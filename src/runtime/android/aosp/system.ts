// the app's process around the real framework: the looper (MessageQueue on droid's green threads),
// vsync for Choreographer, windows and their surfaces, input, MotionEvent, and droid.system.Host
// (what droid's java system services ask the runtime).
import { JavaCall, type VM, type JObject, type JMethod } from '../dalvik.ts'
import { Block, scheduler } from '../threads.ts'
import { jstr } from '../java.ts'
import type { Bmp } from './graphics.ts'

export interface HostSide {
  pkg: string
  apkPath: string
  launchActivity?: string
  screen: () => { w: number; h: number; dpi: number }
  // a window's frame was drawn: show it
  present: (window: number, bmp: Bmp, frame: [number, number, number, number]) => void
  windowGone?: (window: number) => void
  // a window got a (new) frame: video shown in it moves along
  windowFrame?: (window: number, frame: [number, number, number, number]) => void
  event?: (what: string, detail: string) => void
}
interface Gfx { newBmp: (w: number, h: number) => Bmp; canvasFor: (bm: Bmp) => number; resetCanvas: (h: number, bm: Bmp) => void; get: <T>(h: number) => T }

export function registerAospSystem(vm: VM, gfx: Gfx, host: HostSide) {
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  const now = () => performance.now()
  let nextH = 1

  // ---------- the looper ----------
  interface Q { wake: boolean; pending: { m: JMethod; self: JObject | null; args: any[] }[] }
  const queues = new Map<number, Q>()
  const Qp = (p: number) => queues.get(p)
  const post = (qp: number, self: JObject, key: string, args: any[]) => {
    const q = Qp(qp), m = vm.findMethod(self.cls, key)
    if (!q || !m) return
    q.pending.push({ m, self, args })
    scheduler.wake()
  }
  // a java call to run on the main looper (media events and other native callbacks)
  let mainQ = 0
  const later = (m: JMethod, self: JObject | null, args: any[]) => { const q = Qp(mainQ); if (!q) return; q.pending.push({ m, self, args }); scheduler.wake() }
  vm.registerNatives('Landroid/os/MessageQueue;', {
    nativeInit: () => { const p = nextH++; queues.set(p, { wake: false, pending: [] }); mainQ ||= p; return p },
    nativeDestroy: (v, s, [p]) => { queues.delete(p) },
    nativeWake: (v, s, [p]) => { const q = Qp(p); if (q) { q.wake = true; scheduler.wake() } },
    nativeIsIdling: (v, s, [p]) => { const q = Qp(p); return q && !q.pending.length && !q.wake ? 1 : 0 },
    // waits until a message is due (timeout), the queue is woken, or a callback (vsync, input) is due;
    // callbacks run here as java calls, the way android's native looper calls them
    nativePollOnce: (v, s, [p, timeout]) => {
      const q = Qp(p)
      if (!q) return
      const cb = q.pending.shift()
      if (cb) throw new JavaCall(cb.m, cb.self, cb.args, () => undefined)
      if (q.wake) { q.wake = false; return }
      if (timeout === 0) return
      const until = timeout < 0 ? Infinity : now() + timeout
      throw new Block(() => q.wake || q.pending.length > 0 || now() >= until, until, 'looper').then(() => { q.wake = false })
    },
  })

  // ---------- vsync (Choreographer) ----------
  interface Rx { self: JObject; queue: number; scheduled: boolean }
  const vsyncs = new Map<number, Rx>()
  let frame = 0
  const raf: (f: (t: number) => void) => void = typeof requestAnimationFrame !== 'undefined' ? (f) => requestAnimationFrame(f) : (f) => setTimeout(() => f(now()), 16)
  vm.registerNatives('Landroid/view/DisplayEventReceiver;', {
    nativeInit: (v, s, [rx, mq]) => { const p = nextH++; vsyncs.set(p, { self: rx, queue: mq.f.mPtr, scheduled: false }); return p },
    nativeDispose: (v, s, [p]) => { vsyncs.delete(p) },
    nativeScheduleVsync: (v, s, [p]) => {
      const r = vsyncs.get(p)
      if (!r || r.scheduled) return
      r.scheduled = true
      raf(() => { r.scheduled = false; if (vsyncs.has(p)) post(r.queue, r.self, 'dispatchVsync(JII)V', [vm.callStatic('Ljava/lang/System;', 'nanoTime()J') as bigint, 0, frame++]) })
    },
  })

  // ---------- windows and surfaces ----------
  interface Win { id: number; frame: [number, number, number, number]; bmp: Bmp | null; canvas: number; rx: number }
  const wins = new Map<number, Win>()
  const surfaces = new Map<number, number>() // surface native object -> window
  const refs = new Map<number, number>() // extra references (a locked canvas holds one)
  let lastAdded = 0
  const win = (id: number) => { let w = wins.get(id); if (!w) wins.set(id, (w = { id, frame: [0, 0, 0, 0], bmp: null, canvas: 0, rx: 0 })); return w }
  vm.registerNatives('Ldroid/system/Host;', {
    packageName: () => host.pkg,
    apkPath: () => host.apkPath,
    launchActivity: () => host.launchActivity ?? null,
    widthPx: () => host.screen().w, heightPx: () => host.screen().h, densityDpi: () => host.screen().dpi,
    windowAdded: (v, s, [id]) => { win(id); lastAdded = id },
    windowRemoved: (v, s, [id]) => { wins.delete(id); host.windowGone?.(id) },
    attachSurface: (v, s, [surface, id, l, t, r, b]) => {
      const w = win(id)
      w.frame = [l, t, r, b]
      const ww = Math.max(1, r - l), hh = Math.max(1, b - t)
      if (!w.bmp || w.bmp.w !== ww || w.bmp.h !== hh) { w.bmp = gfx.newBmp(ww, hh); w.canvas = w.canvas ? (gfx.resetCanvas(w.canvas, w.bmp), w.canvas) : gfx.canvasFor(w.bmp) }
      const obj = surface.f.mNativeObject || nextH++
      surfaces.set(obj, id)
      surface.f.mNativeObject = obj
      surface.f.mGenerationId = (surface.f.mGenerationId | 0) + 1
      host.windowFrame?.(id, w.frame)
    },
    event: (v, s, [what, detail]) => host.event?.(text(what), text(detail)),
  })
  vm.registerNatives('Landroid/view/Surface;', {
    nativeIsValid: (v, s, [o]) => (surfaces.has(o) ? 1 : 0),
    nativeRelease: (v, s, [o]) => { const n = (refs.get(o) ?? 1) - 1; if (n > 0) refs.set(o, n); else { refs.delete(o); surfaces.delete(o) } },
    nativeIsConsumerRunningBehind: () => 0,
    nativeLockCanvas: (v, s, [o, canvas, dirty]) => {
      const w = wins.get(surfaces.get(o) ?? -1)
      if (!w?.bmp) throw vm.error('Ljava/lang/IllegalArgumentException;', 'surface is not valid')
      gfx.resetCanvas(w.canvas, w.bmp)
      canvas.f.mNativeCanvas = w.canvas
      if (dirty) { dirty.f.left = 0; dirty.f.top = 0; dirty.f.right = w.bmp.w; dirty.f.bottom = w.bmp.h }
      // like android, the lock holds a reference: unlockCanvasAndPost releases that one, not the surface
      refs.set(o, (refs.get(o) ?? 1) + 1)
      return o
    },
    nativeUnlockCanvasAndPost: (v, s, [o]) => { const w = wins.get(surfaces.get(o) ?? -1); if (w?.bmp) host.present(w.id, w.bmp, w.frame) },
    nativeCreateFromSurfaceTexture: () => nextH++, nativeCreateFromSurfaceControl: () => nextH++,
    nativeReadFromParcel: (v, s, [o]) => o, nativeWriteToParcel: () => {},
  })
  vm.registerNatives('Landroid/view/GLES20Canvas;', { nIsAvailable: () => 0 })
  vm.registerNatives('Landroid/view/HardwareRenderer;', { nLoadProperties: () => 0, nSetupShadersDiskCache: () => {}, nBeginFrame: () => {}, nGetSystemTime: () => BigInt(Math.round(now() * 1e6)), nPreserveBackBuffer: () => 0, nIsBackBufferPreserved: () => 0 })
  vm.registerNatives('Landroid/view/SurfaceControl;', { nativeGetBuiltInDisplay: () => null, nativeOpenTransaction: () => {}, nativeCloseTransaction: () => {}, nativeCreate: () => nextH++, nativeRelease: () => {}, nativeDestroy: () => {} })

  // ---------- input ----------
  interface IRx { self: JObject; queue: number; window: number }
  const inputs = new Map<number, IRx>()
  vm.registerNatives('Landroid/view/InputChannel;', {
    nativeOpenInputChannelPair: () => null, nativeDispose: () => {}, nativeTransferTo: () => {}, nativeReadFromParcel: () => {},
    nativeWriteToParcel: () => {}, nativeDup: () => {}, nativeGetName: () => 'droid',
  })
  vm.registerNatives('Landroid/view/InputEventReceiver;', {
    nativeInit: (v, s, [ref, , mq]) => { const p = nextH++; inputs.set(p, { self: ref.f.ref ?? ref, queue: mq.f.mPtr, window: lastAdded }); return p },
    nativeDispose: (v, s, [p]) => { inputs.delete(p) },
    nativeFinishInputEvent: () => {},
    nativeConsumeBatchedInputEvents: () => 0,
  })
  let seq = 1

  // ---------- MotionEvent: pointers and samples live here ----------
  interface Ptr { id: number; tool: number }
  interface Sample { t: bigint; c: number[][] } // per pointer: x y pressure size touchMajor touchMinor toolMajor toolMinor orientation
  interface ME { device: number; source: number; action: number; flags: number; edge: number; meta: number; buttons: number; xo: number; yo: number; xp: number; yp: number; down: bigint; ptrs: Ptr[]; samples: Sample[] }
  const mes = new Map<number, ME>()
  const ME = (p: number) => mes.get(p)!
  const AX = ['x', 'y', 'pressure', 'size', 'touchMajor', 'touchMinor', 'toolMajor', 'toolMinor', 'orientation']
  const coordsOf = (pc: JObject) => AX.map((k) => pc.f[k] ?? 0)
  const sampleAt = (e: ME, pos: number) => (pos === -2147483648 || pos >= e.samples.length - 1 ? e.samples[e.samples.length - 1] : e.samples[Math.max(0, pos)])
  // VelocityTracker: least squares over the last 100ms of each pointer
  interface VT { pts: Map<number, { t: number; x: number; y: number }[]>; vel: Map<number, [number, number]> }
  const vts = new Map<number, VT>()
  vm.registerNatives('Landroid/view/VelocityTracker;', {
    nativeInitialize: () => { const h = nextH++; vts.set(h, { pts: new Map(), vel: new Map() }); return h },
    nativeDispose: (v, s, [h]) => { vts.delete(h) },
    nativeClear: (v, s, [h]) => { const t = vts.get(h); t?.pts.clear(); t?.vel.clear() },
    nativeAddMovement: (v, s, [h, ev]) => {
      const t = vts.get(h), e = mes.get(ev?.f.mNativePtr)
      if (!t || !e) return
      const act = e.action & 0xff
      if (act === 0) t.pts.clear()
      if (act === 1 || act === 6 || act === 3) return // the up sample adds nothing to the speed
      for (const smp of e.samples) {
        const ms = Number(smp.t) / 1e6
        e.ptrs.forEach((p, i) => {
          const l = t.pts.get(p.id) ?? []
          l.push({ t: ms, x: smp.c[i][0] + e.xo, y: smp.c[i][1] + e.yo })
          while (l.length && ms - l[0].t > 100) l.shift()
          t.pts.set(p.id, l)
        })
      }
    },
    nativeComputeCurrentVelocity: (v, s, [h, units, max]) => {
      const t = vts.get(h)
      if (!t) return
      t.vel.clear()
      for (const [id, l] of t.pts) {
        if (l.length < 2) { t.vel.set(id, [0, 0]); continue }
        const n = l.length, mt = l.reduce((a, p) => a + p.t, 0) / n
        const slope = (k: 'x' | 'y') => { const m = l.reduce((a, p) => a + p[k], 0) / n; let num = 0, den = 0; for (const p of l) { num += (p.t - mt) * (p[k] - m); den += (p.t - mt) ** 2 } return den ? num / den : 0 }
        const clamp = (x: number) => Math.max(-max, Math.min(max, x * units))
        t.vel.set(id, [clamp(slope('x')), clamp(slope('y'))])
      }
    },
    nativeGetXVelocity: (v, s, [h, id]) => { const t = vts.get(h); return (id === -1 ? [...(t?.vel.values() ?? [])][0] : t?.vel.get(id))?.[0] ?? 0 },
    nativeGetYVelocity: (v, s, [h, id]) => { const t = vts.get(h); return (id === -1 ? [...(t?.vel.values() ?? [])][0] : t?.vel.get(id))?.[1] ?? 0 },
    nativeGetEstimator: () => 0,
  })
  vm.registerNatives('Landroid/view/MotionEvent;', {
    nativeInitialize: (v, s, [p, device, source, action, flags, edge, meta, buttons, xo, yo, xp, yp, down, t, n, props, coords]) => {
      const h = p || nextH++
      const ptrs: Ptr[] = [], c: number[][] = []
      for (let i = 0; i < n; i++) { ptrs.push({ id: props.data[i].f.id, tool: props.data[i].f.toolType }); c.push(coordsOf(coords.data[i])) }
      mes.set(h, { device, source, action, flags, edge, meta, buttons, xo, yo, xp, yp, down, ptrs, samples: [{ t, c }] })
      return h
    },
    nativeCopy: (v, s, [d, src, keep]) => { const a = ME(src); const h = d || nextH++; mes.set(h, { ...a, ptrs: a.ptrs.map((x) => ({ ...x })), samples: (keep ? a.samples : a.samples.slice(-1)).map((x) => ({ t: x.t, c: x.c.map((y) => [...y]) })) }); return h },
    nativeDispose: (v, s, [p]) => { mes.delete(p) },
    nativeAddBatch: (v, s, [p, t, coords, meta]) => { const e = ME(p); e.samples.push({ t, c: [...coords.data].map((x: JObject) => coordsOf(x)) }); e.meta |= meta },
    nativeGetDeviceId: (v, s, [p]) => ME(p).device, nativeGetSource: (v, s, [p]) => ME(p).source, nativeSetSource: (v, s, [p, x]) => { ME(p).source = x },
    nativeGetAction: (v, s, [p]) => ME(p).action, nativeSetAction: (v, s, [p, x]) => { ME(p).action = x },
    nativeIsTouchEvent: (v, s, [p]) => (ME(p).source & 0x2 ? 1 : 0),
    nativeGetFlags: (v, s, [p]) => ME(p).flags, nativeSetFlags: (v, s, [p, x]) => { ME(p).flags = x },
    nativeGetEdgeFlags: (v, s, [p]) => ME(p).edge, nativeSetEdgeFlags: (v, s, [p, x]) => { ME(p).edge = x },
    nativeGetMetaState: (v, s, [p]) => ME(p).meta, nativeGetButtonState: (v, s, [p]) => ME(p).buttons,
    nativeOffsetLocation: (v, s, [p, dx, dy]) => { const e = ME(p); e.xo += dx; e.yo += dy },
    nativeGetXOffset: (v, s, [p]) => ME(p).xo, nativeGetYOffset: (v, s, [p]) => ME(p).yo,
    nativeGetXPrecision: (v, s, [p]) => ME(p).xp, nativeGetYPrecision: (v, s, [p]) => ME(p).yp,
    nativeGetDownTimeNanos: (v, s, [p]) => ME(p).down, nativeSetDownTimeNanos: (v, s, [p, t]) => { ME(p).down = t },
    nativeGetPointerCount: (v, s, [p]) => ME(p).ptrs.length,
    nativeGetPointerId: (v, s, [p, i]) => ME(p).ptrs[i]?.id ?? -1,
    nativeGetToolType: (v, s, [p, i]) => ME(p).ptrs[i]?.tool ?? 0,
    nativeFindPointerIndex: (v, s, [p, id]) => ME(p).ptrs.findIndex((x) => x.id === id),
    nativeGetHistorySize: (v, s, [p]) => ME(p).samples.length - 1,
    nativeGetEventTimeNanos: (v, s, [p, pos]) => sampleAt(ME(p), pos).t,
    nativeGetRawAxisValue: (v, s, [p, axis, i, pos]) => Math.fround(sampleAt(ME(p), pos).c[i]?.[axis] ?? 0),
    nativeGetAxisValue: (v, s, [p, axis, i, pos]) => { const e = ME(p); const x = sampleAt(e, pos).c[i]?.[axis] ?? 0; return Math.fround(axis === 0 ? x + e.xo : axis === 1 ? x + e.yo : x) },
    nativeGetPointerCoords: (v, s, [p, i, pos, out]) => { const e = ME(p), c = sampleAt(e, pos).c[i] ?? []; AX.forEach((k, j) => (out.f[k] = Math.fround((c[j] ?? 0) + (j === 0 ? e.xo : j === 1 ? e.yo : 0)))); out.f.mPackedAxisBits = 0n },
    nativeGetPointerProperties: (v, s, [p, i, out]) => { const x = ME(p).ptrs[i]; out.f.id = x?.id ?? -1; out.f.toolType = x?.tool ?? 0 },
    nativeScale: (v, s, [p, k]) => { const e = ME(p); e.xo *= k; e.yo *= k; e.xp *= k; e.yp *= k; for (const sm of e.samples) for (const c of sm.c) { c[0] *= k; c[1] *= k; c[3] *= k; c[4] *= k; c[5] *= k; c[6] *= k; c[7] *= k } },
    nativeTransform: (v, s, [p, mh]) => {
      const e = ME(p), m = gfx.get<Float64Array>(mh.f.native_instance)
      if (!m) return
      for (const sm of e.samples) for (const c of sm.c) { const x = c[0] + e.xo, y = c[1] + e.yo, w = m[6] * x + m[7] * y + m[8] || 1; c[0] = (m[0] * x + m[1] * y + m[2]) / w; c[1] = (m[3] * x + m[4] * y + m[5]) / w }
      e.xo = 0; e.yo = 0
    },
    nativeReadFromParcel: (v, s, [p]) => p || nextH++, nativeWriteToParcel: () => {},
  })
  vm.registerNatives('Landroid/view/KeyCharacterMap;', {
    nativeGetCharacter: (v, s, [, code, meta]) => { const c = KEYS[code]; return c ? (meta & 1 ? c.toUpperCase() : c).charCodeAt(0) : 0 },
    nativeGetNumber: (v, s, [, code]) => (code >= 7 && code <= 16 ? 48 + code - 7 : 0),
    nativeGetDisplayLabel: (v, s, [, code]) => (KEYS[code] ?? '').toUpperCase().charCodeAt(0) || 0,
    nativeGetKeyboardType: () => 1, nativeGetMatch: () => 0, nativeGetEvents: () => null, nativeGetFallbackAction: () => 0,
    nativeReadFromParcel: () => 1, nativeWriteToParcel: () => {}, nativeDispose: () => {},
  })

  // ---------- droid.Compat (libcore's own java.* additions) and the binder context ----------
  vm.registerNatives('Ldroid/Compat;', {
    getInt: (v, s, [fd]) => fd?.f.descriptor ?? fd?.f.fd ?? -1,
    setInt: (v, s, [fd, x]) => { if (fd) fd.f.descriptor = x },
    unsafeArray: (v, s, [b]) => b?.f.array ?? null,
    unsafeArrayOffset: (v, s, [b]) => b?.f.offset ?? 0,
  })
  vm.registerNatives('Lcom/android/internal/os/BinderInternal;', {
    getContextObject: () => vm.newObject('Ldroid/system/ServiceRegistry;'),
    joinThreadPool: () => {}, disableBackgroundScheduling: () => {}, handleGc: () => {},
  })
  vm.registerNatives('Landroid/os/Process;', { 'setArgV0(Ljava/lang/String;)V': () => {}, getUidForName: () => 10000, getGidForName: () => 10000, getPids: () => null, sendSignal: () => {}, setProcessGroup: () => {}, getTotalMemory: () => 1024n << 20n, getFreeMemory: () => 512n << 20n })

  // ---------- touches from the page ----------
  // action: 0 down, 1 up, 2 move, 3 cancel; x / y in screen pixels
  const touch = (action: number, x: number, y: number, downAt: number) => {
    // the newest window that has input and holds the point (popups and dialogs come last)
    const rx = [...inputs.values()].reverse().find((r) => { const f = wins.get(r.window)?.frame; return !f || (x >= f[0] && x < f[2] && y >= f[1] && y < f[3]) }) ?? [...inputs.values()].pop()
    if (!rx) return
    const f = wins.get(rx.window)?.frame ?? [0, 0, 0, 0]
    const ev = vm.callStatic('Landroid/view/MotionEvent;', 'obtain(JJIFFI)Landroid/view/MotionEvent;', [BigInt(Math.round(downAt)), BigInt(Math.round(now())), action, Math.fround(x - f[0]), Math.fround(y - f[1]), 0])
    vm.callVirtual(ev, 'setSource(I)V', [0x1002]) // touchscreen
    post(rx.queue, rx.self, 'dispatchInputEvent(ILandroid/view/InputEvent;)V', [seq++, ev])
  }
  const key = (action: number, code: number) => {
    const rx = [...inputs.values()].pop()
    if (!rx) return
    const t = BigInt(Math.round(now()))
    const ev = vm.newObject('Landroid/view/KeyEvent;', '<init>(JJIIIIIIII)V', [t, t, action, code, 0, 0, -1, 0, 8, 0x101])
    post(rx.queue, rx.self, 'dispatchInputEvent(ILandroid/view/InputEvent;)V', [seq++, ev])
  }
  return { touch, key, later, windowOf: (surfaceObj: number) => surfaces.get(surfaceObj) ?? null, frameOf: (id: number) => wins.get(id)?.frame ?? null }
}

const KEYS: Record<number, string> = { 62: ' ', 66: '\n', 55: ',', 56: '.', 76: '/', 69: '-', 70: '=' }
for (let i = 0; i < 26; i++) KEYS[29 + i] = String.fromCharCode(97 + i)
for (let i = 0; i < 10; i++) KEYS[7 + i] = String.fromCharCode(48 + i)
