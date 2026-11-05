package android.security;

/** droid: an empty AndroidKeyStore provider. */
public class AndroidKeyStoreProvider extends java.security.Provider {
    public static final String PROVIDER_NAME = "AndroidKeyStore";
    public AndroidKeyStoreProvider() { super(PROVIDER_NAME, 1.0, "Android KeyStore security provider (droid: empty)"); }
}
