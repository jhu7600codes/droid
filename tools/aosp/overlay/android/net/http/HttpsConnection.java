package android.net.http;

import android.content.Context;
import java.io.File;
import java.io.IOException;
import javax.net.ssl.SSLException;
import org.apache.http.HttpHost;

/** droid: the legacy https stack is not there (apps use HttpURLConnection, which droid networks). */
public class HttpsConnection extends Connection {
    public static void initializeEngine(File sessionDir) {}
    HttpsConnection(Context context, HttpHost host, HttpHost proxy, RequestFeeder requestFeeder) { super(context, host, requestFeeder); }
    void setCertificate(SslCertificate certificate) {}
    AndroidHttpClientConnection openConnection(Request req) throws IOException { throw new IOException("legacy android.net.http https is not available in droid"); }
    void closeConnection() {}
    void restartConnection(boolean proceed) {}
    String getScheme() { return "https"; }
}

class SSLConnectionClosedByUserException extends SSLException {
    public SSLConnectionClosedByUserException(String reason) { super(reason); }
}
