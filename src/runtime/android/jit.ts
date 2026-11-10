// a small dalvik jit: hot "leaf" methods (no calls, no locks, no try blocks: loops, math, array and
// field work) become one js function each, with the registers as js locals and the branches as a
// switch on pc. anything else stays in the interpreter, which can stop and resume threads; these
// never need to (they run to the end or throw). semantics follow the interpreter op for op.
import type { JMethod, JClass } from './dalvik.ts'

const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer)
const f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer)

export interface JitHost {
  cls(name: string): JClass
  fieldKey(f: { cls: string; name: string; type: string }): string
  staticOwner(cls: string, field: string): JClass
  binop(i: number, x: any, y: any): any
  error(cls: string, msg: string): any
  newArray(type: string, n: number): any
  instanceOf(o: any, c: JClass): boolean
  classOf(o: any): JClass
  resolveInvoke(kind: number, ref: any, raw: any[]): any
  jcall(target: JMethod, self: any, args: any[]): any
  init(c: JClass): void
  noCall: symbol
}

// a compiled call chain that has to wait (or reach code that is not compiled): every compiled frame on
// the way out adds its state, and the interpreter rebuilds them as its own frames and goes on
export class Deopt {
  frames: { m: JMethod; pc: number; regs: any[]; res: any }[] = []
  signal: any // what the innermost call threw (a Block or JavaCall), or null: run the call again
  constructor(signal: any) { this.signal = signal }
}

type Fn = (H: JitHost, self: any, args: any[] | null, ePc?: number, eRegs?: any[], eRes?: any) => any

// int binops inlined; the rest (division, long, float) go through the interpreter's own binop
const INT: Record<number, (x: string, y: string) => string> = {
  0: (x, y) => `((${x} + ${y}) | 0)`, 1: (x, y) => `((${x} - ${y}) | 0)`, 2: (x, y) => `Math.imul(${x}, ${y})`,
  5: (x, y) => `(${x} & ${y})`, 6: (x, y) => `(${x} | ${y})`, 7: (x, y) => `(${x} ^ ${y})`,
  8: (x, y) => `(${x} << (${y} & 31))`, 9: (x, y) => `(${x} >> (${y} & 31))`, 10: (x, y) => `((${x} >>> (${y} & 31)) | 0)`,
}
const bin = (i: number, x: string, y: string) => (INT[i] ? INT[i](x, y) : `H.binop(${i}, ${x}, ${y})`)

export function compile(H: JitHost, m: JMethod, kinds: Map<number, string>, JT: any, JO: any): Fn | null {
  const code = m.code
  if (!code || code.tries.length || code.insns.length > 4000 || m.flags & 0x20) return null
  const ins = code.insns, dex = m.dex!
  const consts: any[] = [] // values the code refers to (classes, field refs, strings)
  const K = (v: any) => { let i = consts.indexOf(v); if (i < 0) { i = consts.length; consts.push(v) } return `K[${i}]` }
  const R = (n: number) => `r${n}`
  const s16 = (x: number) => (x << 16) >> 16, s8 = (x: number) => (x << 24) >> 24
  const s32at = (p: number) => ins[p] | (ins[p + 1] << 16)
  const u32at = (p: number) => (ins[p] | (ins[p + 1] << 16)) >>> 0
  const conv = (pc: number, v: number | bigint) => {
    const k = kinds.get(pc)
    if (!k) return typeof v === 'bigint' ? `${v}n` : String(v)
    if (k === 'F') { i32[0] = Number(v); return numLit(f32[0]) }
    i64[0] = typeof v === 'bigint' ? v : BigInt(v); return numLit(f64[0])
  }
  const numLit = (x: number) => (Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : Object.is(x, -0) ? '-0' : String(x))
  const out: string[] = []
  const targets = new Set<number>([0])
  const npe = `throw H.error('Ljava/lang/NullPointerException;', 'null')`
  const nn = (x: string) => `if (${x} == null || ${x} === 0) ${npe};`
  const aget = (a: string, i: string) => `if (${a} == null || ${a} === 0) ${npe}; if (${i} < 0 || ${i} >= ${a}.data.length) throw H.error('Ljava/lang/ArrayIndexOutOfBoundsException;', 'length=' + ${a}.data.length + '; index=' + ${i});`
  let pc = 0
  while (pc < ins.length) {
    const w = ins[pc], op = w & 0xff, AA = w >> 8, A = (w >> 8) & 0xf, B = w >> 12
    // payload pseudo-instructions (switch tables, array data) end the code we translate
    if (op === 0x00 && AA !== 0) break
    let size = 1, s = ''
    const go = (to: number) => { targets.add(to); return `{ pc = ${to}; continue }` }
    switch (op) {
      case 0x00: break
      case 0x01: case 0x04: case 0x07: s = `${R(A)} = ${R(B)};`; break
      case 0x02: case 0x05: case 0x08: s = `${R(AA)} = ${R(ins[pc + 1])};`; size = 2; break
      case 0x03: case 0x06: case 0x09: s = `${R(ins[pc + 1])} = ${R(ins[pc + 2])};`; size = 3; break
      case 0x0e: s = 'return undefined;'; break
      case 0x0f: case 0x10: s = `return ${R(AA)};`; break
      case 0x11: s = `return ${R(AA)} === 0 ? null : ${R(AA)};`; break
      case 0x12: s = `${R(A)} = ${conv(pc, (B << 28) >> 28)};`; break
      case 0x13: s = `${R(AA)} = ${conv(pc, s16(ins[pc + 1]))};`; size = 2; break
      case 0x14: s = `${R(AA)} = ${conv(pc, s32at(pc + 1))};`; size = 3; break
      case 0x15: s = `${R(AA)} = ${conv(pc, (ins[pc + 1] << 16) | 0)};`; size = 2; break
      case 0x16: s = `${R(AA)} = ${conv(pc, BigInt(s16(ins[pc + 1])))};`; size = 2; break
      case 0x17: s = `${R(AA)} = ${conv(pc, BigInt(s32at(pc + 1)))};`; size = 3; break
      case 0x18: s = `${R(AA)} = ${conv(pc, BigInt.asIntN(64, BigInt(u32at(pc + 1)) | (BigInt(u32at(pc + 3)) << 32n)))};`; size = 5; break
      case 0x19: s = `${R(AA)} = ${conv(pc, BigInt.asIntN(64, BigInt(ins[pc + 1]) << 48n))};`; size = 2; break
      case 0x1a: s = `${R(AA)} = ${JSON.stringify(dex.strings[ins[pc + 1]])};`; size = 2; break
      case 0x1b: s = `${R(AA)} = ${JSON.stringify(dex.strings[u32at(pc + 1)])};`; size = 3; break
      case 0x1f: { const c = K(H.cls(dex.types[ins[pc + 1]])); s = `{ const v = ${R(AA)}; if (v != null && v !== 0 && !H.instanceOf(v, ${c})) throw H.error('Ljava/lang/ClassCastException;', H.classOf(v).name + ' cannot be cast to ' + ${c}.name) }`; size = 2; break }
      case 0x20: { const c = K(H.cls(dex.types[ins[pc + 1]])); s = `${R(A)} = H.instanceOf(${R(B)} === 0 ? null : ${R(B)}, ${c}) ? 1 : 0;`; size = 2; break }
      case 0x21: s = `${nn(R(B))} ${R(A)} = ${R(B)}.data.length;`; break
      case 0x23: s = `${R(A)} = H.newArray(${JSON.stringify(dex.types[ins[pc + 1]])}, ${R(B)});`; size = 2; break
      case 0x27: s = `${nn(R(AA))} throw new JT(${R(AA)});`; break
      case 0x28: s = go(pc + s8(AA)); break
      case 0x29: s = go(pc + s16(ins[pc + 1])); size = 2; break
      case 0x2a: s = go(pc + s32at(pc + 1)); size = 3; break
      case 0x2b: case 0x2c: {
        const p = pc + s32at(pc + 1), n = ins[p + 1]
        const cases: string[] = []
        for (let i = 0; i < n; i++) {
          const key = op === 0x2b ? s32at(p + 2) + i : s32at(p + 2 + i * 2)
          const to = pc + (op === 0x2b ? s32at(p + 4 + i * 2) : s32at(p + 2 + n * 2 + i * 2))
          cases.push(`case ${key}: ${go(to)}`)
        }
        s = `switch (${R(AA)}) { ${cases.join(' ')} }`; size = 3; break
      }
      case 0x2d: case 0x2e: case 0x2f: case 0x30: {
        const x = R(ins[pc + 1] & 0xff), y = R(ins[pc + 1] >> 8), nan = op === 0x2d || op === 0x2f ? -1 : 1
        s = `${R(AA)} = (${x} !== ${x} || ${y} !== ${y}) ? ${nan} : ${x} < ${y} ? -1 : ${x} > ${y} ? 1 : 0;`; size = 2; break
      }
      case 0x31: { const x = R(ins[pc + 1] & 0xff), y = R(ins[pc + 1] >> 8); s = `${R(AA)} = ${x} < ${y} ? -1 : ${x} > ${y} ? 1 : 0;`; size = 2; break }
      case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37: {
        const c = ['===', '!==', '<', '>=', '>', '<='][op - 0x32]
        s = `if (${R(A)} ${c} ${R(B)}) ${go(pc + s16(ins[pc + 1]))}`; size = 2; break
      }
      case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: {
        const x = R(AA), z = `(${x} == null || ${x} === 0 || ${x} === 0n || ${x} === false)`
        const c = [z, `!${z}`, `${x} < 0`, `(${x} >= 0 || ${z})`, `${x} > 0`, `(${x} <= 0 || ${z})`][op - 0x38]
        s = `if (${c}) ${go(pc + s16(ins[pc + 1]))}`; size = 2; break
      }
      case 0x44: case 0x45: case 0x46: case 0x47: case 0x48: case 0x49: case 0x4a: {
        const a = R(ins[pc + 1] & 0xff), i = R(ins[pc + 1] >> 8)
        s = `${aget(a, i)} ${R(AA)} = ${a}.data[${i}];`; size = 2; break
      }
      case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f: case 0x50: case 0x51: {
        const a = R(ins[pc + 1] & 0xff), i = R(ins[pc + 1] >> 8)
        s = `${aget(a, i)} ${a}.data[${i}] = ${op === 0x4d ? `(${R(AA)} === 0 ? null : ${R(AA)})` : R(AA)};`; size = 2; break
      }
      case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: case 0x58: {
        const f = dex.fields[ins[pc + 1]], k = JSON.stringify(H.fieldKey(f)), d = defaultFor(f.type[0])
        s = `${nn(R(B))} { const v = ${R(B)}.f[${k}]; ${R(A)} = v === undefined ? ${d} : v }`; size = 2; break
      }
      case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f: {
        const f = dex.fields[ins[pc + 1]], k = JSON.stringify(H.fieldKey(f))
        s = `${nn(R(B))} ${R(B)}.f[${k}] = ${op === 0x5b ? `(${R(A)} === 0 ? null : ${R(A)})` : R(A)};`; size = 2; break
      }
      case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66:
      case 0x67: case 0x68: case 0x69: case 0x6a: case 0x6b: case 0x6c: case 0x6d: {
        const f = dex.fields[ins[pc + 1]], c = H.staticOwner(f.cls, f.name)
        if (!c.initialized) return null // its <clinit> would have to run here: leave it to the interpreter
        const sv = K(c.staticValues), n = JSON.stringify(f.name)
        s = op <= 0x66 ? `{ const v = ${sv}[${n}]; ${R(AA)} = v === undefined ? ${defaultFor(f.type[0])} : v }` : `${sv}[${n}] = ${op === 0x69 ? `(${R(AA)} === 0 ? null : ${R(AA)})` : R(AA)};`
        size = 2; break
      }
      case 0x0a: case 0x0b: case 0x0c: s = `${R(AA)} = res;`; break
      case 0x22: { const c = H.cls(dex.types[ins[pc + 1]]); s = `if (!${K(c)}.initialized) H.init(${K(c)}); ${R(AA)} = new JO(${K(c)});`; size = 2; break }
      case 0x24: case 0x25: {
        const regs = op === 0x24 ? regs35c(ins, pc) : regs3rc(ins, pc)
        s = `{ const a = H.newArray(${JSON.stringify(dex.types[ins[pc + 1]])}, ${regs.length}); ${regs.map((x, i) => `a.data[${i}] = ${R(x)};`).join(' ')} res = a }`; size = 3; break
      }
      case 0x6e: case 0x6f: case 0x70: case 0x71: case 0x72: case 0x74: case 0x75: case 0x76: case 0x77: case 0x78: {
        const range = op >= 0x74, kind = range ? op - 0x74 : op - 0x6e
        const ref = dex.methods[ins[pc + 1]]
        if (ref.cls === 'Ljava/lang/String;' && ref.name === '<init>') return null // string constructors replace registers
        const regs = range ? regs3rc(ins, pc) : regs35c(ins, pc)
        const all = Array.from({ length: code.registers }, (_, i) => R(i)).join(', ')
        s = `{ const c = H.resolveInvoke(${kind}, ${K(ref)}, [${regs.map(R).join(', ')}]); if (c !== H.noCall) { try { res = H.jcall(c.target, c.self, c.args) } catch (e) { if (e instanceof DO) e.frames.push({ m: M, pc: ${pc}, regs: [${all}], res }); throw e } } else res = undefined }`
        size = 3; break
      }
      case 0x7b: s = `${R(A)} = (-${R(B)}) | 0;`; break
      case 0x7c: s = `${R(A)} = ~${R(B)};`; break
      case 0x7d: s = `${R(A)} = BigInt.asIntN(64, -${R(B)});`; break
      case 0x7e: s = `${R(A)} = BigInt.asIntN(64, ~${R(B)});`; break
      case 0x7f: s = `${R(A)} = Math.fround(-${R(B)});`; break
      case 0x80: s = `${R(A)} = -${R(B)};`; break
      case 0x81: s = `${R(A)} = BigInt(${R(B)});`; break
      case 0x82: case 0x8c: s = `${R(A)} = Math.fround(${R(B)});`; break
      case 0x83: case 0x89: s = `${R(A)} = ${R(B)};`; break
      case 0x84: s = `${R(A)} = Number(BigInt.asIntN(32, ${R(B)}));`; break
      case 0x85: s = `${R(A)} = Math.fround(Number(${R(B)}));`; break
      case 0x86: s = `${R(A)} = Number(${R(B)});`; break
      case 0x87: case 0x8a: s = `${R(A)} = toInt(${R(B)});`; break
      case 0x88: case 0x8b: s = `${R(A)} = toLong(${R(B)});`; break
      case 0x8d: s = `${R(A)} = (${R(B)} << 24) >> 24;`; break
      case 0x8e: s = `${R(A)} = ${R(B)} & 0xffff;`; break
      case 0x8f: s = `${R(A)} = (${R(B)} << 16) >> 16;`; break
      default:
        if (op >= 0x90 && op <= 0xaf) { s = `${R(AA)} = ${bin(op - 0x90, R(ins[pc + 1] & 0xff), R(ins[pc + 1] >> 8))};`; size = 2; break }
        if (op >= 0xb0 && op <= 0xcf) { s = `${R(A)} = ${bin(op - 0xb0, R(A), R(B))};`; break }
        if (op >= 0xd0 && op <= 0xd7) { const lit = s16(ins[pc + 1]); s = `${R(A)} = ${op === 0xd1 ? `(${lit} - ${R(B)}) | 0` : bin([0, 0, 2, 3, 4, 5, 6, 7][op - 0xd0], R(B), String(lit))};`; size = 2; break }
        if (op >= 0xd8 && op <= 0xe2) { const bb = R(ins[pc + 1] & 0xff), lit = s8(ins[pc + 1] >> 8); s = `${R(AA)} = ${op === 0xd9 ? `(${lit} - ${bb}) | 0` : bin([0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10][op - 0xd8], bb, String(lit))};`; size = 2; break }
        return null // calls, new objects, locks, fill-array-data...: not a leaf method
    }
    out.push(`case ${pc}: ${s}`)
    pc += size
  }
  // registers: arguments in the last `ins` registers (wide ones take two), like the interpreter
  const regs = code.registers
  const init: string[] = []
  let a = regs - code.ins, ai = 0
  if (!(m.flags & 0x8)) init.push(`r${a++} = self;`)
  for (const p of m.params) { init.push(`r${a} = args ? args[${ai++}] : 0;`); a += p === 'J' || p === 'D' ? 2 : 1 }
  const decl = (regs ? `let ${Array.from({ length: regs }, (_, i) => `r${i} = 0`).join(', ')};` : '') + ' let res;'
  // entering a running frame (on-stack replacement): its registers, pc and last call result
  const osr = `if (eRegs) { ${Array.from({ length: regs }, (_, i) => `r${i} = eRegs[${i}];`).join(' ')} pc = ePc; res = eRes }`
  const src = `${decl}\nlet pc = 0\n${init.join(' ')}\n${osr}\nfor (;;) switch (pc) {\n${out.join('\n')}\ndefault: throw H.error('Ljava/lang/VerifyError;', 'jit: fell off at ' + pc)\n}`
  try {
    const make = new Function('K', 'JT', 'JO', 'DO', 'M', 'toInt', 'toLong', `return function jit(H, self, args, ePc, eRegs, eRes) {\n${src}\n}`)
    return make(consts, JT, JO, Deopt, m, toInt, toLong) as Fn
  } catch (e) {
    console.warn('jit: could not build', m.cls.name, m.key, e)
    return null
  }
}

function regs35c(ins: Uint16Array, pc: number) {
  const w = ins[pc], n = w >> 12, g = (w >> 8) & 0xf, cdef = ins[pc + 2]
  return [cdef & 0xf, (cdef >> 4) & 0xf, (cdef >> 8) & 0xf, (cdef >> 12) & 0xf, g].slice(0, n)
}
function regs3rc(ins: Uint16Array, pc: number) { const n = ins[pc] >> 8, first = ins[pc + 2]; return Array.from({ length: n }, (_, i) => first + i) }
function defaultFor(t: string) { return t === 'J' ? '0n' : 'ZBSCIFD'.includes(t) ? '0' : 'null' }
const toInt = (x: number) => (isNaN(x) ? 0 : x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : Math.trunc(x) | 0)
const toLong = (x: number) => (isNaN(x) ? 0n : x >= 9.223372036854776e18 ? 9223372036854775807n : x <= -9.223372036854776e18 ? -9223372036854775808n : BigInt(Math.trunc(x)))
