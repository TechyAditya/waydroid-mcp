# How ui_tree reads every display

`ui_tree` doesn't use `uiautomator dump`, because that command can't see an app on a hidden display. waydroid-mcp runs its own small dumper inside Android instead.

## What uiautomator dump gets wrong

`uiautomator dump` reads one window, the active one. In testing with two hidden apps open, it returned the tree of the app opened last, for either package. Focusing the other app's display with `waydroid-app-displays focus` didn't change the window it read.

It also clips bounds to the size of display 0. In the same test, display 0 was 1256x1512 and a hidden phone display was 1080x2340. On the phone display, the root element's bounds ended at y 1512 instead of 2340, and elements below that line had clipped bounds.

[How do you get an Android hierarchy dump based on display id?](https://stackoverflow.com/questions/65078563/how-do-you-get-an-android-hierarchy-dump-based-on-display-id) describes the same limit, from the source of `DumpCommand.java`.

## What the dumper does instead

Android 11 added `UiAutomation.getWindowsOnAllDisplays()`, which returns the windows of every display, keyed by display id. Appium's UiAutomator2 driver uses it for the same reason, as its [multi-display guide](https://appium.github.io/appium-uiautomator2-driver/latest/guides/multiwindow/) describes.

The dumper is one Java class, `android/src/waydroidmcp/UiDump.java`. It runs with `app_process` as adb's shell user, as the `uiautomator` command does, so it needs no root and no installed app. It connects a `UiAutomation` the same way that command does, through two hidden APIs that it calls by reflection. It asks for interactive windows, reads the windows of one display, and prints their trees in `uiautomator dump`'s XML, with a `<window>` element around each window. The bounds come from `getBoundsInScreen()` and are not clipped.

The dumper connects with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`. A plain `uiautomator dump` turns off other accessibility services while it runs, and this flag leaves them on.

## How the server runs it

The npm package ships the dumper prebuilt as `assets/uidump.jar`, about 4 kB, so users don't need Java. On the first `ui_tree` call, the server pushes the jar to `/data/local/tmp` under a name that includes the jar's hash. A new version of the jar replaces the old one.

If the dumper fails, `ui_tree` falls back to `uiautomator dump` and says so in its reply. The dumper needs a hidden `UiAutomation(Looper, IUiAutomationConnection)` constructor, and it has been tested on Android 13 only. On an Android version without that constructor, `ui_tree` uses the fallback.
