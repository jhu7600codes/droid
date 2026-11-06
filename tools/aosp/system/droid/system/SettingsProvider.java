package droid.system;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import java.util.HashMap;

/** android.provider.Settings (system, secure, global): droid's defaults, kept for this app run. */
public class SettingsProvider extends ContentProvider {
    private static final HashMap<String, String> values = new HashMap<String, String>();
    static {
        String[][] d = {
            { "sound_effects_enabled", "0" }, { "haptic_feedback_enabled", "0" }, { "dtmf_tone", "0" }, { "screen_brightness", "200" },
            { "screen_off_timeout", "600000" }, { "time_12_24", "12" }, { "auto_time", "1" }, { "font_scale", "1.0" },
            { "accelerometer_rotation", "1" }, { "show_touches", "0" }, { "pointer_location", "0" }, { "window_animation_scale", "1.0" },
            { "transition_animation_scale", "1.0" }, { "animator_duration_scale", "1.0" }, { "adb_enabled", "0" }, { "development_settings_enabled", "0" },
            { "install_non_market_apps", "1" }, { "airplane_mode_on", "0" }, { "wifi_on", "1" }, { "mobile_data", "1" }, { "data_roaming", "0" },
            { "android_id", "d401d401d401d401" }, { "default_input_method", "" }, { "enabled_accessibility_services", "" }, { "accessibility_enabled", "0" },
            { "touch_exploration_enabled", "0" }, { "location_providers_allowed", "network" }, { "device_provisioned", "1" }, { "user_setup_complete", "1" },
            { "stay_on_while_plugged_in", "0" }, { "show_password", "1" }, { "auto_caps", "1" }, { "auto_punctuate", "1" }, { "lockscreen_sounds_enabled", "0" },
        };
        for (String[] kv : d) values.put(kv[0], kv[1]);
    }
    @Override public boolean onCreate() { return true; }
    @Override public Bundle call(String method, String name, Bundle extras) {
        if (method != null && method.startsWith("GET_")) { Bundle b = new Bundle(); b.putString("value", values.get(name)); return b; }
        if (method != null && method.startsWith("PUT_") && extras != null) { values.put(name, extras.getString("value")); return new Bundle(); }
        return null;
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) { return null; }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues v) { if (v != null && v.getAsString("name") != null) values.put(v.getAsString("name"), v.getAsString("value")); return uri; }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
    @Override public int update(Uri uri, ContentValues v, String selection, String[] selectionArgs) { return 0; }
}
