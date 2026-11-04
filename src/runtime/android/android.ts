// framework shim, part 2: the android classes a simple old app uses, mapped onto droid and holo dom.
// (versioned as droid-framework@0.1 in converted manifests)
import { VM, JObject, JArray, JavaThrow, type NativeFn } from './dalvik.ts'
import { jstr, jformat } from './java.ts'
import { parseAxml, attr, attrString, T, type XmlNode, type XmlValue } from './axml.ts'
import { resolve, entryName, type ResTable } from './arsc.ts'

export const SHIM_VERSION = 'droid-framework@0.1'
const OBJ = 'Ljava/lang/Object;'

export interface Env {
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
  const report = (e: unknown) => {
    const msg = e instanceof JavaThrow ? jstr(vm, e.obj) : String((e as Error)?.message || e)
    console.error('android app crashed:', msg)
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
  }
  function applyGravity(e: HTMLElement, g: number) {
    const h = g & 7, vv = g & 0x70
    if (g === 17 || h === 1) e.style.textAlign = 'center'
    if (h === 5) e.style.textAlign = 'right'
    if (vv === 0x10 || g === 17) e.style.alignItems = 'center'
  }
  function inflate(node: XmlNode, parent: JObject | null, parentHorizontal: boolean): JObject {
    const tag = node.tag.replace(/^android\.(widget|view)\./, '')
    const w = WIDGET[tag]
    let v: JObject
    if (w) v = newView(w[0], w[1], w[2])
    else if (node.tag.includes('.') && vm.findDexClass('L' + node.tag.replace(/\./g, '/') + ';')) {
      // the app's own view class: give it a box, it may draw nothing yet
      v = vm.newObject('L' + node.tag.replace(/\./g, '/') + ';')
      v.f.el = document.createElement('div')
      v.f.el.className = 'an-view'
      vm.missing.add('custom view ' + node.tag)
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
    const bg = valueColor(attr(node, 'background'))
    if (bg) e.style.background = bg
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
    const src = attr(node, 'src')
    if (src && src.type === T.REFERENCE) (e as HTMLImageElement).src = drawableUrl(src.data)
    if (tag === 'ProgressBar') { e.append(Object.assign(document.createElement('span'), { className: 'bar' })) }
    // android:onClick="method" in the layout
    const oc = attrString(node, 'onClick')
    if (oc) e.addEventListener('click', () => { try { vm.callVirtual(activityObj, `${oc}(Landroid/view/View;)V`, [v]) } catch (er) { report(er) } })
    const horizontal = tag === 'LinearLayout' && attr(node, 'orientation')?.data !== 1
    if (tag === 'LinearLayout') e.style.flexDirection = horizontal ? 'row' : 'column'
    for (const c of node.children) e.append(el(inflate(c, v, horizontal)))
    void parent
    return v
  }
  const inflateId = (id: number, parent: JObject | null) => {
    const v = res(id)
    if (!v || v.type !== T.STRING) throw vm.error('Landroid/content/res/Resources$NotFoundException;', `layout 0x${(id >>> 0).toString(16)}`)
    const xml = env.files.get(v.str!)
    if (!xml) throw vm.error('Landroid/content/res/Resources$NotFoundException;', v.str!)
    return inflate(parseAxml(xml), parent, false)
  }
  def('Landroid/view/LayoutInflater;', OBJ, {
    'from(Landroid/content/Context;)Landroid/view/LayoutInflater;': () => new JObject(vm.cls('Landroid/view/LayoutInflater;')),
    'inflate(ILandroid/view/ViewGroup;)Landroid/view/View;': (v, s, [id, p]) => { const x = inflateId(id, p); if (p) el(p).append(el(x)); return x },
    'inflate(ILandroid/view/ViewGroup;Z)Landroid/view/View;': (v, s, [id, p, attach]) => { const x = inflateId(id, p); if (p && attach) el(p).append(el(x)); return x },
  })

  // ---------- activity, context, intents ----------
  let activityObj: JObject = null as any
  let content: JObject | null = null
  let menuItems: JObject[] = []
  const contextMethods: Record<string, NativeFn> = {
    'getString(I)Ljava/lang/String;': (v, s, [id]) => resString(id),
    'getString(I[Ljava/lang/Object;)Ljava/lang/String;': (v, s, [id, a]) => jformat(vm, resString(id), a ? [...a.data] : []),
    'getText(I)Ljava/lang/CharSequence;': (v, s, [id]) => resString(id),
    'getResources()Landroid/content/res/Resources;': () => resources,
    'getPackageName()Ljava/lang/String;': () => env.pkg,
    'getApplicationContext()Landroid/content/Context;': (v, s) => s,
    'getSharedPreferences(Ljava/lang/String;I)Landroid/content/SharedPreferences;': (v, s, [name]) => prefsFor(name),
    'getSystemService(Ljava/lang/String;)Ljava/lang/Object;': (v, s, [name]) => { if (name === 'vibrator') return new JObject(vm.cls('Landroid/os/Vibrator;')); if (name === 'layout_inflater') return new JObject(vm.cls('Landroid/view/LayoutInflater;')); if (name === 'audio') return new JObject(vm.cls('Landroid/media/AudioManager;')); vm.missing.add('system service ' + name); return null },
    'startActivity(Landroid/content/Intent;)V': (v, s, [i]) => startActivity(i),
    'getMainLooper()Landroid/os/Looper;': () => new JObject(vm.cls('Landroid/os/Looper;')),
  }
  def('Landroid/content/Context;', OBJ, contextMethods, { statics: { MODE_PRIVATE: 0, VIBRATOR_SERVICE: 'vibrator', LAYOUT_INFLATER_SERVICE: 'layout_inflater' } })
  def('Landroid/content/ContextWrapper;', 'Landroid/content/Context;', {})
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
    'runOnUiThread(Ljava/lang/Runnable;)V': (v, s, [r]) => runSafe(r),
    'getLayoutInflater()Landroid/view/LayoutInflater;': () => new JObject(vm.cls('Landroid/view/LayoutInflater;')),
    'invalidateOptionsMenu()V': () => buildMenu(),
    'requestWindowFeature(I)Z': () => 1,
    'isFinishing()Z': () => 0,
    'getActionBar()Landroid/app/ActionBar;': () => new JObject(vm.cls('Landroid/app/ActionBar;')),
  })
  def('Landroid/app/ActionBar;', OBJ, { 'setTitle(Ljava/lang/CharSequence;)V': (v, s, [t]) => env.droid.actionbar.title(textOf(t)), 'hide()V': () => env.droid.actionbar.hide(), 'show()V': () => env.droid.actionbar.show(), 'setDisplayHomeAsUpEnabled(Z)V': noop })
  def('Landroid/view/Window;', OBJ, { 'setFlags(II)V': (v, s, [f]) => { if (f & 0x400) env.droid.system.fullscreen(true).catch(() => {}) }, 'addFlags(I)V': (v, s, [f]) => { if (f & 0x80) env.droid.system.keepawake(true) }, 'setSoftInputMode(I)V': noop })
  def('Landroid/app/Application;', 'Landroid/content/ContextWrapper;', { 'onCreate()V': noop })
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

  const setContent = (v: JObject) => {
    content = v
    env.root.innerHTML = ''
    const e = el(v)
    e.classList.add('an-root')
    env.root.append(e)
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
  function prefsFor(name: string) {
    const p = new JObject(vm.cls('Landroid/content/SharedPreferences;'))
    const key = (k: string) => `sp:${name}:${k}`
    const get = (k: string, d: any) => (env.prefs.has(key(k)) ? env.prefs.get(key(k)) : d)
    const m = p.cls.methods
    const add = (k: string, fn: NativeFn, cls = p.cls) => cls.methods.set(k, { cls, name: k.slice(0, k.indexOf('(')), key: k, desc: k.slice(k.indexOf('(')), ret: k.slice(k.indexOf(')') + 1), params: [], flags: 1, code: null, native: fn })
    if (!m.size) {
      add('getInt(Ljava/lang/String;I)I', (v, s, [k, d]) => get(k, d))
      add('getLong(Ljava/lang/String;J)J', (v, s, [k, d]) => { const x = get(k, null); return x == null ? d : BigInt(x) })
      add('getBoolean(Ljava/lang/String;Z)Z', (v, s, [k, d]) => get(k, d))
      add('getFloat(Ljava/lang/String;F)F', (v, s, [k, d]) => get(k, d))
      add('getString(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', (v, s, [k, d]) => get(k, d))
      add('contains(Ljava/lang/String;)Z', (v, s, [k]) => (env.prefs.has(key(k)) ? 1 : 0))
      add('edit()Landroid/content/SharedPreferences$Editor;', () => {
        const ed = new JObject(vm.cls('Landroid/content/SharedPreferences$Editor;'))
        ed.f.pending = new Map()
        return ed
      })
      const E = vm.cls('Landroid/content/SharedPreferences$Editor;')
      const put = (sig: string, conv = (x: any) => x) => add(`put${sig}`, (v, s, [k, x]) => { s.f.pending.set(key(k), conv(x)); return s }, E)
      put('Int(Ljava/lang/String;I)Landroid/content/SharedPreferences$Editor;')
      put('Long(Ljava/lang/String;J)Landroid/content/SharedPreferences$Editor;', (x) => String(x))
      put('Boolean(Ljava/lang/String;Z)Landroid/content/SharedPreferences$Editor;')
      put('Float(Ljava/lang/String;F)Landroid/content/SharedPreferences$Editor;')
      put('String(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;')
      add('remove(Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;', (v, s, [k]) => { s.f.pending.set(key(k), undefined); return s }, E)
      add('clear()Landroid/content/SharedPreferences$Editor;', (v, s) => { for (const k of env.prefs.keys()) if (k.startsWith(`sp:${name}:`)) s.f.pending.set(k, undefined); return s }, E)
      const commit: NativeFn = (v, s) => {
        for (const [k, x] of s.f.pending) {
          if (x === undefined) { env.prefs.delete(k); env.droid.prefs.remove(k) } else { env.prefs.set(k, x); env.droid.prefs.set(k, x) }
        }
        s.f.pending.clear()
        return 1
      }
      add('commit()Z', commit, E)
      add('apply()V', commit, E)
    }
    return p
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
  def('Landroid/os/SystemClock;', OBJ, { 'uptimeMillis()J': () => BigInt(Math.round(performance.now())), 'elapsedRealtime()J': () => BigInt(Math.round(performance.now())), 'sleep(J)V': noop })
  def('Landroid/os/Build$VERSION;', OBJ, {}, { statics: { SDK_INT: 19, RELEASE: '4.4' } })
  def('Landroid/os/Build;', OBJ, {}, { statics: { MODEL: 'droid', MANUFACTURER: 'danen', BRAND: 'danen', DEVICE: 'droid', PRODUCT: 'droid' } })
  def('Landroid/graphics/Color;', OBJ, {
    'rgb(III)I': (v, s, [r, g, b]) => (0xff000000 | (r << 16) | (g << 8) | b) | 0,
    'argb(IIII)I': (v, s, [a, r, g, b]) => ((a << 24) | (r << 16) | (g << 8) | b) | 0,
    'parseColor(Ljava/lang/String;)I': (v, s, [x]) => { const h = x.replace('#', ''); return (parseInt(h.length === 6 ? 'ff' + h : h, 16)) | 0 },
  }, { statics: { BLACK: 0xff000000 | 0, WHITE: -1, RED: 0xffff0000 | 0, GREEN: 0xff00ff00 | 0, BLUE: 0xff0000ff | 0, TRANSPARENT: 0, GRAY: 0xff888888 | 0 } })
  def('Landroid/text/TextUtils;', OBJ, { 'isEmpty(Ljava/lang/CharSequence;)Z': (v, s, [t]) => (t == null || jstr(vm, t).length === 0 ? 1 : 0) })

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
  return {
    start(className: string, saved: any) {
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
  }
}
export { JArray }
