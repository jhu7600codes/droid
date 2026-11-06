package droid.system;

import android.content.res.Configuration;
import android.graphics.Rect;
import android.graphics.Region;
import android.os.Bundle;
import android.os.IBinder;
import android.view.IWindow;
import android.view.InputChannel;
import android.view.Surface;
import android.view.WindowManager;
import android.view.WindowManagerGlobal;
import java.util.HashMap;

/** A window session: windows are added, laid out full screen and given the screen as surface. */
public class SessionImpl extends droid.defaults.DefaultIWindowSession {
    private static final boolean DEBUG = false;
    private static int nextWindow = 1;
    private static final HashMap<IBinder, Integer> ids = new HashMap<IBinder, Integer>();

    @Override public int add(IWindow window, int seq, WindowManager.LayoutParams attrs, int viewVisibility, Rect outContentInsets, InputChannel outInputChannel) {
        return addToDisplay(window, seq, attrs, viewVisibility, 0, outContentInsets, outInputChannel);
    }
    @Override public int addToDisplay(IWindow window, int seq, WindowManager.LayoutParams attrs, int viewVisibility, int layerStackId, Rect outContentInsets, InputChannel outInputChannel) {
        int id = nextWindow++;
        ids.put(window.asBinder(), id);
        Host.windowAdded(id);
        if (outContentInsets != null) outContentInsets.setEmpty();
        return WindowManagerGlobal.ADD_OKAY | WindowManagerGlobal.ADD_FLAG_APP_VISIBLE;
    }
    @Override public int addToDisplayWithoutInputChannel(IWindow window, int seq, WindowManager.LayoutParams attrs, int viewVisibility, int layerStackId, Rect outContentInsets) {
        return addToDisplay(window, seq, attrs, viewVisibility, layerStackId, outContentInsets, null);
    }
    @Override public void remove(IWindow window) { Integer id = ids.remove(window.asBinder()); if (id != null) Host.windowRemoved(id); }
    @Override public int relayout(IWindow window, int seq, WindowManager.LayoutParams attrs, int requestedWidth, int requestedHeight, int viewVisibility, int flags,
            Rect outFrame, Rect outOverscanInsets, Rect outContentInsets, Rect outVisibleInsets, Configuration outConfig, Surface outSurface) {
        if (DEBUG) android.util.Log.d("droid", "relayout vis=" + viewVisibility + " req=" + requestedWidth + "x" + requestedHeight + " surface=" + outSurface);
        int w = Host.widthPx(), h = Host.heightPx();
        // dialogs and popups wrap their content and sit centered; activities fill the screen
        int ww = attrs != null && attrs.width == WindowManager.LayoutParams.WRAP_CONTENT && requestedWidth > 0 ? Math.min(requestedWidth, w) : w;
        int wh = attrs != null && attrs.height == WindowManager.LayoutParams.WRAP_CONTENT && requestedHeight > 0 ? Math.min(requestedHeight, h) : h;
        int x = (w - ww) / 2, y = (h - wh) / 2;
        outFrame.set(x, y, x + ww, y + wh);
        if (outOverscanInsets != null) outOverscanInsets.setEmpty();
        if (outContentInsets != null) outContentInsets.setEmpty();
        if (outVisibleInsets != null) outVisibleInsets.setEmpty();
        if (outConfig != null) outConfig.setTo(Pkg.config());
        Integer id = ids.get(window.asBinder());
        if (outSurface != null && viewVisibility == 0) Host.attachSurface(outSurface, id != null ? id : 0, outFrame.left, outFrame.top, outFrame.right, outFrame.bottom);
        boolean first = Boolean.TRUE != firstDone.get(window.asBinder());
        firstDone.put(window.asBinder(), Boolean.TRUE);
        if (first) try { window.windowFocusChanged(true, true); } catch (Exception e) { /* no focus */ }
        return (first ? WindowManagerGlobal.RELAYOUT_RES_FIRST_TIME | WindowManagerGlobal.RELAYOUT_RES_SURFACE_CHANGED : 0) | WindowManagerGlobal.RELAYOUT_RES_IN_TOUCH_MODE;
    }
    private static final HashMap<IBinder, Boolean> firstDone = new HashMap<IBinder, Boolean>();
    @Override public boolean outOfMemory(IWindow window) { return false; }
    @Override public void setTransparentRegion(IWindow window, Region region) {}
    @Override public void setInsets(IWindow window, int touchableInsets, Rect contentInsets, Rect visibleInsets, Region touchableRegion) {}
    @Override public void getDisplayFrame(IWindow window, Rect outDisplayFrame) { outDisplayFrame.set(0, 0, Host.widthPx(), Host.heightPx()); }
    @Override public void finishDrawing(IWindow window) {}
    @Override public boolean getInTouchMode() { return true; }
    @Override public boolean performHapticFeedback(IWindow window, int effectId, boolean always) { return true; }
    @Override public void onRectangleOnScreenRequested(IBinder token, Rect rectangle, boolean immediate) {}
    @Override public Bundle sendWallpaperCommand(IBinder window, String action, int x, int y, int z, Bundle extras, boolean sync) { return null; }
}
