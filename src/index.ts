#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { register as apps } from "./tools/apps.js";
import { register as debug } from "./tools/debug.js";
import { register as screen } from "./tools/screen.js";
import { register as session } from "./tools/session.js";
import { register as system } from "./tools/system.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const server = new McpServer(
  { name: "waydroid", version },
  {
    instructions:
      "Tools to run, drive and debug Android apps in Waydroid on a Linux desktop. Call `status` first; `session` starts " +
      "Waydroid if it's stopped. Open apps with `launch_app`: `hidden` runs an app on an off-screen display at a chosen size " +
      "and density, which suits automated checks. Act on an app by package name; input coordinates are display pixels. " +
      "Debug with `logcat`, `logcat_follow`, `crashes`, `stack_dump`, `trace` and `app_perf`. Files the tools write " +
      "(screenshots, recordings, traces) go to /tmp/waydroid-mcp.",
  },
);

session(server);
apps(server);
screen(server);
debug(server);
system(server);

await server.connect(new StdioServerTransport());
