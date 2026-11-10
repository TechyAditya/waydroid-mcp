# waydroid-mcp

An MCP server for developing and debugging Android apps in [Waydroid](https://waydro.id). An agent can start Waydroid, install and launch apps, see and drive them, read their UI tree, follow their logs, collect crashes and stack dumps, and record Perfetto traces.

Apps can run on hidden displays of a fixed size and density, so an agent can test a 360 dp phone layout without a window on your desktop. This needs [waydroid-app-displays](https://github.com/TechyAditya/waydroid-app-displays), whose service runs only when Android uses `gralloc.default`. Waydroid uses that gralloc on NVIDIA GPUs and with software rendering, and a GBM gralloc on Intel and AMD GPUs. Without the service, every tool works on Waydroid's own window.

## Requirements

- Linux with Waydroid, and a running Wayland desktop session.
- Node.js 20 or later.
- `adb` (the `android-tools` package on most distributions).
- Optional: `scrcpy` for recording an app's own display, ImageMagick (`magick`) for scaled-down screenshots, `unzip` for split APK bundles, and waydroid-app-displays for per-app windows and hidden displays.

The server finds Waydroid's adb address from `waydroid status` and connects to it. You don't need to run `adb connect` first.

## Add it to your MCP client

The server talks MCP over stdio. Start your MCP client from your desktop session, so the server inherits `WAYLAND_DISPLAY` and can start Waydroid.

For Cursor, add this to `~/.cursor/mcp.json`:

```json
{
	"mcpServers": {
		"waydroid": {
			"command": "npx",
			"args": ["-y", "waydroid-mcp"]
		}
	}
}
```

For Claude Code:

```sh
claude mcp add waydroid -- npx -y waydroid-mcp
```

To run a local checkout instead, build it with `npm install && npm run build` and use `node /path/to/waydroid-mcp/dist/index.js` as the command.

## Set up root access

adb root is disabled in Waydroid, so tools that need root in Android run `sudo waydroid shell`. Two tools need it: `stack_dump`, and `shell` with `root: true`. Everything else runs as adb's shell user.

Pick one of these:

- Add a sudoers rule for Waydroid's shell, for example in `/etc/sudoers.d/waydroid-mcp`:

	```
	yourname ALL=(root) NOPASSWD: /usr/bin/waydroid shell *
	```

- Point the server at a file that holds your sudo password: set `WAYDROID_MCP_SUDO_FILE` in the server's environment, or have the agent call `root_access` with the file's path.

If sudo rejects the password once, the server turns root off until `root_access` gets a new file. This stops repeated failures from locking sudo through `pam_faillock`.

## Tools

Tools that act on an app take `package`, or `display_id` for a display. An app in its own window or hidden display is found by package. Any other app is on Waydroid's main display, display 0. Coordinates are display pixels.

| Tool | What it does |
|---|---|
| `status` | Session, adb serial, boot state, Android version, graphics, open app displays and root setup. |
| `session` | Starts, stops or restarts the Waydroid session. `start` waits for Android to boot. |
| `list_displays` | Android's displays with size and density, and the apps open in their own windows. |
| `root_access` | Sets the sudo password file, and checks root once. |
| `list_apps` | Launchable, third-party or all packages, with app names. |
| `app_info` | Version, SDK levels, debuggable flag, paths, launcher activity, processes and permissions. |
| `launch_app` | Opens an app in its own window, on a hidden display, or in Waydroid's window. Takes `size` (such as `720x1280`), `dpi` and `restart` for a cold start. |
| `start_activity` | Starts an intent on a display: a URL, a deep link or a component. Returns the launch time. |
| `install_apk` | Installs an APK or an `.apks`, `.xapk` or `.apkm` bundle from a path or URL. |
| `app_action` | Force-stop, clear data, uninstall, grant or revoke a permission, or close the app's window. |
| `screenshot` | Returns a screenshot as an image and saves the full-size PNG. |
| `record_screen` | Records a display to MP4 for up to 50 seconds. |
| `ui_tree` | The accessibility tree of a display's windows, with text, ids, flags and tap coordinates. |
| `input` | Tap, long press, swipe, text and key events. Tap and long press can find an element by its text, description or id. |
| `logcat` | Recent log lines filtered by app, tag, priority, time and regex. |
| `logcat_follow` | Collects new log lines in the background. `read` returns what is new, and can wait for a line that matches a regex. |
| `crashes` | Java crashes, native crashes and ANRs from Android's dropbox, tombstones and ANR traces. Returns a full report by id. |
| `stack_dump` | Java or native thread stacks of a running app, through `debuggerd`. Needs root. |
| `trace` | Records a Perfetto trace, optionally of an app's cold start, and saves it for [ui.perfetto.dev](https://ui.perfetto.dev). |
| `app_perf` | Memory summary, frame stats with jank percentages, and CPU use of an app. |
| `props` | Lists Waydroid's `persist.waydroid.*` settings with their meaning, and gets or sets any property. |
| `shell` | Runs a command in Android, as the shell user or as root. |
| `files` | Pushes files to Android or pulls them, including from a debuggable app's private directory. |
| `ports` | adb `reverse` and `forward`, and DevTools for Chromium-based browsers. |
| `host_logs` | `waydroid.log`, the container and session journals, and the kernel log. |

Screenshots, recordings, traces, stack dumps and long outputs go to `/tmp/waydroid-mcp`.

## How `ui_tree` reads other displays

`uiautomator dump` reads only the focused window and clips bounds to the main display, so it can't see an app on a hidden display. `ui_tree` runs a small dumper inside Android instead. It connects to `UiAutomation` the way the `uiautomator` command does, and reads every display's windows through `getWindowsOnAllDisplays()`, which needs Android 11 or later. The server pushes it to `/data/local/tmp` on first use. If it fails, `ui_tree` falls back to `uiautomator dump` and says so.

The dumper's source is `android/src/waydroidmcp/UiDump.java`, and the package ships it built as `assets/uidump.jar`. To rebuild it, run `android/build.sh`. The script needs `java` and downloads its compiler, `d8` and the Android 13 `android.jar` into `android/build/tools`, checking each file's SHA-256.

## License

[GNU Affero General Public License v3.0 or later](LICENSE). If you distribute a modified version, or let people use one over a network, you must offer them its source code under the same license.
