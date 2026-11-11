package droid.system;

import android.os.IBinder;
import android.os.ResultReceiver;
import android.os.SystemClock;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import com.android.internal.view.IInputContext;
import com.android.internal.view.IInputMethodClient;
import com.android.internal.view.InputBindResult;

/**
 * The input method service: droid's own keyboard. The focused editor's input connection arrives in
 * startInput / windowGainedFocus (same process: the real object); keys from droid's keyboard go into
 * it with {@link #key}, which the runtime posts on the main looper.
 */
public class InputMethodManagerImpl extends droid.defaults.DefaultIInputMethodManager {
    static IInputContext ctx;
    static EditorInfo info;

    // the app's input method client only lets its connection through once it is told it is active
    private void bind(IInputMethodClient client, IInputContext c, EditorInfo a) {
        if (client != null) { try { client.setActive(true); } catch (Exception e) {} }
        if (c != null) { ctx = c; info = a; }
    }
    @Override public InputBindResult startInput(IInputMethodClient client, IInputContext c, EditorInfo a, int flags) {
        bind(client, c, a);
        return null;
    }
    @Override public InputBindResult windowGainedFocus(IInputMethodClient client, IBinder token, int controlFlags, int softInputMode, int windowFlags, EditorInfo a, IInputContext c) {
        bind(client, c, a);
        return null;
    }
    @Override public void finishInput(IInputMethodClient client) { ctx = null; Host.imeHide(); }
    @Override public boolean showSoftInput(IInputMethodClient client, int flags, ResultReceiver rr) {
        if (ctx == null) return false;
        int t = info != null ? info.inputType : InputType.TYPE_CLASS_TEXT;
        int cls = t & InputType.TYPE_MASK_CLASS, v = t & InputType.TYPE_MASK_VARIATION;
        String kind = "text";
        if (cls == InputType.TYPE_CLASS_NUMBER) kind = "number";
        else if (cls == InputType.TYPE_CLASS_PHONE) kind = "phone";
        else if (cls == InputType.TYPE_CLASS_TEXT) {
            if (v == InputType.TYPE_TEXT_VARIATION_PASSWORD || v == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD || v == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD) kind = "password";
            else if (v == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS || v == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS) kind = "email";
            else if (v == InputType.TYPE_TEXT_VARIATION_URI) kind = "url";
        }
        boolean multi = cls == InputType.TYPE_CLASS_TEXT && (t & InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0;
        boolean cap = (t & (InputType.TYPE_TEXT_FLAG_CAP_SENTENCES | InputType.TYPE_TEXT_FLAG_CAP_WORDS | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)) != 0;
        String enter = "enter";
        switch (action()) {
            case EditorInfo.IME_ACTION_GO: enter = "go"; break;
            case EditorInfo.IME_ACTION_SEARCH: enter = "search"; break;
            case EditorInfo.IME_ACTION_SEND: enter = "send"; break;
            case EditorInfo.IME_ACTION_NEXT: enter = "next"; break;
            case EditorInfo.IME_ACTION_DONE: enter = "done"; break;
        }
        if (multi) enter = "enter";
        Host.imeShow(kind, enter, multi, cap);
        return true;
    }
    @Override public boolean hideSoftInput(IInputMethodClient client, int flags, ResultReceiver rr) { Host.imeHide(); return true; }

    private static int action() {
        if (info == null || (info.imeOptions & EditorInfo.IME_FLAG_NO_ENTER_ACTION) != 0) return EditorInfo.IME_ACTION_UNSPECIFIED;
        return info.imeOptions & EditorInfo.IME_MASK_ACTION;
    }
    private static void sendKey(int code) {
        long now = SystemClock.uptimeMillis();
        try {
            ctx.sendKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, -1, 0, KeyEvent.FLAG_SOFT_KEYBOARD | KeyEvent.FLAG_KEEP_TOUCH_MODE));
            ctx.sendKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0, 0, -1, 0, KeyEvent.FLAG_SOFT_KEYBOARD | KeyEvent.FLAG_KEEP_TOUCH_MODE));
        } catch (Exception e) {}
    }

    /** a key from droid's keyboard: what 0 text, 1 delete, 2 enter */
    public static void key(String text, int what) {
        if (ctx == null) return;
        try {
            if (what == 1) sendKey(KeyEvent.KEYCODE_DEL);
            else if (what == 2) {
                boolean multi = info != null && (info.inputType & InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0;
                int a = action();
                if (multi) ctx.commitText("\n", 1);
                else if (a != EditorInfo.IME_ACTION_UNSPECIFIED && a != EditorInfo.IME_ACTION_NONE) ctx.performEditorAction(a);
                else sendKey(KeyEvent.KEYCODE_ENTER);
            } else if (text != null) ctx.commitText(text, 1);
        } catch (Exception e) {}
    }
}
