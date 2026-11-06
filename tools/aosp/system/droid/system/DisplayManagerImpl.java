package droid.system;

import android.view.Display;
import android.view.DisplayInfo;

/** One display: the screen droid gives the app. */
public class DisplayManagerImpl extends droid.defaults.DefaultIDisplayManager {
    @Override public DisplayInfo getDisplayInfo(int displayId) {
        if (displayId != Display.DEFAULT_DISPLAY) return null;
        DisplayInfo d = new DisplayInfo();
        int w = Host.widthPx(), h = Host.heightPx(), dpi = Host.densityDpi();
        d.layerStack = 0; d.flags = Display.FLAG_SECURE | Display.FLAG_SUPPORTS_PROTECTED_BUFFERS; d.type = Display.TYPE_BUILT_IN;
        d.name = "Droid screen";
        d.appWidth = d.logicalWidth = w; d.appHeight = d.logicalHeight = h;
        d.smallestNominalAppWidth = d.smallestNominalAppHeight = Math.min(w, h);
        d.largestNominalAppWidth = d.largestNominalAppHeight = Math.max(w, h);
        d.rotation = 0; d.refreshRate = 60f;
        d.logicalDensityDpi = dpi; d.physicalXDpi = d.physicalYDpi = dpi;
        return d;
    }
    @Override public int[] getDisplayIds() { return new int[] { Display.DEFAULT_DISPLAY }; }
}
