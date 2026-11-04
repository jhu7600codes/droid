// advanced simd (neon), arm encodings (thumb-2 ones are converted to these first, see thumb.ts).
// covers the data-processing groups of the armv7 reference: three registers of the same length,
// three of different lengths, two and a scalar, two and a shift amount, two-register misc, vext,
// vtbl / vtbx, vdup (scalar), modified immediates, and the element / structure loads and stores.
// d0..d31 live in the fp buffer (8 bytes each, q registers are d pairs); lanes are read through
// typed views, so lane writes wrap the way the hardware does.
import type { CPU } from './cpu.ts'
import type { FP } from './vfp.ts'

type V = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | BigInt64Array | BigUint64Array
const QC = 1 << 27
function view(f: FP, es: number, sgn: boolean): V {
  return es === 1 ? (sgn ? f.i8 : f.b) : es === 2 ? (sgn ? f.i16 : f.u16) : es === 4 ? (sgn ? f.i32 : f.u) : (sgn ? f.i64 : f.u64)
}
const at = (reg: number, es: number) => (reg * 8) / es // first lane of a register in a view of lane size es
const bounds = (es: number, sgn: boolean): [number, number] => sgn ? [-(2 ** (es * 8 - 1)), 2 ** (es * 8 - 1) - 1] : [0, 2 ** (es * 8) - 1]
const bigBounds = (es: number, sgn: boolean): [bigint, bigint] => { const b = BigInt(es * 8); return sgn ? [-(1n << (b - 1n)), (1n << (b - 1n)) - 1n] : [0n, (1n << b) - 1n] }
function sat(f: FP, v: number, es: number, sgn: boolean) {
  const [lo, hi] = bounds(es, sgn)
  if (v < lo) { f.fpscr |= QC; return lo }
  if (v > hi) { f.fpscr |= QC; return hi }
  return v
}
function satB(f: FP, v: bigint, es: number, sgn: boolean) {
  const [lo, hi] = bigBounds(es, sgn)
  if (v < lo) { f.fpscr |= QC; return lo }
  if (v > hi) { f.fpscr |= QC; return hi }
  return v
}
// shifts of numbers that stay exact (lanes up to 32 bits)
const shr = (x: number, s: number) => Math.floor(x / 2 ** s)
const rshr = (x: number, s: number) => (s ? Math.floor((x + 2 ** (s - 1)) / 2 ** s) : x)
const bshr = (x: bigint, s: number) => x >> BigInt(s)
const brshr = (x: bigint, s: number) => (s ? (x + (1n << BigInt(s - 1))) >> BigInt(s) : x)

export function execNeon(c: CPU, insn: number): boolean {
  insn >>>= 0
  if ((insn & 0xff100000) >>> 0 === 0xf4000000 || (insn & 0xff100000) >>> 0 === 0xf4100000) return ldst(c, insn)
  if ((insn & 0xfe000000) >>> 0 !== 0xf2000000) return false
  const f = c.fp
  const U = (insn >>> 24) & 1
  const Vd = ((insn >>> 12) & 0xf) | (((insn >>> 22) & 1) << 4)
  const Vn = ((insn >>> 16) & 0xf) | (((insn >>> 7) & 1) << 4)
  const Vm = (insn & 0xf) | (((insn >>> 5) & 1) << 4)
  if (!((insn >>> 23) & 1)) return three(f, insn, U, Vd, Vn, Vm)
  if (((insn >>> 19) & 7) === 0 && (insn & 0x90) === 0x10) return modImm(f, insn, Vd)
  if ((insn >>> 4) & 1) return shift(f, insn, U, Vd, Vm)
  if (((insn >>> 20) & 3) !== 3) return (insn >>> 6) & 1 ? scalar(f, insn, U, Vd, Vn) : diff(f, insn, U, Vd, Vn, Vm)
  if (!U) { // vext
    const Q = (insn >>> 6) & 1, imm = (insn >>> 8) & 0xf, len = Q ? 16 : 8
    const src = new Uint8Array(len * 2)
    src.set(f.b.subarray(Vn * 8, Vn * 8 + len), 0); src.set(f.b.subarray(Vm * 8, Vm * 8 + len), len)
    f.b.set(src.subarray(imm, imm + len), Vd * 8)
    return true
  }
  if (!((insn >>> 11) & 1)) return misc(f, insn, Vd, Vm)
  if (((insn >>> 10) & 3) === 2) { // vtbl / vtbx
    const len = ((insn >>> 8) & 3) + 1, x = (insn >>> 6) & 1
    const table = f.b.slice(Vn * 8, Vn * 8 + len * 8)
    const idx = f.b.slice(Vm * 8, Vm * 8 + 8)
    for (let i = 0; i < 8; i++) { const k = idx[i]; if (k < len * 8) f.b[Vd * 8 + i] = table[k]; else if (!x) f.b[Vd * 8 + i] = 0 }
    return true
  }
  if (((insn >>> 8) & 0xf) === 0xc && !((insn >>> 7) & 1)) { // vdup scalar
    const imm4 = (insn >>> 16) & 0xf, Q = (insn >>> 6) & 1
    const es = imm4 & 1 ? 1 : imm4 & 2 ? 2 : 4, idx = imm4 >>> (es === 1 ? 1 : es === 2 ? 2 : 3)
    const v = view(f, es, false), x = v[at(Vm & 0x1f, es) + idx]
    const n = (Q ? 16 : 8) / es, d = at(Vd, es)
    for (let i = 0; i < n; i++) v[d + i] = x as any
    return true
  }
  return false
}

// ---------- three registers, same length ----------
function three(f: FP, insn: number, U: number, Vd: number, Vn: number, Vm: number): boolean {
  const A = (insn >>> 8) & 0xf, B = (insn >>> 4) & 1, size = (insn >>> 20) & 3, Q = (insn >>> 6) & 1
  const es = 1 << size, bytes = Q ? 16 : 8
  // bitwise
  if (A === 1 && B === 1) {
    const w = bytes / 4
    for (let i = 0; i < w; i++) {
      const x = f.u[Vn * 2 + i], y = f.u[Vm * 2 + i], dv = f.u[Vd * 2 + i]
      f.u[Vd * 2 + i] = (!U ? [x & y, x & ~y, x | y, x | ~y][size] : [x ^ y, (dv & x) | (~dv & y), (x & dv) | (y & ~dv), (x & ~dv) | (y & dv)][size]) >>> 0
    }
    return true
  }
  // floating point (32-bit lanes)
  if (A >= 13 || (A === 12 && B === 1)) {
    const op = (insn >>> 21) & 1, s = f.s, n = bytes / 4
    const a = s.slice(Vn * 2, Vn * 2 + n), b = s.slice(Vm * 2, Vm * 2 + n), d = s.slice(Vd * 2, Vd * 2 + n)
    const out = new Float32Array(n)
    const pair = (fn: (x: number, y: number) => number) => { const h = n / 2; for (let i = 0; i < h; i++) { out[i] = fn(a[2 * i], a[2 * i + 1]); out[h + i] = fn(b[2 * i], b[2 * i + 1]) } }
    const each = (fn: (x: number, y: number, z: number) => number) => { for (let i = 0; i < n; i++) out[i] = fn(a[i], b[i], d[i]) }
    const mask = (t: boolean) => (t ? -1 : 0)
    const k = A * 4 + B * 2 + U
    if (A === 12) each((x, y, z) => z + (op ? -x : x) * y) // vfma / vfms
    else if (k === 13 * 4) each((x, y) => (op ? x - y : x + y))
    else if (k === 13 * 4 + 1) { if (op) each((x, y) => Math.abs(x - y)); else pair((x, y) => x + y) }
    else if (k === 13 * 4 + 2) each((x, y, z) => z + (op ? -(Math.fround(x * y)) : Math.fround(x * y)))
    else if (k === 13 * 4 + 3) { if (op) return false; each((x, y) => x * y) }
    else if (k === 14 * 4) { if (op) return false; const r = new Int32Array(out.buffer); for (let i = 0; i < n; i++) r[i] = mask(a[i] === b[i]) }
    else if (k === 14 * 4 + 1) { const r = new Int32Array(out.buffer); for (let i = 0; i < n; i++) r[i] = mask(op ? a[i] > b[i] : a[i] >= b[i]) }
    else if (k === 14 * 4 + 3) { const r = new Int32Array(out.buffer); for (let i = 0; i < n; i++) r[i] = mask(op ? Math.abs(a[i]) > Math.abs(b[i]) : Math.abs(a[i]) >= Math.abs(b[i])) }
    else if (k === 15 * 4) each((x, y) => (op ? Math.min(x, y) : Math.max(x, y)))
    else if (k === 15 * 4 + 1) pair((x, y) => (op ? Math.min(x, y) : Math.max(x, y)))
    else if (k === 15 * 4 + 2) each((x, y) => (op ? (3 - x * y) / 2 : 2 - x * y))
    else return false
    s.set(out, Vd * 2)
    return true
  }
  const sgn = !U
  // pairwise integer: vpmax / vpmin (A=10), vpadd (A=11, B=1)
  if (A === 10 || (A === 11 && B === 1)) {
    const v = view(f, es, sgn), n = 8 / es, h = n / 2
    const a = Array.from(v.subarray(at(Vn, es), at(Vn, es) + n) as any) as number[], b = Array.from(v.subarray(at(Vm, es), at(Vm, es) + n) as any) as number[]
    const fn = A === 11 ? (x: number, y: number) => x + y : B ? Math.min : Math.max
    const d = at(Vd, es)
    for (let i = 0; i < h; i++) { v[d + i] = fn(a[2 * i], a[2 * i + 1]) as any; v[d + h + i] = fn(b[2 * i], b[2 * i + 1]) as any }
    return true
  }
  const n = bytes / es
  if (es === 8) { // 64-bit lanes: add / sub / saturating add, sub, shifts
    const v = view(f, 8, sgn) as BigInt64Array, s64 = f.i64
    const out: bigint[] = []
    for (let i = 0; i < n; i++) {
      const x = v[Vn + i], y = v[Vm + i], sh = Number(BigInt.asIntN(8, s64[Vn + i]))
      if (A === 8 && !B) out.push(U ? x - y : x + y)
      else if (A === 0 && B) out.push(satB(f, x + y, 8, sgn))
      else if (A === 2 && B) out.push(satB(f, x - y, 8, sgn))
      else if (A === 4 || A === 5) {
        const sx = v[Vm + i]
        let r: bigint
        if (sh >= 0) r = sh >= 64 ? 0n : sx << BigInt(sh)
        else r = A === 5 ? brshr(sx, Math.min(-sh, 64)) : bshr(sx, Math.min(-sh, 64))
        if (B) { if (sh >= 0 && (r >> BigInt(Math.min(sh, 63))) !== sx) r = sx < 0n ? bigBounds(8, sgn)[0] : bigBounds(8, sgn)[1]; r = satB(f, r, 8, sgn) }
        out.push(r)
      } else if (A === 8 && B) out.push(U ? (x === y ? -1n : 0n) : ((x & y) !== 0n ? -1n : 0n))
      else return false
    }
    out.forEach((x, i) => { f.i64[Vd + i] = BigInt.asIntN(64, x) })
    return true
  }
  const v = view(f, es, sgn), uv = view(f, es, false), sv = view(f, es, true)
  const a = Array.from(v.subarray(at(Vn, es), at(Vn, es) + n) as any) as number[]
  const b = Array.from(v.subarray(at(Vm, es), at(Vm, es) + n) as any) as number[]
  const shs = Array.from(sv.subarray(at(Vn, es), at(Vn, es) + n) as any) as number[] // shift amounts (vshl family: by vn)
  const d = Array.from(v.subarray(at(Vd, es), at(Vd, es) + n) as any) as number[]
  const bits = es * 8
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i]
    let r: number
    switch (A * 2 + B) {
      case 0: r = shr(x + y, 1); break // vhadd
      case 1: r = sat(f, x + y, es, sgn); break // vqadd
      case 2: r = shr(x + y + 1, 1); break // vrhadd
      case 4: r = shr(x - y, 1); break // vhsub
      case 5: r = sat(f, x - y, es, sgn); break // vqsub
      case 6: r = x > y ? -1 : 0; break // vcgt
      case 7: r = x >= y ? -1 : 0; break // vcge
      case 8: case 9: case 10: case 11: { // vshl vqshl vrshl vqrshl (by a signed byte from the lane of vm)
        const sh = (shs[i] << 24) >> 24, round = A === 5, satur = B === 1
        const x = b[i] // the value is in vm
        if (sh >= 0) {
          if (satur) { const p = x * 2 ** Math.min(sh, 64); r = sat(f, p, es, sgn) }
          else r = sh >= bits ? 0 : x * 2 ** sh // wraps on the store
          if (!satur && sh < bits && Math.abs(r) > 2 ** 53) r = Number(BigInt.asUintN(bits, BigInt(x) << BigInt(sh)))
        } else r = round ? rshr(x, Math.min(-sh, bits)) : shr(x, Math.min(-sh, bits))
        break
      }
      case 12: r = Math.max(x, y); break
      case 13: r = Math.min(x, y); break
      case 14: r = Math.abs(x - y); break // vabd
      case 15: r = d[i] + Math.abs(x - y); break // vaba
      case 16: r = U ? x - y : x + y; break // vadd / vsub
      case 17: r = U ? (uv[at(Vn, es) + i] === uv[at(Vm, es) + i] ? -1 : 0) : ((x & y) !== 0 || (es === 4 && (x & y) >>> 0 !== 0) ? -1 : 0); break // vceq / vtst
      case 18: r = U ? d[i] - mulLow(x, y, es) : d[i] + mulLow(x, y, es); break // vmla / vmls
      case 19: r = U ? pmul(x, y) : mulLow(x, y, es); break // vmul (polynomial for u)
      case 22: { // vqdmulh / vqrdmulh (signed)
        const sx = sv[at(Vn, es) + i] as number, sy = sv[at(Vm, es) + i] as number
        const p = BigInt(sx) * BigInt(sy) * 2n + (U ? 1n << BigInt(bits - 1) : 0n)
        r = Number(satB(f, p >> BigInt(bits), es, true))
        break
      }
      default: return false
    }
    out[i] = r
  }
  const dst = at(Vd, es)
  for (let i = 0; i < n; i++) v[dst + i] = out[i] as any
  return true
}
const mulLow = (x: number, y: number, es: number) => (es === 4 ? Math.imul(x, y) : x * y)
function pmul(x: number, y: number) { let r = 0; for (let i = 0; i < 8; i++) if ((y >>> i) & 1) r ^= x << i; return r & 0xff }

// ---------- one register and a modified immediate ----------
function modImm(f: FP, insn: number, Vd: number): boolean {
  const Q = (insn >>> 6) & 1, op = (insn >>> 5) & 1, cmode = (insn >>> 8) & 0xf
  const imm8 = (((insn >>> 24) & 1) << 7) | (((insn >>> 16) & 7) << 4) | (insn & 0xf)
  let lo: number, hi: number
  if (cmode < 8) { const sh = (cmode >>> 1) * 8; lo = hi = (imm8 << sh) >>> 0 }
  else if (cmode < 12) { const sh = ((cmode >>> 1) & 1) * 8; lo = hi = (((imm8 << sh) & 0xffff) * 0x10001) >>> 0 }
  else if (cmode === 12) lo = hi = ((imm8 << 8) | 0xff) >>> 0
  else if (cmode === 13) lo = hi = ((imm8 << 16) | 0xffff) >>> 0
  else if (cmode === 14 && !op) lo = hi = (imm8 * 0x01010101) >>> 0
  else if (cmode === 14) { lo = 0; hi = 0; for (let i = 0; i < 8; i++) if ((imm8 >>> i) & 1) { if (i < 4) lo |= 0xff << (i * 8); else hi |= 0xff << ((i - 4) * 8) } lo >>>= 0; hi >>>= 0 }
  else if (!op) { // cmode 15: a float
    const b6 = (imm8 >>> 6) & 1
    lo = hi = (((imm8 >>> 7) << 31) | ((b6 ^ 1) << 30) | ((b6 ? 0x1f : 0) << 25) | ((imm8 & 0x3f) << 19)) >>> 0
  } else return false
  const inv = op && cmode !== 14 && cmode !== 15
  const isOrr = (cmode & 1) === 1 && cmode < 12
  for (let r = 0; r <= Q; r++) {
    const i = (Vd + r) * 2
    if (isOrr) { if (op) { f.u[i] &= ~lo; f.u[i + 1] &= ~hi } else { f.u[i] |= lo; f.u[i + 1] |= hi } }
    else { f.u[i] = inv ? ~lo >>> 0 : lo; f.u[i + 1] = inv ? ~hi >>> 0 : hi }
  }
  return true
}

// ---------- two registers and a shift amount ----------
function shift(f: FP, insn: number, U: number, Vd: number, Vm: number): boolean {
  const A = (insn >>> 8) & 0xf, L = (insn >>> 7) & 1, Q = (insn >>> 6) & 1, imm6 = (insn >>> 16) & 0x3f
  const es = L ? 8 : imm6 >= 32 ? 4 : imm6 >= 16 ? 2 : 1
  const bits = es * 8
  const right = (L ? 64 : 2 * bits) - imm6, left = imm6 - (L ? 0 : bits)
  const sgn = !U
  // narrowing: q (2*es) -> d (es). vshrn / vrshrn keep the low bits, vqshrun takes signed and gives
  // unsigned, vqshrn keeps the sign of U
  if (A === 8 || A === 9) {
    if (L) return false
    const round = (insn >>> 6) & 1
    const trunc = A === 8 && !U, srcSgn = A === 8 ? !!U : sgn, outSgn = A === 9 && sgn
    const src = view(f, es * 2, srcSgn), n = 8 / es, s0 = at(Vm, es * 2)
    const vals = Array.from(src.subarray(s0, s0 + n) as any) as (number | bigint)[]
    const outV = view(f, es, outSgn), d0 = at(Vd, es)
    for (let i = 0; i < n; i++) {
      const x = vals[i]
      let r: number
      if (typeof x === 'bigint') { const y = round ? brshr(x, right) : bshr(x, right); r = trunc ? Number(BigInt.asUintN(bits, y)) : Number(satB(f, y, es, outSgn)) }
      else { const y = round ? rshr(x, right) : shr(x, right); r = trunc ? y : sat(f, y, es, outSgn) }
      outV[d0 + i] = r as any
    }
    return true
  }
  if (A === 10) { // vshll / vmovl: d (es) -> q (2*es)
    if (L) return false
    const src = view(f, es, sgn), n = 8 / es, s0 = at(Vm, es)
    const vals = Array.from(src.subarray(s0, s0 + n) as any) as number[]
    const out = view(f, es * 2, sgn), d0 = at(Vd, es * 2)
    for (let i = 0; i < n; i++) out[d0 + i] = (es === 4 ? BigInt(vals[i]) << BigInt(left) : vals[i] * 2 ** left) as any
    return true
  }
  if (A === 14 || A === 15) { // vcvt between float and fixed point
    if (L || es !== 4) return false
    const frac = 64 - imm6, n = Q ? 4 : 2
    for (let i = 0; i < n; i++) {
      const k = Vm * 2 + i, o = Vd * 2 + i
      if (A === 14) f.s[o] = (U ? f.u[k] : f.i32[k]) / 2 ** frac
      else { const t = Math.trunc(f.s[k] * 2 ** frac); f.u[o] = U ? (Number.isNaN(t) ? 0 : Math.max(0, Math.min(4294967295, t))) : ((Number.isNaN(t) ? 0 : Math.max(-2147483648, Math.min(2147483647, t))) >>> 0) }
    }
    return true
  }
  const n = (Q ? 16 : 8) / es
  if (es === 8) {
    const v = view(f, 8, sgn) as BigInt64Array, uv = f.u64
    for (let i = 0; i < n; i++) {
      const x = v[Vm + i], d = v[Vd + i], ux = uv[Vm + i], ud = uv[Vd + i]
      let r: bigint
      switch (A) {
        case 0: r = bshr(x, Math.min(right, 63 + U)); break
        case 1: r = d + bshr(x, Math.min(right, 63 + U)); break
        case 2: r = brshr(x, right); break
        case 3: r = d + brshr(x, right); break
        case 4: { if (!U) return false; const mk = right >= 64 ? 0n : (0xffffffffffffffffn >> BigInt(right)); r = (ud & ~mk) | ((ux >> BigInt(right)) & mk); break }
        case 5: { const mk = (0xffffffffffffffffn << BigInt(left)) & 0xffffffffffffffffn; r = U ? (ud & ~mk) | ((ux << BigInt(left)) & mk) : ux << BigInt(left); break }
        case 6: case 7: { const sx = A === 6 ? f.i64[Vm + i] : x; r = satB(f, sx << BigInt(left), 8, A === 7 ? sgn : false); break }
        default: return false
      }
      f.i64[Vd + i] = BigInt.asIntN(64, r)
    }
    return true
  }
  const v = view(f, es, sgn), uv = view(f, es, false), sv = view(f, es, true)
  const s0 = at(Vm, es), d0 = at(Vd, es)
  const xs = Array.from(v.subarray(s0, s0 + n) as any) as number[], ds = Array.from(v.subarray(d0, d0 + n) as any) as number[]
  const uxs = Array.from(uv.subarray(s0, s0 + n) as any) as number[], uds = Array.from(uv.subarray(d0, d0 + n) as any) as number[]
  const full = 2 ** bits
  for (let i = 0; i < n; i++) {
    const x = xs[i], d = ds[i]
    let r: number, tv: V = v
    switch (A) {
      case 0: r = shr(x, right); break // vshr
      case 1: r = d + shr(x, right); break // vsra
      case 2: r = rshr(x, right); break // vrshr
      case 3: r = d + rshr(x, right); break // vrsra
      case 4: { if (!U) return false; const mk = right >= bits ? 0 : Math.floor((full - 1) / 2 ** right); r = Number((BigInt(uds[i]) & ~BigInt(mk)) | (BigInt(Math.floor(uxs[i] / 2 ** right)) & BigInt(mk))); tv = uv; break } // vsri
      case 5: { // vshl imm / vsli
        const p = BigInt(uxs[i]) << BigInt(left)
        if (U) { const mk = (BigInt(full - 1) << BigInt(left)) & BigInt(full - 1); r = Number((BigInt(uds[i]) & ~mk) | (p & mk)) } else r = Number(BigInt.asUintN(bits, p))
        tv = uv; break
      }
      case 6: { if (!U) return false; r = sat(f, (sv[s0 + i] as number) * 2 ** left, es, false); tv = uv; break } // vqshlu (signed in, unsigned out)
      case 7: r = sat(f, x * 2 ** left, es, sgn); break // vqshl imm
      default: return false
    }
    tv[d0 + i] = r as any
  }
  return true
}

// ---------- three registers of different lengths ----------
function diff(f: FP, insn: number, U: number, Vd: number, Vn: number, Vm: number): boolean {
  const A = (insn >>> 8) & 0xf, size = (insn >>> 20) & 3
  const es = 1 << size, wes = es * 2, n = 8 / es, sgn = !U
  const narrow = view(f, es, A === 9 || A === 11 || A === 13 ? true : sgn), wide = view(f, wes, A === 9 || A === 11 || A === 13 ? true : sgn)
  const big = wes === 8
  const N = (i: number) => narrow[at(Vn, es) + i] as number, M = (i: number) => narrow[at(Vm, es) + i] as number
  const W = (r: number, i: number) => wide[at(r, wes) + i]
  if (A === 4 || A === 6) { // vaddhn / vsubhn (+ rounding when U): q, q -> d (high halves)
    const out = view(f, es, false), wv = view(f, wes, false), half = BigInt(es * 8)
    const res: number[] = []
    for (let i = 0; i < n; i++) {
      const x = BigInt(wv[at(Vn, wes) + i]), y = BigInt(wv[at(Vm, wes) + i])
      let s = A === 4 ? x + y : x - y
      if (U) s += 1n << (half - 1n)
      res.push(Number(BigInt.asUintN(es * 8, s >> half)))
    }
    res.forEach((x, i) => { out[at(Vd, es) + i] = x as any })
    return true
  }
  const res: (number | bigint)[] = []
  for (let i = 0; i < n; i++) {
    let r: number | bigint
    const x = A === 1 || A === 3 ? W(Vn, i) : N(i), y = M(i)
    const mul = () => (big ? BigInt(x as number) * BigInt(y) : (x as number) * y)
    const acc = W(Vd, i)
    const add = (a: any, b: any) => (big ? BigInt(a) + BigInt(b) : a + b)
    const sub = (a: any, b: any) => (big ? BigInt(a) - BigInt(b) : a - b)
    switch (A) {
      case 0: case 1: r = add(x, y); break // vaddl / vaddw
      case 2: case 3: r = sub(x, y); break // vsubl / vsubw
      case 5: r = add(acc, Math.abs((x as number) - y)); break // vabal
      case 7: r = big ? BigInt(Math.abs((x as number) - y)) : Math.abs((x as number) - y); break // vabdl
      case 8: r = add(acc, mul()); break // vmlal
      case 10: r = sub(acc, mul()); break // vmlsl
      case 12: r = mul(); break // vmull
      case 9: case 11: case 13: { // vqdmlal / vqdmlsl / vqdmull
        const p = satB(f, BigInt(x as number) * BigInt(y) * 2n, wes, true)
        const v = A === 13 ? p : satB(f, A === 9 ? BigInt(acc) + p : BigInt(acc) - p, wes, true)
        r = big ? v : Number(v)
        break
      }
      case 14: { if (U || es !== 1) return false; let p = 0; for (let k = 0; k < 8; k++) if (((y as number) >>> k) & 1) p ^= ((x as number) & 0xff) << k; r = p; break } // vmull.p8
      default: return false
    }
    res.push(r)
  }
  const d0 = at(Vd, wes)
  res.forEach((x, i) => { if (big) f.i64[d0 + i] = BigInt.asIntN(64, BigInt(x)); else (wide as any)[d0 + i] = x })
  return true
}

// ---------- two registers and a scalar ----------
function scalar(f: FP, insn: number, U: number, Vd: number, Vn: number): boolean {
  const A = (insn >>> 8) & 0xf, size = (insn >>> 20) & 3
  if (size === 0 || size === 3) return false
  const es = 1 << size
  const Vm = es === 2 ? insn & 7 : insn & 0xf
  const idx = es === 2 ? ((((insn >>> 5) & 1) << 1) | ((insn >>> 3) & 1)) : (insn >>> 5) & 1
  const F = (A & 1) === 1 && (A === 1 || A === 5 || A === 9)
  const long = A === 2 || A === 3 || A === 6 || A === 7 || A === 10 || A === 11
  const Q = long ? 0 : U
  if (F) {
    if (es !== 4) return false
    const x = f.s[Vm * 2 + idx], n = Q ? 4 : 2
    for (let i = 0; i < n; i++) {
      const p = Math.fround(f.s[Vn * 2 + i] * x)
      f.s[Vd * 2 + i] = A === 1 ? f.s[Vd * 2 + i] + p : A === 5 ? f.s[Vd * 2 + i] - p : p
    }
    return true
  }
  const sgn = long ? !U : true
  const nv = view(f, es, A === 0 || A === 4 || A === 8 ? false : sgn)
  const sc = nv[at(Vm, es) + idx] as number
  if (!long) {
    const n = (Q ? 16 : 8) / es, base = at(Vn, es), d0 = at(Vd, es)
    const sv = view(f, es, true)
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const x = nv[base + i] as number, d = nv[d0 + i] as number
      if (A === 0) out.push(d + mulLow(x, sc, es))
      else if (A === 4) out.push(d - mulLow(x, sc, es))
      else if (A === 8) out.push(mulLow(x, sc, es))
      else if (A === 12 || A === 13) {
        const sx = sv[base + i] as number, ss = sv[at(Vm, es) + idx] as number
        const p = BigInt(sx) * BigInt(ss) * 2n + (A === 13 ? 1n << BigInt(es * 8 - 1) : 0n)
        out.push(Number(satB(f, p >> BigInt(es * 8), es, true)))
      } else return false
    }
    const ov = A === 12 || A === 13 ? sv : nv
    out.forEach((x, i) => { ov[d0 + i] = x as any })
    return true
  }
  const wes = es * 2, n = 8 / es, big = wes === 8
  const wide = view(f, wes, sgn), d0 = at(Vd, wes)
  const xs = Array.from(nv.subarray(at(Vn, es), at(Vn, es) + n) as any) as number[]
  for (let i = 0; i < n; i++) {
    const p: any = big ? BigInt(xs[i]) * BigInt(sc) : xs[i] * sc
    const acc = wide[d0 + i] as any
    let r: any
    if (A === 2) r = big ? BigInt(acc) + (p as bigint) : acc + p
    else if (A === 6) r = big ? BigInt(acc) - (p as bigint) : acc - p
    else if (A === 10) r = p
    else { // vqdmlal / vqdmlsl / vqdmull
      const q = satB(f, BigInt(xs[i]) * BigInt(sc) * 2n, wes, true)
      const v = A === 11 ? q : satB(f, A === 3 ? BigInt(acc) + q : BigInt(acc) - q, wes, true)
      r = big ? v : Number(v)
    }
    if (big) f.i64[d0 + i] = BigInt.asIntN(64, BigInt(r)); else wide[d0 + i] = r
  }
  return true
}

// ---------- two registers, miscellaneous ----------
function misc(f: FP, insn: number, Vd: number, Vm: number): boolean {
  const size = (insn >>> 18) & 3, opc1 = (insn >>> 16) & 3, op = (insn >>> 7) & 0xf, Q = (insn >>> 6) & 1
  const es = 1 << size, bytes = Q ? 16 : 8, n = bytes / es
  const regs = Q ? 2 : 1
  if (opc1 === 0) {
    if (op <= 2) { // vrev64 / vrev32 / vrev16
      const group = [8, 4, 2][op]
      if (es >= group) return false
      const src = f.b.slice(Vm * 8, Vm * 8 + bytes), out = new Uint8Array(bytes)
      const per = group / es
      for (let g = 0; g < bytes; g += group) for (let e = 0; e < per; e++) for (let k = 0; k < es; k++) out[g + e * es + k] = src[g + (per - 1 - e) * es + k]
      f.b.set(out, Vd * 8)
      return true
    }
    if (op === 4 || op === 5 || op === 12 || op === 13) { // vpaddl / vpadal
      const sgn = !(op & 1), src = view(f, es, sgn), dst = view(f, es * 2, sgn), m = n / 2
      const xs = Array.from(src.subarray(at(Vm, es), at(Vm, es) + n) as any) as number[]
      for (let i = 0; i < m; i++) {
        const s = es === 4 ? BigInt(xs[2 * i]) + BigInt(xs[2 * i + 1]) : xs[2 * i] + xs[2 * i + 1]
        const k = at(Vd, es * 2) + i
        ;(dst as any)[k] = op >= 12 ? (dst as any)[k] + s : s
      }
      return true
    }
    if (op === 8 || op === 9 || op === 10) { // vcls / vclz / vcnt
      const v = view(f, es, false), sv = view(f, es, true), d0 = at(Vd, es), s0 = at(Vm, es), bits = es * 8
      const xs = Array.from(v.subarray(s0, s0 + n) as any) as number[], ss = Array.from(sv.subarray(s0, s0 + n) as any) as number[]
      for (let i = 0; i < n; i++) {
        const x = xs[i]
        let r: number
        if (op === 10) { if (es !== 1) return false; let c = 0; for (let k = x; k; k &= k - 1) c++; r = c }
        else if (op === 9) r = Math.clz32(x) - (32 - bits)
        else { const y = ss[i] < 0 ? ~ss[i] : ss[i]; r = Math.clz32(y) - (32 - bits) - 1 }
        v[d0 + i] = r as any
      }
      return true
    }
    if (op === 11) { for (let i = 0; i < regs * 2; i++) f.u[Vd * 2 + i] = ~f.u[Vm * 2 + i] >>> 0; return true } // vmvn
    if (op === 14 || op === 15) { // vqabs / vqneg
      const v = view(f, es, true), d0 = at(Vd, es), s0 = at(Vm, es)
      const xs = Array.from(v.subarray(s0, s0 + n) as any) as number[]
      for (let i = 0; i < n; i++) v[d0 + i] = sat(f, op === 14 ? Math.abs(xs[i]) : -xs[i], es, true) as any
      return true
    }
    return false
  }
  if (opc1 === 1) { // compare with zero, vabs, vneg (F: float)
    const F = (op >>> 3) & 1, k = op & 7
    if (F) {
      if (es !== 4) return false
      const xs = f.s.slice(Vm * 2, Vm * 2 + n), mask = (t: boolean) => (t ? 0xffffffff : 0)
      for (let i = 0; i < n; i++) {
        const x = xs[i], o = Vd * 2 + i
        if (k === 0) f.u[o] = mask(x > 0); else if (k === 1) f.u[o] = mask(x >= 0); else if (k === 2) f.u[o] = mask(x === 0); else if (k === 3) f.u[o] = mask(x <= 0); else if (k === 4) f.u[o] = mask(x < 0)
        else if (k === 6) f.u[o] = f.u[Vm * 2 + i] & 0x7fffffff
        else if (k === 7) f.u[o] = (f.u[Vm * 2 + i] ^ 0x80000000) >>> 0
        else return false
      }
      return true
    }
    const v = view(f, es, true), d0 = at(Vd, es), s0 = at(Vm, es)
    const xs = Array.from(v.subarray(s0, s0 + n) as any) as number[]
    for (let i = 0; i < n; i++) {
      const x = xs[i]
      let r: number
      if (k === 0) r = x > 0 ? -1 : 0; else if (k === 1) r = x >= 0 ? -1 : 0; else if (k === 2) r = x === 0 ? -1 : 0; else if (k === 3) r = x <= 0 ? -1 : 0; else if (k === 4) r = x < 0 ? -1 : 0
      else if (k === 6) r = Math.abs(x); else if (k === 7) r = -x
      else return false
      v[d0 + i] = r as any
    }
    return true
  }
  if (opc1 === 2) {
    if (op === 0) { const a = f.b.slice(Vd * 8, Vd * 8 + bytes); f.b.copyWithin(Vd * 8, Vm * 8, Vm * 8 + bytes); f.b.set(a, Vm * 8); return true } // vswp
    if (op >= 1 && op <= 3) { // vtrn / vuzp / vzip
      const v = view(f, es, false), d0 = at(Vd, es), m0 = at(Vm, es)
      const a = Array.from(v.subarray(d0, d0 + n) as any) as number[], b = Array.from(v.subarray(m0, m0 + n) as any) as number[]
      let x: number[], y: number[]
      if (op === 1) { x = a.slice(); y = b.slice(); for (let i = 0; i < n; i += 2) { x[i + 1] = b[i]; y[i] = a[i + 1] } }
      else if (op === 2) { const all = [...a, ...b]; x = all.filter((_, i) => !(i & 1)); y = all.filter((_, i) => i & 1) }
      else { const all: number[] = []; for (let i = 0; i < n; i++) all.push(a[i], b[i]); x = all.slice(0, n); y = all.slice(n) }
      x.forEach((e, i) => { v[d0 + i] = e as any }); y.forEach((e, i) => { v[m0 + i] = e as any })
      return true
    }
    if (op === 4 || op === 5) { // vmovn / vqmovun / vqmovn (bits 7-6)
      const kind = (insn >>> 6) & 3, wes = es * 2, m = 8 / es
      const srcSgn = kind === 1 || kind === 2
      const src = view(f, wes, srcSgn), out = view(f, es, kind === 2), d0 = at(Vd, es)
      const xs = Array.from(src.subarray(at(Vm, wes), at(Vm, wes) + m) as any) as (number | bigint)[]
      for (let i = 0; i < m; i++) {
        const x = xs[i]
        if (kind === 0) out[d0 + i] = (typeof x === 'bigint' ? Number(BigInt.asUintN(es * 8, x)) : x) as any
        else out[d0 + i] = (typeof x === 'bigint' ? Number(satB(f, x, es, kind === 2)) : sat(f, x, es, kind === 2)) as any
      }
      return true
    }
    if (op === 6 && !Q) { // vshll by the element size
      const src = view(f, es, false), wes = es * 2, out = view(f, wes, false), m = 8 / es
      const xs = Array.from(src.subarray(at(Vm, es), at(Vm, es) + m) as any) as number[]
      for (let i = 0; i < m; i++) out[at(Vd, wes) + i] = (wes === 8 ? BigInt(xs[i]) << 32n : xs[i] * 2 ** (es * 8)) as any
      return true
    }
    if ((op === 12 || op === 14) && !Q) { // vcvt f16 <-> f32
      if (op === 12) { const r = new Uint16Array(4); for (let i = 0; i < 4; i++) r[i] = toHalf(f.s[Vm * 2 + i]); f.b.set(new Uint8Array(r.buffer), Vd * 8) }
      else { const h = new Uint16Array(f.b.slice(Vm * 8, Vm * 8 + 8).buffer); for (let i = 0; i < 4; i++) f.s[Vd * 2 + i] = fromHalf(h[i]) }
      return true
    }
    return false
  }
  // opc1 = 3: vrecpe / vrsqrte / vcvt (32-bit lanes)
  if (es !== 4) return false
  const m = Q ? 4 : 2
  if ((op & 0xc) === 0x8) { // 10Fx
    const F = (op >>> 1) & 1, sq = op & 1
    for (let i = 0; i < m; i++) {
      const k = Vm * 2 + i, o = Vd * 2 + i
      if (F) f.s[o] = sq ? 1 / Math.sqrt(f.s[k]) : 1 / f.s[k]
      else { const x = f.u[k]; f.u[o] = sq ? (x < 0x40000000 ? 0xffffffff : Math.min(0xffffffff, Math.floor(2 ** 31 / Math.sqrt(x / 2 ** 32)))) >>> 0 : (x < 0x80000000 ? 0xffffffff : Math.min(0xffffffff, Math.floor(2 ** 63 / x))) >>> 0 }
    }
    return true
  }
  if ((op & 0xc) === 0xc) { // vcvt: 00 f32<-s32, 01 f32<-u32, 10 s32<-f32, 11 u32<-f32
    const k2 = op & 3
    for (let i = 0; i < m; i++) {
      const k = Vm * 2 + i, o = Vd * 2 + i
      if (k2 === 0) f.s[o] = f.i32[k]
      else if (k2 === 1) f.s[o] = f.u[k]
      else { const t = Math.trunc(f.s[k]); f.u[o] = Number.isNaN(t) ? 0 : k2 === 2 ? (Math.max(-2147483648, Math.min(2147483647, t)) >>> 0) : Math.max(0, Math.min(4294967295, t)) }
    }
    return true
  }
  return false
}
function toHalf(x: number) {
  const b = new Uint32Array(new Float32Array([x]).buffer)[0]
  const s = (b >>> 16) & 0x8000, e = ((b >>> 23) & 0xff) - 127 + 15, m = b & 0x7fffff
  if (((b >>> 23) & 0xff) === 0xff) return s | 0x7c00 | (m ? 0x200 : 0)
  if (e >= 31) return s | 0x7c00
  if (e <= 0) { if (e < -10) return s; const mm = (m | 0x800000) >>> (1 - e); return s | ((mm + 0x1000) >>> 13) }
  return s | ((e << 10) + ((m + 0x1000) >>> 13))
}
function fromHalf(h: number) {
  const s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

// ---------- element and structure loads / stores ----------
function ldst(c: CPU, insn: number): boolean {
  const f = c.fp, m = c.mem
  const L = (insn >>> 21) & 1, Rn = (insn >>> 16) & 0xf, Rm = insn & 0xf
  const Vd = ((insn >>> 12) & 0xf) | (((insn >>> 22) & 1) << 4)
  let a = c.r[Rn], moved = 0
  const ld = (reg: number, off: number, es: number, addr: number) => { const o = (reg & 31) * 8 + off; for (let k = 0; k < es; k++) f.b[o + k] = m.r8(addr + k) }
  const st = (reg: number, off: number, es: number, addr: number) => { const o = (reg & 31) * 8 + off; for (let k = 0; k < es; k++) m.w8(addr + k, f.b[o + k]) }
  if (!((insn >>> 23) & 1)) { // multiple elements
    const type = (insn >>> 8) & 0xf, es = 1 << ((insn >>> 6) & 3)
    const one: Record<number, number> = { 7: 1, 10: 2, 6: 3, 2: 4 }
    if (one[type]) { // vld1 / vst1: plain copy of whole registers
      const regs = one[type]
      for (let r = 0; r < regs; r++) for (let w = 0; w < 2; w++) { const idx = (Vd + r) * 2 + w; if (L) f.u[idx] = m.r32(a + moved); else m.w32(a + moved, f.u[idx]); moved += 4 }
    } else {
      // structures: nel elements each spread over registers d, d+inc, ...
      const shape: Record<number, [number, number, number]> = { 8: [2, 1, 1], 9: [2, 2, 1], 3: [2, 2, 2], 4: [3, 1, 1], 5: [3, 2, 1], 0: [4, 1, 1], 1: [4, 2, 1] }
      const s = shape[type]
      if (!s) return false
      const [nel, inc, regs] = s
      const lanes = 8 / es
      for (let r = 0; r < regs; r++) for (let e = 0; e < lanes; e++) for (let k = 0; k < nel; k++) {
        const reg = Vd + r + k * (nel === 2 && regs === 2 ? 2 : inc)
        if (L) ld(reg, e * es, es, a + moved); else st(reg, e * es, es, a + moved)
        moved += es
      }
    }
  } else if (((insn >>> 10) & 3) === 3) { // one element to all lanes
    if (!L) return false
    const nel = ((insn >>> 8) & 3) + 1, es = 1 << ((insn >>> 6) & 3), T = (insn >>> 5) & 1
    const inc = nel === 1 ? 1 : T + 1, copies = nel === 1 ? T + 1 : 1
    for (let k = 0; k < nel; k++) {
      const tmp = new Uint8Array(es)
      for (let b = 0; b < es; b++) tmp[b] = m.r8(a + moved + b)
      moved += es
      for (let cpy = 0; cpy < copies; cpy++) { const reg = (Vd + k * inc + cpy) & 31; for (let o = 0; o < 8; o += es) f.b.set(tmp, reg * 8 + o) }
    }
  } else { // one lane
    const size = (insn >>> 10) & 3, nel = ((insn >>> 8) & 3) + 1, es = 1 << size, ia = (insn >>> 4) & 0xf
    const index = size === 0 ? ia >>> 1 : size === 1 ? ia >>> 2 : ia >>> 3
    const inc = size === 0 ? 1 : size === 1 ? ((ia >>> 1) & 1) + 1 : ((ia >>> 2) & 1) + 1
    for (let k = 0; k < nel; k++) { const reg = Vd + k * inc; if (L) ld(reg, index * es, es, a + moved); else st(reg, index * es, es, a + moved); moved += es }
  }
  if (Rm === 13) c.r[Rn] = (a + moved) >>> 0
  else if (Rm !== 15) c.r[Rn] = (a + c.r[Rm]) >>> 0
  void a
  return true
}
