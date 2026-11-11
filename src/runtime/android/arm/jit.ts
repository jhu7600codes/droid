// a block compiler for arm-mode code: hot basic blocks become javascript functions (which the
// browser then compiles to machine code), so each guest instruction stops paying for decoding and
// dispatch. common instructions get their own straight-line code; anything else in a block calls the
// interpreter for that one instruction, so behaviour never depends on what is specialised here.
//
// a block starts at a branch target and runs until a branch (conditional branches leave the block
// only when taken), an instruction that may write pc, an svc, or a length limit. it writes r[15]
// before returning. a fault inside a block reports the faulting instruction's address (ip).
// blocks are dropped when code memory is flushed (cacheflush / __clear_cache: mono's jit patches code).
import { MemFault, type CPU } from './cpu.ts'
import { compileThumb } from './thumb-jit.ts'

type BlockFn = (c: CPU, r: Uint32Array, dv: DataView) => number
export interface Block { fn: BlockFn; n: number; start: number; end: number; src?: string }

const HOT = 6 // runs of a branch target before it is compiled
const MAX = 120 // instructions per block
const LOOPS = 4000 // times a block may loop on itself before the run loop gets control back
const PAGE = 12

const COND = ['c.Z', '!c.Z', 'c.C', '!c.C', 'c.N', '!c.N', 'c.V', '!c.V', '(c.C && !c.Z)', '(!c.C || c.Z)', '(c.N === c.V)', '(c.N !== c.V)', '(!c.Z && c.N === c.V)', '(c.Z || c.N !== c.V)', 'true', 'true']
const hex = (n: number) => '0x' + (n >>> 0).toString(16)

// shared helpers the generated code calls
const H = {
  // 32 x 32 -> 64 multiplies without bigint: lo / hi land in H.lo / H.hi
  lo: 0, hi: 0,
  umul(a: number, b: number) {
    const al = a & 0xffff, ah = a >>> 16, bl = b & 0xffff, bh = b >>> 16
    const ll = al * bl, lh = al * bh, hl = ah * bl, hh = ah * bh
    const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff)
    H.lo = ((mid << 16) | (ll & 0xffff)) >>> 0
    H.hi = (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0
  },
  smul(a: number, b: number) {
    H.umul(a >>> 0, b >>> 0)
    // signed correction: subtract b << 32 when a < 0, a << 32 when b < 0
    let hi = H.hi
    if ((a | 0) < 0) hi = (hi - (b >>> 0)) >>> 0
    if ((b | 0) < 0) hi = (hi - (a >>> 0)) >>> 0
    H.hi = hi
  },
  add64(lo: number, hi: number, alo: number, ahi: number) {
    const l = (lo >>> 0) + (alo >>> 0)
    H.lo = l >>> 0
    H.hi = ((hi >>> 0) + (ahi >>> 0) + (l > 0xffffffff ? 1 : 0)) >>> 0
  },
}

// instructions the interpreter may run inside a block because they never write pc or switch mode:
// vfp / neon (data, loads, stores, transfers), barriers and preloads, the dsp / media ops and atomics
// when their destination fields are not pc
function safe(insn: number) {
  const cond = insn >>> 28, op1 = (insn >>> 25) & 7
  if (cond === 0xf) return (insn & 0xfe000000) >>> 0 === 0xf2000000 || (insn & 0xff100000) >>> 0 === 0xf4000000 || (insn & 0xff100000) >>> 0 === 0xf4100000 || (insn & 0xff000000) >>> 0 === 0xf5000000 || (insn & 0xff000000) >>> 0 === 0xf7000000
  const f12 = (insn >>> 12) & 0xf, f16 = (insn >>> 16) & 0xf, f0 = insn & 0xf
  if (op1 === 6 || (op1 === 7 && !((insn >>> 24) & 1))) { // coprocessor: vfp, neon transfers, mrc / mcr
    const coproc = (insn >>> 8) & 0xf
    return coproc === 10 || coproc === 11 || (coproc === 15 && f12 !== 15)
  }
  if (op1 === 3 && (insn & 0x10)) return f12 !== 15 && f16 !== 15 // media: extends, bit fields, dsp, divides
  if (op1 === 0 && (insn & 0x0f8000f0) === 0x01800090) return f12 !== 15 && f0 !== 15 // ldrex / strex
  if (op1 === 0 && (insn & 0x0f9000f0) === 0x01000050) return f12 !== 15 // qadd family
  if (op1 === 0 && (insn & 0x0f900090) === 0x01000080) return f12 !== 15 && f16 !== 15 // halfword multiplies
  return false
}

export class Jit {
  private c: CPU
  private blocks = new Map<number, Block | null>()
  private heat = new Map<number, number>()
  private pages = new Map<number, Set<number>>() // code page -> block starts touching it
  compiled = 0
  constructor(c: CPU) { this.c = c }

  // the block at pc, compiling it once it is hot; undefined: interpret
  get(pc: number): Block | undefined {
    const b = this.blocks.get(pc)
    if (b !== undefined) return b ?? undefined
    const h = (this.heat.get(pc) ?? 0) + 1
    if (h < HOT) { this.heat.set(pc, h); return undefined }
    this.heat.delete(pc)
    let blk: Block | null = null
    try { blk = this.compile(pc) } catch (e) { console.warn('jit: could not compile block at', hex(pc), (e as Error).message); blk = null }
    this.blocks.set(pc, blk)
    if (blk) {
      this.compiled++
      for (let p = blk.start >>> PAGE; p <= (blk.end - 1) >>> PAGE; p++) { let s = this.pages.get(p); if (!s) this.pages.set(p, (s = new Set())); s.add(pc) }
    }
    return blk ?? undefined
  }

  // thumb blocks share the maps under odd keys (thumb code is 2-aligned, so pc + 1 never clashes)
  getThumb(pc: number): Block | undefined {
    const key = pc + 1
    const b = this.blocks.get(key)
    if (b !== undefined) return b ?? undefined
    const h = (this.heat.get(key) ?? 0) + 1
    if (h < HOT) { this.heat.set(key, h); return undefined }
    this.heat.delete(key)
    let blk: Block | null = null
    try { blk = compileThumb(this.c, pc) } catch (e) { console.warn('jit: could not compile thumb block at', hex(pc), (e as Error).message); blk = null }
    this.blocks.set(key, blk)
    if (blk) {
      this.compiled++
      for (let p = blk.start >>> PAGE; p <= (blk.end - 1) >>> PAGE; p++) { let s = this.pages.get(p); if (!s) this.pages.set(p, (s = new Set())); s.add(key) }
    }
    return blk ?? undefined
  }

  // code in [start, end) changed
  invalidate(start: number, end: number) {
    for (let p = start >>> PAGE; p <= ((end - 1) >>> 0) >>> PAGE; p++) {
      const s = this.pages.get(p)
      if (!s) continue
      for (const pc of s) { this.blocks.delete(pc); this.heat.delete(pc) }
      this.pages.delete(p)
    }
  }
  clear() { this.blocks.clear(); this.heat.clear(); this.pages.clear() }

  private start = 0
  private compile(start: number): Block | null {
    this.start = start
    const m = this.c.mem
    const out: string[] = []
    let pc = start, n = 0
    for (; n < MAX; n++, pc += 4) {
      if (pc + 4 > m.size() || pc < 0x10000) break
      const insn = m.dv.getUint32(pc, true)
      const cond = insn >>> 28
      if (cond !== 15 && (insn & 0x0f000000) === 0x0f000000) break // svc: the interpreter runs it
      const body = this.emit(insn, pc)
      if (body === null) break
      const guarded = cond >= 14 ? body.code : `if (${COND[cond]}) {\n${body.code}\n}`
      out.push(`// ${hex(pc)}: ${hex(insn)}\n${guarded}`)
      if (body.ends && cond >= 14) { n++; pc += 4; break }
    }
    if (n === 0) return null
    // a branch back to the block's own start loops inside the function (up to LOOPS times before
    // going back to the run loop, which checks the deadline); it returns how often it looped
    // flags live in locals (N Z C V) while the block runs, so the engine can drop the ones nobody
    // reads; they go back to the cpu before leaving and around interpreter calls
    const sync = 'c.N = N; c.Z = Z; c.C = C; c.V = V;'
    const body = out.join('\n')
      .replace(/\bc\.([NZCV])\b/g, '$1')
      .replace(/ex\(c, (\d+), (\d+)\);/g, `${sync} ex(c, $1, $2); N = c.N; Z = c.Z; C = c.C; V = c.V;`)
      .replace(/\breturn\b/g, `{ ${sync} return it }`.replace('return it', 'RET'))
      .replace(/RET/g, 'return it')
    const src = `return function block_${start.toString(16)}(c, r, dv) {
  let ip = ${start}, a = 0, b = 0, v = 0, t = 0, s = 0, res = 0, cy = false, it = 0
  let N = c.N, Z = c.Z, C = c.C, V = c.V
  const fs = c.fp.s, fd = c.fp.d, fu = c.fp.u
  try {
    L: for (;;) {
${body}
      r[15] = ${pc >>> 0}
      ${sync}
      return it
    }
  } catch (e) { r[15] = ip; ${sync} c.jitIters = it; throw e }
}`
    const fn = new Function('c', 'H', 'MemFault', 'ex', src)(this.c, H, MemFault, (c: CPU, insn: number, at: number) => c.execOne(insn, at)) as BlockFn
    return { fn, n, start, end: pc, src }
  }

  // code for one instruction (without its condition); null: end the block before it.
  // ends: control may leave the block here (it returns when it does)
  private emit(insn: number, pc: number): { code: string; ends: boolean } | null {
    const op1 = (insn >>> 25) & 7
    const rn = (insn >>> 16) & 0xf, rd = (insn >>> 12) & 0xf
    const R = (n: number) => (n === 15 ? String((pc + 8) >>> 0) : `r[${n}]`)
    const generic = () => (safe(insn)
      ? { code: `ip = ${pc}; ex(c, ${insn >>> 0}, ${pc});`, ends: false } // never writes pc: the block goes on
      : { code: `ip = ${pc}; r[15] = ${pc + 4}; ex(c, ${insn >>> 0}, ${pc}); if (r[15] !== ${pc + 4} || c.thumb) return`, ends: true })
    if (insn >>> 28 === 0xf) return generic() // unconditional space: neon, blx imm, barriers

    // b / bl
    if (op1 === 5) {
      const target = (pc + 8 + ((insn << 8) >> 6)) >>> 0
      const link = (insn >>> 24) & 1
      if (!link && target === this.start) return { code: `if (++it < ${LOOPS}) continue L; r[15] = ${target}; return`, ends: true }
      return { code: `${link ? `r[14] = ${pc + 4}; ` : ''}r[15] = ${target}; return`, ends: true }
    }
    // bx / blx register
    if ((insn & 0x0ffffff0) === 0x012fff10 || (insn & 0x0ffffff0) === 0x012fff30) {
      const rm = insn & 0xf
      return { code: `t = ${R(rm)}; ${(insn & 0xf0) === 0x30 ? `r[14] = ${pc + 4}; ` : ''}c.thumb = (t & 1) === 1; r[15] = (t & ~1) >>> 0; return`, ends: true }
    }

    if (op1 === 0 || op1 === 1) {
      // multiplies
      if (op1 === 0 && (insn & 0x0fc000f0) === 0x00000090) {
        const rdm = (insn >>> 16) & 0xf, ra = (insn >>> 12) & 0xf, rs = (insn >>> 8) & 0xf, rm = insn & 0xf
        if (rdm === 15) return generic()
        const acc = (insn >>> 21) & 1, sflag = (insn >>> 20) & 1
        let code = `res = (Math.imul(${R(rm)}, ${R(rs)}) + ${acc ? R(ra) : 0}) >>> 0; r[${rdm}] = res;`
        if (sflag) code += ' c.N = (res >>> 31) === 1; c.Z = res === 0;'
        return { code, ends: false }
      }
      if (op1 === 0 && (insn & 0x0ff000f0) === 0x00600090) { // mls
        const rdm = (insn >>> 16) & 0xf, ra = (insn >>> 12) & 0xf, rs = (insn >>> 8) & 0xf, rm = insn & 0xf
        if (rdm === 15) return generic()
        return { code: `r[${rdm}] = (${R(ra)} - Math.imul(${R(rm)}, ${R(rs)})) >>> 0;`, ends: false }
      }
      if (op1 === 0 && (insn & 0x0f8000f0) === 0x00800090) { // umull smull umlal smlal
        const hi = (insn >>> 16) & 0xf, lo = (insn >>> 12) & 0xf, rs = (insn >>> 8) & 0xf, rm = insn & 0xf
        if (hi === 15 || lo === 15 || (insn >>> 20) & 1) return generic()
        const signed = (insn >>> 22) & 1, acc = (insn >>> 21) & 1
        let code = `H.${signed ? 'smul' : 'umul'}(${R(rm)}, ${R(rs)});`
        if (acc) code += ` H.add64(H.lo, H.hi, r[${lo}], r[${hi}]);`
        code += ` r[${lo}] = H.lo; r[${hi}] = H.hi;`
        return { code, ends: false }
      }
      if ((insn & 0x0fff0ff0) === 0x016f0f10) return { code: `r[${rd}] = Math.clz32(${R(insn & 0xf)});`, ends: false } // clz
      if ((insn & 0x0ff00000) === 0x03000000) return rd === 15 ? generic() : { code: `r[${rd}] = ${((insn >>> 4) & 0xf000) | (insn & 0xfff)};`, ends: false } // movw
      if ((insn & 0x0ff00000) === 0x03400000) return rd === 15 ? generic() : { code: `r[${rd}] = ((${(((insn >>> 4) & 0xf000) | (insn & 0xfff)) << 16} | (r[${rd}] & 0xffff)) >>> 0);`, ends: false } // movt
      if ((insn & 0x0fffff00) === 0x0320f000) return { code: '', ends: false } // nop hints
      // extra loads / stores: ldrh strh ldrsb ldrsh ldrd strd (not ldrex / strex / swp: those have bit 24..23 patterns we leave alone)
      if (op1 === 0 && (insn & 0x90) === 0x90 && (insn & 0x60) !== 0) {
        const p = (insn >>> 24) & 1, u = (insn >>> 23) & 1, imm = (insn >>> 22) & 1, w = (insn >>> 21) & 1, l = (insn >>> 20) & 1, sh = (insn >>> 5) & 3
        if (rn === 15 && (w || !p) || rd === 15 || ((sh === 2 || sh === 3) && !l && rd === 14) || (!l && sh !== 1 && (rd & 1))) return generic()
        if (!l && sh !== 1 && !(sh === 2 || sh === 3)) return generic()
        const off = imm ? String(((insn >>> 4) & 0xf0) | (insn & 0xf)) : R(insn & 0xf)
        let code = `ip = ${pc}; b = ${R(rn)}; t = (${u ? `b + ${off}` : `b - ${off}`}) >>> 0; a = ${p ? 't' : 'b'}; if (a < 65536) throw new MemFault(a, ${l ? 'false' : 'true'});`
        if (l) {
          if (sh === 1) code += ` v = dv.getUint16(a, true);`
          else if (sh === 2) code += ` v = dv.getInt8(a) >>> 0;`
          else code += ` v = dv.getInt16(a, true) >>> 0;`
          code += ` r[${rd}] = v;` // (the interpreter writes rd, then the base)
          if (!p || w) code += ` r[${rn}] = t;`
        } else {
          if (sh === 1) code += ` dv.setUint16(a, ${R(rd)} & 0xffff, true);`
          else if (sh === 2) { if (rd + 1 === 15) return generic(); code += ` r[${rd}] = dv.getUint32(a, true); r[${rd + 1}] = dv.getUint32(a + 4, true);` } // ldrd
          else code += ` dv.setUint32(a, ${R(rd)}, true); dv.setUint32(a + 4, ${R(rd + 1)}, true);` // strd
          if (!p || w) code += ` r[${rn}] = t;`
        }
        return { code, ends: false }
      }
      // data processing (not the misc / multiply space)
      if (op1 === 0 && (insn & 0x90) === 0x90) return generic() // ldrex / strex / swp and what is left of that space
      if ((insn & 0x01900000) === 0x01000000) return generic() // misc space: mrs, msr, bx forms, qadd, smulxy...

      return this.dp(insn, pc, R, generic)
    }

    // ldr / str / ldrb / strb
    if (op1 === 2 || (op1 === 3 && !(insn & 0x10))) {
      const p = (insn >>> 24) & 1, u = (insn >>> 23) & 1, byte = (insn >>> 22) & 1, w = (insn >>> 21) & 1, l = (insn >>> 20) & 1
      if (rd === 15 || (!p && w)) return generic() // pc loads change control flow; ldrt / strt
      if (rn === 15 && (w || !p)) return generic()
      let off: string
      if ((insn >>> 25) & 1) {
        const rm = insn & 0xf, type = (insn >>> 5) & 3, amt = (insn >>> 7) & 0x1f
        if (rm === 15) return generic()
        off = this.shiftImm(`r[${rm}]`, type, amt)
        if (off === '') return generic()
      } else off = String(insn & 0xfff)
      let code = `ip = ${pc}; b = ${R(rn)}; t = (${u ? `b + ${off}` : `b - ${off}`}) >>> 0; a = ${p ? 't' : 'b'}; if (a < 65536) throw new MemFault(a, ${l ? 'false' : 'true'});`
      if (l) {
        code += byte ? ' v = dv.getUint8(a);' : ' v = dv.getUint32(a, true);'
        if (!p || w) code += ` r[${rn}] = t;`
        code += ` r[${rd}] = v;`
      } else {
        code += byte ? ` dv.setUint8(a, ${R(rd)} & 0xff);` : ` dv.setUint32(a, ${R(rd)}, true);`
        if (!p || w) code += ` r[${rn}] = t;`
      }
      return { code, ends: false }
    }

    // ldm / stm (no user-mode forms; a pc load ends the block)
    if (op1 === 4) {
      const p = (insn >>> 24) & 1, u = (insn >>> 23) & 1, sbit = (insn >>> 22) & 1, w = (insn >>> 21) & 1, l = (insn >>> 20) & 1
      const list = insn & 0xffff
      if (sbit || !list || rn === 15) return generic()
      const regs: number[] = []
      for (let i = 0; i < 16; i++) if (list & (1 << i)) regs.push(i)
      const cnt = regs.length
      const first = u ? (p ? 4 : 0) : (p ? -cnt * 4 : -cnt * 4 + 4)
      let code = `ip = ${pc}; b = r[${rn}]; a = (b + ${first}) >>> 0; if (a < 65536) throw new MemFault(a, ${l ? 'false' : 'true'});`
      let pcLoad = false
      regs.forEach((i, k) => {
        if (l) {
          if (i === 15) { pcLoad = true; code += ` t = dv.getUint32(a + ${k * 4}, true);` }
          else code += ` r[${i}] = dv.getUint32(a + ${k * 4}, true);`
        } else code += ` dv.setUint32(a + ${k * 4}, ${i === 15 ? (pc + 8) >>> 0 : `r[${i}]`}, true);`
      })
      if (w && !(l && list & (1 << rn))) code += ` r[${rn}] = (b ${u ? '+' : '-'} ${cnt * 4}) >>> 0;`
      if (pcLoad) { code += ' c.thumb = (t & 1) === 1; r[15] = (t & ~1) >>> 0; return'; return { code, ends: true } }
      return { code, ends: false }
    }

    // media: extends (with add), bit fields, reverses; the rest through the interpreter
    if (op1 === 3) {
      const rm = insn & 0xf
      if (rd === 15) return generic()
      if ((insn & 0x0f8003f0) === 0x06800070) {
        const rot = ((insn >>> 10) & 3) * 8, kind = (insn >>> 20) & 7
        const v0 = rot ? `((${R(rm)} >>> ${rot}) | (${R(rm)} << ${32 - rot}))` : R(rm)
        const x = kind === 6 ? `(${v0} & 0xff)` : kind === 7 ? `(${v0} & 0xffff)` : kind === 2 ? `((${v0} << 24) >> 24)` : kind === 3 ? `((${v0} << 16) >> 16)` : kind === 4 ? `(${v0} & 0x00ff00ff)` : null
        if (!x) return generic()
        return { code: `r[${rd}] = (${rn === 15 ? 0 : R(rn)} + ${x}) >>> 0;`, ends: false }
      }
      if ((insn & 0x0fe00070) === 0x07e00050) { // ubfx
        const lsb = (insn >>> 7) & 0x1f, width = ((insn >>> 16) & 0x1f) + 1
        return { code: `r[${rd}] = ${width === 32 ? R(rm) : `(${R(rm)} >>> ${lsb}) & ${hex(width === 32 ? 0xffffffff : (2 ** width) - 1)}`};`, ends: false }
      }
      if ((insn & 0x0fe00070) === 0x07a00050) { // sbfx
        const lsb = (insn >>> 7) & 0x1f, width = ((insn >>> 16) & 0x1f) + 1
        return { code: `r[${rd}] = (((${R(rm)} >>> ${lsb}) << ${32 - width}) >> ${32 - width}) >>> 0;`, ends: false }
      }
      if ((insn & 0x0fe00070) === 0x07c00010) { // bfi / bfc
        const lsb = (insn >>> 7) & 0x1f, msb = (insn >>> 16) & 0x1f, wdt = msb - lsb + 1
        if (wdt <= 0) return generic()
        const mask = ((wdt === 32 ? 0xffffffff : (2 ** wdt) - 1) * 2 ** lsb) >>> 0
        return { code: `r[${rd}] = ((r[${rd}] & ${hex(~mask >>> 0)}) | (${rm === 15 ? 0 : `(${R(rm)} << ${lsb})`} & ${hex(mask)})) >>> 0;`, ends: false }
      }
      if ((insn & 0x0fff0ff0) === 0x06bf0f30) return { code: `v = ${R(rm)}; r[${rd}] = (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;`, ends: false } // rev
    }
    if (op1 === 6 || (op1 === 7 && !((insn >>> 24) & 1))) { const v = this.vfp(insn, pc, R); if (v !== null) return { code: v, ends: false } }
    return generic()
  }

  // common vfp instructions inline (fs / fd / fu: the float views of the fp registers); null: the interpreter
  private vfp(insn: number, pc: number, R: (n: number) => string): string | null {
    const cp = (insn >>> 8) & 0xf
    if (cp !== 10 && cp !== 11) return null
    const dbl = cp === 11
    const D = (insn >>> 22) & 1, N = (insn >>> 7) & 1, M = (insn >>> 5) & 1
    const Vd = (insn >>> 12) & 0xf, Vn = (insn >>> 16) & 0xf, Vm = insn & 0xf
    const sd = dbl ? Vd | (D << 4) : (Vd << 1) | D, sn = dbl ? Vn | (N << 4) : (Vn << 1) | N, sm = dbl ? Vm | (M << 4) : (Vm << 1) | M
    const F = dbl ? 'fd' : 'fs'
    const rd = (insn >>> 12) & 0xf, rn = (insn >>> 16) & 0xf
    const top = (insn >>> 24) & 0xf
    const rnd = (e: string) => (dbl ? e : `Math.fround(${e})`)
    // vldr / vstr
    if (top === 0xd && !((insn >>> 21) & 1)) {
      const imm = (insn & 0xff) * 4, u = (insn >>> 23) & 1, L = (insn >>> 20) & 1
      const base = rn === 15 ? String(((pc + 8) & ~3) >>> 0) : `r[${rn}]`
      let c = `ip = ${pc}; a = (${base} ${u ? '+' : '-'} ${imm}) >>> 0; if (a < 65536) throw new MemFault(a, ${L ? 'false' : 'true'});`
      if (dbl) c += L ? ` fu[${sd * 2}] = dv.getUint32(a, true); fu[${sd * 2 + 1}] = dv.getUint32(a + 4, true);` : ` dv.setUint32(a, fu[${sd * 2}], true); dv.setUint32(a + 4, fu[${sd * 2 + 1}], true);`
      else c += L ? ` fu[${sd}] = dv.getUint32(a, true);` : ` dv.setUint32(a, fu[${sd}], true);`
      return c
    }
    // vldm / vstm / vpush / vpop
    if ((top === 0xc || top === 0xd) && (insn & 0x0fe00000) !== 0x0c400000) {
      const P = (insn >>> 24) & 1, U = (insn >>> 23) & 1, W = (insn >>> 21) & 1, L = (insn >>> 20) & 1, words = insn & 0xff
      if (rn === 15 || !words || P === U) return null
      const start = dbl ? sd * 2 : sd
      let c = `ip = ${pc}; b = r[${rn}]; a = ${P && !U ? `(b - ${words * 4}) >>> 0` : 'b'}; if (a < 65536) throw new MemFault(a, ${L ? 'false' : 'true'});`
      for (let i = 0; i < words; i++) c += L ? ` fu[${start + i}] = dv.getUint32(a + ${i * 4}, true);` : ` dv.setUint32(a + ${i * 4}, fu[${start + i}], true);`
      if (W) c += ` r[${rn}] = (b ${U ? '+' : '-'} ${words * 4}) >>> 0;`
      return c
    }
    // vmov two core registers <-> double / two singles
    if ((insn & 0x0fe00000) === 0x0c400000) {
      if (rd === 15 || rn === 15) return null
      const op = (insn >>> 20) & 1, i0 = dbl ? sm * 2 : sm
      return op ? `r[${rd}] = fu[${i0}]; r[${rn}] = fu[${i0 + 1}];` : `fu[${i0}] = r[${rd}]; fu[${i0 + 1}] = r[${rn}];`
    }
    if (top !== 0xe) return null
    if ((insn >>> 4) & 1) {
      if ((insn & 0x0fe00f7f) === 0x0e000a10) { // vmov core <-> single
        if (rd === 15) return null
        return (insn >>> 20) & 1 ? `r[${rd}] = fu[${sn}];` : `fu[${sn}] = r[${rd}];`
      }
      if ((insn & 0x0fff0fff) === 0x0ef10a10) { // vmrs
        if (rd === 15) return `t = c.fp.fpscr; N = (t >>> 31) === 1; Z = ((t >>> 30) & 1) === 1; C = ((t >>> 29) & 1) === 1; V = ((t >>> 28) & 1) === 1;`
        return `r[${rd}] = c.fp.fpscr >>> 0;`
      }
      return null
    }
    const opc1 = (insn >>> 20) & 0xb, opc3 = (insn >>> 6) & 1
    const a = `${F}[${sn}]`, b = `${F}[${sm}]`, d = `${F}[${sd}]`
    switch (opc1) {
      case 0x0: return `${d} = ${rnd(`${d} ${opc3 ? '-' : '+'} ${rnd(`${a} * ${b}`)}`)};` // vmla / vmls
      case 0x1: return `${d} = ${rnd(`-${d} ${opc3 ? '-' : '+'} ${rnd(`${a} * ${b}`)}`)};` // vnmls (op 0: -d + n*m) / vnmla (op 1: -d - n*m)
      case 0x2: return `${d} = ${rnd(`${opc3 ? '-' : ''}(${a} * ${b})`)};` // vmul / vnmul
      case 0x3: return `${d} = ${rnd(`${a} ${opc3 ? '-' : '+'} ${b}`)};` // vadd / vsub
      case 0x8: return opc3 ? null : `${d} = ${rnd(`${a} / ${b}`)};` // vdiv
    }
    if (opc1 !== 0xb || !opc3) return null
    const opc2 = (insn >>> 16) & 0xf, op7 = (insn >>> 7) & 1
    switch (opc2) {
      case 0x0: return `${d} = ${op7 ? `Math.abs(${b})` : b};` // vmov / vabs
      case 0x1: return `${d} = ${op7 ? rnd(`Math.sqrt(${b})`) : `-${b}`};` // vneg / vsqrt
      case 0x4: case 0x5: { // vcmp / vcmpe (with zero for 5): flags into fpscr
        const y = opc2 === 5 ? '0' : b
        return `a = ${d}; b = ${y}; c.fp.fpscr = (c.fp.fpscr & 0x0fffffff) | (a !== a || b !== b ? 0x30000000 : a === b ? 0x60000000 : a < b ? 0x80000000 : 0x20000000);`
      }
      case 0x7: return dbl ? `fs[${(Vd << 1) | D}] = ${b};` : `fd[${Vd | (D << 4)}] = ${b};` // vcvt f64 <-> f32 (the store rounds)
      case 0x8: { const src = (Vm << 1) | M; return `${d} = ${rnd(op7 ? `(fu[${src}] | 0)` : `fu[${src}]`)};` } // int -> float
      case 0xc: case 0xd: { // float -> int, toward zero (op7); vcvtr: the interpreter
        if (!op7) return null
        const dst = (Vd << 1) | D
        return opc2 === 0xd
          ? `t = ${b}; fu[${dst}] = (t !== t ? 0 : t >= 2147483647 ? 2147483647 : t <= -2147483648 ? -2147483648 : Math.trunc(t)) >>> 0;`
          : `t = ${b}; fu[${dst}] = t !== t || t <= 0 ? 0 : t >= 4294967295 ? 4294967295 : Math.trunc(t);`
      }
    }
    return null
  }

  // shift by an immediate amount, as an expression ('' when the case needs the carry: rrx)
  private shiftImm(x: string, type: number, amt: number): string {
    switch (type) {
      case 0: return amt ? `((${x} << ${amt}) >>> 0)` : x
      case 1: return amt ? `(${x} >>> ${amt})` : '0'
      case 2: return amt ? `((${x} >> ${amt}) >>> 0)` : `((${x} >> 31) >>> 0)`
      default: return amt ? `(((${x} >>> ${amt}) | (${x} << ${32 - amt})) >>> 0)` : ''
    }
  }

  // data processing: and eor sub rsb add adc sbc rsc tst teq cmp cmn orr mov bic mvn
  private dp(insn: number, pc: number, R: (n: number) => string, generic: () => { code: string; ends: boolean }) {
    const op = (insn >>> 21) & 0xf, s = (insn >>> 20) & 1
    const rn = (insn >>> 16) & 0xf, rd = (insn >>> 12) & 0xf
    const test = op >= 8 && op <= 11
    if (rd === 15 && !test) return generic() // alu writes to pc (returns, jumps): the interpreter
    const logical = [0, 1, 8, 9, 12, 13, 14, 15].includes(op)
    // operand 2 (and its carry, when a logical op sets flags)
    let b: string, carry: string | null = null
    if ((insn >>> 25) & 1) {
      const rot = ((insn >>> 8) & 0xf) * 2, imm = insn & 0xff
      const val = rot ? ((imm >>> rot) | (imm << (32 - rot))) >>> 0 : imm
      b = String(val)
      if (rot) carry = (val >>> 31) === 1 ? 'true' : 'false'
    } else {
      const rm = insn & 0xf, type = (insn >>> 5) & 3
      if ((insn >>> 4) & 1) return generic() // shift by register
      const amt = (insn >>> 7) & 0x1f
      const x = R(rm)
      const e = this.shiftImm(x, type, amt)
      if (e === '') return generic() // rrx
      b = e
      if (s && logical) {
        if (type === 0) carry = amt ? `((${x} >>> ${32 - amt}) & 1) === 1` : null
        else if (type === 1) carry = amt ? `((${x} >>> ${amt - 1}) & 1) === 1` : `(${x} >>> 31) === 1`
        else if (type === 2) carry = amt ? `((${x} >> ${amt - 1}) & 1) !== 0` : `(${x} >>> 31) === 1`
        else carry = `((${x} >>> ${amt - 1}) & 1) === 1`
      }
    }
    const a = rn === 15 ? String((pc + 8) >>> 0) : `r[${rn}]`
    const nz = 'c.N = (res >>> 31) === 1; c.Z = res === 0;'
    const logicFlags = s ? ` ${nz}${carry ? ` c.C = ${carry};` : ''}` : ''
    // the carry must be read before the result overwrites the shifted register
    const pre = s && logical && carry && carry !== 'true' && carry !== 'false' ? `cy = ${carry}; ` : ''
    const lf = pre ? ` ${nz} c.C = cy;` : logicFlags
    const add = (x: string, y: string, cin: string) => s
      ? `a = ${x}; b = ${y}; s = a + b + ${cin}; res = s >>> 0; c.N = (res >>> 31) === 1; c.Z = res === 0; c.C = s > 0xffffffff; c.V = ((~(a ^ b) & (a ^ res)) >>> 31) === 1;`
      : `res = (${x} + ${y} + ${cin}) >>> 0;`
    const sub = (x: string, y: string, cin: string) => add(x, `(~${y} >>> 0)`, cin)
    const store = test ? '' : ` r[${rd}] = res;`
    let code: string
    switch (op) {
      case 0x0: code = `${pre}res = (${a} & ${b}) >>> 0;${lf}`; break
      case 0x1: code = `${pre}res = (${a} ^ ${b}) >>> 0;${lf}`; break
      case 0x2: code = s ? sub(a, b, '1') : `res = (${a} - ${b}) >>> 0;`; break
      case 0x3: code = s ? sub(b, a, '1') : `res = (${b} - ${a}) >>> 0;`; break
      case 0x4: code = add(a, b, '0'); break
      case 0x5: code = add(a, b, '(c.C ? 1 : 0)'); break
      case 0x6: code = sub(a, b, '(c.C ? 1 : 0)'); break
      case 0x7: code = sub(b, a, '(c.C ? 1 : 0)'); break
      case 0x8: code = `${pre}res = (${a} & ${b}) >>> 0; ${nz}${pre ? ' c.C = cy;' : carry ? ` c.C = ${carry};` : ''}`; break
      case 0x9: code = `${pre}res = (${a} ^ ${b}) >>> 0; ${nz}${pre ? ' c.C = cy;' : carry ? ` c.C = ${carry};` : ''}`; break
      case 0xa: if (!s) return generic(); code = sub(a, b, '1'); break // cmp
      case 0xb: if (!s) return generic(); code = add(a, b, '0'); break // cmn
      case 0xc: code = `${pre}res = (${a} | ${b}) >>> 0;${lf}`; break
      case 0xd: code = `${pre}res = ${b} >>> 0;${lf}`; break
      case 0xe: code = `${pre}res = (${a} & ~${b}) >>> 0;${lf}`; break
      default: code = `${pre}res = ~${b} >>> 0;${lf}`; break
    }
    return { code: code + store, ends: false }
  }
}
