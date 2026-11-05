package android.net;

import java.io.IOException;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.SocketAddress;
import java.net.URI;
import java.util.Collections;
import java.util.List;

/** droid: no pac proxies (droid's own proxy sits below the app). */
public class PacProxySelector extends ProxySelector {
    public PacProxySelector() {}
    @Override public List<Proxy> select(URI uri) { return Collections.singletonList(Proxy.NO_PROXY); }
    @Override public void connectFailed(URI uri, SocketAddress address, IOException failure) {}
}
