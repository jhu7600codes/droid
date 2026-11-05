package com.android.org.bouncycastle.asn1.x509;

import java.util.Vector;

/** droid: just enough of an X.500 name to read "CN=..., O=..., OU=..." */
public class X509Name {
    public static final String CN = "2.5.4.3", O = "2.5.4.10", OU = "2.5.4.11", C = "2.5.4.6", L = "2.5.4.7", ST = "2.5.4.8";
    private final Vector<Object> oids = new Vector<Object>(), values = new Vector<Object>();
    public X509Name(String dirName) {
        if (dirName == null) throw new IllegalArgumentException("null name");
        for (String part : dirName.split("(?<!\\\\),")) {
            int eq = part.indexOf('=');
            if (eq < 0) continue;
            String k = part.substring(0, eq).trim().toUpperCase(), v = part.substring(eq + 1).trim();
            String oid = k.equals("CN") ? CN : k.equals("O") ? O : k.equals("OU") ? OU : k.equals("C") ? C : k.equals("L") ? L : k.equals("ST") ? ST : k;
            oids.add(oid); values.add(v);
        }
    }
    public Vector getOIDs() { return oids; }
    public Vector getValues() { return values; }
}
