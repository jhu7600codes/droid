// resources.arsc: resource id -> values per configuration (strings, colors, dimens, layouts, drawables).
import { readStringPool, readValue, T, type XmlValue } from './axml.ts'

export interface ResConfig { density: number; orientation: number; sdk: number; language: string; width: number; height: number; nightMode: number }
export interface ResEntry { type: string; name: string; values: { config: ResConfig; value?: XmlValue; map?: { name: number; value: XmlValue }[] }[] }
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
          entry.values.push({ config: cfg, map })
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
