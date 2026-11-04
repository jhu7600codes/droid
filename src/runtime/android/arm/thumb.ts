// thumb and thumb-2 (armv7-a) integer instructions: all 16-bit encodings, IT blocks, and the 32-bit
// load / store, data processing (immediate, plain immediate, shifted register, register), multiply,
// divide, branch and misc groups. most real ndk libraries are built as thumb-2.
import { thumbMul, thumbParallel, smlalxy, dualLong, sat16 } from './dsp.ts'
import type { CPU } from './cpu.ts'
import { execVfp } from './vfp.ts'

const ror = (v: number, n: number) => (n ? ((v >>> n) | (v << (32 - n))) >>> 0 : v >>> 0)

// ThumbExpandImm_C
function expandImm(imm12: number, carryIn: boolean): [number, boolean] {
  if ((imm12 >>> 10) === 0) {
    const b = imm12 & 0xff
    switch ((imm12 >>> 8) & 3) {
      case 0: return [b, carryIn]
      case 1: return [((b << 16) | b) >>> 0, carryIn]
      case 2: return [((b << 24) | (b << 8)) >>> 0, carryIn]
      default: return [((b << 24) | (b << 16) | (b << 8) | b) >>> 0, carryIn]
    }
  }
  const v = ror(0x80 | (imm12 & 0x7f), imm12 >>> 7)
  return [v, (v >>> 31) === 1]
}

export function execThumb(c: CPU, pc: number) {
  const m = c.mem
  const hw = m.r16(pc)
  // IT block: this instruction runs only if its condition holds
  let cond = 14
  const inIT = c.it !== 0
  if (inIT) {
    // ITSTATE: condition in bits 7:4, the low bits shift left after every instruction
    cond = c.it >>> 4
    c.it = (c.it & 7) === 0 ? 0 : (c.it & 0xe0) | ((c.it << 1) & 0x1f)
  }
  const is32 = (hw >>> 11) >= 0x1d
  const size = is32 ? 4 : 2
  c.r[15] = pc + size
  if (cond !== 14 && !c.cond(cond)) return
  if (is32) return exec32(c, pc, hw, m.r16(pc + 2))
  exec16(c, pc, hw, !inIT)
}

const PCV = (pc: number) => (pc + 4) >>> 0

function setNZ(c: CPU, v: number) { c.N = (v >>> 31) === 1; c.Z = (v >>> 0) === 0 }
function branchTo(c: CPU, addr: number) { c.r[15] = addr & ~1 }
function bxTo(c: CPU, addr: number) { c.thumb = (addr & 1) === 1; c.r[15] = addr & ~1 }
const rd16 = (c: CPU, n: number, pc: number) => (n === 15 ? PCV(pc) : c.r[n])

function exec16(c: CPU, pc: number, hw: number, setFlags: boolean) {
  const m = c.mem
  const top = hw >>> 11
  const lo3 = (x: number) => x & 7
  switch (top) {
    case 0x00: case 0x01: case 0x02: { // lsl lsr asr #imm
      const imm = (hw >>> 6) & 0x1f, rm = lo3(hw >>> 3), rd = lo3(hw)
      const [v, cy] = c.shift(c.r[rm], top, imm, c.C, false)
      c.r[rd] = v
      if (setFlags) { setNZ(c, v); c.C = cy }
      return
    }
    case 0x03: { // add / sub register or imm3
      const rd = lo3(hw), rn = lo3(hw >>> 3), x = (hw >>> 6) & 7
      const b = (hw >>> 10) & 1 ? x : c.r[x]
      const sub = (hw >>> 9) & 1
      const a = c.r[rn]
      c.r[rd] = setFlags ? (sub ? c.addFlags(a, ~b >>> 0, 1) : c.addFlags(a, b, 0)) : (sub ? a - b : a + b) >>> 0
      return
    }
    case 0x04: { const rd = lo3(hw >>> 8); c.r[rd] = hw & 0xff; if (setFlags) setNZ(c, c.r[rd]); return } // movs
    case 0x05: c.addFlags(c.r[lo3(hw >>> 8)], ~(hw & 0xff) >>> 0, 1); return // cmp
    case 0x06: { const rd = lo3(hw >>> 8); c.r[rd] = setFlags ? c.addFlags(c.r[rd], hw & 0xff, 0) : (c.r[rd] + (hw & 0xff)) >>> 0; return }
    case 0x07: { const rd = lo3(hw >>> 8); c.r[rd] = setFlags ? c.addFlags(c.r[rd], ~(hw & 0xff) >>> 0, 1) : (c.r[rd] - (hw & 0xff)) >>> 0; return }
    case 0x08: {
      if ((hw >>> 10) === 0x10) { // data processing
        const op = (hw >>> 6) & 0xf, rm = lo3(hw >>> 3), rdn = lo3(hw)
        const a = c.r[rdn], b = c.r[rm]
        let r = 0, cy = c.C
        switch (op) {
          case 0x0: r = a & b; break
          case 0x1: r = a ^ b; break
          case 0x2: [r, cy] = c.shift(a, 0, b, c.C, true); break
          case 0x3: [r, cy] = c.shift(a, 1, b, c.C, true); break
          case 0x4: [r, cy] = c.shift(a, 2, b, c.C, true); break
          case 0x5: c.r[rdn] = setFlags ? c.addFlags(a, b, c.C ? 1 : 0) : (a + b + (c.C ? 1 : 0)) >>> 0; return
          case 0x6: c.r[rdn] = setFlags ? c.addFlags(a, ~b >>> 0, c.C ? 1 : 0) : (a - b - (c.C ? 0 : 1)) >>> 0; return
          case 0x7: [r, cy] = c.shift(a, 3, b, c.C, true); break
          case 0x8: setNZ(c, (a & b) >>> 0); return // tst
          case 0x9: c.r[rdn] = setFlags ? c.addFlags(0, ~b >>> 0, 1) : (-b) >>> 0; return // rsbs #0
          case 0xa: c.addFlags(a, ~b >>> 0, 1); return // cmp
          case 0xb: c.addFlags(a, b, 0); return // cmn
          case 0xc: r = a | b; break
          case 0xd: r = Math.imul(a, b); break
          case 0xe: r = a & ~b; break
          default: r = ~b
        }
        c.r[rdn] = r >>> 0
        if (setFlags) { setNZ(c, r); if (op <= 7 || op === 0xe || op === 0xf || op === 0xc) c.C = cy }
        return
      }
      if ((hw >>> 10) === 0x11) { // special data, bx / blx
        const op = (hw >>> 8) & 3, rm = (hw >>> 3) & 0xf, rdn = (hw & 7) | ((hw >>> 4) & 8)
        if (op === 0) { const v = (rd16(c, rdn, pc) + rd16(c, rm, pc)) >>> 0; if (rdn === 15) branchTo(c, v); else c.r[rdn] = v; return }
        if (op === 1) { c.addFlags(rd16(c, rdn, pc), ~rd16(c, rm, pc) >>> 0, 1); return }
        if (op === 2) { const v = rd16(c, rm, pc); if (rdn === 15) branchTo(c, v); else c.r[rdn] = v; return }
        const t = rd16(c, rm, pc)
        if ((hw >>> 7) & 1) c.r[14] = (pc + 2) | 1
        bxTo(c, t)
        return
      }
      throw new Error(`arm: thumb instruction 0x${hw.toString(16)} not supported`)
    }
    case 0x09: c.r[lo3(hw >>> 8)] = m.r32(((PCV(pc) & ~3) + (hw & 0xff) * 4) >>> 0); return // ldr literal
    case 0x0a: case 0x0b: { // load / store register offset
      const op = (hw >>> 9) & 7, rm = lo3(hw >>> 6), rn = lo3(hw >>> 3), rt = lo3(hw)
      const a = (c.r[rn] + c.r[rm]) >>> 0
      switch (op) {
        case 0: m.w32(a, c.r[rt]); break
        case 1: m.w16(a, c.r[rt]); break
        case 2: m.w8(a, c.r[rt]); break
        case 3: c.r[rt] = ((m.r8(a) << 24) >> 24) >>> 0; break
        case 4: c.r[rt] = m.r32(a); break
        case 5: c.r[rt] = m.r16(a); break
        case 6: c.r[rt] = m.r8(a); break
        default: c.r[rt] = ((m.r16(a) << 16) >> 16) >>> 0
      }
      return
    }
    case 0x0c: case 0x0d: case 0x0e: case 0x0f: case 0x10: case 0x11: { // ldr / str immediate (word, byte, half)
      const imm = (hw >>> 6) & 0x1f, rn = lo3(hw >>> 3), rt = lo3(hw), load = (hw >>> 11) & 1
      const kind = top <= 0x0d ? 4 : top <= 0x0f ? 1 : 2
      const a = (c.r[rn] + imm * kind) >>> 0
      if (load) c.r[rt] = kind === 4 ? m.r32(a) : kind === 2 ? m.r16(a) : m.r8(a)
      else if (kind === 4) m.w32(a, c.r[rt]); else if (kind === 2) m.w16(a, c.r[rt]); else m.w8(a, c.r[rt])
      return
    }
    case 0x12: case 0x13: { // ldr / str sp-relative
      const rt = lo3(hw >>> 8), a = (c.r[13] + (hw & 0xff) * 4) >>> 0
      if ((hw >>> 11) & 1) c.r[rt] = m.r32(a); else m.w32(a, c.r[rt])
      return
    }
    case 0x14: c.r[lo3(hw >>> 8)] = ((PCV(pc) & ~3) + (hw & 0xff) * 4) >>> 0; return // adr
    case 0x15: c.r[lo3(hw >>> 8)] = (c.r[13] + (hw & 0xff) * 4) >>> 0; return // add rd, sp, #imm
    case 0x16: case 0x17: return misc16(c, pc, hw)
    case 0x18: case 0x19: { // stm / ldm (increment after, writeback)
      const rn = lo3(hw >>> 8), list = hw & 0xff, load = (hw >>> 11) & 1
      let a = c.r[rn]
      for (let i = 0; i < 8; i++) if (list & (1 << i)) { if (load) c.r[i] = m.r32(a); else m.w32(a, c.r[i]); a += 4 }
      if (!load || !(list & (1 << rn))) c.r[rn] = a >>> 0
      return
    }
    case 0x1a: case 0x1b: { // b<cond>, svc, udf
      const cnd = (hw >>> 8) & 0xf
      if (cnd === 0xf) { c.svc(); return }
      if (cnd === 0xe) throw new Error(`arm: udf at 0x${pc.toString(16)}`)
      if (c.cond(cnd)) branchTo(c, PCV(pc) + (((hw & 0xff) << 24) >> 23))
      return
    }
    case 0x1c: branchTo(c, PCV(pc) + (((hw & 0x7ff) << 21) >> 20)); return // b
  }
  throw new Error(`arm: thumb instruction 0x${hw.toString(16)} at 0x${pc.toString(16)} not supported`)
}

function misc16(c: CPU, pc: number, hw: number) {
  const m = c.mem
  const op = (hw >>> 5) & 0x7f
  if ((op & 0x7c) === 0x00) { c.r[13] = (c.r[13] + (hw & 0x7f) * 4) >>> 0; return } // add sp
  if ((op & 0x7c) === 0x04) { c.r[13] = (c.r[13] - (hw & 0x7f) * 4) >>> 0; return } // sub sp
  if ((hw & 0xf500) === 0xb100) { // cbz / cbnz
    const rn = hw & 7, off = (((hw >>> 9) & 1) << 6) | (((hw >>> 3) & 0x1f) << 1)
    const nz = (hw >>> 11) & 1
    if ((c.r[rn] === 0) !== !!nz) branchTo(c, PCV(pc) + off)
    return
  }
  if ((hw & 0xff00) === 0xb200) { // sxth sxtb uxth uxtb
    const rm = (hw >>> 3) & 7, rd = hw & 7, v = c.r[rm]
    c.r[rd] = [((v << 16) >> 16) >>> 0, ((v << 24) >> 24) >>> 0, v & 0xffff, v & 0xff][(hw >>> 6) & 3]
    return
  }
  if ((hw & 0xfe00) === 0xb400) { // push
    const list = (hw & 0xff) | ((hw & 0x100) << 6)
    let n = 0
    for (let i = 0; i < 16; i++) if (list & (1 << i)) n++
    let a = (c.r[13] - n * 4) >>> 0
    c.r[13] = a
    for (let i = 0; i < 16; i++) if (list & (1 << i)) { m.w32(a, c.r[i]); a += 4 }
    return
  }
  if ((hw & 0xfe00) === 0xbc00) { // pop
    const list = (hw & 0xff) | ((hw & 0x100) << 7)
    let a = c.r[13]
    for (let i = 0; i < 16; i++) if (list & (1 << i)) { const v = m.r32(a); a += 4; if (i === 15) bxTo(c, v); else c.r[i] = v }
    c.r[13] = a >>> 0
    return
  }
  if ((hw & 0xffc0) === 0xba00 || (hw & 0xffc0) === 0xba40 || (hw & 0xffc0) === 0xbac0) { // rev rev16 revsh
    const rm = (hw >>> 3) & 7, rd = hw & 7, v = c.r[rm], k = (hw >>> 6) & 3
    if (k === 0) c.r[rd] = (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0
    else if (k === 1) c.r[rd] = (((v & 0xff) << 8) | ((v >>> 8) & 0xff) | ((v & 0xff0000) << 8) | ((v >>> 8) & 0xff0000)) >>> 0
    else c.r[rd] = ((((v & 0xff) << 24) >> 16) | ((v >>> 8) & 0xff)) >>> 0
    return
  }
  if ((hw & 0xff00) === 0xbf00) { // it and hints
    if (hw & 0xf) c.it = hw & 0xff
    return
  }
  if ((hw & 0xff00) === 0xbe00) throw new Error('arm: bkpt in native code')
  if ((hw & 0xffe8) === 0xb660) return // cps
  throw new Error(`arm: thumb misc 0x${hw.toString(16)} not supported`)
}

// thumb vfp / neon -> arm encoding, then the shared decoder
function coproc(c: CPU, pc: number, h1: number, h2: number) {
  let arm: number
  if ((h1 & 0xff10) === 0xf900) arm = (0xf4000000 | ((h1 & 0xff) << 16) | h2) >>> 0 // neon load / store
  else if ((h1 & 0xef00) === 0xef00) arm = (0xf2000000 | (((h1 >>> 12) & 1) << 24) | ((h1 & 0xff) << 16) | h2) >>> 0 // neon data
  else arm = (0xe0000000 | ((h1 & 0x0fff) << 16) | h2) >>> 0 // vfp
  if (!execVfp(c, arm, pc, true)) throw new Error(`arm: vfp / neon instruction 0x${h1.toString(16)}${h2.toString(16).padStart(4, '0')} at 0x${pc.toString(16)} not supported yet`)
}

function exec32(c: CPU, pc: number, h1: number, h2: number) {
  const m = c.mem
  if (h1 === 0xee1d && (h2 & 0x0fff) === 0x0f70) { c.r[h2 >>> 12] = c.tls; return } // mrc p15 c13: the tls pointer
  if (h1 === 0xee07 && (h2 & 0x0f10) === 0x0f10) return // mcr p15 c7: cache maintenance, armv6 barriers
  if ((h1 & 0xec00) === 0xec00 || (h1 & 0xff10) === 0xf900) return coproc(c, pc, h1, h2)
  const op1 = (h1 >>> 11) & 3, op2 = (h1 >>> 4) & 0x7f, op = (h2 >>> 15) & 1
  const rn = h1 & 0xf, rd = (h2 >>> 8) & 0xf, rt = (h2 >>> 12) & 0xf
  const R = (n: number) => (n === 15 ? PCV(pc) : c.r[n])

  if (op1 === 1) {
    if ((op2 & 0x64) === 0x00) { // load / store multiple
      const opc = (h1 >>> 7) & 3, w = (h1 >>> 5) & 1, load = (h1 >>> 4) & 1, list = h2
      let n = 0
      for (let i = 0; i < 16; i++) if (list & (1 << i)) n++
      const base = c.r[rn]
      let a = opc === 1 ? base : (base - n * 4) >>> 0 // ia : db
      for (let i = 0; i < 16; i++) if (list & (1 << i)) {
        if (load) { const v = m.r32(a); if (i === 15) bxTo(c, v); else c.r[i] = v } else m.w32(a, c.r[i])
        a += 4
      }
      if (w && !(load && list & (1 << rn))) c.r[rn] = (opc === 1 ? base + n * 4 : base - n * 4) >>> 0
      return
    }
    if ((op2 & 0x64) === 0x04) { // dual, exclusive, table branch
      const p = (h1 >>> 8) & 1, u = (h1 >>> 7) & 1, w = (h1 >>> 5) & 1, load = (h1 >>> 4) & 1
      if ((h1 & 0xfff0) === 0xe8d0 && (h2 & 0xffe0) === 0xf000) { // tbb / tbh
        const rm = h2 & 0xf, half = (h2 >>> 4) & 1
        const off = half ? m.r16((R(rn) + c.r[rm] * 2) >>> 0) : m.r8((R(rn) + c.r[rm]) >>> 0)
        branchTo(c, PCV(pc) + off * 2)
        return
      }
      if ((h1 & 0xffe0) === 0xe840) { // ldrex / strex
        const a = (c.r[rn] + (h2 & 0xff) * 4) >>> 0
        if (load) { c.excl = a; c.r[rt] = m.r32(a) }
        else if (c.excl !== a) c.r[rd] = 1
        else { m.w32(a, c.r[rt]); c.r[rd] = 0; c.excl = -1 }
        return
      }
      if ((h1 & 0xfff0) === 0xe8c0 || (h1 & 0xfff0) === 0xe8d0) { // ldrexb/h, strexb/h, ldrexd
        const k = (h2 >>> 4) & 0xf, a = c.r[rn]
        if (load) { c.excl = a; c.r[rt] = k === 4 ? m.r8(a) : k === 5 ? m.r16(a) : m.r32(a); if (k === 7) c.r[rd] = m.r32(a + 4) }
        else if (c.excl !== a) c.r[h2 & 0xf] = 1
        else { if (k === 4) m.w8(a, c.r[rt]); else if (k === 5) m.w16(a, c.r[rt]); else m.w32(a, c.r[rt]); if (k === 7) m.w32(a + 4, c.r[rd]); c.r[h2 & 0xf] = 0; c.excl = -1 }
        return
      }
      const imm = (h2 & 0xff) * 4
      const base = rn === 15 ? PCV(pc) & ~3 : c.r[rn]
      const off = (u ? base + imm : base - imm) >>> 0
      const a = p ? off : base
      if (load) { c.r[rt] = m.r32(a); c.r[rd] = m.r32(a + 4) } else { m.w32(a, c.r[rt]); m.w32(a + 4, c.r[rd]) }
      if (w) c.r[rn] = off
      return
    }
    if ((op2 & 0x60) === 0x20) { // data processing, shifted register
      const opc = (h1 >>> 5) & 0xf, s = (h1 >>> 4) & 1, rm = h2 & 0xf
      const imm = ((h2 >>> 10) & 0x1c) | ((h2 >>> 6) & 3), type = (h2 >>> 4) & 3
      const [b, cy] = c.shift(c.r[rm], type, imm, c.C, false)
      if (opc === 6) { c.r[rd] = type === 2 ? ((c.r[rn] & 0xffff0000) | (b & 0xffff)) >>> 0 : ((c.r[rn] & 0xffff) | (b & 0xffff0000)) >>> 0; return } // pkhtb / pkhbt
      return dp(c, opc, s, rn, rd, b, cy, R)
    }
    throw new Error(`arm: coprocessor / vfp instruction 0x${h1.toString(16)}${h2.toString(16).padStart(4, '0')} at 0x${pc.toString(16)} not supported yet`)
  }

  if (op1 === 2) {
    if (!op) {
      const i = (h1 >>> 10) & 1, imm3 = (h2 >>> 12) & 7, imm8 = h2 & 0xff
      if (!((h1 >>> 9) & 1)) { // modified immediate
        const [b, cy] = expandImm((i << 11) | (imm3 << 8) | imm8, c.C)
        return dp(c, (h1 >>> 5) & 0xf, (h1 >>> 4) & 1, rn, rd, b, cy, R)
      }
      // plain binary immediate
      const imm12 = (i << 11) | (imm3 << 8) | imm8
      switch ((h1 >>> 4) & 0x1f) {
        case 0x00: c.r[rd] = ((rn === 15 ? PCV(pc) & ~3 : c.r[rn]) + imm12) >>> 0; return // addw / adr
        case 0x0a: c.r[rd] = ((rn === 15 ? PCV(pc) & ~3 : c.r[rn]) - imm12) >>> 0; return // subw / adr
        case 0x04: c.r[rd] = (rn << 12) | imm12; return // movw
        case 0x0c: c.r[rd] = ((((rn << 12) | imm12) << 16) | (c.r[rd] & 0xffff)) >>> 0; return // movt
        case 0x14: case 0x1c: { // sbfx / ubfx
          const lsb = (imm3 << 2) | ((h2 >>> 6) & 3), width = (h2 & 0x1f) + 1
          const v = c.r[rn] >>> lsb
          c.r[rd] = (h1 >>> 4) & 8 ? (width === 32 ? v : v & ((1 << width) - 1)) >>> 0 : (((v << (32 - width)) >> (32 - width)) >>> 0)
          return
        }
        case 0x16: { // bfi / bfc
          const lsb = (imm3 << 2) | ((h2 >>> 6) & 3), msb = h2 & 0x1f
          const w = msb - lsb + 1
          const mask = ((w === 32 ? 0xffffffff : (1 << w) - 1) << lsb) >>> 0
          const src = rn === 15 ? 0 : c.r[rn] << lsb
          c.r[rd] = ((c.r[rd] & ~mask) | (src & mask)) >>> 0
          return
        }
        case 0x10: case 0x12: case 0x18: case 0x1a: { // ssat / usat, with an lsl / asr of the input first
          const sat = (h2 & 0x1f) + ((h1 >>> 7) & 1 ? 0 : 1)
          const shAmt = (imm3 << 2) | ((h2 >>> 6) & 3)
          if ((h1 >>> 5) & 1 && shAmt === 0) { c.r[rd] = sat16(c, c.r[rn], (h2 & 0xf) + ((h1 >>> 7) & 1 ? 0 : 1), ((h1 >>> 7) & 1) === 1); return } // ssat16 / usat16
          let v = c.r[rn] | 0
          if ((h1 >>> 5) & 1) v >>= shAmt; else v <<= shAmt
          if ((h1 >>> 7) & 1) c.r[rd] = Math.max(0, Math.min((2 ** (h2 & 0x1f)) - 1, v)) >>> 0
          else { const mx = 2 ** (sat - 1) - 1; c.r[rd] = Math.max(-mx - 1, Math.min(mx, v)) >>> 0 }
          return
        }
      }
      throw new Error(`arm: thumb-2 immediate op 0x${h1.toString(16)}`)
    }
    // branches and misc control
    const op1b = (h2 >>> 12) & 7
    const S = (h1 >>> 10) & 1, J1 = (h2 >>> 13) & 1, J2 = (h2 >>> 11) & 1
    if ((op1b & 5) === 0) {
      if ((h1 & 0x0380) !== 0x0380) { // b<cond>.w
        const off = (S ? -1 << 20 : 0) | (J2 << 19) | (J1 << 18) | ((h1 & 0x3f) << 12) | ((h2 & 0x7ff) << 1)
        if (c.cond((h1 >>> 6) & 0xf)) branchTo(c, PCV(pc) + off)
        return
      }
      return // msr, mrs, hints, barriers: nothing to do here
    }
    const I1 = ~(J1 ^ S) & 1, I2 = ~(J2 ^ S) & 1
    const off = (S ? -1 << 24 : 0) | (I1 << 23) | (I2 << 22) | ((h1 & 0x3ff) << 12) | ((h2 & 0x7ff) << 1)
    if (op1b & 4) c.r[14] = (pc + 4) | 1 // bl / blx
    if ((op1b & 5) === 4) { c.thumb = false; c.r[15] = ((PCV(pc) & ~3) + off) >>> 0; return } // blx: to arm
    branchTo(c, PCV(pc) + off)
    return
  }

  // op1 === 3
  if ((op2 & 0x71) === 0x00 || (op2 & 0x67) === 0x01 || (op2 & 0x67) === 0x03 || (op2 & 0x67) === 0x05) return loadStore32(c, pc, h1, h2)
  if ((op2 & 0x70) === 0x20) return dpReg(c, h1, h2)
  if ((op2 & 0x78) === 0x30) { // multiply, mla, mls
    const rm = h2 & 0xf, ra = rt, k = (h2 >>> 4) & 3
    const p = Math.imul(c.r[rn], c.r[rm])
    if (((h1 >>> 4) & 7) !== 0) { if (thumbMul(c, h1, h2)) return; throw new Error(`arm: thumb-2 multiply 0x${h1.toString(16)} 0x${h2.toString(16)}`) }
    c.r[rd] = k === 1 ? (c.r[ra] - p) >>> 0 : ra === 15 ? p >>> 0 : (c.r[ra] + p) >>> 0
    return
  }
  if ((op2 & 0x78) === 0x38) { // long multiply, divide
    const rm = h2 & 0xf, k = (h1 >>> 4) & 7, rdlo = rt, rdhi = rd
    if (k === 1 || k === 3) { const n = c.r[rn], d = c.r[rm]; c.r[rdhi] = d === 0 ? 0 : k === 3 ? Math.floor(n / d) >>> 0 : (((n | 0) / (d | 0)) | 0) >>> 0; return } // sdiv udiv
    const op = (h2 >>> 4) & 0xf
    if (k === 4 && (op & 0xc) === 0x8) { const [lo, hi] = smlalxy(c.r[rn], c.r[rm], (op >>> 1) & 1, op & 1, c.r[rdlo], c.r[rdhi]); c.r[rdlo] = lo; c.r[rdhi] = hi; return } // smlalxy
    if ((k === 4 || k === 5) && (op & 0xe) === 0xc) { const [lo, hi] = dualLong(c.r[rn], c.r[rm], op & 1, k === 5, c.r[rdlo], c.r[rdhi]); c.r[rdlo] = lo; c.r[rdhi] = hi; return } // smlald / smlsld
    if (k === 6 && op === 6) { const u = BigInt(c.r[rn]) * BigInt(c.r[rm]) + BigInt(c.r[rdlo]) + BigInt(c.r[rdhi]); c.r[rdlo] = Number(u & 0xffffffffn); c.r[rdhi] = Number((u >> 32n) & 0xffffffffn); return } // umaal
    if (op !== 0) throw new Error(`arm: thumb-2 long multiply 0x${h1.toString(16)} 0x${h2.toString(16)}`)
    const signed = k === 0 || k === 4
    let res = signed ? BigInt(c.r[rn] | 0) * BigInt(c.r[rm] | 0) : BigInt(c.r[rn]) * BigInt(c.r[rm])
    if (k >= 4) res += (BigInt(c.r[rdhi]) << 32n) | BigInt(c.r[rdlo])
    const u = BigInt.asUintN(64, res)
    c.r[rdlo] = Number(u & 0xffffffffn)
    c.r[rdhi] = Number(u >> 32n)
    return
  }
  throw new Error(`arm: coprocessor / vfp instruction 0x${h1.toString(16)}${h2.toString(16).padStart(4, '0')} at 0x${pc.toString(16)} not supported yet`)
}

function dp(c: CPU, opc: number, s: number, rn: number, rd: number, b: number, cy: boolean, R: (n: number) => number) {
  const a = rn === 15 ? 0 : R(rn)
  let r: number
  const logic = (v: number) => { r = v >>> 0; if (s) { setNZ(c, r); c.C = cy } }
  switch (opc) {
    case 0x0: logic(a & b); if (rd === 15) return; break // and / tst
    case 0x1: logic(a & ~b); break
    case 0x2: logic(rn === 15 ? b : a | b); break // orr / mov
    case 0x3: logic(rn === 15 ? ~b : a | ~b); break // orn / mvn
    case 0x4: logic(a ^ b); if (rd === 15) return; break // eor / teq
    case 0x8: r = s ? c.addFlags(a, b, 0) : (a + b) >>> 0; if (rd === 15) return; break // add / cmn
    case 0xa: r = s ? c.addFlags(a, b, c.C ? 1 : 0) : (a + b + (c.C ? 1 : 0)) >>> 0; break
    case 0xb: r = s ? c.addFlags(a, ~b >>> 0, c.C ? 1 : 0) : (a - b - (c.C ? 0 : 1)) >>> 0; break
    case 0xd: r = s ? c.addFlags(a, ~b >>> 0, 1) : (a - b) >>> 0; if (rd === 15) return; break // sub / cmp
    case 0xe: r = s ? c.addFlags(b, ~a >>> 0, 1) : (b - a) >>> 0; break // rsb
    default: throw new Error(`arm: thumb-2 data op ${opc}`)
  }
  if (rd === 13 || rd !== 15) c.r[rd] = r!
}

function dpReg(c: CPU, h1: number, h2: number) {
  const rn = h1 & 0xf, rd = (h2 >>> 8) & 0xf, rm = h2 & 0xf
  const op1 = (h1 >>> 4) & 0xf, op2 = (h2 >>> 4) & 0xf
  if ((op1 & 8) === 0 && op2 === 0) { // lsl lsr asr ror by register
    const [v, cy] = c.shift(c.r[rn], (op1 >>> 1) & 3, c.r[rm], c.C, true)
    c.r[rd] = v
    if (op1 & 1) { setNZ(c, v); c.C = cy }
    return
  }
  if ((op1 & 8) === 0 && (op2 & 8)) { // extend (+ add)
    const rot = ((h2 >>> 4) & 3) * 8
    const v = ror(c.r[rm], rot)
    const x = [((v << 16) >> 16) >>> 0, v & 0xffff, 0, 0, ((v << 24) >> 24) >>> 0, v & 0xff][op1 >>> 0 & 7]
    c.r[rd] = ((rn === 15 ? 0 : c.r[rn]) + x) >>> 0
    return
  }
  if (op1 === 9 || op1 === 0xb) { // rev, rev16, rbit, revsh, clz
    const v = c.r[rm]
    if (op1 === 0xb) { c.r[rd] = Math.clz32(v); return }
    if (op2 === 8) c.r[rd] = (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0
    else if (op2 === 9) c.r[rd] = (((v & 0xff) << 8) | ((v >>> 8) & 0xff) | ((v & 0xff0000) << 8) | ((v >>> 8) & 0xff0000)) >>> 0
    else if (op2 === 0xa) { let o = 0, x = v; for (let i = 0; i < 32; i++) { o = (o << 1) | (x & 1); x >>>= 1 } c.r[rd] = o >>> 0 }
    else c.r[rd] = ((((v & 0xff) << 24) >> 16) | ((v >>> 8) & 0xff)) >>> 0
    return
  }
  if ((op1 & 8) && thumbParallel(c, h1, h2)) return
  throw new Error(`arm: thumb-2 register op 0x${h1.toString(16)} 0x${h2.toString(16)}`)
}

function loadStore32(c: CPU, pc: number, h1: number, h2: number) {
  const m = c.mem
  const rn = h1 & 0xf, rt = (h2 >>> 12) & 0xf
  const load = (h1 >>> 4) & 1, size = (h1 >>> 5) & 3, signed = (h1 >>> 8) & 1
  let addr: number, wb: number | null = null
  if (rn === 15) { // literal
    const imm = h2 & 0xfff
    addr = (((PCV(pc) & ~3) + ((h1 >>> 7) & 1 ? imm : -imm)) >>> 0)
  } else if ((h1 >>> 7) & 1) addr = (c.r[rn] + (h2 & 0xfff)) >>> 0 // imm12
  else if ((h2 & 0x0fc0) === 0) addr = (c.r[rn] + (c.r[h2 & 0xf] << ((h2 >>> 4) & 3))) >>> 0 // register
  else { // imm8 with p / u / w
    const p = (h2 >>> 10) & 1, u = (h2 >>> 9) & 1, w = (h2 >>> 8) & 1, imm = h2 & 0xff
    const off = (u ? c.r[rn] + imm : c.r[rn] - imm) >>> 0
    addr = p ? off : c.r[rn]
    if (w || !p) wb = off
  }
  if (load) {
    if (rt === 15 && size !== 2) return // pld / pli hints
    let v: number
    if (size === 0) v = signed ? ((m.r8(addr) << 24) >> 24) >>> 0 : m.r8(addr)
    else if (size === 1) v = signed ? ((m.r16(addr) << 16) >> 16) >>> 0 : m.r16(addr)
    else v = m.r32(addr)
    if (wb !== null) c.r[rn] = wb
    if (rt === 15) bxTo(c, v); else c.r[rt] = v
  } else {
    if (size === 0) m.w8(addr, c.r[rt]); else if (size === 1) m.w16(addr, c.r[rt]); else m.w32(addr, c.r[rt])
    if (wb !== null) c.r[rn] = wb
  }
}
