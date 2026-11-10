import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APP_DISPLAYS, ToolError, adbShell, run, sh } from "./exec.js";

type Shape = Record<string, z.ZodType>;
type Reply = CallToolResult | string;

/** Registers a tool whose ToolErrors become error results instead of protocol errors. */
export function tool<S extends Shape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<Reply>,
  annotations: ToolAnnotations = {},
) {
  server.registerTool(name, { description, inputSchema: shape, annotations }, (async (args: z.infer<z.ZodObject<S>>) => {
    try {
      const r = await handler(args);
      return typeof r === "string" ? text(r) : r;
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  }) as never);
}

export const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
export const json = (o: unknown) => JSON.stringify(o, null, 2);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const pkgSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/, "an Android package name such as com.android.settings");

export const targetShape = {
  package: pkgSchema
    .optional()
    .describe("App to act on. An app in its own window or hidden display is found by package; otherwise Waydroid's main display is used."),
  display_id: z.number().int().min(0).optional().describe("Android display id instead of a package; 0 is Waydroid's main display."),
};

// ---- per-app displays (waydroid-app-displays) ----

export interface AppDisplay {
  package: string;
  display_id: number;
  width: number;
  height: number;
  dpi: number;
  hidden: boolean;
  window: [number, number] | null;
  fixed_size: [number, number] | null;
  fixed_dpi: number | null;
}

let appDisplaysInstalled: boolean | null = null;

export async function hasAppDisplays(): Promise<boolean> {
  if (appDisplaysInstalled === null) {
    appDisplaysInstalled = (await run("sh", ["-c", `command -v ${APP_DISPLAYS}`])).code === 0;
  }
  return appDisplaysInstalled;
}

export const APP_DISPLAYS_HELP =
  "Per-app windows and hidden displays need waydroid-app-displays (https://github.com/TechyAditya/waydroid-app-displays), " +
  "which isn't on PATH. `mode: \"waydroid\"` uses Waydroid's own window instead.";

/** The apps open in their own windows or hidden displays; empty when the service isn't there. */
export async function appDisplays(): Promise<AppDisplay[]> {
  if (!(await hasAppDisplays())) return [];
  const r = await run(APP_DISPLAYS, ["list", "--json"], { timeoutMs: 10_000 });
  if (r.code !== 0) return [];
  try {
    return JSON.parse(r.stdout.toString()) as AppDisplay[];
  } catch {
    return [];
  }
}

export interface Target {
  display: number;
  width: number;
  height: number;
  package?: string;
  app?: AppDisplay;
}

export interface AndroidDisplay {
  id: number;
  name: string;
  width: number;
  height: number;
  dpi: number | null;
}

/** Android's logical displays, from dumpsys display. */
export async function androidDisplays(): Promise<AndroidDisplay[]> {
  const out = await adbShell("dumpsys display | grep mOverrideDisplayInfo");
  const seen = new Map<number, AndroidDisplay>();
  for (const m of out.matchAll(/DisplayInfo\{"([^"]*)", displayId (\d+)[^\n]*?real (\d+) x (\d+)(?:[^\n]*?density (\d+))?/g)) {
    const id = Number(m[2]);
    seen.set(id, { id, name: m[1], width: Number(m[3]), height: Number(m[4]), dpi: m[5] ? Number(m[5]) : null });
  }
  return [...seen.values()];
}

export async function resolveTarget(pkg?: string, displayId?: number): Promise<Target> {
  const apps = await appDisplays();
  if (displayId !== undefined) {
    const app = apps.find((a) => a.display_id === displayId);
    if (app) return { display: displayId, width: app.width, height: app.height, package: app.package, app };
    const d = (await androidDisplays()).find((x) => x.id === displayId);
    if (!d) throw new ToolError(`Android has no display ${displayId}. \`list_displays\` shows the open ones.`);
    return { display: displayId, width: d.width, height: d.height, package: pkg };
  }
  const app = pkg ? apps.find((a) => a.package === pkg) : undefined;
  if (app) {
    if (app.display_id < 0) throw new ToolError(`${pkg} is opening and has no display yet. Try again in a second.`);
    return { display: app.display_id, width: app.width, height: app.height, package: pkg, app };
  }
  const main = (await androidDisplays()).find((x) => x.id === 0);
  return { display: 0, width: main?.width ?? 0, height: main?.height ?? 0, package: pkg };
}

// ---- packages ----

export async function packageUid(pkg: string): Promise<number> {
  const out = await adbShell(`pm list packages -U ${sh(pkg)}`);
  const m = out.match(new RegExp(`^package:${pkg.replace(/\./g, "\\.")} uid:(\\d+)`, "m"));
  if (!m) throw new ToolError(`${pkg} isn't installed. \`list_apps\` lists the installed packages.`);
  return Number(m[1]);
}

export async function pidsOf(pkg: string): Promise<number[]> {
  const out = await adbShell(`pidof ${sh(pkg)} || true`);
  return out.trim().split(/\s+/).filter(Boolean).map(Number);
}
