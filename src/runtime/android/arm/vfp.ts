// vfpv3 and a neon subset, shared by arm and thumb-2 (thumb instructions are converted to the arm form
// first). vfp: loads / stores, vmov forms, vmrs, arithmetic, compare, conversions, sqrt, abs, neg.
// neon: vld1 / vst1 (multiple registers), vmov / vmvn immediate, vdup, vorr / vand / veor / vbic,
// integer vadd / vsub. registers: s0..s31 alias d0..d15, d16..d31, q0..q15 = d pairs.
import type { CPU } from './cpu.ts'

export class FP {
  buf = new ArrayBuffer(256)
  s = new Float32Array(this.buf)
  d = new Float64Array(this.buf)
  u = new Uint32Array(this.buf)
  b = new Uint8Array(this.buf)
  fpscr = 0
}

const NZCV = (c: CPU, n: boolean, z: boolean, cc: boolean, v: boolean) => ((n ? 8 : 0) | (z ? 4 : 0) | (cc ? 2 : 0) | (v ? 1 : 0)) << 28

export function execVfp(c: CPU, insn: number, pc: number, thumb: boolean): boolean {
  const f = c.fp
  const m = c.mem
  const Rn = (insn >>> 16) & 0xf, Rt = (insn >>> 12) & 0xf
  const dbl = ((insn >>> 8) & 0xf) === 0xb
  const D = (insn >>> 22) & 1, N = (insn >>> 7) & 1, M = (insn >>> 5) & 1
  const Vd = (insn >>> 12) & 0xf, Vn = (insn >>> 16) & 0xf, Vm = insn & 0xf
  const sd = dbl ? Vd | (D << 4) : (Vd << 1) | D
  const sn = dbl ? Vn | (N << 4) : (Vn << 1) | N
  const sm = dbl ? Vm | (M << 4) : (Vm << 1) | M
  const base = (r: number) => (r === 15 ? ((pc + (thumb ? 4 : 8)) & ~3) >>> 0 : c.r[r])
  const get = (i: number) => (dbl ? f.d[i] : f.s[i])
  const set = (i: number, v: number) => { if (dbl) f.d[i] = v; else f.s[i] = v }
  const top = (insn >>> 24) & 0xf
  const cp = (insn >>> 8) & 0xf

  // ---- neon (arm encodings 1111 001x data, 1111 0100 load/store) ----
  if (insn >>> 28 === 0xf) return neon(c, insn, pc)

  if (cp !== 0xa && cp !== 0xb) return false

  // loads / stores
  if (top === 0xd && !((insn >>> 21) & 1)) { // vldr / vstr
    const imm = (insn & 0xff) * 4
    const a = ((insn >>> 23) & 1 ? base(Rn) + imm : base(Rn) - imm) >>> 0
    const L = (insn >>> 20) & 1
    if (dbl) { if (L) { f.u[sd * 2] = m.r32(a); f.u[sd * 2 + 1] = m.r32(a + 4) } else { m.w32(a, f.u[sd * 2]); m.w32(a + 4, f.u[sd * 2 + 1]) } }
    else if (L) f.u[sd] = m.r32(a); else m.w32(a, f.u[sd])
    return true
  }
  if (top === 0xc || top === 0xd) {
    if ((insn & 0x0fe00000) === 0x0c400000) { // vmov two core regs <-> double / two singles
      const op = (insn >>> 20) & 1
      if (dbl) { if (op) { c.r[Rt] = f.u[sm * 2]; c.r[Rn] = f.u[sm * 2 + 1] } else { f.u[sm * 2] = c.r[Rt]; f.u[sm * 2 + 1] = c.r[Rn] } }
      else if (op) { c.r[Rt] = f.u[sm]; c.r[Rn] = f.u[sm + 1] } else { f.u[sm] = c.r[Rt]; f.u[sm + 1] = c.r[Rn] }
      return true
    }
    // vldm / vstm / vpush / vpop
    const P = (insn >>> 24) & 1, U = (insn >>> 23) & 1, W = (insn >>> 21) & 1, L = (insn >>> 20) & 1
    const words = insn & 0xff
    let a = P && !U ? (c.r[Rn] - words * 4) >>> 0 : c.r[Rn]
    const start = dbl ? sd * 2 : sd
    for (let i = 0; i < words; i++) { if (L) f.u[start + i] = m.r32(a); else m.w32(a, f.u[start + i]); a += 4 }
    if (W) c.r[Rn] = (U ? c.r[Rn] + words * 4 : c.r[Rn] - words * 4) >>> 0
    return true
  }
  if (top !== 0xe) return false

  if ((insn >>> 4) & 1) {
    // transfers between core and vfp registers
    if ((insn & 0x0fff0fff) === 0x0ef10a10) { // vmrs rt, fpscr
      if (Rt === 15) { const v = f.fpscr; c.N = (v >>> 31) === 1; c.Z = ((v >>> 30) & 1) === 1; c.C = ((v >>> 29) & 1) === 1; c.V = ((v >>> 28) & 1) === 1 }
      else c.r[Rt] = f.fpscr
      return true
    }
    if ((insn & 0x0fff0fff) === 0x0ee10a10) { f.fpscr = c.r[Rt]; return true } // vmsr
    if ((insn & 0x0fe00f7f) === 0x0e000a10) { // vmov core <-> single
      if ((insn >>> 20) & 1) c.r[Rt] = f.u[sn]; else f.u[sn] = c.r[Rt]
      return true
    }
    if ((insn & 0x0f900f1f) === 0x0e000b10 || (insn & 0x0f900f1f) === 0x0e100b10) { // vmov core <-> scalar (32-bit lane)
      const dn = Vn | (N << 4), lane = (insn >>> 21) & 1
      if ((insn >>> 20) & 1) c.r[Rt] = f.u[dn * 2 + lane]; else f.u[dn * 2 + lane] = c.r[Rt]
      return true
    }
    if ((insn & 0x0f900f5f) === 0x0e800b10) { // vdup from core
      const q = (insn >>> 21) & 1, B = (insn >>> 22) & 1, E = (insn >>> 5) & 1
      const dn = Vn | (N << 4)
      const v = c.r[Rt]
      const n = q ? 4 : 2
      for (let i = 0; i < n; i++) {
        const w = B ? (v & 0xff) * 0x01010101 : E ? (v & 0xffff) * 0x10001 : v
        f.u[dn * 2 + i] = w >>> 0
      }
      return true
    }
    return false
  }

  const opc1 = ((insn >>> 20) & 0xb), opc3 = (insn >>> 6) & 1
  const a = get(sn), b = get(sm)
  const round = (v: number) => (dbl ? v : Math.fround(v))
  switch (opc1) {
    case 0x0: set(sd, round(get(sd) + (opc3 ? -(a * b) : a * b))); return true // vmla / vmls
    case 0x1: set(sd, round(-get(sd) + (opc3 ? a * b : -(a * b)))); return true // vnmls / vnmla
    case 0x2: set(sd, round(opc3 ? -(a * b) : a * b)); return true // vmul / vnmul
    case 0x3: set(sd, round(opc3 ? a - b : a + b)); return true // vadd / vsub
    case 0x8: set(sd, round(a / b)); return true // vdiv
    case 0xa: case 0x9: { // vfma / vfms (vfpv4)
      set(sd, round(get(sd) + ((insn >>> 6) & 1 ? -a * b : a * b)))
      return true
    }
  }
  if (opc1 !== 0xb) return false
  const opc2 = (insn >>> 16) & 0xf
  if (!opc3) { // vmov immediate: VFPExpandImm as a float32 bit pattern
    const imm8 = ((insn >>> 12) & 0xf0) | (insn & 0xf)
    const b6 = (imm8 >>> 6) & 1
    const bits = ((imm8 >>> 7) << 31) | ((b6 ^ 1) << 30) | ((b6 ? 0x1f : 0) << 25) | (((imm8 >>> 4) & 3) << 23) | ((imm8 & 0xf) << 19)
    const tmp = new Float32Array(new Uint32Array([bits >>> 0]).buffer)
    set(sd, tmp[0])
    return true
  }
  const op7 = (insn >>> 7) & 1
  switch (opc2) {
    case 0x0: set(sd, op7 ? Math.abs(b) : b); return true // vmov / vabs
    case 0x1: set(sd, op7 ? round(Math.sqrt(b)) : -b); return true // vneg / vsqrt
    case 0x4: case 0x5: { // vcmp / vcmpe (with zero when opc2 = 5)
      const x = get(sd), y = opc2 === 5 ? 0 : b
      f.fpscr = (f.fpscr & 0x0fffffff) | (isNaN(x) || isNaN(y) ? NZCV(c, false, false, true, true) : x === y ? NZCV(c, false, true, true, false) : x < y ? NZCV(c, true, false, false, false) : NZCV(c, false, false, true, false))
      return true
    }
    case 0x7: { // vcvt f32 <-> f64
      if (dbl) { const ds = (Vd << 1) | D; f.s[ds] = Math.fround(f.d[sm]) } else { const dd = Vd | (D << 4); f.d[dd] = f.s[sm] }
      return true
    }
    case 0x8: { // vcvt to float from int (s or u)
      const src = (Vm << 1) | M
      const signed = op7
      const v = signed ? f.u[src] | 0 : f.u[src]
      set(sd, round(v))
      return true
    }
    case 0xc: case 0xd: { // vcvt to int (round toward zero)
      const v = get(sm)
      const dst = (Vd << 1) | D
      const t = isNaN(v) ? 0 : Math.trunc(v)
      f.u[dst] = opc2 === 0xd ? (Math.max(-2147483648, Math.min(2147483647, t)) | 0) >>> 0 : Math.max(0, Math.min(4294967295, t)) >>> 0
      return true
    }
  }
  return false
}

// neon subset (arm encoding)
function neon(c: CPU, insn: number, pc: number): boolean {
  const f = c.fp, m = c.mem
  const D = (insn >>> 22) & 1, Vd = ((insn >>> 12) & 0xf) | (D << 4)
  if (((insn & 0xff100000) >>> 0) === 0xf4000000 || ((insn & 0xff100000) >>> 0) === 0xf4100000) { // vld1 / vst1 / vld2-4 multiple
    if ((insn >>> 23) & 1) { // vld1 / vst1 single lane, vld1 to all lanes
      const L1 = (insn >>> 21) & 1, Rn1 = (insn >>> 16) & 0xf, Rm1 = insn & 0xf
      const nsel = (insn >>> 8) & 3
      if (nsel !== 0 && ((insn >>> 10) & 3) !== 3) return false // vld2..4 lanes
      let bytes: number
      if (((insn >>> 10) & 3) === 3) { // all lanes
        const size = (insn >>> 6) & 3, T = (insn >>> 5) & 1
        bytes = 1 << size
        const a = c.r[Rn1]
        const v = bytes === 4 ? m.r32(a) : bytes === 2 ? m.r16(a) * 0x10001 : m.r8(a) * 0x01010101
        for (let r = 0; r <= T; r++) { f.u[(Vd + r) * 2] = v >>> 0; f.u[(Vd + r) * 2 + 1] = v >>> 0 }
      } else {
        const size = (insn >>> 10) & 3
        bytes = 1 << size
        const index = size === 0 ? (insn >>> 5) & 7 : size === 1 ? (insn >>> 6) & 3 : (insn >>> 7) & 1
        const off = Vd * 8 + index * bytes, a = c.r[Rn1]
        for (let k = 0; k < bytes; k++) { if (L1) f.b[off + k] = m.r8(a + k); else m.w8(a + k, f.b[off + k]) }
      }
      if (Rm1 === 13) c.r[Rn1] = (c.r[Rn1] + bytes) >>> 0
      else if (Rm1 !== 15) c.r[Rn1] = (c.r[Rn1] + c.r[Rm1]) >>> 0
      return true
    }
    const L = (insn >>> 21) & 1, Rn = (insn >>> 16) & 0xf, Rm = insn & 0xf, type = (insn >>> 8) & 0xf
    const regs = type === 7 ? 1 : type === 10 ? 2 : type === 6 ? 3 : type === 2 ? 4 : 0
    if (!regs) return false // interleaved vld2..4 not yet
    let a = c.r[Rn]
    for (let r = 0; r < regs; r++) for (let w = 0; w < 2; w++) {
      const idx = (Vd + r) * 2 + w
      if (L) f.u[idx] = m.r32(a); else m.w32(a, f.u[idx])
      a += 4
    }
    if (Rm === 13) c.r[Rn] = (c.r[Rn] + regs * 8) >>> 0
    else if (Rm !== 15) c.r[Rn] = (c.r[Rn] + c.r[Rm]) >>> 0
    void pc
    return true
  }
  if (((insn & 0xfeb80090) >>> 0) === 0xf2800010) { // vmov / vmvn / vorr / vbic immediate
    const Q = (insn >>> 6) & 1, op = (insn >>> 5) & 1, cmode = (insn >>> 8) & 0xf
    const imm8 = (((insn >>> 24) & 1) << 7) | (((insn >>> 16) & 7) << 4) | (insn & 0xf)
    let lo: number, hi: number
    if (cmode < 8) { const sh = (cmode >>> 1) * 8; lo = hi = (imm8 << sh) >>> 0 }
    else if (cmode < 12) { const sh = ((cmode >>> 1) & 1) * 8; lo = hi = (((imm8 << sh) & 0xffff) * 0x10001) >>> 0 }
    else if (cmode === 12) lo = hi = ((imm8 << 8) | 0xff) >>> 0
    else if (cmode === 13) lo = hi = ((imm8 << 16) | 0xffff) >>> 0
    else if (cmode === 14 && !op) lo = hi = (imm8 * 0x01010101) >>> 0
    else if (cmode === 14) { let x = 0n; for (let i = 0; i < 8; i++) if ((imm8 >>> i) & 1) x |= 0xffn << BigInt(i * 8); lo = Number(x & 0xffffffffn); hi = Number(x >> 32n) }
    else return false
    const inv = op && cmode !== 14
    const isOrr = (cmode & 1) && cmode < 12
    for (let r = 0; r <= Q; r++) {
      const i = (Vd + r) * 2
      if (isOrr) { if (op) { f.u[i] &= ~lo; f.u[i + 1] &= ~hi } else { f.u[i] |= lo; f.u[i + 1] |= hi } }
      else { f.u[i] = inv ? ~lo >>> 0 : lo; f.u[i + 1] = inv ? ~hi >>> 0 : hi }
    }
    return true
  }
  // vmovl (widen each lane, signed or unsigned)
  if (((insn & 0xfe870fd0) >>> 0) === 0xf2800a10 && ((insn >>> 19) & 7)) {
    const U = (insn >>> 24) & 1, imm3 = (insn >>> 19) & 7, M = (insn >>> 5) & 1, Vm = (insn & 0xf) | (M << 4)
    const from = imm3 === 1 ? 1 : imm3 === 2 ? 2 : 4
    const src = new DataView(f.buf, Vm * 8, 8), out = new DataView(new ArrayBuffer(16))
    for (let i = 0; i < 8 / from; i++) {
      const v = from === 1 ? (U ? src.getUint8(i) : src.getInt8(i)) : from === 2 ? (U ? src.getUint16(i * 2, true) : src.getInt16(i * 2, true)) : (U ? src.getUint32(i * 4, true) : src.getInt32(i * 4, true))
      if (from === 4) out.setBigInt64(i * 8, BigInt(v), true); else if (from === 2) out.setInt32(i * 4, v, true); else out.setInt16(i * 2, v, true)
    }
    f.b.set(new Uint8Array(out.buffer), Vd * 8)
    return true
  }
  // three registers, same length: vand vbic vorr vorn veor (bitwise) and integer vadd / vsub
  if (((insn & 0xfe800010) >>> 0) === 0xf2000010 || ((insn & 0xfe800010) >>> 0) === 0xf2000000) {
    const U = (insn >>> 24) & 1, A = (insn >>> 8) & 0xf, B = (insn >>> 4) & 1, Q = (insn >>> 6) & 1, size = (insn >>> 20) & 3
    const N = (insn >>> 7) & 1, M = (insn >>> 5) & 1
    const Vn = ((insn >>> 16) & 0xf) | (N << 4), Vm = (insn & 0xf) | (M << 4)
    const words = Q ? 4 : 2
    if (A === 1 && B === 1) {
      for (let i = 0; i < words; i++) {
        const x = f.u[Vn * 2 + i], y = f.u[Vm * 2 + i], dv = f.u[Vd * 2 + i]
        let r: number
        if (!U) r = [x & y, x & ~y, x | y, x | ~y][size]
        else r = [x ^ y, (dv & x) | (~dv & y), (x & dv) | (y & ~dv), (x & ~dv) | (y & dv)][size] // veor vbsl vbit vbif
        f.u[Vd * 2 + i] = r >>> 0
      }
      return true
    }
    if (A === 8 && B === 0) { // vadd / vsub integer
      const bytes = words * 4, lane = 1 << size
      const tmp = new Uint8Array(bytes)
      const av = f.b.subarray(Vn * 8, Vn * 8 + bytes), bv = f.b.subarray(Vm * 8, Vm * 8 + bytes)
      const dvA = new DataView(av.buffer, av.byteOffset), dvB = new DataView(bv.buffer, bv.byteOffset), out = new DataView(tmp.buffer)
      for (let o = 0; o < bytes; o += lane) {
        if (lane === 8) out.setBigUint64(o, U ? dvA.getBigUint64(o, true) - dvB.getBigUint64(o, true) : dvA.getBigUint64(o, true) + dvB.getBigUint64(o, true), true)
        else {
          const g = lane === 1 ? 'Uint8' : lane === 2 ? 'Uint16' : 'Uint32'
          const x = (dvA as any)['get' + g](o, true), y = (dvB as any)['get' + g](o, true)
          ;(out as any)['set' + g](o, U ? x - y : x + y, true)
        }
      }
      f.b.set(tmp, Vd * 8)
      return true
    }
  }
  return false
}
