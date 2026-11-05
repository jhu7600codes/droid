package android.security;

/** droid has no key chain: the constants apps use, no keys. */
public final class KeyChain {
    public static final String ACCOUNT_TYPE = "com.android.keychain";
    public static final String EXTRA_NAME = "name";
    public static final String EXTRA_CERTIFICATE = "CERT";
    public static final String EXTRA_PKCS12 = "PKCS12";
    public static final String ACTION_STORAGE_CHANGED = "android.security.STORAGE_CHANGED";
    public static boolean isBoundKeyAlgorithm(String algorithm) { return false; }
    public static boolean isKeyAlgorithmSupported(String algorithm) { return false; }
}
