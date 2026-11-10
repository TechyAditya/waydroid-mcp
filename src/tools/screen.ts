// SPDX-License-Identifier: AGPL-3.0-or-later
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hasAppDisplays, resolveTarget, sleep, targetShape, tool, type Target } from "../common.js";
import { APP_DISPLAYS, ToolError, adb, adbSerial, adbShell, outPath, run, runText, sh } from "../exec.js";

function pngSize(buf: Buffer): [number, number] {
  return buf.length > 24 && buf.toString("ascii", 1, 4) === "PNG" ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : [0, 0];
}

const name = (t: Target) => t.package ?? `display-${t.display}`;

async function capture(t: Target): Promise<string> {
  const file = `${outPath("screenshots", name(t))}.png`;
  if (t.app) {
    await runText(APP_DISPLAYS, ["screenshot", t.app.package, "-o", file], { timeoutMs: 30_000 });
  } else if (t.display === 0) {
    const r = await adb(["exec-out", "screencap -p"], { timeoutMs: 30_000 });
    if (r.code !== 0 || !pngSize(r.stdout)[0]) throw new ToolError(`screencap failed: ${r.stderr.trim()}`);
    writeFileSync(file, r.stdout);
  } else {
    throw new ToolError(`screencap can't capture virtual display ${t.display}; only display 0 and per-app displays can be captured.`);
  }
  return file;
}

// ---- UI hierarchy ----

export interface UiNode {
  depth: number;
  window: number; // index into UiTree.windows, or -1 for uiautomator's single window
  cls: string;
  text: string;
  hint: string;
  desc: string;
  id: string;
  pkg: string;
  bounds: [number, number, number, number];
  flags: string[];
  visible: boolean;
}

interface UiTree {
  nodes: UiNode[];
  windows: string[];
  source: "uidump" | "uiautomator";
  note?: string;
}

// Runs inside Android with app_process; built by android/build.sh.
const UIDUMP_JAR = fileURLToPath(new URL("../../assets/uidump.jar", import.meta.url));

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10)) : (ENTITIES[e] ?? m),
  );

const attrs = (s: string) => {
  const a: Record<string, string> = {};
  for (const [, k, v] of s.matchAll(/([\w-]+)="([^"]*)"/g)) a[k] = decode(v);
  return a;
};

function parseUi(xml: string): Omit<UiTree, "source"> {
  const nodes: UiNode[] = [];
  const windows: string[] = [];
  let depth = 0;
  for (const m of xml.matchAll(/<(node|window)\b([^>]*?)(\/?)>|<\/node>/g)) {
    if (m[0] === "</node>") {
      depth--;
      continue;
    }
    const a = attrs(m[2]);
    if (m[1] === "window") {
      const state = [a.type, a.focused === "true" && "focused", a.active === "true" && "active"].filter(Boolean).join(", ");
      windows.push(`Window ${JSON.stringify(a.title ?? "")} (${state})`);
      depth = 0;
      continue;
    }
    const b = (a.bounds ?? "").match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    const flags = ["clickable", "long-clickable", "scrollable", "checkable", "checked", "editable", "focused", "selected", "password"].filter(
      (f) => a[f] === "true",
    );
    if (a.enabled === "false") flags.push("disabled");
    nodes.push({
      depth,
      window: windows.length - 1,
      cls: (a.class ?? "").replace(/^android\.(widget|view)\./, ""),
      text: a.text ?? "",
      hint: a.hint ?? "",
      desc: a["content-desc"] ?? "",
      id: (a["resource-id"] ?? "").replace(/^[\w.]+:id\//, ""),
      pkg: a.package ?? "",
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
      flags,
      visible: a.visible !== "false",
    });
    if (!m[3]) depth++;
  }
  return { nodes, windows };
}

const center = (n: UiNode): [number, number] => [Math.round((n.bounds[0] + n.bounds[2]) / 2), Math.round((n.bounds[1] + n.bounds[3]) / 2)];
const interesting = (n: UiNode) =>
  n.visible && !!(n.text || n.desc || n.id || n.flags.some((f) => /click|scroll|check|edit/.test(f)));

function formatUi(tree: UiTree, all: boolean): string {
  const lines: string[] = [];
  const shown: number[] = []; // depths of the shown ancestors
  let window = -2;
  for (const n of tree.nodes) {
    if (n.window !== window) {
      window = n.window;
      shown.length = 0;
      if (window >= 0) lines.push(tree.windows[window]);
    }
    if (!all && !interesting(n)) continue;
    while (shown.length && shown[shown.length - 1] >= n.depth) shown.pop();
    const [cx, cy] = center(n);
    const parts = [n.cls];
    if (n.text) parts.push(JSON.stringify(n.text));
    if (n.hint && n.hint !== n.text) parts.push(`hint=${JSON.stringify(n.hint)}`);
    if (n.desc) parts.push(`desc=${JSON.stringify(n.desc)}`);
    if (n.id) parts.push(`#${n.id}`);
    if (n.flags.length) parts.push(`[${n.flags.join(",")}]`);
    parts.push(`@${cx},${cy}`, `[${n.bounds[0]},${n.bounds[1]}][${n.bounds[2]},${n.bounds[3]}]`);
    lines.push("  ".repeat(shown.length + (window >= 0 ? 1 : 0)) + parts.join(" "));
    shown.push(n.depth);
  }
  return lines.join("\n");
}

let pushedJar: string | null = null;

/** The windows on one display, through the bundled dumper. */
async function uidump(display: number): Promise<UiTree> {
  const hash = createHash("sha1").update(readFileSync(UIDUMP_JAR)).digest("hex").slice(0, 10);
  const remote = `/data/local/tmp/waydroid-mcp-uidump-${hash}.jar`;
  if (pushedJar !== remote) {
    if ((await adbShell(`[ -f ${remote} ] && echo ok || true`)).trim() !== "ok") {
      await adbShell("rm -f /data/local/tmp/waydroid-mcp-uidump-*.jar");
      await runText("adb", ["-s", await adbSerial(), "push", UIDUMP_JAR, remote], { timeoutMs: 30_000 });
    }
    pushedJar = remote;
  }
  const r = await adb(["shell", `CLASSPATH=${remote} app_process / waydroidmcp.UiDump ${display}`], { timeoutMs: 40_000 });
  const xml = r.stdout.toString();
  if (r.code !== 0 || !xml.includes("<hierarchy")) throw new ToolError((r.stderr || xml).trim() || `exit code ${r.code}`);
  return { ...parseUi(xml), source: "uidump" };
}

/** uiautomator's dump of the focused window, clipped to the main display: the fallback. */
async function uiautomator(t: Target): Promise<UiTree> {
  if (t.app && (await hasAppDisplays())) {
    await run(APP_DISPLAYS, ["focus", t.app.package], { timeoutMs: 10_000 });
    await sleep(300);
  }
  const path = "/data/local/tmp/waydroid-mcp-ui.xml";
  let lastErr = "";
  for (let i = 0; i < 3; i++) {
    const r = await adb(["shell", `uiautomator dump ${path} >/dev/null 2>&1 && cat ${path}; rm -f ${path}`], { timeoutMs: 40_000 });
    const xml = r.stdout.toString();
    if (xml.includes("<hierarchy")) return { ...parseUi(xml), source: "uiautomator" };
    lastErr = (r.stderr + xml).trim();
    await sleep(700);
  }
  throw new ToolError(
    `uiautomator couldn't dump the UI${lastErr ? `: ${lastErr}` : ""}. It fails while the screen keeps animating; ` +
      "a screenshot still works, or try again when the app is idle.",
  );
}

async function dumpUi(t: Target): Promise<UiTree> {
  try {
    return await uidump(t.display);
  } catch (e) {
    const tree = await uiautomator(t);
    tree.note =
      `The bundled dumper failed (${(e as Error).message}), so this is uiautomator's dump of the focused window, ` +
      "with bounds clipped to the main display.";
    return tree;
  }
}

function findNode(nodes: UiNode[], query: string): UiNode {
  const q = query.toLowerCase();
  const fields = (n: UiNode) => [n.text, n.desc, n.id, n.hint];
  const visible = nodes.filter((n) => n.visible);
  const exact = visible.filter((n) => fields(n).some((f) => f.toLowerCase() === q));
  const pool = exact.length ? exact : visible.filter((n) => fields(n).some((f) => f.toLowerCase().includes(q)));
  if (!pool.length) throw new ToolError(`No element's text, description or id matches "${query}". \`ui_tree\` lists them.`);
  // Prefer an element that takes taps itself over its label.
  return pool.find((n) => n.flags.includes("clickable")) ?? pool[0];
}

function keycode(key: string): string {
  if (/^\d+$/.test(key)) return key;
  const k = key.toUpperCase().replace(/^KEYCODE_/, "");
  return `KEYCODE_${{ ESC: "ESCAPE", RETURN: "ENTER", BACKSPACE: "DEL", DELETE: "FORWARD_DEL" }[k] ?? k}`;
}

export function register(server: McpServer) {
  tool(
    server,
    "screenshot",
    "Screenshot of an app's display or of Waydroid's main display, returned as an image and saved as a full-resolution PNG. " +
      "Tap coordinates are display pixels: when the image is scaled down, divide image coordinates by the scale it reports.",
    {
      ...targetShape,
      max_size: z.number().int().min(0).default(1280).describe("Longest side of the returned image in pixels; 0 returns full size."),
      wait_ms: z.number().int().min(0).max(10_000).default(0).describe("Wait this long first, for a page change or animation after input."),
    },
    async ({ package: pkg, display_id, max_size, wait_ms }): Promise<CallToolResult> => {
      if (wait_ms) await sleep(wait_ms);
      const t = await resolveTarget(pkg, display_id);
      const file = await capture(t);
      let img = readFileSync(file);
      const [w, h] = pngSize(img);
      let note = `Display ${t.display}${t.package ? ` (${t.package})` : ""}: ${w}x${h} px, saved to ${file}.`;
      if (max_size && Math.max(w, h) > max_size) {
        const small = file.replace(/\.png$/, "-small.png");
        const r = await run("magick", [file, "-resize", `${max_size}x${max_size}>`, small], { timeoutMs: 30_000 });
        if (r.code === 0 && existsSync(small)) {
          img = readFileSync(small);
          const [sw] = pngSize(img);
          note += ` The image is scaled to ${sw}/${w} = ${(sw / w).toFixed(4)}; divide its coordinates by that to tap.`;
        }
      }
      return { content: [{ type: "image", data: img.toString("base64"), mimeType: "image/png" }, { type: "text", text: note }] };
    },
    { readOnlyHint: true },
  );

  tool(
    server,
    "record_screen",
    "Records a display to an MP4 file on the host for a fixed time, then returns its path.",
    {
      ...targetShape,
      duration_s: z.number().int().min(1).max(50).default(10),
    },
    async ({ package: pkg, display_id, duration_s }) => {
      const t = await resolveTarget(pkg, display_id);
      const file = `${outPath("recordings", name(t))}.mp4`;
      if ((await run("sh", ["-c", "command -v scrcpy"])).code === 0) {
        const r = await run(
          "scrcpy",
          ["-s", await adbSerial(), `--display-id=${t.display}`, "--no-window", "--no-audio", "--no-control", `--record=${file}`, `--time-limit=${duration_s}`],
          { timeoutMs: (duration_s + 20) * 1000 },
        );
        if (!existsSync(file)) throw new ToolError(`scrcpy didn't record: ${r.stderr.trim().split("\n").slice(-5).join("\n")}`);
      } else {
        if (t.display !== 0) throw new ToolError("Recording an app's own display needs scrcpy on the host.");
        const remote = "/data/local/tmp/waydroid-mcp-rec.mp4";
        await adbShell(`screenrecord --time-limit ${duration_s} ${remote}`, (duration_s + 20) * 1000);
        await runText("adb", ["-s", await adbSerial(), "pull", remote, file], { timeoutMs: 60_000 });
        await adbShell(`rm -f ${remote}`);
      }
      return `Recorded ${duration_s} s of display ${t.display} to ${file}.`;
    },
    { readOnlyHint: true },
  );

  tool(
    server,
    "ui_tree",
    "The accessibility tree of the windows on an app's display: one line per element with class, text, hint, description, " +
      "#resource-id, state flags, @center coordinates to tap and bounds, all in display pixels. Works on hidden and unfocused " +
      "displays. Hides layout-only and off-screen elements unless all_nodes.",
    {
      ...targetShape,
      all_nodes: z.boolean().default(false),
    },
    async ({ package: pkg, display_id, all_nodes }) => {
      const t = await resolveTarget(pkg, display_id);
      const tree = await dumpUi(t);
      const roots = [...new Set(tree.nodes.filter((n) => n.depth === 0).map((n) => n.pkg))];
      let head = `Display ${t.display}, ${t.width}x${t.height} px.`;
      if (tree.note) head += ` ${tree.note}`;
      if (t.package && roots.length && !roots.includes(t.package)) {
        head += ` Warning: ${t.package} has no window on this display; the windows here belong to ${roots.join(", ")}.`;
      }
      return `${head}\n${formatUi(tree, all_nodes)}`;
    },
    { readOnlyHint: true },
  );

  tool(
    server,
    "input",
    "Touch and keyboard input on a display, in display pixels. tap and long_press take x and y, or `element`: text, " +
      "description or resource id to find in the UI tree. swipe goes from x,y to x2,y2 (swipe up to scroll down). " +
      "text types into the focused field, so tap the field first; key sends a key such as BACK, ENTER, TAB, HOME or DEL.",
    {
      ...targetShape,
      action: z.enum(["tap", "long_press", "swipe", "text", "key"]),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      x2: z.number().int().optional(),
      y2: z.number().int().optional(),
      element: z.string().optional().describe("For tap and long_press: element text, content description or resource id."),
      duration_ms: z.number().int().min(1).max(10_000).optional().describe("Swipe or long-press length. Defaults: 300 and 800."),
      text: z.string().optional(),
      key: z.string().optional(),
    },
    async ({ package: pkg, display_id, action, x, y, x2, y2, element, duration_ms, text, key }) => {
      const t = await resolveTarget(pkg, display_id);
      const d = `input -d ${t.display}`;
      let found = "";
      if ((action === "tap" || action === "long_press") && (x === undefined || y === undefined)) {
        if (!element) throw new ToolError(`${action} needs x and y, or element.`);
        const n = findNode((await dumpUi(t)).nodes, element);
        [x, y] = center(n);
        found = ` on ${n.cls} ${JSON.stringify(n.text || n.desc || n.id)}`;
      }
      let cmd: string;
      switch (action) {
        case "tap":
          cmd = `${d} tap ${x} ${y}`;
          break;
        case "long_press":
          cmd = `${d} swipe ${x} ${y} ${x} ${y} ${duration_ms ?? 800}`;
          break;
        case "swipe":
          if ([x, y, x2, y2].some((v) => v === undefined)) throw new ToolError("swipe needs x, y, x2 and y2.");
          cmd = `${d} swipe ${x} ${y} ${x2} ${y2} ${duration_ms ?? 300}`;
          break;
        case "text":
          if (!text) throw new ToolError("text needs text.");
          cmd = `${d} text ${sh(text.replace(/%/g, "\\%").replace(/ /g, "%s"))}`;
          break;
        case "key":
          if (!key) throw new ToolError("key needs key.");
          cmd = `${d} keyevent ${keycode(key)}`;
          break;
      }
      await adbShell(cmd, 20_000);
      return `${cmd}${found}`;
    },
  );
}
