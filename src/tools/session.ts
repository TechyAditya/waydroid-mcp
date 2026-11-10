// SPDX-License-Identifier: AGPL-3.0-or-later
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import { z } from "zod";
import { appDisplays, androidDisplays, hasAppDisplays, json, sleep, tool } from "../common.js";
import {
  AdbUnauthorized,
  SESSION_VARS,
  ToolError,
  WAYDROID,
  adb,
  adbSerial,
  adbShell,
  controlRequest,
  fillDesktopEnv,
  rootShell,
  rootState,
  run,
  setSudoFile,
  waydroidStatus,
} from "../exec.js";

const UNIT = "waydroid-mcp-session";
const PROPS = [
  "ro.build.version.release",
  "ro.lineage.version",
  "ro.build.type",
  "ro.hardware.gralloc",
  "ro.hardware.egl",
  "persist.waydroid.multi_windows",
  "persist.waydroid.app_displays",
];

async function booted(): Promise<boolean> {
  try {
    const r = await adb(["shell", "getprop sys.boot_completed"], { timeoutMs: 5000 });
    return r.stdout.toString().trim() === "1";
  } catch (e) {
    if (e instanceof AdbUnauthorized) throw e;
    return false;
  }
}

async function waitForBoot(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const st = await waydroidStatus();
    if (st.session && st.ip && (await booted())) return true;
    await sleep(1000);
  }
  return false;
}

async function start(timeoutS: number): Promise<string> {
  const began = Date.now();
  const st = await waydroidStatus();
  if (st.session) {
    if (await waitForBoot(began + timeoutS * 1000)) return "The session was already running, and Android has booted.";
    return `The session is running but Android hasn't finished booting after ${timeoutS} s. Call \`status\` again.`;
  }
  if (!process.env.WAYLAND_DISPLAY) await fillDesktopEnv();
  if (!process.env.WAYLAND_DISPLAY) {
    throw new ToolError(
      "No Wayland session found: WAYLAND_DISPLAY isn't set, the user systemd manager doesn't have it, and the runtime " +
        "directory doesn't hold exactly one wayland-N socket. Set WAYLAND_DISPLAY in the MCP server's environment.",
    );
  }
  // The session needs the desktop's Wayland and D-Bus to open windows.
  const env = SESSION_VARS.filter((k) => process.env[k]).flatMap((k) => ["-E", `${k}=${process.env[k]}`]);
  if ((await run("sh", ["-c", "command -v systemd-run"])).code === 0) {
    // A session started from a short-lived process dies with it, so it runs as a user unit.
    await run("systemctl", ["--user", "reset-failed", UNIT]);
    const r = await run("systemd-run", ["--user", `--unit=${UNIT}`, "--collect", ...env, WAYDROID, "session", "start"]);
    if (r.code !== 0) throw new ToolError(`systemd-run failed: ${r.stderr.trim()}`);
  } else {
    spawn(WAYDROID, ["session", "start"], { detached: true, stdio: "ignore" }).unref();
  }
  if (await waitForBoot(began + timeoutS * 1000)) return `Android booted in ${Math.round((Date.now() - began) / 1000)} s.`;
  return `The session started, but Android hasn't finished booting after ${timeoutS} s. Call \`status\` to check.`;
}

async function stop(): Promise<string> {
  const st = await waydroidStatus();
  if (!st.session) return "The session wasn't running.";
  await run(WAYDROID, ["session", "stop"], { timeoutMs: 60_000 });
  await run("systemctl", ["--user", "stop", UNIT]);
  const after = await waydroidStatus();
  return after.session ? "`waydroid session stop` returned, but the session is still running." : "The session stopped.";
}

export function register(server: McpServer) {
  tool(
    server,
    "status",
    "Waydroid's state: session and container, adb serial, whether Android has booted, Android and LineageOS versions, " +
      "graphics, the per-app window service and the apps open in it, and how root access is set up. Call this first.",
    {},
    async () => {
      const st = await waydroidStatus();
      const out: Record<string, unknown> = { session: st.session ? "running" : "stopped", container: st.container, ip: st.ip };
      if (st.session && st.ip) {
        try {
          out.adb_serial = await adbSerial();
          out.booted = await booted();
          const lines = await adbShell(PROPS.map((p) => `echo "${p}=$(getprop ${p})"`).join("; "));
          out.properties = Object.fromEntries(lines.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
        } catch (e) {
          out.adb_error = (e as Error).message;
        }
      }
      if (await hasAppDisplays()) {
        try {
          out.app_window_service = await controlRequest("version");
          out.app_displays = await appDisplays();
        } catch (e) {
          out.app_window_service = `not reachable: ${(e as Error).message}`;
        }
      } else {
        out.app_window_service = "waydroid-app-displays isn't installed; apps open in Waydroid's own window";
      }
      out.root = rootState();
      return json(out);
    },
    { readOnlyHint: true },
  );

  tool(
    server,
    "session",
    "Starts, stops or restarts the Waydroid session. `start` waits until Android has booted (about 20-30 s). " +
      "Stopping closes every Android app.",
    {
      action: z.enum(["start", "stop", "restart"]),
      timeout_s: z.number().int().min(5).max(170).default(50).describe("How long `start` waits for Android to boot."),
    },
    async ({ action, timeout_s }) => {
      if (action === "start") return start(timeout_s);
      if (action === "stop") return stop();
      return `${await stop()}\n${await start(timeout_s)}`;
    },
    { destructiveHint: true },
  );

  tool(
    server,
    "list_displays",
    "Android's displays with id, name, size and density, plus the apps open in their own windows or hidden displays. " +
      "Display 0 is Waydroid's main window; input and screenshots take a display id or a package.",
    {},
    async () => json({ android: await androidDisplays(), app_displays: await appDisplays() }),
    { readOnlyHint: true },
  );

  tool(
    server,
    "root_access",
    "Sets up root in Android for `shell` with root and `stack_dump`. adb root is disabled in Waydroid, so root runs " +
      "`sudo waydroid shell`. Pass a file holding the sudo password, or nothing to use sudo without one (a NOPASSWD rule). " +
      "With check, runs `id -u` as root once; if sudo rejects the password, root stays off so repeated failures can't lock sudo.",
    {
      password_file: z.string().optional().describe("Absolute path of a file containing the sudo password."),
      check: z.boolean().default(true),
    },
    async ({ password_file, check }) => {
      setSudoFile(password_file ?? null);
      if (!check) return `Root: ${rootState()}`;
      const r = await rootShell("id -u", 20_000);
      const uid = r.stdout.toString().trim();
      if (uid !== "0") throw new ToolError(`Root check failed (exit ${r.code}): ${r.stderr.trim() || uid}`);
      return `Root works: ${rootState()}.`;
    },
  );
}
