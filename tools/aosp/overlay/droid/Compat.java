package droid;

import java.io.FileDescriptor;
import java.net.InetAddress;
import java.util.Map;

/**
 * Stand-ins for libcore's own additions to java.* (Arrays.checkOffsetAndCount, FileDescriptor.getInt$,
 * LinkedHashMap.eldest, System.logE ...): tools/aosp/build.py rewrites those calls to these. The ones
 * marked native are written in droid's runtime.
 */
public final class Compat {
    private Compat() {}
    public static void noop() {}
    public static void checkOffsetAndCount(int arrayLength, int offset, int count) {
        if ((offset | count) < 0 || offset > arrayLength || arrayLength - offset < count)
            throw new ArrayIndexOutOfBoundsException("length=" + arrayLength + "; regionStart=" + offset + "; regionLength=" + count);
    }
    public static native int getInt(FileDescriptor fd);
    public static native void setInt(FileDescriptor fd, int value);
    public static FileDescriptor getFileDescriptor(Object o) { return o instanceof FileDescriptor ? (FileDescriptor) o : null; }
    public static <K, V> Map.Entry<K, V> eldest(Map<K, V> m) { return m.isEmpty() ? null : m.entrySet().iterator().next(); }
    public static void logE(String m) { System.err.println(m); }
    public static void logE(String m, Throwable t) { System.err.println(m + ": " + t); }
    public static void logW(String m) { System.err.println(m); }
    public static void logW(String m, Throwable t) { System.err.println(m + ": " + t); }
    public static void logI(String m) { System.err.println(m); }
    public static void logI(String m, Throwable t) { System.err.println(m + ": " + t); }
    public static InetAddress parseNumericAddress(String s) {
        try { return InetAddress.getByName(s); } catch (Exception e) { throw new IllegalArgumentException("Not a numeric address: " + s); }
    }
    private static final char[] HEX = "0123456789abcdef".toCharArray(), UHEX = "0123456789ABCDEF".toCharArray();
    public static String byteToHexString(byte b, boolean upper) { char[] d = upper ? UHEX : HEX; return new String(new char[] { d[(b >> 4) & 15], d[b & 15] }); }
    public static String bytesToHexString(byte[] bytes, boolean upper) { StringBuilder sb = new StringBuilder(); for (byte b : bytes) sb.append(byteToHexString(b, upper)); return sb.toString(); }
    public static String intToHexString(int i, boolean upper, int minWidth) { String s = Integer.toHexString(i); if (upper) s = s.toUpperCase(); while (s.length() < minWidth) s = "0" + s; return s; }
    public static void appendByteAsHex(StringBuilder sb, byte b, boolean upper) { sb.append(byteToHexString(b, upper)); }
    public static java.net.InetAddress inet4Any() { try { return java.net.InetAddress.getByAddress(new byte[4]); } catch (Exception e) { return null; } }
    public static java.net.InetAddress inet6Any() { try { return java.net.InetAddress.getByAddress(new byte[16]); } catch (Exception e) { return null; } }
    public static <T extends Throwable> T withCause(T t, Throwable cause) { t.initCause(cause); return t; }
    public static void setReceivedLength(java.net.DatagramPacket p, int n) { p.setLength(n); }
    public static native Object unsafeArray(java.nio.Buffer b);
    public static native int unsafeArrayOffset(java.nio.Buffer b);
    public static void freeDirectBuffer(java.nio.ByteBuffer b) {}
}
