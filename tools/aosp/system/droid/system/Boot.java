package droid.system;

import android.app.ActivityThread;
import android.os.ServiceManager;

/** The app's process: droid's system services, then android's own ActivityThread.main. */
public final class Boot {
    private Boot() {}
    public static void main(String[] args) {
        Pkg.load();
        ServiceRegistry.services.put("activity", new ActivityManagerImpl());
        ServiceRegistry.services.put("package", new PackageManagerImpl());
        ServiceRegistry.services.put("window", new WindowManagerImpl());
        ServiceRegistry.services.put("display", new DisplayManagerImpl());
        ServiceRegistry.services.put("power", new droid.defaults.DefaultIPowerManager() {
            @Override public boolean isScreenOn() { return true; }
        });
        ServiceRegistry.services.put("input_method", new droid.defaults.DefaultIInputMethodManager());
        ServiceRegistry.services.put("accessibility", new droid.defaults.DefaultIAccessibilityManager());
        ServiceRegistry.services.put("alarm", new droid.defaults.DefaultIAlarmManager());
        ServiceRegistry.services.put("notification", new droid.defaults.DefaultINotificationManager());
        ServiceRegistry.services.put("audio", new droid.defaults.DefaultIAudioService());
        ServiceRegistry.services.put("clipboard", new droid.defaults.DefaultIClipboard());
        ServiceRegistry.services.put("connectivity", new droid.defaults.DefaultIConnectivityManager());
        ServiceRegistry.services.put("statusbar", new droid.defaults.DefaultIStatusBarService());
        ServiceRegistry.services.put("location", new droid.defaults.DefaultILocationManager());
        ServiceRegistry.services.put("appops", new droid.defaults.DefaultIAppOpsService());
        ServiceRegistry.services.put("content", new droid.defaults.DefaultIContentService());
        ServiceRegistry.services.put("account", new droid.defaults.DefaultIAccountManager());
        ServiceRegistry.services.put("user", new droid.defaults.DefaultIUserManager());
        ServiceRegistry.services.put("vibrator", new droid.defaults.DefaultIVibratorService());
        ServiceRegistry.services.put("uimode", new droid.defaults.DefaultIUiModeManager());
        ServiceRegistry.services.put("input", new InputManagerImpl());
        ServiceRegistry.services.put("wallpaper", new droid.defaults.DefaultIWallpaperManager());
        ServiceRegistry.services.put("textservices", new droid.defaults.DefaultITextServicesManager());
        ServiceRegistry.services.put("search", new droid.defaults.DefaultISearchManager());
        ServiceRegistry.services.put("mount", new droid.defaults.DefaultIMountService());
        ServiceManager.initServiceCache(ServiceRegistry.services);
        ActivityThread.main(args);
    }
}
