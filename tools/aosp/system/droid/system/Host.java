package droid.system;

import android.view.Surface;

/** What droid's runtime (javascript) tells the framework, and what it is told back. */
public final class Host {
    private Host() {}
    public static native String packageName();
    public static native String apkPath();
    /** the activity to start (a class name), from the launch intent */
    public static native String launchActivity();
    public static native int widthPx();
    public static native int heightPx();
    public static native int densityDpi();
    /** gives a window's Surface the screen to draw into */
    public static native void attachSurface(Surface surface, int window, int left, int top, int right, int bottom);
    /** a window was added (its input channel comes next) / removed */
    public static native void windowAdded(int window);
    public static native void windowRemoved(int window);
    /** the shell hears about the app: "resumed", "finished", titles */
    public static native void event(String what, String detail);
}
