// vfpv3 and a neon subset, shared by arm and thumb-2 (thumb instructions are converted to the arm form
// first). vfp: loads / stores, vmov forms, vmrs, arithmetic, compare, conversions, sqrt, abs, neg.
// neon: vld1 / vst1 (multiple registers), vmov / vmvn immediate, vdup, vorr / vand / veor / vbic,
// integer vadd / vsub. registers: s0..s31 alias d0..d15, d16..d31, q0..q15 = d pairs.
import type { CPU } from './cpu.ts'
import { execNeon } from './neon.ts'

export class FP {
  buf = new ArrayBuffer(256)
  s = new Float32Array(this.buf)
  d = new Float64Array(this.buf)
  u = new Uint32Array(this.buf)
  b = new Uint8Array(this.buf)
  // lane views for neon
  i8 = new Int8Array(this.buf)
  u16 = new Uint16Array(this.buf)
  i16 = new Int16Array(this.buf)
  i32 = new Int32Array(this.buf)
  i64 = new BigInt64Array(this.buf)
  u64 = new BigUint64Array(this.buf)
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
  if (insn >>> 28 === 0xf) return execNeon(c, insn)

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
    if ((insn & 0x0f000f1f) === 0x0e000b10 && !(((insn >>> 20) & 1) === 0 && (insn >>> 23) & 1)) { // vmov core <-> scalar (8, 16, 32-bit lanes)
      const dn = Vn | (N << 4), opc1 = (insn >>> 21) & 3, opc2 = (insn >>> 5) & 3, L = (insn >>> 20) & 1, Us = (insn >>> 23) & 1
      let es: number, idx: number
      if (opc1 & 2) { es = 1; idx = ((opc1 & 1) << 2) | opc2 } else if (opc2 & 1) { es = 2; idx = ((opc1 & 1) << 1) | (opc2 >>> 1) } else if (!(opc2 & 2)) { es = 4; idx = opc1 & 1 } else return false
      const off = dn * 8 + idx * es
      if (L) {
        const v = es === 1 ? f.b[off] : es === 2 ? f.b[off] | (f.b[off + 1] << 8) : f.u[off >>> 2]
        c.r[Rt] = (es === 4 || Us ? v : es === 1 ? (v << 24) >> 24 : (v << 16) >> 16) >>> 0
      } else if (es === 4) f.u[off >>> 2] = c.r[Rt]
      else { f.b[off] = c.r[Rt] & 0xff; if (es === 2) f.b[off + 1] = (c.r[Rt] >>> 8) & 0xff }
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
    // vmla and friends are not fused: the product is rounded first
    case 0x0: { const p = round(a * b); set(sd, round(get(sd) + (opc3 ? -p : p))); return true } // vmla / vmls
    case 0x1: { const p = round(a * b); set(sd, round(-get(sd) + (opc3 ? p : -p))); return true } // vnmls / vnmla
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
