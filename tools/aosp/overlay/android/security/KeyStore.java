package android.security;

/** droid has no system key store: always empty. */
public class KeyStore {
    public static final int NO_ERROR = 1, LOCKED = 2, UNINITIALIZED = 3, SYSTEM_ERROR = 4, PROTOCOL_ERROR = 5, PERMISSION_DENIED = 6, KEY_NOT_FOUND = 7, VALUE_CORRUPTED = 8, UNDEFINED_ACTION = 9, WRONG_PASSWORD = 10;
    public static final int FLAG_NONE = 0, FLAG_ENCRYPTED = 1;
    public enum State { UNLOCKED, LOCKED, UNINITIALIZED }
    private static final KeyStore INSTANCE = new KeyStore();
    public static KeyStore getInstance() { return INSTANCE; }
    public State state() { return State.UNLOCKED; }
    public boolean isUnlocked() { return true; }
    public byte[] get(String key) { return null; }
    public boolean put(String key, byte[] value, int uid, int flags) { return false; }
    public boolean delete(String key) { return false; }
    public boolean delete(String key, int uid) { return false; }
    public boolean contains(String key) { return false; }
    public boolean contains(String key, int uid) { return false; }
    public boolean delKey(String key) { return false; }
    public boolean delKey(String key, int uid) { return false; }
    public boolean importKey(String keyName, byte[] key, int uid, int flags) { return false; }
    public boolean duplicate(String srcKey, int srcUid, String destKey, int destUid) { return false; }
    public String[] saw(String prefix) { return new String[0]; }
    public int getLastError() { return NO_ERROR; }
}
