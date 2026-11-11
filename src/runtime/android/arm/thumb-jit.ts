// a block compiler for thumb / thumb-2 code (most ndk libraries, unity's included, are built as
// thumb-2). the common 16-bit instructions and the 32-bit calls / branches / word loads and stores
// get straight-line javascript; every other instruction calls the thumb interpreter for that one
// instruction, so behaviour never depends on what is specialised here. instructions inside an IT
// block always go through the interpreter (it keeps the IT state).
import { MemFault, type CPU } from './cpu.ts'
import { execThumb } from './thumb.ts'

const MAX = 120
const LOOPS = 4000
const COND = ['Z', '!Z', 'C', '!C', 'N', '!N', 'V', '!V', '(C && !Z)', '(!C || Z)', '(N === V)', '(N !== V)', '(!Z && N === V)', '(Z || N !== V)']

type Fn = (c: CPU, r: Uint32Array, dv: DataView) => number
export interface TBlock { fn: Fn; n: number; start: number; end: number }

const nz = (v: string) => `N = (${v} >>> 31) === 1; Z = (${v} >>> 0) === 0;`
// adds / subs with all four flags (a, b are js expressions of unsigned 32-bit values)
const addFlags = (d: string, a: string, b: string) => `s = ${a}; t = ${b}; v = s + t; ${d} = v >>> 0; C = v > 0xffffffff; V = ((~(s ^ t) & (s ^ v)) & 0x80000000) !== 0; ${nz('(v >>> 0)')}`
const subFlags = (d: string | null, a: string, b: string) => `s = ${a}; t = ${b}; v = (s - t) >>> 0; ${d ? `${d} = v;` : ''} C = s >= t; V = (((s ^ t) & (s ^ v)) & 0x80000000) !== 0; ${nz('v')}`

export function compileThumb(c: CPU, start: number): TBlock | null {
  const m = c.mem, dv = m.dv
  const out: string[] = []
  let pc = start, n = 0, itLeft = 0
  const R = (k: number, at: number) => (k === 15 ? String((at + 4) >>> 0) : `r[${k}]`)
  // one instruction through the interpreter; leaves the block if it moved pc or left thumb mode
  const generic = (at: number, size: number) => `ip = ${at}; c.N = N; c.Z = Z; c.C = C; c.V = V; tx(c, ${at}); N = c.N; Z = c.Z; C = c.C; V = c.V; if (r[15] !== ${at + size} || !c.thumb) return it;`
  for (; n < MAX; n++) {
    if (pc + 4 > m.size() || pc < 0x10000) break
    const hw = dv.getUint16(pc, true)
    const is32 = (hw >>> 11) >= 0x1d
    const size = is32 ? 4 : 2
    const h2 = is32 ? dv.getUint16(pc + 2, true) : 0
    let code: string | null = null, ends = false
    if (!is32 && (hw & 0xff00) === 0xdf00) break // svc: the run loop does it
    if (itLeft > 0) { itLeft--; code = generic(pc, size) }
    else if (!is32 && (hw & 0xff00) === 0xbf00 && (hw & 0xf) !== 0) {
      // IT: it and the instructions it covers run in the interpreter
      const mask = hw & 0xf
      itLeft = 4 - (mask & 1 ? 0 : mask & 2 ? 1 : mask & 4 ? 2 : 3)
      code = generic(pc, size)
    } else if (!is32) {
      const r = emit16(hw, pc, R)
      if (r) { code = r.code; ends = r.ends }
    } else {
      const r = emit32(hw, h2, pc, R)
      if (r) { code = r.code; ends = r.ends }
    }
    if (code === null) code = generic(pc, size)
    out.push(`// ${pc.toString(16)}\n${code}`)
    pc += size
    if (ends) { n++; break }
  }
  if (n === 0) return null
  const body = out.join('\n').replace(/\bLOOP_START\b/g, String(start)).replace(/\breturn it\b/g, '{ c.N = N; c.Z = Z; c.C = C; c.V = V; return it }')
  const src = `return function tblock_${start.toString(16)}(c, r, dv) {
  let ip = ${start}, a = 0, b = 0, v = 0, t = 0, s = 0, it = 0
  let N = c.N, Z = c.Z, C = c.C, V = c.V
  try {
    L: for (;;) {
${body}
      r[15] = ${pc >>> 0}
      c.N = N; c.Z = Z; c.C = C; c.V = V
      return it
    }
  } catch (e) { r[15] = ip; c.N = N; c.Z = Z; c.C = C; c.V = V; c.jitIters = it; throw e }
}`
  const fn = new Function('MemFault', 'tx', src)(MemFault, execThumb) as Fn
  return { fn, n, start, end: pc }

  // ---- 16-bit ----
  function emit16(hw: number, at: number, R: (k: number, at: number) => string): { code: string; ends: boolean } | null {
    const lo = (x: number) => x & 7
    const top = hw >>> 11
    const ld = (addr: string, kind: 'w' | 'h' | 'b' | 'sh' | 'sb', rt: number) => `ip = ${at}; a = (${addr}) >>> 0; if (a < 65536) throw new MemFault(a, false); r[${rt}] = ${kind === 'w' ? 'dv.getUint32(a, true)' : kind === 'h' ? 'dv.getUint16(a, true)' : kind === 'b' ? 'dv.getUint8(a)' : kind === 'sh' ? 'dv.getInt16(a, true) >>> 0' : 'dv.getInt8(a) >>> 0'};`
    const st = (addr: string, kind: 'w' | 'h' | 'b', rt: number) => `ip = ${at}; a = (${addr}) >>> 0; if (a < 65536) throw new MemFault(a, true); ${kind === 'w' ? `dv.setUint32(a, r[${rt}], true)` : kind === 'h' ? `dv.setUint16(a, r[${rt}] & 0xffff, true)` : `dv.setUint8(a, r[${rt}] & 0xff)`};`
    switch (top) {
      case 0x00: { // lsls #imm (imm 0: movs)
        const imm = (hw >>> 6) & 0x1f, rm = lo(hw >>> 3), rd = lo(hw)
        if (!imm) return { code: `v = r[${rm}]; r[${rd}] = v; ${nz('v')}`, ends: false }
        return { code: `v = r[${rm}]; C = ((v >>> ${32 - imm}) & 1) === 1; v = (v << ${imm}) >>> 0; r[${rd}] = v; ${nz('v')}`, ends: false }
      }
      case 0x01: { // lsrs #imm (0 = 32)
        const imm = (hw >>> 6) & 0x1f || 32, rm = lo(hw >>> 3), rd = lo(hw)
        return { code: `v = r[${rm}]; C = ((v >>> ${imm - 1}) & 1) === 1; v = ${imm === 32 ? '0' : `v >>> ${imm}`}; r[${rd}] = v; ${nz('v')}`, ends: false }
      }
      case 0x02: { // asrs #imm (0 = 32)
        const imm = (hw >>> 6) & 0x1f || 32, rm = lo(hw >>> 3), rd = lo(hw)
        return { code: `v = r[${rm}] | 0; C = ((v >> ${Math.min(imm - 1, 31)}) & 1) === 1; v = (v >> ${Math.min(imm, 31)}) >>> 0; r[${rd}] = v; ${nz('v')}`, ends: false }
      }
      case 0x03: { // adds / subs reg or imm3
        const imm = (hw >>> 10) & 1, sub = (hw >>> 9) & 1, x = (hw >>> 6) & 7, rn = lo(hw >>> 3), rd = lo(hw)
        const b = imm ? String(x) : `r[${x}]`
        return { code: sub ? subFlags(`r[${rd}]`, `r[${rn}]`, b) : addFlags(`r[${rd}]`, `r[${rn}]`, b), ends: false }
      }
      case 0x04: { const rd = lo(hw >>> 8), imm = hw & 0xff; return { code: `r[${rd}] = ${imm}; N = false; Z = ${imm === 0};`, ends: false } } // movs
      case 0x05: return { code: subFlags(null, `r[${lo(hw >>> 8)}]`, String(hw & 0xff)), ends: false } // cmp imm8
      case 0x06: { const rd = lo(hw >>> 8); return { code: addFlags(`r[${rd}]`, `r[${rd}]`, String(hw & 0xff)), ends: false } } // adds imm8
      case 0x07: { const rd = lo(hw >>> 8); return { code: subFlags(`r[${rd}]`, `r[${rd}]`, String(hw & 0xff)), ends: false } } // subs imm8
      case 0x08: {
        if ((hw & 0xfc00) === 0x4000) { // data processing, register
          const op = (hw >>> 6) & 0xf, rm = lo(hw >>> 3), rdn = lo(hw)
          const D = `r[${rdn}]`, M = `r[${rm}]`
          switch (op) {
            case 0: return { code: `v = (${D} & ${M}) >>> 0; ${D} = v; ${nz('v')}`, ends: false }
            case 1: return { code: `v = (${D} ^ ${M}) >>> 0; ${D} = v; ${nz('v')}`, ends: false }
            case 8: return { code: `v = (${D} & ${M}) >>> 0; ${nz('v')}`, ends: false } // tst
            case 9: return { code: subFlags(D, '0', M), ends: false } // rsbs #0 (negs)
            case 10: return { code: subFlags(null, D, M), ends: false } // cmp
            case 11: return { code: addFlags('b', D, M), ends: false } // cmn (b is scratch)
            case 12: return { code: `v = (${D} | ${M}) >>> 0; ${D} = v; ${nz('v')}`, ends: false }
            case 13: return { code: `v = Math.imul(${D}, ${M}) >>> 0; ${D} = v; ${nz('v')}`, ends: false }
            case 14: return { code: `v = (${D} & ~${M}) >>> 0; ${D} = v; ${nz('v')}`, ends: false }
            case 15: return { code: `v = (~${M}) >>> 0; ${D} = v; ${nz('v')}`, ends: false }
            default: return null
          }
        }
        if ((hw & 0xfc00) === 0x4400) { // special data: add / cmp / mov high registers, bx / blx
          const op = (hw >>> 8) & 3, rm = (hw >>> 3) & 0xf, rd = ((hw >>> 4) & 8) | lo(hw)
          if (op === 3) { // bx / blx
            if (rm === 15) return null
            const link = (hw >>> 7) & 1
            return { code: `t = r[${rm}]; ${link ? `r[14] = ${(at + 2) | 1};` : ''} c.thumb = (t & 1) === 1; r[15] = (t & ~1) >>> 0; return it`, ends: true }
          }
          if (rd === 15 || rm === 15) return null
          if (op === 0) return { code: `r[${rd}] = (r[${rd}] + r[${rm}]) >>> 0;`, ends: false }
          if (op === 1) return { code: subFlags(null, `r[${rd}]`, `r[${rm}]`), ends: false }
          return { code: `r[${rd}] = r[${rm}];`, ends: false }
        }
        // ldr rt, [pc, #imm8*4]
        const rt = lo(hw >>> 8), addr = (((at + 4) & ~3) + (hw & 0xff) * 4) >>> 0
        return { code: ld(String(addr), 'w', rt), ends: false }
      }
      case 0x0a: case 0x0b: { // load / store, register offset
        const op = (hw >>> 9) & 7, rm = lo(hw >>> 6), rn = lo(hw >>> 3), rt = lo(hw)
        const a = `r[${rn}] + r[${rm}]`
        return { code: [st(a, 'w', rt), st(a, 'h', rt), st(a, 'b', rt), ld(a, 'sb', rt), ld(a, 'w', rt), ld(a, 'h', rt), ld(a, 'b', rt), ld(a, 'sh', rt)][op], ends: false }
      }
      case 0x0c: return { code: st(`r[${lo(hw >>> 3)}] + ${((hw >>> 6) & 0x1f) * 4}`, 'w', lo(hw)), ends: false }
      case 0x0d: return { code: ld(`r[${lo(hw >>> 3)}] + ${((hw >>> 6) & 0x1f) * 4}`, 'w', lo(hw)), ends: false }
      case 0x0e: return { code: st(`r[${lo(hw >>> 3)}] + ${(hw >>> 6) & 0x1f}`, 'b', lo(hw)), ends: false }
      case 0x0f: return { code: ld(`r[${lo(hw >>> 3)}] + ${(hw >>> 6) & 0x1f}`, 'b', lo(hw)), ends: false }
      case 0x10: return { code: st(`r[${lo(hw >>> 3)}] + ${((hw >>> 6) & 0x1f) * 2}`, 'h', lo(hw)), ends: false }
      case 0x11: return { code: ld(`r[${lo(hw >>> 3)}] + ${((hw >>> 6) & 0x1f) * 2}`, 'h', lo(hw)), ends: false }
      case 0x12: return { code: st(`r[13] + ${(hw & 0xff) * 4}`, 'w', lo(hw >>> 8)), ends: false }
      case 0x13: return { code: ld(`r[13] + ${(hw & 0xff) * 4}`, 'w', lo(hw >>> 8)), ends: false }
      case 0x14: return { code: `r[${lo(hw >>> 8)}] = ${(((at + 4) & ~3) + (hw & 0xff) * 4) >>> 0};`, ends: false } // adr
      case 0x15: return { code: `r[${lo(hw >>> 8)}] = (r[13] + ${(hw & 0xff) * 4}) >>> 0;`, ends: false } // add rd, sp, #imm
      case 0x16: case 0x17: {
        if ((hw & 0xff00) === 0xb000) { const imm = (hw & 0x7f) * 4; return { code: `r[13] = (r[13] ${(hw & 0x80) ? '-' : '+'} ${imm}) >>> 0;`, ends: false } } // add / sub sp
        if ((hw & 0xf500) === 0xb100) { // cbz / cbnz
          const rn = lo(hw), nonzero = (hw >>> 11) & 1, off = (((hw >>> 9) & 1) << 6) | (((hw >>> 3) & 0x1f) << 1)
          const target = (at + 4 + off) >>> 0
          return { code: `if ((r[${rn}] ${nonzero ? '!==' : '==='} 0)) { r[15] = ${target}; return it }`, ends: false }
        }
        if ((hw & 0xff00) === 0xb200) { // sxth sxtb uxth uxtb
          const op = (hw >>> 6) & 3, rm = lo(hw >>> 3), rd = lo(hw)
          return { code: `r[${rd}] = ${['(r[RM] << 16 >> 16) >>> 0', '(r[RM] << 24 >> 24) >>> 0', 'r[RM] & 0xffff', 'r[RM] & 0xff'][op].replace(/RM/g, String(rm))};`, ends: false }
        }
        if ((hw & 0xfe00) === 0xb400) { // push {list, lr}
          const regs = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => (hw >>> i) & 1)
          if ((hw >>> 8) & 1) regs.push(14)
          const k = regs.length
          if (!k) return null
          return { code: `ip = ${at}; a = (r[13] - ${k * 4}) >>> 0; if (a < 65536) throw new MemFault(a, true); ${regs.map((x, i) => `dv.setUint32(a + ${i * 4}, r[${x}], true);`).join(' ')} r[13] = a;`, ends: false }
        }
        if ((hw & 0xfe00) === 0xbc00) { // pop {list, pc}
          const regs = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => (hw >>> i) & 1)
          const withPc = (hw >>> 8) & 1, k = regs.length + withPc
          if (!k) return null
          let code = `ip = ${at}; a = r[13]; if (a < 65536) throw new MemFault(a, false); ${regs.map((x, i) => `r[${x}] = dv.getUint32(a + ${i * 4}, true);`).join(' ')}`
          if (withPc) code += ` t = dv.getUint32(a + ${regs.length * 4}, true); r[13] = (a + ${k * 4}) >>> 0; c.thumb = (t & 1) === 1; r[15] = (t & ~1) >>> 0; return it`
          else code += ` r[13] = (a + ${k * 4}) >>> 0;`
          return { code, ends: !!withPc }
        }
        if ((hw & 0xffff) === 0xbf00) return { code: '', ends: false } // nop
        return null
      }
      case 0x1a: case 0x1b: { // b<cond>
        const cond = (hw >>> 8) & 0xf
        if (cond >= 14) return null
        const target = (at + 4 + (((hw & 0xff) << 24) >> 23)) >>> 0
        if (target === start) return { code: `if (${COND[cond]}) { if (++it < ${LOOPS}) continue L; r[15] = ${target}; return it }`, ends: false }
        return { code: `if (${COND[cond]}) { r[15] = ${target}; return it }`, ends: false }
      }
      case 0x1c: { // b
        const target = (at + 4 + (((hw & 0x7ff) << 21) >> 20)) >>> 0
        if (target === start) return { code: `if (++it < ${LOOPS}) continue L; r[15] = ${target}; return it`, ends: true }
        return { code: `r[15] = ${target}; return it`, ends: true }
      }
    }
    return null
  }

  // ---- 32-bit: calls, branches, plain word / byte loads and stores ----
  function emit32(h1: number, h2: number, at: number, R: (k: number, at: number) => string): { code: string; ends: boolean } | null {
    void R
    // bl / blx / b.w (unconditional)
    if ((h1 & 0xf800) === 0xf000 && (h2 & 0x8000) === 0x8000) {
      const op = (h2 >>> 12) & 5, S = (h1 >>> 10) & 1, J1 = (h2 >>> 13) & 1, J2 = (h2 >>> 11) & 1
      const I1 = 1 - (J1 ^ S), I2 = 1 - (J2 ^ S)
      if (op === 5 || op === 4 || op === 1) {
        let off = (S ? -1 << 24 : 0) | (I1 << 23) | (I2 << 22) | ((h1 & 0x3ff) << 12) | ((h2 & 0x7ff) << 1)
        if (op === 4) off &= ~3
        const base = op === 4 ? ((at + 4) & ~3) : at + 4
        const target = (base + off) >>> 0
        if (op === 1) return { code: target === start ? `if (++it < ${LOOPS}) continue L; r[15] = ${target}; return it` : `r[15] = ${target}; return it`, ends: true } // b.w
        return { code: `r[14] = ${(at + 4) | 1}; ${op === 4 ? 'c.thumb = false; ' : ''}r[15] = ${target}; return it`, ends: true } // bl / blx
      }
      if (op === 0) { // b<cond>.w
        const cond = (h1 >>> 6) & 0xf
        if (cond >= 14) return null
        const off = (S ? -1 << 20 : 0) | (J2 << 19) | (J1 << 18) | ((h1 & 0x3f) << 12) | ((h2 & 0x7ff) << 1)
        const target = (at + 4 + off) >>> 0
        return { code: `if (${COND[cond]}) { r[15] = ${target}; return it }`, ends: false }
      }
      return null
    }
    // ldr.w / str.w / ldrb.w / strb.w / ldrh.w / strh.w rt, [rn, #imm12]
    if ((h1 & 0xfe00) === 0xf800 && (h1 & 0x0080)) {
      const rn = h1 & 0xf, rt = h2 >>> 12, imm = h2 & 0xfff, load = (h1 >>> 4) & 1, sz = (h1 >>> 5) & 3, signed = (h1 >>> 8) & 1
      if (rn === 15 || rt === 15 || signed || sz === 3 || (rt === 13 && load)) return null
      const addr = `(r[${rn}] + ${imm}) >>> 0`
      const k = sz === 2 ? 'w' : sz === 1 ? 'h' : 'b'
      if (load) return { code: `ip = ${at}; a = ${addr}; if (a < 65536) throw new MemFault(a, false); r[${rt}] = ${k === 'w' ? 'dv.getUint32(a, true)' : k === 'h' ? 'dv.getUint16(a, true)' : 'dv.getUint8(a)'};`, ends: false }
      return { code: `ip = ${at}; a = ${addr}; if (a < 65536) throw new MemFault(a, true); ${k === 'w' ? `dv.setUint32(a, r[${rt}], true)` : k === 'h' ? `dv.setUint16(a, r[${rt}] & 0xffff, true)` : `dv.setUint8(a, r[${rt}] & 0xff)`};`, ends: false }
    }
    return null
  }
}
