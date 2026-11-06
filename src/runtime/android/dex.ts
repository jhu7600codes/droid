// classes.dex parser (dex 035-039): strings, types, protos, fields, methods, classes with code and
// try/catch tables, static values. only what the interpreter needs.

export interface MethodRef { cls: string; name: string; proto: Proto; key: string }
export interface FieldRef { cls: string; name: string; type: string }
export interface Proto { shorty: string; ret: string; params: string[]; desc: string }
export interface Code { registers: number; ins: number; outs: number; insns: Uint16Array; tries: Try[] }
export interface Try { start: number; end: number; handlers: { type: string | null; addr: number }[] }
export interface DexMethod { ref: MethodRef; flags: number; code: Code | null }
export interface DexField { ref: FieldRef; flags: number }
export interface DexClass {
  name: string; flags: number; super: string | null; interfaces: string[]
  staticFields: DexField[]; instanceFields: DexField[]; directMethods: DexMethod[]; virtualMethods: DexMethod[]
  staticValues: unknown[]
}
export interface Dex { strings: string[]; types: string[]; protos: Proto[]; fields: FieldRef[]; methods: MethodRef[]; classes: DexClass[] }

export const ACC = { PUBLIC: 1, PRIVATE: 2, PROTECTED: 4, STATIC: 8, FINAL: 0x10, SYNCHRONIZED: 0x20, NATIVE: 0x100, INTERFACE: 0x200, ABSTRACT: 0x400, CONSTRUCTOR: 0x10000 }

// mutf-8: like utf-8, with 0 as two bytes and surrogate pairs as two 3-byte sequences
function mutf8(b: Uint8Array, p: number) {
  let s = ''
  for (;;) {
    const a = b[p++]
    if (a === 0) return s
    if (a < 0x80) s += String.fromCharCode(a)
    else if ((a & 0xe0) === 0xc0) s += String.fromCharCode(((a & 0x1f) << 6) | (b[p++] & 0x3f))
    else { const c = b[p++], e = b[p++]; s += String.fromCharCode(((a & 0x0f) << 12) | ((c & 0x3f) << 6) | (e & 0x3f)) }
  }
}

export function parseDex(buf: Uint8Array): Dex {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = new TextDecoder().decode(buf.subarray(0, 3))
  if (magic !== 'dex') throw new Error('not a dex file')
  const u32 = (o: number) => d.getUint32(o, true)
  const u16 = (o: number) => d.getUint16(o, true)
  let p = 0
  const uleb = () => { let r = 0, s = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7 } while (b & 0x80); return r >>> 0 }
  const sleb = () => { let r = 0, s = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7 } while (b & 0x80); if (s < 32 && b & 0x40) r |= -1 << s; return r }

  const [sN, sO, tN, tO, pN, pO, fN, fO, mN, mO, cN, cO] = [56, 60, 64, 68, 72, 76, 80, 84, 88, 92, 96, 100].map(u32)
  const strings: string[] = []
  for (let i = 0; i < sN; i++) { p = u32(sO + i * 4); uleb(); strings.push(mutf8(buf, p)) }
  const types: string[] = []
  for (let i = 0; i < tN; i++) types.push(strings[u32(tO + i * 4)])
  const typeList = (off: number) => { if (!off) return []; const n = u32(off); const out = []; for (let i = 0; i < n; i++) out.push(types[u16(off + 4 + i * 2)]); return out }
  const protos: Proto[] = []
  for (let i = 0; i < pN; i++) {
    const o = pO + i * 12
    const params = typeList(u32(o + 8)), ret = types[u32(o + 4)]
    protos.push({ shorty: strings[u32(o)], ret, params, desc: `(${params.join('')})${ret}` })
  }
  const fields: FieldRef[] = []
  for (let i = 0; i < fN; i++) { const o = fO + i * 8; fields.push({ cls: types[u16(o)], type: types[u16(o + 2)], name: strings[u32(o + 4)] }) }
  const methods: MethodRef[] = []
  for (let i = 0; i < mN; i++) {
    const o = mO + i * 8
    const cls = types[u16(o)], proto = protos[u16(o + 2)], name = strings[u32(o + 4)]
    methods.push({ cls, name, proto, key: name + proto.desc })
  }

  const readCode = (off: number): Code | null => {
    if (!off) return null
    const registers = u16(off), ins = u16(off + 2), outs = u16(off + 4), triesN = u16(off + 6), n = u32(off + 12)
    const insns = new Uint16Array(n)
    for (let i = 0; i < n; i++) insns[i] = u16(off + 16 + i * 2)
    const tries: Try[] = []
    if (triesN) {
      let tp = off + 16 + n * 2
      if (n & 1) tp += 2
      const handlersBase = tp + triesN * 8
      for (let i = 0; i < triesN; i++) {
        const start = u32(tp + i * 8), count = u16(tp + i * 8 + 4), hOff = u16(tp + i * 8 + 6)
        p = handlersBase + hOff
        const size = sleb()
        const handlers: Try['handlers'] = []
        for (let k = 0; k < Math.abs(size); k++) handlers.push({ type: types[uleb()], addr: uleb() })
        if (size <= 0) handlers.push({ type: null, addr: uleb() }) // catch-all
        tries.push({ start, end: start + count, handlers })
      }
    }
    return { registers, ins, outs, insns, tries }
  }

  const encodedValue = (): unknown => {
    const b = buf[p++]
    const type = b & 0x1f, arg = b >> 5
    const readInt = (signed: boolean) => {
      let v = 0n
      for (let i = 0; i <= arg; i++) v |= BigInt(buf[p++]) << BigInt(8 * i)
      const bits = BigInt(8 * (arg + 1))
      if (signed && v & (1n << (bits - 1n))) v -= 1n << bits
      return v
    }
    switch (type) {
      case 0x00: return Number(BigInt.asIntN(8, readInt(true)))
      case 0x02: case 0x04: return Number(BigInt.asIntN(32, readInt(true)))
      case 0x03: return Number(readInt(false)) // char
      case 0x06: return BigInt.asIntN(64, readInt(true))
      case 0x10: { let v = 0; for (let i = 0; i <= arg; i++) v |= buf[p++] << (8 * (3 - arg + i)); return new Float32Array(new Uint32Array([v >>> 0]).buffer)[0] }
      case 0x11: { const bytes = new Uint8Array(8); for (let i = 0; i <= arg; i++) bytes[7 - arg + i] = buf[p++]; return new Float64Array(bytes.buffer)[0] }
      case 0x17: return strings[Number(readInt(false))]
      case 0x18: return { type: types[Number(readInt(false))] }
      case 0x1c: { const n = uleb(); const a = []; for (let i = 0; i < n; i++) a.push(encodedValue()); return a }
      case 0x1e: return null
      case 0x1f: return arg !== 0 ? 1 : 0 // booleans are ints in registers
      default: readInt(false); return null // field / method / enum / annotation refs: not needed for statics here
    }
  }

  const classes: DexClass[] = []
  for (let i = 0; i < cN; i++) {
    const o = cO + i * 32
    const superIdx = u32(o + 8), ifOff = u32(o + 12), dataOff = u32(o + 24), staticOff = u32(o + 28)
    const c: DexClass = { name: types[u32(o)], flags: u32(o + 4), super: superIdx === 0xffffffff ? null : types[superIdx], interfaces: typeList(ifOff), staticFields: [], instanceFields: [], directMethods: [], virtualMethods: [], staticValues: [] }
    if (dataOff) {
      p = dataOff
      const sf = uleb(), inf = uleb(), dm = uleb(), vm = uleb()
      const readFields = (n: number, into: DexField[]) => { let idx = 0; for (let k = 0; k < n; k++) { idx += uleb(); into.push({ ref: fields[idx], flags: uleb() }) } }
      const readMethods = (n: number, into: DexMethod[]) => {
        let idx = 0
        for (let k = 0; k < n; k++) {
          idx += uleb()
          const flags = uleb(), codeOff = uleb()
          const save = p
          into.push({ ref: methods[idx], flags, code: readCode(codeOff) })
          p = save
        }
      }
      readFields(sf, c.staticFields)
      readFields(inf, c.instanceFields)
      readMethods(dm, c.directMethods)
      readMethods(vm, c.virtualMethods)
    }
    if (staticOff) { p = staticOff; const n = uleb(); for (let k = 0; k < n; k++) c.staticValues.push(encodedValue()) }
    classes.push(c)
  }
  return { strings, types, protos, fields, methods, classes }
}
