// more of android.widget / android.view / android.graphics for converted apps:
// drawables and bitmaps (images decode in the background; their size is known at once from the
// file header), backgrounds, TextView extras (typeface, ellipsize, max lines, shadows, compound
// drawables), a real in-app AlertDialog (lists, single / multi choice, custom views, three buttons)
// and ProgressDialog, AsyncTask on green threads, Spinner, AutoCompleteTextView, SeekBar,
// HorizontalScrollView, TabHost / TabWidget, MenuInflater (menu xml), GestureDetector,
// ViewPropertyAnimator, AttributeSet / TypedArray, and smaller pieces.
import { VM, JObject, JArray, type NativeFn } from './dalvik.ts'
import { jstr } from './java.ts'
import { parseAxml, attr, T, type XmlNode, type XmlValue } from './axml.ts'
import type { Env } from './android.ts'

const OBJ = 'Ljava/lang/Object;'
const D = 'Landroid/graphics/drawable/Drawable;'

export interface WidgetHelpers {
  el: (v: JObject) => HTMLElement
  report: (e: unknown) => void
  activity: () => JObject
  res: (id: number) => XmlValue | undefined
  drawableUrl: (id: number) => string
  resString: (id: number) => string
  valueText: (v: XmlValue | undefined) => string | undefined
  cssColor: (argb: number) => string
  renderList: (list: JObject) => void
  views: Map<number, JObject>
  setText: (s: JObject, t: string) => void
  getText: (s: JObject) => string
  addMenuItem: (id: number, title: string, icon?: string, order?: number) => JObject
  newView: (cls: string, tag: string, className?: string) => JObject
}

// width / height straight from a png / jpeg / gif / webp header
export function imageSize(b: Uint8Array): [number, number] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return [dv.getUint32(16), dv.getUint32(20)]
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return [dv.getUint16(6, true), dv.getUint16(8, true)]
  if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57) { // webp
    const k = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (k === 'VP8 ') return [dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff]
    if (k === 'VP8L') { const x = dv.getUint32(21, true); return [(x & 0x3fff) + 1, ((x >> 14) & 0x3fff) + 1] }
    if (k === 'VP8X') return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))]
  }
  if (b[0] === 0xff && b[1] === 0xd8) { // jpeg: the first start-of-frame
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1], len = dv.getUint16(i + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [dv.getUint16(i + 7), dv.getUint16(i + 5)]
      i += 2 + len
    }
  }
  return [0, 0]
}
const mimeOf = (b: Uint8Array) => (b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : b[0] === 0x47 ? 'image/gif' : b[0] === 0x52 ? 'image/webp' : 'application/octet-stream')

// classes whose parent here is more exact than the older shims'
const FORCE = new Set(['Landroid/widget/ListView;', 'Landroid/widget/GridView;', 'Landroid/widget/AbsListView;', 'Landroid/widget/Spinner;', 'Landroid/widget/AbsSpinner;', 'Landroid/widget/SeekBar;', 'Landroid/widget/AbsSeekBar;', 'Landroid/widget/AutoCompleteTextView;', 'Landroid/widget/ImageButton;', 'Landroid/widget/TabWidget;', 'Landroid/widget/TabHost;', 'Landroid/widget/HorizontalScrollView;', 'Landroid/widget/ScrollView;', 'Landroid/app/ProgressDialog;', 'Landroid/app/AlertDialog;', 'Landroid/graphics/drawable/BitmapDrawable;', 'Landroid/graphics/drawable/ColorDrawable;', 'Landroid/graphics/drawable/GradientDrawable;'])

export function registerWidgets(vm: VM, env: Env, w: WidgetHelpers) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => {
    const old = vm.shims.get(name)
    vm.shim(name, { super: FORCE.has(name) ? sup : old?.super ?? sup, interfaces: [...(old?.interfaces || []), ...(extra.interfaces || [])], methods: { ...(old?.methods || {}), ...methods }, statics: { ...(old?.statics || {}), ...(extra.statics || {}) } })
  }
  const obj = (cls: string, f: Record<string, any> = {}) => { const o = new JObject(vm.cls(cls)); Object.assign(o.f, f); return o }
  const noop: NativeFn = () => {}
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  const el = w.el
  const dp = env.density
  const call = (l: any, key: string, args: any[] = []) => { if (l) try { return vm.callVirtual(l, key, args) } catch (e) { w.report(e) } }

  // ---------- bitmaps ----------
  const BMP = 'Landroid/graphics/Bitmap;'
  // a bitmap: a canvas (drawn into once the image has decoded), or an url for an <img>
  const bitmapFromBytes = (b: Uint8Array) => {
    const [width, height] = imageSize(b)
    if (!width && !height) return null
    const url = URL.createObjectURL(new Blob([b.slice() as BlobPart], { type: mimeOf(b) }))
    return obj(BMP, { width, height, url, recycled: false })
  }
  const bitmapUrl = (bm: JObject): string => {
    if (bm.f.canvas && bm.f.dirty !== false) { try { bm.f.url = (bm.f.canvas as HTMLCanvasElement).toDataURL(); bm.f.dirty = false } catch { /* tainted */ } }
    return bm.f.url || ''
  }
  const newBitmap = (width: number, height: number) => {
    const c = document.createElement('canvas'); c.width = Math.max(1, width); c.height = Math.max(1, height)
    return obj(BMP, { width, height, canvas: c, dirty: true, recycled: false })
  }
  const readAll = (is: JObject): Uint8Array => {
    const out: number[] = []
    const buf = vm.newArray('[B', 8192)
    for (;;) {
      const n = vm.callVirtual(is, 'read([BII)I', [buf, 0, 8192]) as number
      if (n <= 0) break
      for (let i = 0; i < n; i++) out.push((buf.data as Int8Array)[i] & 0xff)
    }
    return new Uint8Array(out)
  }
  def(BMP, OBJ, {
    'getWidth()I': (v, s) => s.f.width, 'getHeight()I': (v, s) => s.f.height,
    'getScaledWidth(I)I': (v, s) => s.f.width, 'getScaledHeight(I)I': (v, s) => s.f.height,
    'isRecycled()Z': (v, s) => (s.f.recycled ? 1 : 0), 'recycle()V': (v, s) => { s.f.recycled = true },
    'isMutable()Z': (v, s) => (s.f.canvas ? 1 : 0), 'hasAlpha()Z': () => 1,
    'getByteCount()I': (v, s) => s.f.width * s.f.height * 4, 'getRowBytes()I': (v, s) => s.f.width * 4,
    'getConfig()Landroid/graphics/Bitmap$Config;': () => vm.cls('Landroid/graphics/Bitmap$Config;').staticValues.ARGB_8888,
    'createBitmap(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;': (v, s, [wd, ht]) => newBitmap(wd, ht),
    'createScaledBitmap(Landroid/graphics/Bitmap;IIZ)Landroid/graphics/Bitmap;': (v, s, [b, wd, ht]) => obj(BMP, { ...b.f, width: wd, height: ht }),
    'createBitmap(Landroid/graphics/Bitmap;)Landroid/graphics/Bitmap;': (v, s, [b]) => obj(BMP, { ...b.f }),
    'createBitmap(Landroid/graphics/Bitmap;IIII)Landroid/graphics/Bitmap;': (v, s, [b, , , wd, ht]) => obj(BMP, { ...b.f, width: wd, height: ht }),
    'compress(Landroid/graphics/Bitmap$CompressFormat;ILjava/io/OutputStream;)Z': () => 0,
    'copy(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;': (v, s) => obj(BMP, { ...s.f }),
  })
  def('Landroid/graphics/Bitmap$Config;', OBJ, {}, { statics: {} })
  const cfg = vm.cls('Landroid/graphics/Bitmap$Config;')
  for (const n of ['ALPHA_8', 'RGB_565', 'ARGB_4444', 'ARGB_8888']) cfg.staticValues[n] = obj('Landroid/graphics/Bitmap$Config;', { name: n })
  def('Landroid/graphics/Bitmap$CompressFormat;', OBJ, {})
  const cf = vm.cls('Landroid/graphics/Bitmap$CompressFormat;')
  for (const n of ['JPEG', 'PNG', 'WEBP']) cf.staticValues[n] = obj('Landroid/graphics/Bitmap$CompressFormat;', { name: n })
  const resBytes = (id: number) => { const v = w.res(id); return v?.type === T.STRING ? env.files.get(v.str!) : undefined }
  def('Landroid/graphics/BitmapFactory;', OBJ, {
    'decodeResource(Landroid/content/res/Resources;I)Landroid/graphics/Bitmap;': (v, s, [, id]) => { const b = resBytes(id); return b ? bitmapFromBytes(b) : null },
    'decodeResource(Landroid/content/res/Resources;ILandroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;': (v, s, [, id, o]) => decodeWith(resBytes(id), o),
    'decodeByteArray([BII)Landroid/graphics/Bitmap;': (v, s, [a, off, len]) => bitmapFromBytes(new Uint8Array((a.data as Int8Array).buffer, (a.data as Int8Array).byteOffset + off, len)),
    'decodeByteArray([BIILandroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;': (v, s, [a, off, len, o]) => decodeWith(new Uint8Array((a.data as Int8Array).buffer, (a.data as Int8Array).byteOffset + off, len), o),
    'decodeStream(Ljava/io/InputStream;)Landroid/graphics/Bitmap;': (v, s, [is]) => (is ? bitmapFromBytes(readAll(is)) : null),
    'decodeStream(Ljava/io/InputStream;Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;': (v, s, [is, , o]) => (is ? decodeWith(readAll(is), o) : null),
    'decodeFile(Ljava/lang/String;)Landroid/graphics/Bitmap;': (v, s, [p]) => { const b = (env as any).vfs?.read(text(p)); return b ? bitmapFromBytes(b) : null },
    'decodeFile(Ljava/lang/String;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;': (v, s, [p, o]) => decodeWith((env as any).vfs?.read(text(p)), o),
  })
  // Options: inJustDecodeBounds fills outWidth / outHeight only; inSampleSize scales the size
  const decodeWith = (b: Uint8Array | undefined, o: JObject | null) => {
    if (!b) return null
    const [wd, ht] = imageSize(b)
    const k = Math.max(1, o?.f.inSampleSize | 0 || 1)
    if (o) { o.f.outWidth = Math.floor(wd / k); o.f.outHeight = Math.floor(ht / k); o.f.outMimeType = mimeOf(b) }
    if (o?.f.inJustDecodeBounds) return null
    const bm = bitmapFromBytes(b)
    if (bm && k > 1) { bm.f.width = Math.floor(wd / k); bm.f.height = Math.floor(ht / k) }
    return bm
  }
  def('Landroid/graphics/BitmapFactory$Options;', OBJ, { '<init>()V': (v, s) => { Object.assign(s.f, { inJustDecodeBounds: 0, inSampleSize: 1, outWidth: 0, outHeight: 0, inPurgeable: 0, inInputShareable: 0, inScaled: 1, inDither: 0, inPreferredConfig: null, outMimeType: null }) } })

  // ---------- drawables ----------
  // a drawable: an image url, a color, or a bitmap; bounds and a color filter
  const drawable = (f: Record<string, any>, cls = D) => obj(cls, { bounds: [0, 0, 0, 0], alpha: 255, ...f })
  const resDrawable = (id: number): JObject | null => {
    if (!id) return null
    const v = w.res(id)
    if (!v) return null
    if (v.type >= T.COLOR_ARGB8 && v.type <= T.COLOR_RGB4) return drawable({ color: v.data | 0 }, 'Landroid/graphics/drawable/ColorDrawable;')
    const url = w.drawableUrl(id)
    if (!url) return drawable({ resId: id })
    const b = resBytes(id)
    const [iw, ih] = b ? imageSize(b) : [0, 0]
    return drawable({ url, resId: id, iw: Math.round(iw / 1.5), ih: Math.round(ih / 1.5) }, 'Landroid/graphics/drawable/BitmapDrawable;')
  }
  // css for a drawable as a background
  const cssBackground = (d: JObject | null) => {
    if (!d) return ''
    if (d.f.color !== undefined) return w.cssColor(d.f.color)
    if (d.f.bitmap) return `center / 100% 100% no-repeat url("${bitmapUrl(d.f.bitmap)}")`
    if (d.f.url) return `center / 100% 100% no-repeat url("${d.f.url}")`
    return ''
  }
  const drawableUrlOf = (d: JObject | null) => (!d ? '' : d.f.bitmap ? bitmapUrl(d.f.bitmap) : d.f.url || '')
  const filterOf = (d: JObject) => (d.f.tint !== undefined ? `drop-shadow(0 0 0 ${w.cssColor(d.f.tint)})` : '')
  const dMethods: Record<string, NativeFn> = {
    'setBounds(IIII)V': (v, s, [l, t, r, b]) => { s.f.bounds = [l, t, r, b] },
    'setBounds(Landroid/graphics/Rect;)V': (v, s, [rc]) => { s.f.bounds = [rc.f.left | 0, rc.f.top | 0, rc.f.right | 0, rc.f.bottom | 0] },
    'getBounds()Landroid/graphics/Rect;': (v, s) => obj('Landroid/graphics/Rect;', { left: s.f.bounds[0], top: s.f.bounds[1], right: s.f.bounds[2], bottom: s.f.bounds[3] }),
    'copyBounds()Landroid/graphics/Rect;': (v, s) => obj('Landroid/graphics/Rect;', { left: s.f.bounds[0], top: s.f.bounds[1], right: s.f.bounds[2], bottom: s.f.bounds[3] }),
    'getIntrinsicWidth()I': (v, s) => Math.round((s.f.iw ?? s.f.bitmap?.f.width ?? -1) * (s.f.iw !== undefined ? dp : 1)),
    'getIntrinsicHeight()I': (v, s) => Math.round((s.f.ih ?? s.f.bitmap?.f.height ?? -1) * (s.f.ih !== undefined ? dp : 1)),
    'getMinimumWidth()I': () => 0, 'getMinimumHeight()I': () => 0,
    'mutate()Landroid/graphics/drawable/Drawable;': (v, s) => s,
    'setColorFilter(ILandroid/graphics/PorterDuff$Mode;)V': (v, s, [c]) => { s.f.tint = c },
    'setColorFilter(Landroid/graphics/ColorFilter;)V': (v, s, [f]) => { if (f?.f.color !== undefined) s.f.tint = f.f.color; else delete s.f.tint },
    'clearColorFilter()V': (v, s) => { delete s.f.tint },
    'setAlpha(I)V': (v, s, [a]) => { s.f.alpha = a }, 'getAlpha()I': (v, s) => s.f.alpha,
    'setCallback(Landroid/graphics/drawable/Drawable$Callback;)V': noop, 'invalidateSelf()V': noop,
    'setLevel(I)Z': () => 0, 'setState([I)Z': () => 0, 'getState()[I': () => vm.newArray('[I', 0),
    'getConstantState()Landroid/graphics/drawable/Drawable$ConstantState;': () => null,
    'draw(Landroid/graphics/Canvas;)V': noop, 'getOpacity()I': () => -3,
    'setVisible(ZZ)Z': () => 1, 'isVisible()Z': () => 1, 'setDither(Z)V': noop, 'setFilterBitmap(Z)V': noop,
  }
  def(D, OBJ, dMethods, { statics: {} })
  def('Landroid/graphics/drawable/BitmapDrawable;', D, {
    '<init>(Landroid/graphics/Bitmap;)V': (v, s, [b]) => { Object.assign(s.f, { bounds: [0, 0, 0, 0], alpha: 255, bitmap: b }) },
    '<init>(Landroid/content/res/Resources;Landroid/graphics/Bitmap;)V': (v, s, [, b]) => { Object.assign(s.f, { bounds: [0, 0, 0, 0], alpha: 255, bitmap: b }) },
    'getBitmap()Landroid/graphics/Bitmap;': (v, s) => s.f.bitmap ?? null,
    'setAntiAlias(Z)V': noop, 'setGravity(I)V': noop, 'setTileModeXY(Landroid/graphics/Shader$TileMode;Landroid/graphics/Shader$TileMode;)V': noop,
  })
  def('Landroid/graphics/drawable/ColorDrawable;', D, {
    '<init>()V': (v, s) => { Object.assign(s.f, { bounds: [0, 0, 0, 0], alpha: 255, color: 0 }) },
    '<init>(I)V': (v, s, [c]) => { Object.assign(s.f, { bounds: [0, 0, 0, 0], alpha: 255, color: c }) },
    'setColor(I)V': (v, s, [c]) => { s.f.color = c }, 'getColor()I': (v, s) => s.f.color,
  })
  def('Landroid/graphics/drawable/GradientDrawable;', D, {
    '<init>()V': (v, s) => { Object.assign(s.f, { bounds: [0, 0, 0, 0], alpha: 255, color: 0 }) },
    'setColor(I)V': (v, s, [c]) => { s.f.color = c }, 'setCornerRadius(F)V': (v, s, [r]) => { s.f.radius = r }, 'setStroke(II)V': (v, s, [wd, c]) => { s.f.stroke = [wd, c] }, 'setShape(I)V': noop,
  })
  def('Landroid/graphics/drawable/StateListDrawable;', D, { '<init>()V': (v, s) => { Object.assign(s.f, { bounds: [0, 0, 0, 0], alpha: 255 }) }, 'addState([ILandroid/graphics/drawable/Drawable;)V': (v, s, [st, d]) => { if (!s.f.first || !st.data.length) Object.assign(s.f, { url: d?.f.url, color: d?.f.color, bitmap: d?.f.bitmap, first: true }) } })
  def('Landroid/graphics/drawable/AnimationDrawable;', D, { '<init>()V': (v, s) => { Object.assign(s.f, { bounds: [0, 0, 0, 0], alpha: 255 }) }, 'start()V': noop, 'stop()V': noop, 'addFrame(Landroid/graphics/drawable/Drawable;I)V': (v, s, [d]) => { if (!s.f.url) Object.assign(s.f, { url: d?.f.url }) }, 'setOneShot(Z)V': noop, 'isRunning()Z': () => 0 })
  def('Landroid/graphics/drawable/TransitionDrawable;', D, { 'startTransition(I)V': noop, 'resetTransition()V': noop, 'setCrossFadeEnabled(Z)V': noop })
  def('Landroid/graphics/PorterDuffColorFilter;', 'Landroid/graphics/ColorFilter;', { '<init>(ILandroid/graphics/PorterDuff$Mode;)V': (v, s, [c]) => { s.f.color = c } })
  def('Landroid/graphics/LightingColorFilter;', 'Landroid/graphics/ColorFilter;', { '<init>(II)V': (v, s, [, add]) => { s.f.color = add | 0xff000000 } })
  def('Landroid/graphics/ColorFilter;', OBJ, {})
  def('Landroid/graphics/PorterDuff$Mode;', OBJ, {})
  const pdm = vm.cls('Landroid/graphics/PorterDuff$Mode;')
  for (const n of ['CLEAR', 'SRC', 'DST', 'SRC_OVER', 'DST_OVER', 'SRC_IN', 'DST_IN', 'SRC_OUT', 'DST_OUT', 'SRC_ATOP', 'DST_ATOP', 'XOR', 'DARKEN', 'LIGHTEN', 'MULTIPLY', 'SCREEN', 'ADD', 'OVERLAY']) pdm.staticValues[n] = obj('Landroid/graphics/PorterDuff$Mode;', { name: n })
  def('Landroid/graphics/Typeface;', OBJ, {
    'create(Ljava/lang/String;I)Landroid/graphics/Typeface;': (v, s, [fam, st]) => obj('Landroid/graphics/Typeface;', { family: text(fam), style: st }),
    'create(Landroid/graphics/Typeface;I)Landroid/graphics/Typeface;': (v, s, [t, st]) => obj('Landroid/graphics/Typeface;', { family: t?.f.family ?? '', style: st }),
    'defaultFromStyle(I)Landroid/graphics/Typeface;': (v, s, [st]) => obj('Landroid/graphics/Typeface;', { family: '', style: st }),
    'createFromAsset(Landroid/content/res/AssetManager;Ljava/lang/String;)Landroid/graphics/Typeface;': () => obj('Landroid/graphics/Typeface;', { family: '', style: 0 }),
    'getStyle()I': (v, s) => s.f.style ?? 0, 'isBold()Z': (v, s) => ((s.f.style ?? 0) & 1 ? 1 : 0), 'isItalic()Z': (v, s) => ((s.f.style ?? 0) & 2 ? 1 : 0),
  }, { statics: { NORMAL: 0, BOLD: 1, ITALIC: 2, BOLD_ITALIC: 3 } })
  const tf = vm.cls('Landroid/graphics/Typeface;')
  Object.assign(tf.staticValues, { DEFAULT: obj('Landroid/graphics/Typeface;', { family: '', style: 0 }), DEFAULT_BOLD: obj('Landroid/graphics/Typeface;', { family: '', style: 1 }), SANS_SERIF: obj('Landroid/graphics/Typeface;', { family: 'sans-serif', style: 0 }), SERIF: obj('Landroid/graphics/Typeface;', { family: 'serif', style: 0 }), MONOSPACE: obj('Landroid/graphics/Typeface;', { family: 'monospace', style: 0 }) })

  // ---------- view: backgrounds, scrolling, focus, animation ----------
  const setBg = (s: JObject, d: JObject | null) => { s.f.background = d; el(s).style.background = cssBackground(d) }
  def('Landroid/view/View;', OBJ, {
    'setBackgroundResource(I)V': (v, s, [id]) => setBg(s, resDrawable(id)),
    'setBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V': (v, s, [d]) => setBg(s, d),
    'setBackground(Landroid/graphics/drawable/Drawable;)V': (v, s, [d]) => setBg(s, d),
    'getBackground()Landroid/graphics/drawable/Drawable;': (v, s) => s.f.background ?? null,
    'performClick()Z': (v, s) => { el(s).click(); return 1 },
    'callOnClick()Z': (v, s) => { el(s).click(); return 1 },
    'scrollBy(II)V': (v, s, [x, y]) => { el(s).scrollBy(x / dp, y / dp) },
    'scrollTo(II)V': (v, s, [x, y]) => { el(s).scrollTo(x / dp, y / dp) },
    'getScrollX()I': (v, s) => Math.round(el(s).scrollLeft * dp), 'getScrollY()I': (v, s) => Math.round(el(s).scrollTop * dp),
    'getTop()I': (v, s) => Math.round(el(s).offsetTop * dp), 'getLeft()I': (v, s) => Math.round(el(s).offsetLeft * dp),
    'getBottom()I': (v, s) => Math.round((el(s).offsetTop + el(s).offsetHeight) * dp), 'getRight()I': (v, s) => Math.round((el(s).offsetLeft + el(s).offsetWidth) * dp),
    'setPivotX(F)V': (v, s, [x]) => { s.f.pivotX = x; el(s).style.transformOrigin = `${(x / dp) || 0}px ${(s.f.pivotY ?? 0) / dp}px` },
    'setPivotY(F)V': (v, s, [y]) => { s.f.pivotY = y; el(s).style.transformOrigin = `${(s.f.pivotX ?? 0) / dp}px ${(y / dp) || 0}px` },
    'setScaleX(F)V': (v, s, [x]) => { s.f.scaleX = x; transform(s) }, 'setScaleY(F)V': (v, s, [y]) => { s.f.scaleY = y; transform(s) },
    'setTranslationX(F)V': (v, s, [x]) => { s.f.tx = x; transform(s) }, 'setTranslationY(F)V': (v, s, [y]) => { s.f.ty = y; transform(s) },
    'setRotation(F)V': (v, s, [r]) => { s.f.rot = r; transform(s) },
    'getScaleX()F': (v, s) => s.f.scaleX ?? 1, 'getScaleY()F': (v, s) => s.f.scaleY ?? 1, 'getTranslationX()F': (v, s) => s.f.tx ?? 0, 'getTranslationY()F': (v, s) => s.f.ty ?? 0,
    'animate()Landroid/view/ViewPropertyAnimator;': (v, s) => obj('Landroid/view/ViewPropertyAnimator;', { view: s, props: {}, duration: 300 }),
    'hasFocus()Z': (v, s) => (el(s).contains(document.activeElement) ? 1 : 0),
    'isFocused()Z': (v, s) => (document.activeElement === el(s) ? 1 : 0),
    'requestFocus(I)Z': (v, s) => { el(s).focus?.(); return 1 },
    'setNextFocusLeftId(I)V': noop, 'setNextFocusRightId(I)V': noop, 'setNextFocusUpId(I)V': noop, 'setNextFocusDownId(I)V': noop,
    'getWindowToken()Landroid/os/IBinder;': () => obj('Landroid/os/IBinder;'),
    'setSelected(Z)V': (v, s, [x]) => { el(s).classList.toggle('selected', !!x) }, 'isSelected()Z': (v, s) => (el(s).classList.contains('selected') ? 1 : 0),
    'setActivated(Z)V': (v, s, [x]) => { el(s).classList.toggle('activated', !!x) },
    'setLayerType(ILandroid/graphics/Paint;)V': noop, 'setDrawingCacheEnabled(Z)V': noop,
  })
  const transform = (s: JObject) => {
    const f = s.f
    el(s).style.transform = `translate(${(f.tx ?? 0) / dp}px, ${(f.ty ?? 0) / dp}px) scale(${f.scaleX ?? 1}, ${f.scaleY ?? 1}) rotate(${f.rot ?? 0}deg)`
  }
  const VPA = 'Landroid/view/ViewPropertyAnimator;'
  const vpaSet = (k: string): NativeFn => (v, s, [x]) => { s.f.props[k] = x; return s }
  def(VPA, OBJ, {
    'scaleX(F)Landroid/view/ViewPropertyAnimator;': vpaSet('scaleX'), 'scaleY(F)Landroid/view/ViewPropertyAnimator;': vpaSet('scaleY'),
    'translationX(F)Landroid/view/ViewPropertyAnimator;': vpaSet('tx'), 'translationY(F)Landroid/view/ViewPropertyAnimator;': vpaSet('ty'),
    'rotation(F)Landroid/view/ViewPropertyAnimator;': vpaSet('rot'), 'alpha(F)Landroid/view/ViewPropertyAnimator;': vpaSet('alpha'),
    'setDuration(J)Landroid/view/ViewPropertyAnimator;': (v, s, [d]) => { s.f.duration = Number(d); return s },
    'setStartDelay(J)Landroid/view/ViewPropertyAnimator;': (v, s, [d]) => { s.f.delay = Number(d); return s },
    'setInterpolator(Landroid/animation/TimeInterpolator;)Landroid/view/ViewPropertyAnimator;': (v, s) => s,
    'setListener(Landroid/animation/Animator$AnimatorListener;)Landroid/view/ViewPropertyAnimator;': (v, s, [l]) => { s.f.listener = l; return s },
    'withEndAction(Ljava/lang/Runnable;)Landroid/view/ViewPropertyAnimator;': (v, s, [r]) => { s.f.end = r; return s },
    'start()V': (v, s) => runAnim(s), 'cancel()V': noop,
  })
  const runAnim = (s: JObject) => {
    if (s.f.started) return
    s.f.started = true
    const view = s.f.view as JObject, e = el(view)
    e.style.transition = `transform ${s.f.duration}ms, opacity ${s.f.duration}ms`
    setTimeout(() => {
      Object.assign(view.f, Object.fromEntries(Object.entries(s.f.props).filter(([k]) => k !== 'alpha')))
      if ('alpha' in s.f.props) e.style.opacity = String(s.f.props.alpha)
      transform(view)
      setTimeout(() => { if (s.f.end) call(s.f.end, 'run()V'); if (s.f.listener) call(s.f.listener, 'onAnimationEnd(Landroid/animation/Animator;)V', [null]) }, s.f.duration)
    }, s.f.delay ?? 0)
  }
  // animate() without start() starts on the next frame, like android
  const animOrig = vm.shims.get('Landroid/view/View;')!.methods!['animate()Landroid/view/ViewPropertyAnimator;']
  def('Landroid/view/View;', OBJ, { 'animate()Landroid/view/ViewPropertyAnimator;': (v, s, a) => { const x = animOrig(v, s, a) as JObject; setTimeout(() => runAnim(x), 0); return x } })
  def('Landroid/view/ViewGroup;', 'Landroid/view/View;', {
    'indexOfChild(Landroid/view/View;)I': (v, s, [c]) => [...el(s).children].indexOf(el(c)),
  })
  def('Landroid/view/View$MeasureSpec;', OBJ, {
    'getSize(I)I': (v, s, [m]) => m & 0x3fffffff, 'getMode(I)I': (v, s, [m]) => m & 0xc0000000 | 0,
    'makeMeasureSpec(II)I': (v, s, [sz, mode]) => ((sz & 0x3fffffff) | (mode & 0xc0000000)) | 0,
  }, { statics: { UNSPECIFIED: 0, EXACTLY: 0x40000000, AT_MOST: 0x80000000 | 0 } })
  def('Landroid/view/ViewConfiguration;', OBJ, {
    'get(Landroid/content/Context;)Landroid/view/ViewConfiguration;': () => obj('Landroid/view/ViewConfiguration;'),
    'getScaledTouchSlop()I': () => Math.round(8 * dp), 'getScaledPagingTouchSlop()I': () => Math.round(16 * dp), 'getScaledDoubleTapSlop()I': () => Math.round(100 * dp),
    'getScaledMinimumFlingVelocity()I': () => Math.round(50 * dp), 'getScaledMaximumFlingVelocity()I': () => Math.round(8000 * dp),
    'hasPermanentMenuKey()Z': () => 0, 'getTapTimeout()I': () => 100, 'getLongPressTimeout()I': () => 500, 'getDoubleTapTimeout()I': () => 300,
  })
  def('Landroid/view/KeyCharacterMap;', OBJ, { 'deviceHasKey(I)Z': (v, s, [k]) => (k === 4 || k === 3 || k === 82 ? 1 : 0), 'load(I)Landroid/view/KeyCharacterMap;': () => obj('Landroid/view/KeyCharacterMap;') })
  def('Landroid/util/TypedValue;', OBJ, {
    '<init>()V': noop,
    'applyDimension(IFLandroid/util/DisplayMetrics;)F': (v, s, [unit, x]) => Math.fround(unit === 0 ? x : unit === 1 ? x * dp : unit === 2 ? x * dp : unit === 3 ? x * dp * 160 / 72 : unit === 4 ? x * dp * 160 : unit === 5 ? x * dp * 160 / 25.4 : x),
  }, { statics: { COMPLEX_UNIT_PX: 0, COMPLEX_UNIT_DIP: 1, COMPLEX_UNIT_SP: 2, COMPLEX_UNIT_PT: 3, COMPLEX_UNIT_IN: 4, COMPLEX_UNIT_MM: 5, TYPE_NULL: 0, TYPE_REFERENCE: 1, TYPE_STRING: 3, TYPE_FLOAT: 4, TYPE_DIMENSION: 5, TYPE_INT_DEC: 16, TYPE_INT_COLOR_ARGB8: 28 } })

  // ---------- text views ----------
  // compound drawables: the text goes into a label span, the images around it
  const compound = (s: JObject, ds: (JObject | null)[]) => {
    s.f.compound = ds
    const e = el(s)
    if (!s.f.label) { const lb = document.createElement('span'); lb.textContent = e.textContent; e.textContent = ''; s.f.label = lb }
    e.querySelectorAll(':scope > img.an-cd').forEach((x) => x.remove())
    e.style.display = 'inline-flex'
    e.style.alignItems = 'center'
    e.style.flexDirection = ds[1] || ds[3] ? 'column' : 'row'
    e.style.gap = ((s.f.cdPad ?? 0) / dp) + 'px'
    const img = (d: JObject) => {
      const i = document.createElement('img'); i.className = 'an-cd'; i.src = drawableUrlOf(d)
      const b = d.f.bounds
      if (b[2] - b[0] > 0) { i.style.width = (b[2] - b[0]) / dp + 'px'; i.style.height = (b[3] - b[1]) / dp + 'px' } else if (d.f.iw) { i.style.width = d.f.iw + 'px'; i.style.height = d.f.ih + 'px' }
      if (d.f.tint !== undefined) { i.style.filter = `opacity(0.999) drop-shadow(0 0 0 ${w.cssColor(d.f.tint)})`; i.style.transform = 'translateX(-9999px)'; i.style.filter = `drop-shadow(9999px 0 0 ${w.cssColor(d.f.tint)})` }
      return i
    }
    const [l, t, r, b] = ds
    if (t) e.append(img(t))
    if (l) e.append(img(l))
    e.append(s.f.label)
    if (r) e.append(img(r))
    if (b) e.append(img(b))
  }
  void filterOf
  def('Landroid/widget/TextView;', 'Landroid/view/View;', {
    'setTypeface(Landroid/graphics/Typeface;I)V': (v, s, [t, st]) => { const e = el(s); const style = st | (t?.f.style ?? 0); e.style.fontWeight = style & 1 ? 'bold' : ''; e.style.fontStyle = style & 2 ? 'italic' : ''; if (t?.f.family) e.style.fontFamily = t.f.family },
    'setTypeface(Landroid/graphics/Typeface;)V': (v, s, [t]) => { const e = el(s); e.style.fontWeight = t?.f.style & 1 ? 'bold' : ''; e.style.fontStyle = t?.f.style & 2 ? 'italic' : ''; if (t?.f.family) e.style.fontFamily = t.f.family },
    'getTypeface()Landroid/graphics/Typeface;': () => tf.staticValues.DEFAULT,
    'setEllipsize(Landroid/text/TextUtils$TruncateAt;)V': (v, s, [t]) => { const e = el(s); if (t) { e.style.overflow = 'hidden'; e.style.textOverflow = 'ellipsis'; if (!s.f.maxLines || s.f.maxLines === 1) e.style.whiteSpace = 'nowrap' } },
    'setMaxLines(I)V': (v, s, [n]) => { s.f.maxLines = n; const e = el(s); e.style.display = '-webkit-box'; (e.style as any).webkitLineClamp = String(n); (e.style as any).webkitBoxOrient = 'vertical'; e.style.overflow = 'hidden' },
    'setLines(I)V': (v, s, [n]) => { el(s).style.height = `${n * 1.3}em` }, 'setMinLines(I)V': noop,
    'setSingleLine(Z)V': (v, s, [x]) => { el(s).style.whiteSpace = x ? 'nowrap' : '' },
    'setShadowLayer(FFFI)V': (v, s, [r, dx, dy, c]) => { el(s).style.textShadow = `${dx / dp}px ${dy / dp}px ${r / dp}px ${w.cssColor(c)}` },
    'setCompoundDrawablePadding(I)V': (v, s, [p]) => { s.f.cdPad = p; el(s).style.gap = p / dp + 'px' },
    'setCompoundDrawables(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V': (v, s, ds) => compound(s, ds),
    'setCompoundDrawablesWithIntrinsicBounds(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V': (v, s, ds) => compound(s, ds),
    'setCompoundDrawablesWithIntrinsicBounds(IIII)V': (v, s, ids) => compound(s, ids.map((id: number) => resDrawable(id))),
    'getCompoundDrawables()[Landroid/graphics/drawable/Drawable;': (v, s) => { const a = vm.newArray('[Landroid/graphics/drawable/Drawable;', 4); (s.f.compound || [null, null, null, null]).forEach((d: any, i: number) => ((a.data as any)[i] = d)); return a },
    'setMaxWidth(I)V': (v, s, [x]) => { el(s).style.maxWidth = x / dp + 'px' }, 'setMaxHeight(I)V': (v, s, [x]) => { el(s).style.maxHeight = x / dp + 'px' },
    'setMinWidth(I)V': (v, s, [x]) => { el(s).style.minWidth = x / dp + 'px' }, 'setMinHeight(I)V': (v, s, [x]) => { el(s).style.minHeight = x / dp + 'px' },
    'setTextSize(IF)V': (v, s, [unit, x]) => { el(s).style.fontSize = (unit === 0 ? x / dp : x) + 'px' },
    'getTextSize()F': (v, s) => Math.fround((parseFloat(getComputedStyle(el(s)).fontSize) || 14) * dp),
    'setLineSpacing(FF)V': (v, s, [add, mult]) => { el(s).style.lineHeight = String(mult * 1.2 + add / dp / 14) },
    'setHintTextColor(I)V': noop, 'setLinkTextColor(I)V': noop, 'setHighlightColor(I)V': noop,
    'setTextAppearance(Landroid/content/Context;I)V': noop, 'setAllCaps(Z)V': (v, s, [x]) => { el(s).style.textTransform = x ? 'uppercase' : '' },
    'setPaintFlags(I)V': (v, s, [f]) => { el(s).style.textDecoration = f & 16 ? 'line-through' : f & 8 ? 'underline' : '' }, 'getPaintFlags()I': () => 0,
    'length()I': (v, s) => w.getText(s).length,
    'setMovementMethod(Landroid/text/method/MovementMethod;)V': noop, 'setLinksClickable(Z)V': noop, 'setAutoLinkMask(I)V': noop,
    'setHorizontallyScrolling(Z)V': noop, 'setMarqueeRepeatLimit(I)V': noop, 'setFocusable(Z)V': noop, 'setEnabled(Z)V': (v, s, [x]) => { (el(s) as any).disabled = !x; el(s).classList.toggle('disabled', !x) },
    'getLayout()Landroid/text/Layout;': (v, s) => obj('Landroid/text/Layout;', { view: s }),
    'getLineCount()I': (v, s) => { const e = el(s); const lh = parseFloat(getComputedStyle(e).lineHeight) || 18; return Math.max(1, Math.round(e.scrollHeight / lh)) },
    'onTextChanged(Ljava/lang/CharSequence;III)V': noop, 'onDraw(Landroid/graphics/Canvas;)V': noop,
    'setInputType(I)V': (v, s, [t]) => { s.f.inputType = t; const e = el(s) as HTMLInputElement; if (e.tagName === 'INPUT') { if ((t & 0xfff) === 0x81 || (t & 0xfff) === 0x12) e.type = 'password'; else if ((t & 0xf) === 2) e.inputMode = 'numeric' } },
    'setImeOptions(I)V': noop, 'setRawInputType(I)V': noop, 'setKeyListener(Landroid/text/method/KeyListener;)V': noop, 'setFilters([Landroid/text/InputFilter;)V': noop,
    'setOnEditorActionListener(Landroid/widget/TextView$OnEditorActionListener;)V': (v, s, [l]) => {
      el(s).addEventListener('keydown', (ev: Event) => { if ((ev as KeyboardEvent).key === 'Enter') { ev.preventDefault(); call(l, 'onEditorAction(Landroid/widget/TextView;ILandroid/view/KeyEvent;)Z', [s, 3, null]) } })
    },
    'addTextChangedListener(Landroid/text/TextWatcher;)V': (v, s, [l]) => {
      let before = w.getText(s)
      el(s).addEventListener('input', () => {
        const now = w.getText(s)
        call(l, 'beforeTextChanged(Ljava/lang/CharSequence;III)V', [before, 0, before.length, now.length])
        call(l, 'onTextChanged(Ljava/lang/CharSequence;III)V', [now, 0, before.length, now.length])
        call(l, 'afterTextChanged(Landroid/text/Editable;)V', [now])
        before = now
      })
    },
    'setHint(I)V': (v, s, [id]) => { (el(s) as HTMLInputElement).placeholder = w.resString(id) },
    'getHint()Ljava/lang/CharSequence;': (v, s) => (el(s) as HTMLInputElement).placeholder ?? '',
    'setError(Ljava/lang/CharSequence;)V': (v, s, [m]) => { el(s).title = text(m); el(s).style.outline = m ? '1px solid #f44' : '' },
  })
  // android-more puts no-op listeners on Button / EditText / ImageView themselves, which would hide these
  for (const c of ['Landroid/widget/Button;', 'Landroid/widget/EditText;']) {
    const sh = vm.shims.get(c)
    for (const k of ['addTextChangedListener(Landroid/text/TextWatcher;)V', 'setOnEditorActionListener(Landroid/widget/TextView$OnEditorActionListener;)V', 'setInputType(I)V', 'setSingleLine(Z)V']) { delete sh?.methods?.[k]; vm.classes.get(c)?.methods.delete(k) }
  }
  def('Landroid/text/Layout;', OBJ, {
    'getLineCount()I': (v, s) => vm.callVirtual(s.f.view, 'getLineCount()I') as number,
    'getLineEnd(I)I': (v, s, [i]) => { const t = w.getText(s.f.view); const n = vm.callVirtual(s.f.view, 'getLineCount()I') as number; return Math.min(t.length, Math.round(((i + 1) / n) * t.length)) },
    'getLineStart(I)I': (v, s, [i]) => { const t = w.getText(s.f.view); const n = vm.callVirtual(s.f.view, 'getLineCount()I') as number; return Math.min(t.length, Math.round((i / n) * t.length)) },
    'getEllipsisCount(I)I': () => 0, 'getHeight()I': (v, s) => Math.round(el(s.f.view).scrollHeight * dp), 'getWidth()I': (v, s) => Math.round(el(s.f.view).clientWidth * dp),
  })
  def('Landroid/text/StaticLayout;', 'Landroid/text/Layout;', {
    '<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFZ)V': (v, s, [t, , wd]) => { s.f.text = text(t); s.f.width = wd },
    'getLineCount()I': (v, s) => Math.max(1, Math.ceil((s.f.text.length * 7 * dp) / Math.max(1, s.f.width))),
    'getHeight()I': (v, s) => Math.ceil((s.f.text.length * 7 * dp) / Math.max(1, s.f.width)) * Math.round(18 * dp),
  })
  def('Landroid/text/TextUtils$TruncateAt;', OBJ, {})
  const ta = vm.cls('Landroid/text/TextUtils$TruncateAt;')
  for (const n of ['START', 'MIDDLE', 'END', 'MARQUEE']) ta.staticValues[n] = obj('Landroid/text/TextUtils$TruncateAt;', { name: n })
  def('Landroid/widget/EditText;', 'Landroid/widget/TextView;', {
    'setHint(I)V': (v, s, [id]) => { (el(s) as HTMLInputElement).placeholder = w.resString(id) },
    'setMaxLines(I)V': noop, 'selectAll()V': (v, s) => { (el(s) as HTMLInputElement).select?.() },
    'setSelection(II)V': noop,
  })
  def('Landroid/widget/ImageView;', 'Landroid/view/View;', {
    'setImageBitmap(Landroid/graphics/Bitmap;)V': (v, s, [b]) => { (el(s) as HTMLImageElement).src = b ? bitmapUrl(b) : '' },
    'setImageDrawable(Landroid/graphics/drawable/Drawable;)V': (v, s, [d]) => { s.f.drawable = d; (el(s) as HTMLImageElement).src = drawableUrlOf(d); if (d?.f.color !== undefined) el(s).style.background = w.cssColor(d.f.color) },
    'getDrawable()Landroid/graphics/drawable/Drawable;': (v, s) => s.f.drawable ?? null,
    'setScaleType(Landroid/widget/ImageView$ScaleType;)V': (v, s, [t]) => { const n = t?.f.name; (el(s) as HTMLImageElement).style.objectFit = n === 'CENTER_CROP' ? 'cover' : n === 'FIT_XY' ? 'fill' : n === 'CENTER' ? 'none' : 'contain' },
    'setAdjustViewBounds(Z)V': noop, 'setColorFilter(I)V': noop, 'setColorFilter(ILandroid/graphics/PorterDuff$Mode;)V': noop, 'clearColorFilter()V': noop,
    'setImageAlpha(I)V': (v, s, [a]) => { el(s).style.opacity = String(a / 255) }, 'setAlpha(I)V': (v, s, [a]) => { el(s).style.opacity = String(a / 255) },
    'setImageURI(Landroid/net/Uri;)V': (v, s, [u]) => { (el(s) as HTMLImageElement).src = u ? text(vm.callVirtual(u, 'toString()Ljava/lang/String;')) : '' },
    'setMaxHeight(I)V': noop, 'setMaxWidth(I)V': noop, 'setImageLevel(I)V': noop,
  })
  def('Landroid/widget/ImageView$ScaleType;', OBJ, {})
  const st = vm.cls('Landroid/widget/ImageView$ScaleType;')
  for (const n of ['MATRIX', 'FIT_XY', 'FIT_START', 'FIT_CENTER', 'FIT_END', 'CENTER', 'CENTER_CROP', 'CENTER_INSIDE']) st.staticValues[n] = obj('Landroid/widget/ImageView$ScaleType;', { name: n })
  def('Landroid/widget/ImageButton;', 'Landroid/widget/ImageView;', {})
  def('Landroid/widget/LinearLayout;', 'Landroid/view/ViewGroup;', {
    'setWeightSum(F)V': noop, 'setBaselineAligned(Z)V': noop, 'setDividerDrawable(Landroid/graphics/drawable/Drawable;)V': noop, 'setShowDividers(I)V': noop,
  })
  def('Landroid/widget/FrameLayout;', 'Landroid/view/ViewGroup;', { 'setForeground(Landroid/graphics/drawable/Drawable;)V': noop, 'setForegroundGravity(I)V': noop })
  def('Landroid/widget/ProgressBar;', 'Landroid/view/View;', { 'setProgressDrawable(Landroid/graphics/drawable/Drawable;)V': noop, 'setIndeterminate(Z)V': (v, s, [x]) => { el(s).classList.toggle('indeterminate', !!x) }, 'setSecondaryProgress(I)V': noop, 'getMax()I': (v, s) => s.f.max || 100, 'setIndeterminateDrawable(Landroid/graphics/drawable/Drawable;)V': noop })

  // ---------- resources ----------
  const plural = (n: number) => (n === 1 ? 'one' : 'other')
  def('Landroid/content/res/Resources;', OBJ, {
    'getDrawable(I)Landroid/graphics/drawable/Drawable;': (v, s, [id]) => resDrawable(id) ?? (() => { throw vm.error('Landroid/content/res/Resources$NotFoundException;', `Resource ID #0x${(id >>> 0).toString(16)}`) })(),
    'getDrawable(ILandroid/content/res/Resources$Theme;)Landroid/graphics/drawable/Drawable;': (v, s, [id]) => resDrawable(id),
    'getStringArray(I)[Ljava/lang/String;': (v, s, [id]) => {
      const e = env.res.entries.get(id >>> 0), val = e?.values.find((x) => x.map) ?? e?.values[0]
      const items = (val?.map || []).map((it) => w.valueText(it.value) ?? '')
      const a = vm.newArray('[Ljava/lang/String;', items.length); items.forEach((x, i) => ((a.data as any)[i] = x)); return a
    },
    'getTextArray(I)[Ljava/lang/CharSequence;': (v, s, [id]) => vm.callVirtual(s, 'getStringArray(I)[Ljava/lang/String;', [id]),
    'getIntArray(I)[I': (v, s, [id]) => { const e = env.res.entries.get(id >>> 0), val = e?.values.find((x) => x.map); const items = (val?.map || []).map((it) => it.value.data | 0); const a = vm.newArray('[I', items.length); (a.data as Int32Array).set(items); return a },
    'getQuantityString(II)Ljava/lang/String;': (v, s, [id, n]) => quantity(id, n),
    'getQuantityString(II[Ljava/lang/Object;)Ljava/lang/String;': (v, s, [id, n, args]) => vm.callStatic('Ljava/lang/String;', 'format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;', [quantity(id, n), args]),
    'getQuantityText(II)Ljava/lang/CharSequence;': (v, s, [id, n]) => quantity(id, n),
  })
  // plurals: a map of quantity attrs (0x01000004 other, 0x01000005 zero, 0x01000006 one, ...) to strings
  const quantity = (id: number, n: number) => {
    const e = env.res.entries.get(id >>> 0), val = e?.values.find((x) => x.map)
    const keys: Record<number, string> = { 0x01000004: 'other', 0x01000005: 'zero', 0x01000006: 'one', 0x01000007: 'two', 0x01000008: 'few', 0x01000009: 'many' }
    const want = n === 0 ? ['zero', 'other'] : [plural(n), 'other']
    for (const k of want) { const it = val?.map?.find((m) => keys[m.name] === k); if (it) return w.valueText(it.value) ?? '' }
    return w.valueText(val?.map?.[0]?.value) ?? ''
  }

  // ---------- dialogs: holo, in the app's own page ----------
  const DI = 'Landroid/content/DialogInterface;'
  def(DI, OBJ, {}, { statics: { BUTTON_POSITIVE: -1, BUTTON_NEGATIVE: -2, BUTTON_NEUTRAL: -3 } })
  const B = 'Landroid/app/AlertDialog$Builder;'
  const bset = (k: string, conv: (x: any) => any = (x) => x): NativeFn => (v, s, [x]) => { s.f.d[k] = conv(x); return s }
  const strs = (a: any): string[] => (a ? [...(a.data as any[])].map((x) => text(x)) : [])
  const resStrings = (id: number) => strs(vm.callVirtual(obj('Landroid/content/res/Resources;'), 'getStringArray(I)[Ljava/lang/String;', [id]))
  def(B, OBJ, {
    '<init>(Landroid/content/Context;)V': (v, s) => { s.f.d = { cancelable: true } },
    '<init>(Landroid/content/Context;I)V': (v, s) => { s.f.d = { cancelable: true } },
    'setTitle(Ljava/lang/CharSequence;)Landroid/app/AlertDialog$Builder;': bset('title', text),
    'setTitle(I)Landroid/app/AlertDialog$Builder;': bset('title', (id) => w.resString(id)),
    'setMessage(Ljava/lang/CharSequence;)Landroid/app/AlertDialog$Builder;': bset('message', text),
    'setMessage(I)Landroid/app/AlertDialog$Builder;': bset('message', (id) => w.resString(id)),
    'setIcon(I)Landroid/app/AlertDialog$Builder;': bset('icon', (id) => w.drawableUrl(id)),
    'setIcon(Landroid/graphics/drawable/Drawable;)Landroid/app/AlertDialog$Builder;': bset('icon', (d) => drawableUrlOf(d)),
    'setCancelable(Z)Landroid/app/AlertDialog$Builder;': bset('cancelable', (x) => !!x),
    'setView(Landroid/view/View;)Landroid/app/AlertDialog$Builder;': bset('view'),
    'setCustomTitle(Landroid/view/View;)Landroid/app/AlertDialog$Builder;': bset('titleView'),
    'setInverseBackgroundForced(Z)Landroid/app/AlertDialog$Builder;': (v, s) => s,
    'setPositiveButton(Ljava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [t, l]) => { s.f.d.pos = [text(t), l]; return s },
    'setPositiveButton(ILandroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [id, l]) => { s.f.d.pos = [w.resString(id), l]; return s },
    'setNegativeButton(Ljava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [t, l]) => { s.f.d.neg = [text(t), l]; return s },
    'setNegativeButton(ILandroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [id, l]) => { s.f.d.neg = [w.resString(id), l]; return s },
    'setNeutralButton(Ljava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [t, l]) => { s.f.d.neu = [text(t), l]; return s },
    'setNeutralButton(ILandroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [id, l]) => { s.f.d.neu = [w.resString(id), l]; return s },
    'setItems([Ljava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [a, l]) => { s.f.d.items = strs(a); s.f.d.itemL = l; return s },
    'setItems(ILandroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [id, l]) => { s.f.d.items = resStrings(id); s.f.d.itemL = l; return s },
    'setSingleChoiceItems([Ljava/lang/CharSequence;ILandroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [a, sel, l]) => { Object.assign(s.f.d, { items: strs(a), single: sel, itemL: l }); return s },
    'setSingleChoiceItems(IILandroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [id, sel, l]) => { Object.assign(s.f.d, { items: resStrings(id), single: sel, itemL: l }); return s },
    'setSingleChoiceItems(Landroid/widget/ListAdapter;ILandroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [a, sel, l]) => { Object.assign(s.f.d, { adapter: a, single: sel, itemL: l }); return s },
    'setMultiChoiceItems([Ljava/lang/CharSequence;[ZLandroid/content/DialogInterface$OnMultiChoiceClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [a, checked, l]) => { Object.assign(s.f.d, { items: strs(a), multi: checked, multiL: l }); return s },
    'setMultiChoiceItems(I[ZLandroid/content/DialogInterface$OnMultiChoiceClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [id, checked, l]) => { Object.assign(s.f.d, { items: resStrings(id), multi: checked, multiL: l }); return s },
    'setAdapter(Landroid/widget/ListAdapter;Landroid/content/DialogInterface$OnClickListener;)Landroid/app/AlertDialog$Builder;': (v, s, [a, l]) => { Object.assign(s.f.d, { adapter: a, itemL: l }); return s },
    'setOnCancelListener(Landroid/content/DialogInterface$OnCancelListener;)Landroid/app/AlertDialog$Builder;': bset('onCancel'),
    'setOnDismissListener(Landroid/content/DialogInterface$OnDismissListener;)Landroid/app/AlertDialog$Builder;': bset('onDismiss'),
    'setOnKeyListener(Landroid/content/DialogInterface$OnKeyListener;)Landroid/app/AlertDialog$Builder;': (v, s) => s,
    'create()Landroid/app/AlertDialog;': (v, s) => obj('Landroid/app/AlertDialog;', { d: { ...s.f.d } }),
    'show()Landroid/app/AlertDialog;': (v, s) => { const d = obj('Landroid/app/AlertDialog;', { d: { ...s.f.d } }); showDialog(d); return d },
    'getContext()Landroid/content/Context;': () => w.activity(),
  })
  const dlgCss = `.an-dlg-scrim{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:1000}
.an-dlg{background:#282828;color:#fff;min-width:280px;max-width:92%;max-height:86%;display:flex;flex-direction:column;box-shadow:0 2px 12px rgba(0,0,0,.6);font:15px Roboto,sans-serif}
.an-dlg-t{padding:16px 16px 12px;color:#33b5e5;font-size:20px;display:flex;align-items:center;gap:10px;border-bottom:2px solid #33b5e5}
.an-dlg-t img{width:32px;height:32px}
.an-dlg-m{padding:16px;line-height:1.4;white-space:pre-wrap;overflow:auto}
.an-dlg-v{overflow:auto;min-height:0}
.an-dlg-l{list-style:none;margin:0;padding:0;overflow:auto}
.an-dlg-l li{padding:0 16px;min-height:48px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #3a3a3a;cursor:pointer}
.an-dlg-l li:active,.an-dlg-l li.pressed{background:rgba(51,181,229,.4)}
.an-dlg-l input{width:20px;height:20px;accent-color:#33b5e5}
.an-dlg-b{display:flex;border-top:1px solid #3a3a3a}
.an-dlg-b button{flex:1;background:none;border:0;border-left:1px solid #3a3a3a;color:#fff;font:inherit;min-height:48px;cursor:pointer}
.an-dlg-b button:first-child{border-left:0}
.an-dlg-b button:active{background:rgba(51,181,229,.4)}
.an-pd{display:flex;align-items:center;gap:16px;padding:20px 16px}
.an-pd .spin{width:32px;height:32px;border:4px solid #555;border-top-color:#33b5e5;border-radius:50%;animation:an-spin 1s linear infinite}
@keyframes an-spin{to{transform:rotate(360deg)}}`
  const ensureCss = () => { if (document.getElementById('an-dlg-css')) return; const st2 = document.createElement('style'); st2.id = 'an-dlg-css'; st2.textContent = dlgCss; document.head.append(st2) }
  const dismissDialog = (d: JObject, cancelled = false) => {
    if (!d.f.node) return
    d.f.node.remove(); d.f.node = null
    if (cancelled) call(d.f.d.onCancel, 'onCancel(Landroid/content/DialogInterface;)V', [d])
    call(d.f.d.onDismiss, 'onDismiss(Landroid/content/DialogInterface;)V', [d])
    if (d.f.view) { const ve = el(d.f.view); ve.remove() }
    try { vm.callVirtual(d, 'onStop()V') } catch { /* fine */ }
  }
  const showDialog = (d: JObject) => {
    if (d.f.node) return
    ensureCss()
    const o = d.f.d
    const scrim = document.createElement('div'); scrim.className = 'an-dlg-scrim'
    const box = document.createElement('div'); box.className = 'an-dlg'
    scrim.append(box)
    scrim.addEventListener('click', (ev) => { if (ev.target === scrim && o.cancelable !== false) dismissDialog(d, true) })
    if (o.titleView) { const tv = document.createElement('div'); tv.append(el(o.titleView)); box.append(tv) }
    else if (o.title) { const t = document.createElement('div'); t.className = 'an-dlg-t'; if (o.icon) { const i = document.createElement('img'); i.src = o.icon; t.append(i) } t.append(o.title); box.append(t) }
    if (o.message) { const m = document.createElement('div'); m.className = 'an-dlg-m'; m.textContent = o.message; box.append(m) }
    if (d.f.contentView || o.view) { const vv = document.createElement('div'); vv.className = 'an-dlg-v'; vv.append(el(d.f.contentView || o.view)); box.append(vv) }
    const labels: string[] = o.items ?? (o.adapter ? Array.from({ length: vm.callVirtual(o.adapter, 'getCount()I') as number }, () => '') : [])
    if (labels.length) {
      const ul = document.createElement('ul'); ul.className = 'an-dlg-l'
      labels.forEach((label, i) => {
        const li = document.createElement('li')
        if (o.adapter) { const v2 = vm.callVirtual(o.adapter, 'getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;', [i, null, null]) as JObject; li.append(el(v2)) } else li.append(label)
        let box2: HTMLInputElement | null = null
        if (o.single !== undefined) { box2 = document.createElement('input'); box2.type = 'radio'; box2.name = 'an-dlg-single'; box2.checked = o.single === i; li.append(box2) }
        if (o.multi !== undefined) { box2 = document.createElement('input'); box2.type = 'checkbox'; box2.checked = !!o.multi?.data[i]; li.append(box2) }
        li.addEventListener('click', (ev) => {
          if (o.multi !== undefined) {
            if (ev.target !== box2) box2!.checked = !box2!.checked
            if (o.multi) o.multi.data[i] = box2!.checked ? 1 : 0
            call(o.multiL, 'onClick(Landroid/content/DialogInterface;IZ)V', [d, i, box2!.checked ? 1 : 0])
            return
          }
          if (box2) box2.checked = true
          call(o.itemL, 'onClick(Landroid/content/DialogInterface;I)V', [d, i])
          if (o.single === undefined) dismissDialog(d)
        })
        ul.append(li)
      })
      box.append(ul)
    }
    const btns: [any, number][] = [[o.neg, -2], [o.neu, -3], [o.pos, -1]]
    if (btns.some(([b]) => b)) {
      const bar = document.createElement('div'); bar.className = 'an-dlg-b'
      for (const [b, which] of btns) {
        if (!b) continue
        const bt = document.createElement('button'); bt.textContent = b[0]
        bt.addEventListener('click', () => { call(b[1], 'onClick(Landroid/content/DialogInterface;I)V', [d, which]); if (!d.f.keepOpen?.[which]) dismissDialog(d) })
        ;(d.f.buttons ||= {})[which] = bt
        bar.append(bt)
      }
      box.append(bar)
    }
    document.body.append(scrim)
    d.f.node = scrim
    call(d.f.d.onShow, 'onShow(Landroid/content/DialogInterface;)V', [d])
  }
  const dialogMethods: Record<string, NativeFn> = {
    '<init>(Landroid/content/Context;)V': (v, s) => { s.f.d = { cancelable: true } },
    '<init>(Landroid/content/Context;I)V': (v, s) => { s.f.d = { cancelable: true } },
    'show()V': (v, s) => { if (!s.f.d) s.f.d = { cancelable: true }; try { if (!s.f.created) { s.f.created = true; vm.callVirtual(s, 'onCreate(Landroid/os/Bundle;)V', [null]) } } catch (e) { w.report(e) } showDialog(s) },
    'dismiss()V': (v, s) => dismissDialog(s), 'cancel()V': (v, s) => dismissDialog(s, true), 'hide()V': (v, s) => { if (s.f.node) s.f.node.style.display = 'none' },
    'isShowing()Z': (v, s) => (s.f.node ? 1 : 0),
    'setCancelable(Z)V': (v, s, [x]) => { (s.f.d ||= {}).cancelable = !!x }, 'setCanceledOnTouchOutside(Z)V': (v, s, [x]) => { (s.f.d ||= {}).cancelable = !!x },
    'setTitle(Ljava/lang/CharSequence;)V': (v, s, [t]) => { (s.f.d ||= {}).title = text(t) }, 'setTitle(I)V': (v, s, [id]) => { (s.f.d ||= {}).title = w.resString(id) },
    'setMessage(Ljava/lang/CharSequence;)V': (v, s, [t]) => { (s.f.d ||= {}).message = text(t); const m = s.f.node?.querySelector('.an-dlg-m'); if (m) m.textContent = text(t) },
    'setContentView(Landroid/view/View;)V': (v, s, [view]) => { s.f.contentView = view },
    'setContentView(I)V': (v, s, [id]) => { s.f.contentView = vm.callVirtual(vm.callVirtual(w.activity(), 'getLayoutInflater()Landroid/view/LayoutInflater;'), 'inflate(ILandroid/view/ViewGroup;)Landroid/view/View;', [id, null]) },
    'findViewById(I)Landroid/view/View;': (v, s, [id]) => w.views.get(id) ?? null,
    'setView(Landroid/view/View;)V': (v, s, [view]) => { (s.f.d ||= {}).view = view },
    'setButton(ILjava/lang/CharSequence;Landroid/content/DialogInterface$OnClickListener;)V': (v, s, [which, t, l]) => { const k = which === -1 ? 'pos' : which === -2 ? 'neg' : 'neu'; (s.f.d ||= {})[k] = [text(t), l] },
    'getButton(I)Landroid/widget/Button;': (v, s, [which]) => { const bt = s.f.buttons?.[which]; if (!bt) return null; const b = obj('Landroid/widget/Button;', { el: bt }); return b },
    'setOnCancelListener(Landroid/content/DialogInterface$OnCancelListener;)V': (v, s, [l]) => { (s.f.d ||= {}).onCancel = l },
    'setOnDismissListener(Landroid/content/DialogInterface$OnDismissListener;)V': (v, s, [l]) => { (s.f.d ||= {}).onDismiss = l },
    'setOnShowListener(Landroid/content/DialogInterface$OnShowListener;)V': (v, s, [l]) => { (s.f.d ||= {}).onShow = l },
    'setOnKeyListener(Landroid/content/DialogInterface$OnKeyListener;)V': noop,
    'getWindow()Landroid/view/Window;': () => obj('Landroid/view/Window;'),
    'getContext()Landroid/content/Context;': () => w.activity(),
    'getListView()Landroid/widget/ListView;': () => null,
    'onCreate(Landroid/os/Bundle;)V': noop, 'onStart()V': noop, 'onStop()V': noop,
    'requestWindowFeature(I)Z': () => 1,
  }
  def('Landroid/app/Dialog;', OBJ, dialogMethods, { interfaces: [DI] })
  def('Landroid/app/AlertDialog;', 'Landroid/app/Dialog;', { 'setIcon(I)V': noop })
  // ProgressDialog: a spinner and a message
  const pdShow = (s: JObject) => {
    const d = (s.f.d ||= { cancelable: true })
    const holder = document.createElement('div'); holder.className = 'an-pd'
    holder.append(Object.assign(document.createElement('div'), { className: 'spin' }), Object.assign(document.createElement('div'), { className: 'an-dlg-m', textContent: d.message || '' }))
    holder.querySelector('.an-dlg-m')!.setAttribute('style', 'padding:0')
    s.f.contentView = obj('Landroid/view/View;', { el: holder })
    showDialog(s)
  }
  def('Landroid/app/ProgressDialog;', 'Landroid/app/AlertDialog;', {
    '<init>(Landroid/content/Context;)V': (v, s) => { s.f.d = { cancelable: true } },
    '<init>(Landroid/content/Context;I)V': (v, s) => { s.f.d = { cancelable: true } },
    'show()V': (v, s) => pdShow(s),
    'show(Landroid/content/Context;Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Landroid/app/ProgressDialog;': (v, s, [, t, m]) => { const p = obj('Landroid/app/ProgressDialog;', { d: { title: text(t), message: text(m), cancelable: false } }); pdShow(p); return p },
    'show(Landroid/content/Context;Ljava/lang/CharSequence;Ljava/lang/CharSequence;Z)Landroid/app/ProgressDialog;': (v, s, [, t, m]) => { const p = obj('Landroid/app/ProgressDialog;', { d: { title: text(t), message: text(m), cancelable: false } }); pdShow(p); return p },
    'show(Landroid/content/Context;Ljava/lang/CharSequence;Ljava/lang/CharSequence;ZZ)Landroid/app/ProgressDialog;': (v, s, [, t, m, , c]) => { const p = obj('Landroid/app/ProgressDialog;', { d: { title: text(t), message: text(m), cancelable: !!c } }); pdShow(p); return p },
    'setProgressStyle(I)V': noop, 'setIndeterminate(Z)V': noop, 'setMax(I)V': noop, 'setProgress(I)V': noop, 'incrementProgressBy(I)V': noop,
    'setProgressNumberFormat(Ljava/lang/String;)V': noop, 'setProgressPercentFormat(Ljava/text/NumberFormat;)V': noop,
  }, { statics: { STYLE_SPINNER: 0, STYLE_HORIZONTAL: 1 } })

  // ---------- AsyncTask: doInBackground on its own green thread, the rest on the ui thread ----------
  const AT = 'Landroid/os/AsyncTask;'
  const startTask = (s: JObject, args: JArray | null) => {
    if (s.f.state === 'running') throw vm.error('Ljava/lang/IllegalStateException;', 'Cannot execute task: the task is already running.')
    s.f.state = 'running'
    call(s, 'onPreExecute()V')
    const m = vm.findMethod(s.cls, 'doInBackground([Ljava/lang/Object;)Ljava/lang/Object;')
    if (!m) { s.f.state = 'finished'; return s }
    const t = vm.startThread('AsyncTask #' + (++taskN), m, s, [args ?? vm.newArray('[Ljava/lang/Object;', 0)])
    t.onDone = (err) => {
      s.f.state = 'finished'
      if (err) { w.report(err); return }
      const result = t.lastValue
      setTimeout(() => {
        if (s.f.cancelled) call(s, 'onCancelled(Ljava/lang/Object;)V', [result]) ?? call(s, 'onCancelled()V')
        else call(s, 'onPostExecute(Ljava/lang/Object;)V', [result])
      }, 0)
    }
    return s
  }
  let taskN = 0
  def(AT, OBJ, {
    '<init>()V': (v, s) => { s.f.state = 'pending' },
    'execute([Ljava/lang/Object;)Landroid/os/AsyncTask;': (v, s, [a]) => startTask(s, a),
    'executeOnExecutor(Ljava/util/concurrent/Executor;[Ljava/lang/Object;)Landroid/os/AsyncTask;': (v, s, [, a]) => startTask(s, a),
    'execute(Ljava/lang/Runnable;)V': (v, s, [r]) => { setTimeout(() => call(r, 'run()V'), 0) },
    'cancel(Z)Z': (v, s) => { if (s.f.state === 'finished') return 0; s.f.cancelled = true; return 1 },
    'isCancelled()Z': (v, s) => (s.f.cancelled ? 1 : 0),
    'getStatus()Landroid/os/AsyncTask$Status;': (v, s) => vm.cls('Landroid/os/AsyncTask$Status;').staticValues[s.f.state === 'running' ? 'RUNNING' : s.f.state === 'finished' ? 'FINISHED' : 'PENDING'],
    'publishProgress([Ljava/lang/Object;)V': (v, s, [a]) => { setTimeout(() => call(s, 'onProgressUpdate([Ljava/lang/Object;)V', [a]), 0) },
    'get()Ljava/lang/Object;': (v, s) => s.f.result ?? null,
    'onPreExecute()V': noop, 'onPostExecute(Ljava/lang/Object;)V': noop, 'onProgressUpdate([Ljava/lang/Object;)V': noop, 'onCancelled()V': noop, 'onCancelled(Ljava/lang/Object;)V': (v, s) => { vm.callVirtual(s, 'onCancelled()V') },
  })
  def('Landroid/os/AsyncTask$Status;', OBJ, {})
  const ats = vm.cls('Landroid/os/AsyncTask$Status;')
  for (const n of ['PENDING', 'RUNNING', 'FINISHED']) ats.staticValues[n] = obj('Landroid/os/AsyncTask$Status;', { name: n })
  vm.cls(AT).staticValues.THREAD_POOL_EXECUTOR = vm.cls(AT).staticValues.SERIAL_EXECUTOR = obj('Ljava/util/concurrent/Executor;')

  // ---------- spinner: the chosen item's view, a list to pick from ----------
  const pickFrom = (s: JObject) => {
    const a = s.f.adapter
    if (!a) return
    const d = obj('Landroid/app/AlertDialog;', { d: { adapter: a, cancelable: true, itemL: obj('Landroid/content/DialogInterface$OnClickListener;') } })
    d.f.d.itemL = { __pick: true }
    const n = vm.callVirtual(a, 'getCount()I') as number
    d.f.d.items = Array.from({ length: n }, (_, i) => text(vm.callVirtual(a, 'getItem(I)Ljava/lang/Object;', [i])))
    d.f.d.adapter = undefined
    d.f.d.single = s.f.selected ?? 0
    d.f.d.itemL = null
    showDialog(d)
    d.f.node?.querySelectorAll('li').forEach((li: Element, i: number) => li.addEventListener('click', () => { select(s, i); dismissDialog(d) }))
  }
  const drawSpinner = (s: JObject) => {
    const e = el(s), a = s.f.adapter
    e.innerHTML = ''
    if (!a) return
    const n = vm.callVirtual(a, 'getCount()I') as number
    if (!n) return
    const i = Math.min(s.f.selected ?? 0, n - 1)
    const v2 = vm.callVirtual(a, 'getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;', [i, null, s]) as JObject
    e.append(el(v2))
  }
  const select = (s: JObject, i: number) => {
    const changed = s.f.selected !== i
    s.f.selected = i
    drawSpinner(s)
    if (changed && s.f.onSelect) call(s.f.onSelect, 'onItemSelected(Landroid/widget/AdapterView;Landroid/view/View;IJ)V', [s, null, i, BigInt(i)])
  }
  def('Landroid/widget/AbsSpinner;', 'Landroid/widget/AdapterView;', {})
  def('Landroid/widget/Spinner;', 'Landroid/widget/AbsSpinner;', {
    'setAdapter(Landroid/widget/SpinnerAdapter;)V': (v, s, [a]) => { s.f.adapter = a; a.f.spinners = [...(a.f.spinners || []), s]; s.f.selected ??= 0; drawSpinner(s); if (s.f.onSelect) setTimeout(() => call(s.f.onSelect, 'onItemSelected(Landroid/widget/AdapterView;Landroid/view/View;IJ)V', [s, null, s.f.selected, BigInt(s.f.selected)]), 0) },
    'setAdapter(Landroid/widget/ListAdapter;)V': (v, s, [a]) => { s.f.adapter = a; s.f.selected ??= 0; drawSpinner(s) },
    'getAdapter()Landroid/widget/Adapter;': (v, s) => s.f.adapter ?? null,
    'setSelection(I)V': (v, s, [i]) => select(s, i), 'setSelection(IZ)V': (v, s, [i]) => select(s, i),
    'getSelectedItemPosition()I': (v, s) => (s.f.adapter ? s.f.selected ?? 0 : -1),
    'getSelectedItem()Ljava/lang/Object;': (v, s) => (s.f.adapter ? vm.callVirtual(s.f.adapter, 'getItem(I)Ljava/lang/Object;', [s.f.selected ?? 0]) : null),
    'getSelectedItemId()J': (v, s) => BigInt(s.f.selected ?? -1),
    'getCount()I': (v, s) => (s.f.adapter ? vm.callVirtual(s.f.adapter, 'getCount()I') as number : 0),
    'getItemAtPosition(I)Ljava/lang/Object;': (v, s, [i]) => vm.callVirtual(s.f.adapter, 'getItem(I)Ljava/lang/Object;', [i]),
    'setOnItemSelectedListener(Landroid/widget/AdapterView$OnItemSelectedListener;)V': (v, s, [l]) => { s.f.onSelect = l },
    'setPrompt(Ljava/lang/CharSequence;)V': noop, 'setEnabled(Z)V': (v, s, [x]) => { el(s).classList.toggle('disabled', !x); s.f.disabled = !x },
    'performClick()Z': (v, s) => { pickFrom(s); return 1 },
  })
  def('Landroid/widget/AdapterView;', 'Landroid/view/ViewGroup;', {
    'getItemAtPosition(I)Ljava/lang/Object;': (v, s, [i]) => (s.f.adapter ? vm.callVirtual(s.f.adapter, 'getItem(I)Ljava/lang/Object;', [i]) : null),
    'setOnItemSelectedListener(Landroid/widget/AdapterView$OnItemSelectedListener;)V': (v, s, [l]) => { s.f.onSelect = l },
    'setOnItemLongClickListener(Landroid/widget/AdapterView$OnItemLongClickListener;)V': (v, s, [l]) => { s.f.longClick = l },
    'getCount()I': (v, s) => (s.f.adapter ? vm.callVirtual(s.f.adapter, 'getCount()I') as number : 0),
    'getFirstVisiblePosition()I': () => 0, 'getLastVisiblePosition()I': (v, s) => (s.f.adapter ? (vm.callVirtual(s.f.adapter, 'getCount()I') as number) - 1 : -1),
    'setEmptyView(Landroid/view/View;)V': (v, s, [e]) => { s.f.empty = e },
    'getSelectedItemPosition()I': (v, s) => s.f.selected ?? -1,
  })
  def('Landroid/widget/AbsListView;', 'Landroid/widget/AdapterView;', {
    'setOnScrollListener(Landroid/widget/AbsListView$OnScrollListener;)V': (v, s, [l]) => {
      s.f.scrollL = l
      el(s).addEventListener('scroll', () => call(l, 'onScroll(Landroid/widget/AbsListView;III)V', [s, 0, 0, vm.callVirtual(s, 'getCount()I')]))
    },
    'invalidateViews()V': (v, s) => w.renderList(s), 'setFastScrollEnabled(Z)V': noop, 'setSmoothScrollbarEnabled(Z)V': noop,
    'smoothScrollToPosition(I)V': (v, s, [i]) => { el(s).children[i * 2]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) },
    'setSelector(Landroid/graphics/drawable/Drawable;)V': noop, 'setSelector(I)V': noop, 'setCacheColorHint(I)V': noop, 'setScrollingCacheEnabled(Z)V': noop,
    'setTranscriptMode(I)V': noop, 'setStackFromBottom(Z)V': noop, 'setChoiceMode(I)V': noop, 'setTextFilterEnabled(Z)V': noop,
  })
  def('Landroid/widget/ListView;', 'Landroid/widget/AbsListView;', {
    'setDivider(Landroid/graphics/drawable/Drawable;)V': (v, s, [d]) => { el(s).classList.toggle('an-nodivider', !d) },
    'setDividerHeight(I)V': noop, 'setHeaderDividersEnabled(Z)V': noop, 'setFooterDividersEnabled(Z)V': noop, 'setItemsCanFocus(Z)V': noop,
    'addHeaderView(Landroid/view/View;)V': (v, s, [h]) => { (s.f.headers ||= []).push(h); w.renderList(s) },
    'addHeaderView(Landroid/view/View;Ljava/lang/Object;Z)V': (v, s, [h]) => { (s.f.headers ||= []).push(h); w.renderList(s) },
    'addFooterView(Landroid/view/View;)V': (v, s, [f]) => { (s.f.footers ||= []).push(f); w.renderList(s) },
    'addFooterView(Landroid/view/View;Ljava/lang/Object;Z)V': (v, s, [f]) => { (s.f.footers ||= []).push(f); w.renderList(s) },
    'removeFooterView(Landroid/view/View;)Z': (v, s, [f]) => { s.f.footers = (s.f.footers || []).filter((x: JObject) => x !== f); el(f).remove(); return 1 },
    'removeHeaderView(Landroid/view/View;)Z': (v, s, [h]) => { s.f.headers = (s.f.headers || []).filter((x: JObject) => x !== h); el(h).remove(); return 1 },
    'getHeaderViewsCount()I': (v, s) => (s.f.headers || []).length, 'getFooterViewsCount()I': (v, s) => (s.f.footers || []).length,
    'setSelection(I)V': (v, s, [i]) => { el(s).children[i * 2]?.scrollIntoView({ block: 'nearest' }) },
    'setSelectionFromTop(II)V': (v, s, [i]) => { el(s).children[i * 2]?.scrollIntoView({ block: 'start' }) },
  })
  def('Landroid/widget/GridView;', 'Landroid/widget/AbsListView;', { 'setNumColumns(I)V': (v, s, [n]) => { const e = el(s); e.style.display = 'grid'; e.style.gridTemplateColumns = `repeat(${Math.max(1, n)}, 1fr)` }, 'setColumnWidth(I)V': noop, 'setStretchMode(I)V': noop, 'setHorizontalSpacing(I)V': noop, 'setVerticalSpacing(I)V': noop })
  def('Landroid/widget/ArrayAdapter;', 'Landroid/widget/BaseAdapter;', {
    'setDropDownViewResource(I)V': (v, s, [id]) => { s.f.dropRes = id },
    'addAll(Ljava/util/Collection;)V': (v, s, [c]) => { const arr: any[] = s.f.items?.f?.a ?? s.f.own; for (const x of vm.callVirtual(c, 'toArray()[Ljava/lang/Object;').data) arr.push(x); vm.callVirtual(s, 'notifyDataSetChanged()V') },
    'insert(Ljava/lang/Object;I)V': (v, s, [x, i]) => { const arr: any[] = s.f.items?.f?.a ?? s.f.own; arr.splice(i, 0, x); vm.callVirtual(s, 'notifyDataSetChanged()V') },
    'remove(Ljava/lang/Object;)V': (v, s, [x]) => { const arr: any[] = s.f.items?.f?.a ?? s.f.own; const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); vm.callVirtual(s, 'notifyDataSetChanged()V') },
    'getPosition(Ljava/lang/Object;)I': (v, s, [x]) => (s.f.items?.f?.a ?? s.f.own ?? []).indexOf(x),
    'getFilter()Landroid/widget/Filter;': () => obj('Landroid/widget/Filter;'),
    'setNotifyOnChange(Z)V': noop,
    'getDropDownView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;': (v, s, [i, c, p]) => vm.callVirtual(s, 'getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;', [i, c, p]),
  })
  def('Landroid/widget/BaseAdapter;', OBJ, {
    'notifyDataSetChanged()V': (v, s) => { (s.f.lists || []).forEach(w.renderList); (s.f.spinners || []).forEach(drawSpinner); (s.f.observers || []).forEach((o: JObject) => call(o, 'onChanged()V')) },
    'notifyDataSetInvalidated()V': (v, s) => { (s.f.lists || []).forEach(w.renderList) },
    'registerDataSetObserver(Landroid/database/DataSetObserver;)V': (v, s, [o]) => { (s.f.observers ||= []).push(o) },
    'unregisterDataSetObserver(Landroid/database/DataSetObserver;)V': (v, s, [o]) => { s.f.observers = (s.f.observers || []).filter((x: JObject) => x !== o) },
    'getItemViewType(I)I': () => 0, 'getViewTypeCount()I': () => 1, 'hasStableIds()Z': () => 0, 'isEmpty()Z': (v, s) => ((vm.callVirtual(s, 'getCount()I') as number) === 0 ? 1 : 0),
    'areAllItemsEnabled()Z': () => 1, 'isEnabled(I)Z': () => 1,
    'getDropDownView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;': (v, s, [i, c, p]) => vm.callVirtual(s, 'getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;', [i, c, p]),
  })
  def('Landroid/database/DataSetObserver;', OBJ, { '<init>()V': noop, 'onChanged()V': noop, 'onInvalidated()V': noop })
  def('Landroid/widget/Filter;', OBJ, {
    '<init>()V': noop,
    'filter(Ljava/lang/CharSequence;)V': (v, s, [q]) => runFilter(s, q, null),
    'filter(Ljava/lang/CharSequence;Landroid/widget/Filter$FilterListener;)V': (v, s, [q, l]) => runFilter(s, q, l),
    'convertResultToString(Ljava/lang/Object;)Ljava/lang/CharSequence;': (v, s, [x]) => (x == null ? '' : text(vm.callVirtual(x, 'toString()Ljava/lang/String;'))),
  })
  const runFilter = (s: JObject, q: any, l: any) => {
    // performFiltering off the ui thread, publishResults on it
    const m = vm.findMethod(s.cls, 'performFiltering(Ljava/lang/CharSequence;)Landroid/widget/Filter$FilterResults;')
    if (!m) return
    const t = vm.startThread('Filter', m, s, [q])
    t.onDone = (err) => {
      if (err) { w.report(err); return }
      const r = t.lastValue
      setTimeout(() => { call(s, 'publishResults(Ljava/lang/CharSequence;Landroid/widget/Filter$FilterResults;)V', [q, r]); if (l instanceof JObject) call(l, 'onFilterComplete(I)V', [r?.f.count ?? 0]) }, 0)
    }
  }
  def('Landroid/widget/Filter$FilterResults;', OBJ, { '<init>()V': (v, s) => { s.f.count = 0; s.f.values = null } })

  // ---------- AutoCompleteTextView: an input with a dropdown of the adapter's items ----------
  const drop = (s: JObject, show: boolean) => {
    s.f.dropEl?.remove(); s.f.dropEl = null
    if (!show || !s.f.adapter) return
    const a = s.f.adapter, n = vm.callVirtual(a, 'getCount()I') as number
    if (!n) return
    ensureCss()
    const e = el(s), r = e.getBoundingClientRect()
    const ul = document.createElement('ul'); ul.className = 'an-dlg-l'
    ul.style.cssText = `position:fixed;left:${r.left}px;top:${r.bottom}px;width:${r.width}px;max-height:50vh;background:#282828;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,.6)`
    for (let i = 0; i < n; i++) {
      const li = document.createElement('li')
      const v2 = vm.callVirtual(a, 'getView(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;', [i, null, s]) as JObject
      li.append(el(v2))
      li.addEventListener('pointerdown', (ev) => ev.preventDefault())
      li.addEventListener('click', () => {
        const item = vm.callVirtual(a, 'getItem(I)Ljava/lang/Object;', [i])
        w.setText(s, item == null ? '' : text(vm.callVirtual(item, 'toString()Ljava/lang/String;')))
        drop(s, false)
        if (s.f.itemClick) call(s.f.itemClick, 'onItemClick(Landroid/widget/AdapterView;Landroid/view/View;IJ)V', [null, v2, i, BigInt(i)])
      })
      ul.append(li)
    }
    document.body.append(ul)
    s.f.dropEl = ul
  }
  def('Landroid/widget/AutoCompleteTextView;', 'Landroid/widget/EditText;', {
    'setAdapter(Landroid/widget/ListAdapter;)V': (v, s, [a]) => {
      s.f.adapter = a
      a.f.observers = [...(a.f.observers || []), obj('Landroid/database/DataSetObserver;', {})]
      if (!s.f.acBound) {
        s.f.acBound = true
        const e = el(s)
        e.addEventListener('input', () => {
          const q = w.getText(s)
          if (q.length < (s.f.threshold ?? 2)) { drop(s, false); return }
          const f = vm.callVirtual(a, 'getFilter()Landroid/widget/Filter;') as JObject | null
          if (f && vm.findMethod(f.cls, 'performFiltering(Ljava/lang/CharSequence;)Landroid/widget/Filter$FilterResults;')) runFilter(f, q, { __done: true })
          setTimeout(() => drop(s, document.activeElement === e), 50)
        })
        e.addEventListener('blur', () => setTimeout(() => drop(s, false), 150))
      }
    },
    'getAdapter()Landroid/widget/ListAdapter;': (v, s) => s.f.adapter ?? null,
    'setThreshold(I)V': (v, s, [n]) => { s.f.threshold = n },
    'showDropDown()V': (v, s) => drop(s, true), 'dismissDropDown()V': (v, s) => drop(s, false),
    'isPopupShowing()Z': (v, s) => (s.f.dropEl ? 1 : 0),
    'setOnItemClickListener(Landroid/widget/AdapterView$OnItemClickListener;)V': (v, s, [l]) => { s.f.itemClick = l },
    'setDropDownWidth(I)V': noop, 'setDropDownHeight(I)V': noop, 'setDropDownBackgroundResource(I)V': noop, 'setDropDownVerticalOffset(I)V': noop,
    'getText()Landroid/text/Editable;': (v, s) => w.getText(s),
  })

  // ---------- scrolling, seek bars ----------
  def('Landroid/widget/ScrollView;', 'Landroid/widget/FrameLayout;', {
    'smoothScrollTo(II)V': (v, s, [x, y]) => { el(s).scrollTo({ left: x / dp, top: y / dp, behavior: 'smooth' }) },
    'smoothScrollBy(II)V': (v, s, [x, y]) => { el(s).scrollBy({ left: x / dp, top: y / dp, behavior: 'smooth' }) },
    'fullScroll(I)Z': (v, s, [d]) => { const e = el(s); e.scrollTop = d === 130 ? e.scrollHeight : 0; return 1 },
    'setFillViewport(Z)V': noop, 'setSmoothScrollingEnabled(Z)V': noop, 'setVerticalScrollBarEnabled(Z)V': noop,
  })
  def('Landroid/widget/HorizontalScrollView;', 'Landroid/widget/FrameLayout;', {
    'setHorizontalScrollBarEnabled(Z)V': (v, s, [x]) => { el(s).style.scrollbarWidth = x ? '' : 'none' },
    'smoothScrollTo(II)V': (v, s, [x, y]) => { el(s).scrollTo({ left: x / dp, top: y / dp, behavior: 'smooth' }) },
    'smoothScrollBy(II)V': (v, s, [x, y]) => { el(s).scrollBy({ left: x / dp, top: y / dp, behavior: 'smooth' }) },
    'fullScroll(I)Z': (v, s, [d]) => { const e = el(s); e.scrollLeft = d === 66 ? e.scrollWidth : 0; return 1 },
    'setFillViewport(Z)V': noop, 'setSmoothScrollingEnabled(Z)V': noop,
  })
  const seekInput = (s: JObject) => el(s) as HTMLInputElement
  def('Landroid/widget/AbsSeekBar;', 'Landroid/widget/ProgressBar;', {})
  def('Landroid/widget/SeekBar;', 'Landroid/widget/AbsSeekBar;', {
    'setMax(I)V': (v, s, [m]) => { s.f.max = m; seekInput(s).max = String(m) },
    'getMax()I': (v, s) => s.f.max ?? 100,
    'setProgress(I)V': (v, s, [p]) => { s.f.progress = p; seekInput(s).value = String(p) },
    'getProgress()I': (v, s) => Number(seekInput(s).value) || 0,
    'setSecondaryProgress(I)V': (v, s, [p]) => { const max = s.f.max ?? 100; seekInput(s).style.setProperty('--secondary', `${(p / max) * 100}%`) },
    'setOnSeekBarChangeListener(Landroid/widget/SeekBar$OnSeekBarChangeListener;)V': (v, s, [l]) => {
      const e = seekInput(s)
      if (s.f.seekBound) { s.f.seekL = l; return }
      s.f.seekBound = true; s.f.seekL = l
      e.addEventListener('pointerdown', () => call(s.f.seekL, 'onStartTrackingTouch(Landroid/widget/SeekBar;)V', [s]))
      e.addEventListener('input', () => call(s.f.seekL, 'onProgressChanged(Landroid/widget/SeekBar;IZ)V', [s, Number(e.value), 1]))
      e.addEventListener('change', () => call(s.f.seekL, 'onStopTrackingTouch(Landroid/widget/SeekBar;)V', [s]))
    },
    'setThumb(Landroid/graphics/drawable/Drawable;)V': noop, 'setThumbOffset(I)V': noop, 'setKeyProgressIncrement(I)V': noop,
  })

  // ---------- tabs ----------
  // TabHost: setup() finds the TabWidget (android:id/tabs) and the content frame (android:id/tabcontent)
  const TABS_ID = 0x1020013, TABCONTENT_ID = 0x1020011
  const findIn = (root: JObject, id: number): JObject | null => {
    const v = w.views.get(id)
    if (v && el(root).contains(el(v))) return v
    return null
  }
  const showTab = (s: JObject, i: number, fire: boolean) => {
    const tabs: any[] = s.f.tabs || []
    if (!tabs[i]) return
    const prev = s.f.current
    s.f.current = i
    tabs.forEach((t, k) => {
      t.ind?.classList.toggle('selected', k === i)
      if (t.view) el(t.view).style.display = k === i ? '' : 'none'
    })
    const t = tabs[i]
    if (!t.view && t.factory) {
      t.view = vm.callVirtual(t.factory, 'createTabContent(Ljava/lang/String;)Landroid/view/View;', [t.tag]) as JObject
      if (t.view && s.f.content) el(s.f.content).append(el(t.view))
    }
    if (!t.view && t.intent) vm.callVirtual(w.activity(), 'startActivity(Landroid/content/Intent;)V', [t.intent])
    if (fire && prev !== i && s.f.onChange) call(s.f.onChange, 'onTabChanged(Ljava/lang/String;)V', [t.tag])
  }
  def('Landroid/widget/TabHost;', 'Landroid/widget/FrameLayout;', {
    'setup()V': (v, s) => {
      s.f.widget = findIn(s, TABS_ID); s.f.content = findIn(s, TABCONTENT_ID); s.f.tabs ||= []
      if (s.f.widget) { const we = el(s.f.widget); we.classList.add('h-tabs'); we.style.display = 'flex' }
    },
    'setup(Landroid/app/LocalActivityManager;)V': (v, s) => vm.callVirtual(s, 'setup()V'),
    'newTabSpec(Ljava/lang/String;)Landroid/widget/TabHost$TabSpec;': (v, s, [tag]) => obj('Landroid/widget/TabHost$TabSpec;', { tag: text(tag), host: s }),
    'addTab(Landroid/widget/TabHost$TabSpec;)V': (v, s, [spec]) => {
      const tabs: any[] = (s.f.tabs ||= [])
      const i = tabs.length
      let ind: HTMLElement
      if (spec.f.indView) ind = el(spec.f.indView)
      else { ind = document.createElement('span'); ind.className = 'h-tab'; ind.textContent = spec.f.label ?? spec.f.tag }
      ind.style.flex = '1'
      ind.addEventListener('click', () => showTab(s, i, true))
      if (s.f.widget) el(s.f.widget).append(ind)
      const view = spec.f.contentId ? w.views.get(spec.f.contentId) ?? null : null
      tabs.push({ tag: spec.f.tag, ind, view, factory: spec.f.factory, intent: spec.f.intent })
      if (view) el(view).style.display = 'none'
      if (i === 0) showTab(s, 0, false)
    },
    'clearAllTabs()V': (v, s) => { if (s.f.widget) el(s.f.widget).innerHTML = ''; s.f.tabs = []; s.f.current = -1 },
    'setCurrentTab(I)V': (v, s, [i]) => showTab(s, i, true),
    'setCurrentTabByTag(Ljava/lang/String;)V': (v, s, [tag]) => showTab(s, (s.f.tabs || []).findIndex((t: any) => t.tag === text(tag)), true),
    'getCurrentTab()I': (v, s) => s.f.current ?? -1,
    'getCurrentTabTag()Ljava/lang/String;': (v, s) => s.f.tabs?.[s.f.current]?.tag ?? null,
    'getCurrentTabView()Landroid/view/View;': () => null,
    'getCurrentView()Landroid/view/View;': (v, s) => s.f.tabs?.[s.f.current]?.view ?? null,
    'getTabWidget()Landroid/widget/TabWidget;': (v, s) => s.f.widget ?? null,
    'getTabContentView()Landroid/widget/FrameLayout;': (v, s) => s.f.content ?? null,
    'setOnTabChangedListener(Landroid/widget/TabHost$OnTabChangeListener;)V': (v, s, [l]) => { s.f.onChange = l },
    'dispatchWindowFocusChanged(Z)V': noop,
  })
  def('Landroid/widget/TabHost$TabSpec;', OBJ, {
    'setIndicator(Ljava/lang/CharSequence;)Landroid/widget/TabHost$TabSpec;': (v, s, [t]) => { s.f.label = text(t); return s },
    'setIndicator(Ljava/lang/CharSequence;Landroid/graphics/drawable/Drawable;)Landroid/widget/TabHost$TabSpec;': (v, s, [t]) => { s.f.label = text(t); return s },
    'setIndicator(Landroid/view/View;)Landroid/widget/TabHost$TabSpec;': (v, s, [view]) => { s.f.indView = view; return s },
    'setContent(I)Landroid/widget/TabHost$TabSpec;': (v, s, [id]) => { s.f.contentId = id; return s },
    'setContent(Landroid/widget/TabHost$TabContentFactory;)Landroid/widget/TabHost$TabSpec;': (v, s, [f]) => { s.f.factory = f; return s },
    'setContent(Landroid/content/Intent;)Landroid/widget/TabHost$TabSpec;': (v, s, [i]) => { s.f.intent = i; return s },
    'getTag()Ljava/lang/String;': (v, s) => s.f.tag,
  })
  def('Landroid/widget/TabWidget;', 'Landroid/widget/LinearLayout;', {
    'getChildCount()I': (v, s) => el(s).children.length,
    'getChildAt(I)Landroid/view/View;': (v, s, [i]) => { const c = el(s).children[i] as any; if (!c) return null; if (!c.__view) { c.__view = obj('Landroid/widget/TextView;', { el: c }) } return c.__view },
    'getChildTabViewAt(I)Landroid/view/View;': (v, s, [i]) => vm.callVirtual(s, 'getChildAt(I)Landroid/view/View;', [i]),
    'getTabCount()I': (v, s) => el(s).children.length,
    'setStripEnabled(Z)V': noop, 'setDividerDrawable(I)V': noop, 'setDividerDrawable(Landroid/graphics/drawable/Drawable;)V': noop, 'setCurrentTab(I)V': noop,
  })

  // ---------- menus from xml ----------
  def('Landroid/view/MenuInflater;', OBJ, {
    '<init>(Landroid/content/Context;)V': noop,
    'inflate(ILandroid/view/Menu;)V': (v, s, [id]) => {
      const r = w.res(id)
      const xml = r?.type === T.STRING ? env.files.get(r.str!) : undefined
      if (!xml) return
      const walk = (n: XmlNode) => {
        if (n.tag === 'item') {
          const idv = attr(n, 'id'), title = w.valueText(attr(n, 'title')) ?? '', icon = attr(n, 'icon')
          const order = attr(n, 'orderInCategory')?.data ?? 0
          const it = w.addMenuItem((idv?.data ?? 0) | 0, title, icon?.type === T.REFERENCE ? w.drawableUrl(icon.data) : undefined, order)
          const show = attr(n, 'showAsAction')
          if (show) it.f.showAsAction = show.data
          const vis = attr(n, 'visible')
          if (vis && !vis.data) it.f.hidden = true
          const en = attr(n, 'enabled')
          if (en && !en.data) it.f.disabled = true
          const chk = attr(n, 'checkable')
          if (chk && chk.data) it.f.checkable = true
        }
        for (const c of n.children) if (c.tag !== 'menu' || n.tag === 'menu') walk(c)
      }
      walk(parseAxml(xml))
    },
  })
  def('Landroid/app/Activity;', 'Landroid/view/ContextThemeWrapper;', {
    'getMenuInflater()Landroid/view/MenuInflater;': () => obj('Landroid/view/MenuInflater;'),
    'onUserLeaveHint()V': noop, 'onNewIntent(Landroid/content/Intent;)V': noop,
  })

  // ---------- gestures ----------
  const GD = 'Landroid/view/GestureDetector;'
  const gdInit: NativeFn = (v, s, args) => { s.f.l = args.find((a: any) => a instanceof JObject && !vm.isSubclass(a.cls, vm.cls('Landroid/content/Context;'))) ?? null; s.f.down = null }
  def(GD, OBJ, {
    '<init>(Landroid/view/GestureDetector$OnGestureListener;)V': gdInit,
    '<init>(Landroid/content/Context;Landroid/view/GestureDetector$OnGestureListener;)V': gdInit,
    '<init>(Landroid/content/Context;Landroid/view/GestureDetector$OnGestureListener;Landroid/os/Handler;)V': gdInit,
    'setIsLongpressEnabled(Z)V': noop, 'setOnDoubleTapListener(Landroid/view/GestureDetector$OnDoubleTapListener;)V': (v, s, [l]) => { s.f.dbl = l },
    'onTouchEvent(Landroid/view/MotionEvent;)Z': (v, s, [e]) => {
      const a = e.f.action & 0xff, p = e.f.ps?.[0] ?? { x: 0, y: 0 }
      const now = Number(e.f.time ?? 0n)
      if (a === 0) {
        s.f.down = { x: p.x, y: p.y, t: now, e, moved: false }
        call(s.f.l, 'onDown(Landroid/view/MotionEvent;)Z', [e])
        clearTimeout(s.f.lp)
        s.f.lp = setTimeout(() => { if (s.f.down && !s.f.down.moved) { s.f.down.long = true; call(s.f.l, 'onLongPress(Landroid/view/MotionEvent;)V', [e]) } }, 500)
        return 1
      }
      const d = s.f.down
      if (!d) return 0
      const dx = p.x - d.x, dy = p.y - d.y
      if (a === 2) {
        if (!d.moved && Math.hypot(dx, dy) > 8 * dp) { d.moved = true; clearTimeout(s.f.lp) }
        if (d.moved) { call(s.f.l, 'onScroll(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z', [d.e, e, (d.lx ?? d.x) - p.x, (d.ly ?? d.y) - p.y]); d.lx = p.x; d.ly = p.y }
        d.last = { x: p.x, y: p.y, t: now }
        return 1
      }
      if (a === 1) {
        clearTimeout(s.f.lp)
        s.f.down = null
        if (d.long) return 1
        if (!d.moved) {
          call(s.f.l, 'onSingleTapUp(Landroid/view/MotionEvent;)Z', [e])
          const dbl = s.f.dbl ?? s.f.l
          if (s.f.lastTap && now - s.f.lastTap < 300) { s.f.lastTap = 0; call(dbl, 'onDoubleTap(Landroid/view/MotionEvent;)Z', [e]) }
          else { s.f.lastTap = now; setTimeout(() => { if (s.f.lastTap === now) call(dbl, 'onSingleTapConfirmed(Landroid/view/MotionEvent;)Z', [e]) }, 300) }
          return 1
        }
        const dt = Math.max(1, now - (d.last?.t ?? d.t)) / 1000
        const vx = (p.x - (d.last?.x ?? d.x)) / dt, vy = (p.y - (d.last?.y ?? d.y)) / dt
        if (Math.hypot(vx, vy) > 50 * dp) call(s.f.l, 'onFling(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z', [d.e, e, Math.fround(vx), Math.fround(vy)])
        return 1
      }
      if (a === 3) { clearTimeout(s.f.lp); s.f.down = null }
      return 0
    },
  })
  const SOGL = 'Landroid/view/GestureDetector$SimpleOnGestureListener;'
  def(SOGL, OBJ, {
    '<init>()V': noop,
    'onDown(Landroid/view/MotionEvent;)Z': () => 0, 'onSingleTapUp(Landroid/view/MotionEvent;)Z': () => 0, 'onLongPress(Landroid/view/MotionEvent;)V': noop,
    'onScroll(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z': () => 0, 'onFling(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z': () => 0,
    'onShowPress(Landroid/view/MotionEvent;)V': noop, 'onDoubleTap(Landroid/view/MotionEvent;)Z': () => 0, 'onDoubleTapEvent(Landroid/view/MotionEvent;)Z': () => 0,
    'onSingleTapConfirmed(Landroid/view/MotionEvent;)Z': () => 0,
  }, { interfaces: ['Landroid/view/GestureDetector$OnGestureListener;', 'Landroid/view/GestureDetector$OnDoubleTapListener;'] })

  // ---------- attribute sets for custom views ----------
  def('Landroid/util/AttributeSet;', OBJ, {
    'getAttributeCount()I': (v, s) => s.f.node?.attrs.length ?? 0,
    'getAttributeName(I)Ljava/lang/String;': (v, s, [i]) => s.f.node?.attrs[i]?.name ?? null,
    'getAttributeValue(I)Ljava/lang/String;': (v, s, [i]) => { const a = s.f.node?.attrs[i]; return a ? a.value.str ?? a.value.raw ?? String(a.value.data) : null },
    'getAttributeValue(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [, n]) => { const a = s.f.node?.attrs.find((x: any) => x.name === text(n)); return a ? a.value.str ?? a.value.raw ?? String(a.value.data) : null },
    'getAttributeIntValue(Ljava/lang/String;Ljava/lang/String;I)I': (v, s, [, n, d]) => { const a = s.f.node?.attrs.find((x: any) => x.name === text(n)); return a ? a.value.data | 0 : d },
    'getAttributeBooleanValue(Ljava/lang/String;Ljava/lang/String;Z)Z': (v, s, [, n, d]) => { const a = s.f.node?.attrs.find((x: any) => x.name === text(n)); return a ? (a.value.data ? 1 : 0) : d },
    'getAttributeResourceValue(Ljava/lang/String;Ljava/lang/String;I)I': (v, s, [, n, d]) => { const a = s.f.node?.attrs.find((x: any) => x.name === text(n)); return a && a.value.type === T.REFERENCE ? a.value.data | 0 : d },
    'getIdAttributeResourceValue(I)I': (v, s, [d]) => (attr(s.f.node, 'id')?.data ?? 0) | 0 || d,
    'getStyleAttribute()I': () => 0,
  })
  // TypedArray from a view's attributes: index i of the styleable array -> that attribute's value
  const TA = 'Landroid/content/res/TypedArray;'
  const taVal = (s: JObject, i: number): XmlValue | undefined => {
    const want = s.f.ids?.[i]
    return want === undefined ? undefined : s.f.node?.attrs.find((a: any) => a.resId === want)?.value
  }
  def(TA, OBJ, {
    'getString(I)Ljava/lang/String;': (v, s, [i]) => w.valueText(taVal(s, i)) ?? null,
    'getText(I)Ljava/lang/CharSequence;': (v, s, [i]) => w.valueText(taVal(s, i)) ?? null,
    'getBoolean(IZ)Z': (v, s, [i, d]) => { const x = taVal(s, i); return x ? (x.data ? 1 : 0) : d },
    'getInt(II)I': (v, s, [i, d]) => taVal(s, i)?.data ?? d,
    'getInteger(II)I': (v, s, [i, d]) => taVal(s, i)?.data ?? d,
    'getFloat(IF)F': (v, s, [i, d]) => { const x = taVal(s, i); return x ? new Float32Array(new Uint32Array([x.data]).buffer)[0] : d },
    'getColor(II)I': (v, s, [i, d]) => { const x = taVal(s, i); if (!x) return d; const r = x.type === T.REFERENCE ? w.res(x.data) : x; return r ? r.data | 0 : d },
    'getResourceId(II)I': (v, s, [i, d]) => { const x = taVal(s, i); return x && x.type === T.REFERENCE ? x.data | 0 : d },
    'getDimension(IF)F': (v, s, [i, d]) => taVal(s, i)?.data !== undefined ? Math.fround(dimenOf(taVal(s, i)!) * dp) : d,
    'getDimensionPixelSize(II)I': (v, s, [i, d]) => taVal(s, i) ? Math.round(dimenOf(taVal(s, i)!) * dp) : d,
    'getDimensionPixelOffset(II)I': (v, s, [i, d]) => taVal(s, i) ? Math.round(dimenOf(taVal(s, i)!) * dp) : d,
    'getLayoutDimension(II)I': (v, s, [i, d]) => { const x = taVal(s, i); return x ? (x.type === T.DIMENSION ? Math.round(dimenOf(x) * dp) : x.data | 0) : d },
    'getDrawable(I)Landroid/graphics/drawable/Drawable;': (v, s, [i]) => { const x = taVal(s, i); return x && x.type === T.REFERENCE ? resDrawable(x.data) : null },
    'hasValue(I)Z': (v, s, [i]) => (taVal(s, i) ? 1 : 0),
    'getIndexCount()I': (v, s) => (s.f.ids || []).filter((_: any, i: number) => taVal(s, i)).length,
    'getIndex(I)I': (v, s, [k]) => (s.f.ids || []).map((_: any, i: number) => i).filter((i: number) => taVal(s, i))[k] ?? 0,
    'length()I': (v, s) => (s.f.ids || []).length,
    'recycle()V': noop,
  })
  const RADIX = [1, 1 / 128, 1 / 32768, 1 / 8388608]
  const dimenOf = (x: XmlValue) => {
    if (x.type !== T.DIMENSION) return x.data | 0
    const value = (x.data >> 8) * RADIX[(x.data >> 4) & 3], unit = x.data & 0xf
    return unit === 0 ? value / dp : value
  }
  const obtain: NativeFn = (v, s, args) => {
    const set = args.find((a: any) => a instanceof JObject && a.cls.name === 'Landroid/util/AttributeSet;') ?? null
    const ids = args.find((a: any) => a instanceof JArray)
    return obj(TA, { node: set?.f.node ?? null, ids: ids ? [...(ids.data as Int32Array)] : [] })
  }
  for (const c of ['Landroid/content/Context;', 'Landroid/content/res/Resources$Theme;']) def(c, OBJ, {
    'obtainStyledAttributes(Landroid/util/AttributeSet;[I)Landroid/content/res/TypedArray;': obtain,
    'obtainStyledAttributes(Landroid/util/AttributeSet;[III)Landroid/content/res/TypedArray;': obtain,
    'obtainStyledAttributes([I)Landroid/content/res/TypedArray;': obtain,
    'obtainStyledAttributes(I[I)Landroid/content/res/TypedArray;': obtain,
  })

  // ---------- misc ----------
  def('Landroid/view/Window;', OBJ, { 'findViewById(I)Landroid/view/View;': (v, s, [id]) => w.views.get(id) ?? null, 'getDecorView()Landroid/view/View;': () => w.views.get(0x1020002) ?? null })
  def('Landroid/widget/RemoteViews;', OBJ, {
    '<init>(Ljava/lang/String;I)V': (v, s, [p, id]) => { s.f.pkg = text(p); s.f.layout = id; s.f.vals = {} },
    'setTextViewText(ILjava/lang/CharSequence;)V': (v, s, [id, t]) => { s.f.vals[id] = text(t) },
    'setImageViewResource(II)V': noop, 'setImageViewBitmap(ILandroid/graphics/Bitmap;)V': noop, 'setViewVisibility(II)V': noop, 'setProgressBar(IIIZ)V': noop,
    'setOnClickPendingIntent(ILandroid/app/PendingIntent;)V': (v, s, [, pi]) => { s.f.pi ??= pi }, 'setInt(ILjava/lang/String;I)V': noop, 'setTextColor(II)V': noop,
  })
  def('Landroid/webkit/CookieManager;', OBJ, {
    'getInstance()Landroid/webkit/CookieManager;': () => cookies,
    'setAcceptCookie(Z)V': noop, 'acceptCookie()Z': () => 1,
    'getCookie(Ljava/lang/String;)Ljava/lang/String;': (v, s, [u]) => { try { return s.f.jar.get(new URL(text(u)).host) ?? null } catch { return null } },
    'setCookie(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [u, c]) => { try { const h = new URL(text(u)).host; const kv = text(c).split(';')[0]; const prev = (s.f.jar.get(h) || '').split('; ').filter((x: string) => x && x.split('=')[0] !== kv.split('=')[0]); s.f.jar.set(h, [...prev, kv].join('; ')) } catch { /* bad url */ } },
    'removeAllCookie()V': (v, s) => { s.f.jar.clear() }, 'removeAllCookies(Landroid/webkit/ValueCallback;)V': (v, s) => { s.f.jar.clear() },
    'removeSessionCookie()V': noop, 'hasCookies()Z': (v, s) => (s.f.jar.size ? 1 : 0), 'flush()V': noop, 'setAcceptThirdPartyCookies(Landroid/webkit/WebView;Z)V': noop,
  })
  const cookies = obj('Landroid/webkit/CookieManager;', { jar: new Map<string, string>() })
  def('Landroid/webkit/CookieSyncManager;', OBJ, { 'createInstance(Landroid/content/Context;)Landroid/webkit/CookieSyncManager;': () => obj('Landroid/webkit/CookieSyncManager;'), 'getInstance()Landroid/webkit/CookieSyncManager;': () => obj('Landroid/webkit/CookieSyncManager;'), 'sync()V': noop, 'startSync()V': noop, 'stopSync()V': noop })

  // ---------- uris, intents ----------
  const U = 'Landroid/net/Uri;'
  const uri = (x: string) => obj(U, { s: x })
  const parsed = (u: JObject): URL | null => { try { return new URL(String(u.f.s)) } catch { return null } }
  def(U, OBJ, {
    'fromFile(Ljava/io/File;)Landroid/net/Uri;': (v, s, [f]) => uri('file://' + text(vm.callVirtual(f, 'getAbsolutePath()Ljava/lang/String;'))),
    'fromParts(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri;': (v, s, [a, b, c]) => uri(`${text(a)}:${text(b)}${c ? '#' + text(c) : ''}`),
    'getScheme()Ljava/lang/String;': (v, s) => { const m = String(s.f.s).match(/^([a-zA-Z][\w+.-]*):/); return m ? m[1] : null },
    'getHost()Ljava/lang/String;': (v, s) => parsed(s)?.hostname || null,
    'getPort()I': (v, s) => Number(parsed(s)?.port || -1),
    'getAuthority()Ljava/lang/String;': (v, s) => parsed(s)?.host || null,
    'getPath()Ljava/lang/String;': (v, s) => { const p = parsed(s); return p ? decodeURIComponent(p.pathname) : String(s.f.s).split(/[?#]/)[0] },
    'getEncodedPath()Ljava/lang/String;': (v, s) => parsed(s)?.pathname ?? null,
    'getQuery()Ljava/lang/String;': (v, s) => { const q = parsed(s)?.search; return q ? decodeURIComponent(q.slice(1)) : null },
    'getEncodedQuery()Ljava/lang/String;': (v, s) => { const q = parsed(s)?.search; return q ? q.slice(1) : null },
    'getFragment()Ljava/lang/String;': (v, s) => { const q = parsed(s)?.hash; return q ? decodeURIComponent(q.slice(1)) : null },
    'getLastPathSegment()Ljava/lang/String;': (v, s) => { const p = (parsed(s)?.pathname ?? String(s.f.s)).split('/').filter(Boolean); return p.length ? decodeURIComponent(p[p.length - 1]) : null },
    'getPathSegments()Ljava/util/List;': (v, s) => { const l = vm.newObject('Ljava/util/ArrayList;'); for (const x of (parsed(s)?.pathname ?? '').split('/').filter(Boolean)) vm.callVirtual(l, 'add(Ljava/lang/Object;)Z', [decodeURIComponent(x)]); return l },
    'getQueryParameter(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => parsed(s)?.searchParams.get(text(k)) ?? null,
    'getSchemeSpecificPart()Ljava/lang/String;': (v, s) => String(s.f.s).replace(/^[a-zA-Z][\w+.-]*:/, '').split('#')[0],
    'isAbsolute()Z': (v, s) => (/^[a-zA-Z][\w+.-]*:/.test(String(s.f.s)) ? 1 : 0),
    'encode(Ljava/lang/String;)Ljava/lang/String;': (v, s, [x]) => encodeURIComponent(text(x)),
    'decode(Ljava/lang/String;)Ljava/lang/String;': (v, s, [x]) => { try { return decodeURIComponent(text(x)) } catch { return text(x) } },
    'withAppendedPath(Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;': (v, s, [b, x]) => uri(String(b.f.s).replace(/\/$/, '') + '/' + encodeURIComponent(text(x))),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o?.f?.s === s.f.s ? 1 : 0), 'hashCode()I': (v, s) => { let h = 0; for (const c of String(s.f.s)) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0; return h },
    'buildUpon()Landroid/net/Uri$Builder;': (v, s) => obj('Landroid/net/Uri$Builder;', { u: String(s.f.s) }),
  }, { statics: { EMPTY: uri('') } })
  def('Landroid/net/Uri$Builder;', OBJ, {
    '<init>()V': (v, s) => { s.f.u = '' },
    'scheme(Ljava/lang/String;)Landroid/net/Uri$Builder;': (v, s, [x]) => { s.f.u = text(x) + '://' + s.f.u.replace(/^[^:]*:\/\//, ''); return s },
    'authority(Ljava/lang/String;)Landroid/net/Uri$Builder;': (v, s, [x]) => { const m = s.f.u.match(/^([^:]*:\/\/)?[^/?#]*(.*)$/); s.f.u = (m[1] || '//') + text(x) + m[2]; return s },
    'path(Ljava/lang/String;)Landroid/net/Uri$Builder;': (v, s, [x]) => { s.f.u = s.f.u.replace(/^((?:[^:]*:)?\/\/[^/?#]*)[^?#]*/, '$1') + text(x); return s },
    'appendPath(Ljava/lang/String;)Landroid/net/Uri$Builder;': (v, s, [x]) => { const [a, q = ''] = s.f.u.split(/(?=[?#])/); s.f.u = a.replace(/\/$/, '') + '/' + encodeURIComponent(text(x)) + q; return s },
    'appendEncodedPath(Ljava/lang/String;)Landroid/net/Uri$Builder;': (v, s, [x]) => { const [a, q = ''] = s.f.u.split(/(?=[?#])/); s.f.u = a.replace(/\/$/, '') + '/' + text(x) + q; return s },
    'appendQueryParameter(Ljava/lang/String;Ljava/lang/String;)Landroid/net/Uri$Builder;': (v, s, [k, x]) => { s.f.u += (s.f.u.includes('?') ? '&' : '?') + encodeURIComponent(text(k)) + '=' + encodeURIComponent(text(x)); return s },
    'encodedQuery(Ljava/lang/String;)Landroid/net/Uri$Builder;': (v, s, [x]) => { s.f.u = s.f.u.split('?')[0] + (x ? '?' + text(x) : ''); return s },
    'fragment(Ljava/lang/String;)Landroid/net/Uri$Builder;': (v, s, [x]) => { s.f.u = s.f.u.split('#')[0] + '#' + encodeURIComponent(text(x)); return s },
    'build()Landroid/net/Uri;': (v, s) => uri(s.f.u), 'toString()Ljava/lang/String;': (v, s) => s.f.u,
  })
  const extras = (s: JObject) => (s.f.extras ||= {})
  def('Landroid/content/Intent;', OBJ, {
    'getData()Landroid/net/Uri;': (v, s) => (s.f.data != null ? uri(String(s.f.data)) : null),
    'getDataString()Ljava/lang/String;': (v, s) => s.f.data ?? null,
    'setData(Landroid/net/Uri;)Landroid/content/Intent;': (v, s, [u]) => { s.f.data = u?.f.s ?? null; return s },
    'setDataAndType(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;': (v, s, [u, t]) => { s.f.data = u?.f.s ?? null; s.f.type = t; return s },
    'getType()Ljava/lang/String;': (v, s) => s.f.type ?? null,
    'createChooser(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;': (v, s, [i]) => i,
    'putExtra(Ljava/lang/String;[Ljava/lang/String;)Landroid/content/Intent;': (v, s, [k, a]) => { extras(s)[k] = a; return s },
    'getStringArrayExtra(Ljava/lang/String;)[Ljava/lang/String;': (v, s, [k]) => extras(s)[k] ?? null,
    'putExtra(Ljava/lang/String;Ljava/io/Serializable;)Landroid/content/Intent;': (v, s, [k, a]) => { extras(s)[k] = a; return s },
    'getSerializableExtra(Ljava/lang/String;)Ljava/io/Serializable;': (v, s, [k]) => extras(s)[k] ?? null,
    'putExtra(Ljava/lang/String;Landroid/os/Parcelable;)Landroid/content/Intent;': (v, s, [k, a]) => { extras(s)[k] = a; return s },
    'getParcelableExtra(Ljava/lang/String;)Landroid/os/Parcelable;': (v, s, [k]) => extras(s)[k] ?? null,
    'removeExtra(Ljava/lang/String;)V': (v, s, [k]) => { delete extras(s)[k] },
    'getComponent()Landroid/content/ComponentName;': (v, s) => (s.f.target ? obj('Landroid/content/ComponentName;', { pkg: env.pkg, cls: String(s.f.target).slice(1, -1).replace(/\//g, '.') }) : null),
    'setPackage(Ljava/lang/String;)Landroid/content/Intent;': (v, s) => s,
    'addCategory(Ljava/lang/String;)Landroid/content/Intent;': (v, s) => s,
    'getFlags()I': () => 0,
  })
  def('Landroid/content/ComponentName;', OBJ, {
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [p, c]) => { s.f.pkg = text(p); s.f.cls = text(c) },
    '<init>(Landroid/content/Context;Ljava/lang/Class;)V': (v, s, [, c]) => { s.f.pkg = env.pkg; s.f.cls = c.f.of.name.slice(1, -1).replace(/\//g, '.') },
    'getPackageName()Ljava/lang/String;': (v, s) => s.f.pkg, 'getClassName()Ljava/lang/String;': (v, s) => s.f.cls,
    'getShortClassName()Ljava/lang/String;': (v, s) => (s.f.cls.startsWith(s.f.pkg) ? s.f.cls.slice(s.f.pkg.length) : s.f.cls),
    'flattenToString()Ljava/lang/String;': (v, s) => `${s.f.pkg}/${s.f.cls}`,
  })

  // ---------- activity odds and ends ----------
  def('Landroid/app/Activity;', 'Landroid/view/ContextThemeWrapper;', {
    'getLastNonConfigurationInstance()Ljava/lang/Object;': () => null,
    'onRetainNonConfigurationInstance()Ljava/lang/Object;': () => null,
    'getChangingConfigurations()I': () => 0, 'isChangingConfigurations()Z': () => 0,
    'getCallingActivity()Landroid/content/ComponentName;': () => null, 'getCallingPackage()Ljava/lang/String;': () => null,
    'getComponentName()Landroid/content/ComponentName;': (v, s) => obj('Landroid/content/ComponentName;', { pkg: env.pkg, cls: s.cls.name.slice(1, -1).replace(/\//g, '.') }),
    'getLocalClassName()Ljava/lang/String;': (v, s) => s.cls.name.slice(1, -1).replace(/\//g, '.').replace(env.pkg + '.', ''),
    'isTaskRoot()Z': () => 1, 'moveTaskToBack(Z)Z': () => 1, 'hasWindowFocus()Z': () => 1,
    'setProgressBarIndeterminateVisibility(Z)V': noop, 'setProgressBarVisibility(Z)V': noop, 'setProgressBarIndeterminate(Z)V': noop,
    'setDefaultKeyMode(I)V': noop, 'setVolumeControlStream(I)V': noop, 'takeKeyEvents(Z)V': noop,
    'openOptionsMenu()V': noop, 'closeOptionsMenu()V': noop, 'invalidateOptionsMenu()V': noop,
    'registerForContextMenu(Landroid/view/View;)V': noop, 'unregisterForContextMenu(Landroid/view/View;)V': noop,
    'showDialog(I)V': (v, s, [id]) => { const d = (s.f.dialogs ||= {})[id] ??= call(s, 'onCreateDialog(I)Landroid/app/Dialog;', [id]); if (d) vm.callVirtual(d, 'show()V') },
    'dismissDialog(I)V': (v, s, [id]) => { const d = s.f.dialogs?.[id]; if (d) vm.callVirtual(d, 'dismiss()V') },
    'removeDialog(I)V': (v, s, [id]) => { const d = s.f.dialogs?.[id]; if (d) { vm.callVirtual(d, 'dismiss()V'); delete s.f.dialogs[id] } },
    'onCreateDialog(I)Landroid/app/Dialog;': () => null,
    'getParent()Landroid/app/Activity;': () => null, 'isChild()Z': () => 0,
  })

  // ---------- web views: the page in an iframe ----------
  const WV = 'Landroid/webkit/WebView;'
  const frameOf = (s: JObject): HTMLIFrameElement => {
    const e = el(s)
    let f = e.querySelector(':scope > iframe') as HTMLIFrameElement | null
    if (!f) { f = document.createElement('iframe'); f.style.cssText = 'border:0;width:100%;height:100%;display:block;background:#fff'; f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups'); e.append(f) }
    return f
  }
  def(WV, 'Landroid/widget/AbsoluteLayout;', {
    '<init>(Landroid/content/Context;)V': (v, s) => { s.f.el ??= Object.assign(document.createElement('div'), { className: 'an-view' }); s.f.el.__view = s; s.f.settings = obj('Landroid/webkit/WebSettings;', { ua: navigator.userAgent }) },
    'loadUrl(Ljava/lang/String;)V': (v, s, [u]) => {
      const url = text(u)
      if (url.startsWith('javascript:')) return
      const f = frameOf(s); f.removeAttribute('srcdoc'); f.src = url; s.f.url = url
      if (s.f.client) { call(s.f.client, 'onPageStarted(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V', [s, url, null]); f.onload = () => call(s.f.client, 'onPageFinished(Landroid/webkit/WebView;Ljava/lang/String;)V', [s, url]) }
    },
    'loadUrl(Ljava/lang/String;Ljava/util/Map;)V': (v, s, [u]) => vm.callVirtual(s, 'loadUrl(Ljava/lang/String;)V', [u]),
    'loadData(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (v, s, [d]) => { frameOf(s).srcdoc = text(d) },
    'loadDataWithBaseURL(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (v, s, [, d]) => { frameOf(s).srcdoc = text(d) },
    'getUrl()Ljava/lang/String;': (v, s) => s.f.url ?? null, 'getTitle()Ljava/lang/String;': () => null, 'getProgress()I': () => 100,
    'stopLoading()V': noop, 'reload()V': (v, s) => { const f = frameOf(s); f.src = f.src },
    'canGoBack()Z': () => 0, 'goBack()V': noop, 'canGoForward()Z': () => 0, 'goForward()V': noop, 'clearHistory()V': noop, 'clearCache(Z)V': noop,
    'destroy()V': (v, s) => { el(s).querySelector('iframe')?.remove() }, 'onPause()V': noop, 'onResume()V': noop, 'pauseTimers()V': noop, 'resumeTimers()V': noop,
    'getSettings()Landroid/webkit/WebSettings;': (v, s) => (s.f.settings ??= obj('Landroid/webkit/WebSettings;', { ua: navigator.userAgent })),
    'setWebViewClient(Landroid/webkit/WebViewClient;)V': (v, s, [c]) => { s.f.client = c }, 'setWebChromeClient(Landroid/webkit/WebChromeClient;)V': noop,
    'addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V': noop, 'removeJavascriptInterface(Ljava/lang/String;)V': noop,
    'evaluateJavascript(Ljava/lang/String;Landroid/webkit/ValueCallback;)V': noop,
    'setDownloadListener(Landroid/webkit/DownloadListener;)V': noop, 'setInitialScale(I)V': noop, 'setScrollBarStyle(I)V': noop,
  })
  def('Landroid/webkit/WebSettings;', OBJ, {
    'getUserAgentString()Ljava/lang/String;': (v, s) => s.f.ua, 'setUserAgentString(Ljava/lang/String;)V': (v, s, [u]) => { s.f.ua = u == null ? navigator.userAgent : text(u) },
    'setJavaScriptEnabled(Z)V': noop, 'getJavaScriptEnabled()Z': () => 1, 'setDomStorageEnabled(Z)V': noop, 'setBuiltInZoomControls(Z)V': noop, 'setSupportZoom(Z)V': noop,
    'setLoadWithOverviewMode(Z)V': noop, 'setUseWideViewPort(Z)V': noop, 'setCacheMode(I)V': noop, 'setAppCacheEnabled(Z)V': noop, 'setDatabaseEnabled(Z)V': noop,
    'setPluginState(Landroid/webkit/WebSettings$PluginState;)V': noop, 'setAllowFileAccess(Z)V': noop, 'setJavaScriptCanOpenWindowsAutomatically(Z)V': noop, 'setMediaPlaybackRequiresUserGesture(Z)V': noop,
    'setDefaultTextEncodingName(Ljava/lang/String;)V': noop, 'setLoadsImagesAutomatically(Z)V': noop, 'setSaveFormData(Z)V': noop, 'setSavePassword(Z)V': noop,
  })
  def('Landroid/webkit/WebViewClient;', OBJ, {
    '<init>()V': noop, 'shouldOverrideUrlLoading(Landroid/webkit/WebView;Ljava/lang/String;)Z': () => 0,
    'onPageStarted(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V': noop, 'onPageFinished(Landroid/webkit/WebView;Ljava/lang/String;)V': noop,
    'onReceivedError(Landroid/webkit/WebView;ILjava/lang/String;Ljava/lang/String;)V': noop,
  })
  def('Landroid/webkit/WebChromeClient;', OBJ, { '<init>()V': noop, 'onProgressChanged(Landroid/webkit/WebView;I)V': noop })

  // ---------- video view extras ----------
  const video = (s: JObject) => el(s) as HTMLVideoElement
  def('Landroid/widget/VideoView;', 'Landroid/view/SurfaceView;', {
    'getHolder()Landroid/view/SurfaceHolder;': (v, s) => (s.f.vholder ??= obj('Landroid/view/SurfaceHolder;', { view: s, callbacks: [], format: 4 })),
    'getBufferPercentage()I': (v, s) => { const e = video(s); try { return e.duration ? Math.round((e.buffered.length ? e.buffered.end(e.buffered.length - 1) : 0) / e.duration * 100) : 0 } catch { return 0 } },
    'setOnPreparedListener(Landroid/media/MediaPlayer$OnPreparedListener;)V': (v, s, [l]) => { video(s).addEventListener('loadedmetadata', () => call(l, 'onPrepared(Landroid/media/MediaPlayer;)V', [obj('Landroid/media/MediaPlayer;', { videoEl: video(s) })])) },
    'setOnErrorListener(Landroid/media/MediaPlayer$OnErrorListener;)V': (v, s, [l]) => { video(s).addEventListener('error', () => call(l, 'onError(Landroid/media/MediaPlayer;II)Z', [null, 1, 0])) },
    'setOnInfoListener(Landroid/media/MediaPlayer$OnInfoListener;)V': noop,
    'canPause()Z': () => 1, 'canSeekBackward()Z': () => 1, 'canSeekForward()Z': () => 1, 'resume()V': (v, s) => { video(s).play().catch(() => {}) },
  })
  def('Landroid/media/MediaPlayer;', OBJ, {
    'getVideoWidth()I': (v, s) => s.f.videoEl?.videoWidth ?? 0, 'getVideoHeight()I': (v, s) => s.f.videoEl?.videoHeight ?? 0,
  })

  // ---------- small leftovers ----------
  def('Landroid/widget/LinearLayout;', 'Landroid/view/ViewGroup;', {
    'setGravity(I)V': (v, s, [g]) => { const e = el(s); const hz = g & 7, vt = (g >> 4) & 7; const row = e.style.flexDirection !== 'column'; const main = row ? hz : vt, cross = row ? vt : hz; const pos = (x: number) => (x === 1 ? 'center' : x === 5 || x === 3 && false ? 'flex-end' : x === 8 || x === 5 ? 'flex-end' : ''); e.style.justifyContent = pos(main); e.style.alignItems = pos(cross) },
  })
  def('Landroid/widget/GridView;', 'Landroid/widget/AbsListView;', {
    'setAdapter(Landroid/widget/ListAdapter;)V': (v, s, [a]) => { s.f.adapter = a; a.f.lists = [...(a.f.lists || []), s]; w.renderList(s) },
    'getAdapter()Landroid/widget/ListAdapter;': (v, s) => s.f.adapter ?? null,
  })
  def('Landroid/view/View;', OBJ, { 'setClipToPadding(Z)V': noop, 'setFadingEdgeLength(I)V': noop, 'setVerticalFadingEdgeEnabled(Z)V': noop, 'setHorizontalFadingEdgeEnabled(Z)V': noop, 'setOverScrollMode(I)V': noop, 'setScrollContainer(Z)V': noop, 'setSoundEffectsEnabled(Z)V': noop, 'setHapticFeedbackEnabled(Z)V': noop, 'performHapticFeedback(I)Z': () => 1, 'setKeepScreenOn(Z)V': noop })
  def('Ljava/net/URL;', OBJ, {
    'getAuthority()Ljava/lang/String;': (v, s) => (s.f.host ? s.f.host + (s.f.port >= 0 ? ':' + s.f.port : '') : null),
    'getUserInfo()Ljava/lang/String;': () => null,
    'toURI()Ljava/net/URI;': (v, s) => vm.newObject('Ljava/net/URI;', '<init>(Ljava/lang/String;)V', [s.f.url]),
  })
  const MI = 'Landroid/view/MenuItem;'
  const self: NativeFn = (v, s) => s
  def(MI, OBJ, {
    'setTitle(I)Landroid/view/MenuItem;': (v, s, [id]) => { s.f.title = w.resString(id); return s },
    'setTitle(Ljava/lang/CharSequence;)Landroid/view/MenuItem;': (v, s, [t]) => { s.f.title = text(t); return s },
    'setTitleCondensed(Ljava/lang/CharSequence;)Landroid/view/MenuItem;': self,
    'setIcon(Landroid/graphics/drawable/Drawable;)Landroid/view/MenuItem;': (v, s, [d]) => { s.f.icon = drawableUrlOf(d); return s },
    'setIcon(I)Landroid/view/MenuItem;': (v, s, [id]) => { s.f.icon = w.drawableUrl(id); return s },
    'setCheckable(Z)Landroid/view/MenuItem;': (v, s, [x]) => { s.f.checkable = !!x; return s },
    'setChecked(Z)Landroid/view/MenuItem;': (v, s, [x]) => { s.f.checked = !!x; return s }, 'isChecked()Z': (v, s) => (s.f.checked ? 1 : 0), 'isCheckable()Z': (v, s) => (s.f.checkable ? 1 : 0),
    'setEnabled(Z)Landroid/view/MenuItem;': (v, s, [x]) => { s.f.disabled = !x; return s }, 'isEnabled()Z': (v, s) => (s.f.disabled ? 0 : 1),
    'isVisible()Z': (v, s) => (s.f.hidden ? 0 : 1),
    'setIntent(Landroid/content/Intent;)Landroid/view/MenuItem;': (v, s, [i]) => { s.f.intent = i; return s }, 'getIntent()Landroid/content/Intent;': (v, s) => s.f.intent ?? null,
    'setOnMenuItemClickListener(Landroid/view/MenuItem$OnMenuItemClickListener;)Landroid/view/MenuItem;': (v, s, [l]) => { s.f.onClick = l; return s },
    'setShortcut(CC)Landroid/view/MenuItem;': self, 'setAlphabeticShortcut(C)Landroid/view/MenuItem;': self, 'setNumericShortcut(C)Landroid/view/MenuItem;': self,
    'setShowAsActionFlags(I)Landroid/view/MenuItem;': self, 'setActionView(Landroid/view/View;)Landroid/view/MenuItem;': self, 'setActionView(I)Landroid/view/MenuItem;': self, 'getActionView()Landroid/view/View;': () => null,
    'getGroupId()I': () => 0, 'getOrder()I': (v, s) => s.f.order ?? 0, 'hasSubMenu()Z': () => 0, 'getSubMenu()Landroid/view/SubMenu;': () => null, 'getMenuInfo()Landroid/view/ContextMenu$ContextMenuInfo;': () => null,
    'getIcon()Landroid/graphics/drawable/Drawable;': (v, s) => (s.f.icon ? drawable({ url: s.f.icon }) : null),
  })
}
