package waydroidmcp;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.SparseArray;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.List;

/**
 * Prints the accessibility trees of the windows on one display, in uiautomator dump's XML with a
 * {@code <window>} element around each window. `uiautomator dump` only reads the focused window and
 * clips bounds to the default display, so it can't see apps on other displays.
 *
 * <p>Run as adb's shell user: {@code CLASSPATH=uidump.jar app_process / waydroidmcp.UiDump DISPLAY_ID}
 */
public final class UiDump {
    private static final int MAX_DEPTH = 120;

    public static void main(String[] args) {
        int display = args.length > 0 ? Integer.parseInt(args[0]) : 0;
        try {
            UiAutomation ua = connect();
            AccessibilityServiceInfo info = ua.getServiceInfo();
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                    | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                    | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            ua.setServiceInfo(info);
            try {
                ua.waitForIdle(300, 3000);
            } catch (Exception e) {
                // An animating app never goes idle; dump what is there.
            }
            List<AccessibilityWindowInfo> windows = null;
            SparseArray<List<AccessibilityWindowInfo>> all = null;
            for (int i = 0; i < 30; i++) {
                all = ua.getWindowsOnAllDisplays();
                windows = all.get(display);
                if (windows != null && !windows.isEmpty()) break;
                Thread.sleep(100);
            }
            if (windows == null || windows.isEmpty()) {
                StringBuilder ids = new StringBuilder();
                for (int i = 0; i < all.size(); i++) ids.append(i > 0 ? "," : "").append(all.keyAt(i));
                System.err.println("no windows on display " + display + "; displays with windows: " + ids);
                System.exit(2);
            }
            StringBuilder out = new StringBuilder(64 * 1024);
            out.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy display=\"")
                    .append(display).append("\">");
            for (AccessibilityWindowInfo w : windows) {
                out.append("<window");
                attr(out, "type", windowType(w.getType()));
                attr(out, "title", w.getTitle());
                attr(out, "layer", String.valueOf(w.getLayer()));
                attr(out, "active", String.valueOf(w.isActive()));
                attr(out, "focused", String.valueOf(w.isFocused()));
                out.append(">");
                AccessibilityNodeInfo root = w.getRoot();
                if (root != null) dump(root, 0, 0, out);
                out.append("</window>");
            }
            out.append("</hierarchy>");
            System.out.println(out);
            System.out.flush();
            try {
                Method disconnect = UiAutomation.class.getDeclaredMethod("disconnect");
                disconnect.setAccessible(true);
                disconnect.invoke(ua);
            } catch (Exception e) {
                // The process exits anyway.
            }
            System.exit(0);
        } catch (Throwable t) {
            System.err.println("UiDump failed: " + t);
            System.exit(1);
        }
    }

    /** A UiAutomation connected the way the uiautomator command connects one: hidden APIs. */
    private static UiAutomation connect() throws Exception {
        HandlerThread thread = new HandlerThread("UiDump");
        thread.start();
        Class<?> iface = Class.forName("android.app.IUiAutomationConnection");
        Object conn = Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor().newInstance();
        UiAutomation ua = null;
        for (Constructor<?> c : UiAutomation.class.getDeclaredConstructors()) {
            Class<?>[] p = c.getParameterTypes();
            if (p.length == 2 && p[0] == Looper.class && p[1] == iface) {
                c.setAccessible(true);
                ua = (UiAutomation) c.newInstance(thread.getLooper(), conn);
            }
        }
        if (ua == null) throw new IllegalStateException("no UiAutomation(Looper, IUiAutomationConnection) on this Android");
        // Other accessibility services keep running, unlike with a plain connect().
        Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
        connect.setAccessible(true);
        connect.invoke(ua, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        return ua;
    }

    private static void dump(AccessibilityNodeInfo n, int index, int depth, StringBuilder out) {
        if (depth > MAX_DEPTH) return;
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        out.append("<node");
        attr(out, "index", String.valueOf(index));
        attr(out, "text", n.getText());
        attr(out, "hint", n.getHintText());
        attr(out, "resource-id", n.getViewIdResourceName());
        attr(out, "class", n.getClassName());
        attr(out, "package", n.getPackageName());
        attr(out, "content-desc", n.getContentDescription());
        attr(out, "checkable", String.valueOf(n.isCheckable()));
        attr(out, "checked", String.valueOf(n.isChecked()));
        attr(out, "clickable", String.valueOf(n.isClickable()));
        attr(out, "enabled", String.valueOf(n.isEnabled()));
        attr(out, "focusable", String.valueOf(n.isFocusable()));
        attr(out, "focused", String.valueOf(n.isFocused()));
        attr(out, "scrollable", String.valueOf(n.isScrollable()));
        attr(out, "long-clickable", String.valueOf(n.isLongClickable()));
        attr(out, "password", String.valueOf(n.isPassword()));
        attr(out, "selected", String.valueOf(n.isSelected()));
        attr(out, "editable", String.valueOf(n.isEditable()));
        attr(out, "visible", String.valueOf(n.isVisibleToUser()));
        attr(out, "bounds", "[" + r.left + "," + r.top + "][" + r.right + "," + r.bottom + "]");
        out.append(">");
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c != null) dump(c, i, depth + 1, out);
        }
        out.append("</node>");
    }

    private static String windowType(int type) {
        switch (type) {
            case AccessibilityWindowInfo.TYPE_APPLICATION: return "application";
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD: return "input_method";
            case AccessibilityWindowInfo.TYPE_SYSTEM: return "system";
            case AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY: return "accessibility_overlay";
            case AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER: return "split_screen_divider";
            case AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY: return "magnification_overlay";
            default: return String.valueOf(type);
        }
    }

    private static void attr(StringBuilder out, String name, CharSequence value) {
        if (value == null) value = "";
        out.append(' ').append(name).append("=\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '&': out.append("&amp;"); break;
                case '<': out.append("&lt;"); break;
                case '>': out.append("&gt;"); break;
                case '"': out.append("&quot;"); break;
                case '\n': out.append("&#10;"); break;
                default:
                    if (c >= 0x20 || c == '\t') out.append(c);
            }
        }
        out.append('"');
    }
}
