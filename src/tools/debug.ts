// SPDX-License-Identifier: AGPL-3.0-or-later
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { hasAppDisplays, packageUid, pidsOf, pkgSchema, sleep, tool } from "../common.js";
import {
  ANDROID_DATA,
  APP_DISPLAYS,
  ToolError,
  WAYDROID,
  adbSerial,
  adbShell,
  clip,
  outPath,
  rootShell,
  run,
  runText,
  sh,
} from "../exec.js";

// ---- logcat filters ----

const filterShape = {
  package: pkgSchema
    .optional()
    .describe("Only lines logged by this app's uid. System apps such as Settings share uid 1000 with system_server."),
  tags: z
    .array(z.string())
    .optional()
    .describe('logcat filter specs such as "ActivityManager:I" or "chromium:V"; tags not listed are hidden.'),
  min_priority: z.enum(["V", "D", "I", "W", "E", "F"]).optional().describe("Lowest priority shown, for every tag not in tags."),
  buffers: z.array(z.enum(["main", "system", "crash", "events", "radio"])).default(["main", "system", "crash"]),
  grep: z.string().optional().describe("JavaScript regular expression a line must match."),
};

type Filters = { package?: string; tags?: string[]; min_priority?: string; buffers: string[]; grep?: string };

async function logcatArgs(f: Filters): Promise<string[]> {
  const args = ["-v", "threadtime", "-b", f.buffers.join(",")];
  if (f.package) args.push(`--uid=${await packageUid(f.package)}`);
  if (f.tags?.length) args.push(...f.tags, `*:${f.min_priority ?? "S"}`);
  else if (f.min_priority) args.push(`*:${f.min_priority}`);
  return args;
}

function regex(grep?: string): RegExp | null {
  if (!grep) return null;
  try {
    return new RegExp(grep);
  } catch (e) {
    throw new ToolError(`grep isn't a valid regular expression: ${(e as Error).message}`);
  }
}

// ---- followers ----

interface Follower {
  id: number;
  proc: ChildProcess;
  lines: string[];
  base: number; // absolute index of lines[0]
  cursor: number; // absolute index of the first unread line
  ended: string | null;
  describe: string;
}

const MAX_BUFFERED = 20_000;
const followers = new Map<number, Follower>();
let nextId = 1;

process.on("exit", () => {
  for (const f of followers.values()) f.proc.kill();
});

function unread(f: Follower): string[] {
  return f.lines.slice(Math.max(0, f.cursor - f.base));
}

// ---- crashes ----

interface Crash {
  id: string;
  time: string;
  kind: string;
  process: string;
  summary: string;
  text?: string;
  file?: string;
}

const crashCache = new Map<string, Crash>();
const DROPBOX_TAGS = [
  "data_app_crash",
  "system_app_crash",
  "data_app_native_crash",
  "system_app_native_crash",
  "data_app_anr",
  "system_app_anr",
  "system_server_crash",
];

function head(file: string, bytes = 6000): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString();
  } finally {
    closeSync(fd);
  }
}

function fileCrashes(dir: string, kind: "tombstone" | "anr", since: number): Crash[] {
  const root = join(ANDROID_DATA, dir);
  if (!existsSync(root)) return [];
  const out: Crash[] = [];
  for (const name of readdirSync(root)) {
    if (name.endsWith(".pb") || !/^(tombstone_|anr_|trace_)/.test(name)) continue;
    const file = join(root, name);
    let st, text;
    try {
      st = statSync(file);
      if (st.mtimeMs < since) continue;
      text = head(file);
    } catch {
      continue;
    }
    const proc =
      kind === "tombstone" ? (text.match(/>>> (\S+) <<</)?.[1] ?? "?") : (text.match(/^Cmd line: (\S+)/m)?.[1] ?? "?");
    const summary =
      kind === "tombstone"
        ? [text.match(/^signal .*$/m)?.[0], text.match(/^Abort message: .*$/m)?.[0]].filter(Boolean).join("; ")
        : (text.match(/^Subject: .*$/m)?.[0] ?? "ANR traces");
    out.push({ id: `${kind}:${name}`, time: st.mtime.toISOString(), kind, process: proc, summary, file });
  }
  return out;
}

async function dropboxCrashes(since: number): Promise<Crash[]> {
  const out: Crash[] = [];
  for (const tag of DROPBOX_TAGS) {
    const dump = await adbShell(`dumpsys dropbox --print ${tag}`, 60_000);
    for (const entry of dump.split(/^={20,}$/m).slice(1)) {
      const m = entry.match(/^\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (\S+) \(text, \d+ bytes\)\n([\s\S]*)$/);
      if (!m || m[2] !== tag) continue;
      const time = new Date(`${m[1].replace(" ", "T")}Z`);
      if (time.getTime() < since) continue;
      const body = m[3];
      const proc = body.match(/^Process: (\S+)/m)?.[1] ?? "?";
      const summary =
        body.match(/^Subject: .*$/m)?.[0] ??
        body.match(/^(?:Caused by: )?[\w.$]+(?:Exception|Error)\b.*$/m)?.[0] ??
        body.match(/^signal .*$/m)?.[0] ??
        "";
      out.push({ id: `dropbox:${tag}:${m[1].replace(" ", "T")}`, time: time.toISOString(), kind: tag, process: proc, summary, text: body });
    }
  }
  return out;
}

// ---- traces ----

const DEFAULT_CATEGORIES = ["sched", "freq", "idle", "gfx", "view", "wm", "am", "input", "binder_driver", "dalvik", "hal", "res"];

export function register(server: McpServer) {
  tool(
    server,
    "logcat",
    "Recent Android log lines, filtered by app, tag, priority, time and regex. Android's clock is UTC. " +
      "For logs that keep coming, such as while you reproduce a bug, use logcat_follow.",
    {
      ...filterShape,
      since_s: z.number().int().min(1).optional().describe("Only lines from the last N seconds."),
      lines: z.number().int().min(1).max(5000).default(200).describe("Return at most the last N matching lines."),
    },
    async (a) => {
      const args = ["-d", ...(await logcatArgs(a))];
      if (a.since_s) args.push("-T", `${Math.floor(Date.now() / 1000) - a.since_s}.000`);
      const re = regex(a.grep);
      const all = (await adbShell(`logcat ${args.map(sh).join(" ")}`, 60_000))
        .split("\n")
        .filter((l) => l && !l.startsWith("--------- beginning of") && (!re || re.test(l)));
      const shown = all.slice(-a.lines);
      const note = all.length > shown.length ? `[${all.length} lines match; showing the last ${shown.length}.]\n` : "";
      return shown.length ? clip(note + shown.join("\n"), "logcat", a.package ?? "logcat") : "No log lines match.";
    },
    { readOnlyHint: true },
  );

  tool(
    server,
    "logcat_follow",
    "Follows the Android log in the background across calls. `start` begins collecting new lines with the same filters as " +
      "logcat and returns an id. `read` returns the lines since the last read; with wait_for it first waits up to timeout_s " +
      "for a line matching that regex, such as a crash (FATAL EXCEPTION) or your own log message. `stop` ends it; `list` shows all.",
    {
      action: z.enum(["start", "read", "stop", "list"]),
      id: z.number().int().optional().describe("Follower id for read and stop."),
      ...filterShape,
      wait_for: z.string().optional().describe("For read: regex to wait for in new lines."),
      timeout_s: z.number().min(0).max(50).default(0).describe("For read with wait_for: the longest wait."),
      max_lines: z.number().int().min(1).max(5000).default(300).describe("For read: return at most the last N new lines."),
    },
    async (a) => {
      if (a.action === "list") {
        if (!followers.size) return "No followers running.";
        return [...followers.values()]
          .map((f) => `${f.id}: ${f.describe}; ${f.base + f.lines.length - f.cursor} unread lines${f.ended ? `; ${f.ended}` : ""}`)
          .join("\n");
      }
      if (a.action === "start") {
        const args = [...(await logcatArgs(a)), "-T", `${Math.floor(Date.now() / 1000)}.000`];
        const re = regex(a.grep);
        const proc = spawn("adb", ["-s", await adbSerial(), "logcat", ...args], { stdio: ["ignore", "pipe", "pipe"] });
        const describe = [a.package && `package ${a.package}`, a.tags?.length && `tags ${a.tags.join(" ")}`, a.min_priority && `>=${a.min_priority}`, a.grep && `grep /${a.grep}/`]
          .filter(Boolean)
          .join(", ") || "all lines";
        const f: Follower = { id: nextId++, proc, lines: [], base: 0, cursor: 0, ended: null, describe };
        createInterface({ input: proc.stdout! }).on("line", (l) => {
          if (l.startsWith("--------- beginning of") || (re && !re.test(l))) return;
          f.lines.push(l);
          if (f.lines.length > MAX_BUFFERED) {
            const drop = f.lines.length - MAX_BUFFERED;
            f.lines.splice(0, drop);
            f.base += drop;
          }
        });
        let stderr = "";
        proc.stderr!.on("data", (d) => (stderr += d));
        proc.on("close", (code) => (f.ended = `adb logcat exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        followers.set(f.id, f);
        return `Following ${describe} as id ${f.id}. Call read with id ${f.id}.`;
      }
      const f = a.id !== undefined ? followers.get(a.id) : undefined;
      if (!f) throw new ToolError(`No follower ${a.id ?? ""}. \`list\` shows the running ones.`);
      if (a.action === "stop") {
        f.proc.kill();
        followers.delete(f.id);
        return `Stopped follower ${f.id}; ${f.base + f.lines.length - f.cursor} lines were unread.`;
      }
      let waitNote = "";
      if (a.wait_for) {
        const re = regex(a.wait_for)!;
        const deadline = Date.now() + a.timeout_s * 1000;
        let scanned = f.cursor;
        for (;;) {
          const end = f.base + f.lines.length;
          const hit = f.lines.slice(Math.max(0, scanned - f.base)).some((l) => re.test(l));
          scanned = end;
          if (hit) {
            waitNote = `[Matched /${a.wait_for}/.]\n`;
            break;
          }
          if (Date.now() >= deadline || f.ended) {
            waitNote = `[No line matched /${a.wait_for}/ within ${a.timeout_s} s.]\n`;
            break;
          }
          await sleep(200);
        }
      }
      const lines = unread(f);
      f.cursor = f.base + f.lines.length;
      const shown = lines.slice(-a.max_lines);
      const skipped = lines.length > shown.length ? `[${lines.length} new lines; showing the last ${shown.length}.]\n` : "";
      const ended = f.ended ? `\n[${f.ended}]` : "";
      return clip(waitNote + skipped + (shown.join("\n") || "No new lines.") + ended, "logcat", `follow-${f.id}`);
    },
    { readOnlyHint: true },
  );

  tool(
    server,
    "crashes",
    "Lists recent Java crashes and native crashes and ANRs, newest first, from Android's dropbox (kept across reboots), " +
      "tombstones and ANR traces, optionally for one app. Pass `read` with an id from the list for the full report and stack.",
    {
      package: z.string().optional().describe("Only crashes of this process or package."),
      since_h: z.number().min(0).default(24).describe("How many hours back to look."),
      limit: z.number().int().min(1).max(200).default(20),
      read: z.string().optional().describe("An id from the list, such as tombstone:tombstone_03, to return that report."),
    },
    async ({ package: pkg, since_h, limit, read }) => {
      if (read) {
        let c = crashCache.get(read);
        if (!c && /^(tombstone|anr):/.test(read)) {
          const [kind, name] = read.split(":");
          const file = join(ANDROID_DATA, kind === "tombstone" ? "tombstones" : "anr", name);
          if (existsSync(file)) c = { id: read, time: "", kind, process: "", summary: "", file };
        }
        if (!c) throw new ToolError(`Unknown crash id ${read}. List the crashes again to refresh the ids.`);
        return clip(c.text ?? readFileSync(c.file!, "utf8"), "crashes", read.replace(/:/g, "-"), "start");
      }
      const since = Date.now() - since_h * 3_600_000;
      // Tombstones and ANR traces are host files, so they list even when Android is too broken for adb.
      let dropbox: Crash[] = [];
      let note = "";
      try {
        dropbox = await dropboxCrashes(since);
      } catch (e) {
        note = `Android's dropbox isn't readable (${(e as Error).message}), so Java crashes are missing; tombstones and ANR traces are listed.\n`;
      }
      const all = [...dropbox, ...fileCrashes("tombstones", "tombstone", since), ...fileCrashes("anr", "anr", since)]
        .filter((c) => !pkg || c.process === pkg || c.process.startsWith(`${pkg}:`))
        .sort((a, b) => b.time.localeCompare(a.time));
      for (const c of all) crashCache.set(c.id, c);
      if (!all.length) return `${note}No crashes${pkg ? ` of ${pkg}` : ""} in the last ${since_h} h.`;
      return (
        note +
        all
          .slice(0, limit)
          .map((c) => `${c.time}  ${c.kind}  ${c.process}  ${c.summary}\n  read: ${c.id}`)
          .join("\n")
      );
    },
    { readOnlyHint: true },
  );

  tool(
    server,
    "stack_dump",
    "Thread stacks of a running app without killing it: Java stacks (`java`), native backtraces (`native`), or both. " +
      "Uses debuggerd as root (see root_access). Useful for a frozen app or an ANR in progress.",
    {
      package: pkgSchema,
      kind: z.enum(["java", "native", "both"]).default("java"),
    },
    async ({ package: pkg, kind }) => {
      const pids = await pidsOf(pkg);
      if (!pids.length) throw new ToolError(`${pkg} isn't running.`);
      const flags = kind === "both" ? ["-j", "-b"] : [kind === "java" ? "-j" : "-b"];
      const parts: string[] = [];
      for (const pid of pids) {
        for (const flag of flags) {
          const r = await rootShell(`debuggerd ${flag} ${pid}`, 60_000);
          parts.push(`### pid ${pid}, debuggerd ${flag}\n${(r.stdout.toString() || r.stderr).trim()}`);
        }
      }
      const text = parts.join("\n\n");
      const file = `${outPath("stacks", pkg)}.txt`;
      writeFileSync(file, text);
      return `Saved to ${file}.\n${clip(text, "stacks", pkg, "start")}`;
    },
    { readOnlyHint: true },
  );

  tool(
    server,
    "trace",
    "Records a Perfetto system trace (scheduling, frames, binder, app trace sections) for duration_s and saves it on the host. " +
      "With package, the app's own Trace sections are recorded; with launch, the app is force-stopped and launched a second " +
      "into the trace to capture a cold start. Open the file at https://ui.perfetto.dev.",
    {
      duration_s: z.number().int().min(1).max(50).default(10),
      package: pkgSchema.optional(),
      launch: z.boolean().default(false),
      categories: z.array(z.string()).optional().describe(`atrace categories. Default: ${DEFAULT_CATEGORIES.join(" ")}.`),
      buffer_mb: z.number().int().min(4).max(512).default(64),
    },
    async ({ duration_s, package: pkg, launch, categories, buffer_mb }) => {
      if (launch && !pkg) throw new ToolError("launch needs a package.");
      const remote = "/data/misc/perfetto-traces/waydroid-mcp.pftrace";
      const cmd = [`perfetto -o ${remote} -t ${duration_s}s -b ${buffer_mb}mb`, pkg ? `-a ${sh(pkg)}` : "", ...(categories ?? DEFAULT_CATEGORIES).map(sh)].join(" ");
      if (launch) await adbShell(`am force-stop ${sh(pkg!)}`);
      const recording = adbShell(`${cmd} 2>&1`, (duration_s + 30) * 1000);
      if (launch) {
        await sleep(1500);
        if (await hasAppDisplays()) await run(APP_DISPLAYS, ["launch", "--quiet", pkg!], { timeoutMs: 30_000 });
        else await run(WAYDROID, ["app", "launch", pkg!], { timeoutMs: 30_000 });
      }
      const log = await recording;
      const file = `${outPath("traces", pkg ?? "system")}.pftrace`;
      await runText("adb", ["-s", await adbSerial(), "pull", remote, file], { timeoutMs: 60_000 });
      await adbShell(`rm -f ${remote}`);
      const size = statSync(file).size;
      return `Saved a ${(size / 1e6).toFixed(1)} MB trace to ${file}. Open it at https://ui.perfetto.dev (Open trace file).\n${log.trim().split("\n").slice(-3).join("\n")}`;
    },
  );

  tool(
    server,
    "app_perf",
    "An app's memory (PSS summary from meminfo), frame rendering stats (jank percentage and frame time percentiles from gfxinfo) " +
      "and CPU use. reset_frames clears the frame stats afterwards, so the next call measures only what happens in between.",
    {
      package: pkgSchema,
      reset_frames: z.boolean().default(false),
    },
    async ({ package: pkg, reset_frames }) => {
      const pids = await pidsOf(pkg);
      if (!pids.length) throw new ToolError(`${pkg} isn't running.`);
      const mem = await adbShell(`dumpsys meminfo ${sh(pkg)}`, 60_000);
      const summary = mem.match(/App Summary[\s\S]*?TOTAL (?:PSS|SWAP)[^\n]*(?:\n[^\n]*TOTAL SWAP[^\n]*)?/)?.[0] ?? mem.slice(0, 3000);
      const gfx = await adbShell(`dumpsys gfxinfo ${sh(pkg)}`, 60_000);
      const frames = gfx
        .split("\n")
        .filter((l) => /^(Stats since|Total frames rendered|Janky frames|\d+th (gpu )?percentile|Number |HISTOGRAM)/i.test(l.trim()))
        .filter((l) => !/^HISTOGRAM/.test(l.trim()))
        .join("\n");
      const cpu = await adbShell(`top -b -n 1 -p ${pids.join(",")} -o PID,USER,%CPU,%MEM,RES,THREADS,ARGS | tail -n ${pids.length + 1}`);
      if (reset_frames) await adbShell(`dumpsys gfxinfo ${sh(pkg)} reset`);
      return `## Memory\n${summary.trim()}\n\n## Frames\n${frames || "No frames rendered since the last reset."}\n\n## CPU\n${cpu.trim()}`;
    },
    { readOnlyHint: true },
  );
}
