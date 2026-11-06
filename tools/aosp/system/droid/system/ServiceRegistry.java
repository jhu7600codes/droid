package droid.system;

import android.os.IBinder;
import android.util.Log;
import java.util.HashMap;

/** The service manager: every system service droid provides, by name. */
public class ServiceRegistry extends droid.defaults.DefaultIServiceManager {
    static final HashMap<String, IBinder> services = new HashMap<String, IBinder>();
    @Override public IBinder getService(String name) { IBinder b = services.get(name); if (b == null) Log.w("droid", "no system service: " + name); return b; }
    @Override public IBinder checkService(String name) { return services.get(name); }
    @Override public void addService(String name, IBinder service, boolean allowIsolated) { services.put(name, service); }
    @Override public String[] listServices() { return services.keySet().toArray(new String[0]); }
}
