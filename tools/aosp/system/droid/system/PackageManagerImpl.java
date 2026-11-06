package droid.system;

import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PackageParser;
import android.content.pm.ResolveInfo;
import java.util.ArrayList;
import java.util.List;

/** The package manager: the app itself, from its manifest. */
public class PackageManagerImpl extends droid.defaults.DefaultIPackageManager {
    private boolean mine(String pkg) { return pkg != null && pkg.equals(Pkg.app.packageName); }
    @Override public ApplicationInfo getApplicationInfo(String packageName, int flags, int userId) { return mine(packageName) ? Pkg.app : null; }
    @Override public ActivityInfo getActivityInfo(ComponentName c, int flags, int userId) { return c != null && mine(c.getPackageName()) ? Pkg.activity(c.getClassName()) : null; }
    @Override public PackageInfo getPackageInfo(String packageName, int flags, int userId) {
        if (!mine(packageName)) return null;
        PackageInfo pi = new PackageInfo();
        pi.packageName = Pkg.pkg.packageName; pi.versionCode = Pkg.pkg.mVersionCode; pi.versionName = Pkg.pkg.mVersionName;
        pi.applicationInfo = Pkg.app; pi.firstInstallTime = pi.lastUpdateTime = System.currentTimeMillis();
        pi.signatures = new android.content.pm.Signature[] { new android.content.pm.Signature(new byte[] { 0x30, 0x00 }) };
        return pi;
    }
    @Override public ResolveInfo resolveIntent(Intent intent, String resolvedType, int flags, int userId) {
        List<ResolveInfo> l = queryIntentActivities(intent, resolvedType, flags, userId);
        return l.isEmpty() ? null : l.get(0);
    }
    @Override public List<ResolveInfo> queryIntentActivities(Intent intent, String resolvedType, int flags, int userId) {
        List<ResolveInfo> out = new ArrayList<ResolveInfo>();
        ComponentName c = intent.getComponent();
        for (PackageParser.Activity a : Pkg.pkg.activities) {
            boolean hit = c != null ? a.info.name.equals(c.getClassName()) : false;
            if (!hit && c == null) for (android.content.IntentFilter f : a.intents) if (f.match(intent.getAction(), resolvedType, intent.getScheme(), intent.getData(), intent.getCategories(), "droid") >= 0) { hit = true; break; }
            if (hit) { ResolveInfo ri = new ResolveInfo(); ri.activityInfo = a.info; out.add(ri); }
        }
        return out;
    }
    @Override public int checkPermission(String permName, String pkgName) { return PackageManager.PERMISSION_GRANTED; }
    @Override public int checkUidPermission(String permName, int uid) { return PackageManager.PERMISSION_GRANTED; }
    @Override public String[] getPackagesForUid(int uid) { return new String[] { Pkg.app.packageName }; }
    @Override public String getNameForUid(int uid) { return Pkg.app.packageName; }
    @Override public String getInstallerPackageName(String packageName) { return "droid.store"; }
    @Override public int getComponentEnabledSetting(ComponentName componentName, int userId) { return PackageManager.COMPONENT_ENABLED_STATE_DEFAULT; }
    @Override public int getApplicationEnabledSetting(String packageName, int userId) { return PackageManager.COMPONENT_ENABLED_STATE_DEFAULT; }
    @Override public boolean hasSystemFeature(String name) { return name != null && (name.startsWith("android.hardware.touchscreen") || name.equals("android.hardware.screen.portrait") || name.equals("android.hardware.wifi")); }
    @Override public android.content.pm.FeatureInfo[] getSystemAvailableFeatures() { return new android.content.pm.FeatureInfo[0]; }
    @Override public String[] getSystemSharedLibraryNames() { return new String[0]; }
    @Override public boolean isSafeMode() { return false; }
    @Override public boolean hasSystemUidErrors() { return false; }
}
