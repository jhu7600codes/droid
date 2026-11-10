// framework shim, part 2: the android classes a simple old app uses, mapped onto droid and holo dom.
// (versioned as droid-framework@0.1 in converted manifests)
import { VM, JObject, JArray, JavaThrow, splitParams, type NativeFn } from './dalvik.ts'
import { Block } from './threads.ts'
import { registerMore } from './android-more.ts'
import { registerWidgets } from './widgets.ts'
import { registerHttp } from './net.ts'
import { registerGlJava } from './gl-java.ts'
import { registerAudio, registerNet } from './audio.ts'
import { jstr, jformat, box } from './java.ts'
import { parseAxml, attr, attrString, T, type XmlNode, type XmlValue } from './axml.ts'
import { resolve, entryName, themeWindow, type ResTable } from './arsc.ts'

export const SHIM_VERSION = 'droid-framework@0.1'
const OBJ = 'Ljava/lang/Object;'

export interface Env {
  vfs?: import('./javaio.ts').Vfs // in-memory file system shared with native code
  pkg: string
  files: Map<string, Uint8Array>
  res: ResTable
  root: HTMLElement
  droid: any
  prefs: Map<string, any> // preloaded droid.prefs, so SharedPreferences can stay synchronous
  density: number
  landscape: boolean
  lang: string
  intent: { action?: string; extras?: Record<string, any> }
  activityFor(className: string): string | null // java class -> droid activity name
  self: string // droid activity name of this page
}

// dimension and color decoding (android TypedValue)
const RADIX = [1, 1 / 128, 1 / 32768, 1 / 8388608]
export function dimen(v: XmlValue | undefined, fallback = 0): number {
  if (!v) return fallback
  if (v.type !== T.DIMENSION) return v.type === T.INT_DEC ? v.data | 0 : fallback
  const value = (v.data >> 8) * RADIX[(v.data >> 4) & 3]
  const unit = v.data & 0xf
  // 1 css px = 1 dp in droid: px values are divided by the density
  return unit === 0 ? value / 1.5 : unit === 3 ? value * 1.333 : value
}
export const cssColor = (argb: number) => `rgba(${(argb >> 16) & 255},${(argb >> 8) & 255},${argb & 255},${((argb >>> 24) / 255).toFixed(3)})`

export function registerAndroid(vm: VM, env: Env) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => vm.shim(name, { super: sup, methods, ...extra })
  const want = () => ({ density: env.density, landscape: env.landscape, lang: env.lang })
  const res = (id: number) => resolve(env.res, id, want())
  const resString = (id: number): string => {
    const v = res(id)
    if (!v) throw vm.error('Landroid/content/res/Resources$NotFoundException;', `String resource ID #0x${(id >>> 0).toString(16)}`)
    return v.type === T.STRING ? v.str! : String(v.data)
  }
  const valueText = (v: XmlValue | undefined): string | undefined => {
    if (!v) return undefined
    if (v.type === T.STRING) return v.str
    if (v.type === T.REFERENCE) { const r = res(v.data); return r?.type === T.STRING ? r.str : r ? String(r.data) : undefined }
    return v.raw ?? undefined
  }
  const valueColor = (v: XmlValue | undefined): string | undefined => {
    if (!v) return undefined
    const r = v.type === T.REFERENCE ? res(v.data) : v
    if (!r) return undefined
    if (r.type >= T.COLOR_ARGB8 && r.type <= T.COLOR_RGB4) return cssColor(r.data)
    return undefined
  }
  const fileUrl = new Map<string, string>()
  const drawableUrl = (id: number) => {
    const v = res(id)
    if (v?.type === T.STRING && env.files.has(v.str!)) {
      const p = v.str!
      if (!fileUrl.has(p)) fileUrl.set(p, URL.createObjectURL(new Blob([env.files.get(p)! as BlobPart], { type: p.endsWith('.png') ? 'image/png' : p.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream' })))
      return fileUrl.get(p)!
    }
    return ''
  }

  // ---------- views ----------
  const views = new Map<number, JObject>() // id -> view, for findViewById
  const el = (v: JObject) => v.f.el as HTMLElement
  const newView = (cls: string, tag: string, className = '') => {
    const v = new JObject(vm.cls(cls))
    const e = document.createElement(tag)
    if (className) e.className = className
    v.f.el = e
    ;(e as any).__view = v
    return v
  }
  const click = (v: JObject) => {
    if (!v.f.onClick) return
    try { vm.callVirtual(v.f.onClick, 'onClick(Landroid/view/View;)V', [v]) } catch (e) { report(e) }
  }
  // this app's window without the status bar (FLAG_FULLSCREEN, fullscreen themes)
  const statusBar = (visible: boolean) => { env.droid.system.statusbar?.(visible)?.catch?.(() => {}) }
  // a theme's window look: no title bar, no status bar
  const applyTheme = (id: number) => {
    if (!id) return
    const w = themeWindow(env.res, id)
    if (w.noTitle) env.droid.actionbar.hide()
    if (w.fullscreen) statusBar(false)
  }
  const manifestTheme = (cls: string) => {
    const x = (env as any).manifestXml as XmlNode | null
    const app = x?.children.find((c) => c.tag === 'application')
    const theme = (n?: XmlNode) => (n?.attrs.find((a) => a.resId === 0x01010000)?.value.data ?? 0) >>> 0
    const full = (n: string) => (n.startsWith('.') ? env.pkg + n : n.includes('.') ? n : env.pkg + '.' + n)
    const act = app?.children.find((c) => c.tag === 'activity' && 'L' + full(String(c.attrs.find((a) => a.resId === 0x01010003)?.value.str ?? '')).replace(/\./g, '/') + ';' === cls)
    return theme(act) || theme(app)
  }
  const report = (e: unknown) => {
    const msg = e instanceof JavaThrow ? jstr(vm, e.obj) : String((e as Error)?.message || e)
    console.error('android app crashed:', msg)
    if (e instanceof JavaThrow && e.obj?.f?.jstack?.length) console.error('java stack:', e.obj.f.jstack.join(' < '))
    // runtime errors (not java exceptions): where it happened, in js and in native code
    if (!(e instanceof JavaThrow)) {
      if ((e as Error)?.stack) console.error('stack:', (e as Error).stack!.split('\n').slice(0, 8).join(' | '))
      const nat = (vm as any).nativeAsync
      if (nat?.where) { const f = nat.fault || { pc: nat.cpu.r[15], lr: nat.cpu.r[14] }; console.error(`native: pc ${nat.where(f.pc)} lr ${nat.where(f.lr)}`) }
    }
    env.droid.dialog({ title: 'Unfortunately, the app has stopped.', message: msg, ok: 'OK' })
  }

  const viewMethods: Record<string, NativeFn> = {
    'setOnClickListener(Landroid/view/View$OnClickListener;)V': (v, s, [l]) => {
      s.f.onClick = l
      if (!s.f.clickBound) { s.f.clickBound = true; el(s).addEventListener('click', () => { if (!el(s).classList.contains('disabled')) click(s) }) }
    },
    'setOnLongClickListener(Landroid/view/View$OnLongClickListener;)V': (v, s, [l]) => { el(s).addEventListener('contextmenu', (e) => { e.preventDefault(); vm.callVirtual(l, 'onLongClick(Landroid/view/View;)Z', [s]) }) },
    'setVisibility(I)V': (v, s, [x]) => { s.f.visibility = x; el(s).style.display = x === 8 ? 'none' : ''; el(s).style.visibility = x === 4 ? 'hidden' : '' },
    'getVisibility()I': (v, s) => s.f.visibility ?? 0,
    'setEnabled(Z)V': (v, s, [x]) => { el(s).classList.toggle('disabled', !x); if ('disabled' in el(s)) (el(s) as any).disabled = !x },
    'isEnabled()Z': (v, s) => (el(s).classList.contains('disabled') ? 0 : 1),
    'getId()I': (v, s) => s.f.id ?? -1,
    'setId(I)V': (v, s, [id]) => { s.f.id = id; views.set(id, s) },
    'setTag(Ljava/lang/Object;)V': (v, s, [t]) => { s.f.tag = t },
    'getTag()Ljava/lang/Object;': (v, s) => s.f.tag ?? null,
    'findViewById(I)Landroid/view/View;': (v, s, [id]) => views.get(id) ?? null,
    'setBackgroundColor(I)V': (v, s, [c]) => { el(s).style.background = cssColor(c) },
    'setPadding(IIII)V': (v, s, [l, t, r, b]) => { el(s).style.padding = `${t / env.density}px ${r / env.density}px ${b / env.density}px ${l / env.density}px` },
    'getContext()Landroid/content/Context;': () => activityObj,
    'invalidate()V': () => {}, 'requestLayout()V': () => {}, 'requestFocus()Z': (v, s) => { el(s).focus?.(); return 1 },
    'post(Ljava/lang/Runnable;)Z': (v, s, [r]) => { setTimeout(() => runSafe(r), 0); return 1 },
    'postDelayed(Ljava/lang/Runnable;J)Z': (v, s, [r, ms]) => { setTimeout(() => runSafe(r), Number(ms)); return 1 },
    'getWidth()I': (v, s) => Math.round(el(s).clientWidth * env.density),
    'getHeight()I': (v, s) => Math.round(el(s).clientHeight * env.density),
  }
  const runSafe = (r: any) => { try { vm.callVirtual(r, 'run()V') } catch (e) { report(e) } }
  def('Landroid/view/View;', OBJ, viewMethods)
  def('Landroid/view/View$OnClickListener;', OBJ, {})
  def('Landroid/view/View$OnLongClickListener;', OBJ, {})
  def('Landroid/view/ViewGroup;', 'Landroid/view/View;', {
    'addView(Landroid/view/View;)V': (v, s, [c]) => el(s).append(el(c)),
    'removeAllViews()V': (v, s) => { el(s).innerHTML = '' },
    'getChildCount()I': (v, s) => el(s).children.length,
    'getChildAt(I)Landroid/view/View;': (v, s, [i]) => (el(s).children[i] as any)?.__view ?? null,
  })
  def('Landroid/widget/LinearLayout;', 'Landroid/view/ViewGroup;', { 'setOrientation(I)V': (v, s, [o]) => { el(s).style.flexDirection = o === 1 ? 'column' : 'row' } })
  def('Landroid/widget/FrameLayout;', 'Landroid/view/ViewGroup;', {})
  def('Landroid/widget/RelativeLayout;', 'Landroid/view/ViewGroup;', {})
  def('Landroid/widget/ScrollView;', 'Landroid/widget/FrameLayout;', {})
  const textOf = (v: any) => (v == null ? '' : jstr(vm, v))
  def('Landroid/widget/TextView;', 'Landroid/view/View;', {
    'setText(Ljava/lang/CharSequence;)V': (v, s, [t]) => setText(s, textOf(t)),
    'setText(I)V': (v, s, [id]) => setText(s, resString(id)),
    'getText()Ljava/lang/CharSequence;': (v, s) => getText(s),
    'append(Ljava/lang/CharSequence;)V': (v, s, [t]) => setText(s, getText(s) + textOf(t)),
    'setTextColor(I)V': (v, s, [c]) => { el(s).style.color = cssColor(c) },
    'setTextSize(F)V': (v, s, [x]) => { el(s).style.fontSize = x + 'px' },
    'setHint(Ljava/lang/CharSequence;)V': (v, s, [t]) => { (el(s) as HTMLInputElement).placeholder = textOf(t) },
    'setGravity(I)V': (v, s, [g]) => applyGravity(el(s), g),
    'setTypeface(Landroid/graphics/Typeface;)V': () => {},
    'setSingleLine()V': () => {},
  })
  const textTarget = (s: JObject) => (s.f.label as HTMLElement) || el(s)
  const setText = (s: JObject, t: string) => { const e = textTarget(s); if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) e.value = t; else e.textContent = t }
  const getText = (s: JObject) => { const e = textTarget(s); return e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value : e.textContent || '' }
  def('Landroid/widget/Button;', 'Landroid/widget/TextView;', {})
  def('Landroid/widget/EditText;', 'Landroid/widget/TextView;', {
    'getText()Landroid/text/Editable;': (v, s) => getText(s),
    'setSelection(I)V': () => {},
  })
  def('Landroid/text/Editable;', OBJ, {}, { interfaces: ['Ljava/lang/CharSequence;'] })
  def('Landroid/widget/CompoundButton;', 'Landroid/widget/Button;', {
    'isChecked()Z': (v, s) => (s.f.input.checked ? 1 : 0),
    'setChecked(Z)V': (v, s, [x]) => { s.f.input.checked = !!x },
    'toggle()V': (v, s) => { s.f.input.checked = !s.f.input.checked },
    'setOnCheckedChangeListener(Landroid/widget/CompoundButton$OnCheckedChangeListener;)V': (v, s, [l]) => {
      s.f.input.addEventListener('change', () => { try { vm.callVirtual(l, 'onCheckedChanged(Landroid/widget/CompoundButton;Z)V', [s, s.f.input.checked ? 1 : 0]) } catch (e) { report(e) } })
    },
  })
  def('Landroid/widget/CheckBox;', 'Landroid/widget/CompoundButton;', {})
  def('Landroid/widget/RadioButton;', 'Landroid/widget/CompoundButton;', {})
  def('Landroid/widget/Switch;', 'Landroid/widget/CompoundButton;', {})
  def('Landroid/widget/ToggleButton;', 'Landroid/widget/CompoundButton;', {})
  def('Landroid/widget/ImageView;', 'Landroid/view/View;', {
    'setImageResource(I)V': (v, s, [id]) => { (el(s) as HTMLImageElement).src = drawableUrl(id) },
  })
  def('Landroid/widget/ImageButton;', 'Landroid/widget/ImageView;', {})
  def('Landroid/widget/ProgressBar;', 'Landroid/view/View;', {
    'setProgress(I)V': (v, s, [p]) => { s.f.progress = p; const bar = el(s).querySelector<HTMLElement>('.bar'); if (bar) bar.style.width = (p / (s.f.max || 100)) * 100 + '%' },
    'setMax(I)V': (v, s, [m]) => { s.f.max = m },
    'getProgress()I': (v, s) => s.f.progress || 0,
  })

  // lists: ArrayAdapter, or the app's own BaseAdapter subclass
  def('Landroid/widget/AdapterView;', 'Landroid/view/ViewGroup;', {
    'setOnItemClickListener(Landroid/widget/AdapterView$OnItemClickListener;)V': (v, s, [l]) => { s.f.itemClick = l },
  })
  def('Landroid/widget/ListView;', 'Landroid/widget/AdapterView;', {
    'setAdapter(Landroid/widget/ListAdapter;)V': (v, s, [a]) => { s.f.adapter = a; a.f.lists = [...(a.f.lists || []), s]; renderList(s) },
    'getAdapter()Landroid/widget/ListAdapter;': (v, s) => s.f.adapter ?? null,
  })
  def('Landroid/widget/GridView;', 'Landroid/widget/ListView;', {})
  const renderList = (list: JObject) => {
    const a = list.f.adapter
    const ul = el(list)
    ul.innerHTML = ''
    if (!a) return
    try {
      const n = vm.callVirtual(a, 'getCount()I') as number
      for (let i = 0; i < n; i++) {
        const child = vm.callVirtual(a, 'getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;', [i, null, list]) as JObject
        const li = document.createElement('li')
        li.className = 'h-item small'
        li.append(el(child))
        li.addEventListener('pointerdown', () => li.classList.add('pressed'))
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) li.addEventListener(ev, () => li.classList.remove('pressed'))
        li.addEventListener('click', () => {
          if (list.f.itemClick) try { vm.callVirtual(list.f.itemClick, 'onItemClick(Landroid/widget/AdapterView;Landroid/view/View;IJ)V', [list, child, i, BigInt(i)]) } catch (e) { report(e) }
        })
        ul.append(li)
        const d = document.createElement('li')
        d.className = 'h-divider'
        ul.append(d)
      }
    } catch (e) { report(e) }
  }
  const items = (a: JObject): any[] => (a.f.items?.f?.a ?? a.f.items?.data ?? a.f.own)
  def('Landroid/widget/BaseAdapter;', OBJ, {
    'notifyDataSetChanged()V': (v, s) => (s.f.lists || []).forEach(renderList),
    'getItemId(I)J': (v, s, [i]) => BigInt(i),
  })
  def('Landroid/widget/ArrayAdapter;', 'Landroid/widget/BaseAdapter;', {
    '<init>(Landroid/content/Context;I)V': (v, s) => { s.f.own = [] },
    '<init>(Landroid/content/Context;ILjava/util/List;)V': (v, s, [, , l]) => { s.f.items = l },
    '<init>(Landroid/content/Context;I[Ljava/lang/Object;)V': (v, s, [, , a]) => { s.f.items = a },
    'getCount()I': (v, s) => items(s).length,
    'getItem(I)Ljava/lang/Object;': (v, s, [i]) => items(s)[i],
    'add(Ljava/lang/Object;)V': (v, s, [x]) => { items(s).push(x); vm.callVirtual(s, 'notifyDataSetChanged()V') },
    'clear()V': (v, s) => { items(s).length = 0; vm.callVirtual(s, 'notifyDataSetChanged()V') },
    'getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;': (v, s, [i]) => {
      const t = newView('Landroid/widget/TextView;', 'span', 'title')
      t.f.el.textContent = jstr(vm, items(s)[i])
      return t
    },
  })

  // ---------- layout inflation ----------
  const WIDGET: Record<string, [string, string, string]> = {
    LinearLayout: ['Landroid/widget/LinearLayout;', 'div', 'an-linear'],
    FrameLayout: ['Landroid/widget/FrameLayout;', 'div', 'an-frame'],
    RelativeLayout: ['Landroid/widget/RelativeLayout;', 'div', 'an-linear an-relative'],
    ScrollView: ['Landroid/widget/ScrollView;', 'div', 'an-scroll'],
    TextView: ['Landroid/widget/TextView;', 'span', 'an-text'],
    Button: ['Landroid/widget/Button;', 'button', 'h-btn'],
    EditText: ['Landroid/widget/EditText;', 'input', 'h-edit'],
    CheckBox: ['Landroid/widget/CheckBox;', 'label', 'an-check'],
    RadioButton: ['Landroid/widget/RadioButton;', 'label', 'an-check'],
    Switch: ['Landroid/widget/Switch;', 'label', 'an-check'],
    ImageView: ['Landroid/widget/ImageView;', 'img', 'an-image'],
    ImageButton: ['Landroid/widget/ImageButton;', 'img', 'an-image h-btn-borderless'],
    ListView: ['Landroid/widget/ListView;', 'ul', 'h-list an-list'],
    GridView: ['Landroid/widget/GridView;', 'ul', 'h-list an-list'],
    ProgressBar: ['Landroid/widget/ProgressBar;', 'span', 'h-progress'],
    View: ['Landroid/view/View;', 'div', 'an-view'],
    AutoCompleteTextView: ['Landroid/widget/AutoCompleteTextView;', 'input', 'h-edit'],
    MultiAutoCompleteTextView: ['Landroid/widget/AutoCompleteTextView;', 'input', 'h-edit'],
    Spinner: ['Landroid/widget/Spinner;', 'div', 'an-spinner h-spinner'],
    SeekBar: ['Landroid/widget/SeekBar;', 'input', 'an-seek'],
    RatingBar: ['Landroid/widget/RatingBar;', 'input', 'an-seek'],
    HorizontalScrollView: ['Landroid/widget/HorizontalScrollView;', 'div', 'an-hscroll'],
    TabHost: ['Landroid/widget/TabHost;', 'div', 'an-linear'],
    TabWidget: ['Landroid/widget/TabWidget;', 'div', 'h-tabs'],
    ToggleButton: ['Landroid/widget/ToggleButton;', 'button', 'h-btn'],
    ViewFlipper: ['Landroid/widget/ViewFlipper;', 'div', 'an-frame'],
    ViewSwitcher: ['Landroid/widget/ViewSwitcher;', 'div', 'an-frame'],
    TableLayout: ['Landroid/widget/TableLayout;', 'div', 'an-linear'],
    TableRow: ['Landroid/widget/TableRow;', 'div', 'an-linear'],
    RadioGroup: ['Landroid/widget/RadioGroup;', 'div', 'an-linear'],
    WebView: ['Landroid/webkit/WebView;', 'div', 'an-view'],
    VideoView: ['Landroid/widget/VideoView;', 'div', 'an-view'],
    SurfaceView: ['Landroid/view/SurfaceView;', 'canvas', 'an-surface'],
  }
  // the framework widget a custom view class grows from (its nearest WIDGET ancestor)
  const widgetFor = (c: any): [string, string, string] => {
    for (let x = c; x; x = x.super) for (const w of Object.values(WIDGET)) if (w[0] === x.name) return w
    return WIDGET.View
  }
  function applyGravity(e: HTMLElement, g: number) {
    const h = g & 7, vv = g & 0x70
    if (g === 17 || h === 1) e.style.textAlign = 'center'
    if (h === 5) e.style.textAlign = 'right'
    if (vv === 0x10 || g === 17) e.style.alignItems = 'center'
  }
  // style="@style/x": its items (and its parents') fill in attributes the tag does not set itself.
  // style items are keyed by attribute id; names come from a fixed table of android attrs plus every
  // attribute the app's own xml files use
  const ATTR: Record<number, string> = {
    0x010100f4: 'layout_width', 0x010100f5: 'layout_height', 0x01010181: 'layout_weight', 0x010100b3: 'layout_gravity', 0x010100af: 'gravity',
    0x01010095: 'textSize', 0x01010097: 'textStyle', 0x01010098: 'textColor', 0x010100d4: 'background', 0x010100c4: 'orientation', 0x0101014f: 'text',
    0x010100d5: 'padding', 0x010100d6: 'paddingLeft', 0x010100d7: 'paddingTop', 0x010100d8: 'paddingRight', 0x010100d9: 'paddingBottom',
    0x010100f6: 'layout_margin', 0x010100f7: 'layout_marginLeft', 0x010100f8: 'layout_marginTop', 0x010100f9: 'layout_marginRight', 0x010100fa: 'layout_marginBottom',
    0x0101016e: 'drawableTop', 0x0101016f: 'drawableBottom', 0x01010170: 'drawableLeft', 0x01010171: 'drawableRight', 0x01010172: 'drawablePadding',
    0x010100dc: 'visibility', 0x010100d0: 'id', 0x01010119: 'src', 0x01010150: 'hint',
  }
  let attrNamesScanned = false
  const attrName = (id: number) => {
    if (!(id in ATTR) && !attrNamesScanned) {
      attrNamesScanned = true
      for (const [p, b] of env.files) if (/^res\/(layout|menu|xml|drawable|color)[^/]*\/.*\.xml$/.test(p)) {
        try { const walk = (n: XmlNode) => { for (const a of n.attrs) if (a.resId && !(a.resId in ATTR)) ATTR[a.resId] = a.name; n.children.forEach(walk) }; walk(parseAxml(b)) } catch { /* not binary xml */ }
      }
    }
    return ATTR[id]
  }
  const styleItems = (id: number, depth = 0): { name: string; value: XmlValue }[] => {
    const e = env.res.entries.get(id >>> 0)
    const val = e?.values.find((x) => x.map) ?? e?.values[0]
    if (!val || depth > 10) return []
    const own = (val.map || []).map((m) => ({ name: attrName(m.name), value: m.value })).filter((x) => x.name) as { name: string; value: XmlValue }[]
    // parent: explicit, or implied by a dotted name (NavItem.Big -> NavItem)
    let parentId = val.parent ?? 0
    if (!parentId && e!.name.includes('.')) { const pn = e!.name.slice(0, e!.name.lastIndexOf('.')); for (const [k, x] of env.res.entries) if (x.type === 'style' && x.name === pn) { parentId = k; break } }
    const up = parentId && (parentId >>> 24) === 0x7f ? styleItems(parentId, depth + 1) : []
    return [...own, ...up.filter((u) => !own.some((o) => o.name === u.name))]
  }
  const withStyle = (node: XmlNode): XmlNode => {
    const st = node.attrs.find((a) => a.name === 'style' && !a.ns)?.value ?? node.attrs.find((a) => a.name === 'style')?.value
    if (!st || st.type !== T.REFERENCE) return node
    const extra = styleItems(st.data).filter((x) => !node.attrs.some((a) => a.name === x.name))
    return { ...node, attrs: [...node.attrs, ...extra.map((x) => ({ ns: 'http://schemas.android.com/apk/res/android', name: x.name, resId: 0, value: x.value }))] }
  }
  // a drawable resource as css background: images, colors, and xml drawables (selector: its plain
  // state; shape: fill, corners, stroke; layer-list: the layers; inset / bitmap: their drawable)
  const drawableCss = (id: number, depth = 0): string => {
    if (depth > 6) return ''
    const v = res(id)
    if (!v) return ''
    if (v.type >= T.COLOR_ARGB8 && v.type <= T.COLOR_RGB4) return cssColor(v.data)
    if (v.type !== T.STRING) return ''
    if (!v.str!.endsWith('.xml')) { const u = drawableUrl(id); return u ? `center / 100% 100% no-repeat url("${u}")` : '' }
    const b = env.files.get(v.str!)
    if (!b) return ''
    let n: XmlNode
    try { n = parseAxml(b) } catch { return '' }
    return xmlDrawableCss(n, depth)
  }
  const refCss = (x: XmlValue | undefined, depth: number) => (!x ? '' : x.type === T.REFERENCE ? drawableCss(x.data, depth + 1) : x.type >= T.COLOR_ARGB8 && x.type <= T.COLOR_RGB4 ? cssColor(x.data) : '')
  const xmlDrawableCss = (n: XmlNode, depth: number): string => {
    if (n.tag === 'selector') {
      const items = n.children.filter((c) => c.tag === 'item')
      const plain = items.find((c) => !c.attrs.some((a) => a.name.startsWith('state_') && a.value.data)) ?? items[items.length - 1]
      if (!plain) return ''
      return refCss(attr(plain, 'drawable') ?? attr(plain, 'color'), depth) || (plain.children[0] ? xmlDrawableCss(plain.children[0], depth + 1) : '')
    }
    if (n.tag === 'shape') {
      const solid = n.children.find((c) => c.tag === 'solid'), grad = n.children.find((c) => c.tag === 'gradient')
      if (solid) return refCss(attr(solid, 'color'), depth)
      if (grad) { const a = refCss(attr(grad, 'startColor'), depth), z = refCss(attr(grad, 'endColor'), depth); return a && z ? `linear-gradient(${(270 - (attr(grad, 'angle')?.data ?? 0)) % 360}deg, ${a}, ${z})` : '' }
      return ''
    }
    if (n.tag === 'layer-list') return n.children.filter((c) => c.tag === 'item').map((c) => refCss(attr(c, 'drawable'), depth) || (c.children[0] ? xmlDrawableCss(c.children[0], depth + 1) : '')).filter(Boolean).reverse().join(', ')
    if (n.tag === 'inset' || n.tag === 'bitmap' || n.tag === 'nine-patch' || n.tag === 'clip' || n.tag === 'scale') return refCss(attr(n, 'drawable') ?? attr(n, 'src'), depth)
    if (n.tag === 'color') return refCss(attr(n, 'color'), depth)
    return ''
  }
  // extra box styling from a shape drawable: corners and stroke
  const shapeBox = (id: number, e: HTMLElement) => {
    const v = res(id)
    if (v?.type !== T.STRING || !v.str!.endsWith('.xml')) return
    let n: XmlNode
    try { n = parseAxml(env.files.get(v.str!)!) } catch { return }
    if (n.tag === 'selector') { const it = n.children.find((c) => c.tag === 'item' && !c.attrs.some((a) => a.name.startsWith('state_') && a.value.data)); const d = it && attr(it, 'drawable'); if (d?.type === T.REFERENCE) return shapeBox(d.data, e); if (it?.children[0]) n = it.children[0]; else return }
    if (n.tag !== 'shape') return
    const corners = n.children.find((c) => c.tag === 'corners'), stroke = n.children.find((c) => c.tag === 'stroke')
    if (corners) e.style.borderRadius = dimen(attr(corners, 'radius')) + 'px'
    if (attr(n, 'shape')?.data === 1) e.style.borderRadius = '50%'
    if (stroke) { const c = refCss(attr(stroke, 'color'), 0); if (c) e.style.border = `${dimen(attr(stroke, 'width')) || 1}px solid ${c}` }
  }
  function inflate(rawNode: XmlNode, parent: JObject | null, parentHorizontal: boolean): JObject {
    const node = withStyle(rawNode)
    const tag = node.tag.replace(/^android\.(widget|view)\./, '')
    const w = WIDGET[tag]
    let v: JObject
    const custom = node.tag === 'view' ? attrString(node, 'class') : node.tag
    if (w) v = newView(w[0], w[1], w[2])
    else if (custom && custom.includes('.') && vm.findDexClass('L' + custom.replace(/\./g, '/').replace(/\$/g, '$') + ';')) {
      // the app's own view class: the element of the widget it extends, then its (Context, AttributeSet) constructor
      const cname = 'L' + custom.replace(/\./g, '/') + ';'
      const c = vm.cls(cname)
      vm.init(c)
      v = new JObject(c)
      const [, t, k] = widgetFor(c)
      const ce = document.createElement(t)
      ce.className = k
      if (t === 'canvas') ce.style.cssText = 'display:block;width:100%;height:100%;touch-action:none'
      v.f.el = ce
      ;(ce as any).__view = v
      const set = new JObject(vm.cls('Landroid/util/AttributeSet;'))
      set.f.node = node
      const ctx = activityObj ?? appObj
      const m2 = vm.findMethod(c, '<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V')
      const m3 = m2 ? null : vm.findMethod(c, '<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V')
      const m1 = m2 || m3 ? null : vm.findMethod(c, '<init>(Landroid/content/Context;)V')
      try {
        if (m2) vm.invoke(m2, v, [ctx, set])
        else if (m3) vm.invoke(m3, v, [ctx, set, 0])
        else if (m1) vm.invoke(m1, v, [ctx])
      } catch (er) { report(er) }
      v.f.el = ce
    } else { vm.missing.add('widget ' + node.tag); v = newView('Landroid/view/View;', 'div', 'an-view') }
    const e = el(v)
    const id = attr(node, 'id')
    if (id && id.type === T.REFERENCE) { v.f.id = id.data | 0; views.set(id.data | 0, v) }
    // size
    const lw = attr(node, 'layout_width'), lh = attr(node, 'layout_height')
    const size = (x: XmlValue | undefined, prop: 'width' | 'height') => {
      if (!x) return
      if (x.type === T.INT_DEC || x.type === T.INT_HEX) { const n = x.data | 0; if (n === -1) e.style[prop] = '100%'; return }
      const d = dimen(x)
      if (d) e.style[prop] = d + 'px'
    }
    size(lw, 'width')
    size(lh, 'height')
    const weight = attr(node, 'layout_weight')
    if (weight && weight.type === T.FLOAT) {
      const f = new Float32Array(new Uint32Array([weight.data]).buffer)[0]
      if (f > 0) { e.style.flex = `${f} 1 0`; e.style[parentHorizontal ? 'width' : 'height'] = 'auto'; e.style.minWidth = e.style.minHeight = '0' }
    }
    const pad = attr(node, 'padding')
    if (pad) e.style.padding = dimen(pad) + 'px'
    for (const [k, css] of [['layout_marginTop', 'marginTop'], ['layout_marginBottom', 'marginBottom'], ['layout_marginLeft', 'marginLeft'], ['layout_marginRight', 'marginRight'], ['layout_margin', 'margin']] as const) {
      const m = node.attrs.find((a) => a.name === k)?.value
      if (m) (e.style as any)[css] = dimen(m) + 'px'
    }
    const bgv = attr(node, 'background')
    const bg = valueColor(bgv)
    if (bg) e.style.background = bg
    else if (bgv?.type === T.REFERENCE) { const css = drawableCss(bgv.data); if (css) e.style.background = css; shapeBox(bgv.data, e) }
    const lg = attr(node, 'layout_gravity')
    if (lg && (lg.data === 17 || (lg.data & 7) === 1)) { e.style.alignSelf = 'center'; e.style.margin = 'auto' }
    const grav = attr(node, 'gravity')
    if (grav) applyGravity(e, grav.data)
    const vis = attr(node, 'visibility')
    if (vis && vis.data === 2) e.style.display = 'none'
    // text widgets
    const text = valueText(attr(node, 'text'))
    if (tag === 'CheckBox' || tag === 'RadioButton' || tag === 'Switch') {
      const input = document.createElement('input')
      input.type = tag === 'RadioButton' ? 'radio' : 'checkbox'
      input.className = tag === 'RadioButton' ? 'h-radio' : 'h-check'
      const label = document.createElement('span')
      label.textContent = text || ''
      e.append(input, label)
      v.f.input = input
      v.f.label = label
      const ch = attr(node, 'checked')
      if (ch && ch.data) input.checked = true
    } else if (text != null) setText(v, text)
    if (tag === 'EditText') {
      const hint = valueText(attr(node, 'hint'))
      if (hint) (e as HTMLInputElement).placeholder = hint
      const it = attr(node, 'inputType')
      if (it && (it.data & 0xf) === 2) (e as HTMLInputElement).inputMode = 'numeric'
      if (it && (it.data & 0xfff) === 0x81) (e as HTMLInputElement).type = 'password'
    }
    const ts = attr(node, 'textSize')
    if (ts) e.style.fontSize = dimen(ts) + 'px'
    const tc = valueColor(attr(node, 'textColor'))
    if (tc) e.style.color = tc
    else { const tcv = attr(node, 'textColor'); if (tcv?.type === T.REFERENCE) { const c = drawableCss(tcv.data); if (c && !c.includes('url(')) e.style.color = c } }
    for (const [k, css] of [['paddingLeft', 'paddingLeft'], ['paddingTop', 'paddingTop'], ['paddingRight', 'paddingRight'], ['paddingBottom', 'paddingBottom'], ['paddingStart', 'paddingLeft'], ['paddingEnd', 'paddingRight']] as const) {
      const pv = attr(node, k)
      if (pv) (e.style as any)[css] = dimen(pv) + 'px'
    }
    const tsy = attr(node, 'textStyle')
    if (tsy) { if (tsy.data & 1) e.style.fontWeight = 'bold'; if (tsy.data & 2) e.style.fontStyle = 'italic' }
    if (attr(node, 'textAllCaps')?.data) e.style.textTransform = 'uppercase'
    const ml = attr(node, 'maxLines'), sl = attr(node, 'singleLine')
    if (sl?.data || ml?.data === 1) { e.style.whiteSpace = 'nowrap'; e.style.overflow = 'hidden'; e.style.textOverflow = 'ellipsis' }
    else if (ml && ml.data > 1) { e.style.display = '-webkit-box'; (e.style as any).webkitLineClamp = String(ml.data); (e.style as any).webkitBoxOrient = 'vertical'; e.style.overflow = 'hidden' }
    if (attr(node, 'ellipsize') && !e.style.overflow) { e.style.overflow = 'hidden'; e.style.textOverflow = 'ellipsis' }
    const mh = attr(node, 'minHeight'), mw = attr(node, 'minWidth')
    if (mh) e.style.minHeight = dimen(mh) + 'px'
    if (mw) e.style.minWidth = dimen(mw) + 'px'
    const cds = ['drawableLeft', 'drawableTop', 'drawableRight', 'drawableBottom'].map((k) => attr(node, k) ?? attr(node, k.replace('Left', 'Start').replace('Right', 'End')))
    if (cds.some((x) => x?.type === T.REFERENCE)) {
      const dpad = attr(node, 'drawablePadding')
      if (dpad) v.f.cdPad = dimen(dpad) * env.density
      try { vm.callVirtual(v, 'setCompoundDrawablesWithIntrinsicBounds(IIII)V', cds.map((x) => (x?.type === T.REFERENCE ? x.data | 0 : 0))) } catch (er) { report(er) }
    }
    const src = attr(node, 'src')
    if (src && src.type === T.REFERENCE) (e as HTMLImageElement).src = drawableUrl(src.data)
    if (tag === 'ProgressBar') { e.append(Object.assign(document.createElement('span'), { className: 'bar' })) }
    // android:onClick="method" in the layout
    const oc = attrString(node, 'onClick')
    if (oc) e.addEventListener('click', () => { try { vm.callVirtual(activityObj, `${oc}(Landroid/view/View;)V`, [v]) } catch (er) { report(er) } })
    const horizontal = tag === 'LinearLayout' && attr(node, 'orientation')?.data !== 1
    if (tag === 'LinearLayout') e.style.flexDirection = horizontal ? 'row' : 'column'
    if (tag === 'SeekBar' || tag === 'RatingBar') { const r = e as HTMLInputElement; r.type = 'range'; r.min = '0'; r.max = String(attr(node, tag === 'RatingBar' ? 'numStars' : 'max')?.data ?? 100); r.value = String(attr(node, 'progress')?.data ?? 0) }
    if (tag === 'HorizontalScrollView') { e.style.overflowX = 'auto'; e.style.display = 'flex' }
    inflateChildren(node, v, horizontal)
    void parent
    return v
  }
  // children, with <include layout="@layout/x"/> and <merge> (whose children join the parent)
  function inflateChildren(node: XmlNode, v: JObject, horizontal: boolean) {
    const e = el(v)
    for (const c of node.children) {
      if (c.tag === 'include') {
        const lay = attr(c, 'layout')
        if (!lay) continue
        const r = res(lay.data), xml = r?.type === T.STRING ? env.files.get(r.str!) : undefined
        if (!xml) continue
        const root = parseAxml(xml)
        if (root.tag === 'merge') { inflateChildren(root, v, horizontal); continue }
        const x = inflate(root, v, horizontal)
        const iid = attr(c, 'id')
        if (iid && iid.type === T.REFERENCE) { x.f.id = iid.data | 0; views.set(iid.data | 0, x) }
        const vis = attr(c, 'visibility')
        if (vis && vis.data === 2) el(x).style.display = 'none'
        e.append(el(x))
      } else if (c.tag === 'merge') inflateChildren(c, v, horizontal)
      else if (c.tag === 'requestFocus') continue
      else e.append(el(inflate(c, v, horizontal)))
    }
  }
  const inflateId = (id: number, parent: JObject | null) => {
    const v = res(id)
    if (!v || v.type !== T.STRING) throw vm.error('Landroid/content/res/Resources$NotFoundException;', `layout 0x${(id >>> 0).toString(16)}`)
    const xml = env.files.get(v.str!)
    if (!xml) throw vm.error('Landroid/content/res/Resources$NotFoundException;', v.str!)
    const root = parseAxml(xml)
    if (root.tag === 'merge' && parent) { inflateChildren(root, parent, false); return parent }
    return inflate(root, parent, false)
  }
  def('Landroid/view/LayoutInflater;', OBJ, {
    'from(Landroid/content/Context;)Landroid/view/LayoutInflater;': () => new JObject(vm.cls('Landroid/view/LayoutInflater;')),
    'inflate(ILandroid/view/ViewGroup;)Landroid/view/View;': (v, s, [id, p]) => { const x = inflateId(id, p); if (p && x !== p) el(p).append(el(x)); return x },
    'inflate(ILandroid/view/ViewGroup;Z)Landroid/view/View;': (v, s, [id, p, attach]) => { const x = inflateId(id, p); if (p && attach && x !== p) el(p).append(el(x)); return x },
  })

  // ---------- activity, context, intents ----------
  let activityObj: JObject = null as any
  let appObj: JObject | null = null // the app's Application (its own subclass when it has one)
  let content: JObject | null = null
  let menuItems: JObject[] = []
  const APK_PATH = `/data/app/${env.pkg}-1.apk`
  const fileObj = (p: string) => { const f = new JObject(vm.cls('Ljava/io/File;')); f.f.path = p; return f }
  const dirFile = (p: string) => { env.vfs?.mkdirs(p); return fileObj(p) }
  const appInfo = () => {
    const a = new JObject(vm.cls('Landroid/content/pm/ApplicationInfo;'))
    Object.assign(a.f, { packageName: env.pkg, sourceDir: APK_PATH, publicSourceDir: APK_PATH, dataDir: `/data/data/${env.pkg}`, nativeLibraryDir: `/data/data/${env.pkg}/lib`, targetSdkVersion: 19, flags: 0, uid: 10050, processName: env.pkg })
    return a
  }
  const contextMethods: Record<string, NativeFn> = {
    'getString(I)Ljava/lang/String;': (v, s, [id]) => resString(id),
    'getString(I[Ljava/lang/Object;)Ljava/lang/String;': (v, s, [id, a]) => jformat(vm, resString(id), a ? [...a.data] : []),
    'getText(I)Ljava/lang/CharSequence;': (v, s, [id]) => resString(id),
    'getResources()Landroid/content/res/Resources;': () => resources,
    'getPackageName()Ljava/lang/String;': () => env.pkg,
    // where things live on a phone (backed by the in-memory file system)
    'getFilesDir()Ljava/io/File;': () => dirFile(`/data/data/${env.pkg}/files`),
    'getCacheDir()Ljava/io/File;': () => dirFile(`/data/data/${env.pkg}/cache`),
    'getDir(Ljava/lang/String;I)Ljava/io/File;': (v, s, [n]) => dirFile(`/data/data/${env.pkg}/app_${n}`),
    'getExternalFilesDir(Ljava/lang/String;)Ljava/io/File;': (v, s, [t]) => dirFile(`/sdcard/Android/data/${env.pkg}/files` + (t ? '/' + t : '')),
    'getExternalCacheDir()Ljava/io/File;': () => dirFile(`/sdcard/Android/data/${env.pkg}/cache`),
    'getFileStreamPath(Ljava/lang/String;)Ljava/io/File;': (v, s, [n]) => fileObj(`/data/data/${env.pkg}/files/${n}`),
    'getPackageCodePath()Ljava/lang/String;': () => APK_PATH,
    'getPackageResourcePath()Ljava/lang/String;': () => APK_PATH,
    'getApplicationInfo()Landroid/content/pm/ApplicationInfo;': () => appInfo(),
    'openFileInput(Ljava/lang/String;)Ljava/io/FileInputStream;': (v, s, [n]) => { const f = new JObject(vm.cls('Ljava/io/FileInputStream;')); vm.callVirtual(f, '<init>(Ljava/lang/String;)V', [`/data/data/${env.pkg}/files/${n}`]); return f },
    'openFileOutput(Ljava/lang/String;I)Ljava/io/FileOutputStream;': (v, s, [n, mode]) => { const f = new JObject(vm.cls('Ljava/io/FileOutputStream;')); vm.callVirtual(f, '<init>(Ljava/lang/String;Z)V', [`/data/data/${env.pkg}/files/${n}`, mode & 0x8792 ? 1 : 0]); return f },
    'getApplicationContext()Landroid/content/Context;': (v, s) => appObj ?? s,
    'getSharedPreferences(Ljava/lang/String;I)Landroid/content/SharedPreferences;': (v, s, [name]) => prefsFor(name),
    'getSystemService(Ljava/lang/String;)Ljava/lang/Object;': (v, s, [name]) => { if (name === 'vibrator') return new JObject(vm.cls('Landroid/os/Vibrator;')); if (name === 'layout_inflater') return new JObject(vm.cls('Landroid/view/LayoutInflater;')); if (name === 'audio') return new JObject(vm.cls('Landroid/media/AudioManager;')); if (name === 'notification') return new JObject(vm.cls('Landroid/app/NotificationManager;')); vm.missing.add('system service ' + name); return null },
    'startActivity(Landroid/content/Intent;)V': (v, s, [i]) => startActivity(i),
    'getMainLooper()Landroid/os/Looper;': () => new JObject(vm.cls('Landroid/os/Looper;')),
  }
  def('Landroid/content/Context;', OBJ, contextMethods, { statics: { MODE_PRIVATE: 0, VIBRATOR_SERVICE: 'vibrator', LAYOUT_INFLATER_SERVICE: 'layout_inflater', NOTIFICATION_SERVICE: 'notification', AUDIO_SERVICE: 'audio', ALARM_SERVICE: 'alarm' } })
  def('Landroid/content/ContextWrapper;', 'Landroid/content/Context;', {
    '<init>(Landroid/content/Context;)V': () => {},
    'attachBaseContext(Landroid/content/Context;)V': () => {},
    'getBaseContext()Landroid/content/Context;': (v, s) => s,
  })
  def('Landroid/view/ContextThemeWrapper;', 'Landroid/content/ContextWrapper;', {})
  const noop: NativeFn = () => {}
  def('Landroid/app/Activity;', 'Landroid/view/ContextThemeWrapper;', {
    '<init>()V': noop,
    'onCreate(Landroid/os/Bundle;)V': noop, 'onStart()V': noop, 'onRestart()V': noop, 'onResume()V': noop, 'onPause()V': noop, 'onStop()V': noop, 'onDestroy()V': noop,
    'onPostCreate(Landroid/os/Bundle;)V': noop, 'onPostResume()V': noop,
    'onSaveInstanceState(Landroid/os/Bundle;)V': noop, 'onRestoreInstanceState(Landroid/os/Bundle;)V': noop,
    'onBackPressed()V': (v, s) => vm.callVirtual(s, 'finish()V'),
    'onCreateOptionsMenu(Landroid/view/Menu;)Z': () => 1,
    'onPrepareOptionsMenu(Landroid/view/Menu;)Z': () => 1,
    'onOptionsItemSelected(Landroid/view/MenuItem;)Z': () => 0,
    'onKeyDown(ILandroid/view/KeyEvent;)Z': () => 0,
    'onConfigurationChanged(Landroid/content/res/Configuration;)V': noop,
    'onActivityResult(IILandroid/content/Intent;)V': noop,
    'setContentView(I)V': (v, s, [id]) => setContent(inflateId(id, null)),
    'setContentView(Landroid/view/View;)V': (v, s, [view]) => setContent(view),
    'findViewById(I)Landroid/view/View;': (v, s, [id]) => views.get(id) ?? null,
    'getIntent()Landroid/content/Intent;': () => currentIntent,
    'setIntent(Landroid/content/Intent;)V': (v, s, [i]) => { currentIntent = i },
    'finish()V': () => env.droid.app.finish(resultCode, resultData),
    'setResult(I)V': (v, s, [c]) => { resultCode = c },
    'setResult(ILandroid/content/Intent;)V': (v, s, [c, i]) => { resultCode = c; resultData = i ? { extras: extrasToJson(i) } : undefined },
    'startActivityForResult(Landroid/content/Intent;I)V': (v, s, [i, code]) => startActivity(i, code),
    'setTitle(Ljava/lang/CharSequence;)V': (v, s, [t]) => env.droid.actionbar.title(textOf(t)),
    'setTitle(I)V': (v, s, [id]) => env.droid.actionbar.title(resString(id)),
    'getWindow()Landroid/view/Window;': () => new JObject(vm.cls('Landroid/view/Window;')),
    'runOnUiThread(Ljava/lang/Runnable;)V': (v, s, [r]) => { if (vm.current === vm.main) runSafe(r); else setTimeout(() => runSafe(r), 0) },
    'getLayoutInflater()Landroid/view/LayoutInflater;': () => new JObject(vm.cls('Landroid/view/LayoutInflater;')),
    'invalidateOptionsMenu()V': () => buildMenu(),
    'requestWindowFeature(I)Z': (v, s, [f]) => { if (f === 1) env.droid.actionbar.hide() /* FEATURE_NO_TITLE */; return 1 },
    'getApplication()Landroid/app/Application;': () => appObj,
    'setTheme(I)V': (v, s, [id]) => applyTheme(id), // the holo look comes from the shell; this does the window part
    'getTheme()Landroid/content/res/Resources$Theme;': () => new JObject(vm.cls('Landroid/content/res/Resources$Theme;')),
    'isFinishing()Z': () => 0,
    'getActionBar()Landroid/app/ActionBar;': () => new JObject(vm.cls('Landroid/app/ActionBar;')),
  })
  def('Landroid/app/ActionBar;', OBJ, { 'setTitle(Ljava/lang/CharSequence;)V': (v, s, [t]) => env.droid.actionbar.title(textOf(t)), 'hide()V': () => env.droid.actionbar.hide(), 'show()V': () => env.droid.actionbar.show(), 'setDisplayHomeAsUpEnabled(Z)V': noop })
  def('Landroid/view/Window;', OBJ, {
    // FLAG_FULLSCREEN 0x400: no status bar for this app; FLAG_KEEP_SCREEN_ON 0x80
    'setFlags(II)V': (v, s, [f, mask]) => { if (mask & 0x400) statusBar(!(f & 0x400)); if (mask & 0x80) env.droid.system.keepawake(!!(f & 0x80)) },
    'addFlags(I)V': (v, s, [f]) => { if (f & 0x400) statusBar(false); if (f & 0x80) env.droid.system.keepawake(true) },
    'clearFlags(I)V': (v, s, [f]) => { if (f & 0x400) statusBar(true); if (f & 0x80) env.droid.system.keepawake(false) },
    'setSoftInputMode(I)V': noop, 'setFormat(I)V': noop, 'setBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V': noop,
    'setBackgroundDrawableResource(I)V': noop, 'setLayout(II)V': noop, 'setGravity(I)V': noop, 'setType(I)V': noop,
    'takeSurface(Landroid/view/SurfaceHolder$Callback2;)V': noop, 'takeInputQueue(Landroid/view/InputQueue$Callback;)V': noop,
    'requestFeature(I)Z': () => 1, 'setFeatureInt(II)V': noop,
  })
  def('Landroid/content/res/Resources$Theme;', OBJ, { 'applyStyle(IZ)V': noop })
  def('Landroid/app/Application;', 'Landroid/content/ContextWrapper;', {
    '<init>()V': noop, 'onCreate()V': noop, 'onTerminate()V': noop, 'onLowMemory()V': noop, 'onTrimMemory(I)V': noop,
    'onConfigurationChanged(Landroid/content/res/Configuration;)V': noop,
    'registerActivityLifecycleCallbacks(Landroid/app/Application$ActivityLifecycleCallbacks;)V': noop,
    'unregisterActivityLifecycleCallbacks(Landroid/app/Application$ActivityLifecycleCallbacks;)V': noop,
  })
  def('Landroid/content/pm/PackageItemInfo;', OBJ, {})
  def('Landroid/content/ContentProvider;', OBJ, {
    '<init>()V': noop,
    'onCreate()Z': () => 1,
    'getContext()Landroid/content/Context;': (v, s) => s.f.context ?? appObj,
    'attachInfo(Landroid/content/Context;Landroid/content/pm/ProviderInfo;)V': (v, s, [c]) => { s.f.context = c },
  })
  def('Landroid/content/pm/ApplicationInfo;', 'Landroid/content/pm/PackageItemInfo;', { '<init>()V': noop })
  def('Landroid/content/res/Resources;', OBJ, {
    'getString(I)Ljava/lang/String;': (v, s, [id]) => resString(id),
    'getColor(I)I': (v, s, [id]) => (res(id)?.data ?? 0) | 0,
    'getDimension(I)F': (v, s, [id]) => dimen(res(id)) * env.density,
    'getInteger(I)I': (v, s, [id]) => (res(id)?.data ?? 0) | 0,
    'getBoolean(I)Z': (v, s, [id]) => (res(id)?.data ? 1 : 0),
    'getDisplayMetrics()Landroid/util/DisplayMetrics;': () => { const m = new JObject(vm.cls('Landroid/util/DisplayMetrics;')); m.f.density = env.density; m.f.widthPixels = Math.round(innerWidth * env.density); m.f.heightPixels = Math.round(innerHeight * env.density); m.f.densityDpi = Math.round(env.density * 160); return m },
    'getIdentifier(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I': (v, s, [name, type]) => { for (const [id, e] of env.res.entries) if (e.name === name && e.type === type) return id | 0; return 0 },
  })
  def('Landroid/util/DisplayMetrics;', OBJ, {})
  const resources = new JObject(vm.cls('Landroid/content/res/Resources;'))

  // the window's content frame (android.R.id.content): a FrameLayout holding the activity's layout,
  // which apps look up to wrap or rearrange their content
  let contentFrame: JObject | null = null
  const setContent = (v: JObject) => {
    content = v
    if (!contentFrame) {
      contentFrame = new JObject(vm.cls('Landroid/widget/FrameLayout;'))
      const f = document.createElement('div')
      f.className = 'an-view an-content'
      f.style.cssText = 'position:relative;width:100%;height:100%'
      contentFrame.f.el = f
      contentFrame.f.id = 0x1020002
      ;(f as any).__view = contentFrame
      views.set(0x1020002, contentFrame)
    }
    const f = el(contentFrame)
    env.root.innerHTML = ''
    f.innerHTML = ''
    const e = el(v)
    e.classList.add('an-root')
    f.append(e)
    env.root.append(f)
  }

  // bundles and intents keep their extras in a js object
  const bundleMethods = (field: string): Record<string, NativeFn> => {
    const g = (s: JObject) => (s.f[field] ||= {})
    const m: Record<string, NativeFn> = {
      '<init>()V': (v, s) => { s.f[field] = {} },
      'containsKey(Ljava/lang/String;)Z': (v, s, [k]) => (k in g(s) ? 1 : 0),
      'remove(Ljava/lang/String;)V': (v, s, [k]) => { delete g(s)[k] },
      'keySet()Ljava/util/Set;': (v, s) => { const l = new JObject(vm.cls('Ljava/util/ArrayList;')); l.f.a = Object.keys(g(s)); return l },
    }
    for (const [t, sig, def0] of [['Int', 'I', 0], ['Long', 'J', 0n], ['Boolean', 'Z', 0], ['Float', 'F', 0], ['Double', 'D', 0], ['String', 'Ljava/lang/String;', null], ['CharSequence', 'Ljava/lang/CharSequence;', null]] as const) {
      m[`put${t}(Ljava/lang/String;${sig})V`] = (v, s, [k, x]) => { g(s)[k] = x }
      m[`get${t}(Ljava/lang/String;)${sig}`] = (v, s, [k]) => (k in g(s) ? g(s)[k] : def0)
      m[`get${t}(Ljava/lang/String;${sig})${sig}`] = (v, s, [k, d]) => (k in g(s) ? g(s)[k] : d)
    }
    return m
  }
  def('Landroid/os/Bundle;', OBJ, bundleMethods('map'))
  const extrasOf = (i: JObject) => (i.f.extras ||= {})
  const intentMethods: Record<string, NativeFn> = {
    '<init>()V': (v, s) => { s.f.extras = {} },
    '<init>(Ljava/lang/String;)V': (v, s, [a]) => { s.f.extras = {}; s.f.action = a },
    '<init>(Landroid/content/Context;Ljava/lang/Class;)V': (v, s, [, c]) => { s.f.extras = {}; s.f.target = c.f.of.name },
    '<init>(Ljava/lang/String;Landroid/net/Uri;)V': (v, s, [a, u]) => { s.f.extras = {}; s.f.action = a; s.f.data = u?.f.s },
    'setClass(Landroid/content/Context;Ljava/lang/Class;)Landroid/content/Intent;': (v, s, [, c]) => { s.f.target = c.f.of.name; return s },
    'setAction(Ljava/lang/String;)Landroid/content/Intent;': (v, s, [a]) => { s.f.action = a; return s },
    'getAction()Ljava/lang/String;': (v, s) => s.f.action ?? null,
    'setType(Ljava/lang/String;)Landroid/content/Intent;': (v, s, [t]) => { s.f.type = t; return s },
    'getExtras()Landroid/os/Bundle;': (v, s) => { const b = new JObject(vm.cls('Landroid/os/Bundle;')); b.f.map = extrasOf(s); return b },
    'hasExtra(Ljava/lang/String;)Z': (v, s, [k]) => (k in extrasOf(s) ? 1 : 0),
    'addFlags(I)Landroid/content/Intent;': (v, s) => s,
    'setFlags(I)Landroid/content/Intent;': (v, s) => s,
  }
  for (const [t, sig, def0] of [['Int', 'I', 0], ['Long', 'J', 0n], ['Boolean', 'Z', 0], ['Float', 'F', 0], ['Double', 'D', 0], ['String', 'Ljava/lang/String;', null]] as const) {
    intentMethods[`putExtra(Ljava/lang/String;${sig})Landroid/content/Intent;`] = (v, s, [k, x]) => { extrasOf(s)[k] = x; return s }
    intentMethods[`get${t}Extra(Ljava/lang/String;${sig === 'Ljava/lang/String;' ? '' : sig})${sig}`] = (v, s, [k, d]) => (k in extrasOf(s) ? extrasOf(s)[k] : d ?? def0)
  }
  def('Landroid/content/Intent;', OBJ, intentMethods, { statics: { ACTION_VIEW: 'android.intent.action.VIEW', ACTION_SEND: 'android.intent.action.SEND', ACTION_MAIN: 'android.intent.action.MAIN', EXTRA_TEXT: 'android.intent.extra.TEXT' } })
  def('Landroid/net/Uri;', OBJ, { 'parse(Ljava/lang/String;)Landroid/net/Uri;': (v, s, [x]) => { const u = new JObject(vm.cls('Landroid/net/Uri;')); u.f.s = x; return u }, 'toString()Ljava/lang/String;': (v, s) => s.f.s })

  const extrasToJson = (i: JObject) => {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(extrasOf(i))) out[k] = typeof v === 'bigint' ? { long: v.toString() } : v
    return out
  }
  const extrasFromJson = (e: Record<string, any> = {}) => {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(e)) out[k] = v && typeof v === 'object' && 'long' in v ? BigInt(v.long) : v
    return out
  }
  let resultCode = 0
  let resultData: any
  let currentIntent = new JObject(vm.cls('Landroid/content/Intent;'))
  currentIntent.f.extras = extrasFromJson(env.intent.extras?.android)
  currentIntent.f.action = env.intent.extras?.androidAction || 'android.intent.action.MAIN'

  function startActivity(i: JObject, requestCode?: number) {
    const extras = { android: extrasToJson(i), androidAction: i.f.action }
    if (i.f.target) {
      const name = env.activityFor(i.f.target)
      if (!name) throw vm.error('Landroid/content/ActivityNotFoundException;', i.f.target)
      if (requestCode == null) env.droid.intent.start({ package: env.pkg, activity: name, extras })
      else env.droid.intent.startforresult({ package: env.pkg, activity: name, extras }).then((r: any) => {
        const data = r.data?.extras ? (() => { const d = new JObject(vm.cls('Landroid/content/Intent;')); d.f.extras = extrasFromJson(r.data.extras); return d })() : null
        try { vm.callVirtual(activityObj, 'onActivityResult(IILandroid/content/Intent;)V', [requestCode, r.code, data]) } catch (e) { report(e) }
      })
      return
    }
    // implicit intents: view a url in the browser, share text
    if (i.f.action === 'android.intent.action.VIEW' && i.f.data) env.droid.intent.start({ action: 'view', data: i.f.data })
    else if (i.f.action === 'android.intent.action.SEND') env.droid.intent.start({ action: 'send', type: i.f.type || 'text/plain', extras: { text: extrasOf(i)['android.intent.extra.TEXT'] } })
    else vm.missing.add('intent ' + i.f.action)
  }
  def('Landroid/content/ActivityNotFoundException;', 'Ljava/lang/RuntimeException;', {})
  def('Landroid/content/res/Resources$NotFoundException;', 'Ljava/lang/RuntimeException;', {})

  // shared preferences -> droid.prefs (preloaded, written through)
  def('Landroid/content/SharedPreferences;', OBJ, {})
  def('Landroid/content/SharedPreferences$Editor;', OBJ, {})
  // values keep their java type next to them (sp-type:<name>:<key>) so getAll can box them right
  function prefsFor(name: string) {
    const p = new JObject(vm.cls('Landroid/content/SharedPreferences;'))
    p.f.name = name
    return p
  }
  {
    const P = vm.cls('Landroid/content/SharedPreferences;'), E = vm.cls('Landroid/content/SharedPreferences$Editor;')
    const key = (s: JObject, k: string) => `sp:${s.f.name}:${k}`
    const get = (s: JObject, k: string, d: any) => (env.prefs.has(key(s, k)) ? env.prefs.get(key(s, k)) : d)
    const add = (k: string, fn: NativeFn, cls = P) => (vm.epoch++, cls.methods.set(k, { cls, name: k.slice(0, k.indexOf('(')), key: k, desc: k.slice(k.indexOf('(')), ret: k.slice(k.indexOf(')') + 1), params: splitParams(k.slice(k.indexOf('('))), flags: 1, code: null, native: fn }))
    add('getInt(Ljava/lang/String;I)I', (v, s, [k, d]) => get(s, k, d))
    add('getLong(Ljava/lang/String;J)J', (v, s, [k, d]) => { const x = get(s, k, null); return x == null ? d : BigInt(x) })
    add('getBoolean(Ljava/lang/String;Z)Z', (v, s, [k, d]) => (get(s, k, d) ? 1 : 0))
    add('getFloat(Ljava/lang/String;F)F', (v, s, [k, d]) => get(s, k, d))
    add('getString(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', (v, s, [k, d]) => get(s, k, d))
    add('getStringSet(Ljava/lang/String;Ljava/util/Set;)Ljava/util/Set;', (v, s, [k, d]) => { const x = get(s, k, null); if (!Array.isArray(x)) return d; const set = vm.newObject('Ljava/util/HashSet;'); for (const i of x) vm.callVirtual(set, 'add(Ljava/lang/Object;)Z', [i]); return set })
    add('contains(Ljava/lang/String;)Z', (v, s, [k]) => (env.prefs.has(key(s, k)) ? 1 : 0))
    add('getAll()Ljava/util/Map;', (v, s) => {
      const m = vm.newObject('Ljava/util/HashMap;')
      const pre = `sp:${s.f.name}:`
      for (const [k, x] of env.prefs) {
        if (!k.startsWith(pre)) continue
        const t = env.prefs.get(`sp-type:${s.f.name}:${k.slice(pre.length)}`)
        const boxed = typeof x === 'string' ? x : t === 'J' ? box(vm, 'Ljava/lang/Long;', BigInt(x)) : t === 'F' ? box(vm, 'Ljava/lang/Float;', x) : t === 'Z' ? box(vm, 'Ljava/lang/Boolean;', x ? 1 : 0) : typeof x === 'number' ? box(vm, 'Ljava/lang/Integer;', x) : x
        vm.callVirtual(m, 'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', [k.slice(pre.length), boxed])
      }
      return m
    })
    add('registerOnSharedPreferenceChangeListener(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V', () => {})
    add('unregisterOnSharedPreferenceChangeListener(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V', () => {})
    add('edit()Landroid/content/SharedPreferences$Editor;', (v, s) => {
      const ed = new JObject(E)
      ed.f.pending = new Map()
      ed.f.name = s.f.name
      return ed
    })
    const put = (sig: string, t: string, conv = (x: any) => x) => add(`put${sig}`, (v, s, [k, x]) => { s.f.pending.set(key(s, k), [conv(x), t]); return s }, E)
    put('Int(Ljava/lang/String;I)Landroid/content/SharedPreferences$Editor;', 'I')
    put('Long(Ljava/lang/String;J)Landroid/content/SharedPreferences$Editor;', 'J', (x) => String(x))
    put('Boolean(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;', 'Z', (x) => !!x)
    put('Float(Ljava/lang/String;F)Landroid/content/SharedPreferences$Editor;', 'F')
    put('String(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;', 'S')
    put('StringSet(Ljava/lang/String;Ljava/util/Set;)Landroid/content/SharedPreferences$Editor;', 'T', (x) => { const out: any[] = []; const it = vm.callVirtual(x, 'iterator()Ljava/util/Iterator;'); while (vm.callVirtual(it, 'hasNext()Z')) out.push(vm.callVirtual(it, 'next()Ljava/lang/Object;')); return out })
    add('remove(Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;', (v, s, [k]) => { s.f.pending.set(key(s, k), undefined); return s }, E)
    add('clear()Landroid/content/SharedPreferences$Editor;', (v, s) => { for (const k of env.prefs.keys()) if (k.startsWith(`sp:${s.f.name}:`)) s.f.pending.set(k, undefined); return s }, E)
    const commit: NativeFn = (v, s) => {
      for (const [k, x] of s.f.pending) {
        const tk = k.replace(/^sp:/, 'sp-type:')
        if (x === undefined) { env.prefs.delete(k); env.droid.prefs.remove(k); env.prefs.delete(tk); env.droid.prefs.remove(tk) }
        else { env.prefs.set(k, x[0]); env.droid.prefs.set(k, x[0]); env.prefs.set(tk, x[1]); env.droid.prefs.set(tk, x[1]) }
      }
      s.f.pending.clear()
      return 1
    }
    add('commit()Z', commit, E)
    add('apply()V', (v, s, a) => { commit(v, s, a) }, E)
  }

  // ---------- toast, log, menus, misc ----------
  def('Landroid/widget/Toast;', OBJ, {
    'makeText(Landroid/content/Context;Ljava/lang/CharSequence;I)Landroid/widget/Toast;': (v, s, [, t, d]) => { const o = new JObject(vm.cls('Landroid/widget/Toast;')); o.f.text = textOf(t); o.f.long = d === 1; return o },
    'makeText(Landroid/content/Context;II)Landroid/widget/Toast;': (v, s, [, id, d]) => { const o = new JObject(vm.cls('Landroid/widget/Toast;')); o.f.text = resString(id); o.f.long = d === 1; return o },
    'show()V': (v, s) => env.droid.toast(s.f.text, s.f.long ? 'long' : 'short'),
    'setGravity(III)V': noop, 'cancel()V': noop,
    'setText(Ljava/lang/CharSequence;)V': (v, s, [t]) => { s.f.text = textOf(t) },
  }, { statics: { LENGTH_SHORT: 0, LENGTH_LONG: 1 } })
  const log = (lvl: string): NativeFn => (v, s, [tag, msg]) => { console.log(`${lvl}/${tag}: ${msg}`); return 0 }
  def('Landroid/util/Log;', OBJ, {
    'd(Ljava/lang/String;Ljava/lang/String;)I': log('D'), 'i(Ljava/lang/String;Ljava/lang/String;)I': log('I'), 'v(Ljava/lang/String;Ljava/lang/String;)I': log('V'),
    'w(Ljava/lang/String;Ljava/lang/String;)I': log('W'), 'e(Ljava/lang/String;Ljava/lang/String;)I': log('E'),
    'e(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)I': log('E'), 'w(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)I': log('W'),
  })
  def('Landroid/view/Menu;', OBJ, {
    'add(Ljava/lang/CharSequence;)Landroid/view/MenuItem;': (v, s, [t]) => addItem(0, textOf(t)),
    'add(I)Landroid/view/MenuItem;': (v, s, [id]) => addItem(0, resString(id)),
    'add(IIILjava/lang/CharSequence;)Landroid/view/MenuItem;': (v, s, [, id, , t]) => addItem(id, textOf(t)),
    'add(IIII)Landroid/view/MenuItem;': (v, s, [, id, , r]) => addItem(id, resString(r)),
    'clear()V': () => { menuItems = [] },
    'size()I': () => menuItems.length,
    'findItem(I)Landroid/view/MenuItem;': (v, s, [id]) => menuItems.find((m) => m.f.id === id) ?? null,
  })
  def('Landroid/view/MenuItem;', OBJ, {
    'getItemId()I': (v, s) => s.f.id,
    'getTitle()Ljava/lang/CharSequence;': (v, s) => s.f.title,
    'setIcon(I)Landroid/view/MenuItem;': (v, s) => s,
    'setShowAsAction(I)V': noop,
    'setEnabled(Z)Landroid/view/MenuItem;': (v, s) => s,
    'setVisible(Z)Landroid/view/MenuItem;': (v, s, [x]) => { s.f.hidden = !x; return s },
  })
  const addItem = (id: number, title: string) => { const it = new JObject(vm.cls('Landroid/view/MenuItem;')); it.f.id = id; it.f.title = title; it.f.idx = menuItems.length; menuItems.push(it); return it }
  const menuObj = new JObject(vm.cls('Landroid/view/Menu;'))
  function buildMenu() {
    menuItems = []
    try {
      if (vm.callVirtual(activityObj, 'onCreateOptionsMenu(Landroid/view/Menu;)Z', [menuObj])) vm.callVirtual(activityObj, 'onPrepareOptionsMenu(Landroid/view/Menu;)Z', [menuObj])
    } catch (e) { report(e) }
    env.droid.actionbar.menu(menuItems.filter((m) => !m.f.hidden).map((m) => ({ id: String(m.f.idx), title: m.f.title })))
  }
  def('Landroid/os/Vibrator;', OBJ, { 'vibrate(J)V': (v, s, [ms]) => env.droid.system.vibrate(Number(ms)).catch(() => {}), 'cancel()V': noop })
  def('Landroid/os/Looper;', OBJ, { 'getMainLooper()Landroid/os/Looper;': () => new JObject(vm.cls('Landroid/os/Looper;')), 'myLooper()Landroid/os/Looper;': () => new JObject(vm.cls('Landroid/os/Looper;')) })
  def('Landroid/os/Handler;', OBJ, {
    '<init>()V': noop, '<init>(Landroid/os/Looper;)V': noop,
    'post(Ljava/lang/Runnable;)Z': (v, s, [r]) => { setTimeout(() => runSafe(r), 0); return 1 },
    'postDelayed(Ljava/lang/Runnable;J)Z': (v, s, [r, ms]) => { const t = setTimeout(() => runSafe(r), Number(ms)); (s.f.timers ||= new Map()).set(r, t); return 1 },
    'removeCallbacks(Ljava/lang/Runnable;)V': (v, s, [r]) => { const t = s.f.timers?.get(r); if (t) clearTimeout(t) },
  })
  def('Landroid/os/SystemClock;', OBJ, { 'uptimeMillis()J': () => BigInt(Math.round(performance.now())), 'elapsedRealtime()J': () => BigInt(Math.round(performance.now())), 'sleep(J)V': (v, s, [ms]) => { const until = performance.now() + Number(ms); throw new Block(() => performance.now() >= until, until, 'sleep') }, 'currentThreadTimeMillis()J': () => BigInt(Math.round(performance.now())) })
  def('Landroid/os/Build$VERSION;', OBJ, {}, { statics: { SDK_INT: 19, SDK: '19', RELEASE: '4.4', CODENAME: 'REL', INCREMENTAL: 'droid' } })
  def('Landroid/os/Build$VERSION_CODES;', OBJ, {}, { statics: { BASE: 1, CUPCAKE: 3, DONUT: 4, ECLAIR: 5, FROYO: 8, GINGERBREAD: 9, HONEYCOMB: 11, HONEYCOMB_MR1: 12, HONEYCOMB_MR2: 13, ICE_CREAM_SANDWICH: 14, ICE_CREAM_SANDWICH_MR1: 15, JELLY_BEAN: 16, JELLY_BEAN_MR1: 17, JELLY_BEAN_MR2: 18, KITKAT: 19 } })
  def('Landroid/os/Build;', OBJ, { 'getRadioVersion()Ljava/lang/String;': () => 'droid' }, { statics: {
    MODEL: 'Droid', MANUFACTURER: 'Danen', BRAND: 'danen', DEVICE: 'droid', PRODUCT: 'droid', BOARD: 'droid', HARDWARE: 'droid', BOOTLOADER: 'unknown',
    CPU_ABI: 'armeabi-v7a', CPU_ABI2: 'armeabi', DISPLAY: 'KTU84Q', ID: 'KTU84Q', HOST: 'danen', USER: 'danen', TAGS: 'release-keys', TYPE: 'user',
    FINGERPRINT: 'danen/droid/droid:4.4/KTU84Q/droid:user/release-keys', SERIAL: '0123456789ABCDEF', RADIO: 'unknown', UNKNOWN: 'unknown', TIME: 1404000000000n,
  } })
  def('Landroid/graphics/Color;', OBJ, {
    'rgb(III)I': (v, s, [r, g, b]) => (0xff000000 | (r << 16) | (g << 8) | b) | 0,
    'argb(IIII)I': (v, s, [a, r, g, b]) => ((a << 24) | (r << 16) | (g << 8) | b) | 0,
    'parseColor(Ljava/lang/String;)I': (v, s, [x]) => { const h = x.replace('#', ''); return (parseInt(h.length === 6 ? 'ff' + h : h, 16)) | 0 },
  }, { statics: { BLACK: 0xff000000 | 0, WHITE: -1, RED: 0xffff0000 | 0, GREEN: 0xff00ff00 | 0, BLUE: 0xff0000ff | 0, TRANSPARENT: 0, GRAY: 0xff888888 | 0 } })
  def('Landroid/text/TextUtils;', OBJ, { 'isEmpty(Ljava/lang/CharSequence;)Z': (v, s, [t]) => (t == null || jstr(vm, t).length === 0 ? 1 : 0) })

  // ---------- notifications: NotificationManager, Notification(.Builder), PendingIntent ----------
  def('Landroid/app/PendingIntent;', OBJ, {
    'getActivity(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;': (v, s, [, code, i]) => { const p = new JObject(vm.cls('Landroid/app/PendingIntent;')); p.f.intent = i; p.f.kind = 'activity'; p.f.code = code; return p },
    'getBroadcast(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;': (v, s, [, code, i]) => { const p = new JObject(vm.cls('Landroid/app/PendingIntent;')); p.f.intent = i; p.f.kind = 'broadcast'; p.f.code = code; return p },
    'getService(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;': (v, s, [, code, i]) => { const p = new JObject(vm.cls('Landroid/app/PendingIntent;')); p.f.intent = i; p.f.kind = 'service'; p.f.code = code; return p },
    'cancel()V': noop,
  }, { statics: { FLAG_UPDATE_CURRENT: 0x8000000, FLAG_CANCEL_CURRENT: 0x10000000, FLAG_ONE_SHOT: 0x40000000, FLAG_IMMUTABLE: 0x4000000 } })
  const FLAG_ONGOING = 2, FLAG_NO_CLEAR = 32
  def('Landroid/app/Notification;', OBJ, {
    '<init>()V': (v, s) => { s.f.n = {} },
    '<init>(ILjava/lang/CharSequence;J)V': (v, s, [, ticker]) => { s.f.n = { ticker: textOf(ticker) } },
    'setLatestEventInfo(Landroid/content/Context;Ljava/lang/CharSequence;Ljava/lang/CharSequence;Landroid/app/PendingIntent;)V': (v, s, [, t, x, pi]) => { Object.assign((s.f.n ||= {}), { title: textOf(t), text: textOf(x), pi }) },
  }, { statics: { FLAG_ONGOING_EVENT: FLAG_ONGOING, FLAG_NO_CLEAR, FLAG_AUTO_CANCEL: 16, DEFAULT_ALL: -1, DEFAULT_SOUND: 1, DEFAULT_VIBRATE: 2, PRIORITY_DEFAULT: 0, PRIORITY_HIGH: 1, PRIORITY_LOW: -1 } })
  const B = 'Landroid/app/Notification$Builder;'
  const bset = (field: string, conv: (x: any) => any = (x) => x): NativeFn => (v, s, [x]) => { s.f.n[field] = conv(x); return s }
  def(B, OBJ, {
    '<init>(Landroid/content/Context;)V': (v, s) => { s.f.n = {} },
    '<init>(Landroid/content/Context;Ljava/lang/String;)V': (v, s) => { s.f.n = {} },
    [`setContentTitle(Ljava/lang/CharSequence;)${B}`]: bset('title', textOf),
    [`setContentText(Ljava/lang/CharSequence;)${B}`]: bset('text', textOf),
    [`setSubText(Ljava/lang/CharSequence;)${B}`]: bset('sub', textOf),
    [`setTicker(Ljava/lang/CharSequence;)${B}`]: bset('ticker', textOf),
    [`setContentInfo(Ljava/lang/CharSequence;)${B}`]: bset('info', textOf),
    [`setSmallIcon(I)${B}`]: bset('icon'),
    [`setSmallIcon(II)${B}`]: bset('icon'),
    [`setLargeIcon(Landroid/graphics/Bitmap;)${B}`]: (v, s) => s,
    [`setContentIntent(Landroid/app/PendingIntent;)${B}`]: bset('pi'),
    [`setDeleteIntent(Landroid/app/PendingIntent;)${B}`]: (v, s) => s,
    [`setAutoCancel(Z)${B}`]: bset('autoCancel', (x) => !!x),
    [`setOngoing(Z)${B}`]: bset('ongoing', (x) => !!x),
    [`setOnlyAlertOnce(Z)${B}`]: (v, s) => s,
    [`setWhen(J)${B}`]: (v, s) => s,
    [`setShowWhen(Z)${B}`]: (v, s) => s,
    [`setDefaults(I)${B}`]: bset('defaults'),
    [`setPriority(I)${B}`]: (v, s) => s,
    [`setNumber(I)${B}`]: (v, s) => s,
    [`setVibrate([J)${B}`]: (v, s) => s,
    [`setLights(III)${B}`]: (v, s) => s,
    [`setSound(Landroid/net/Uri;)${B}`]: (v, s) => s,
    [`setProgress(IIZ)${B}`]: (v, s, [max, p, ind]) => { s.f.n.progress = ind ? -1 : max > 0 ? p / max : undefined; return s },
    [`setStyle(Landroid/app/Notification$Style;)${B}`]: (v, s, [st]) => { if (st?.f?.big) s.f.n.text = st.f.big; return s },
    'build()Landroid/app/Notification;': (v, s) => { const n = new JObject(vm.cls('Landroid/app/Notification;')); n.f.n = { ...s.f.n }; return n },
    'getNotification()Landroid/app/Notification;': (v, s) => { const n = new JObject(vm.cls('Landroid/app/Notification;')); n.f.n = { ...s.f.n }; return n },
  })
  def('Landroid/app/Notification$Style;', OBJ, {})
  def('Landroid/app/Notification$BigTextStyle;', 'Landroid/app/Notification$Style;', {
    '<init>()V': noop,
    'bigText(Ljava/lang/CharSequence;)Landroid/app/Notification$BigTextStyle;': (v, s, [t]) => { s.f.big = textOf(t); return s },
    'setBigContentTitle(Ljava/lang/CharSequence;)Landroid/app/Notification$BigTextStyle;': (v, s) => s,
  })
  const notifKey = (tag: any, id: number) => `android:${tag == null ? '' : textOf(tag)}:${id | 0}`
  const post = (tag: any, id: number, n: JObject) => {
    const d = n?.f?.n || {}
    const flags = n?.f?.flags | 0
    // the PendingIntent's target activity and extras, so a tap lands on the right screen
    let activity: string | undefined, extras: any
    const it = d.pi?.f?.intent
    if (it?.f?.target && d.pi.f.kind === 'activity') { activity = env.activityFor(it.f.target) || undefined; extras = { android: Object.fromEntries(Object.entries(it.f.extras || {}).map(([k, x]) => [k, typeof x === 'bigint' ? { long: String(x) } : x])), androidAction: it.f.action } }
    ;((env as any).posted ||= new Set()).add(notifKey(tag, id))
    env.droid.system.notify({ id: notifKey(tag, id), title: d.title || d.ticker || env.res.pkg, text: d.text || d.sub, ticker: d.ticker, ongoing: !!d.ongoing || !!(flags & (FLAG_ONGOING | FLAG_NO_CLEAR)), progress: d.progress, activity, extras }).catch((e: any) => console.warn('notification', e?.message))
    if (d.defaults && (d.defaults === -1 || d.defaults & 2)) env.droid.system.vibrate(200).catch(() => {})
  }
  def('Landroid/app/NotificationManager;', OBJ, {
    'notify(ILandroid/app/Notification;)V': (v, s, [id, n]) => post(null, id, n),
    'notify(Ljava/lang/String;ILandroid/app/Notification;)V': (v, s, [tag, id, n]) => post(tag, id, n),
    'cancel(I)V': (v, s, [id]) => { env.droid.system.cancel(notifKey(null, id)) },
    'cancel(Ljava/lang/String;I)V': (v, s, [tag, id]) => { env.droid.system.cancel(notifKey(tag, id)) },
    'cancelAll()V': () => { (env as any).posted?.forEach?.((k: string) => env.droid.system.cancel(k)) },
    'areNotificationsEnabled()Z': () => 1,
  })
  def('Landroid/graphics/Bitmap;', OBJ, {})
  def('Landroid/graphics/BitmapFactory;', OBJ, { 'decodeResource(Landroid/content/res/Resources;I)Landroid/graphics/Bitmap;': () => new JObject(vm.cls('Landroid/graphics/Bitmap;')) })

  // ---------- background: AlarmManager, Service, IntentService, BroadcastReceiver ----------
  const jobOf = (pi: JObject) => {
    const it = pi?.f?.intent
    const extras = Object.fromEntries(Object.entries(it?.f?.extras || {}).map(([k, x]) => [k, typeof x === 'bigint' ? { long: String(x) } : x]))
    const kind = pi?.f?.kind || 'activity'
    return { kind, cls: it?.f?.target, action: it?.f?.action, extras, activity: kind === 'activity' && it?.f?.target ? env.activityFor(it.f.target) : undefined }
  }
  const alarmId = (pi: JObject) => `${pi?.f?.kind}:${pi?.f?.code}:${pi?.f?.intent?.f?.target || pi?.f?.intent?.f?.action || ''}`
  // RTC types are wall clock, ELAPSED_REALTIME types count from boot (our performance.now)
  const toEpoch = (type: number, t: bigint) => (type >= 2 ? Date.now() + (Number(t) - performance.now()) : Number(t))
  const setAlarm = (type: number, at: bigint, interval: number, pi: JObject) => {
    env.droid.background.alarm({ id: alarmId(pi), at: toEpoch(type, at), interval, job: jobOf(pi) }).catch((e: any) => console.warn('alarm', e?.message))
  }
  def('Landroid/app/AlarmManager;', OBJ, {
    'set(IJLandroid/app/PendingIntent;)V': (v, s, [t, at, pi]) => setAlarm(t, at, 0, pi),
    'setExact(IJLandroid/app/PendingIntent;)V': (v, s, [t, at, pi]) => setAlarm(t, at, 0, pi),
    'setAndAllowWhileIdle(IJLandroid/app/PendingIntent;)V': (v, s, [t, at, pi]) => setAlarm(t, at, 0, pi),
    'setExactAndAllowWhileIdle(IJLandroid/app/PendingIntent;)V': (v, s, [t, at, pi]) => setAlarm(t, at, 0, pi),
    'setWindow(IJJLandroid/app/PendingIntent;)V': (v, s, [t, at, , pi]) => setAlarm(t, at, 0, pi),
    'setRepeating(IJJLandroid/app/PendingIntent;)V': (v, s, [t, at, iv, pi]) => setAlarm(t, at, Math.max(60000, Number(iv)), pi),
    'setInexactRepeating(IJJLandroid/app/PendingIntent;)V': (v, s, [t, at, iv, pi]) => setAlarm(t, at, Math.max(60000, Number(iv)), pi),
    'cancel(Landroid/app/PendingIntent;)V': (v, s, [pi]) => { env.droid.background.cancel(alarmId(pi)) },
  }, { statics: { RTC: 1, RTC_WAKEUP: 0, ELAPSED_REALTIME: 3, ELAPSED_REALTIME_WAKEUP: 2, INTERVAL_FIFTEEN_MINUTES: 900000n, INTERVAL_HALF_HOUR: 1800000n, INTERVAL_HOUR: 3600000n, INTERVAL_DAY: 86400000n } })
  contextMethods['startService(Landroid/content/Intent;)Landroid/content/ComponentName;'] = (v, s, [i]) => { env.droid.background.run({ kind: 'service', cls: i.f.target, action: i.f.action, extras: jobOf(mkPi(i, 'service')).extras }); return null }
  contextMethods['stopService(Landroid/content/Intent;)Z'] = () => 1
  contextMethods['sendBroadcast(Landroid/content/Intent;)V'] = (v, s, [i]) => { env.droid.background.run({ kind: 'broadcast', cls: i.f.target, action: i.f.action, extras: jobOf(mkPi(i, 'broadcast')).extras }) }
  contextMethods['registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;)Landroid/content/Intent;'] = (v, s, [r, f]) => { (dynamicReceivers ||= []).push({ r, actions: f?.f?.actions || [] }); return null }
  contextMethods['unregisterReceiver(Landroid/content/BroadcastReceiver;)V'] = (v, s, [r]) => { dynamicReceivers = (dynamicReceivers || []).filter((x) => x.r !== r) }
  let dynamicReceivers: { r: JObject; actions: string[] }[] | undefined
  const mkPi = (i: JObject, kind: string) => { const p = new JObject(vm.cls('Landroid/app/PendingIntent;')); p.f.intent = i; p.f.kind = kind; return p }
  def('Landroid/content/IntentFilter;', OBJ, {
    '<init>()V': (v, s) => { s.f.actions = [] },
    '<init>(Ljava/lang/String;)V': (v, s, [a]) => { s.f.actions = [a] },
    'addAction(Ljava/lang/String;)V': (v, s, [a]) => { (s.f.actions ||= []).push(a) },
  })
  def('Landroid/content/BroadcastReceiver;', OBJ, {
    '<init>()V': noop,
    'setResultCode(I)V': noop, 'abortBroadcast()V': noop,
    'goAsync()Landroid/content/BroadcastReceiver$PendingResult;': () => new JObject(vm.cls('Landroid/content/BroadcastReceiver$PendingResult;')),
  })
  def('Landroid/content/BroadcastReceiver$PendingResult;', OBJ, { 'finish()V': noop })
  def('Landroid/app/Service;', 'Landroid/content/ContextWrapper;', {
    '<init>()V': noop,
    'onCreate()V': noop, 'onDestroy()V': noop,
    'onStartCommand(Landroid/content/Intent;II)I': (v, s, [i, f, id]) => { vm.callVirtual(s, 'onStart(Landroid/content/Intent;I)V', [i, id]); return 1 },
    'onStart(Landroid/content/Intent;I)V': noop,
    'onBind(Landroid/content/Intent;)Landroid/os/IBinder;': () => null,
    'stopSelf()V': noop, 'stopSelf(I)V': noop, 'stopSelfResult(I)Z': () => 1,
    'startForeground(ILandroid/app/Notification;)V': (v, s, [id, n]) => { if (n?.f?.n) n.f.n.ongoing = true; post('fg', id, n) },
    'stopForeground(Z)V': () => {},
  }, { statics: { START_STICKY: 1, START_NOT_STICKY: 2, START_REDELIVER_INTENT: 3 } })
  def('Landroid/app/IntentService;', 'Landroid/app/Service;', {
    '<init>(Ljava/lang/String;)V': noop,
    'onStartCommand(Landroid/content/Intent;II)I': (v, s, [i]) => { vm.callVirtual(s, 'onHandleIntent(Landroid/content/Intent;)V', [i]); return 2 },
    'setIntentRedelivery(Z)V': noop,
  })
  contextMethods['getSystemService(Ljava/lang/String;)Ljava/lang/Object;'] = ((orig) => (v: VM, s: any, a: any[]) => (a[0] === 'alarm' ? new JObject(vm.cls('Landroid/app/AlarmManager;')) : orig(v, s, a)))(contextMethods['getSystemService(Ljava/lang/String;)Ljava/lang/Object;'])
  const services = new Map<string, JObject>()
  let startId = 1
  const intentFrom = (job: any) => {
    const i = new JObject(vm.cls('Landroid/content/Intent;'))
    i.f.extras = extrasFromJson(job.extras || {})
    i.f.action = job.action
    i.f.target = job.cls
    return i
  }
  function runJob(job: any, receiverClasses: { cls: string; actions: string[] }[]) {
    const ctxObj = appObj || activityObj || (activityObj = vm.newObject('Landroid/app/Application;'))
    const intent = intentFrom(job)
    if (job.kind === 'service') {
      if (!job.cls) return
      let svc = services.get(job.cls)
      if (!svc) { svc = vm.newObject(job.cls); services.set(job.cls, svc); vm.callVirtual(svc, 'onCreate()V') }
      vm.callVirtual(svc, 'onStartCommand(Landroid/content/Intent;II)I', [intent, 0, startId++])
      return
    }
    const targets = job.cls ? [job.cls] : receiverClasses.filter((r) => r.actions.includes(job.action)).map((r) => r.cls)
    for (const c of targets) { const r = vm.newObject(c); vm.callVirtual(r, 'onReceive(Landroid/content/Context;Landroid/content/Intent;)V', [ctxObj, intent]) }
    for (const d of dynamicReceivers || []) if (!job.cls && d.actions.includes(job.action)) vm.callVirtual(d.r, 'onReceive(Landroid/content/Context;Landroid/content/Intent;)V', [ctxObj, intent])
  }

  // ---------- media: MediaPlayer, SoundPool, VideoView, AudioManager ----------
  const rawUrl = (id: number) => (() => {
    const v = res(id)
    if (v?.type !== T.STRING || !env.files.has(v.str!)) return ''
    const p = v.str!
    if (!fileUrl.has(p)) {
      const type = p.endsWith('.mp3') ? 'audio/mpeg' : p.endsWith('.ogg') ? 'audio/ogg' : p.endsWith('.wav') ? 'audio/wav' : p.endsWith('.mp4') ? 'video/mp4' : p.endsWith('.webm') ? 'video/webm' : 'application/octet-stream'
      fileUrl.set(p, URL.createObjectURL(new Blob([env.files.get(p)! as BlobPart], { type })))
    }
    return fileUrl.get(p)!
  })()
  const assetUrl = (path: string) => {
    const p = 'assets/' + path.replace(/^\/+/, '')
    if (!env.files.has(p)) return ''
    if (!fileUrl.has(p)) fileUrl.set(p, URL.createObjectURL(new Blob([env.files.get(p)! as BlobPart])))
    return fileUrl.get(p)!
  }
  const players = new Set<HTMLMediaElement>()
  const callback = (l: any, key: string, args: any[]) => { if (l) try { vm.callVirtual(l, key, args) } catch (e) { report(e) } }
  const mp = (s: JObject): HTMLAudioElement => (s.f.audio ||= (() => {
    const a = new Audio()
    a.addEventListener('ended', () => { if (!a.loop) callback(s.f.onDone, 'onCompletion(Landroid/media/MediaPlayer;)V', [s]) })
    a.addEventListener('canplay', () => { if (s.f.preparing) { s.f.preparing = false; callback(s.f.onPrepared, 'onPrepared(Landroid/media/MediaPlayer;)V', [s]) } })
    a.addEventListener('error', () => callback(s.f.onError, 'onError(Landroid/media/MediaPlayer;II)Z', [s, 1, 0]))
    players.add(a)
    return a
  })())
  const newPlayer = (url: string) => { const p = new JObject(vm.cls('Landroid/media/MediaPlayer;')); mp(p).src = url; return p }
  def('Landroid/media/MediaPlayer;', OBJ, {
    '<init>()V': noop,
    'create(Landroid/content/Context;I)Landroid/media/MediaPlayer;': (v, s, [, id]) => { const u = rawUrl(id); return u ? newPlayer(u) : null },
    'create(Landroid/content/Context;Landroid/net/Uri;)Landroid/media/MediaPlayer;': (v, s, [, u]) => newPlayer(u.f.s),
    'setDataSource(Ljava/lang/String;)V': (v, s, [u]) => { mp(s).src = /^https?:/.test(u) ? u : assetUrl(u) || u },
    'setDataSource(Landroid/content/Context;Landroid/net/Uri;)V': (v, s, [, u]) => { mp(s).src = u.f.s },
    'setDataSource(Ljava/io/FileDescriptor;JJ)V': (v, s, [fd]) => { if (fd?.f?.url) mp(s).src = fd.f.url },
    'prepare()V': noop,
    'prepareAsync()V': (v, s) => { s.f.preparing = true; mp(s).load() },
    'start()V': (v, s) => { mp(s).play().catch(() => env.droid.toast('Tap again to allow sound')) },
    'pause()V': (v, s) => mp(s).pause(),
    'stop()V': (v, s) => { const a = mp(s); a.pause(); a.currentTime = 0 },
    'reset()V': (v, s) => { mp(s).pause(); mp(s).removeAttribute('src') },
    'release()V': (v, s) => { const a = mp(s); a.pause(); players.delete(a); a.removeAttribute('src'); a.load() },
    'isPlaying()Z': (v, s) => (!mp(s).paused && !mp(s).ended ? 1 : 0),
    'setLooping(Z)V': (v, s, [x]) => { mp(s).loop = !!x },
    'isLooping()Z': (v, s) => (mp(s).loop ? 1 : 0),
    'setVolume(FF)V': (v, s, [l, r]) => { mp(s).volume = Math.max(0, Math.min(1, (l + r) / 2)) },
    'getDuration()I': (v, s) => (isFinite(mp(s).duration) ? Math.round(mp(s).duration * 1000) : -1),
    'getCurrentPosition()I': (v, s) => Math.round(mp(s).currentTime * 1000),
    'seekTo(I)V': (v, s, [ms]) => { mp(s).currentTime = ms / 1000 },
    'setAudioStreamType(I)V': noop, 'setWakeMode(Landroid/content/Context;I)V': noop,
    'setOnCompletionListener(Landroid/media/MediaPlayer$OnCompletionListener;)V': (v, s, [l]) => { s.f.onDone = l },
    'setOnPreparedListener(Landroid/media/MediaPlayer$OnPreparedListener;)V': (v, s, [l]) => { s.f.onPrepared = l },
    'setOnErrorListener(Landroid/media/MediaPlayer$OnErrorListener;)V': (v, s, [l]) => { s.f.onError = l },
  })
  // SoundPool: short sounds by id; each play gets a fresh audio element (they may overlap)
  def('Landroid/media/SoundPool;', OBJ, {
    '<init>(III)V': (v, s) => { s.f.sounds = new Map(); s.f.streams = new Map(); s.f.next = 1 },
    'load(Landroid/content/Context;II)I': (v, s, [, id]) => {
      const n = s.f.next++
      s.f.sounds.set(n, rawUrl(id))
      setTimeout(() => callback(s.f.onLoad, 'onLoadComplete(Landroid/media/SoundPool;II)V', [s, n, 0]), 0)
      return n
    },
    'play(IFFIIF)I': (v, s, [id, l, r, , loop, rate]) => {
      const u = s.f.sounds.get(id)
      if (!u) return 0
      const a = new Audio(u)
      a.volume = Math.max(0, Math.min(1, (l + r) / 2))
      a.playbackRate = rate || 1
      a.loop = loop === -1
      a.play().catch(() => {})
      const stream = s.f.next++
      s.f.streams.set(stream, a)
      a.addEventListener('ended', () => s.f.streams.delete(stream))
      return stream
    },
    'stop(I)V': (v, s, [st]) => { s.f.streams.get(st)?.pause(); s.f.streams.delete(st) },
    'pause(I)V': (v, s, [st]) => s.f.streams.get(st)?.pause(),
    'resume(I)V': (v, s, [st]) => { s.f.streams.get(st)?.play().catch(() => {}) },
    'autoPause()V': (v, s) => s.f.streams.forEach((a: HTMLAudioElement) => a.pause()),
    'autoResume()V': (v, s) => s.f.streams.forEach((a: HTMLAudioElement) => a.play().catch(() => {})),
    'setVolume(IFF)V': (v, s, [st, l, r]) => { const a = s.f.streams.get(st); if (a) a.volume = (l + r) / 2 },
    'unload(I)Z': (v, s, [id]) => (s.f.sounds.delete(id) ? 1 : 0),
    'release()V': (v, s) => { s.f.streams.forEach((a: HTMLAudioElement) => a.pause()); s.f.streams.clear() },
    'setOnLoadCompleteListener(Landroid/media/SoundPool$OnLoadCompleteListener;)V': (v, s, [l]) => { s.f.onLoad = l },
  })
  def('Landroid/media/AudioManager;', OBJ, {
    'getStreamVolume(I)I': () => 10, 'getStreamMaxVolume(I)I': () => 15, 'setStreamVolume(III)V': noop,
    'requestAudioFocus(Landroid/media/AudioManager$OnAudioFocusChangeListener;II)I': () => 1, 'abandonAudioFocus(Landroid/media/AudioManager$OnAudioFocusChangeListener;)I': () => 1,
    'getRingerMode()I': () => 2,
  }, { statics: { STREAM_MUSIC: 3, AUDIOFOCUS_GAIN: 1, AUDIOFOCUS_REQUEST_GRANTED: 1 } })
  contextMethods['setVolumeControlStream(I)V'] = noop
  def('Landroid/widget/VideoView;', 'Landroid/view/View;', {
    'setVideoPath(Ljava/lang/String;)V': (v, s, [p]) => { (el(s) as HTMLVideoElement).src = /^https?:/.test(p) ? p : assetUrl(p) || p },
    'setVideoURI(Landroid/net/Uri;)V': (v, s, [u]) => { const x = String(u.f.s); const m2 = x.match(/android\.resource:\/\/[^/]+\/(\d+)$/); (el(s) as HTMLVideoElement).src = m2 ? rawUrl(+m2[1]) : x },
    'start()V': (v, s) => { (el(s) as HTMLVideoElement).play().catch(() => {}) },
    'pause()V': (v, s) => (el(s) as HTMLVideoElement).pause(),
    'stopPlayback()V': (v, s) => { const e = el(s) as HTMLVideoElement; e.pause(); e.removeAttribute('src') },
    'isPlaying()Z': (v, s) => ((el(s) as HTMLVideoElement).paused ? 0 : 1),
    'seekTo(I)V': (v, s, [ms]) => { (el(s) as HTMLVideoElement).currentTime = ms / 1000 },
    'getDuration()I': (v, s) => Math.round(((el(s) as HTMLVideoElement).duration || 0) * 1000),
    'getCurrentPosition()I': (v, s) => Math.round((el(s) as HTMLVideoElement).currentTime * 1000),
    'setMediaController(Landroid/widget/MediaController;)V': (v, s) => { (el(s) as HTMLVideoElement).controls = true },
    'setOnCompletionListener(Landroid/media/MediaPlayer$OnCompletionListener;)V': (v, s, [l]) => { el(s).addEventListener('ended', () => callback(l, 'onCompletion(Landroid/media/MediaPlayer;)V', [null])) },
  })
  def('Landroid/widget/MediaController;', 'Landroid/view/View;', { '<init>(Landroid/content/Context;)V': noop, 'setAnchorView(Landroid/view/View;)V': noop })
  WIDGET.VideoView = ['Landroid/widget/VideoView;', 'video', 'an-video']
  const stopAllMedia = () => players.forEach((a) => a.pause())

  // ---------- running an activity ----------
  // last: it extends classes defined (and patched) above
  registerMore(vm, env, { el, report, runSafe, activity: () => activityObj, app: () => appObj, prefsFor, noop, appInfo: () => appInfo() })
  registerWidgets(vm, env, { el, report, activity: () => activityObj, res, drawableUrl, resString, valueText, cssColor, renderList, views, setText, getText, addMenuItem: (id, title, icon, order) => { const it = addItem(id, title); if (icon) it.f.icon = icon; it.f.order = order ?? 0; return it }, newView })
  registerGlJava(vm, env, report)
  registerAudio(vm)
  registerNet(vm)
  registerHttp(vm, env.droid, () => vm.current === vm.main)
  // the app-wide default prefs file android names <package>_preferences
  vm.shim('Landroid/preference/PreferenceManager;', { methods: {
    'getDefaultSharedPreferences(Landroid/content/Context;)Landroid/content/SharedPreferences;': () => prefsFor(env.pkg + '_preferences'),
    'getDefaultSharedPreferencesName(Landroid/content/Context;)Ljava/lang/String;': () => env.pkg + '_preferences',
    'setDefaultValues(Landroid/content/Context;IZ)V': noop,
  } })
  return {
    // <application android:name>: made once, before any activity, like android does
    application(className: string | null, providers: { cls: string; authorities: string }[] = []) {
      if (appObj) return
      appObj = vm.newObject(className && vm.hasClass(className) ? className : 'Landroid/app/Application;')
      vm.callVirtual(appObj, 'attachBaseContext(Landroid/content/Context;)V', [appObj])
      // content providers start between attachBaseContext and onCreate (libraries init there)
      for (const p of providers) {
        if (!vm.hasClass(p.cls)) continue
        try {
          const o = vm.newObject(p.cls)
          o.f.context = appObj
          o.f.authority = p.authorities
          vm.callVirtual(o, 'onCreate()Z')
        } catch (e) { console.warn('content provider', p.cls, e instanceof JavaThrow ? jstr(vm, e.obj) : e) }
      }
      vm.callVirtual(appObj, 'onCreate()V')
    },
    start(className: string, saved: any) {
      applyTheme(manifestTheme(className))
      activityObj = vm.newObject(className)
      let bundle: JObject | null = null
      if (saved && typeof saved === 'object') { bundle = new JObject(vm.cls('Landroid/os/Bundle;')); bundle.f.map = extrasFromJson(saved) }
      vm.callVirtual(activityObj, 'onCreate(Landroid/os/Bundle;)V', [bundle])
      vm.callVirtual(activityObj, 'onStart()V')
      if (bundle) vm.callVirtual(activityObj, 'onRestoreInstanceState(Landroid/os/Bundle;)V', [bundle])
      vm.callVirtual(activityObj, 'onResume()V')
      buildMenu()
    },
    lifecycle(ev: string) {
      if (ev === 'destroy') stopAllMedia()
      const map: Record<string, string> = { pause: 'onPause()V', resume: 'onResume()V', stop: 'onStop()V', start: 'onRestart()V', destroy: 'onDestroy()V' }
      try { if (map[ev] && activityObj) vm.callVirtual(activityObj, map[ev]) } catch (e) { report(e) }
    },
    save() {
      const b = new JObject(vm.cls('Landroid/os/Bundle;'))
      b.f.map = {}
      try { vm.callVirtual(activityObj, 'onSaveInstanceState(Landroid/os/Bundle;)V', [b]) } catch (e) { report(e) }
      const out: Record<string, any> = {}
      for (const [k, v] of Object.entries(b.f.map)) if (v == null || typeof v !== 'object') out[k] = typeof v === 'bigint' ? { long: v.toString() } : v
      return out
    },
    back() { try { vm.callVirtual(activityObj, 'onBackPressed()V') } catch (e) { report(e) } },
    menu(id: string) {
      const it = menuItems[+id]
      if (it) try { vm.callVirtual(activityObj, 'onOptionsItemSelected(Landroid/view/MenuItem;)Z', [it]) } catch (e) { report(e) }
      buildMenu()
    },
    report,
    content: () => content,
    // background host: run one job (broadcast, service) with the app context
    background(job: any, receivers: { cls: string; actions: string[] }[]) { try { runJob(job, receivers) } catch (e) { console.error('background job', e instanceof JavaThrow ? jstr(vm, e.obj) : e) } },
  }
}
export { JArray }
