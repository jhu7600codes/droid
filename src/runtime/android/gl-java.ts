// framework shim, part 8: EGL10 and GLSurfaceView on webgl2 (arm/gles.ts draws). the GLSurfaceView's
// render thread is a green "driver" thread: it runs the app's renderer callbacks as java calls, one
// after another (onSurfaceCreated, onSurfaceChanged, then onDrawFrame once per display frame), and
// every one of them may stop and go on in the next slice, native frames included.
import { VM, JObject, JArray, JThread, JavaThrow, type JMethod, type NativeFn } from './dalvik.ts'
import { Block, scheduler, isBlock } from './threads.ts'
import { GL } from './arm/gles.ts'
import type { Env } from './android.ts'

const OBJ = 'Ljava/lang/Object;'
const EGL = 'Ljavax/microedition/khronos/egl/'

// display frames: one tick per requestAnimationFrame while something draws
let tick = 0
let ticking = false
const startTicks = () => {
  if (ticking || typeof requestAnimationFrame === 'undefined') return
  ticking = true
  const f = () => { tick++; scheduler.wake(); if (ticking) requestAnimationFrame(f) }
  requestAnimationFrame(f)
}

export function registerGlJava(vm: VM, env: Env, report: (e: unknown) => void) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => {
    const old = vm.shims.get(name)
    vm.shim(name, { super: old?.super ?? sup, interfaces: [...(old?.interfaces || []), ...(extra.interfaces || [])], methods: { ...(old?.methods || {}), ...methods }, statics: { ...(old?.statics || {}), ...(extra.statics || {}) } })
  }
  const obj = (cls: string, f: Record<string, any> = {}) => { const o = new JObject(vm.cls(cls)); Object.assign(o.f, f); return o }

  // ---------- EGL10 ----------
  for (const n of ['EGLDisplay', 'EGLContext', 'EGLSurface', 'EGLConfig']) def(EGL + n + ';', OBJ, {})
  const display = obj(EGL + 'EGLDisplay;', { id: 1 })
  const NO = { context: obj(EGL + 'EGLContext;', { none: true }), surface: obj(EGL + 'EGLSurface;', { none: true }), display: obj(EGL + 'EGLDisplay;', { none: true }) }
  // configs on offer (attribute -> value); webgl2 does everything here
  const ES2 = 4, WINDOW = 4, PBUFFER = 1
  const configs = [
    { 0x3024: 8, 0x3023: 8, 0x3022: 8, 0x3021: 8, 0x3025: 24, 0x3026: 8 },
    { 0x3024: 8, 0x3023: 8, 0x3022: 8, 0x3021: 0, 0x3025: 24, 0x3026: 8 },
    { 0x3024: 5, 0x3023: 6, 0x3022: 5, 0x3021: 0, 0x3025: 16, 0x3026: 0 },
    { 0x3024: 8, 0x3023: 8, 0x3022: 8, 0x3021: 8, 0x3025: 16, 0x3026: 0 },
    { 0x3024: 5, 0x3023: 6, 0x3022: 5, 0x3021: 0, 0x3025: 24, 0x3026: 8 },
  ].map((a, i) => obj(EGL + 'EGLConfig;', { attrs: { ...a, 0x3020: a[0x3024] + a[0x3023] + a[0x3022] + a[0x3021], 0x3028: i + 1, 0x3040: ES2 | 1, 0x3042: ES2 | 1, 0x3033: WINDOW | PBUFFER, 0x3031: 0, 0x3032: 0, 0x3027: 0x3038, 0x302d: 1, 0x303f: 0x308e, 0x3029: 0, 0x302a: 4096, 0x302b: 16777216, 0x302c: 4096, 0x302e: 0, 0x3039: 1, 0x303b: 1, 0x303c: 1 } }))
  const matches = (cfg: JObject, want: [number, number][]) => want.every(([k, v]) => {
    const have = cfg.f.attrs[k] ?? 0
    if (v === -1 || k === 0x3038) return true // EGL_DONT_CARE
    if ([0x3024, 0x3023, 0x3022, 0x3021, 0x3025, 0x3026, 0x3020, 0x3031, 0x3032].includes(k)) return have >= v // at least
    if (k === 0x3040 || k === 0x3033 || k === 0x3042) return (have & v) === v // bit masks
    return have === v
  })
  const attribList = (a: JArray | null) => { const out: [number, number][] = []; if (a) for (let i = 0; i + 1 < a.data.length && a.data[i] !== 0x3038; i += 2) out.push([a.data[i] as number, a.data[i + 1] as number]); return out }
  let current: { context: JObject; draw: JObject } | null = null
  let error = 0x3000
  const surfaceInfo = (s: JObject) => {
    const sv = s.f.view
    const c: HTMLCanvasElement = s.f.canvas
    const w = s.f.w || (sv?.f.holder?.f.fixedW) || c.width || 1, h = s.f.h || (sv?.f.holder?.f.fixedH) || c.height || 1
    return { canvas: c, width: w, height: h }
  }
  // the canvas behind whatever was passed as the native window (a SurfaceHolder, a SurfaceView, a Surface)
  const canvasOf = (win: any): { canvas: HTMLCanvasElement | null; view: JObject | null } => {
    if (!win) return { canvas: null, view: null }
    const view = win.f?.view ?? (win.f?.el ? win : null)
    const el = view?.f.el ?? win.f?.canvas
    return { canvas: el instanceof HTMLCanvasElement ? el : null, view }
  }
  const eglMethods: Record<string, NativeFn> = {
    'eglGetDisplay(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;': () => display,
    'eglInitialize(Ljavax/microedition/khronos/egl/EGLDisplay;[I)Z': (v, s, [d, ver]) => { if (ver && ver.data.length >= 2) { ver.data[0] = 1; ver.data[1] = 4 } return 1 },
    'eglTerminate(Ljavax/microedition/khronos/egl/EGLDisplay;)Z': () => 1,
    'eglGetError()I': () => { const e = error; error = 0x3000; return e },
    'eglQueryString(Ljavax/microedition/khronos/egl/EGLDisplay;I)Ljava/lang/String;': (v, s, [, n]) => ({ 0x3053: 'Danen', 0x3054: '1.4 Droid', 0x3055: 'EGL_KHR_image_base', 0x308d: 'OpenGL_ES' } as Record<number, string>)[n] ?? '',
    'eglChooseConfig(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z': (v, s, [, attrs, out, size, num]) => {
      const want = attribList(attrs)
      const ok = configs.filter((c) => matches(c, want))
      if (out) for (let i = 0; i < Math.min(size, ok.length); i++) out.data[i] = ok[i]
      if (num) num.data[0] = out ? Math.min(size, ok.length) : ok.length
      return 1
    },
    'eglGetConfigs(Ljavax/microedition/khronos/egl/EGLDisplay;[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z': (v, s, [, out, size, num]) => {
      if (out) for (let i = 0; i < Math.min(size, configs.length); i++) out.data[i] = configs[i]
      if (num) num.data[0] = out ? Math.min(size, configs.length) : configs.length
      return 1
    },
    'eglGetConfigAttrib(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z': (v, s, [, cfg, k, val]) => { val.data[0] = cfg?.f.attrs?.[k] ?? 0; return 1 },
    'eglCreateContext(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljavax/microedition/khronos/egl/EGLContext;[I)Ljavax/microedition/khronos/egl/EGLContext;': (v, s, [, cfg, , attrs]) => {
      const ver = attribList(attrs).find(([k]) => k === 0x3098)?.[1] ?? 1
      return obj(EGL + 'EGLContext;', { config: cfg, version: ver })
    },
    'eglDestroyContext(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLContext;)Z': () => 1,
    'eglCreateWindowSurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljava/lang/Object;[I)Ljavax/microedition/khronos/egl/EGLSurface;': (v, s, [, cfg, win]) => {
      const { canvas, view } = canvasOf(win)
      if (!canvas) { error = 0x300b; return NO.surface } // EGL_BAD_NATIVE_WINDOW
      return obj(EGL + 'EGLSurface;', { canvas, view, config: cfg })
    },
    'eglCreatePbufferSurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;[I)Ljavax/microedition/khronos/egl/EGLSurface;': (v, s, [, cfg, attrs]) => {
      const a = attribList(attrs), w = a.find(([k]) => k === 0x3057)?.[1] ?? 1, h = a.find(([k]) => k === 0x3056)?.[1] ?? 1
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
      return obj(EGL + 'EGLSurface;', { canvas, config: cfg, w, h, pbuffer: true })
    },
    'eglDestroySurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;)Z': (v, s, [, srf]) => { if (current?.draw === srf) { current = null; GL.makeCurrent(null) } return 1 },
    'eglMakeCurrent(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z': (v, s, [, draw, , ctx]) => {
      if (!draw || draw.f.none || !ctx || ctx.f.none) { current = null; GL.makeCurrent(null); return 1 }
      current = { context: ctx, draw }
      if (!GL.makeCurrent(surfaceInfo(draw))) { error = 0x3002; return 0 } // EGL_BAD_ACCESS: no webgl2 here
      return 1
    },
    'eglSwapBuffers(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;)Z': () => { GL.swap(); return 1 },
    'eglQuerySurface(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;I[I)Z': (v, s, [, srf, k, val]) => { const i = surfaceInfo(srf); val.data[0] = k === 0x3057 ? i.width : k === 0x3056 ? i.height : k === 0x3028 ? 1 : 0; return 1 },
    'eglGetCurrentContext()Ljavax/microedition/khronos/egl/EGLContext;': () => current?.context ?? NO.context,
    'eglGetCurrentSurface(I)Ljavax/microedition/khronos/egl/EGLSurface;': () => current?.draw ?? NO.surface,
    'eglGetCurrentDisplay()Ljavax/microedition/khronos/egl/EGLDisplay;': () => (current ? display : NO.display),
    'eglWaitGL()Z': () => 1, 'eglWaitNative(ILjava/lang/Object;)Z': () => 1,
    'eglCopyBuffers(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljava/lang/Object;)Z': () => 0,
  }
  const C = { EGL_SUCCESS: 0x3000, EGL_NONE: 0x3038, EGL_RED_SIZE: 0x3024, EGL_GREEN_SIZE: 0x3023, EGL_BLUE_SIZE: 0x3022, EGL_ALPHA_SIZE: 0x3021, EGL_DEPTH_SIZE: 0x3025, EGL_STENCIL_SIZE: 0x3026, EGL_RENDERABLE_TYPE: 0x3040, EGL_SURFACE_TYPE: 0x3033, EGL_WINDOW_BIT: 4, EGL_PBUFFER_BIT: 1, EGL_SAMPLES: 0x3031, EGL_SAMPLE_BUFFERS: 0x3032, EGL_WIDTH: 0x3057, EGL_HEIGHT: 0x3056, EGL_DRAW: 0x3059, EGL_READ: 0x305a, EGL_BAD_NATIVE_WINDOW: 0x300b, EGL_CONTEXT_LOST: 0x300e, EGL_CONFIG_CAVEAT: 0x3027, EGL_BUFFER_SIZE: 0x3020, EGL_LEVEL: 0x3029, EGL_NATIVE_RENDERABLE: 0x302d, EGL_DONT_CARE: -1,
    EGL_NO_CONTEXT: NO.context, EGL_NO_SURFACE: NO.surface, EGL_NO_DISPLAY: NO.display, EGL_DEFAULT_DISPLAY: null }
  def(EGL + 'EGL;', OBJ, {})
  def(EGL + 'EGL10;', OBJ, eglMethods, { interfaces: [EGL + 'EGL;'], statics: C })
  def(EGL + 'EGL11;', OBJ, {}, { interfaces: [EGL + 'EGL10;'], statics: { ...C, EGL_CONTEXT_LOST: 0x300e } })
  const egl = obj(EGL + 'EGL10;')
  def(EGL + 'EGLContext;', OBJ, { 'getEGL()Ljavax/microedition/khronos/egl/EGL;': () => egl, 'getGL()Ljavax/microedition/khronos/opengles/GL;': () => gl10 })
  def('Ljavax/microedition/khronos/opengles/GL;', OBJ, {})
  def('Ljavax/microedition/khronos/opengles/GL10;', OBJ, {}, { interfaces: ['Ljavax/microedition/khronos/opengles/GL;'] })
  const gl10 = obj('Ljavax/microedition/khronos/opengles/GL10;')

  // ---------- GLSurfaceView ----------
  // its own SurfaceHolder.Callback: surfaceCreated / Changed / Destroyed drive the render thread
  def('Landroid/opengl/GLSurfaceView;', 'Landroid/view/SurfaceView;', {
    '<init>(Landroid/content/Context;)V': (v, s) => initView(s),
    '<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V': (v, s) => initView(s),
    'setRenderer(Landroid/opengl/GLSurfaceView$Renderer;)V': (v, s, [r]) => { st(s).renderer = r; startThread(s) },
    'setEGLContextFactory(Landroid/opengl/GLSurfaceView$EGLContextFactory;)V': (v, s, [f]) => { st(s).contextFactory = f },
    'setEGLWindowSurfaceFactory(Landroid/opengl/GLSurfaceView$EGLWindowSurfaceFactory;)V': (v, s, [f]) => { st(s).surfaceFactory = f },
    'setEGLConfigChooser(Landroid/opengl/GLSurfaceView$EGLConfigChooser;)V': (v, s, [c]) => { st(s).chooser = c },
    'setEGLConfigChooser(Z)V': (v, s, [depth]) => { st(s).want = [[0x3024, 8], [0x3023, 8], [0x3022, 8], [0x3025, depth ? 16 : 0]] },
    'setEGLConfigChooser(IIIIII)V': (v, s, [r, g, b, a, d, sten]) => { st(s).want = [[0x3024, r], [0x3023, g], [0x3022, b], [0x3021, a], [0x3025, d], [0x3026, sten]] },
    'setEGLContextClientVersion(I)V': (v, s, [n]) => { st(s).version = n },
    'setPreserveEGLContextOnPause(Z)V': () => {}, 'getPreserveEGLContextOnPause()Z': () => 1,
    'setDebugFlags(I)V': () => {}, 'getDebugFlags()I': () => 0, 'setGLWrapper(Landroid/opengl/GLSurfaceView$GLWrapper;)V': () => {},
    'setRenderMode(I)V': (v, s, [m]) => { st(s).mode = m; scheduler.wake() },
    'getRenderMode()I': (v, s) => st(s).mode,
    'requestRender()V': (v, s) => { st(s).dirty = true; scheduler.wake() },
    'queueEvent(Ljava/lang/Runnable;)V': (v, s, [r]) => { st(s).events.push(r); scheduler.wake() },
    'onPause()V': (v, s) => { st(s).paused = true },
    'onResume()V': (v, s) => { st(s).paused = false; scheduler.wake() },
    'surfaceCreated(Landroid/view/SurfaceHolder;)V': (v, s) => { st(s).surface = true; scheduler.wake() },
    'surfaceChanged(Landroid/view/SurfaceHolder;III)V': (v, s, [, , w, h]) => { const x = st(s); x.surface = true; if (x.w !== w || x.h !== h) { x.w = w; x.h = h; x.resized = true } scheduler.wake() },
    'surfaceDestroyed(Landroid/view/SurfaceHolder;)V': (v, s) => { st(s).surface = false },
    'onDetachedFromWindow()V': () => {}, 'onAttachedToWindow()V': () => {},
  }, { statics: { RENDERMODE_WHEN_DIRTY: 0, RENDERMODE_CONTINUOUSLY: 1, DEBUG_CHECK_GL_ERROR: 1, DEBUG_LOG_GL_CALLS: 2 } })
  for (const n of ['Renderer', 'EGLContextFactory', 'EGLConfigChooser', 'EGLWindowSurfaceFactory', 'GLWrapper']) def(`Landroid/opengl/GLSurfaceView$${n};`, OBJ, {})
  interface St { renderer: JObject | null; contextFactory: JObject | null; surfaceFactory: JObject | null; chooser: JObject | null; want: [number, number][] | null; version: number; mode: number; dirty: boolean; paused: boolean; surface: boolean; w: number; h: number; resized: boolean; events: JObject[]; thread: JThread | null }
  const st = (s: JObject): St => (s.f.gl ||= { renderer: null, contextFactory: null, surfaceFactory: null, chooser: null, want: null, version: 1, mode: 1, dirty: true, paused: false, surface: false, w: 0, h: 0, resized: false, events: [], thread: null })
  const initView = (s: JObject) => {
    // the SurfaceView part (canvas, holder) first, then listen to our own holder
    const sv = vm.shims.get('Landroid/view/SurfaceView;')!.methods!['<init>(Landroid/content/Context;)V']
    sv(vm, s, [null])
    const holder = vm.callVirtual(s, 'getHolder()Landroid/view/SurfaceHolder;')
    vm.callVirtual(holder, 'addCallback(Landroid/view/SurfaceHolder$Callback;)V', [s])
    st(s)
  }

  // the render thread: a driver that queues one java call at a time
  const method = (o: JObject, key: string): JMethod | null => vm.findMethod(vm.classOf(o), key)
  const startThread = (view: JObject) => {
    const x = st(view)
    if (x.thread) return
    const t = new JThread(vm, 'GLThread ' + (++glThreads))
    x.thread = t
    let phase: 'wait' | 'config' | 'context' | 'surface' | 'created' | 'changed' | 'frames' = 'wait'
    let config: JObject | null = null, context: JObject | null = null, surface: JObject | null = null
    let lastTick = -1, frameStart = 0
    let waitBlock: Block | null = null
    // runs java method m on the thread; its value lands in t.lastValue
    const queue = (o: JObject, key: string, args: any[]): boolean => {
      const m = method(o, key)
      if (!m) return false
      if (m.code) { vm.pushCall(t, m, o, args); return true }
      t.lastValue = vm.invoke(m, o, args) // a framework (js) method: right away
      return false
    }
    const nextCall = (): 'call' | 'wait' | 'again' => {
      if (!x.surface || x.paused || !x.renderer) { waitBlock = new Block(() => x.surface && !x.paused && !!x.renderer, Infinity, 'gl surface'); return 'wait' }
      switch (phase) {
        case 'wait': phase = 'config'; return 'again'
        case 'config':
          phase = 'context'
          if (x.chooser) return queue(x.chooser, 'chooseConfig(Ljavax/microedition/khronos/egl/EGL10;Ljavax/microedition/khronos/egl/EGLDisplay;)Ljavax/microedition/khronos/egl/EGLConfig;', [egl, display]) ? 'call' : 'again'
          t.lastValue = configs.find((c) => matches(c, x.want ?? [[0x3024, 8], [0x3023, 8], [0x3022, 8], [0x3025, 16]])) ?? configs[0]
          return 'again'
        case 'context':
          config = t.lastValue
          phase = 'surface'
          if (x.contextFactory) return queue(x.contextFactory, 'createContext(Ljavax/microedition/khronos/egl/EGL10;Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;)Ljavax/microedition/khronos/egl/EGLContext;', [egl, display, config]) ? 'call' : 'again'
          t.lastValue = obj(EGL + 'EGLContext;', { config, version: x.version })
          return 'again'
        case 'surface': {
          context = t.lastValue
          phase = 'created'
          const holder = vm.callVirtual(view, 'getHolder()Landroid/view/SurfaceHolder;')
          if (x.surfaceFactory) return queue(x.surfaceFactory, 'createWindowSurface(Ljavax/microedition/khronos/egl/EGL10;Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLSurface;', [egl, display, config, holder]) ? 'call' : 'again'
          t.lastValue = obj(EGL + 'EGLSurface;', { canvas: canvasOf(holder).canvas, view, config })
          return 'again'
        }
        case 'created':
          surface = t.lastValue
          makeCurrent()
          phase = 'changed'
          return queue(x.renderer, 'onSurfaceCreated(Ljavax/microedition/khronos/opengles/GL10;Ljavax/microedition/khronos/egl/EGLConfig;)V', [gl10, config]) ? 'call' : 'again'
        case 'changed':
          phase = 'frames'
          x.resized = false
          makeCurrent()
          return queue(x.renderer, 'onSurfaceChanged(Ljavax/microedition/khronos/opengles/GL10;II)V', [gl10, size().width, size().height]) ? 'call' : 'again'
        case 'frames': {
          if (frameStart) { GL.swap(); frameStart = 0 }
          if (x.events.length) { const r = x.events.shift()!; return queue(r, 'run()V', []) ? 'call' : 'again' }
          if (x.resized) { phase = 'changed'; return 'again' }
          const want = x.mode === 1 || x.dirty
          if (!want || tick === lastTick) { startTicks(); const seen = tick; waitBlock = new Block(() => (x.mode === 1 ? tick !== seen : x.dirty) || x.events.length > 0 || x.resized || !x.surface || x.paused, Infinity, 'vsync'); return 'wait' }
          lastTick = tick
          x.dirty = false
          makeCurrent()
          frameStart = performance.now()
          return queue(x.renderer, 'onDrawFrame(Ljavax/microedition/khronos/opengles/GL10;)V', [gl10]) ? 'call' : 'again'
        }
      }
    }
    const size = () => { const c: HTMLCanvasElement = el(view); const w = x.w || Math.max(1, Math.round(c.clientWidth * env.density)), h = x.h || Math.max(1, Math.round(c.clientHeight * env.density)); return { width: w, height: h } }
    const makeCurrent = () => {
      const s = surface && !surface.f.none ? surface : obj(EGL + 'EGLSurface;', { canvas: el(view), view })
      s.f.w = size().width; s.f.h = size().height
      current = { context: context ?? NO.context, draw: s }
      GL.makeCurrent({ canvas: s.f.canvas, width: s.f.w, height: s.f.h })
    }
    const el = (v: JObject) => v.f.el as HTMLCanvasElement
    t.step = (ms: number) => {
      const end = performance.now() + ms
      const prev = vm.current
      for (;;) {
        // a java call in progress (it may have stopped, or wait): give it the time
        if (t.frames.length || t.nativeCall || (t.block && !waitBlock)) {
          vm.stepThread(t, Math.max(1, end - performance.now()))
          if (t.state === 'blocked' || t.frames.length || t.nativeCall) return
          t.state = 'runnable'
        } else if (waitBlock) {
          if (!waitBlock.ready()) { t.block = waitBlock; t.state = 'blocked'; return }
          waitBlock = null; t.block = null; t.state = 'runnable'
        }
        if (performance.now() >= end) return
        vm.current = t
        t.busy = true
        let r: 'call' | 'wait' | 'again'
        try { r = nextCall() }
        catch (e) { t.busy = false; vm.current = prev; if (isBlock(e)) { waitBlock = e; continue } report(e); t.state = 'done'; return }
        t.busy = false
        vm.current = prev
        if (r === 'wait') { t.block = waitBlock; t.state = 'blocked'; return }
      }
    }
    t.onDone = (err) => { if (err) { report(err instanceof JavaThrow ? err : err); } }
    scheduler.add(t)
  }
  let glThreads = 0
}
