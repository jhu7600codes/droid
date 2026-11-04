// resources.arsc: resource id -> values per configuration (strings, colors, dimens, layouts, drawables).
import { readStringPool, readValue, T, type XmlValue } from './axml.ts'

export interface ResConfig { density: number; orientation: number; sdk: number; language: string; width: number; height: number; nightMode: number }
export interface ResEntry { type: string; name: string; values: { config: ResConfig; value?: XmlValue; map?: { name: number; value: XmlValue }[]; parent?: number }[] }
export interface ResTable { pkg: string; entries: Map<number, ResEntry> }

export function parseArsc(buf: Uint8Array): ResTable {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (d.getUint16(0, true) !== 0x0002) throw new Error('not resources.arsc')
  let globals: string[] = []
  const table: ResTable = { pkg: '', entries: new Map() }
  let o = d.getUint16(2, true)
  while (o < buf.length) {
    const type = d.getUint16(o, true), size = d.getUint32(o + 4, true)
    if (type === 0x0001) globals = readStringPool(d, o)
    else if (type === 0x0200) parsePackage(d, o, globals, table)
    o += size
  }
  return table
}

function parsePackage(d: DataView, o: number, globals: string[], table: ResTable) {
  const headerSize = d.getUint16(o + 2, true), size = d.getUint32(o + 4, true)
  const id = d.getUint32(o + 8, true)
  let name = ''
  for (let i = 0; i < 128; i++) { const c = d.getUint16(o + 12 + i * 2, true); if (!c) break; name += String.fromCharCode(c) }
  table.pkg = name
  const typeStrOff = d.getUint32(o + 268, true), keyStrOff = d.getUint32(o + 276, true)
  const types = readStringPool(d, o + typeStrOff)
  const keys = readStringPool(d, o + keyStrOff)
  let p = o + headerSize
  const end = o + size
  while (p < end) {
    const t = d.getUint16(p, true), hs = d.getUint16(p + 2, true), sz = d.getUint32(p + 4, true)
    if (t === 0x0201) { // type chunk
      const typeId = d.getUint8(p + 8)
      const flags = d.getUint8(p + 9)
      const count = d.getUint32(p + 12, true)
      const entriesStart = d.getUint32(p + 16, true)
      const cfg = readConfig(d, p + 20)
      const sparse = (flags & 0x01) !== 0
      for (let i = 0; i < count; i++) {
        let idx = i, off: number
        if (sparse) { idx = d.getUint16(p + hs + i * 4, true); off = d.getUint16(p + hs + i * 4 + 2, true) * 4 }
        else { off = d.getUint32(p + hs + i * 4, true); if (off === 0xffffffff) continue }
        const e = p + entriesStart + off
        const eSize = d.getUint16(e, true), eFlags = d.getUint16(e + 2, true), key = d.getUint32(e + 4, true)
        const resId = ((id & 0xff) << 24) | (typeId << 16) | idx
        let entry = table.entries.get(resId >>> 0)
        if (!entry) table.entries.set(resId >>> 0, (entry = { type: types[typeId - 1], name: keys[key], values: [] }))
        if (eFlags & 0x0001) { // complex: a map (styles, arrays, plurals)
          const n = d.getUint32(e + 12, true)
          const map = []
          for (let k = 0; k < n; k++) { const m = e + eSize + k * 12; map.push({ name: d.getUint32(m, true), value: readValue(d, m + 4, globals) }) }
          entry.values.push({ config: cfg, map, parent: d.getUint32(e + 8, true) })
        } else entry.values.push({ config: cfg, value: readValue(d, e + eSize, globals) })
      }
    }
    p += sz
  }
}

function readConfig(d: DataView, o: number): ResConfig {
  const lang = d.getUint16(o + 8, true)
  return {
    language: lang ? String.fromCharCode(lang & 0xff, lang >> 8) : '',
    orientation: d.getUint8(o + 12), density: d.getUint16(o + 14, true),
    width: d.getUint16(o + 24, true), height: d.getUint16(o + 26, true), sdk: d.getUint16(o + 28, true),
    nightMode: (d.getUint8(o + 40) >> 4) & 3,
  }
}

// picks the best value for this device (density close to ours, default language, portrait/landscape)
export function resolve(t: ResTable, id: number, want: { density: number; landscape: boolean; lang: string }, depth = 0): XmlValue | undefined {
  const e = t.entries.get(id >>> 0)
  if (!e || depth > 8) return undefined
  const score = (c: ResConfig) => {
    let s = 0
    if (c.language && c.language !== want.lang) return -1e9
    if (c.language === want.lang) s += 1000
    if (c.orientation) { if ((c.orientation === 2) !== want.landscape) return -1e9; s += 100 }
    if (c.nightMode === 2) return -1e9
    if (c.density && c.density !== 0xffff) s -= Math.abs(c.density - want.density) / 10 + (c.density < want.density ? 20 : 0)
    return s
  }
  const best = e.values.filter((v) => v.value).map((v) => ({ v, s: score(v.config) })).filter((x) => x.s > -1e8).sort((a, b) => b.s - a.s)[0]
  const v = best?.v.value
  if (v && v.type === T.REFERENCE && v.data && v.data !== id) return resolve(t, v.data, want, depth + 1) || v
  return v
}

export const entryName = (t: ResTable, id: number) => t.entries.get(id >>> 0)
export function idByName(t: ResTable, type: string, name: string) {
  for (const [id, e] of t.entries) if (e.type === type && e.name === name) return id
  return 0
}

// window look of a theme: does it hide the title / action bar, the status bar. app styles are walked
// up their parents (attribute values win, nearest first) to a framework theme
const FRAMEWORK_THEMES: Record<number, { noTitle: boolean; fullscreen: boolean }> = {
  0x01030006: { noTitle: true, fullscreen: false }, 0x01030007: { noTitle: true, fullscreen: true }, // Theme.NoTitleBar(.Fullscreen)
  0x01030009: { noTitle: true, fullscreen: false }, 0x0103000a: { noTitle: true, fullscreen: true }, // Theme.Black.NoTitleBar(.Fullscreen)
  0x0103000d: { noTitle: true, fullscreen: false }, 0x0103000e: { noTitle: true, fullscreen: true }, // Theme.Light.NoTitleBar(.Fullscreen)
  0x01030010: { noTitle: true, fullscreen: false }, 0x01030011: { noTitle: true, fullscreen: true }, // Theme.Translucent.NoTitleBar(.Fullscreen)
  0x0103006c: { noTitle: true, fullscreen: false }, 0x0103006d: { noTitle: true, fullscreen: true }, // Theme.Holo.NoActionBar(.Fullscreen)
  0x010300f0: { noTitle: true, fullscreen: false }, 0x010300f1: { noTitle: true, fullscreen: true }, // Theme.Holo.Light.NoActionBar(.Fullscreen)
}
export function themeWindow(t: ResTable | undefined, id: number): { noTitle: boolean; fullscreen: boolean } {
  let noTitle: boolean | undefined, fullscreen: boolean | undefined
  for (let cur = id >>> 0, depth = 0; cur && depth < 20; depth++) {
    const fw = FRAMEWORK_THEMES[cur]
    if (fw) { noTitle ??= fw.noTitle; fullscreen ??= fw.fullscreen; break }
    const e = t?.entries.get(cur)
    if (!e) break
    const v = e.values.find((x) => x.map) ?? e.values[0]
    for (const it of v?.map || []) {
      const on = !!(it.value as any)?.data
      if (it.name === 0x01010056) noTitle ??= on // windowNoTitle
      else if (it.name === 0x010102cd) noTitle ??= !on // windowActionBar
      else if (it.name === 0x0101020d) fullscreen ??= on // windowFullscreen
    }
    // styles named after the framework ones they copy (parent missing from the table)
    if (/NoTitleBar|NoActionBar/i.test(e.name)) noTitle ??= true
    if (/Fullscreen/i.test(e.name)) fullscreen ??= true
    cur = (v?.parent ?? 0) >>> 0
  }
  return { noTitle: !!noTitle, fullscreen: !!fullscreen }
}
