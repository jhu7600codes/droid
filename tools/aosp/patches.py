# small fixes to aosp sources so they build without the rest of the platform: (file, old, new).
# file is relative to the framework (src) or libcore source root. keep each one minimal.
PATCHES = [
    # no input method app is bound in droid: keys the IME stage gets back unhandled go on to the views
    # (on a phone the IME is always connected and answers asynchronously, which forwards them)
    ('android/view/ViewRootImpl.java', '''                    } else if (result == InputMethodManager.DISPATCH_NOT_HANDLED) {
                        return FINISH_NOT_HANDLED;''', '''                    } else if (result == InputMethodManager.DISPATCH_NOT_HANDLED) {
                        return FORWARD;'''),
    # the ticker layouts are not in kitkat's res (status bar only)
    ('android/app/Notification.java', '? R.layout.status_bar_latest_event_ticker\n                            : R.layout.status_bar_latest_event_ticker_large_icon', '? R.layout.notification_template_base\n                            : R.layout.notification_template_base'),
    # droid's nio has no CharsetEncoder.encode(CharBuffer, ByteBuffer, boolean): shared prefs are utf-8 anyway
    ('com/android/internal/util/FastXmlSerializer.java', '''                CharBuffer charBuffer = CharBuffer.wrap(mText, 0, mPos);
                CoderResult result = mCharset.encode(charBuffer, mBytes, true);
                while (true) {
                    if (result.isError()) {
                        throw new IOException(result.toString());
                    } else if (result.isOverflow()) {
                        flushBytes();
                        result = mCharset.encode(charBuffer, mBytes, true);
                        continue;
                    }
                    break;
                }
                flushBytes();''', '''                flushBytes();
                mOutputStream.write(new String(mText, 0, mPos).getBytes("UTF-8"));'''),
    # no mount service: droid's storage is always there
    ('android/os/Environment.java', '''    public static String getStorageState(File path) {
        final String rawPath;''', '''    public static String getStorageState(File path) {
        if (path != null) return Environment.MEDIA_MOUNTED;
        final String rawPath;'''),
]
