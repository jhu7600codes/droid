// android binary xml (AndroidManifest.xml, res/layout/*.xml inside an apk) -> a plain tree.
// format: ResChunk headers, a string pool, a resource map, then start/end namespace and element chunks.

export interface XmlValue { type: number; data: number; raw: string | null; str?: string }
export interface XmlAttr { ns: string; name: string; resId: number; value: XmlValue }
export interface XmlNode { tag: string; attrs: XmlAttr[]; children: XmlNode[] }

export const T = { NULL: 0, REFERENCE: 1, ATTRIBUTE: 2, STRING: 3, FLOAT: 4, DIMENSION: 5, FRACTION: 6, INT_DEC: 0x10, INT_HEX: 0x11, BOOLEAN: 0x12, COLOR_ARGB8: 0x1c, COLOR_RGB8: 0x1d, COLOR_ARGB4: 0x1e, COLOR_RGB4: 0x1f }

// string pool chunk at offset o (shared with resources.arsc)
export function readStringPool(d: DataView, o: number): string[] {
  const headerSize = d.getUint16(o + 2, true)
  const count = d.getUint32(o + 8, true)
  const flags = d.getUint32(o + 16, true)
  const stringsStart = d.getUint32(o + 20, true)
  const utf8 = (flags & 0x100) !== 0
  const out: string[] = []
  const base = o + stringsStart
  const u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  for (let i = 0; i < count; i++) {
    let p = base + d.getUint32(o + headerSize + i * 4, true)
    if (utf8) {
      // utf-16 length then utf-8 length, each 1 or 2 bytes
      p += u8[p] & 0x80 ? 2 : 1
      let n = u8[p]
      if (n & 0x80) { n = ((n & 0x7f) << 8) | u8[p + 1]; p += 2 } else p += 1
      out.push(new TextDecoder().decode(u8.subarray(p, p + n)))
    } else {
      let n = d.getUint16(p, true)
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | d.getUint16(p + 2, true); p += 4 } else p += 2
      let s = ''
      for (let k = 0; k < n; k++) s += String.fromCharCode(d.getUint16(p + k * 2, true))
      out.push(s)
    }
  }
  return out
}

export function readValue(d: DataView, o: number, strings: string[]): XmlValue {
  const type = d.getUint8(o + 3)
  const data = d.getUint32(o + 4, true)
  return { type, data, raw: null, str: type === T.STRING ? strings[data] : undefined }
}

export function parseAxml(buf: Uint8Array): XmlNode {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (d.getUint16(0, true) !== 0x0003) throw new Error('not binary xml')
  let strings: string[] = []
  let resMap: number[] = []
  const root: XmlNode = { tag: '#document', attrs: [], children: [] }
  const stack = [root]
  let o = d.getUint16(2, true)
  while (o < buf.length) {
    const type = d.getUint16(o, true)
    const size = d.getUint32(o + 4, true)
    if (type === 0x0001) strings = readStringPool(d, o)
    else if (type === 0x0180) { const n = (size - 8) / 4; resMap = []; for (let i = 0; i < n; i++) resMap.push(d.getUint32(o + 8 + i * 4, true)) }
    else if (type === 0x0102) { // start element
      const ext = o + 16
      const nameIdx = d.getUint32(ext + 4, true)
      const attrStart = d.getUint16(ext + 8, true), attrSize = d.getUint16(ext + 10, true), attrCount = d.getUint16(ext + 12, true)
      const node: XmlNode = { tag: strings[nameIdx], attrs: [], children: [] }
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize
        const ns = d.getUint32(a, true), name = d.getUint32(a + 4, true), raw = d.getUint32(a + 8, true)
        const v = readValue(d, a + 12, strings)
        v.raw = raw !== 0xffffffff ? strings[raw] : null
        node.attrs.push({ ns: ns !== 0xffffffff ? strings[ns] : '', name: strings[name] || '', resId: resMap[name] || 0, value: v })
      }
      stack[stack.length - 1].children.push(node)
      stack.push(node)
    } else if (type === 0x0103) stack.pop()
    o += size
  }
  return root.children[0]
}

// android:* attribute by name (aapt2 keeps names; old aapt may only keep the resource id)
const ANDROID_ATTR_IDS: Record<string, number> = {
  name: 0x01010003, label: 0x01010001, icon: 0x01010002, id: 0x010100d0, text: 0x0101014f, textSize: 0x01010095,
  layout_width: 0x010100f4, layout_height: 0x010100f5, orientation: 0x010100c4, versionCode: 0x0101021b, versionName: 0x0101021c,
  minSdkVersion: 0x0101020c, targetSdkVersion: 0x01010270, hint: 0x01010150, textColor: 0x01010098, padding: 0x010100d5,
  layout_weight: 0x01010181, layout_gravity: 0x010100b3, gravity: 0x010100af, checked: 0x01010106, src: 0x01010119,
  background: 0x010100d4, theme: 0x01010000, screenOrientation: 0x0101001e, layout_marginTop: 0x010100f7, visibility: 0x010100dc,
  inputType: 0x01010220, onClick: 0x0101026f, textStyle: 0x01010097, scaleType: 0x0101011d,
}
export function attr(n: XmlNode, name: string): XmlValue | undefined {
  const id = ANDROID_ATTR_IDS[name]
  return n.attrs.find((a) => a.name === name || (id && a.resId === id))?.value
}
export function attrString(n: XmlNode, name: string): string | undefined {
  const v = attr(n, name)
  if (!v) return undefined
  if (v.type === T.STRING) return v.str
  if (v.raw != null) return v.raw
  if (v.type === T.INT_DEC) return String(v.data | 0)
  if (v.type === T.BOOLEAN) return v.data ? 'true' : 'false'
  return undefined
}
