package droid.system;

import android.graphics.Point;
import android.view.IWindowSession;
import com.android.internal.view.IInputContext;
import com.android.internal.view.IInputMethodClient;

/** The window manager: one full-screen display; windows get the screen as their surface. */
public class WindowManagerImpl extends droid.defaults.DefaultIWindowManager {
    @Override public IWindowSession openSession(IInputMethodClient client, IInputContext inputContext) { return new SessionImpl(); }
    @Override public void getInitialDisplaySize(int displayId, Point size) { size.set(Host.widthPx(), Host.heightPx()); }
    @Override public void getBaseDisplaySize(int displayId, Point size) { size.set(Host.widthPx(), Host.heightPx()); }
    @Override public int getInitialDisplayDensity(int displayId) { return Host.densityDpi(); }
    @Override public int getBaseDisplayDensity(int displayId) { return Host.densityDpi(); }
    @Override public int getRotation() { return 0; }
    @Override public boolean hasNavigationBar() { return false; }
    @Override public boolean isKeyguardLocked() { return false; }
    @Override public boolean inKeyguardRestrictedInputMode() { return false; }
    @Override public float getAnimationScale(int which) { return 1f; }
    @Override public float[] getAnimationScales() { return new float[] { 1f, 1f, 1f }; }
    @Override public boolean isSafeModeEnabled() { return false; }
}
