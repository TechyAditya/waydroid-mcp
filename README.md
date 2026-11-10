# waydroid-mcp

An MCP server that lets an agent run and debug Android apps in [Waydroid](https://waydro.id). The agent can install and open apps, take screenshots, read the UI tree, tap and type, follow logs, collect crashes and stack dumps, and record Perfetto traces. [Tools](docs/tools.md) lists all 25 tools.

With [waydroid-app-displays](https://github.com/TechyAditya/waydroid-app-displays), an app can run on a hidden display of a fixed size and density. An agent can then check a 360 dp phone layout without opening a window on your desktop. Without waydroid-app-displays, the tools work on Waydroid's own window.

## Requirements

- Linux with Waydroid, in a Wayland desktop session.
- Node.js 20 or later.
- `adb`, from the `android-tools` package on most distributions.

These are optional:

- `scrcpy`, to record an app's own display.
- ImageMagick (`magick`), to return scaled-down screenshots.
- `unzip`, to install split APK bundles.
- waydroid-app-displays, for per-app windows and hidden displays. Its service runs only when Android uses `gralloc.default`. Waydroid uses that gralloc on NVIDIA GPUs and with software rendering. On Intel and AMD GPUs, Waydroid uses a GBM gralloc, and the service stays off.

You don't need to run `adb connect`. The server reads Waydroid's address from `waydroid status` and connects adb itself.

## Add the server to your MCP client

The server talks MCP over stdio. Start your MCP client from your desktop session, so that the server gets `WAYLAND_DISPLAY` and can start Waydroid.

To add it to Cursor, put this in `~/.cursor/mcp.json`:

```json
{
	"mcpServers": {
		"waydroid": {
			"command": "npx",
			"args": ["-y", "github:TechyAditya/waydroid-mcp#v0.1.0"]
		}
	}
}
```

To add it to Claude Code, run:

```sh
claude mcp add waydroid -- npx -y github:TechyAditya/waydroid-mcp#v0.1.0
```

On the first run, npm clones the repository and builds the server. To skip the build, give npm the prebuilt package from the [v0.1.0 release](https://github.com/TechyAditya/waydroid-mcp/releases/tag/v0.1.0) instead. Replace `github:TechyAditya/waydroid-mcp#v0.1.0` with `https://github.com/TechyAditya/waydroid-mcp/releases/download/v0.1.0/waydroid-mcp-0.1.0.tgz`.

## Set up root access

Two tools need root in Android: `stack_dump`, and `shell` with `root: true`. adb root is disabled in Waydroid, so the server runs `sudo waydroid shell` for them. The other tools run as adb's shell user and need no setup.

To let the server use sudo, do one of these:

- Add a sudoers rule for Waydroid's shell, for example in `/etc/sudoers.d/waydroid-mcp`. Replace `yourname` with your user name:

	```
	yourname ALL=(root) NOPASSWD: /usr/bin/waydroid shell *
	```

- Put your sudo password in a file that only you can read. Then set `WAYDROID_MCP_SUDO_FILE` to its path in the server's environment, or have the agent call `root_access` with the path.

If sudo rejects the password once, the server turns root off until `root_access` gets a new file. By default, `pam_faillock` locks sudo after three failed attempts, and this stops the server from reaching that limit.

## Build from source

1. Clone the repository.
2. Run `npm install` in it. npm installs the dependencies and builds the server into `dist`.
3. Use `node /path/to/waydroid-mcp/dist/index.js` as the command in your MCP client.

`ui_tree` runs a small UI dumper inside Android, and `assets/uidump.jar` has it prebuilt. [How ui_tree reads every display](docs/ui-tree.md) explains why. To rebuild the dumper after you change `android/src`, run `android/build.sh`. The script needs `java`. It downloads the Java compiler, `d8` and the Android 13 `android.jar` into `android/build/tools`, and checks the SHA-256 of each file.

## License

waydroid-mcp is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). If you distribute a modified version, or let people use one over a network, you must offer them its source code under the same license.
