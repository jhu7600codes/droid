package droid.system;

import android.app.ActivityManager;
import android.app.IApplicationThread;
import android.app.IActivityManager.ContentProviderHolder;
import android.app.ResultInfo;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.CompatibilityInfo;
import android.content.res.Configuration;
import android.os.Binder;
import android.os.Bundle;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

/**
 * The activity manager for one app: binds it, starts its activities on android's own
 * ActivityThread (launch, pause, resume, finish, results) and keeps their stack.
 */
public class ActivityManagerImpl extends droid.defaults.DefaultIActivityManager {
    static class Rec { IBinder token; ActivityInfo info; Intent intent; Rec caller; String resultWho; int requestCode; boolean finishing; }
    private IApplicationThread thread;
    private final ArrayList<Rec> stack = new ArrayList<Rec>();
    private int ident;

    @Override public void attachApplication(IApplicationThread app) {
        thread = app;
        try {
            thread.bindApplication(Pkg.app.packageName, Pkg.app, Pkg.providers(), null, null, null, false, null, null, null, 0, false, false, false,
                    Pkg.config(), CompatibilityInfo.DEFAULT_COMPATIBILITY_INFO, null, new Bundle());
            ActivityInfo ai = Pkg.launcher();
            if (ai == null) { Host.event("finished", "no activity"); return; }
            Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setComponent(new ComponentName(Pkg.app.packageName, ai.name));
            launch(ai, i, null, null, -1);
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    private void launch(ActivityInfo ai, Intent intent, Rec caller, String resultWho, int requestCode) throws Exception {
        Rec top = stack.isEmpty() ? null : stack.get(stack.size() - 1);
        Rec r = new Rec();
        r.token = new Binder(); r.info = ai; r.intent = intent; r.caller = caller; r.resultWho = resultWho; r.requestCode = requestCode;
        stack.add(r);
        if (top != null) thread.schedulePauseActivity(top.token, false, true, 0);
        thread.scheduleLaunchActivity(intent, r.token, ident++, ai, Pkg.config(), CompatibilityInfo.DEFAULT_COMPATIBILITY_INFO, 2,
                null, null, null, false, true, null, null, false);
        if (top != null) thread.scheduleStopActivity(top.token, false, 0);
        Host.event("resumed", ai.name);
    }

    private Rec find(IBinder token) { for (Rec r : stack) if (r.token == token) return r; return null; }

    @Override public int startActivity(IApplicationThread caller, String callingPackage, Intent intent, String resolvedType, IBinder resultTo,
            String resultWho, int requestCode, int flags, String profileFile, ParcelFileDescriptor profileFd, Bundle options) {
        ComponentName c = intent.getComponent();
        ActivityInfo ai = c != null && c.getPackageName().equals(Pkg.app.packageName) ? Pkg.activity(c.getClassName()) : null;
        if (ai == null) { Host.event("intent", intent.toUri(0)); return ActivityManager.START_SUCCESS; }
        try { launch(ai, intent, find(resultTo), resultWho, requestCode); } catch (Exception e) { throw new RuntimeException(e); }
        return ActivityManager.START_SUCCESS;
    }

    @Override public boolean finishActivity(IBinder token, int resultCode, Intent data) {
        Rec r = find(token);
        if (r == null || r.finishing) return false;
        r.finishing = true;
        int at = stack.indexOf(r);
        boolean wasTop = at == stack.size() - 1;
        stack.remove(r);
        try {
            thread.scheduleDestroyActivity(r.token, true, 0);
            if (r.caller != null && r.requestCode >= 0 && stack.contains(r.caller)) {
                List<ResultInfo> res = new ArrayList<ResultInfo>();
                res.add(new ResultInfo(r.resultWho, r.requestCode, resultCode, data));
                thread.scheduleSendResult(r.caller.token, res);
            }
            if (wasTop && !stack.isEmpty()) {
                Rec top = stack.get(stack.size() - 1);
                thread.scheduleWindowVisibility(top.token, true);
                thread.scheduleResumeActivity(top.token, 2, false);
                Host.event("resumed", top.info.name);
            }
            if (stack.isEmpty()) Host.event("finished", "");
        } catch (Exception e) { throw new RuntimeException(e); }
        return true;
    }

    // content providers: android's settings, and the app's own ones (installed by ActivityThread at bind)
    private SettingsProvider settings;
    @Override public ContentProviderHolder getContentProvider(IApplicationThread caller, String name, int userId, boolean stable) {
        if ("settings".equals(name)) {
            if (settings == null) {
                settings = new SettingsProvider();
                android.content.pm.ProviderInfo pi = new android.content.pm.ProviderInfo();
                pi.authority = "settings"; pi.name = SettingsProvider.class.getName(); pi.packageName = "android"; pi.applicationInfo = Pkg.app; pi.exported = true;
                settings.attachInfo(null, pi);
            }
            android.content.pm.ProviderInfo pi = new android.content.pm.ProviderInfo();
            pi.authority = "settings"; pi.name = SettingsProvider.class.getName(); pi.packageName = "android"; pi.applicationInfo = Pkg.app;
            ContentProviderHolder h = new ContentProviderHolder(pi);
            h.provider = settings.getIContentProvider();
            h.noReleaseNeeded = true;
            return h;
        }
        for (android.content.pm.PackageParser.Provider p : Pkg.pkg.providers)
            for (String a : p.info.authority.split(";")) if (a.equals(name)) { ContentProviderHolder h = new ContentProviderHolder(p.info); h.noReleaseNeeded = true; return h; }
        return null;
    }
    @Override public boolean refContentProvider(IBinder connection, int stableDelta, int unstableDelta) { return true; }
    @Override public void removeContentProvider(IBinder connection, boolean stable) {}

    @Override public boolean moveActivityTaskToBack(IBinder token, boolean nonRoot) { Host.event("background", ""); return true; }
    @Override public Configuration getConfiguration() { return Pkg.config(); }
    @Override public List<ActivityManager.RunningAppProcessInfo> getRunningAppProcesses() {
        List<ActivityManager.RunningAppProcessInfo> l = new ArrayList<ActivityManager.RunningAppProcessInfo>();
        ActivityManager.RunningAppProcessInfo p = new ActivityManager.RunningAppProcessInfo(Pkg.app.processName != null ? Pkg.app.processName : Pkg.app.packageName, android.os.Process.myPid(), new String[] { Pkg.app.packageName });
        p.importance = ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
        l.add(p);
        return l;
    }
    // what the device offers: a touchscreen, no keyboard or d-pad, OpenGL ES 2.0 (games check this)
    @Override public android.content.pm.ConfigurationInfo getDeviceConfigurationInfo() {
        android.content.pm.ConfigurationInfo c = new android.content.pm.ConfigurationInfo();
        c.reqTouchScreen = android.content.res.Configuration.TOUCHSCREEN_FINGER;
        c.reqKeyboardType = android.content.res.Configuration.KEYBOARD_NOKEYS;
        c.reqNavigation = android.content.res.Configuration.NAVIGATION_NONAV;
        c.reqGlEsVersion = 0x20000;
        return c;
    }
    @Override public void getMemoryInfo(ActivityManager.MemoryInfo out) { out.availMem = 512L << 20; out.totalMem = 1024L << 20; out.threshold = 64L << 20; out.lowMemory = false; }
    @Override public int getFrontActivityScreenCompatMode() { return ActivityManager.COMPAT_MODE_NEVER; }
    @Override public ComponentName getCallingActivity(IBinder token) { Rec r = find(token); return r != null && r.caller != null ? new ComponentName(Pkg.app.packageName, r.caller.info.name) : null; }
    @Override public String getCallingPackage(IBinder token) { return Pkg.app.packageName; }
    @Override public int checkPermission(String permission, int pid, int uid) { return android.content.pm.PackageManager.PERMISSION_GRANTED; }
    @Override public boolean isUserAMonkey() { return false; }
}
