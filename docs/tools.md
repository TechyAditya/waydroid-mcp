# Tools

waydroid-mcp has 25 tools. Each tool describes its parameters in its MCP schema.

## Targets and coordinates

A tool that acts on an app takes `package`, or `display_id` for a display.

- An app in its own window or on a hidden display is found by its package.
- Any other app is on display 0, Waydroid's main window.
- Coordinates for `input`, and the coordinates that `ui_tree` returns, are display pixels.
- `screenshot` can return a scaled-down image. It then reports the scale, and you divide image coordinates by it to get display pixels.
- A display id changes each time an app is closed and opened again.

## Session

| Tool | Description |
|---|---|
| `status` | Session state, adb serial, boot state, Android and LineageOS versions, graphics, the per-app window service, open app displays and the root setup. |
| `session` | Starts, stops or restarts the Waydroid session. `start` waits until Android has booted. |
| `list_displays` | Android's displays with size and density, and the apps open in their own windows or on hidden displays. |
| `root_access` | Sets the file that holds the sudo password, and runs `id -u` as root once to check it. |

## Apps

| Tool | Description |
|---|---|
| `list_apps` | Launchable, third-party or all packages, with app names. |
| `app_info` | Version, SDK levels, debuggable flag, paths, launcher activity, running processes, open display and permissions of one package. |
| `launch_app` | Opens an app in its own window (`window`), on a hidden display (`hidden`), or in Waydroid's window (`waydroid`). `size` and `dpi` fix the display, and `restart` force-stops the app first for a cold start. Launching an open app again applies the new options. Returns after the app has drawn its first frame, and in Waydroid's window after the window has stopped resizing. |
| `start_activity` | Starts an intent on a display: a URL, a deep link or a component. Returns the launch time from `am start -W`. |
| `install_apk` | Installs an APK, or an `.apks`, `.xapk` or `.apkm` bundle, from a host path or a URL. Returns the package name and version. |
| `app_action` | Force-stops an app, clears its data, uninstalls it, grants or revokes a permission, or closes its own window. |

## Screen and input

| Tool | Description |
|---|---|
| `screenshot` | Returns a screenshot as an image, and saves the full-size PNG. An app's own display is captured by waydroid-app-displays, and display 0 by `screencap`. `wait_ms` waits first, for a page change after input. |
| `record_screen` | Records a display to MP4 for up to 50 seconds. |
| `ui_tree` | The accessibility tree of the windows on a display, one line per element: class, text, hint, description, resource id, state flags, center coordinates and bounds. |
| `input` | Tap, long press, swipe, text and key events. `tap` and `long_press` take coordinates, or an element's text, description or resource id. |

## Debugging

| Tool | Description |
|---|---|
| `logcat` | Recent log lines, filtered by app, tag, priority, time and regular expression. |
| `logcat_follow` | Collects new log lines in the background. `read` returns the lines since the last read, and can wait for a line that matches a regular expression. |
| `crashes` | Java crashes, native crashes and ANRs from Android's dropbox, tombstones and ANR traces, newest first. With `read`, returns one full report. Tombstones and ANR traces are host files, so they are listed even when adb can't reach Android. |
| `stack_dump` | Java or native thread stacks of a running app, from `debuggerd`. Needs root. |
| `trace` | Records a Perfetto trace for up to 50 seconds, optionally of an app's cold start. Open the file at [ui.perfetto.dev](https://ui.perfetto.dev). |
| `app_perf` | Memory summary from `meminfo`, frame stats and jank percentages from `gfxinfo`, and CPU use of an app. |

## System

| Tool | Description |
|---|---|
| `props` | Lists Waydroid's `persist.waydroid.*` settings with their meaning and value, and gets or sets any property. |
| `shell` | Runs a command in Android as adb's shell user, or as root. |
| `files` | Pushes a file to Android or pulls one, also from a debuggable app's private directory. |
| `ports` | adb `reverse` and `forward`, and DevTools for Chromium-based browsers. |
| `host_logs` | `/var/lib/waydroid/waydroid.log`, the journals of the container and the session, and the kernel log. |

## Output files

Screenshots, recordings, traces, stack dumps and long outputs go to `/tmp/waydroid-mcp`. A reply longer than 40,000 characters keeps one end of the text and gives the path of the full file.
