// framework shim, part 6: what game engines (unity) and bigger apps reach for beyond basic views:
// views made from code, SurfaceView / SurfaceHolder, touch and key events, display and window
// manager, package manager, assets read from the apk, system services (power, sensors, location,
// connectivity, telephony), settings, environment, xml pull parsing, rects, handler threads.
import { VM, JObject, JArray, JavaThrow, type NativeFn } from './dalvik.ts'
import { jstr, box } from './java.ts'
import { listZip, type ZipEntry } from '../zip.ts'
import type { Env } from './android.ts'

export interface MoreHelpers {
  el: (v: JObject) => HTMLElement
  report: (e: unknown) => void
  runSafe: (r: any) => void
  activity: () => JObject
  app: () => JObject | null
  prefsFor: (name: string) => JObject
  appInfo: () => JObject
  noop: NativeFn
}

const OBJ = 'Ljava/lang/Object;'

export function registerMore(vm: VM, env: Env, h: MoreHelpers) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => {
    // merge into an existing shim of the same name (part 1 defines many of these with a few methods)
    const old = vm.shims.get(name)
    vm.shim(name, { super: old?.super ?? sup, interfaces: [...(old?.interfaces || []), ...(extra.interfaces || [])], methods: { ...(old?.methods || {}), ...methods }, statics: { ...(old?.statics || {}), ...(extra.statics || {}) } })
  }
  const { el, noop } = h
  const dp = env.density
  const obj = (cls: string, f: Record<string, any> = {}) => { const o = new JObject(vm.cls(cls)); Object.assign(o.f, f); return o }
  const list = (items: any[]) => { const l = vm.newObject('Ljava/util/ArrayList;'); for (const x of items) vm.callVirtual(l, 'add(Ljava/lang/Object;)Z', [x]); return l }
  const strArray = (xs: string[]) => { const a = vm.newArray('[Ljava/lang/String;', xs.length); xs.forEach((x, i) => (a.data[i] = x)); return a }

  // ---------- views made in code: the element comes with the constructor ----------
  const TAGS: [string, string, string][] = [
    ['Landroid/view/SurfaceView;', 'canvas', 'an-surface'], ['Landroid/widget/EditText;', 'input', 'h-edit'], ['Landroid/widget/Button;', 'button', 'h-btn'],
    ['Landroid/widget/ImageView;', 'img', ''], ['Landroid/widget/TextView;', 'span', 'an-text'], ['Landroid/widget/ProgressBar;', 'div', 'an-progress'],
    ['Landroid/view/ViewGroup;', 'div', 'an-group'],
  ]
  const ensureEl = (s: JObject) => {
    if (s.f.el) return
    let tag = 'div', cls = 'an-view'
    for (const [c, t, k] of TAGS) if (vm.isSubclass(s.cls, vm.cls(c))) { tag = t; cls = k; break }
    const e = document.createElement(tag)
    e.className = cls
    if (tag === 'canvas') e.style.cssText = 'display:block;width:100%;height:100%;touch-action:none'
    if (vm.isSubclass(s.cls, vm.cls('Landroid/widget/FrameLayout;')) || vm.isSubclass(s.cls, vm.cls('Landroid/widget/RelativeLayout;'))) e.style.cssText = 'position:relative;width:100%;height:100%'
    s.f.el = e
    ;(e as any).__view = s
  }
  const ctors: Record<string, NativeFn> = {
    '<init>(Landroid/content/Context;)V': (v, s) => ensureEl(s),
    '<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V': (v, s) => ensureEl(s),
    '<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V': (v, s) => ensureEl(s),
  }
  // touch, the android way: one listener on the activity's root turns pointer events into MotionEvents
  // for Activity.dispatchTouchEvent, which hands them to the content view; a ViewGroup passes them
  // down the path to the touched view (keeping the view that took the down for the rest of the
  // gesture, onInterceptTouchEvent can take them over), and what nobody wants comes back up through
  // onTouchListener / onTouchEvent. coordinates are in each receiving view's own pixels
  const pointers = new Map<number, { rx: number; ry: number; id: number }>()
  let downTime = 0
  let touchPath: JObject[] = []
  const rootRect = () => env.root.getBoundingClientRect()
  const scaleOf = () => { const r = rootRect(); return env.root.offsetWidth ? r.width / env.root.offsetWidth : 1 }
  // a copy of the event in view coordinates
  const localize = (me: JObject, view: JObject | null) => {
    const r = view ? el(view)?.getBoundingClientRect() : null, rr = rootRect(), k = scaleOf()
    const ox = r ? ((r.left - rr.left) / k) * dp : 0, oy = r ? ((r.top - rr.top) / k) * dp : 0
    return obj('Landroid/view/MotionEvent;', { ...me.f, ps: (me.f.ps || []).map((p: any) => ({ ...p, rx: p.rx ?? p.x, ry: p.ry ?? p.y, x: (p.rx ?? p.x) - ox, y: (p.ry ?? p.y) - oy })) })
  }
  const dispatchTo = (view: JObject, me: JObject) => !!vm.callVirtual(view, 'dispatchTouchEvent(Landroid/view/MotionEvent;)Z', [localize(me, view)])
  // what View.dispatchTouchEvent does: the touch listener first, then onTouchEvent
  const viewDispatch = (s: JObject, me: JObject) => {
    if (s.f.onTouch && vm.callVirtual(s.f.onTouch, 'onTouch(Landroid/view/View;Landroid/view/MotionEvent;)Z', [s, me])) return 1
    return vm.callVirtual(s, 'onTouchEvent(Landroid/view/MotionEvent;)Z', [me]) ? 1 : 0
  }
  const groupDispatch = (s: JObject, me: JObject) => {
    const action = me.f.action & 0xff
    if (action === 0) s.f.touchTarget = null
    const intercepted = !!vm.callVirtual(s, 'onInterceptTouchEvent(Landroid/view/MotionEvent;)Z', [me])
    if (intercepted && s.f.touchTarget) { // taken over: the child gets a cancel
      dispatchTo(s.f.touchTarget, obj('Landroid/view/MotionEvent;', { ...me.f, action: 3 }))
      s.f.touchTarget = null
    }
    if (!intercepted) {
      if (s.f.touchTarget) { const r = dispatchTo(s.f.touchTarget, me); if (action === 1 || action === 3) s.f.touchTarget = null; return r ? 1 : 0 }
      if (action === 0 || action === 5) {
        const child = touchPath[touchPath.indexOf(s) + 1]
        if (child && dispatchTo(child, me)) { s.f.touchTarget = child; return 1 }
      }
    }
    return viewDispatch(s, me)
  }
  const installTouch = () => {
    const root = env.root
    if ((root as any).__touch) return
    ;(root as any).__touch = true
    root.style.touchAction = 'none'
    const send = (ev: PointerEvent, kind: 'down' | 'move' | 'up' | 'cancel') => {
      const act = h.activity()
      if (!act) return
      const rr = rootRect(), k = scaleOf()
      const rx = ((ev.clientX - rr.left) / k) * dp, ry = ((ev.clientY - rr.top) / k) * dp
      let action = 2
      if (kind === 'down') {
        if (!pointers.size) {
          downTime = performance.now()
          // the views under the finger, outermost first (the gesture keeps going to these)
          const path: JObject[] = []
          for (let e = ev.target as HTMLElement | null; e && e !== root; e = e.parentElement) if ((e as any).__view) path.unshift((e as any).__view)
          touchPath = path
        }
        const used = new Set([...pointers.values()].map((p) => p.id))
        let id = 0
        while (used.has(id)) id++
        pointers.set(ev.pointerId, { rx, ry, id })
        action = pointers.size === 1 ? 0 : 5
      } else {
        const p = pointers.get(ev.pointerId)
        if (!p) return
        p.rx = rx; p.ry = ry
        if (kind !== 'move') action = kind === 'cancel' ? 3 : pointers.size === 1 ? 1 : 6
      }
      const idx = Math.max(0, [...pointers.keys()].indexOf(ev.pointerId))
      const me = obj('Landroid/view/MotionEvent;', { action: action | (action === 5 || action === 6 ? idx << 8 : 0), ps: [...pointers.values()].map((p) => ({ ...p, x: p.rx, y: p.ry })), time: BigInt(Math.round(ev.timeStamp)), down: BigInt(Math.round(downTime)) })
      if (kind === 'up' || kind === 'cancel') pointers.delete(ev.pointerId)
      try { vm.callVirtual(act, 'dispatchTouchEvent(Landroid/view/MotionEvent;)Z', [me]) } catch (er) { h.report(er) }
    }
    root.addEventListener('pointerdown', (ev) => send(ev, 'down'))
    root.addEventListener('pointermove', (ev) => { if (pointers.has(ev.pointerId)) send(ev, 'move') })
    // a finger can end outside the root: listen on the window for the ends
    globalThis.addEventListener?.('pointerup', (ev: Event) => send(ev as PointerEvent, 'up'))
    globalThis.addEventListener?.('pointercancel', (ev: Event) => send(ev as PointerEvent, 'cancel'))
  }
  // older callers: the root listener covers every view now
  const bindTouch = (s: JObject) => { void s; installTouch() }
  // keys: the activity gets onKeyDown / onKeyUp (the shell's back key is handled elsewhere)
  def('Landroid/view/View;', OBJ, {
    ...ctors,
    'dispatchTouchEvent(Landroid/view/MotionEvent;)Z': (v, s, [e]) => viewDispatch(s, e),
    'onTouchEvent(Landroid/view/MotionEvent;)Z': () => 0,
    'dispatchTrackballEvent(Landroid/view/MotionEvent;)Z': () => 0,
    'onKeyDown(ILandroid/view/KeyEvent;)Z': () => 0, 'onKeyUp(ILandroid/view/KeyEvent;)Z': () => 0, 'onKeyPreIme(ILandroid/view/KeyEvent;)Z': () => 0,
    'onWindowFocusChanged(Z)V': noop, 'onAttachedToWindow()V': noop, 'onDetachedFromWindow()V': noop,
    'onSizeChanged(IIII)V': noop, 'onLayout(ZIIII)V': noop, 'onMeasure(II)V': noop,
    'setSystemUiVisibility(I)V': (v, s, [f]) => { env.droid.system.statusbar?.(!(f & 0x4)) }, // SYSTEM_UI_FLAG_FULLSCREEN
    'getSystemUiVisibility()I': () => 0,
    'getWindowVisibleDisplayFrame(Landroid/graphics/Rect;)V': (v, s, [r]) => { Object.assign(r.f, { left: 0, top: 0, right: Math.round(innerWidth * dp), bottom: Math.round(innerHeight * dp) }) },
    'setFocusable(Z)V': noop, 'setFocusableInTouchMode(Z)V': noop, 'setKeepScreenOn(Z)V': (v, s, [on]) => { env.droid.system.keepawake(!!on).catch?.(() => {}) },
    'setLayoutParams(Landroid/view/ViewGroup$LayoutParams;)V': (v, s, [p]) => { s.f.lp = p; applyLp(s, p) },
    'getLayoutParams()Landroid/view/ViewGroup$LayoutParams;': (v, s) => s.f.lp ?? null,
    'setClickable(Z)V': noop, 'setLongClickable(Z)V': noop, 'setWillNotDraw(Z)V': noop, 'setDrawingCacheEnabled(Z)V': noop,
    'setOnFocusChangeListener(Landroid/view/View$OnFocusChangeListener;)V': noop,
    'setOnTouchListener(Landroid/view/View$OnTouchListener;)V': (v, s, [l]) => { s.f.onTouch = l; bindTouch(s) },
    'getRootView()Landroid/view/View;': (v, s) => s,
    'getParent()Landroid/view/ViewParent;': (v, s) => (el(s)?.parentElement as any)?.__view ?? null,
    'isShown()Z': (v, s) => (el(s)?.isConnected ? 1 : 0),
    'hasWindowFocus()Z': () => 1,
    'getLocationOnScreen([I)V': (v, s, [a]) => { const r = el(s).getBoundingClientRect(); a.data[0] = Math.round(r.left * dp); a.data[1] = Math.round(r.top * dp) },
    'getMeasuredWidth()I': (v, s) => Math.round((el(s)?.clientWidth || 0) * dp),
    'getMeasuredHeight()I': (v, s) => Math.round((el(s)?.clientHeight || 0) * dp),
  })
  const applyLp = (s: JObject, p: JObject | null) => {
    const e = el(s)
    if (!e || !p) return
    const len = (x: number) => (x === -1 ? '100%' : x === -2 ? 'auto' : x / dp + 'px')
    if (p.f.w != null) e.style.width = len(p.f.w)
    if (p.f.h != null) e.style.height = len(p.f.h)
    if (p.f.weight > 0) { e.style.flex = `${p.f.weight} 1 0`; e.style.minWidth = e.style.minHeight = '0'; const row = e.parentElement?.style.flexDirection === 'row'; e.style[row ? 'width' : 'height'] = 'auto' }
    if (p.f.gravity != null && e.parentElement) { e.style.position = 'absolute'; const g = p.f.gravity; if ((g & 0x70) === 0x50) e.style.bottom = '0'; if ((g & 0x70) === 0x30) e.style.top = '0'; if ((g & 7) === 5) e.style.right = '0'; if ((g & 7) === 3) e.style.left = '0'; if ((g & 0x11) === 0x11) { e.style.left = '50%'; e.style.top = '50%'; e.style.transform = 'translate(-50%,-50%)' } }
  }
  // MotionEvent: pointer list, action, times
  const ptr = (s: JObject, i: number) => s.f.ps?.[i] ?? { x: 0, y: 0, id: 0 }
  def('Landroid/view/InputEvent;', OBJ, {})
  def('Landroid/view/MotionEvent;', 'Landroid/view/InputEvent;', {
    'getAction()I': (v, s) => s.f.action,
    'getActionMasked()I': (v, s) => s.f.action & 0xff,
    'getActionIndex()I': (v, s) => (s.f.action >> 8) & 0xff,
    'getPointerCount()I': (v, s) => s.f.ps?.length || 1,
    'getPointerId(I)I': (v, s, [i]) => ptr(s, i).id,
    'findPointerIndex(I)I': (v, s, [id]) => (s.f.ps || []).findIndex((p: any) => p.id === id),
    'getX()F': (v, s) => Math.fround(ptr(s, 0).x), 'getY()F': (v, s) => Math.fround(ptr(s, 0).y),
    'getX(I)F': (v, s, [i]) => Math.fround(ptr(s, i).x), 'getY(I)F': (v, s, [i]) => Math.fround(ptr(s, i).y),
    'getRawX()F': (v, s) => Math.fround(ptr(s, 0).rx ?? ptr(s, 0).x), 'getRawY()F': (v, s) => Math.fround(ptr(s, 0).ry ?? ptr(s, 0).y),
    'getPressure()F': () => 1, 'getPressure(I)F': () => 1, 'getSize()F': () => 0.1, 'getSize(I)F': () => 0.1,
    'getTouchMajor(I)F': () => 10, 'getToolType(I)I': () => 1,
    'getEventTime()J': (v, s) => s.f.time ?? 0n, 'getDownTime()J': (v, s) => s.f.down ?? 0n,
    'getHistorySize()I': () => 0, 'getHistoricalX(II)F': (v, s, [i]) => Math.fround(ptr(s, i).x), 'getHistoricalY(II)F': (v, s, [i]) => Math.fround(ptr(s, i).y),
    'getHistoricalEventTime(I)J': (v, s) => s.f.time ?? 0n,
    'getSource()I': () => 0x1002, 'getDeviceId()I': () => 1, 'getMetaState()I': () => 0, 'getFlags()I': () => 0, 'getEdgeFlags()I': () => 0,
    'recycle()V': noop,
    'obtain(JJIFFI)Landroid/view/MotionEvent;': (v, s, [d, t, a, x, y]) => obj('Landroid/view/MotionEvent;', { action: a, ps: [{ x, y, id: 0 }], time: t, down: d }),
    'obtain(JJIIIIIIFFIIII)Landroid/view/MotionEvent;': (v, s, [d, t, a]) => obj('Landroid/view/MotionEvent;', { action: a, ps: [], time: t, down: d }),
    'obtain(JJII[I[Landroid/view/MotionEvent$PointerCoords;IFFIIII)Landroid/view/MotionEvent;': (v, s, [d, t, a, , , coords]) => obj('Landroid/view/MotionEvent;', { action: a, ps: [...(coords?.data || [])].map((c: any, i: number) => ({ x: c?.f.x ?? 0, y: c?.f.y ?? 0, id: i })), time: t, down: d }),
    'addBatch(J[Landroid/view/MotionEvent$PointerCoords;I)V': noop,
    'toString()Ljava/lang/String;': (v, s) => `MotionEvent { action=${s.f.action} }`,
  }, { statics: { ACTION_DOWN: 0, ACTION_UP: 1, ACTION_MOVE: 2, ACTION_CANCEL: 3, ACTION_OUTSIDE: 4, ACTION_POINTER_DOWN: 5, ACTION_POINTER_UP: 6, ACTION_MASK: 0xff, ACTION_POINTER_INDEX_MASK: 0xff00, ACTION_POINTER_INDEX_SHIFT: 8 } })
  def('Landroid/view/MotionEvent$PointerCoords;', OBJ, { '<init>()V': (v, s) => { s.f.x = 0; s.f.y = 0 } })
  def('Landroid/view/KeyEvent;', 'Landroid/view/InputEvent;', {
    '<init>(II)V': (v, s, [a, c]) => { s.f.action = a; s.f.code = c },
    '<init>(JJIIIIIII)V': (v, s, [, , a, c, , meta]) => { s.f.action = a; s.f.code = c; s.f.meta = meta },
    'getAction()I': (v, s) => s.f.action ?? 0, 'getKeyCode()I': (v, s) => s.f.code ?? 0, 'getMetaState()I': (v, s) => s.f.meta ?? 0,
    'getUnicodeChar()I': (v, s) => s.f.char ?? 0, 'getUnicodeChar(I)I': (v, s) => s.f.char ?? 0, 'getScanCode()I': () => 0, 'getDeviceId()I': () => 0,
    'getRepeatCount()I': () => 0, 'isShiftPressed()Z': () => 0, 'getCharacters()Ljava/lang/String;': (v, s) => s.f.chars ?? null,
    'isSystem()Z': (v, s) => (s.f.code === 4 || s.f.code === 82 ? 1 : 0), 'getSource()I': () => 0x101, 'getFlags()I': () => 0,
  }, { statics: { ACTION_DOWN: 0, ACTION_UP: 1, ACTION_MULTIPLE: 2, KEYCODE_BACK: 4, KEYCODE_MENU: 82, KEYCODE_HOME: 3, KEYCODE_VOLUME_UP: 24, KEYCODE_VOLUME_DOWN: 25, KEYCODE_SEARCH: 84, KEYCODE_ENTER: 66, KEYCODE_DEL: 67 } })
  def('Landroid/view/InputDevice;', OBJ, {
    'getDevice(I)Landroid/view/InputDevice;': (v, s, [id]) => obj('Landroid/view/InputDevice;', { id }),
    'getDeviceIds()[I': () => { const a = vm.newArray('[I', 1); a.data[0] = 1; return a },
    'getSources()I': () => 0x1002, 'getName()Ljava/lang/String;': () => 'touchscreen', 'getId()I': (v, s) => s.f.id ?? 1,
    'getMotionRange(I)Landroid/view/InputDevice$MotionRange;': () => obj('Landroid/view/InputDevice$MotionRange;'),
    'getKeyboardType()I': () => 0, 'isVirtual()Z': () => 0,
  }, { statics: { SOURCE_TOUCHSCREEN: 0x1002, SOURCE_KEYBOARD: 0x101, SOURCE_MOUSE: 0x2002, SOURCE_CLASS_POINTER: 2, SOURCE_JOYSTICK: 0x1000010, SOURCE_GAMEPAD: 0x401 } })
  def('Landroid/view/InputDevice$MotionRange;', OBJ, { 'getRange()F': () => 1, 'getMin()F': () => 0, 'getMax()F': () => 1, 'getFlat()F': () => 0, 'getFuzz()F': () => 0 })

  // ---------- view groups, layout params ----------
  const lp = (cls: string) => def(cls, 'Landroid/view/ViewGroup$LayoutParams;', {
    '<init>(II)V': (v, s, [w, hh]) => { s.f.w = w; s.f.h = hh },
    '<init>(III)V': (v, s, [w, hh, g]) => { s.f.w = w; s.f.h = hh; s.f.gravity = g },
    '<init>(IIF)V': (v, s, [w, hh, wt]) => { s.f.w = w; s.f.h = hh; s.f.weight = wt },
    '<init>(Landroid/view/ViewGroup$LayoutParams;)V': (v, s, [o]) => { s.f.w = o?.f.w; s.f.h = o?.f.h },
    'addRule(I)V': (v, s, [r]) => { (s.f.rules ||= []).push(r) }, 'addRule(II)V': (v, s, [r]) => { (s.f.rules ||= []).push(r) },
    'setMargins(IIII)V': noop,
  })
  def('Landroid/view/ViewGroup$LayoutParams;', OBJ, { '<init>(II)V': (v, s, [w, hh]) => { s.f.w = w; s.f.h = hh } }, { statics: { MATCH_PARENT: -1, FILL_PARENT: -1, WRAP_CONTENT: -2 } })
  def('Landroid/view/ViewGroup$MarginLayoutParams;', 'Landroid/view/ViewGroup$LayoutParams;', { '<init>(II)V': (v, s, [w, hh]) => { s.f.w = w; s.f.h = hh }, 'setMargins(IIII)V': noop })
  for (const c of ['Landroid/widget/FrameLayout$LayoutParams;', 'Landroid/widget/RelativeLayout$LayoutParams;', 'Landroid/widget/LinearLayout$LayoutParams;', 'Landroid/view/WindowManager$LayoutParams;', 'Landroid/widget/AbsoluteLayout$LayoutParams;']) lp(c)
  def('Landroid/view/ViewGroup;', 'Landroid/view/View;', {
    ...ctors,
    'dispatchTouchEvent(Landroid/view/MotionEvent;)Z': (v, s, [e]) => groupDispatch(s, e),
    'onInterceptTouchEvent(Landroid/view/MotionEvent;)Z': () => 0,
    'requestDisallowInterceptTouchEvent(Z)V': noop,
    'addView(Landroid/view/View;)V': (v, s, [c]) => { ensureEl(s); ensureEl(c); el(s).append(el(c)); attached(c) },
    'addView(Landroid/view/View;I)V': (v, s, [c, i]) => { ensureEl(s); ensureEl(c); const k = el(s).children[i]; if (k && i >= 0) el(s).insertBefore(el(c), k); else el(s).append(el(c)); attached(c) },
    'addView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V': (v, s, [c, p]) => { ensureEl(s); ensureEl(c); el(s).append(el(c)); c.f.lp = p; applyLp(c, p); attached(c) },
    'addView(Landroid/view/View;II)V': (v, s, [c, w, hh]) => { ensureEl(s); ensureEl(c); el(s).append(el(c)); c.f.lp = obj('Landroid/view/ViewGroup$LayoutParams;', { w, h: hh }); applyLp(c, c.f.lp); attached(c) },
    'addView(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V': (v, s, [c, , p]) => { ensureEl(s); ensureEl(c); el(s).append(el(c)); c.f.lp = p; applyLp(c, p); attached(c) },
    'removeView(Landroid/view/View;)V': (v, s, [c]) => { el(c)?.remove(); detached(c) },
    'removeViewAt(I)V': (v, s, [i]) => { const k = el(s).children[i]; if (k) { k.remove(); detached((k as any).__view) } },
    'updateViewLayout(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V': (v, s, [c, p]) => { c.f.lp = p; applyLp(c, p) },
    'bringChildToFront(Landroid/view/View;)V': (v, s, [c]) => { el(s).append(el(c)) },
    'setClipChildren(Z)V': noop,
  })
  // surfaces need to know when they are on screen (surfaceCreated / surfaceChanged)
  const attached = (c: JObject) => { if (!c) return; requestAnimationFrame(() => { for (const sv of [c, ...childViews(c)]) if (sv.f.holder) surfaceUp(sv) }) }
  const detached = (c: JObject) => { if (!c) return; for (const sv of [c, ...childViews(c)]) if (sv.f.holder) surfaceDown(sv) }
  const childViews = (c: JObject): JObject[] => [...(el(c)?.querySelectorAll('*') || [])].map((e: any) => e.__view).filter(Boolean)
  for (const c of ['Landroid/widget/FrameLayout;', 'Landroid/widget/RelativeLayout;', 'Landroid/widget/LinearLayout;', 'Landroid/widget/AbsoluteLayout;'])
    def(c, 'Landroid/view/ViewGroup;', { ...ctors, 'onKeyDown(ILandroid/view/KeyEvent;)Z': () => 0, 'onKeyUp(ILandroid/view/KeyEvent;)Z': () => 0, 'onKeyPreIme(ILandroid/view/KeyEvent;)Z': () => 0, 'setForegroundGravity(I)V': noop })
  for (const c of ['Landroid/widget/TextView;', 'Landroid/widget/Button;', 'Landroid/widget/EditText;', 'Landroid/widget/ImageView;', 'Landroid/widget/ProgressBar;'])
    def(c, vm.shims.get(c)?.super ?? 'Landroid/view/View;', { ...ctors, 'setIndeterminate(Z)V': noop, 'setImeOptions(I)V': noop, 'setInputType(I)V': (v, s, [t]) => { s.f.inputType = t }, 'getInputType()I': (v, s) => s.f.inputType ?? 1, 'setRawInputType(I)V': noop, 'selectAll()V': (v, s) => { (el(s) as HTMLInputElement).select?.() }, 'addTextChangedListener(Landroid/text/TextWatcher;)V': noop, 'setKeyListener(Landroid/text/method/KeyListener;)V': noop, 'setOnEditorActionListener(Landroid/widget/TextView$OnEditorActionListener;)V': noop, 'setSingleLine()V': noop, 'setSingleLine(Z)V': noop, 'setGravity(I)V': noop })

  // ---------- SurfaceView and its holder ----------
  // the canvas is the surface. surfaceCreated / surfaceChanged fire once it is on screen
  const holderOf = (sv: JObject) => {
    if (!sv.f.holder) {
      ensureEl(sv)
      sv.f.holder = obj('Landroid/view/SurfaceHolder;', { view: sv, callbacks: [], format: 4 })
      sv.f.holder.f.surface = obj('Landroid/view/Surface;', { view: sv, canvas: el(sv) })
      new ResizeObserver(() => { if (sv.f.up) surfaceSize(sv, true) }).observe(el(sv))
    }
    return sv.f.holder as JObject
  }
  const surfaceSize = (sv: JObject, changed: boolean) => {
    const c = el(sv) as HTMLCanvasElement, hd = sv.f.holder
    const w = hd.f.fixedW || Math.max(1, Math.round(c.clientWidth * dp)), hh = hd.f.fixedH || Math.max(1, Math.round(c.clientHeight * dp))
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh } else if (changed) return
    for (const cb of hd.f.callbacks) try { vm.callVirtual(cb, 'surfaceChanged(Landroid/view/SurfaceHolder;III)V', [hd, hd.f.format, w, hh]) } catch (e) { h.report(e) }
  }
  const surfaceUp = (sv: JObject) => {
    if (sv.f.up || !el(sv).isConnected) return
    sv.f.up = true
    const hd = sv.f.holder
    for (const cb of hd.f.callbacks) try { vm.callVirtual(cb, 'surfaceCreated(Landroid/view/SurfaceHolder;)V', [hd]) } catch (e) { h.report(e) }
    surfaceSize(sv, false)
  }
  const surfaceDown = (sv: JObject) => {
    if (!sv.f.up) return
    sv.f.up = false
    const hd = sv.f.holder
    for (const cb of hd.f.callbacks) try { vm.callVirtual(cb, 'surfaceDestroyed(Landroid/view/SurfaceHolder;)V', [hd]) } catch (e) { h.report(e) }
  }
  def('Landroid/view/SurfaceView;', 'Landroid/view/View;', {
    ...ctors,
    'getHolder()Landroid/view/SurfaceHolder;': (v, s) => holderOf(s),
    'setZOrderOnTop(Z)V': noop, 'setZOrderMediaOverlay(Z)V': noop,
    'onTouchEvent(Landroid/view/MotionEvent;)Z': () => 0,
  })
  def('Landroid/view/SurfaceHolder;', OBJ, {
    'addCallback(Landroid/view/SurfaceHolder$Callback;)V': (v, s, [cb]) => { s.f.callbacks.push(cb); bindTouch(s.f.view); if (s.f.view.f.up) { try { vm.callVirtual(cb, 'surfaceCreated(Landroid/view/SurfaceHolder;)V', [s]) } catch (e) { h.report(e) } } else attached(s.f.view) },
    'removeCallback(Landroid/view/SurfaceHolder$Callback;)V': (v, s, [cb]) => { s.f.callbacks = s.f.callbacks.filter((x: any) => x !== cb) },
    'getSurface()Landroid/view/Surface;': (v, s) => s.f.surface,
    'setFormat(I)V': (v, s, [f]) => { s.f.format = f }, 'setType(I)V': noop, 'setKeepScreenOn(Z)V': noop,
    'setFixedSize(II)V': (v, s, [w, hh]) => { s.f.fixedW = w; s.f.fixedH = hh; if (s.f.view.f.up) surfaceSize(s.f.view, false) },
    'setSizeFromLayout()V': (v, s) => { s.f.fixedW = 0; s.f.fixedH = 0; if (s.f.view.f.up) surfaceSize(s.f.view, false) },
    'getSurfaceFrame()Landroid/graphics/Rect;': (v, s) => { const c = el(s.f.view) as HTMLCanvasElement; return obj('Landroid/graphics/Rect;', { left: 0, top: 0, right: c.width, bottom: c.height }) },
    'isCreating()Z': () => 0,
    'lockCanvas()Landroid/graphics/Canvas;': () => null, 'unlockCanvasAndPost(Landroid/graphics/Canvas;)V': noop,
  })
  def('Landroid/view/SurfaceHolder$Callback;', OBJ, {})
  def('Landroid/view/SurfaceHolder$Callback2;', OBJ, {}, { interfaces: ['Landroid/view/SurfaceHolder$Callback;'] })
  def('Landroid/view/Surface;', OBJ, { 'isValid()Z': (v, s) => (s.f.view?.f.up ? 1 : 0), 'release()V': noop })
  // GLSurfaceView: a SurfaceView whose renderer runs in a loop (the egl part comes with opengl)
  def('Landroid/opengl/GLSurfaceView;', 'Landroid/view/SurfaceView;', {
    ...ctors,
    'setEGLContextClientVersion(I)V': (v, s, [n]) => { s.f.glVersion = n },
    'setEGLConfigChooser(IIIIII)V': noop, 'setEGLConfigChooser(Z)V': noop, 'setPreserveEGLContextOnPause(Z)V': noop,
    'setRenderer(Landroid/opengl/GLSurfaceView$Renderer;)V': (v, s, [r]) => { s.f.renderer = r; holderOf(s) },
    'setRenderMode(I)V': (v, s, [m]) => { s.f.mode = m }, 'requestRender()V': noop, 'queueEvent(Ljava/lang/Runnable;)V': (v, s, [r]) => { setTimeout(() => h.runSafe(r), 0) },
    'onPause()V': noop, 'onResume()V': noop, 'onDetachedFromWindow()V': noop, 'onAttachedToWindow()V': noop,
  }, { statics: { RENDERMODE_WHEN_DIRTY: 0, RENDERMODE_CONTINUOUSLY: 1 } })

  // ---------- display, window manager ----------
  const W = () => Math.round(innerWidth * dp), H = () => Math.round(innerHeight * dp)
  def('Landroid/view/Display;', OBJ, {
    'getWidth()I': W, 'getHeight()I': H,
    'getSize(Landroid/graphics/Point;)V': (v, s, [p]) => { p.f.x = W(); p.f.y = H() },
    'getRealSize(Landroid/graphics/Point;)V': (v, s, [p]) => { p.f.x = W(); p.f.y = H() },
    'getMetrics(Landroid/util/DisplayMetrics;)V': (v, s, [m]) => Object.assign(m.f, metrics()),
    'getRealMetrics(Landroid/util/DisplayMetrics;)V': (v, s, [m]) => Object.assign(m.f, metrics()),
    'getOrientation()I': () => (innerWidth > innerHeight ? 1 : 0), 'getRotation()I': () => (innerWidth > innerHeight ? 1 : 0),
    'getRefreshRate()F': () => 60, 'getPixelFormat()I': () => 1, 'getDisplayId()I': () => 0, 'getName()Ljava/lang/String;': () => 'Built-in Screen',
  })
  const metrics = () => ({ density: dp, scaledDensity: dp, densityDpi: Math.round(dp * 160), widthPixels: W(), heightPixels: H(), xdpi: dp * 160, ydpi: dp * 160 })
  def('Landroid/graphics/Point;', OBJ, { '<init>()V': (v, s) => { s.f.x = 0; s.f.y = 0 }, '<init>(II)V': (v, s, [x, y]) => { s.f.x = x; s.f.y = y } })
  def('Landroid/view/WindowManager;', OBJ, {
    'getDefaultDisplay()Landroid/view/Display;': () => obj('Landroid/view/Display;'),
    'addView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V': (v, s, [c]) => { ensureEl(c); env.root.append(el(c)); attached(c) },
    'removeView(Landroid/view/View;)V': (v, s, [c]) => { el(c)?.remove() },
    'updateViewLayout(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V': noop,
  })
  def('Landroid/view/Window;', OBJ, {
    'getDecorView()Landroid/view/View;': () => { const d = obj('Landroid/widget/FrameLayout;'); d.f.el = env.root; return d },
    'getAttributes()Landroid/view/WindowManager$LayoutParams;': () => obj('Landroid/view/WindowManager$LayoutParams;', { w: -1, h: -1 }),
    'setAttributes(Landroid/view/WindowManager$LayoutParams;)V': noop,
    'getWindowManager()Landroid/view/WindowManager;': () => obj('Landroid/view/WindowManager;'),
    'setContentView(Landroid/view/View;)V': (v, s, [c]) => vm.callVirtual(h.activity(), 'setContentView(Landroid/view/View;)V', [c]),
  })

  // ---------- rects ----------
  const rect = (cls: string, conv: (x: number) => number) => def(cls, OBJ, {
    '<init>()V': (v, s) => Object.assign(s.f, { left: 0, top: 0, right: 0, bottom: 0 }),
    [`<init>(${cls === 'Landroid/graphics/RectF;' ? 'FFFF' : 'IIII'})V`]: (v, s, [l, t, r, b]) => Object.assign(s.f, { left: l, top: t, right: r, bottom: b }),
    [`width()${cls === 'Landroid/graphics/RectF;' ? 'F' : 'I'}`]: (v, s) => conv(s.f.right - s.f.left),
    [`height()${cls === 'Landroid/graphics/RectF;' ? 'F' : 'I'}`]: (v, s) => conv(s.f.bottom - s.f.top),
    [`set(${cls === 'Landroid/graphics/RectF;' ? 'FFFF' : 'IIII'})V`]: (v, s, [l, t, r, b]) => Object.assign(s.f, { left: l, top: t, right: r, bottom: b }),
    'isEmpty()Z': (v, s) => (s.f.right <= s.f.left || s.f.bottom <= s.f.top ? 1 : 0),
    [`contains(${cls === 'Landroid/graphics/RectF;' ? 'FF' : 'II'})Z`]: (v, s, [x, y]) => (x >= s.f.left && x < s.f.right && y >= s.f.top && y < s.f.bottom ? 1 : 0),
    [`centerX()${cls === 'Landroid/graphics/RectF;' ? 'F' : 'I'}`]: (v, s) => conv((s.f.left + s.f.right) / 2),
    [`centerY()${cls === 'Landroid/graphics/RectF;' ? 'F' : 'I'}`]: (v, s) => conv((s.f.top + s.f.bottom) / 2),
    'toString()Ljava/lang/String;': (v, s) => `Rect(${s.f.left}, ${s.f.top} - ${s.f.right}, ${s.f.bottom})`,
  })
  rect('Landroid/graphics/Rect;', (x) => x | 0)
  rect('Landroid/graphics/RectF;', Math.fround)

  // ---------- activity / context extras ----------
  const pmObj = () => obj('Landroid/content/pm/PackageManager;')
  def('Landroid/content/Context;', OBJ, {
    'checkCallingOrSelfPermission(Ljava/lang/String;)I': () => 0,
    'checkPermission(Ljava/lang/String;II)I': () => 0,
    'checkSelfPermission(Ljava/lang/String;)I': () => 0,
    'getContentResolver()Landroid/content/ContentResolver;': () => obj('Landroid/content/ContentResolver;'),
    'getPackageManager()Landroid/content/pm/PackageManager;': pmObj,
    'getAssets()Landroid/content/res/AssetManager;': () => assets(),
    'bindService(Landroid/content/Intent;Landroid/content/ServiceConnection;I)Z': () => 0,
    'unbindService(Landroid/content/ServiceConnection;)V': noop,
    'getClassLoader()Ljava/lang/ClassLoader;': () => vm.callStatic('Ljava/lang/ClassLoader;', 'getSystemClassLoader()Ljava/lang/ClassLoader;'),
    'getMainLooper()Landroid/os/Looper;': () => mainLooper,
    'getApplicationInfo()Landroid/content/pm/ApplicationInfo;': () => h.appInfo(),
  })
  def('Landroid/app/Activity;', 'Landroid/view/ContextThemeWrapper;', {
    'getLocalClassName()Ljava/lang/String;': (v, s) => { const n = s.cls.name.slice(1, -1).replace(/\//g, '.'); return n.startsWith(env.pkg + '.') ? n.slice(env.pkg.length + 1) : n },
    'getComponentName()Landroid/content/ComponentName;': (v, s) => obj('Landroid/content/ComponentName;', { pkg: env.pkg, cls: s.cls.name.slice(1, -1).replace(/\//g, '.') }),
    'getRequestedOrientation()I': (v, s) => s.f.orientation ?? -1,
    'setRequestedOrientation(I)V': (v, s, [o]) => { s.f.orientation = o; const want = o === 1 || o === 7 || o === 9 || o === 12 ? 'portrait' : o === 0 || o === 6 || o === 8 || o === 11 ? 'landscape' : 'any'; env.droid.system.orientation?.(want)?.catch?.(() => {}) },
    'onWindowFocusChanged(Z)V': noop, 'onTouchEvent(Landroid/view/MotionEvent;)Z': () => 0,
    // the content view first, then the activity's own onTouchEvent
    'dispatchTouchEvent(Landroid/view/MotionEvent;)Z': (v, s, [e]) => {
      const content = (env.root.querySelector(':scope > .an-content') as any)?.__view as JObject | undefined
      if (content && dispatchTo(content, e)) return 1
      return vm.callVirtual(s, 'onTouchEvent(Landroid/view/MotionEvent;)Z', [e]) ? 1 : 0
    },
    'onKeyDown(ILandroid/view/KeyEvent;)Z': () => 0, 'onKeyUp(ILandroid/view/KeyEvent;)Z': () => 0,
    'onConfigurationChanged(Landroid/content/res/Configuration;)V': noop, 'onLowMemory()V': noop,
    'getWindowManager()Landroid/view/WindowManager;': () => obj('Landroid/view/WindowManager;'),
    'getChangingConfigurations()I': () => 0, 'isFinishing()Z': () => 0, 'hasWindowFocus()Z': () => 1,
    'getCallingActivity()Landroid/content/ComponentName;': () => null, 'getCallingPackage()Ljava/lang/String;': () => null,
    'getTaskId()I': () => 1, 'isTaskRoot()Z': () => 1, 'moveTaskToBack(Z)Z': () => 1,
    'overridePendingTransition(II)V': noop, 'setVolumeControlStream(I)V': noop, 'takeKeyEvents(Z)V': noop,
  })
  def('Landroid/content/ComponentName;', OBJ, {
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [p, c]) => { s.f.pkg = p; s.f.cls = c },
    '<init>(Landroid/content/Context;Ljava/lang/String;)V': (v, s, [, c]) => { s.f.pkg = env.pkg; s.f.cls = c },
    '<init>(Landroid/content/Context;Ljava/lang/Class;)V': (v, s, [, c]) => { s.f.pkg = env.pkg; s.f.cls = c.f.of.name.slice(1, -1).replace(/\//g, '.') },
    'getPackageName()Ljava/lang/String;': (v, s) => s.f.pkg, 'getClassName()Ljava/lang/String;': (v, s) => s.f.cls,
    'getShortClassName()Ljava/lang/String;': (v, s) => (s.f.cls.startsWith(s.f.pkg) ? s.f.cls.slice(s.f.pkg.length) : s.f.cls),
    'flattenToString()Ljava/lang/String;': (v, s) => `${s.f.pkg}/${s.f.cls}`,
  })
  // NativeActivity (unity's native activity variant): a plain activity here
  def('Landroid/app/NativeActivity;', 'Landroid/app/Activity;', { '<init>()V': noop })

  // ---------- package manager ----------
  def('Landroid/content/pm/PackageManager;', OBJ, {
    'getPackageInfo(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;': (v, s, [p]) => {
      if (p !== env.pkg) throw vm.error('Landroid/content/pm/PackageManager$NameNotFoundException;', p)
      const m = env.files.get('AndroidManifest.xml')
      void m
      const sig = obj('Landroid/content/pm/Signature;', { bytes: new Uint8Array(32).fill(7) })
      const sigs = vm.newArray('[Landroid/content/pm/Signature;', 1); sigs.data[0] = sig
      return obj('Landroid/content/pm/PackageInfo;', { packageName: env.pkg, versionName: (env as any).versionName ?? '1.0', versionCode: (env as any).versionCode ?? 1, applicationInfo: h.appInfo(), signatures: sigs, firstInstallTime: 0n, lastUpdateTime: 0n })
    },
    'getApplicationInfo(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;': (v, s, [p]) => {
      if (p !== env.pkg) throw vm.error('Landroid/content/pm/PackageManager$NameNotFoundException;', p)
      const a = h.appInfo()
      a.f.metaData ??= metaBundle()
      return a
    },
    'getActivityInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ActivityInfo;': (v, s, [c]) => obj('Landroid/content/pm/ActivityInfo;', { name: c?.f.cls, packageName: env.pkg, metaData: metaBundle(), screenOrientation: -1, configChanges: 0 }),
    'hasSystemFeature(Ljava/lang/String;)Z': (v, s, [f]) => (/touchscreen|screen\.(portrait|landscape)|opengles|wifi|faketouch|microphone/.test(String(f)) ? 1 : 0),
    'checkPermission(Ljava/lang/String;Ljava/lang/String;)I': () => 0,
    'getInstalledPackages(I)Ljava/util/List;': () => list([]),
    'getInstalledApplications(I)Ljava/util/List;': () => list([]),
    'queryIntentActivities(Landroid/content/Intent;I)Ljava/util/List;': () => list([]),
    'queryIntentServices(Landroid/content/Intent;I)Ljava/util/List;': () => list([]),
    'resolveActivity(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;': () => null,
    'getLaunchIntentForPackage(Ljava/lang/String;)Landroid/content/Intent;': () => null,
    'getInstallerPackageName(Ljava/lang/String;)Ljava/lang/String;': () => 'danen.store',
    'getApplicationLabel(Landroid/content/pm/ApplicationInfo;)Ljava/lang/CharSequence;': () => env.pkg,
  }, { statics: { GET_META_DATA: 128, GET_SIGNATURES: 64, GET_ACTIVITIES: 1, PERMISSION_GRANTED: 0, PERMISSION_DENIED: -1, FEATURE_TOUCHSCREEN: 'android.hardware.touchscreen' } })
  vm.shim('Landroid/content/pm/PackageManager$NameNotFoundException;', { super: 'Ljava/lang/Exception;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m } } })
  def('Landroid/content/pm/PackageInfo;', OBJ, { '<init>()V': noop })
  def('Landroid/content/pm/ActivityInfo;', 'Landroid/content/pm/PackageItemInfo;', { '<init>()V': noop })
  def('Landroid/content/pm/Signature;', OBJ, {
    'toByteArray()[B': (v, s) => { const a = vm.newArray('[B', s.f.bytes.length); (a.data as Int8Array).set(new Int8Array(s.f.bytes.buffer)); return a },
    'toCharsString()Ljava/lang/String;': (v, s) => [...s.f.bytes].map((b: number) => b.toString(16).padStart(2, '0')).join(''),
    'hashCode()I': () => 0x0d0d0d0d,
  })
  // <meta-data> of the application in the manifest -> a Bundle
  let meta: JObject | null = null
  const metaBundle = () => {
    if (meta) return meta
    meta = obj('Landroid/os/Bundle;', { map: {} })
    try {
      const man = (env as any).manifestXml as any
      const app = man?.children.find((c: any) => c.tag === 'application')
      for (const m of app?.children || []) {
        if (m.tag !== 'meta-data') continue
        const n = m.attrs.find((a: any) => a.name === 'name')?.value.str, val = m.attrs.find((a: any) => a.name === 'value')?.value
        if (n && val) meta.f.map[n] = val.str ?? (val.type === 0x12 ? !!val.data : val.data)
      }
    } catch { /* no manifest */ }
    return meta
  }

  // ---------- assets: read straight from the apk (kept as original/ for native apps) ----------
  let zipIndex: Map<string, ZipEntry> | null = null
  const apkBytes = () => env.vfs?.read(`/data/app/${env.pkg}-1.apk`) ?? null
  const assetEntry = (p: string) => {
    const apk = apkBytes()
    if (!apk) return null
    if (!zipIndex) { zipIndex = new Map(); for (const e of listZip(apk.buffer.slice(apk.byteOffset, apk.byteOffset + apk.length) as ArrayBuffer)) zipIndex.set(e.path, e) }
    return zipIndex.get('assets/' + p.replace(/^\/+/, '')) ?? null
  }
  const assetBytes = (p: string): Uint8Array | null => {
    const e = assetEntry(p)
    const apk = apkBytes()
    if (e && apk) {
      const start = dataStart(apk, e)
      if (e.method === 0) return apk.subarray(start, start + e.size)
      return inflateSync(apk.subarray(start, start + e.compressed), e.size)
    }
    // apps without the original: their assets were unpacked under apk/assets/
    const f = env.files.get('assets/' + p)
    return f ?? null
  }
  // where an entry's bytes start: after its local header (name and extra field lengths vary)
  const dataStart = (apk: Uint8Array, e: ZipEntry) => { const o = e.offset; return o + 30 + (apk[o + 26] | (apk[o + 27] << 8)) + (apk[o + 28] | (apk[o + 29] << 8)) }
  let assetMgr: JObject | null = null
  const assets = () => (assetMgr ||= obj('Landroid/content/res/AssetManager;'))
  def('Landroid/content/res/AssetManager;', OBJ, {
    'open(Ljava/lang/String;)Ljava/io/InputStream;': (v, s, [p]) => stream(p),
    'open(Ljava/lang/String;I)Ljava/io/InputStream;': (v, s, [p]) => stream(p),
    'openFd(Ljava/lang/String;)Landroid/content/res/AssetFileDescriptor;': (v, s, [p]) => {
      const e = assetEntry(p)
      if (!e || e.method !== 0) throw vm.error('Ljava/io/FileNotFoundException;', 'This file can not be opened as a file descriptor; it is probably compressed')
      return obj('Landroid/content/res/AssetFileDescriptor;', { path: `/data/app/${env.pkg}-1.apk`, start: BigInt(dataStart(apkBytes()!, e)), length: BigInt(e.size) })
    },
    'list(Ljava/lang/String;)[Ljava/lang/String;': (v, s, [dir]) => {
      const pre = 'assets/' + (dir ? String(dir).replace(/\/?$/, '/') : '')
      const names = new Set<string>()
      if (apkBytes()) { assetEntry(''); for (const k of zipIndex!.keys()) if (k.startsWith(pre)) names.add(k.slice(pre.length).split('/')[0]) }
      for (const k of env.files.keys()) if (k.startsWith(pre)) names.add(k.slice(pre.length).split('/')[0])
      return strArray([...names].filter(Boolean))
    },
    'close()V': noop,
  })
  const stream = (p: string) => {
    const b = assetBytes(p)
    if (!b) throw vm.error('Ljava/io/FileNotFoundException;', p)
    const i = obj('Ljava/io/ByteArrayInputStream;')
    i.f.buf = b; i.f.pos = 0
    return i
  }
  def('Landroid/content/res/AssetFileDescriptor;', OBJ, {
    'getFileDescriptor()Ljava/io/FileDescriptor;': (v, s) => obj('Ljava/io/FileDescriptor;', { path: s.f.path }),
    'getStartOffset()J': (v, s) => s.f.start, 'getLength()J': (v, s) => s.f.length, 'getDeclaredLength()J': (v, s) => s.f.length,
    'close()V': noop,
  })
  def('Ljava/io/FileDescriptor;', OBJ, { 'valid()Z': () => 1 })
  def('Ljava/io/FileInputStream;', 'Ljava/io/InputStream;', { 'getFD()Ljava/io/FileDescriptor;': (v, s) => obj('Ljava/io/FileDescriptor;', { path: s.f.path }) })
  def('Landroid/content/res/Resources;', OBJ, {
    'getAssets()Landroid/content/res/AssetManager;': () => assets(),
    'getConfiguration()Landroid/content/res/Configuration;': () => configuration(),
  })
  const configuration = () => obj('Landroid/content/res/Configuration;', { orientation: innerWidth > innerHeight ? 2 : 1, screenLayout: 2, touchscreen: 3, keyboard: 1, keyboardHidden: 2, hardKeyboardHidden: 2, navigation: 1, uiMode: 0x11, fontScale: 1, mcc: 0, mnc: 0, locale: obj('Ljava/util/Locale;', { lang: env.lang, country: 'US' }), screenWidthDp: innerWidth, screenHeightDp: innerHeight, smallestScreenWidthDp: Math.min(innerWidth, innerHeight), densityDpi: Math.round(dp * 160) })
  def('Landroid/content/res/Configuration;', OBJ, { '<init>()V': noop }, { statics: { ORIENTATION_PORTRAIT: 1, ORIENTATION_LANDSCAPE: 2, ORIENTATION_UNDEFINED: 0 } })

  // ---------- system services ----------
  const service = (name: string): JObject | null => {
    switch (name) {
      case 'window': return obj('Landroid/view/WindowManager;')
      case 'power': return obj('Landroid/os/PowerManager;')
      case 'sensor': return obj('Landroid/hardware/SensorManager;')
      case 'location': return obj('Landroid/location/LocationManager;')
      case 'connectivity': return obj('Landroid/net/ConnectivityManager;')
      case 'phone': return obj('Landroid/telephony/TelephonyManager;')
      case 'input_method': return obj('Landroid/view/inputmethod/InputMethodManager;')
      case 'wifi': return obj('Landroid/net/wifi/WifiManager;')
      case 'activity': return obj('Landroid/app/ActivityManager;')
      case 'keyguard': return obj('Landroid/app/KeyguardManager;')
      case 'clipboard': return obj('Landroid/text/ClipboardManager;')
      case 'display': return obj('Landroid/hardware/display/DisplayManager;')
      default: return undefined as any
    }
  }
  const ctxShim = vm.shims.get('Landroid/content/Context;')!
  const prevService = ctxShim.methods!['getSystemService(Ljava/lang/String;)Ljava/lang/Object;']
  def('Landroid/content/Context;', OBJ, { 'getSystemService(Ljava/lang/String;)Ljava/lang/Object;': (v, s, a) => { const x = service(a[0]); return x !== undefined ? x : prevService(v, s, a) } })
  def('Landroid/os/PowerManager;', OBJ, {
    'newWakeLock(ILjava/lang/String;)Landroid/os/PowerManager$WakeLock;': () => obj('Landroid/os/PowerManager$WakeLock;'),
    'isScreenOn()Z': () => (document.hidden ? 0 : 1), 'isInteractive()Z': () => (document.hidden ? 0 : 1),
  }, { statics: { SCREEN_BRIGHT_WAKE_LOCK: 10, FULL_WAKE_LOCK: 26, PARTIAL_WAKE_LOCK: 1, SCREEN_DIM_WAKE_LOCK: 6, ACQUIRE_CAUSES_WAKEUP: 0x10000000, ON_AFTER_RELEASE: 0x20000000 } })
  def('Landroid/os/PowerManager$WakeLock;', OBJ, {
    'acquire()V': (v, s) => { s.f.held = true; env.droid.system.keepawake(true).catch?.(() => {}) },
    'acquire(J)V': (v, s) => { s.f.held = true; env.droid.system.keepawake(true).catch?.(() => {}) },
    'release()V': (v, s) => { s.f.held = false; env.droid.system.keepawake(false).catch?.(() => {}) },
    'isHeld()Z': (v, s) => (s.f.held ? 1 : 0), 'setReferenceCounted(Z)V': noop,
  })
  // no motion sensors on most browsers that matter here: no default sensors (apps handle null)
  def('Landroid/hardware/SensorManager;', OBJ, {
    'getDefaultSensor(I)Landroid/hardware/Sensor;': () => null,
    'getSensorList(I)Ljava/util/List;': () => list([]),
    'registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;I)Z': () => 0,
    'registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;ILandroid/os/Handler;)Z': () => 0,
    'unregisterListener(Landroid/hardware/SensorEventListener;)V': noop,
    'unregisterListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;)V': noop,
    'getRotationMatrix([F[F[F[F)Z': () => 0,
    'getOrientation([F[F)[F': (v, s, [, o]) => o,
  }, { statics: { SENSOR_DELAY_FASTEST: 0, SENSOR_DELAY_GAME: 1, SENSOR_DELAY_UI: 2, SENSOR_DELAY_NORMAL: 3, GRAVITY_EARTH: 9.80665 } })
  def('Landroid/hardware/Sensor;', OBJ, {}, { statics: { TYPE_ACCELEROMETER: 1, TYPE_MAGNETIC_FIELD: 2, TYPE_ORIENTATION: 3, TYPE_GYROSCOPE: 4, TYPE_LIGHT: 5, TYPE_GRAVITY: 9, TYPE_LINEAR_ACCELERATION: 10, TYPE_ROTATION_VECTOR: 11 } })
  def('Landroid/hardware/GeomagneticField;', OBJ, { '<init>(FFFJ)V': noop, 'getDeclination()F': () => 0 })
  def('Landroid/location/LocationManager;', OBJ, {
    'getProviders(Z)Ljava/util/List;': () => list([]),
    'getProviders(Landroid/location/Criteria;Z)Ljava/util/List;': () => list([]),
    'getAllProviders()Ljava/util/List;': () => list([]),
    'getProvider(Ljava/lang/String;)Landroid/location/LocationProvider;': () => null,
    'getLastKnownLocation(Ljava/lang/String;)Landroid/location/Location;': () => null,
    'isProviderEnabled(Ljava/lang/String;)Z': () => 0,
    'requestLocationUpdates(Ljava/lang/String;JFLandroid/location/LocationListener;)V': noop,
    'requestLocationUpdates(Ljava/lang/String;JFLandroid/location/LocationListener;Landroid/os/Looper;)V': noop,
    'removeUpdates(Landroid/location/LocationListener;)V': noop,
  }, { statics: { GPS_PROVIDER: 'gps', NETWORK_PROVIDER: 'network', PASSIVE_PROVIDER: 'passive' } })
  def('Landroid/location/Location;', OBJ, { 'getTime()J': () => 0n, 'getAccuracy()F': () => 0, 'getLatitude()D': () => 0, 'getLongitude()D': () => 0, 'getAltitude()D': () => 0, 'getProvider()Ljava/lang/String;': () => 'network' })
  def('Landroid/location/LocationProvider;', OBJ, { 'getAccuracy()I': () => 2 })
  def('Landroid/net/ConnectivityManager;', OBJ, {
    'getActiveNetworkInfo()Landroid/net/NetworkInfo;': () => (navigator.onLine ? obj('Landroid/net/NetworkInfo;') : null),
    'getNetworkInfo(I)Landroid/net/NetworkInfo;': () => obj('Landroid/net/NetworkInfo;'),
    'getAllNetworkInfo()[Landroid/net/NetworkInfo;': () => { const a = vm.newArray('[Landroid/net/NetworkInfo;', 1); a.data[0] = obj('Landroid/net/NetworkInfo;'); return a },
  }, { statics: { TYPE_MOBILE: 0, TYPE_WIFI: 1 } })
  def('Landroid/net/NetworkInfo;', OBJ, {
    'isConnected()Z': () => (navigator.onLine ? 1 : 0), 'isConnectedOrConnecting()Z': () => (navigator.onLine ? 1 : 0), 'isAvailable()Z': () => 1,
    'getType()I': () => 1, 'getTypeName()Ljava/lang/String;': () => 'WIFI', 'getSubtype()I': () => 0, 'getState()Landroid/net/NetworkInfo$State;': () => null,
  })
  def('Landroid/telephony/TelephonyManager;', OBJ, {
    'getDeviceId()Ljava/lang/String;': () => '000000000000000', 'getSubscriberId()Ljava/lang/String;': () => null, 'getLine1Number()Ljava/lang/String;': () => null,
    'getNetworkOperatorName()Ljava/lang/String;': () => 'VTE', 'getSimOperatorName()Ljava/lang/String;': () => 'VTE', 'getNetworkOperator()Ljava/lang/String;': () => '00101',
    'getSimCountryIso()Ljava/lang/String;': () => 'us', 'getNetworkCountryIso()Ljava/lang/String;': () => 'us', 'getPhoneType()I': () => 0, 'getNetworkType()I': () => 13, 'getSimState()I': () => 5,
  })
  def('Landroid/view/inputmethod/InputMethodManager;', OBJ, {
    'toggleSoftInput(II)V': noop, 'showSoftInput(Landroid/view/View;I)Z': () => 1,
    'hideSoftInputFromWindow(Landroid/os/IBinder;I)Z': () => 1, 'isActive()Z': () => 0,
  })
  def('Landroid/net/wifi/WifiManager;', OBJ, { 'isWifiEnabled()Z': () => 1, 'getConnectionInfo()Landroid/net/wifi/WifiInfo;': () => obj('Landroid/net/wifi/WifiInfo;') })
  def('Landroid/net/wifi/WifiInfo;', OBJ, { 'getMacAddress()Ljava/lang/String;': () => '02:00:00:00:00:00', 'getSSID()Ljava/lang/String;': () => 'DR-Nt', 'getRssi()I': () => -50 })
  def('Landroid/app/ActivityManager;', OBJ, {
    'getMemoryInfo(Landroid/app/ActivityManager$MemoryInfo;)V': (v, s, [m]) => Object.assign(m.f, { availMem: 512n << 20n, totalMem: 1n << 30n, threshold: 64n << 20n, lowMemory: 0 }),
    'getMemoryClass()I': () => 128, 'getLargeMemoryClass()I': () => 256, 'getRunningAppProcesses()Ljava/util/List;': () => list([]),
    'getDeviceConfigurationInfo()Landroid/content/pm/ConfigurationInfo;': () => obj('Landroid/content/pm/ConfigurationInfo;', { reqGlEsVersion: 0x20000 }),
  })
  def('Landroid/app/ActivityManager$MemoryInfo;', OBJ, { '<init>()V': noop })
  def('Landroid/content/pm/ConfigurationInfo;', OBJ, { 'getGlEsVersion()Ljava/lang/String;': () => '2.0' })
  def('Landroid/content/ContentResolver;', OBJ, { 'query(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;': () => null })

  // ---------- settings, environment, process ----------
  const androidId = (() => { const k = 'android_id'; let id = env.prefs.get('sp:__droid:' + k); if (!id) { id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join(''); env.prefs.set('sp:__droid:' + k, id); env.droid.prefs.set?.('sp:__droid:' + k, id)?.catch?.(() => {}) } return id })()
  def('Landroid/provider/Settings$Secure;', OBJ, {
    'getString(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;': (v, s, [, n]) => (n === 'android_id' ? androidId : null),
    'getInt(Landroid/content/ContentResolver;Ljava/lang/String;I)I': (v, s, [, , d]) => d,
  }, { statics: { ANDROID_ID: 'android_id' } })
  def('Landroid/provider/Settings$System;', OBJ, {
    'getInt(Landroid/content/ContentResolver;Ljava/lang/String;I)I': (v, s, [, n, d]) => (n === 'accelerometer_rotation' ? 1 : d),
    'getInt(Landroid/content/ContentResolver;Ljava/lang/String;)I': () => 0,
    'getString(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;': () => null,
  })
  def('Landroid/provider/Settings$Global;', OBJ, { 'getInt(Landroid/content/ContentResolver;Ljava/lang/String;I)I': (v, s, [, , d]) => d })
  def('Landroid/os/Environment;', OBJ, {
    'getExternalStorageState()Ljava/lang/String;': () => 'mounted',
    'getExternalStorageDirectory()Ljava/io/File;': () => { env.vfs?.mkdirs('/sdcard'); const f = obj('Ljava/io/File;', { path: '/sdcard' }); return f },
    'getDataDirectory()Ljava/io/File;': () => obj('Ljava/io/File;', { path: '/data' }),
    'getDownloadCacheDirectory()Ljava/io/File;': () => obj('Ljava/io/File;', { path: '/cache' }),
    'getExternalStoragePublicDirectory(Ljava/lang/String;)Ljava/io/File;': (v, s, [t]) => obj('Ljava/io/File;', { path: '/sdcard/' + t }),
    'isExternalStorageRemovable()Z': () => 0, 'isExternalStorageEmulated()Z': () => 1,
  }, { statics: { MEDIA_MOUNTED: 'mounted', MEDIA_MOUNTED_READ_ONLY: 'mounted_ro', DIRECTORY_DOWNLOADS: 'Download', DIRECTORY_PICTURES: 'Pictures' } })
  def('Landroid/os/Process;', OBJ, {
    'myPid()I': () => 4242, 'myTid()I': () => vm.current.id, 'myUid()I': () => 10050,
    'killProcess(I)V': () => { env.droid.app.finish() },
    'setThreadPriority(I)V': noop, 'setThreadPriority(II)V': noop, 'getThreadPriority(I)I': () => 0,
  }, { statics: { THREAD_PRIORITY_DEFAULT: 0, THREAD_PRIORITY_BACKGROUND: 10, THREAD_PRIORITY_DISPLAY: -4, THREAD_PRIORITY_URGENT_DISPLAY: -8, THREAD_PRIORITY_AUDIO: -16 } })
  def('Landroid/os/StatFs;', OBJ, { '<init>(Ljava/lang/String;)V': noop, 'getBlockSize()I': () => 4096, 'getAvailableBlocks()I': () => 262144, 'getBlockCount()I': () => 1048576, 'getAvailableBytes()J': () => 1n << 30n, 'getBlockSizeLong()J': () => 4096n, 'getAvailableBlocksLong()J': () => 262144n })

  // ---------- loopers and handler threads ----------
  // one looper per thread; the main looper is the event loop. a HandlerThread's looper runs its
  // queue on that green thread
  const mainLooper = obj('Landroid/os/Looper;', { main: true })
  const loopers = new Map<any, JObject>()
  def('Landroid/os/Looper;', OBJ, {
    'getMainLooper()Landroid/os/Looper;': () => mainLooper,
    'myLooper()Landroid/os/Looper;': () => (vm.current === vm.main ? mainLooper : loopers.get(vm.current) ?? null),
    'prepare()V': () => { if (!loopers.has(vm.current)) loopers.set(vm.current, obj('Landroid/os/Looper;', { queue: [], thread: vm.current })) },
    'loop()V': () => { const l = loopers.get(vm.current); if (l) loopForever(l) },
    'quit()V': (v, s) => { s.f.quit = true }, 'quitSafely()V': (v, s) => { s.f.quit = true },
    'getThread()Ljava/lang/Thread;': (v, s) => (s.f.main ? vm.callStatic('Ljava/lang/Thread;', 'currentThread()Ljava/lang/Thread;') : s.f.thread?.obj ?? null),
    'prepareMainLooper()V': noop,
  })
  const loopForever = (l: JObject) => {
    // runs posted messages on the looper's thread; waits (green) while the queue is empty
    const { Block } = threadsMod
    for (;;) {
      if (l.f.quit) return
      const q: { at: number; run: () => void }[] = l.f.queue
      const now = performance.now()
      const i = q.findIndex((m) => m.at <= now)
      if (i >= 0) { const [m] = q.splice(i, 1); m.run(); continue }
      const next = Math.min(...q.map((m) => m.at))
      throw new Block(() => l.f.quit || q.some((m) => m.at <= performance.now()), next, 'looper').then(() => loopForever(l))
    }
  }
  def('Landroid/os/HandlerThread;', 'Ljava/lang/Thread;', {
    '<init>(Ljava/lang/String;)V': (v, s, [n]) => { s.f.name = n },
    '<init>(Ljava/lang/String;I)V': (v, s, [n]) => { s.f.name = n },
    'run()V': (v, s) => { vm.callStatic('Landroid/os/Looper;', 'prepare()V'); s.f.looper = loopers.get(vm.current); vm.callVirtual(s, 'onLooperPrepared()V'); loopForever(s.f.looper) },
    'onLooperPrepared()V': noop,
    'getLooper()Landroid/os/Looper;': (v, s) => {
      if (s.f.looper) return s.f.looper
      // not started yet: make the looper now, the thread adopts it when it runs
      const l = obj('Landroid/os/Looper;', { queue: [] })
      s.f.looper = l
      return l
    },
    'quit()Z': (v, s) => { if (s.f.looper) s.f.looper.f.quit = true; return 1 },
  })
  // HandlerThread.run is js: start it as a thread whose body is the looper (Thread.start runs bytecode run()
  // only, so give it a tiny dex-free path)
  const threadStart = vm.shims.get('Ljava/lang/Thread;')!.methods!['start()V']
  def('Landroid/os/HandlerThread;', 'Ljava/lang/Thread;', {
    'start()V': (v, s, a) => {
      if (vm.findMethod(vm.classOf(s), 'run()V')?.code) return threadStart(v, s, a)
      const l = s.f.looper ?? (s.f.looper = obj('Landroid/os/Looper;', { queue: [] }))
      const t = new threadsMod.Task(vm, s.f.name ?? 'HandlerThread', () => { l.f.thread = vm.current; loopers.set(vm.current, l); vm.callVirtual(s, 'onLooperPrepared()V'); loopForever(l) })
      s.f.jt = t.thread
    },
  })
  // Handler: posts to its looper (main = the js event loop)
  const post = (hd: JObject, fn: () => void, delay: number) => {
    const l: JObject | null = hd.f.looper
    if (!l || l.f.main) { const t = setTimeout(fn, Math.max(0, delay)); return t }
    l.f.queue.push({ at: performance.now() + delay, run: fn })
    threadsMod.scheduler.wake()
    return 0
  }
  const runnable = (r: JObject) => () => { try { vm.callVirtual(r, 'run()V') } catch (e) { if (e instanceof JavaThrow) h.report(e); else throw e } }
  const message = (hd: JObject, m: JObject) => () => { try { if (m.f.callback) vm.callVirtual(m.f.callback, 'run()V'); else vm.callVirtual(hd, 'handleMessage(Landroid/os/Message;)V', [m]) } catch (e) { if (e instanceof JavaThrow) h.report(e); else throw e } }
  def('Landroid/os/Handler;', OBJ, {
    '<init>()V': (v, s) => { s.f.looper = vm.current === vm.main ? mainLooper : loopers.get(vm.current) ?? mainLooper },
    '<init>(Landroid/os/Looper;)V': (v, s, [l]) => { s.f.looper = l ?? mainLooper },
    '<init>(Landroid/os/Handler$Callback;)V': (v, s, [c]) => { s.f.looper = mainLooper; s.f.cb = c },
    '<init>(Landroid/os/Looper;Landroid/os/Handler$Callback;)V': (v, s, [l, c]) => { s.f.looper = l ?? mainLooper; s.f.cb = c },
    'post(Ljava/lang/Runnable;)Z': (v, s, [r]) => { post(s, runnable(r), 0); return 1 },
    'postDelayed(Ljava/lang/Runnable;J)Z': (v, s, [r, d]) => { (s.f.timers ||= new Map()).set(r, post(s, runnable(r), Number(d))); return 1 },
    'postAtTime(Ljava/lang/Runnable;J)Z': (v, s, [r, at]) => { post(s, runnable(r), Number(at) - performance.now()); return 1 },
    'postAtFrontOfQueue(Ljava/lang/Runnable;)Z': (v, s, [r]) => { post(s, runnable(r), 0); return 1 },
    'removeCallbacks(Ljava/lang/Runnable;)V': (v, s, [r]) => { const t = s.f.timers?.get(r); if (t) clearTimeout(t); const q = s.f.looper?.f.queue; if (q) s.f.looper.f.queue = q.filter((m: any) => m.r !== r) },
    'removeCallbacksAndMessages(Ljava/lang/Object;)V': (v, s) => { for (const t of s.f.timers?.values() || []) clearTimeout(t); if (s.f.looper?.f.queue) s.f.looper.f.queue.length = 0 },
    'removeMessages(I)V': noop,
    'hasMessages(I)Z': () => 0,
    'sendMessage(Landroid/os/Message;)Z': (v, s, [m]) => { post(s, message(s, m), 0); return 1 },
    'sendMessageDelayed(Landroid/os/Message;J)Z': (v, s, [m, d]) => { post(s, message(s, m), Number(d)); return 1 },
    'sendEmptyMessage(I)Z': (v, s, [w]) => { post(s, message(s, msg(s, w)), 0); return 1 },
    'sendEmptyMessageDelayed(IJ)Z': (v, s, [w, d]) => { post(s, message(s, msg(s, w)), Number(d)); return 1 },
    'obtainMessage()Landroid/os/Message;': (v, s) => msg(s, 0),
    'obtainMessage(I)Landroid/os/Message;': (v, s, [w]) => msg(s, w),
    'obtainMessage(ILjava/lang/Object;)Landroid/os/Message;': (v, s, [w, o]) => { const m = msg(s, w); m.f.obj = o; return m },
    'obtainMessage(III)Landroid/os/Message;': (v, s, [w, a1, a2]) => { const m = msg(s, w); m.f.arg1 = a1; m.f.arg2 = a2; return m },
    'obtainMessage(IIILjava/lang/Object;)Landroid/os/Message;': (v, s, [w, a1, a2, o]) => { const m = msg(s, w); m.f.arg1 = a1; m.f.arg2 = a2; m.f.obj = o; return m },
    'handleMessage(Landroid/os/Message;)V': (v, s, [m]) => { if (s.f.cb) vm.callVirtual(s.f.cb, 'handleMessage(Landroid/os/Message;)Z', [m]) },
    'getLooper()Landroid/os/Looper;': (v, s) => s.f.looper,
  })
  const msg = (hd: JObject, what: number) => obj('Landroid/os/Message;', { what, arg1: 0, arg2: 0, obj: null, target: hd })
  def('Landroid/os/Message;', OBJ, {
    '<init>()V': (v, s) => Object.assign(s.f, { what: 0, arg1: 0, arg2: 0, obj: null }),
    'obtain()Landroid/os/Message;': () => obj('Landroid/os/Message;', { what: 0, arg1: 0, arg2: 0, obj: null }),
    'obtain(Landroid/os/Handler;I)Landroid/os/Message;': (v, s, [hd, w]) => msg(hd, w),
    'obtain(Landroid/os/Handler;ILjava/lang/Object;)Landroid/os/Message;': (v, s, [hd, w, o]) => { const m = msg(hd, w); m.f.obj = o; return m },
    'sendToTarget()V': (v, s) => { if (s.f.target) post(s.f.target, message(s.f.target, s), 0) },
    'recycle()V': noop,
    'getData()Landroid/os/Bundle;': (v, s) => (s.f.data ||= obj('Landroid/os/Bundle;', { map: {} })),
    'setData(Landroid/os/Bundle;)V': (v, s, [b]) => { s.f.data = b },
  })

  // ---------- dialogs ----------
  def('Landroid/app/AlertDialog$Builder;', OBJ, {
    '<init>(Landroid/content/Context;)V': (v, s) => { s.f.d = {} },
    '<init>(Landroid/content/Context;I)V': (v, s) => { s.f.d = {} },
    'setTitle(Ljava/lang/CharSequence;)Landroid/app/AlertDialog$Builder;': (v, s, [t]) => { s.f.d.title = jstr(vm, t); return s },
    'setMessage(Ljava/lang/CharSequence;)Landroid/app/AlertDialog$Builder;': (v, s, [t]) => { s.f.d.message = jstr(vm, t); return s },
    'setPositiveButton(Ljava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [t, l]) => { s.f.d.ok = jstr(vm, t); s.f.okL = l; return s },
    'setNegativeButton(Ljava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [t, l]) => { s.f.d.cancel = jstr(vm, t); s.f.noL = l; return s },
    'setCancelable(Z)Landroid/app/AlertDialog$Builder;': (v, s) => s,
    'setIcon(I)Landroid/app/AlertDialog$Builder;': (v, s) => s,
    'create()Landroid/app/AlertDialog;': (v, s) => obj('Landroid/app/AlertDialog;', { b: s }),
    'show()Landroid/app/AlertDialog;': (v, s) => { const d = obj('Landroid/app/AlertDialog;', { b: s }); showDialog(d); return d },
  })
  const showDialog = (d: JObject) => {
    const b = d.f.b
    env.droid.dialog({ ...b.f.d, ok: b.f.d.ok || 'OK' }).then((r: any) => {
      const l = r?.button === 'ok' ? b.f.okL : r?.button === 'cancel' ? b.f.noL : null
      if (l) try { vm.callVirtual(l, 'onClick(Landroid/content/DialogInterface;I)V', [d, r.button === 'ok' ? -1 : -2]) } catch (e) { h.report(e) }
    }).catch(() => {})
  }
  def('Landroid/app/Dialog;', OBJ, { 'show()V': noop, 'dismiss()V': noop, 'cancel()V': noop, 'setCancelable(Z)V': noop, 'isShowing()Z': () => 0, 'setOnCancelListener(Landroid/content/DialogInterface$OnCancelListener;)V': noop })
  def('Landroid/app/AlertDialog;', 'Landroid/app/Dialog;', { 'show()V': (v, s) => showDialog(s), 'setCancelable(Z)V': noop })

  // ---------- xml pull parser (small, enough for config files like unity's settings.xml) ----------
  def('Lorg/xmlpull/v1/XmlPullParserFactory;', OBJ, {
    'newInstance()Lorg/xmlpull/v1/XmlPullParserFactory;': () => obj('Lorg/xmlpull/v1/XmlPullParserFactory;'),
    'setNamespaceAware(Z)V': noop, 'setValidating(Z)V': noop,
    'newPullParser()Lorg/xmlpull/v1/XmlPullParser;': () => obj('Lorg/xmlpull/v1/XmlPullParser;'),
  })
  def('Landroid/util/Xml;', OBJ, { 'newPullParser()Lorg/xmlpull/v1/XmlPullParser;': () => obj('Lorg/xmlpull/v1/XmlPullParser;') })
  type Ev = { type: number; name?: string; text?: string; attrs?: [string, string][]; depth: number }
  const tokenize = (xml: string): Ev[] => {
    const out: Ev[] = [{ type: 0, depth: 0 }]
    let depth = 0
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
    const unesc = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&')
    for (let m; (m = re.exec(xml));) {
      if (m[1] != null) out.push({ type: 4, text: m[1], depth })
      else if (m[2]) { out.push({ type: 3, name: m[2], depth }); depth-- }
      else if (m[3]) {
        const attrs: [string, string][] = []
        for (const a of (m[4] || '').matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs.push([a[1], unesc(a[3] ?? a[4] ?? '')])
        depth++
        out.push({ type: 2, name: m[3], attrs, depth })
        if (m[5]) { out.push({ type: 3, name: m[3], depth }); depth-- }
      } else if (m[6] != null && !m[0].startsWith('<')) out.push({ type: 4, text: unesc(m[6]), depth })
    }
    out.push({ type: 1, depth: 0 })
    return out
  }
  const cur = (s: JObject): Ev => s.f.evs?.[s.f.i] ?? { type: 0, depth: 0 }
  def('Lorg/xmlpull/v1/XmlPullParser;', OBJ, {
    'setInput(Ljava/io/InputStream;Ljava/lang/String;)V': (v, s, [i]) => { const b: Uint8Array = i?.f.buf ?? new Uint8Array(); s.f.evs = tokenize(new TextDecoder().decode(b.subarray(i?.f.pos ?? 0)).replace(/^﻿/, '')); s.f.i = 0 },
    'setInput(Ljava/io/Reader;)V': (v, s, [r]) => { s.f.evs = tokenize(String(r?.f.text ?? '').slice(r?.f.pos ?? 0)); s.f.i = 0 },
    'setFeature(Ljava/lang/String;Z)V': noop,
    'getEventType()I': (v, s) => cur(s).type,
    'next()I': (v, s) => { if (s.f.i < s.f.evs.length - 1) s.f.i++; return cur(s).type },
    'nextToken()I': (v, s) => { if (s.f.i < s.f.evs.length - 1) s.f.i++; return cur(s).type },
    'nextTag()I': (v, s) => { do { s.f.i++ } while (s.f.i < s.f.evs.length - 1 && cur(s).type === 4 && !cur(s).text!.trim()); return cur(s).type },
    'nextText()Ljava/lang/String;': (v, s) => { let t = ''; if (s.f.evs[s.f.i + 1]?.type === 4) { s.f.i++; t = cur(s).text! } if (s.f.evs[s.f.i + 1]?.type === 3) s.f.i++; return t },
    'getName()Ljava/lang/String;': (v, s) => cur(s).name ?? null,
    'getText()Ljava/lang/String;': (v, s) => cur(s).text ?? null,
    'getDepth()I': (v, s) => cur(s).depth,
    'getAttributeCount()I': (v, s) => cur(s).attrs?.length ?? -1,
    'getAttributeName(I)Ljava/lang/String;': (v, s, [i]) => cur(s).attrs?.[i]?.[0] ?? null,
    'getAttributeValue(I)Ljava/lang/String;': (v, s, [i]) => cur(s).attrs?.[i]?.[1] ?? null,
    'getAttributeValue(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [, n]) => cur(s).attrs?.find((a) => a[0] === n)?.[1] ?? null,
    'isWhitespace()Z': (v, s) => (!cur(s).text?.trim() ? 1 : 0),
    'getNamespace()Ljava/lang/String;': () => '', 'getPrefix()Ljava/lang/String;': () => null,
    'require(ILjava/lang/String;Ljava/lang/String;)V': noop,
  }, { statics: { START_DOCUMENT: 0, END_DOCUMENT: 1, START_TAG: 2, END_TAG: 3, TEXT: 4, CDSECT: 5, ENTITY_REF: 6, IGNORABLE_WHITESPACE: 7, PROCESSING_INSTRUCTION: 8, COMMENT: 9, DOCDECL: 10 } })

  // ---------- java.lang extras unity uses ----------
  const strShim = vm.shims.get('Ljava/lang/String;')!
  const S = (fn: (s: string, a: any[]) => any): NativeFn => (v, s, a) => fn(s as string, a)
  const fromBytes = (a: JArray, off = 0, n = a.data.length) => new TextDecoder().decode(new Uint8Array((a.data as Int8Array).buffer, (a.data as Int8Array).byteOffset + off, n))
  const toBytes = (s: string) => { const b = new TextEncoder().encode(s); const a = vm.newArray('[B', b.length); (a.data as Int8Array).set(new Int8Array(b.buffer)); return a }
  vm.shim('Ljava/lang/String;', { ...strShim, methods: { ...strShim.methods,
    // strings are js strings: the "constructors" return the new string (the interpreter keeps the value)
    '<init>([B)V': (v, s, [a]) => fromBytes(a),
    '<init>([BLjava/lang/String;)V': (v, s, [a]) => fromBytes(a),
    '<init>([BII)V': (v, s, [a, o, n]) => fromBytes(a, o, n),
    '<init>([BIILjava/lang/String;)V': (v, s, [a, o, n]) => fromBytes(a, o, n),
    '<init>(Ljava/lang/String;)V': (v, s, [x]) => x,
    '<init>([C)V': (v, s, [a]) => String.fromCharCode(...a.data),
    '<init>([CII)V': (v, s, [a, o, n]) => String.fromCharCode(...Array.prototype.slice.call(a.data, o, o + n)),
    'getBytes()[B': S((s) => toBytes(s)),
    'getBytes(Ljava/lang/String;)[B': S((s) => toBytes(s)),
    'indexOf(II)I': S((s, [c, from]) => s.indexOf(String.fromCharCode(c), from)),
    'compareToIgnoreCase(Ljava/lang/String;)I': S((s, [o]) => { const a = s.toLowerCase(), b = String(o).toLowerCase(); return a < b ? -1 : a > b ? 1 : 0 }),
  } })
  def('Ljava/lang/System;', OBJ, {
    'setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [k, x]) => { const old = props.get(k) ?? null; props.set(k, x); return old },
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => props.get(k) ?? ({ 'line.separator': '\n', 'java.vm.version': '1.6.0', 'os.arch': 'armv7l', 'os.name': 'Linux', 'http.agent': 'Dalvik/1.6.0 (Linux; U; Android 4.4; Droid)', 'file.separator': '/', 'path.separator': ':', 'user.dir': '/', 'java.io.tmpdir': '/data/local/tmp' } as any)[k] ?? null,
    'getProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [k, d]) => props.get(k) ?? d,
    'getenv(Ljava/lang/String;)Ljava/lang/String;': () => null,
  })
  const props = new Map<string, string>()
  def('Ljava/lang/AssertionError;', 'Ljava/lang/Error;', { '<init>()V': noop, '<init>(Ljava/lang/Object;)V': (v, s, [m]) => { s.f.message = jstr(vm, m) } })
  def('Ljava/lang/Double;', 'Ljava/lang/Number;', { 'isInfinite(D)Z': (v, s, [x]) => (x === Infinity || x === -Infinity ? 1 : 0) })
  def('Ljava/lang/Class;', OBJ, { 'asSubclass(Ljava/lang/Class;)Ljava/lang/Class;': (v, s) => s })
  // java.util.Locale: language / country / variant; the default is the device's
  const NAMES: Record<string, string> = { en: 'English', ru: 'русский', de: 'Deutsch', fr: 'français', es: 'español', it: 'italiano', ja: '日本語', ko: '한국어', zh: '中文', pt: 'português', uk: 'українська', pl: 'polski', tr: 'Türkçe', nl: 'Nederlands' }
  const locale = (lang: string, country = '', variant = '') => obj('Ljava/util/Locale;', { lang: lang.toLowerCase(), country: country.toUpperCase(), variant })
  const deviceCountry = (() => { const m = /-([A-Za-z]{2})$/.exec((globalThis as any).navigator?.language || ''); return m ? m[1].toUpperCase() : env.lang === 'en' ? 'US' : '' })()
  let defaultLocale: JObject | null = null
  const localeStr = (s: JObject) => [s.f.lang, s.f.country, s.f.variant].filter((x, i) => x || i === 0).join('_').replace(/_+$/, '')
  def('Ljava/util/Locale;', OBJ, {
    '<init>(Ljava/lang/String;)V': (v, s, [l]) => { Object.assign(s.f, { lang: String(l).toLowerCase(), country: '', variant: '' }) },
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [l, c]) => { Object.assign(s.f, { lang: String(l).toLowerCase(), country: String(c).toUpperCase(), variant: '' }) },
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (v, s, [l, c, x]) => { Object.assign(s.f, { lang: String(l).toLowerCase(), country: String(c).toUpperCase(), variant: String(x) }) },
    'getDefault()Ljava/util/Locale;': () => (defaultLocale ??= locale(env.lang || 'en', deviceCountry)),
    'setDefault(Ljava/util/Locale;)V': (v, s, [l]) => { defaultLocale = l },
    'getLanguage()Ljava/lang/String;': (v, s) => s.f.lang, 'getCountry()Ljava/lang/String;': (v, s) => s.f.country, 'getVariant()Ljava/lang/String;': (v, s) => s.f.variant,
    'getISO3Language()Ljava/lang/String;': (v, s) => ({ en: 'eng', ru: 'rus', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', ja: 'jpn', zh: 'zho', pt: 'por', uk: 'ukr' } as Record<string, string>)[s.f.lang] ?? s.f.lang,
    'getISO3Country()Ljava/lang/String;': (v, s) => ({ US: 'USA', GB: 'GBR', RU: 'RUS', DE: 'DEU', FR: 'FRA', UA: 'UKR' } as Record<string, string>)[s.f.country] ?? s.f.country,
    'getDisplayLanguage()Ljava/lang/String;': (v, s) => NAMES[s.f.lang] ?? s.f.lang,
    'getDisplayLanguage(Ljava/util/Locale;)Ljava/lang/String;': (v, s) => NAMES[s.f.lang] ?? s.f.lang,
    'getDisplayCountry()Ljava/lang/String;': (v, s) => s.f.country, 'getDisplayName()Ljava/lang/String;': (v, s) => NAMES[s.f.lang] ?? localeStr(s),
    'toString()Ljava/lang/String;': (v, s) => localeStr(s),
    'toLanguageTag()Ljava/lang/String;': (v, s) => [s.f.lang, s.f.country].filter(Boolean).join('-'),
    'hashCode()I': (v, s) => [...localeStr(s)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o instanceof JObject && o.f.lang === s.f.lang && o.f.country === s.f.country && o.f.variant === s.f.variant ? 1 : 0),
    'getAvailableLocales()[Ljava/util/Locale;': () => { const a = vm.newArray('[Ljava/util/Locale;', 2); a.data[0] = locale('en', 'US'); a.data[1] = locale(env.lang || 'en', deviceCountry); return a },
  })
  const lc = vm.cls('Ljava/util/Locale;')
  Object.assign(lc.staticValues, { ENGLISH: locale('en'), US: locale('en', 'US'), UK: locale('en', 'GB'), ROOT: locale(''), GERMAN: locale('de'), GERMANY: locale('de', 'DE'), FRENCH: locale('fr'), FRANCE: locale('fr', 'FR'), ITALIAN: locale('it'), JAPANESE: locale('ja'), JAPAN: locale('ja', 'JP'), KOREAN: locale('ko'), CHINESE: locale('zh'), CHINA: locale('zh', 'CN'), CANADA: locale('en', 'CA') })

  // java.util.UUID: two 64-bit halves
  const uuid = (hi: bigint, lo: bigint) => obj('Ljava/util/UUID;', { hi: BigInt.asIntN(64, hi), lo: BigInt.asIntN(64, lo) })
  const u64 = (b: Uint8Array, o: number) => Array.from(b.slice(o, o + 8)).reduce((x: bigint, y: number) => (x << 8n) | BigInt(y), 0n)
  const uuidStr = (s: JObject) => { const h = (BigInt.asUintN(64, s.f.hi).toString(16).padStart(16, '0') + BigInt.asUintN(64, s.f.lo).toString(16).padStart(16, '0')); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` }
  def('Ljava/util/UUID;', OBJ, {
    '<init>(JJ)V': (v, s, [hi, lo]) => { s.f.hi = BigInt.asIntN(64, hi); s.f.lo = BigInt.asIntN(64, lo) },
    'randomUUID()Ljava/util/UUID;': () => {
      const b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80 // version 4, ietf variant
      return uuid(u64(b, 0), u64(b, 8))
    },
    'nameUUIDFromBytes([B)Ljava/util/UUID;': (v, s, [arr]) => {
      // version 3 wants md5; a sha-256 based stand-in keeps names stable on this device
      const src = new Uint8Array(arr.data.buffer, arr.data.byteOffset, arr.data.length)
      let h1 = 0x811c9dc5n, h2 = 0xcbf29ce484222325n
      for (const x of src) { h1 = BigInt.asUintN(64, (h1 ^ BigInt(x)) * 0x100000001b3n); h2 = BigInt.asUintN(64, (h2 ^ BigInt(x)) * 0x100000001b3n + 7n) }
      const hi = (h1 & ~0xf000n) | 0x3000n, lo = (h2 & 0x3fffffffffffffffn) | 0x8000000000000000n
      return uuid(hi, lo)
    },
    'fromString(Ljava/lang/String;)Ljava/util/UUID;': (v, s, [str]) => {
      const h = String(str).replace(/-/g, '')
      if (!/^[0-9a-fA-F]{32}$/.test(h)) throw vm.error('Ljava/lang/IllegalArgumentException;', 'Invalid UUID string: ' + str)
      return uuid(BigInt('0x' + h.slice(0, 16)), BigInt('0x' + h.slice(16)))
    },
    'toString()Ljava/lang/String;': (v, s) => uuidStr(s),
    'getMostSignificantBits()J': (v, s) => s.f.hi, 'getLeastSignificantBits()J': (v, s) => s.f.lo,
    'version()I': (v, s) => Number((BigInt.asUintN(64, s.f.hi) >> 12n) & 0xfn),
    'hashCode()I': (v, s) => { const x = BigInt.asUintN(64, BigInt(s.f.hi) ^ BigInt(s.f.lo)); return Number(BigInt.asIntN(32, (x >> 32n) ^ x)) },
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o instanceof JObject && o.f.hi === s.f.hi && o.f.lo === s.f.lo ? 1 : 0),
    'compareTo(Ljava/util/UUID;)I': (v, s, [o]) => (s.f.hi !== o.f.hi ? (s.f.hi < o.f.hi ? -1 : 1) : s.f.lo !== o.f.lo ? (s.f.lo < o.f.lo ? -1 : 1) : 0),
  })

  // shared preferences extras
  const sp = h.prefsFor('__probe')
  void sp
  void box
  installTouch()
}

// ---------- tiny sync inflate (raw deflate) for compressed assets ----------
import { inflateRawSync } from './inflate.ts'
const inflateSync = (b: Uint8Array, size: number) => inflateRawSync(b, size)
// the threads module is imported lazily-free: plain import
import * as threadsReal from './threads.ts'
import { JThread } from './dalvik.ts'
// a green thread whose body is js (HandlerThread loopers)
class JsTask {
  thread: JThread
  constructor(vm: VM, name: string, body: () => void) {
    const t = new JThread(vm, name)
    this.thread = t
    let started = false
    t.step = () => {
      const prev = vm.current
      vm.current = t
      t.busy = true
      try {
        if (t.block) { const b = t.block; t.block = null; b.finish() }
        else if (!started) { started = true; body() }
        t.state = 'done'
      } catch (e) {
        if (e instanceof threadsReal.Block) { t.block = e; t.state = 'blocked' }
        else { t.state = 'done'; console.warn(`thread "${name}" died`, e instanceof JavaThrow ? e.obj.f.message : e) }
      } finally { t.busy = false; vm.current = prev }
    }
    threadsReal.scheduler.add(t)
  }
}
const threadsMod = { Block: threadsReal.Block, scheduler: threadsReal.scheduler, Task: JsTask }
export { inflateRawSync }
