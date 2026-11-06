package droid.system;

import android.os.Parcel;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import java.lang.reflect.Constructor;

/** Input devices: the touch screen and a virtual keyboard (the page's keys). */
public class InputManagerImpl extends droid.defaults.DefaultIInputManager {
    private InputDevice touch, keys;
    @Override public int[] getInputDeviceIds() { return new int[] { KeyCharacterMap.VIRTUAL_KEYBOARD, 1 }; }
    @Override public InputDevice getInputDevice(int id) {
        if (keys == null) {
            Parcel p = Parcel.obtain();
            KeyCharacterMap kcm = KeyCharacterMap.CREATOR.createFromParcel(p);
            p.recycle();
            keys = make(KeyCharacterMap.VIRTUAL_KEYBOARD, "Virtual", "droid-keys", InputDevice.SOURCE_KEYBOARD, InputDevice.KEYBOARD_TYPE_ALPHABETIC, kcm);
            touch = make(1, "Droid touch screen", "droid-touch", InputDevice.SOURCE_TOUCHSCREEN, InputDevice.KEYBOARD_TYPE_NONE, kcm);
        }
        return id == 1 ? touch : id == KeyCharacterMap.VIRTUAL_KEYBOARD ? keys : null;
    }
    private static InputDevice make(int id, String name, String desc, int sources, int kbType, KeyCharacterMap kcm) {
        try {
            Constructor<InputDevice> c = InputDevice.class.getDeclaredConstructor(int.class, int.class, int.class, String.class, int.class, int.class, String.class,
                    boolean.class, int.class, int.class, KeyCharacterMap.class, boolean.class, boolean.class);
            c.setAccessible(true);
            return c.newInstance(id, 1, 0, name, 0, 0, desc, false, sources, kbType, kcm, false, false);
        } catch (Exception e) { throw new RuntimeException(e); }
    }
}
