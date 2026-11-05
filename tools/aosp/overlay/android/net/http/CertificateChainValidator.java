package android.net.http;

import java.io.IOException;
import javax.net.ssl.SSLSocket;

/** droid: certificates are checked by the browser underneath, never here. */
public class CertificateChainValidator {
    private static final CertificateChainValidator INSTANCE = new CertificateChainValidator();
    public static CertificateChainValidator getInstance() { return INSTANCE; }
    public SslError doHandshakeAndValidateServerCertificates(HttpsConnection connection, SSLSocket sslSocket, String domain) throws IOException { return null; }
    public static SslError verifyServerCertificates(byte[][] certChain, String domain, String authType) throws IOException { return null; }
    public static void handleTrustStorageUpdate() {}
}
