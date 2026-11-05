package dalvik.system;

/** droid's VM: the parts of dalvik's VMRuntime the framework asks for. */
public final class VMRuntime {
    private static final VMRuntime THE_ONE = new VMRuntime();
    private int targetSdk = 19;
    private float heapUtilization = 0.75f;
    private VMRuntime() {}
    public static VMRuntime getRuntime() { return THE_ONE; }
    public String vmLibrary() { return "libdroid.so"; }
    public float getTargetHeapUtilization() { return heapUtilization; }
    public float setTargetHeapUtilization(float f) { float old = heapUtilization; heapUtilization = f; return old; }
    public void setTargetSdkVersion(int v) { targetSdk = v; }
    public int getTargetSdkVersion() { return targetSdk; }
    public void clearGrowthLimit() {}
    public long totalMemory() { return Runtime.getRuntime().totalMemory(); }
    public long freeMemory() { return Runtime.getRuntime().freeMemory(); }
    public void runFinalizationSync() {}
    public void startJitCompilation() {}
    public void disableJitCompilation() {}
    public void preloadDexCaches() {}
    public void registerNativeAllocation(int bytes) {}
    public void registerNativeFree(int bytes) {}
    public boolean isDebuggerActive() { return false; }
    public Object newNonMovableArray(Class<?> componentType, int length) { return java.lang.reflect.Array.newInstance(componentType, length); }
    public long addressOf(Object array) { return 0; }
    public String[] properties() { return new String[0]; }
    public String bootClassPath() { return ""; }
    public String classPath() { return ""; }
    public String vmVersion() { return "1.6.0"; }
}
