// android's resource system for the real framework: what libandroidfw does in c++.
// AssetManager (resource tables of framework-res.apk and the app, configuration matching, styles,
// themes, bags, arrays), XmlBlock (android's binary xml as a pull parser) and StringBlock.
// strings from resource tables go into one shared pool (string block 0, asset cookie 1); strings
// from an xml file stay in that file's own pool (asset cookie -1), as on android.
import { fdFor } from './fds.ts'
import type { VM, JObject, JArray } from '../dalvik.ts'
import { jstr } from '../java.ts'

// ---------- typed values ----------
export const TYPE = { NULL: 0, REFERENCE: 1, ATTRIBUTE: 2, STRING: 3, FLOAT: 4, DIMENSION: 5, FRACTION: 6, INT_DEC: 0x10, INT_BOOLEAN: 0x12 } as const
export interface Val { type: number; data: number }

// ---------- configurations (ResTable_config) ----------
export interface Config {
  mcc: number; mnc: number; lang: string; country: string; orientation: number; touchscreen: number; density: number
  keyboard: number; navigation: number; sdk: number; screenLayout: number; uiMode: number; sw: number; wdp: number; hdp: number
}
export interface Device { density: number; widthDp: number; heightDp: number; lang: string; country: string; sdk: number; night: boolean }
const str2 = (d: DataView, o: number) => { const a = d.getUint8(o), b = d.getUint8(o + 1); return a ? String.fromCharCode(a, b) : '' }
function readConfig(d: DataView, o: number): Config {
  const size = d.getUint32(o, true)
  const g8 = (k: number) => (k < size ? d.getUint8(o + k) : 0), g16 = (k: number) => (k + 1 < size ? d.getUint16(o + k, true) : 0)
  return {
    mcc: g16(4), mnc: g16(6), lang: str2(d, o + 8), country: str2(d, o + 10), orientation: g8(12), touchscreen: g8(13), density: g16(14),
    keyboard: g8(16), navigation: g8(17), sdk: g16(24), screenLayout: g8(28), uiMode: g8(29), sw: g16(30), wdp: g16(32), hdp: g16(34),
  }
}
const sizeOf = (dev: Device) => { const sw = Math.min(dev.widthDp, dev.heightDp); return sw >= 720 ? 4 : sw >= 600 ? 3 : 2 } // xlarge / large / normal
// does this configuration fit the device at all
function fits(c: Config, dev: Device) {
  if (c.mcc || c.mnc) return false
  if (c.lang && c.lang !== dev.lang) return false
  if (c.country && c.country !== dev.country) return false
  if (c.orientation && c.orientation !== (dev.widthDp > dev.heightDp ? 2 : 1)) return false
  if (c.touchscreen && c.touchscreen !== 3) return false
  if (c.sdk > dev.sdk) return false
  if (c.sw && c.sw > Math.min(dev.widthDp, dev.heightDp)) return false
  if (c.wdp && c.wdp > dev.widthDp) return false
  if (c.hdp && c.hdp > dev.heightDp) return false
  if ((c.screenLayout & 0x0f) > sizeOf(dev)) return false
  if ((c.uiMode & 0x0f) > 1) return false
  if ((c.uiMode & 0x30) && ((c.uiMode & 0x30) === 0x20) !== dev.night) return false
  if (c.keyboard > 1 || c.navigation > 1) return false
  return true
}
// ResTable_config::isBetterThan, for the qualifiers droid uses
function better(a: Config, b: Config, dev: Device): boolean {
  if (a.lang !== b.lang) return !!a.lang
  if (a.country !== b.country) return !!a.country
  if (a.sw !== b.sw) return a.sw > b.sw
  if (a.wdp !== b.wdp) return a.wdp > b.wdp
  if (a.hdp !== b.hdp) return a.hdp > b.hdp
  if ((a.screenLayout & 0x0f) !== (b.screenLayout & 0x0f)) return (a.screenLayout & 0x0f) > (b.screenLayout & 0x0f)
  if (a.orientation !== b.orientation) return !!a.orientation
  if ((a.uiMode & 0x30) !== (b.uiMode & 0x30)) return !!(a.uiMode & 0x30)
  if (a.density !== b.density) {
    const want = dev.density
    const da = a.density || 160, db = b.density || 160
    if (da === 0xffff || db === 0xffff) return db === 0xffff ? false : true
    if (da === want) return true
    if (db === want) return false
    const h = Math.max(da, db), l = Math.min(da, db), aBigger = da > db
    if (want >= h) return aBigger
    if (l >= want) return !aBigger
    return ((2 * l - want) * h > want * want) ? !aBigger : aBigger
  }
  if (a.touchscreen !== b.touchscreen) return !!a.touchscreen
  if (a.sdk !== b.sdk) return a.sdk > b.sdk
  return false
}

// ---------- resource tables ----------
interface Item { cfg: Config; val?: Val; bag?: [number, Val][]; parent?: number }
interface Entry { pkg: string; type: string; name: string; items: Item[] }

// the shared string pool (block 0): every table string, interned
export class Pool {
  strings: string[] = []
  private index = new Map<string, number>()
  intern(s: string) { let i = this.index.get(s); if (i === undefined) { i = this.strings.length; this.strings.push(s); this.index.set(s, i) } return i }
}

function readPool(d: DataView, o: number): string[] {
  const count = d.getUint32(o + 8, true), flags = d.getUint32(o + 16, true), strStart = d.getUint32(o + 20, true)
  const utf8 = (flags & 0x100) !== 0, hs = d.getUint16(o + 2, true)
  const out: string[] = new Array(count)
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    let p = o + strStart + d.getUint32(o + hs + i * 4, true)
    if (utf8) {
      let n = d.getUint8(p); p += n & 0x80 ? 2 : 1 // utf-16 length
      let m = d.getUint8(p); if (m & 0x80) { m = ((m & 0x7f) << 8) | d.getUint8(p + 1); p += 2 } else p += 1
      out[i] = dec.decode(new Uint8Array(d.buffer, d.byteOffset + p, m))
      void n
    } else {
      let n = d.getUint16(p, true); p += 2
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | d.getUint16(p, true); p += 2 }
      let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(d.getUint16(p + k * 2, true))
      out[i] = s
    }
  }
  return out
}

export function parseTable(buf: Uint8Array, pool: Pool, into: Map<number, Entry>) {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let globals: string[] = []
  let o = d.getUint16(2, true)
  const val = (p: number): Val => {
    const type = d.getUint8(p + 3), data = d.getUint32(p + 4, true) | 0
    return type === TYPE.STRING ? { type, data: pool.intern(globals[data >>> 0] ?? '') } : { type, data }
  }
  while (o < buf.length) {
    const type = d.getUint16(o, true), size = d.getUint32(o + 4, true)
    if (type === 0x0001) globals = readPool(d, o)
    else if (type === 0x0200) {
      const hs = d.getUint16(o + 2, true), id = d.getUint32(o + 8, true) & 0xff
      let pkg = ''; for (let i = 0; i < 128; i++) { const c = d.getUint16(o + 12 + i * 2, true); if (!c) break; pkg += String.fromCharCode(c) }
      const types = readPool(d, o + d.getUint32(o + 268, true)), keys = readPool(d, o + d.getUint32(o + 276, true))
      let p = o + hs
      while (p < o + size) {
        const t = d.getUint16(p, true), ths = d.getUint16(p + 2, true), sz = d.getUint32(p + 4, true)
        if (t === 0x0201) {
          const typeId = d.getUint8(p + 8), flags = d.getUint8(p + 9), count = d.getUint32(p + 12, true), start = d.getUint32(p + 16, true)
          const cfg = readConfig(d, p + 20), sparse = (flags & 1) !== 0
          for (let i = 0; i < count; i++) {
            let idx = i, off: number
            if (sparse) { idx = d.getUint16(p + ths + i * 4, true); off = d.getUint16(p + ths + i * 4 + 2, true) * 4 }
            else { off = d.getUint32(p + ths + i * 4, true); if (off === 0xffffffff) continue }
            const e = p + start + off
            const es = d.getUint16(e, true), ef = d.getUint16(e + 2, true), key = d.getUint32(e + 4, true)
            const rid = ((id << 24) | (typeId << 16) | idx) >>> 0
            let entry = into.get(rid)
            if (!entry) into.set(rid, (entry = { pkg, type: types[typeId - 1], name: keys[key], items: [] }))
            if (ef & 1) {
              const n = d.getUint32(e + 12, true), bag: [number, Val][] = []
              for (let k = 0; k < n; k++) { const m = e + es + k * 12; bag.push([d.getUint32(m, true) >>> 0, val(m + 4)]) }
              entry.items.push({ cfg, bag, parent: d.getUint32(e + 8, true) >>> 0 })
            } else entry.items.push({ cfg, val: val(e + es) })
          }
        }
        p += sz
      }
    }
    o += size
  }
}

// ---------- binary xml ----------
interface XAttr { ns: number; name: number; raw: number; type: number; data: number; res: number }
interface XEvent { ev: number; ns: number; name: number; text: number; attrs: XAttr[]; line: number; id: number; cls: number; style: number }
export interface Xml { pool: string[]; events: XEvent[] }
export function parseXml(buf: Uint8Array): Xml {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pool: string[] = [], resMap: number[] = []
  const events: XEvent[] = []
  let o = d.getUint16(2, true)
  while (o + 8 <= buf.length) {
    const t = d.getUint16(o, true), hs = d.getUint16(o + 2, true), sz = d.getUint32(o + 4, true)
    if (!sz) break
    if (t === 0x0001) pool = readPool(d, o)
    else if (t === 0x0180) { resMap = []; for (let k = o + hs; k < o + sz; k += 4) resMap.push(d.getUint32(k, true) >>> 0) }
    else if (t === 0x0102 || t === 0x0103 || t === 0x0104) {
      const line = d.getUint32(o + 8, true)
      const x = o + hs
      if (t === 0x0104) { events.push({ ev: 4, ns: -1, name: -1, text: d.getInt32(x, true), attrs: [], line, id: -1, cls: -1, style: -1 }); o += sz; continue }
      const ns = d.getInt32(x, true), name = d.getInt32(x + 4, true)
      if (t === 0x0103) { events.push({ ev: 3, ns, name, text: -1, attrs: [], line, id: -1, cls: -1, style: -1 }); o += sz; continue }
      const aStart = d.getUint16(x + 8, true), aSize = d.getUint16(x + 10, true), aCount = d.getUint16(x + 12, true)
      const idI = d.getUint16(x + 14, true) - 1, clsI = d.getUint16(x + 16, true) - 1, styleI = d.getUint16(x + 18, true) - 1
      const attrs: XAttr[] = []
      for (let k = 0; k < aCount; k++) {
        const a = x + aStart + k * aSize
        const an = d.getInt32(a + 4, true)
        attrs.push({ ns: d.getInt32(a, true), name: an, raw: d.getInt32(a + 8, true), type: d.getUint8(a + 15), data: d.getInt32(a + 16, true), res: an >= 0 && an < resMap.length ? resMap[an] : 0 })
      }
      events.push({ ev: 2, ns, name, text: -1, attrs, line, id: idI, cls: clsI, style: styleI })
    }
    o += sz
  }
  events.push({ ev: 1, ns: -1, name: -1, text: -1, attrs: [], line: 0, id: -1, cls: -1, style: -1 })
  return { pool, events }
}

// ---------- the asset manager ----------
// apk contents droid knows by path ('/system/framework/framework-res.apk', the app's apk)
export const apks = new Map<string, Map<string, Uint8Array>>()
export const device: Device = { density: 320, widthDp: 360, heightDp: 640, lang: 'en', country: 'US', sdk: 19, night: false }

class Assets {
  paths: string[] = []
  entries = new Map<number, Entry>()
  pickCache = new Map<number, { item: Item; density: number } | null>()
  bagCache = new Map<number, Map<number, Val> | null>()
  pool: Pool
  constructor(pool: Pool) { this.pool = pool }
  add(path: string) {
    const files = apks.get(path)
    if (!files) return 0
    if (!this.paths.includes(path)) {
      this.paths.push(path)
      const arsc = files.get('resources.arsc')
      if (arsc) parseTable(arsc, this.pool, this.entries)
      this.pickCache.clear(); this.bagCache.clear()
    }
    return this.paths.indexOf(path) + 1
  }
  file(cookie: number, name: string): Uint8Array | undefined {
    if (cookie > 0) { const b = apks.get(this.paths[cookie - 1])?.get(name); if (b) return b }
    for (let i = this.paths.length - 1; i >= 0; i--) { const b = apks.get(this.paths[i])?.get(name); if (b) return b }
  }
  // the best item of a resource for the device
  pick(id: number) {
    id >>>= 0
    if (this.pickCache.has(id)) return this.pickCache.get(id)!
    const e = this.entries.get(id)
    let best: Item | null = null
    for (const it of e?.items || []) if (fits(it.cfg, device) && (!best || better(it.cfg, best.cfg, device))) best = it
    const r = best ? { item: best, density: best.cfg.density } : null
    this.pickCache.set(id, r)
    return r
  }
  // a style / array / plurals: its items merged over its parents'
  bag(id: number): Map<number, Val> | null {
    id >>>= 0
    if (this.bagCache.has(id)) return this.bagCache.get(id)!
    this.bagCache.set(id, null) // loops
    const p = this.pick(id)
    if (!p?.item.bag) return null
    const m = new Map<number, Val>(p.item.parent ? this.bag(p.item.parent) ?? [] : [])
    for (const [k, v] of p.item.bag) m.set(k, v)
    this.bagCache.set(id, m)
    return m
  }
  bagList(id: number): [number, Val][] { return this.pick(id)?.item.bag ?? [] }
  // follows @references to a value (a bag stays a reference)
  resolve(v: Val, resId = 0, density = 0) {
    for (let n = 0; v.type === TYPE.REFERENCE && v.data && n < 20; n++) {
      const p = this.pick(v.data)
      if (!p || !p.item.val) return { v, resId: v.data >>> 0, density }
      resId = v.data >>> 0
      density = p.density
      v = p.item.val
    }
    return { v, resId, density }
  }
  identifier(name: string, type: string, pkg: string) {
    const m = name.match(/^(?:@?\+?(?:([\w.]+):)?([\w-]+)\/)?([\w.]+)$/)
    if (!m) return 0
    const p = m[1] || pkg || 'android', t = m[2] || type
    for (const [id, e] of this.entries) if (e.name === m[3] && e.type === t && (e.pkg === p || (!p && true))) return id | 0
    if (/^\d+$/.test(name)) return parseInt(name) | 0
    return 0
  }
}

interface Theme { am: Assets; map: Map<number, Val> }

export function registerAospRes(vm: VM) {
  const pool = new Pool()
  const ams = new Map<number, Assets>(), themes = new Map<number, Theme>(), xmls = new Map<number, Xml>()
  const blocks = new Map<number, string[]>([[1, pool.strings]])
  const states = new Map<number, { x: Xml; i: number }>()
  const assets = new Map<number, { b: Uint8Array; pos: number }>()
  let next = 2
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  const A = (s: JObject): Assets => { const a = ams.get(s.f.mObject); if (!a) throw vm.error('Ljava/lang/IllegalStateException;', 'AssetManager closed'); return a }
  const strArray = (l: string[]) => { const a = vm.newArray('[Ljava/lang/String;', l.length); l.forEach((x, i) => (a.data[i] = x)); return a }
  const intArray = (l: number[]) => { const a = vm.newArray('[I', l.length); (a.data as Int32Array).set(l); return a }

  // TypedValue: type, data, assetCookie (1 = the shared pool), resourceId, changing configs, density
  const setTv = (tv: JObject, v: Val, resId: number, density: number) => {
    tv.f.type = v.type; tv.f.data = v.data | 0; tv.f.assetCookie = v.type === TYPE.STRING ? 1 : 0
    tv.f.resourceId = resId | 0; tv.f.changingConfigurations = 0; tv.f.density = density === 0xffff ? 0xffff : density
    tv.f.string = null
  }
  // a theme's value for an attribute (following ?attr chains)
  const themeAttr = (t: Theme, attr: number): Val | null => {
    let v = t.map.get(attr >>> 0)
    for (let n = 0; v && v.type === TYPE.ATTRIBUTE && n < 20; n++) v = t.map.get(v.data >>> 0)
    return v && v.type !== TYPE.ATTRIBUTE ? v : null
  }
  const putEntry = (out: Int32Array, i: number, v: Val, cookie: number, resId: number, density: number) => {
    const k = i * 6
    out[k] = v.type; out[k + 1] = v.data | 0; out[k + 2] = cookie; out[k + 3] = resId | 0; out[k + 4] = 0; out[k + 5] = density === 0xffff ? 0xffff : density
  }
  const isNullish = (v: Val | null | undefined) => !v || v.type === TYPE.NULL || (v.type === TYPE.REFERENCE && v.data === 0)

  const assetFd = (b: Uint8Array | null | undefined, name: string, out: any) => {
    if (!b) throw vm.error('Ljava/io/FileNotFoundException;', name)
    const fd = vm.newObject('Ljava/io/FileDescriptor;') as any
    fd.f.descriptor = fdFor(b)
    if (out?.data) { out.data[0] = 0n; out.data[1] = BigInt(b.length) }
    return vm.newObject('Landroid/os/ParcelFileDescriptor;', '<init>(Ljava/io/FileDescriptor;)V', [fd])
  }
  vm.registerNatives('Landroid/content/res/AssetManager;', {
    // like android's addDefaultAssets: every asset manager starts with the framework's resources
    'init()V': (v, s) => { const h = next++; const a = new Assets(pool); a.add('/system/framework/framework-res.apk'); ams.set(h, a); s.f.mObject = h },
    'destroy()V': (v, s) => { ams.delete(s.f.mObject) },
    'addAssetPathNative(Ljava/lang/String;)I': (v, s, [p]) => A(s).add(text(p)),
    'isUpToDate()Z': () => 1,
    'setLocale(Ljava/lang/String;)V': (v, s, [l]) => { const [lang, country] = text(l).split(/[-_]r?/); device.lang = lang || 'en'; device.country = country || ''; A(s).pickCache.clear(); A(s).bagCache.clear() },
    'getLocales()[Ljava/lang/String;': () => strArray(['en', 'en-US']),
    'setConfiguration(IILjava/lang/String;IIIIIIIIIIIIII)V': (v, s, [, , loc, , , density, , , , , , sw, wdp, hdp, , uiMode]) => {
      const [lang, country] = text(loc).split(/[-_]r?/)
      if (lang) device.lang = lang
      if (country) device.country = country
      if (density) device.density = density
      if (wdp) device.widthDp = wdp
      if (hdp) device.heightDp = hdp
      void sw
      device.night = (uiMode & 0x30) === 0x20
      const a = A(s); a.pickCache.clear(); a.bagCache.clear()
    },
    'getResourceIdentifier(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I': (v, s, [n, t, p]) => A(s).identifier(text(n), text(t), text(p)),
    'getResourceName(I)Ljava/lang/String;': (v, s, [id]) => { const e = A(s).entries.get(id >>> 0); return e ? `${e.pkg}:${e.type}/${e.name}` : null },
    'getResourcePackageName(I)Ljava/lang/String;': (v, s, [id]) => A(s).entries.get(id >>> 0)?.pkg ?? null,
    'getResourceTypeName(I)Ljava/lang/String;': (v, s, [id]) => A(s).entries.get(id >>> 0)?.type ?? null,
    'getResourceEntryName(I)Ljava/lang/String;': (v, s, [id]) => A(s).entries.get(id >>> 0)?.name ?? null,
    'loadResourceValue(ISLandroid/util/TypedValue;Z)I': (v, s, [id, , tv, res]) => {
      const a = A(s), p = a.pick(id)
      if (!p || !p.item.val) return -1
      let r = { v: p.item.val, resId: id >>> 0, density: p.density }
      if (res) r = a.resolve(p.item.val, id >>> 0, p.density)
      setTv(tv, r.v, r.resId, r.density)
      return 0
    },
    'loadResourceBagValue(IILandroid/util/TypedValue;Z)I': (v, s, [id, key, tv, res]) => {
      const a = A(s), val = a.bag(id)?.get(key >>> 0)
      if (!val) return -1
      const r = res ? a.resolve(val) : { v: val, resId: 0, density: 0 }
      setTv(tv, r.v, r.resId, r.density)
      return 0
    },
    'getArraySize(I)I': (v, s, [id]) => A(s).bagList(id).length,
    'retrieveArray(I[I)I': (v, s, [id, out]) => {
      const a = A(s), l = a.bagList(id), o = out.data as Int32Array
      l.forEach(([, val], i) => { const r = a.resolve(val); if (i * 6 + 5 < o.length) putEntry(o, i, isNullish(r.v) ? { type: TYPE.NULL, data: 0 } : r.v, r.v.type === TYPE.STRING ? 1 : -1, r.resId, r.density) })
      return l.length * 6
    },
    'getArrayStringResource(I)[Ljava/lang/String;': (v, s, [id]) => { const a = A(s); return strArray(a.bagList(id).map(([, val]) => { const r = a.resolve(val).v; return r.type === TYPE.STRING ? pool.strings[r.data] : null as any })) },
    'getArrayStringInfo(I)[I': (v, s, [id]) => { const a = A(s); return intArray(a.bagList(id).flatMap(([, val]) => { const r = a.resolve(val).v; return r.type === TYPE.STRING ? [1, r.data] : [-1, -1] })) },
    'getArrayIntResource(I)[I': (v, s, [id]) => { const a = A(s); return intArray(a.bagList(id).map(([, val]) => a.resolve(val).v.data | 0)) },
    'getStringBlockCount()I': () => 1,
    'getNativeStringBlock(I)I': () => 1,
    'getCookieName(I)Ljava/lang/String;': (v, s, [c]) => A(s).paths[c - 1] ?? null,
    'getGlobalAssetCount()I': () => assets.size, 'getAssetAllocations()Ljava/lang/String;': () => null, 'getGlobalAssetManagerCount()I': () => ams.size,
    // themes
    'newTheme()I': (v, s) => { const h = next++; themes.set(h, { am: A(s), map: new Map() }); return h },
    'deleteTheme(I)V': (v, s, [h]) => { themes.delete(h) },
    'applyThemeStyle(IIZ)V': (v, s, [h, style, force]) => {
      const t = themes.get(h); const bag = t?.am.bag(style)
      if (!t || !bag) return
      for (const [k, val] of bag) if (force || !t.map.has(k)) t.map.set(k, val)
    },
    'copyTheme(II)V': (v, s, [dst, src]) => { const a = themes.get(dst), b = themes.get(src); if (a && b) a.map = new Map(b.map) },
    'loadThemeAttributeValue(IILandroid/util/TypedValue;Z)I': (v, s, [h, attr, tv, res]) => {
      const t = themes.get(h); const val = t && themeAttr(t, attr)
      if (!t || !val) return -1
      const r = res ? t.am.resolve(val) : { v: val, resId: 0, density: 0 }
      setTv(tv, r.v, r.resId, r.density)
      return 0
    },
    'dumpTheme(IILjava/lang/String;Ljava/lang/String;)V': () => {},
    // obtainStyledAttributes: xml attribute > its style= > the default style (attr, then res) > the theme
    'applyStyle(IIII[I[I[I)Z': (v, s, [h, defStyleAttr, defStyleRes, xmlState, inAttrs, outValues, outIndices]) => {
      const t = themes.get(h)
      if (!t) return 0
      const a = t.am
      const st = xmlState ? states.get(xmlState) : undefined
      const ev = st ? st.x.events[st.i] : undefined
      let defBag: Map<number, Val> | null = null
      if (defStyleAttr) { const dv = themeAttr(t, defStyleAttr); if (dv?.type === TYPE.REFERENCE) defBag = a.bag(dv.data) }
      if (!defBag && defStyleRes) defBag = a.bag(defStyleRes)
      let styleBag: Map<number, Val> | null = null
      const sa = ev?.ev === 2 && ev.style >= 0 ? ev.attrs[ev.style] : undefined
      if (sa) { let sv: Val | null = { type: sa.type, data: sa.data }; if (sv.type === TYPE.ATTRIBUTE) sv = themeAttr(t, sv.data); if (sv?.type === TYPE.REFERENCE) styleBag = a.bag(sv.data) }
      const ids = inAttrs.data as Int32Array, out = outValues.data as Int32Array, idx = outIndices?.data as Int32Array | undefined
      let n = 0
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i] >>> 0
        let val: Val | null = null, cookie = -1, fromXml = false
        const xa = ev?.ev === 2 ? ev.attrs.find((x) => x.res === id) : undefined
        if (xa) { val = { type: xa.type, data: xa.data }; fromXml = true }
        if (!val) { const b = styleBag?.get(id) ?? defBag?.get(id); if (b) val = b }
        if (val && val.type === TYPE.ATTRIBUTE) { val = themeAttr(t, val.data); fromXml = false }
        if (!val) { val = themeAttr(t, id); fromXml = false }
        let resId = 0, density = 0
        if (val && val.type === TYPE.REFERENCE) { const r = a.resolve(val); val = r.v; resId = r.resId; density = r.density; fromXml = false }
        if (!val || isNullish(val)) { putEntry(out, i, { type: TYPE.NULL, data: 0 }, -1, 0, 0); continue }
        cookie = val.type === TYPE.STRING ? (fromXml ? -1 : 1) : (fromXml ? -1 : 1)
        putEntry(out, i, val, cookie, resId, density)
        if (idx) idx[++n] = i
      }
      if (idx) idx[0] = n
      return 1
    },
    'retrieveAttributes(I[I[I[I)Z': (v, s, [xmlState, inAttrs, outValues, outIndices]) => {
      const a = A(s), st = states.get(xmlState), ev = st?.x.events[st.i]
      const ids = inAttrs.data as Int32Array, out = outValues.data as Int32Array, idx = outIndices?.data as Int32Array | undefined
      let n = 0
      for (let i = 0; i < ids.length; i++) {
        const xa = ev?.ev === 2 ? ev.attrs.find((x) => x.res === (ids[i] >>> 0)) : undefined
        if (!xa) { putEntry(out, i, { type: TYPE.NULL, data: 0 }, -1, 0, 0); continue }
        let val: Val = { type: xa.type, data: xa.data }, resId = 0, density = 0, cookie = -1
        if (val.type === TYPE.REFERENCE) { const r = a.resolve(val); val = r.v; resId = r.resId; density = r.density; cookie = 1 }
        if (isNullish(val)) { putEntry(out, i, { type: TYPE.NULL, data: 0 }, -1, 0, 0); continue }
        putEntry(out, i, val, cookie, resId, density)
        if (idx) idx[++n] = i
      }
      if (idx) idx[0] = n
      return 1
    },
    // files inside the apks
    'list(Ljava/lang/String;)[Ljava/lang/String;': (v, s, [p]) => {
      const dir = 'assets/' + text(p).replace(/^\/+|\/+$/g, '')
      const names = new Set<string>()
      for (const path of A(s).paths) for (const f of apks.get(path)?.keys() || []) if (f.startsWith(dir + '/')) names.add(f.slice(dir.length + 1).split('/')[0])
      return strArray([...names])
    },
    'openAsset(Ljava/lang/String;I)I': (v, s, [name]) => { const b = A(s).file(0, 'assets/' + text(name).replace(/^\/+/, '')); if (!b) throw vm.error('Ljava/io/FileNotFoundException;', text(name)); const h = next++; assets.set(h, { b, pos: 0 }); return h },
    // openFd(): a FileDescriptor over the asset's bytes (fds.ts), offset 0, its length
    'openAssetFd(Ljava/lang/String;[J)Landroid/os/ParcelFileDescriptor;': (v, s, [name, out]) => assetFd(A(s).file(0, 'assets/' + text(name).replace(/^\/+/, '')), text(name), out),
    'openNonAssetFdNative(ILjava/lang/String;[J)Landroid/os/ParcelFileDescriptor;': (v, s, [cookie, name, out]) => assetFd(A(s).file(cookie, text(name)), text(name), out),
    'openNonAssetNative(ILjava/lang/String;I)I': (v, s, [cookie, name]) => { const b = A(s).file(cookie, text(name)); if (!b) throw vm.error('Ljava/io/FileNotFoundException;', text(name)); const h = next++; assets.set(h, { b, pos: 0 }); return h },
    'destroyAsset(I)V': (v, s, [h]) => { assets.delete(h) },
    'readAssetChar(I)I': (v, s, [h]) => { const a = assets.get(h)!; return a.pos < a.b.length ? a.b[a.pos++] : -1 },
    'readAsset(I[BII)I': (v, s, [h, arr, off, len]) => {
      const a = assets.get(h)!, k = Math.min(len, a.b.length - a.pos)
      if (k <= 0) return len === 0 ? 0 : -1
      ;(arr.data as Int8Array).set(new Int8Array(a.b.buffer, a.b.byteOffset + a.pos, k), off); a.pos += k; return k
    },
    'seekAsset(IJI)J': (v, s, [h, off, whence]) => { const a = assets.get(h)!; const base = whence === 1 ? a.pos : whence === 2 ? a.b.length : 0; a.pos = Math.max(0, Math.min(a.b.length, base + Number(off))); return BigInt(a.pos) },
    'getAssetLength(I)J': (v, s, [h]) => BigInt(assets.get(h)!.b.length),
    'getAssetRemainingLength(I)J': (v, s, [h]) => { const a = assets.get(h)!; return BigInt(a.b.length - a.pos) },
    'openXmlAssetNative(ILjava/lang/String;)I': (v, s, [cookie, name]) => {
      const b = A(s).file(cookie, text(name))
      if (!b) throw vm.error('Ljava/io/FileNotFoundException;', 'Asset XML file: ' + text(name))
      const h = next++; xmls.set(h, parseXml(b)); return h
    },
  })

  vm.registerNatives('Landroid/content/res/XmlBlock;', {
    'nativeCreate([BII)I': (v, s, [a, off, len]) => { const h = next++; xmls.set(h, parseXml(new Uint8Array((a.data as Int8Array).buffer, (a.data as Int8Array).byteOffset + off, len))); return h },
    'nativeGetStringBlock(I)I': (v, s, [x]) => { const h = next++; blocks.set(h, xmls.get(x)!.pool); return h },
    'nativeCreateParseState(I)I': (v, s, [x]) => { const h = next++; states.set(h, { x: xmls.get(x)!, i: -1 }); return h },
    'nativeNext(I)I': (v, s, [h]) => { const st = states.get(h); if (!st) return 1; if (st.i < st.x.events.length - 1) st.i++; return st.x.events[st.i].ev },
    'nativeGetNamespace(I)I': (v, s, [h]) => cur(h)?.ns ?? -1,
    'nativeGetName(I)I': (v, s, [h]) => cur(h)?.name ?? -1,
    'nativeGetText(I)I': (v, s, [h]) => cur(h)?.text ?? -1,
    'nativeGetLineNumber(I)I': (v, s, [h]) => cur(h)?.line ?? -1,
    'nativeGetAttributeCount(I)I': (v, s, [h]) => (cur(h)?.ev === 2 ? cur(h)!.attrs.length : -1),
    'nativeGetAttributeNamespace(II)I': (v, s, [h, i]) => cur(h)?.attrs[i]?.ns ?? -1,
    'nativeGetAttributeName(II)I': (v, s, [h, i]) => cur(h)?.attrs[i]?.name ?? -1,
    'nativeGetAttributeResource(II)I': (v, s, [h, i]) => (cur(h)?.attrs[i]?.res ?? 0) | 0,
    'nativeGetAttributeDataType(II)I': (v, s, [h, i]) => cur(h)?.attrs[i]?.type ?? 0,
    'nativeGetAttributeData(II)I': (v, s, [h, i]) => cur(h)?.attrs[i]?.data ?? 0,
    'nativeGetAttributeStringValue(II)I': (v, s, [h, i]) => cur(h)?.attrs[i]?.raw ?? -1,
    'nativeGetIdAttribute(I)I': (v, s, [h]) => { const e = cur(h); return e && e.id >= 0 ? e.attrs[e.id].raw : -1 },
    'nativeGetClassAttribute(I)I': (v, s, [h]) => { const e = cur(h); return e && e.cls >= 0 ? e.attrs[e.cls].raw : -1 },
    'nativeGetStyleAttribute(I)I': (v, s, [h]) => { const e = cur(h); return e && e.style >= 0 ? e.attrs[e.style].data : 0 },
    'nativeGetAttributeIndex(ILjava/lang/String;Ljava/lang/String;)I': (v, s, [h, ns, name]) => {
      const e = cur(h), st = states.get(h)
      if (!e || !st) return -1
      const want = text(name), wantNs = ns == null ? null : text(ns)
      return e.attrs.findIndex((a) => st.x.pool[a.name] === want && (wantNs == null || (a.ns >= 0 ? st.x.pool[a.ns] : '') === wantNs))
    },
    'nativeDestroyParseState(I)V': (v, s, [h]) => { states.delete(h) },
    'nativeDestroy(I)V': (v, s, [h]) => { xmls.delete(h) },
  })
  const cur = (h: number) => { const st = states.get(h); return st && st.i >= 0 ? st.x.events[st.i] : undefined }

  vm.registerNatives('Landroid/content/res/StringBlock;', {
    'nativeCreate([BII)I': () => { const h = next++; blocks.set(h, []); return h },
    'nativeGetSize(I)I': (v, s, [h]) => blocks.get(h)?.length ?? 0,
    'nativeGetString(II)Ljava/lang/String;': (v, s, [h, i]) => blocks.get(h)?.[i] ?? null,
    'nativeGetStyle(II)[I': () => null,
    'nativeDestroy(I)V': (v, s, [h]) => { if (h !== 1) blocks.delete(h) },
  })
  return { assetBytes: (h: number) => { const a = assets.get(h); return a ? a.b.subarray(a.pos) : undefined } }
}
// keep the JArray import used for readers of this file
export type { JArray }
