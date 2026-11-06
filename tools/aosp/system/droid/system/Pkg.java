package droid.system;

import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageParser;
import android.content.res.Configuration;
import android.util.DisplayMetrics;
import java.io.File;
import java.util.Locale;

/** The app's package, read by android's own PackageParser from its manifest. */
public final class Pkg {
    private Pkg() {}
    static PackageParser.Package pkg;
    static ApplicationInfo app;

    static void load() {
        String path = Host.apkPath();
        PackageParser pp = new PackageParser(path);
        DisplayMetrics dm = new DisplayMetrics();
        dm.setToDefaults();
        pkg = pp.parsePackage(new File(path), path, dm, 0);
        if (pkg == null) throw new IllegalStateException("could not read the manifest of " + path);
        app = pkg.applicationInfo;
        app.sourceDir = app.publicSourceDir = path;
        app.dataDir = "/data/data/" + pkg.packageName;
        app.nativeLibraryDir = "/data/app-lib/" + pkg.packageName;
        app.uid = 10000;
        app.flags |= ApplicationInfo.FLAG_HAS_CODE | ApplicationInfo.FLAG_INSTALLED;
        app.enabled = true;
        for (PackageParser.Activity a : pkg.activities) fill(a.info);
    }
    private static void fill(ActivityInfo ai) { ai.applicationInfo = app; if (ai.processName == null) ai.processName = app.packageName; }

    /** the app's content providers, for ActivityThread to install at bind */
    static java.util.List<android.content.pm.ProviderInfo> providers() {
        java.util.List<android.content.pm.ProviderInfo> l = new java.util.ArrayList<android.content.pm.ProviderInfo>();
        for (PackageParser.Provider p : pkg.providers) { p.info.applicationInfo = app; if (p.info.processName == null) p.info.processName = app.packageName; l.add(p.info); }
        return l.isEmpty() ? null : l;
    }

    static ActivityInfo activity(String className) {
        for (PackageParser.Activity a : pkg.activities) if (a.info.name.equals(className)) return a.info;
        for (PackageParser.Activity a : pkg.activities) if (a.info.name.endsWith("." + className) || a.info.name.equals(app.packageName + className)) return a.info;
        return null;
    }
    /** the launcher activity (MAIN / LAUNCHER), else the first one */
    static ActivityInfo launcher() {
        String want = Host.launchActivity();
        if (want != null && want.length() > 0) { ActivityInfo ai = activity(want); if (ai != null) return ai; }
        for (PackageParser.Activity a : pkg.activities)
            for (android.content.IntentFilter f : a.intents)
                if (f.hasAction("android.intent.action.MAIN") && f.hasCategory("android.intent.category.LAUNCHER")) return a.info;
        return pkg.activities.isEmpty() ? null : pkg.activities.get(0).info;
    }

    static Configuration config() {
        Configuration c = new Configuration();
        c.setToDefaults();
        int dpi = Host.densityDpi(), w = Host.widthPx(), h = Host.heightPx();
        c.densityDpi = dpi;
        c.screenWidthDp = w * 160 / dpi;
        c.screenHeightDp = h * 160 / dpi;
        c.smallestScreenWidthDp = Math.min(c.screenWidthDp, c.screenHeightDp);
        c.orientation = w > h ? Configuration.ORIENTATION_LANDSCAPE : Configuration.ORIENTATION_PORTRAIT;
        c.screenLayout = (c.smallestScreenWidthDp >= 720 ? Configuration.SCREENLAYOUT_SIZE_XLARGE : c.smallestScreenWidthDp >= 600 ? Configuration.SCREENLAYOUT_SIZE_LARGE : Configuration.SCREENLAYOUT_SIZE_NORMAL) | Configuration.SCREENLAYOUT_LONG_YES;
        c.touchscreen = Configuration.TOUCHSCREEN_FINGER;
        c.keyboard = Configuration.KEYBOARD_NOKEYS;
        c.keyboardHidden = Configuration.KEYBOARDHIDDEN_YES;
        c.hardKeyboardHidden = Configuration.HARDKEYBOARDHIDDEN_YES;
        c.navigation = Configuration.NAVIGATION_NONAV;
        c.uiMode = Configuration.UI_MODE_TYPE_NORMAL | Configuration.UI_MODE_NIGHT_NO;
        c.locale = Locale.getDefault();
        c.fontScale = 1f;
        return c;
    }
}
