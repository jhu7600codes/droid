// EGL10 (com.google.android.gles_jni.EGLImpl) for the real framework: android's GLSurfaceView and its
// GLThread run as they are; the surface is a webgl2 canvas over the SurfaceView's window, and gl calls
// (java or the app's native code) go to droid's one GL (arm/gles.ts).
import type { VM, JObject } from '../dalvik.ts'
import { GL } from '../arm/gles.ts'
import { Block, scheduler } from '../threads.ts'

export interface EglHost {
  windowOf: (surfaceObj: number) => number | null
  frameOf: (window: number) => [number, number, number, number] | null
  // a canvas over the window (sized to it), or null where there is no screen (node)
  glCanvas?: (window: number) => HTMLCanvasElement | null
}

const PK = 'Lcom/google/android/gles_jni/'
// one config: rgba8888, depth 24, stencil 8, es1 + es2, window + pbuffer
const CONFIG: Record<number, number> = {
  0x3020: 32, 0x3021: 8, 0x3022: 8, 0x3023: 8, 0x3024: 8, 0x3025: 24, 0x3026: 8, 0x3027: 0x3038, 0x3028: 1,
  0x302e: 1, 0x302f: 0x3038, 0x3031: 0, 0x3032: 0, 0x3033: 5, 0x3040: 5, 0x3042: 0x3038, 0x303f: 0x308e, 0x3029: 0, 0x302a: 0, 0x302c: 0,
}

// display frames (requestAnimationFrame), counted while someone waits on a swap
let frame = 0, ticking = false
const tick = () => { if (ticking) return; ticking = true; requestAnimationFrame(() => { ticking = false; frame++; scheduler.wake() }) }

export function registerAospEgl(vm: VM, host: EglHost) {
  let error = 0x3000, nextH = 1
  interface Srf { window: number | null; canvas: HTMLCanvasElement | null; w: number; h: number }
  const surfaces = new Map<number, Srf>()
  const contexts = new Set<number>()
  let cur = { ctx: 0, draw: 0, read: 0, dpy: 0 }
  const ok = (r = 1) => { error = 0x3000; return r }
  const fail = (e: number) => { error = e; return 0 }
  const h = (o: any, f: string) => (o ? o.f[f] | 0 : 0)
  const size = (s: Srf) => {
    if (s.window == null) return
    const f = host.frameOf(s.window)
    if (f) { s.w = Math.max(1, f[2] - f[0]); s.h = Math.max(1, f[3] - f[1]) }
    if (s.canvas && (s.canvas.width !== s.w || s.canvas.height !== s.h)) { s.canvas.width = s.w; s.canvas.height = s.h }
  }
  vm.registerNatives(PK + 'EGLImpl;', {
    _nativeClassInit: () => {},
    _eglGetDisplay: () => 1,
    getInitCount: () => 1,
    eglInitialize: (v, s, [, mm]) => { if (mm) { mm.data[0] = 1; mm.data[1] = 4 } return ok() },
    eglTerminate: () => ok(), eglReleaseThread: () => ok(), eglWaitGL: () => ok(), eglWaitNative: () => ok(),
    eglGetError: () => { const e = error; error = 0x3000; return e },
    eglQueryString: (v, s, [, name]) => ({ 0x3053: 'Droid', 0x3054: '1.4 Droid', 0x3055: 'EGL_KHR_image_base', 0x308d: 'OpenGL_ES' } as Record<number, string>)[name] ?? null,
    eglChooseConfig: (v, s, [, , configs, n, num]) => {
      if (configs && n > 0) configs.data[0] = vm.newObject(PK + 'EGLConfigImpl;', '<init>(I)V', [1])
      if (num) num.data[0] = 1
      return ok()
    },
    eglGetConfigs: (v, s, [, configs, n, num]) => {
      if (configs && n > 0) configs.data[0] = vm.newObject(PK + 'EGLConfigImpl;', '<init>(I)V', [1])
      if (num) num.data[0] = 1
      return ok()
    },
    eglGetConfigAttrib: (v, s, [, , attr, out]) => { if (!(attr in CONFIG)) return fail(0x3004); out.data[0] = CONFIG[attr]; return ok() },
    _eglCreateContext: () => { const c = nextH++; contexts.add(c); return ok(c) },
    eglDestroyContext: (v, s, [, c]) => { contexts.delete(h(c, 'mEGLContext')); return ok() },
    eglQueryContext: (v, s, [, , attr, out]) => { out.data[0] = attr === 0x3098 ? 2 : attr === 0x3028 ? 1 : 0; return ok() },
    _eglCreateWindowSurface: (v, s, [, , win]) => {
      // GLSurfaceView hands over its holder's Surface
      const obj = win?.f?.mNativeObject | 0
      const window = obj ? host.windowOf(obj) : null
      if (window == null) return fail(0x300b) // EGL_BAD_NATIVE_WINDOW
      const sf: Srf = { window, canvas: host.glCanvas?.(window) ?? null, w: 1, h: 1 }
      size(sf)
      const id = nextH++
      surfaces.set(id, sf)
      return ok(id)
    },
    _eglCreateWindowSurfaceTexture: () => fail(0x300b),
    _eglCreatePbufferSurface: (v, s, [, , attrs]) => {
      let w = 1, hh = 1
      for (let i = 0; attrs && i + 1 < attrs.data.length && attrs.data[i] !== 0x3038; i += 2) { if (attrs.data[i] === 0x3057) w = attrs.data[i + 1]; if (attrs.data[i] === 0x3056) hh = attrs.data[i + 1] }
      const id = nextH++
      surfaces.set(id, { window: null, canvas: typeof document !== 'undefined' ? document.createElement('canvas') : null, w, h: hh })
      return ok(id)
    },
    _eglCreatePixmapSurface: () => { fail(0x300a) },
    eglDestroySurface: (v, s, [, srf]) => {
      const id = h(srf, 'mEGLSurface')
      if (cur.draw === id) { cur = { ctx: 0, draw: 0, read: 0, dpy: 0 }; GL.makeCurrent(null) }
      surfaces.delete(id)
      return ok()
    },
    eglQuerySurface: (v, s, [, srf, attr, out]) => {
      const sf = surfaces.get(h(srf, 'mEGLSurface'))
      if (!sf) return fail(0x300d)
      size(sf)
      out.data[0] = attr === 0x3057 ? sf.w : attr === 0x3056 ? sf.h : attr === 0x3028 ? 1 : 0
      return ok()
    },
    eglMakeCurrent: (v, s, [dpy, draw, read, ctx]) => {
      const d = h(draw, 'mEGLSurface'), c = h(ctx, 'mEGLContext')
      if (!d || !c) { cur = { ctx: 0, draw: 0, read: 0, dpy: 0 }; GL.makeCurrent(null); return ok() }
      const sf = surfaces.get(d)
      if (!sf) return fail(0x300d)
      size(sf)
      if (!sf.canvas) { cur = { ctx: c, draw: d, read: h(read, 'mEGLSurface'), dpy: h(dpy, 'mEGLDisplay') }; return ok() } // no screen (node): nothing to draw on
      if (!GL.makeCurrent({ canvas: sf.canvas, width: sf.w, height: sf.h })) return fail(0x3002)
      cur = { ctx: c, draw: d, read: h(read, 'mEGLSurface'), dpy: h(dpy, 'mEGLDisplay') }
      return ok()
    },
    eglSwapBuffers: (v, s, [, srf]) => {
      const sf = surfaces.get(h(srf, 'mEGLSurface'))
      if (!sf) return fail(0x300d)
      if (sf.canvas) { GL.swap(); size(sf); if (GL.surface?.canvas === sf.canvas) GL.resize(sf.w, sf.h) }
      // like a phone, swapping waits for the next display frame: a render loop then runs at the
      // display's rate and the app's other threads (loading, audio, game logic) get the time between
      if (sf.canvas && typeof requestAnimationFrame !== 'undefined') {
        const want = frame + 1
        tick()
        error = 0x3000
        throw new Block(() => frame >= want, performance.now() + 50, 'vsync').then(() => 1)
      }
      return ok()
    },
    eglCopyBuffers: () => fail(0x300a),
    _eglGetCurrentContext: () => cur.ctx, _eglGetCurrentDisplay: () => cur.dpy, _eglGetCurrentSurface: () => cur.draw,
  })
  // the java GL10 object: what apps ask it before handing over to native code
  const STR: Record<number, string> = { 0x1f00: 'Droid', 0x1f01: 'Droid WebGL', 0x1f02: 'OpenGL ES 2.0 Droid', 0x8b8c: 'OpenGL ES GLSL ES 1.00' }
  vm.registerNatives(PK + 'GLImpl;', {
    _nativeClassInit: () => {},
    _glGetString: (v, s, [name]) => {
      if (name === 0x1f03) { const g = GL.gl; return g ? ['GL_OES_depth24', 'GL_OES_packed_depth_stencil', 'GL_OES_rgb8_rgba8', 'GL_OES_element_index_uint', 'GL_OES_vertex_array_object', 'GL_OES_texture_npot', 'GL_EXT_texture_format_BGRA8888', ...(g.getSupportedExtensions() || []).map((x) => 'GL_' + x)].join(' ') : 'GL_OES_depth24 GL_OES_rgb8_rgba8' }
      return STR[name] ?? null
    },
    'glGetIntegerv(I[II)V': (v, s, [pn, out, off]) => { const g = GL.gl; const x = g ? g.getParameter(pn) : 0; out.data[off] = typeof x === 'number' ? x : x?.[0] ?? 0 },
    'glGetError()I': () => GL.gl?.getError() ?? 0,
  })
  void (null as unknown as JObject)
}
