package com.droid.hellojni;

import android.app.Activity;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
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
        view = new GLSurfaceView(this);
        view.setEGLContextClientVersion(2);
        view.setRenderer(new GLSurfaceView.Renderer() {
            final long start = System.currentTimeMillis();
            public void onSurfaceCreated(GL10 gl, EGLConfig config) { }
            public void onSurfaceChanged(GL10 gl, int w, int h) { glInit(w, h); }
            public void onDrawFrame(GL10 gl) { glFrame(System.currentTimeMillis() - start); }
        });
        setContentView(view);
    }

    @Override protected void onPause() { super.onPause(); view.onPause(); }
    @Override protected void onResume() { super.onResume(); view.onResume(); }
}
