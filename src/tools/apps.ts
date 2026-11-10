import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  APP_DISPLAYS_HELP,
  appDisplays,
  hasAppDisplays,
  json,
  packageUid,
  pidsOf,
  pkgSchema,
  resolveTarget,
  targetShape,
  tool,
} from "../common.js";
import {
  ANDROID_DATA,
  APP_DISPLAYS,
  DESKTOP_ENTRIES,
  ToolError,
  WAYDROID,
  adb,
  adbSerial,
  adbShell,
  outPath,
  runText,
  sh,
} from "../exec.js";

/** App names from the desktop entries Waydroid writes for launcher apps. */
function labels(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(DESKTOP_ENTRIES)) return out;
  for (const f of readdirSync(DESKTOP_ENTRIES)) {
    const m = f.match(/^waydroid\.(.+)\.desktop$/);
    if (!m) continue;
    try {
      const name = readFileSync(join(DESKTOP_ENTRIES, f), "utf8").match(/^Name=(.*)$/m)?.[1];
      if (name) out.set(m[1], name.trim());
    } catch {
      // unreadable entry
    }
  }
  return out;
}

function packageBlock(dump: string, pkg: string): string {
  const start = dump.indexOf(`Package [${pkg}]`);
  if (start < 0) throw new ToolError(`${pkg} isn't installed.`);
  const rest = dump.slice(start);
  const end = rest.slice(1).search(/\n {2}Package \[|\n\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

async function appInfo(pkg: string) {
  const block = packageBlock(await adbShell(`dumpsys package ${sh(pkg)}`), pkg);
  const field = (re: RegExp) => block.match(re)?.[1] ?? null;
  const launcher = (await adbShell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${sh(pkg)}`))
    .trim()
    .split("\n")
    .pop();
  const granted: string[] = [];
  const denied: string[] = [];
  for (const m of block.matchAll(/^\s+([\w.]+): granted=(true|false)/gm)) (m[2] === "true" ? granted : denied).push(m[1]);
  return {
    package: pkg,
    uid: await packageUid(pkg),
    version_name: field(/versionName=(\S+)/),
    version_code: field(/versionCode=(\d+)/),
    min_sdk: field(/minSdk=(\d+)/),
    target_sdk: field(/targetSdk=(\d+)/),
    debuggable: /pkgFlags=\[[^\]]*DEBUGGABLE/.test(block),
    system: /pkgFlags=\[[^\]]*\bSYSTEM\b/.test(block),
    first_install: field(/firstInstallTime=(.+)/),
    last_update: field(/lastUpdateTime=(.+)/),
    code_path: field(/codePath=(\S+)/),
    data_dir: field(/dataDir=(\S+)/),
    launcher_activity: launcher && launcher.includes("/") ? launcher : null,
    running_pids: await pidsOf(pkg),
    app_display: (await appDisplays()).find((a) => a.package === pkg) ?? null,
    granted_permissions: granted,
    denied_permissions: denied,
  };
}

/** The newest app directory under Android's /data/app, which names the package just installed. */
function newestInstall(since: number): string | null {
  const root = join(ANDROID_DATA, "app");
  let best: { pkg: string; mtime: number } | null = null;
  try {
    for (const outer of readdirSync(root)) {
      for (const inner of readdirSync(join(root, outer))) {
        const m = inner.match(/^(.+)-[^-]+==$/);
        const mtime = statSync(join(root, outer, inner)).mtimeMs;
        if (m && mtime >= since - 2000 && (!best || mtime > best.mtime)) best = { pkg: m[1], mtime };
      }
    }
  } catch {
    return null;
  }
  return best?.pkg ?? null;
}

async function fetchToFile(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new ToolError(`Downloading ${url} failed: HTTP ${res.status}`);
  const name = basename(new URL(res.url).pathname) || "download.apk";
  const file = `${outPath("downloads", name.replace(/\.(apks|xapk|apkm|apk)$/i, ""))}${name.match(/\.(apks|xapk|apkm|apk)$/i)?.[0] ?? ".apk"}`;
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** The APK files to install: the file itself, or the APKs inside an .apks, .xapk or .apkm bundle. */
async function apkFiles(file: string): Promise<string[]> {
  if (!existsSync(file)) throw new ToolError(`${file} doesn't exist.`);
  if (/\.apk$/i.test(file)) return [file];
  if (!/\.(apks|xapk|apkm|zip)$/i.test(file)) return [file];
  const dir = outPath("bundles", basename(file));
  mkdirSync(dir, { recursive: true });
  await runText("unzip", ["-o", "-q", file, "*.apk", "-d", dir], { timeoutMs: 120_000 });
  const apks: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.apk$/i.test(e.name)) apks.push(join(d, e.name));
    }
  };
  walk(dir);
  if (!apks.length) throw new ToolError(`${file} has no APKs inside.`);
  return apks;
}

export function register(server: McpServer) {
  tool(
    server,
    "list_apps",
    "Installed Android packages with their names. `launchable` lists apps with a launcher icon, including system apps such as Settings.",
    {
      scope: z.enum(["launchable", "third_party", "all"]).default("launchable"),
      filter: z.string().optional().describe("Case-insensitive text to match in the package or app name."),
    },
    async ({ scope, filter }) => {
      const names = labels();
      let pkgs: string[];
      if (scope === "launchable") {
        const out = await adbShell("cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER");
        pkgs = [...new Set(out.split("\n").map((l) => l.trim().split("/")[0]).filter((p) => /^[\w.]+$/.test(p) && p.includes(".")))];
      } else {
        const out = await adbShell(`pm list packages ${scope === "third_party" ? "-3" : ""}`);
        pkgs = out.split("\n").map((l) => l.replace(/^package:/, "").trim()).filter(Boolean);
      }
      const f = filter?.toLowerCase();
      const rows = pkgs
        .map((p) => ({ package: p, name: names.get(p) ?? "" }))
        .filter((r) => !f || r.package.toLowerCase().includes(f) || r.name.toLowerCase().includes(f))
        .sort((a, b) => a.package.localeCompare(b.package));
      return rows.length ? rows.map((r) => (r.name ? `${r.package}  (${r.name})` : r.package)).join("\n") : "No packages match.";
    },
    { readOnlyHint: true },
  );

  tool(
    server,
    "app_info",
    "One package's version, SDK levels, debuggable flag, paths, launcher activity, running processes, open display and permissions.",
    { package: pkgSchema },
    async ({ package: pkg }) => json(await appInfo(pkg)),
    { readOnlyHint: true },
  );

  tool(
    server,
    "launch_app",
    "Opens an app. `window` opens it in its own desktop window and `hidden` on an off-screen display with no window " +
      "(both need waydroid-app-displays; hidden defaults to 1080x2340 at 440 dpi). `waydroid` uses Waydroid's own window. " +
      "`size` fixes the Android display in pixels and `dpi` its density (dp width = pixels * 160 / dpi), so 720x1280 at 320 dpi is a 360 dp phone. " +
      "Launching an open app again applies the new options, and options left out go back to the defaults. " +
      "Returns the display id that input, screenshot and ui_tree act on; it changes each time the app is closed and opened.",
    {
      package: pkgSchema,
      mode: z.enum(["window", "hidden", "waydroid"]).optional().describe("Default: window when waydroid-app-displays is installed, otherwise waydroid."),
      size: z.string().regex(/^\d+x\d+$/).optional().describe("Android display size WIDTHxHEIGHT in pixels, such as 1080x2340."),
      dpi: z.number().int().min(80).max(800).optional(),
      restart: z.boolean().default(false).describe("Force-stop the app first, for a cold start."),
    },
    async ({ package: pkg, mode, size, dpi, restart }) => {
      await adbSerial();
      await packageUid(pkg);
      const perApp = await hasAppDisplays();
      const m = mode ?? (perApp ? "window" : "waydroid");
      if (restart) await adbShell(`am force-stop ${sh(pkg)}`);
      if (m === "waydroid") {
        if (size || dpi) throw new ToolError("size and dpi apply to per-app windows and hidden displays, not Waydroid's own window.");
        await runText(WAYDROID, ["app", "launch", pkg], { timeoutMs: 30_000 });
        const t = await resolveTarget(undefined, 0);
        return json({ package: pkg, mode: m, display_id: 0, width: t.width, height: t.height });
      }
      if (!perApp) throw new ToolError(APP_DISPLAYS_HELP);
      const args = ["launch", pkg, "--json"];
      if (size) args.push("--size", size);
      if (dpi) args.push("--dpi", String(dpi));
      if (m === "hidden") args.push("--hidden");
      const info = JSON.parse(await runText(APP_DISPLAYS, args, { timeoutMs: 120_000 }));
      const { commands, serial: _serial, ...rest } = info;
      return json({ ...rest, mode: m, live_view: m === "hidden" ? commands?.["live view"] : undefined });
    },
  );

  tool(
    server,
    "start_activity",
    "Starts an activity with an intent on a display, and waits for it to draw: open a URL or deep link (`url`), " +
      "or an exact component such as com.android.settings/.Settings. Returns `am start -W`'s timing (TotalTime is the launch time in ms).",
    {
      ...targetShape,
      url: z.string().optional().describe("Data URI for an ACTION_VIEW intent, such as https://example.com or myapp://path."),
      component: z.string().optional().describe("package/activity to start."),
      action: z.string().optional().describe("Intent action. Default: android.intent.action.VIEW with url, otherwise MAIN."),
      extras: z.record(z.string(), z.string()).optional().describe("String extras, passed with --es."),
    },
    async ({ package: pkg, display_id, url, component, action, extras }) => {
      const t = await resolveTarget(pkg, display_id);
      const parts = ["am start -W", `--display ${t.display}`];
      parts.push(`-a ${sh(action ?? (url ? "android.intent.action.VIEW" : "android.intent.action.MAIN"))}`);
      if (url) parts.push(`-d ${sh(url)}`);
      for (const [k, v] of Object.entries(extras ?? {})) parts.push(`--es ${sh(k)} ${sh(v)}`);
      if (component) parts.push(`-n ${sh(component)}`);
      else if (pkg) parts.push(sh(pkg));
      else if (!url) throw new ToolError("Give a url, a component or a package.");
      return `${parts.join(" ")}\n${(await adbShell(parts.join(" "), 60_000)).trim()}`;
    },
  );

  tool(
    server,
    "install_apk",
    "Installs an APK, or a split bundle (.apks, .xapk, .apkm), from a host path or an http(s) URL. Replaces an installed " +
      "version by default. Returns the package name and version.",
    {
      source: z.string().describe("Host path or URL of the APK or bundle."),
      extra_splits: z.array(z.string()).optional().describe("More split APK paths installed together with source."),
      downgrade: z.boolean().default(false),
      grant_permissions: z.boolean().default(false).describe("Grant all runtime permissions (-g)."),
      allow_test: z.boolean().default(true).describe("Allow test-only APKs, as Android Studio debug builds are (-t)."),
    },
    async ({ source, extra_splits, downgrade, grant_permissions, allow_test }) => {
      const file = /^https?:\/\//.test(source) ? await fetchToFile(source) : source;
      const files = [...(await apkFiles(file)), ...(extra_splits ?? [])];
      const flags = ["-r", ...(downgrade ? ["-d"] : []), ...(grant_permissions ? ["-g"] : []), ...(allow_test ? ["-t"] : [])];
      const before = new Set((await adbShell("pm list packages")).split("\n").map((l) => l.trim()));
      const began = Date.now();
      const r = await adb([files.length > 1 ? "install-multiple" : "install", ...flags, ...files], { timeoutMs: 300_000 });
      const out = (r.stdout.toString() + r.stderr).trim();
      if (r.code !== 0 || !/Success/.test(out)) throw new ToolError(`Install failed: ${out}`);
      const added = (await adbShell("pm list packages")).split("\n").map((l) => l.trim()).filter((l) => l && !before.has(l));
      const pkg = added[0]?.replace(/^package:/, "") ?? newestInstall(began);
      if (!pkg) return `Installed ${files.length} APK(s), but the package name couldn't be found.\n${out}`;
      const info = await appInfo(pkg);
      return json({
        package: pkg,
        new_install: added.length > 0,
        version_name: info.version_name,
        version_code: info.version_code,
        launcher_activity: info.launcher_activity,
        files,
      });
    },
  );

  tool(
    server,
    "app_action",
    "Changes an app's state: force_stop, clear_data (also stops it), uninstall, uninstall_keep_data, grant or revoke a " +
      "runtime permission, or close_window (closes its own window or hidden display; the app keeps running).",
    {
      package: pkgSchema,
      action: z.enum(["force_stop", "clear_data", "uninstall", "uninstall_keep_data", "grant", "revoke", "close_window"]),
      permission: z.string().optional().describe("For grant and revoke, such as android.permission.CAMERA."),
    },
    async ({ package: pkg, action, permission }) => {
      const p = sh(pkg);
      switch (action) {
        case "force_stop":
          await adbShell(`am force-stop ${p}`);
          return `Stopped ${pkg}.`;
        case "clear_data":
          return `${pkg}: ${(await adbShell(`pm clear ${p}`)).trim()}`;
        case "uninstall":
        case "uninstall_keep_data": {
          const r = await adb(["uninstall", ...(action === "uninstall_keep_data" ? ["-k"] : []), pkg], { timeoutMs: 60_000 });
          return `${pkg}: ${(r.stdout.toString() + r.stderr).trim()}`;
        }
        case "grant":
        case "revoke":
          if (!permission) throw new ToolError(`${action} needs a permission.`);
          await adbShell(`pm ${action} ${p} ${sh(permission)}`);
          return `${action === "grant" ? "Granted" : "Revoked"} ${permission} for ${pkg}.`;
        case "close_window":
          if (!(await hasAppDisplays())) throw new ToolError(APP_DISPLAYS_HELP);
          await runText(APP_DISPLAYS, ["close", pkg]);
          return `Closed ${pkg}'s window.`;
      }
    },
    { destructiveHint: true },
  );
}
