package droid.system;

import android.net.ConnectivityManager;
import android.net.NetworkInfo;

/** Droid is always online through the browser: one connected wifi network. */
public class ConnectivityManagerImpl extends droid.defaults.DefaultIConnectivityManager {
    private NetworkInfo wifi() {
        NetworkInfo n = new NetworkInfo(ConnectivityManager.TYPE_WIFI, 0, "WIFI", "");
        n.setIsAvailable(true);
        n.setDetailedState(NetworkInfo.DetailedState.CONNECTED, null, "\"Droid\"");
        return n;
    }
    @Override public NetworkInfo getActiveNetworkInfo() { return wifi(); }
    @Override public NetworkInfo getActiveNetworkInfoForUid(int uid) { return wifi(); }
    @Override public NetworkInfo getProvisioningOrActiveNetworkInfo() { return wifi(); }
    @Override public NetworkInfo getNetworkInfo(int type) { return type == ConnectivityManager.TYPE_WIFI ? wifi() : null; }
    @Override public NetworkInfo[] getAllNetworkInfo() { return new NetworkInfo[] { wifi() }; }
    @Override public boolean isNetworkSupported(int type) { return type == ConnectivityManager.TYPE_WIFI; }
    @Override public boolean isActiveNetworkMetered() { return false; }
}
