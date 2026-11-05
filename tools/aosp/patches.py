# small fixes to aosp sources so they build without the rest of the platform: (file, old, new).
# file is relative to the framework (src) or libcore source root. keep each one minimal.
PATCHES = [
    # the ticker layouts are not in kitkat's res (status bar only)
    ('android/app/Notification.java', '? R.layout.status_bar_latest_event_ticker\n                            : R.layout.status_bar_latest_event_ticker_large_icon', '? R.layout.notification_template_base\n                            : R.layout.notification_template_base'),
]
