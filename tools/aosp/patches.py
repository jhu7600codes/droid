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
]
