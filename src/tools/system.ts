import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { json, tool } from "../common.js";
import { ToolError, WAYDROID, adb, adbShell, clip, rootShell, run, runText, sh } from "../exec.js";

// Waydroid's own settings. Most are read when the session or the service starts.
const WAYDROID_PROPS: Record<string, string> = {
  "persist.waydroid.multi_windows": "true: Waydroid's composer gives each Android app its own desktop window; false: one full Android window.",
  "persist.waydroid.width": "Width of Waydroid's main window in pixels.",
  "persist.waydroid.height": "Height of Waydroid's main window in pixels.",
  "persist.waydroid.width_padding": "Pixels subtracted from the main display's width.",
  "persist.waydroid.height_padding": "Pixels subtracted from the main display's height.",
  "persist.waydroid.reverse_scrolling": "true: reverse mouse wheel and touchpad scrolling.",
  "persist.waydroid.invert_colors": "true: swap red and blue in buffers, for GPUs that show them swapped.",
  "persist.waydroid.use_subsurface": "true: show Android layers as Wayland subsurfaces.",
  "persist.waydroid.cursor_on_subsurface": "true: draw the mouse cursor on a subsurface instead of as a Wayland cursor.",
  "persist.waydroid.cursor_force_shm": "true: send the cursor image through shared memory.",
  "persist.waydroid.no_presentation": "true: don't use the presentation-time protocol for frame timing.",
  "persist.waydroid.no_background_subsurface": "true: no background subsurface behind Android's layers.",
  "persist.waydroid.no_hdr": "true: turn HDR output off (patched composer).",
  "persist.waydroid.resize_interval_ms": "Minimum milliseconds between display resizes while a window is dragged; 0 resizes on every step (patched composer and waydroid-app-displays; default 150).",
  "persist.waydroid.video_sdr_output": "How 8-bit video reaches Android with host video decoding: auto, rgba, nv12 or system.",
  "persist.waydroid.app_displays": "waydroid-app-displays: false makes `waydroid app launch` use Waydroid's own window modes again (default true).",
  "persist.waydroid.app_titlebar": "waydroid-app-displays: auto draws a title bar with Back only where the compositor draws none; always draws it everywhere.",
  "persist.waydroid.app_display_density": "waydroid-app-displays: density of per-app displays (default: ro.sf.lcd_density).",
  "persist.waydroid.app_media": "waydroid-app-displays: false stops publishing Android media sessions as MPRIS players (default true).",
};

const PORT_SPEC = z.string().regex(/^(tcp:\d+|localabstract:[\w.-]+|localfilesystem:\S+|jdwp:\d+)$/, "such as tcp:8000 or localabstract:chrome_devtools_remote");

export function register(server: McpServer) {
  tool(
    server,
    "props",
    "Android system properties. `waydroid` lists Waydroid's persist.waydroid.* settings with their meaning and current value. " +
      "`get` reads names or a regex. `set` changes one: persist.waydroid.* through `waydroid prop set`, others with setprop " +
      "(debug.*, log.tag.* and persist.log.tag.* work without root). Most Waydroid settings apply after a session restart.",
    {
      action: z.enum(["waydroid", "get", "set"]).default("waydroid"),
      names: z.array(z.string()).optional().describe("For get: property names."),
      pattern: z.string().optional().describe("For get: regex matched against every property name."),
      name: z.string().optional().describe("For set."),
      value: z.string().optional().describe("For set; an empty string clears the property."),
    },
    async ({ action, names, pattern, name, value }) => {
      if (action === "set") {
        if (!name || value === undefined) throw new ToolError("set needs name and value.");
        if (name.startsWith("persist.waydroid.")) {
          await runText(WAYDROID, ["prop", "set", name, value], { timeoutMs: 20_000 });
        } else {
          const r = await adb(["shell", `setprop ${sh(name)} ${sh(value)}`], { timeoutMs: 20_000 });
          if (r.code !== 0) {
            const root = await rootShell(`setprop ${sh(name)} ${sh(value)}`);
            if (root.code !== 0) throw new ToolError(`setprop failed, also as root: ${root.stderr.trim()}`);
          }
        }
        const now = (await adbShell(`getprop ${sh(name)}`)).trim();
        return `${name}=${now}${now !== value ? ` (asked for "${value}"; Android may only read it at the next start)` : ""}`;
      }
      const all = new Map<string, string>();
      for (const m of (await adbShell("getprop")).matchAll(/^\[([^\]]+)\]: \[([\s\S]*?)\]$/gm)) all.set(m[1], m[2]);
      if (action === "waydroid") {
        const rows = Object.entries(WAYDROID_PROPS).map(([k, desc]) => ({ name: k, value: all.get(k) ?? "(unset)", meaning: desc }));
        const extra = [...all.keys()].filter((k) => k.startsWith("persist.waydroid.") && !(k in WAYDROID_PROPS));
        return json({ settings: rows, other_persist_waydroid: Object.fromEntries(extra.map((k) => [k, all.get(k)])) });
      }
      let re: RegExp | null = null;
      if (pattern) {
        try {
          re = new RegExp(pattern);
        } catch (e) {
          throw new ToolError(`pattern isn't a valid regular expression: ${(e as Error).message}`);
        }
      }
      if (!names?.length && !re) throw new ToolError("get needs names or a pattern.");
      const out: Record<string, string> = {};
      for (const [k, v] of all) if (names?.includes(k) || re?.test(k)) out[k] = v;
      for (const n of names ?? []) if (!(n in out)) out[n] = "(unset)";
      return json(out);
    },
  );

  tool(
    server,
    "shell",
    "Runs a shell command in Android and returns its output and exit code: dumpsys, am, pm, cmd, wm, getprop and so on. " +
      "Runs as adb's shell user, or as root with root: true (see root_access). Nothing can be piped into it.",
    {
      command: z.string(),
      root: z.boolean().default(false),
      timeout_s: z.number().int().min(1).max(300).default(30),
    },
    async ({ command, root, timeout_s }) => {
      const r = root ? await rootShell(command, timeout_s * 1000) : await adb(["shell", command], { timeoutMs: timeout_s * 1000 });
      const out = (r.stdout.toString() + (r.stderr ? `\n[stderr]\n${r.stderr}` : "")).trimEnd();
      const status = r.timedOut ? `[timed out after ${timeout_s} s]` : `[exit code ${r.code}]`;
      return `${clip(out, "shell", "shell")}\n${status}`;
    },
    { destructiveHint: true },
  );

  tool(
    server,
    "files",
    "Copies files between the host and Android: push a host path to an Android path, or pull an Android path to the host. " +
      "App-private files under /data/data are readable with pull only for debuggable apps (through run-as), given `package`.",
    {
      action: z.enum(["push", "pull"]),
      host_path: z.string(),
      android_path: z.string(),
      package: z.string().optional().describe("For pull from a debuggable app's private directory."),
    },
    async ({ action, host_path, android_path, package: pkg }) => {
      if (action === "push") {
        if (!existsSync(host_path)) throw new ToolError(`${host_path} doesn't exist.`);
        const r = await adb(["push", host_path, android_path], { timeoutMs: 300_000 });
        if (r.code !== 0) throw new ToolError((r.stderr || r.stdout.toString()).trim());
        return `Pushed ${host_path} to ${android_path}.`;
      }
      if (pkg) {
        const r = await adb(["exec-out", `run-as ${sh(pkg)} cat ${sh(android_path)}`], { timeoutMs: 300_000 });
        if (r.code !== 0) throw new ToolError(`run-as failed (is ${pkg} debuggable?): ${r.stderr.trim() || r.stdout.toString().trim()}`);
        writeFileSync(host_path, r.stdout);
        return `Pulled ${r.stdout.length} bytes to ${host_path}.`;
      }
      const r = await adb(["pull", android_path, host_path], { timeoutMs: 300_000 });
      if (r.code !== 0) throw new ToolError((r.stderr || r.stdout.toString()).trim());
      return `Pulled ${android_path} to ${host_path}.`;
    },
  );

  tool(
    server,
    "ports",
    "Connects ports between the host and Android over adb. `reverse` makes a host server reachable from Android " +
      "(reverse tcp:8000 tcp:8000, then open http://127.0.0.1:8000 in Android). `forward` makes an Android socket reachable " +
      "from the host. `devtools` forwards a Chromium-based browser's DevTools to a host port and lists its pages. " +
      "`remove` undoes one, `list` shows all.",
    {
      action: z.enum(["reverse", "forward", "devtools", "remove", "list"]),
      host: PORT_SPEC.optional().describe("Host side, such as tcp:8000."),
      android: PORT_SPEC.optional().describe("Android side, such as tcp:8000 or localabstract:chrome_devtools_remote."),
      direction: z.enum(["reverse", "forward"]).optional().describe("For remove."),
      port: z.number().int().min(1024).max(65535).default(9333).describe("For devtools: the host port."),
    },
    async ({ action, host, android, direction, port }) => {
      if (action === "list") {
        const f = (await adb(["forward", "--list"])).stdout.toString().trim();
        const r = (await adb(["reverse", "--list"])).stdout.toString().trim();
        return `forward:\n${f || "(none)"}\nreverse:\n${r || "(none)"}`;
      }
      if (action === "devtools") {
        const fwd = await adb(["forward", `tcp:${port}`, "localabstract:chrome_devtools_remote"]);
        if (fwd.code !== 0) throw new ToolError(fwd.stderr.trim());
        let pages = "";
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          pages = JSON.stringify(
            ((await res.json()) as { title: string; url: string; webSocketDebuggerUrl?: string }[]).map((p) => ({
              title: p.title,
              url: p.url,
              ws: p.webSocketDebuggerUrl,
            })),
            null,
            2,
          );
        } catch (e) {
          pages = `No answer at http://127.0.0.1:${port}/json (${(e as Error).message}); open the browser first.`;
        }
        return `DevTools at http://127.0.0.1:${port}. Undo with ports remove direction=forward host=tcp:${port}.\n${pages}`;
      }
      if (action === "remove") {
        if (!host || !direction) throw new ToolError("remove needs host and direction.");
        const side = direction === "reverse" ? (android ?? host) : host;
        const r = await adb([direction, "--remove", side]);
        if (r.code !== 0) throw new ToolError(r.stderr.trim());
        return `Removed ${direction} ${side}.`;
      }
      if (!host || !android) throw new ToolError(`${action} needs host and android.`);
      const r = action === "reverse" ? await adb(["reverse", android, host]) : await adb(["forward", host, android]);
      if (r.code !== 0) throw new ToolError(r.stderr.trim());
      return action === "reverse" ? `Android ${android} now reaches host ${host}.` : `Host ${host} now reaches Android ${android}.`;
    },
  );

  tool(
    server,
    "host_logs",
    "Host-side logs of Waydroid: `waydroid` is /var/lib/waydroid/waydroid.log (container start, mounts, errors), " +
      "`container` the waydroid-container service's journal, `session` the session's journal, and `kernel` the kernel log " +
      "(binder, GPU and overlay errors).",
    {
      source: z.enum(["waydroid", "container", "session", "kernel"]),
      lines: z.number().int().min(1).max(5000).default(200),
      grep: z.string().optional().describe("Regex a line must match."),
      since: z.string().optional().describe('For journal sources: journalctl --since, such as "10 min ago".'),
    },
    async ({ source, lines, grep, since }) => {
      let text: string;
      const since_ = since ? ["--since", since] : [];
      if (source === "waydroid") {
        const r = await run("tail", ["-n", String(grep ? 20_000 : lines), "/var/lib/waydroid/waydroid.log"]);
        if (r.code !== 0) throw new ToolError(r.stderr.trim());
        text = r.stdout.toString();
      } else {
        const args =
          source === "container"
            ? ["-u", "waydroid-container", ...since_]
            : source === "session"
              ? ["--user", "-u", "waydroid-mcp-session", ...since_]
              : ["-k", ...(since ? since_ : ["-b"])];
        const r = await run("journalctl", ["--no-pager", "-o", "short-iso", "-n", String(grep ? 20_000 : lines), ...args], { timeoutMs: 30_000 });
        text = r.stdout.toString() || r.stderr;
      }
      let rows = text.split("\n").filter(Boolean);
      if (grep) {
        let re: RegExp;
        try {
          re = new RegExp(grep);
        } catch (e) {
          throw new ToolError(`grep isn't a valid regular expression: ${(e as Error).message}`);
        }
        rows = rows.filter((l) => re.test(l)).slice(-lines);
      }
      return rows.length ? clip(rows.join("\n"), "host-logs", source) : "No lines match.";
    },
    { readOnlyHint: true },
  );
}
