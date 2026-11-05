package com.droid.hellojni;

import android.app.Activity;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
import android.util.Log;
import android.view.MotionEvent;
import android.widget.FrameLayout;
import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

// opengl es 2 from native code: the renderer's callbacks go straight to libhello.so
public class GlActivity extends Activity {
    static { System.loadLibrary("hello"); }
    static native void glInit(int width, int height);
    static native int glFrame(long ms);

    private GLSurfaceView view;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        // touch: the surface takes touches in its top half, the rest goes on to the activity
        view = new GLSurfaceView(this) {
            @Override public boolean onTouchEvent(MotionEvent e) {
                if (e.getActionMasked() == MotionEvent.ACTION_DOWN && e.getY() > getHeight() / 2) return false;
                Log.i("touch", "view " + e.getActionMasked() + " " + Math.round(e.getX()) + "," + Math.round(e.getY()) + " pointers " + e.getPointerCount());
                return true;
            }
        };
        view.setEGLContextClientVersion(2);
        view.setRenderer(new GLSurfaceView.Renderer() {
            final long start = System.currentTimeMillis();
            public void onSurfaceCreated(GL10 gl, EGLConfig config) { }
            public void onSurfaceChanged(GL10 gl, int w, int h) { glInit(w, h); }
            public void onDrawFrame(GL10 gl) { glFrame(System.currentTimeMillis() - start); }
        });
        FrameLayout frame = new FrameLayout(this);
        frame.addView(view);
        setContentView(frame);
    }

    @Override public boolean onTouchEvent(MotionEvent e) {
        Log.i("touch", "activity " + e.getActionMasked() + " " + Math.round(e.getX()) + "," + Math.round(e.getY()));
        return true;
    }

    @Override protected void onPause() { super.onPause(); view.onPause(); }
    @Override protected void onResume() { super.onResume(); view.onResume(); }
}
