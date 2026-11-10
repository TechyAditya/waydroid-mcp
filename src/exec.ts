// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const WAYDROID = "/usr/bin/waydroid";
export const APP_DISPLAYS = "waydroid-app-displays";
const DATA_HOME = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
// Android's /data is this host directory, and Android's system uid is the host user.
export const ANDROID_DATA = join(DATA_HOME, "waydroid", "data");
export const DESKTOP_ENTRIES = join(DATA_HOME, "applications");
export const CONTROL_SOCKET = join(ANDROID_DATA, "waydroid-app-displays", "control.sock");
export const OUT_DIR = "/tmp/waydroid-mcp";
// Text past this many characters goes to a file, and the reply keeps its end.
const MAX_TEXT = 40_000;

export class ToolError extends Error {}
export class AdbUnauthorized extends ToolError {}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 30_000, input, env } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let done = false;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => finish({ code: null, stdout: Buffer.alloc(0), stderr: String(e), timedOut }));
    child.on("close", (code) =>
      finish({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString(), timedOut }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** Runs a command and returns its stdout, or throws with its stderr. */
export async function runText(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.timedOut) throw new ToolError(`${cmd} ${args.join(" ")} timed out after ${(opts.timeoutMs ?? 30_000) / 1000} s`);
  if (r.code !== 0) {
    const msg = (r.stderr.trim() || r.stdout.toString().trim()).replace(/^waydroid-app-displays: /, "");
    throw new ToolError(msg || `${cmd} exited with code ${r.code}`);
  }
  return r.stdout.toString();
}

export function sh(s: string): string {
  return /^[A-Za-z0-9_\-+=.,:/@%]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function outPath(kind: string, name: string): string {
  const dir = join(OUT_DIR, kind);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(dir, `${name.replace(/[^A-Za-z0-9._-]/g, "_")}-${stamp}`);
}

/** Text short enough for a reply; longer text is saved to a file and the reply keeps one end of it. */
export function clip(text: string, kind = "output", name = "output", keep: "start" | "end" = "end"): string {
  if (text.length <= MAX_TEXT) return text;
  const file = `${outPath(kind, name)}.txt`;
  writeFileSync(file, text);
  const note = `[${text.length} characters; the full text is in ${file}. Showing the ${keep === "end" ? "last" : "first"} ${MAX_TEXT}.]`;
  return keep === "end" ? `${note}\n${text.slice(-MAX_TEXT)}` : `${text.slice(0, MAX_TEXT)}\n${note}`;
}

// ---- Waydroid ----

export interface WaydroidStatus {
  session: boolean;
  container: string;
  ip: string | null;
  raw: string;
}

export async function waydroidStatus(): Promise<WaydroidStatus> {
  const raw = (await run(WAYDROID, ["status"], { timeoutMs: 10_000 })).stdout.toString();
  const field = (name: string) => raw.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1].trim() ?? "";
  const ip = field("IP address");
  return {
    session: field("Session") === "RUNNING",
    container: field("Container") || "unknown",
    ip: /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null,
    raw,
  };
}

/** One request to the per-app window service's control socket. */
export function controlRequest(line: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(CONTROL_SOCKET);
    const chunks: Buffer[] = [];
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error("timed out")));
    sock.on("connect", () => sock.write(line + "\n"));
    sock.on("data", (d) => chunks.push(d));
    sock.on("end", () => resolve(Buffer.concat(chunks).toString().trim()));
    sock.on("error", reject);
  });
}

// ---- adb ----

let cachedSerial: string | null = null;

async function adbState(serial: string): Promise<string | null> {
  const devices = (await run("adb", ["devices"], { timeoutMs: 10_000 })).stdout.toString();
  return devices.match(new RegExp(`^${serial.replace(/\./g, "\\.")}\\s+(\\S+)$`, "m"))?.[1] ?? null;
}

const adbConnected = async (serial: string) => (await adbState(serial)) === "device";

/** Waydroid's adb serial, connecting adb to it when needed. */
export async function adbSerial(): Promise<string> {
  if (cachedSerial && (await adbConnected(cachedSerial))) return cachedSerial;
  const st = await waydroidStatus();
  if (!st.session) throw new ToolError("The Waydroid session isn't running. Start it with the `session` tool.");
  if (!st.ip) throw new ToolError("Waydroid has no IP address yet, so Android is still booting. Try again in a few seconds.");
  const serial = `${st.ip}:5555`;
  for (let i = 0; i < 3; i++) {
    const state = await adbState(serial);
    if (state === "device") {
      cachedSerial = serial;
      return serial;
    }
    if (state === "unauthorized") {
      throw new AdbUnauthorized(
        `Android hasn't authorized this computer's adb key yet. Open Waydroid's main window (\`waydroid show-full-ui\`), ` +
          "tick \"Always allow from this computer\" in the \"Allow USB debugging?\" prompt, and tap Allow.",
      );
    }
    await run("adb", ["connect", serial], { timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new ToolError(`adb can't connect to ${serial}. Check that Android has booted (\`status\`).`);
}

export async function adb(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run("adb", ["-s", await adbSerial(), ...args], opts);
}

/** Runs a shell command in Android as the shell user and returns stdout, or throws. */
export async function adbShell(command: string, timeoutMs = 30_000): Promise<string> {
  const r = await adb(["shell", command], { timeoutMs });
  if (r.timedOut) throw new ToolError(`\`${command}\` timed out after ${timeoutMs / 1000} s`);
  if (r.code !== 0) {
    const out = (r.stderr + r.stdout.toString()).trim();
    throw new ToolError(`\`${command}\` failed with exit code ${r.code}${out ? `: ${out}` : ""}`);
  }
  return r.stdout.toString();
}

// ---- root through sudo waydroid shell ----

let sudoFile: string | null = process.env.WAYDROID_MCP_SUDO_FILE || null;
let sudoRejected: string | null = null;

export const ROOT_HELP =
  "This needs root in Android. adb root is disabled in Waydroid, so root goes through `sudo waydroid shell`, " +
  "and sudo asks for a password. Either call `root_access` with the path of a file that holds the sudo password, " +
  `or add a sudoers rule such as \`${userInfo().username} ALL=(root) NOPASSWD: ${WAYDROID} shell *\`.`;

export function setSudoFile(path: string | null) {
  sudoFile = path;
  sudoRejected = null;
}

export function rootState(): string {
  if (sudoRejected) return `off: ${sudoRejected}`;
  return sudoFile ? `sudo password file ${sudoFile}` : "sudo without a password file (works only with a NOPASSWD rule)";
}

/** Runs a shell command in Android as root. sudo's stdin carries only the password. */
export async function rootShell(command: string, timeoutMs = 30_000): Promise<RunResult> {
  if (sudoRejected) throw new ToolError(sudoRejected);
  const args = [WAYDROID, "shell", "--", "sh", "-c", command];
  let r = await run("sudo", ["-n", ...args], { timeoutMs });
  if (r.code !== 0 && /password is required/.test(r.stderr)) {
    if (!sudoFile) throw new ToolError(ROOT_HELP);
    if (!existsSync(sudoFile)) throw new ToolError(`The sudo password file ${sudoFile} doesn't exist. Call \`root_access\` with a new one.`);
    const pw = readFileSync(sudoFile, "utf8");
    r = await run("sudo", ["-S", "-p", "", ...args], { timeoutMs, input: pw.endsWith("\n") ? pw : pw + "\n" });
    if (/incorrect password|try again|Sorry/i.test(r.stderr)) {
      sudoRejected =
        "sudo rejected the password, so root is off until `root_access` gets a new file. " +
        "Three failures lock sudo for 10 minutes; check with `faillock --user $USER`.";
      throw new ToolError(sudoRejected);
    }
  }
  return r;
}
