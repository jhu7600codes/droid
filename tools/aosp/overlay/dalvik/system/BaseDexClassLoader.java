package dalvik.system;

import java.io.File;
import java.net.URL;
import java.util.Collections;
import java.util.Enumeration;

/** droid: the app's dex is loaded by droid's vm already; this loader just asks it for classes. */
public class BaseDexClassLoader extends ClassLoader {
    private final String path;
    private final String libraryPath;
    public BaseDexClassLoader(String dexPath, File optimizedDirectory, String libraryPath, ClassLoader parent) {
        super(parent);
        this.path = dexPath;
        this.libraryPath = libraryPath;
    }
    @Override protected Class<?> findClass(String name) throws ClassNotFoundException { return Class.forName(name); }
    @Override public String findLibrary(String name) { return libraryPath == null ? null : libraryPath.split(":")[0] + "/" + System.mapLibraryName(name); }
    @Override protected URL findResource(String name) { return null; }
    @Override protected Enumeration<URL> findResources(String name) { return Collections.enumeration(Collections.<URL>emptyList()); }
    public String getLdLibraryPath() { return libraryPath; }
    @Override public String toString() { return getClass().getName() + "[" + path + "]"; }
}
