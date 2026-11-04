// armv6 dsp / simd-in-a-register instructions, shared by the arm and thumb-2 decoders:
// parallel add / subtract (signed, saturating, halving, unsigned...), sel, qadd / qsub / qdadd / qdsub,
// the 16-bit multiplies (smulxy smlaxy smulwy smlawy smlalxy, smuad smlad smusd smlsd smlald smlsld,
// smmul smmla smmls), usad8 / usada8, pkhbt / pkhtb, ssat16 / usat16, revsh.
import type { CPU } from './cpu.ts'

const s16 = (v: number) => (v << 16) >> 16
const s8 = (v: number) => (v << 24) >> 24
const clamp = (v: number, lo: number, hi: number, c: CPU) => { if (v < lo) { c.Qf = true; return lo } if (v > hi) { c.Qf = true; return hi } return v }

// kind: 1 signed (sets GE), 2 saturating signed, 3 halving signed, 5 unsigned (sets GE), 6 saturating
// unsigned, 7 halving unsigned. op: 0 add16, 1 asx, 2 sax, 3 sub16, 4 add8, 7 sub8 (arm numbering)
export function parallel(c: CPU, kind: number, op: number, a: number, b: number): number {
  const sgn = kind < 4, mode = kind & 3 // 1 plain, 2 saturating, 3 halving
  if (op === 4 || op === 7) {
    let r = 0, ge = 0
    for (let i = 0; i < 4; i++) {
      const x = sgn ? s8(a >>> (i * 8)) : (a >>> (i * 8)) & 0xff, y = sgn ? s8(b >>> (i * 8)) : (b >>> (i * 8)) & 0xff
      let v = op === 4 ? x + y : x - y
      if (mode === 1) { if (sgn ? v >= 0 : op === 4 ? v >= 0x100 : v >= 0) ge |= 1 << i }
      else if (mode === 2) v = sgn ? Math.max(-128, Math.min(127, v)) : Math.max(0, Math.min(255, v))
      else v >>= 1
      r |= (v & 0xff) << (i * 8)
    }
    if (mode === 1) c.GE = ge
    return r >>> 0
  }
  let r = 0, ge = 0
  for (let i = 0; i < 2; i++) {
    const x = sgn ? s16(a >>> (i * 16)) : (a >>> (i * 16)) & 0xffff
    // asx: lo = a.lo - b.hi, hi = a.hi + b.lo. sax: lo = a.lo + b.hi, hi = a.hi - b.lo
    const j = op === 1 || op === 2 ? 1 - i : i
    const y = sgn ? s16(b >>> (j * 16)) : (b >>> (j * 16)) & 0xffff
    const add = op === 0 || (op === 1 && i === 1) || (op === 2 && i === 0)
    let v = add ? x + y : x - y
    if (mode === 1) { if (sgn ? v >= 0 : add ? v >= 0x10000 : v >= 0) ge |= 3 << (i * 2) }
    else if (mode === 2) v = sgn ? Math.max(-32768, Math.min(32767, v)) : Math.max(0, Math.min(65535, v))
    else v >>= 1
    r |= (v & 0xffff) << (i * 16)
  }
  if (mode === 1) c.GE = ge
  return r >>> 0
}
export function sel(c: CPU, a: number, b: number) {
  let r = 0
  for (let i = 0; i < 4; i++) r |= (((c.GE >>> i) & 1 ? a : b) >>> (i * 8) & 0xff) << (i * 8)
  return r >>> 0
}
// qadd 0, qsub 1, qdadd 2, qdsub 3 (rm op rn)
export function qop(c: CPU, op: number, m: number, n: number) {
  const L = -2147483648, H = 2147483647
  let y = n | 0
  if (op & 2) y = clamp(y * 2, L, H, c)
  return clamp(op & 1 ? (m | 0) - y : (m | 0) + y, L, H, c) >>> 0
}
export function usad8(a: number, b: number) {
  let s = 0
  for (let i = 0; i < 4; i++) s += Math.abs(((a >>> (i * 8)) & 0xff) - ((b >>> (i * 8)) & 0xff))
  return s
}
export function sat16(c: CPU, v: number, bits: number, unsigned: boolean) {
  let r = 0
  for (let i = 0; i < 2; i++) {
    const x = s16(v >>> (i * 16))
    const y = unsigned ? clamp(x, 0, 2 ** bits - 1, c) : clamp(x, -(2 ** (bits - 1)), 2 ** (bits - 1) - 1, c)
    r |= (y & 0xffff) << (i * 16)
  }
  return r >>> 0
}
const half = (v: number, top: number) => (top ? v >> 16 : s16(v))
const addQ = (c: CPU, a: number, b: number) => { const s = a + b; if (s > 2147483647 || s < -2147483648) c.Qf = true; return s | 0 }
// smulxy / smlaxy (acc !== null)
export function smulxy(c: CPU, n: number, m: number, x: number, y: number, acc: number | null) {
  const p = half(n, x) * half(m, y)
  return (acc === null ? p : addQ(c, p, acc | 0)) >>> 0
}
// smulwy / smlawy: 32 x 16 -> top 32 of 48
export function smulwy(c: CPU, n: number, m: number, y: number, acc: number | null) {
  const p = Number((BigInt(n | 0) * BigInt(half(m, y))) >> 16n)
  return (acc === null ? p | 0 : addQ(c, p | 0, acc | 0)) >>> 0
}
// smuad / smlad / smusd / smlsd: two 16x16 products, summed or subtracted (x swaps m's halves)
export function dual(c: CPU, n: number, m: number, x: number, sub: boolean, acc: number | null) {
  const mm = x ? ((m >>> 16) | (m << 16)) >>> 0 : m
  const p1 = s16(n) * s16(mm), p2 = (n >> 16) * (mm >> 16)
  let r = sub ? p1 - p2 : p1 + p2
  if (acc !== null) r += acc | 0
  if (!sub && (r > 2147483647 || r < -2147483648)) c.Qf = true
  return r >>> 0
}
// smlald / smlsld: the same into a 64-bit accumulator; returns [lo, hi]
export function dualLong(n: number, m: number, x: number, sub: boolean, lo: number, hi: number): [number, number] {
  const mm = x ? ((m >>> 16) | (m << 16)) >>> 0 : m
  const p1 = s16(n) * s16(mm), p2 = (n >> 16) * (mm >> 16)
  const r = BigInt.asUintN(64, ((BigInt(hi) << 32n) | BigInt(lo >>> 0)) + BigInt(sub ? p1 - p2 : p1 + p2))
  return [Number(r & 0xffffffffn), Number(r >> 32n)]
}
// smmul / smmla / smmls (+ rounding)
export function smm(n: number, m: number, acc: number | null, sub: boolean, round: boolean) {
  let p = BigInt(n | 0) * BigInt(m | 0)
  if (acc !== null) p = sub ? (BigInt(acc | 0) << 32n) - p : (BigInt(acc | 0) << 32n) + p
  if (round) p += 0x80000000n
  return Number(BigInt.asUintN(32, p >> 32n))
}
// smlalxy: 16x16 into 64
export function smlalxy(n: number, m: number, x: number, y: number, lo: number, hi: number): [number, number] {
  const r = BigInt.asUintN(64, ((BigInt(hi) << 32n) | BigInt(lo >>> 0)) + BigInt(half(n, x) * half(m, y)))
  return [Number(r & 0xffffffffn), Number(r >> 32n)]
}
export const revsh = (v: number) => (s8(v) << 8 | ((v >>> 8) & 0xff)) >>> 0

// arm encodings. returns false when the instruction is not one of these
export function armDsp(c: CPU, insn: number): boolean {
  const rd = (insn >>> 12) & 0xf, rn = (insn >>> 16) & 0xf, rm = insn & 0xf, rs = (insn >>> 8) & 0xf
  const R = c.r
  if ((insn & 0x0f800010) === 0x06000010 && ((insn >>> 20) & 3)) { // parallel add / sub
    const kind = (insn >>> 20) & 7, op = (insn >>> 5) & 7
    if (op === 5 || op === 6) return false
    R[rd] = parallel(c, kind, op, R[rn], R[rm])
    return true
  }
  if ((insn & 0x0ff00ff0) === 0x06800fb0) { R[rd] = sel(c, R[rn], R[rm]); return true }
  if ((insn & 0x0ff00030) === 0x06800010) { // pkhbt / pkhtb
    const sh = (insn >>> 7) & 0x1f, tb = (insn >>> 6) & 1
    if (tb) { const v = sh ? (R[rm] | 0) >> sh : (R[rm] | 0) >> 31; R[rd] = ((R[rn] & 0xffff0000) | (v & 0xffff)) >>> 0 }
    else { const v = R[rm] << sh; R[rd] = ((R[rn] & 0xffff) | (v & 0xffff0000)) >>> 0 }
    return true
  }
  if ((insn & 0x0fb00ff0) === 0x06a00f30) { R[rd] = sat16(c, R[rm], (((insn >>> 16) & 0xf) + ((insn >>> 22) & 1 ? 0 : 1)), ((insn >>> 22) & 1) === 1); return true } // ssat16 / usat16
  if ((insn & 0x0fa00030) === 0x06a00010) { // ssat / usat with shift
    const u = (insn >>> 22) & 1, sat = (insn >>> 16) & 0x1f, sh = (insn >>> 7) & 0x1f, asr = (insn >>> 6) & 1
    let v = R[rm] | 0
    v = asr ? v >> (sh || 31) : v << sh
    R[rd] = (u ? clamp(v, 0, 2 ** sat - 1, c) : clamp(v, -(2 ** sat), 2 ** sat - 1, c)) >>> 0
    return true
  }
  if ((insn & 0x0fff0ff0) === 0x06ff0fb0) { R[rd] = revsh(R[rm]); return true }
  if ((insn & 0x0ff000f0) === 0x07800010) { R[rn] = (usad8(R[rm], R[rs]) + (rd === 15 ? 0 : R[rd])) >>> 0; return true } // usad8 / usada8 (rd field = ra)
  if ((insn & 0x0f800010) === 0x07000010) { // smlad family (rn field = rd, rd field = ra)
    const op1 = (insn >>> 20) & 7, op2 = (insn >>> 5) & 7, x = op2 & 1
    const dst = rn, ra = rd
    if (op1 === 0) { R[dst] = dual(c, R[rm], R[rs], x, (op2 & 2) === 2, ra === 15 ? null : R[ra]); return true }
    if (op1 === 4) { const [lo, hi] = dualLong(R[rm], R[rs], x, (op2 & 2) === 2, R[rd], R[rn]); R[rd] = lo; R[rn] = hi; return true }
    if (op1 === 5) { const sub = op2 >= 6; R[dst] = smm(R[rm], R[rs], ra === 15 ? null : R[ra], sub, (op2 & 1) === 1); return true }
    return false
  }
  if ((insn & 0x0f9000f0) === 0x01000050) { R[rd] = qop(c, (insn >>> 21) & 3, R[rm], R[rn]); return true }
  if ((insn & 0x0f900090) === 0x01000080) { // halfword multiplies
    const op = (insn >>> 21) & 3, x = (insn >>> 5) & 1, y = (insn >>> 6) & 1
    const dst = rn, ra = rd
    if (op === 0) R[dst] = smulxy(c, R[rm], R[rs], x, y, R[ra])
    else if (op === 1) R[dst] = x ? smulwy(c, R[rm], R[rs], y, null) : smulwy(c, R[rm], R[rs], y, R[ra])
    else if (op === 2) { const [lo, hi] = smlalxy(R[rm], R[rs], x, y, R[rd], R[rn]); R[rd] = lo; R[rn] = hi }
    else R[dst] = smulxy(c, R[rm], R[rs], x, y, null)
    return true
  }
  return false
}

// thumb-2: register group (h1 1111 1010 1xxx) parallel ops, q ops, sel
export function thumbParallel(c: CPU, h1: number, h2: number): boolean {
  const rn = h1 & 0xf, rd = (h2 >>> 8) & 0xf, rm = h2 & 0xf
  const op1 = (h1 >>> 4) & 7, op2 = (h2 >>> 4) & 0xf
  const R = c.r
  if (op2 < 8) {
    // thumb op1: 000 add8 001 add16 010 asx 100 sub8 101 sub16 110 sax; op2: 000 s 001 q 010 sh 100 u 101 uq 110 uh
    const op = [4, 0, 1, -1, 7, 3, 2, -1][op1], k = op2 & 7
    if (op < 0 || k === 3 || k === 7) return false
    const kind = (k & 4 ? 5 : 1) + (k & 3)
    R[rd] = parallel(c, kind, op, R[rn], R[rm])
    return true
  }
  if (op1 === 0 && op2 >= 8 && op2 <= 0xb) { R[rd] = qop(c, [0, 2, 1, 3][op2 - 8], R[rm], R[rn]); return true } // qadd qdadd qsub qdsub
  if (op1 === 2 && op2 === 8) { R[rd] = sel(c, R[rn], R[rm]); return true }
  return false
}

// thumb-2: multiply group (h1 1111 1011 0xxx), the dsp ones
export function thumbMul(c: CPU, h1: number, h2: number): boolean {
  const rn = h1 & 0xf, ra = (h2 >>> 12) & 0xf, rd = (h2 >>> 8) & 0xf, rm = h2 & 0xf
  const op1 = (h1 >>> 4) & 7, op2 = (h2 >>> 4) & 3
  const R = c.r, acc = ra === 15 ? null : R[ra]
  switch (op1) {
    case 1: R[rd] = smulxy(c, R[rn], R[rm], (op2 >>> 1) & 1, op2 & 1, acc); return true
    case 2: R[rd] = dual(c, R[rn], R[rm], op2 & 1, false, acc); return true
    case 3: R[rd] = smulwy(c, R[rn], R[rm], op2 & 1, acc); return true
    case 4: R[rd] = dual(c, R[rn], R[rm], op2 & 1, true, acc); return true
    case 5: R[rd] = smm(R[rn], R[rm], acc, false, (op2 & 1) === 1); return true
    case 6: R[rd] = smm(R[rn], R[rm], R[ra], true, (op2 & 1) === 1); return true
    case 7: R[rd] = (usad8(R[rn], R[rm]) + (acc ?? 0)) >>> 0; return true
  }
  return false
}
