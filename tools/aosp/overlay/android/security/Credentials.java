package android.security;

/** droid has no credential storage: the names, and nothing stored. */
public class Credentials {
    public static final String INSTALL_ACTION = "android.credentials.INSTALL";
    public static final String UNLOCK_ACTION = "com.android.credentials.UNLOCK";
    public static final String CA_CERTIFICATE = "CACERT_";
    public static final String USER_CERTIFICATE = "USRCERT_";
    public static final String USER_PRIVATE_KEY = "USRPKEY_";
    public static final String USER_SECRET_KEY = "USRSKEY_";
    public static final String VPN = "VPN_";
    public static final String WIFI = "WIFI_";
    public static byte[] convertToPem(java.security.cert.Certificate... objects) throws java.io.IOException, java.security.cert.CertificateException { return new byte[0]; }
    public static Credentials getInstance() { return new Credentials(); }
}
