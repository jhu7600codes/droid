package com.android.org.conscrypt;

import java.security.cert.X509Certificate;
import java.util.Collections;
import java.util.Set;

/** droid: no user certificate store. */
public class TrustedCertificateStore {
    public Set<String> userAliases() { return Collections.emptySet(); }
    public Set<String> aliases() { return Collections.emptySet(); }
    public String getCertificateAlias(X509Certificate c) { return null; }
}
