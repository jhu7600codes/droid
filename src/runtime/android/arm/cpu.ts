// armv7-a user mode interpreter (arm state; thumb-2 comes next). integer instructions:
// data processing with all shifter modes, multiply and long multiply, loads and stores (word, byte,
// half, signed, double, multiple), branches and interworking, movw / movt, clz, extend, bitfield, rev.
// jumps to addresses in the trap area call js host functions (libc, liblog, jni).

export const TRAP_BASE = 0xfff00000
export const RETURN_TRAP = 0xfffffff0

export class Memory {
  buf: ArrayBuffer
  u8: Uint8Array
  dv: DataView
  brk: number
  constructor(size = 64 * 1024 * 1024) {
    this.buf = new ArrayBuffer(size)
    this.u8 = new Uint8Array(this.buf)
    this.dv = new DataView(this.buf)
    this.brk = 0x10000
  }
  r32(a: number) { return this.dv.getUint32(a >>> 0, true) }
  w32(a: number, v: number) { this.dv.setUint32(a >>> 0, v >>> 0, true) }
  r16(a: number) { return this.dv.getUint16(a >>> 0, true) }
  w16(a: number, v: number) { this.dv.setUint16(a >>> 0, v & 0xffff, true) }
  r8(a: number) { return this.u8[a >>> 0] }
  w8(a: number, v: number) { this.u8[a >>> 0] = v }
  cstr(a: number, max = 1 << 20) {
    let e = a
    while (this.u8[e] && e - a < max) e++
    return new TextDecoder().decode(this.u8.subarray(a, e))
  }
  // simple first-fit heap with a free list (malloc / free / realloc)
  private free_: [number, number][] = []
  private sizes = new Map<number, number>()
  heapTop = 0
  malloc(n: number) {
    n = (Math.max(1, n) + 15) & ~15
    for (let i = 0; i < this.free_.length; i++) {
      const [a, s] = this.free_[i]
      if (s >= n) { this.free_.splice(i, 1); if (s > n + 32) this.free_.push([a + n, s - n]); this.sizes.set(a, n); return a }
    }
    const a = this.heapTop
    this.heapTop += n
    if (this.heapTop > this.stackLimit) throw new Error('arm: out of memory')
    this.sizes.set(a, n)
    return a
  }
  free(a: number) {
    const s = this.sizes.get(a)
    if (s == null) return
    this.sizes.delete(a)
    this.free_.push([a, s])
  }
  sizeOf(a: number) { return this.sizes.get(a) || 0 }
  stackLimit = 0
}

export type HostFn = (cpu: CPU) => number | void | bigint

export class CPU {
  r = new Uint32Array(16)
  N = false; Z = false; C = false; V = false
  thumb = false
  mem: Memory
  host: { name: string; fn: HostFn }[] = []
  steps = 0
  constructor(mem: Memory) { this.mem = mem }

  // registers a js function and returns its trap address
  hostFn(name: string, fn: HostFn) {
    this.host.push({ name, fn })
    return TRAP_BASE + (this.host.length - 1) * 4
  }

  // calls arm code at addr with up to 4 register args (more go on the stack), returns r0 (and r1)
  call(addr: number, args: number[] = []): { r0: number; r1: number } {
    const saved = this.r.slice()
    const savedFlags = [this.N, this.Z, this.C, this.V, this.thumb]
    let sp = this.r[13]
    const extra = args.slice(4)
    sp = (sp - extra.length * 4) & ~7
    extra.forEach((v, i) => this.mem.w32(sp + i * 4, v))
    for (let i = 0; i < 4; i++) this.r[i] = (args[i] ?? 0) >>> 0
    this.r[13] = sp
    this.r[14] = RETURN_TRAP
    this.thumb = (addr & 1) === 1
    this.r[15] = addr & ~1
    this.run()
    const out = { r0: this.r[0], r1: this.r[1] }
    this.r.set(saved)
    ;[this.N, this.Z, this.C, this.V, this.thumb] = savedFlags
    return out
  }

  private run() {
    for (;;) {
      const pc = this.r[15]
      if (pc >= TRAP_BASE) {
        if (pc === RETURN_TRAP) return
        const h = this.host[(pc - TRAP_BASE) >>> 2]
        if (!h) throw new Error(`arm: jump to bad trap 0x${pc.toString(16)}`)
        const v = h.fn(this)
        if (typeof v === 'bigint') { const u = BigInt.asUintN(64, v); this.r[0] = Number(u & 0xffffffffn); this.r[1] = Number(u >> 32n) }
        else if (v !== undefined) this.r[0] = v >>> 0
        const lr = this.r[14]
        this.thumb = (lr & 1) === 1
        this.r[15] = lr & ~1
        continue
      }
      if (this.thumb) throw new Error(`arm: thumb code at 0x${pc.toString(16)} is not supported yet (build the library with -marm)`)
      this.steps++
      const insn = this.mem.r32(pc)
      this.r[15] = pc + 4
      if (this.cond(insn >>> 28)) this.exec(insn, pc)
    }
  }

  private cond(c: number) {
    switch (c) {
      case 0: return this.Z
      case 1: return !this.Z
      case 2: return this.C
      case 3: return !this.C
      case 4: return this.N
      case 5: return !this.N
      case 6: return this.V
      case 7: return !this.V
      case 8: return this.C && !this.Z
      case 9: return !this.C || this.Z
      case 10: return this.N === this.V
      case 11: return this.N !== this.V
      case 12: return !this.Z && this.N === this.V
      case 13: return this.Z || this.N !== this.V
      default: return true // 14 al, 15 unconditional space (handled in exec)
    }
  }

  // reading pc gives the instruction address + 8
  private reg(n: number, pc: number) { return n === 15 ? (pc + 8) >>> 0 : this.r[n] }

  private shift(v: number, type: number, amount: number, carryIn: boolean, byReg: boolean): [number, boolean] {
    if (byReg) {
      amount &= 0xff
      if (amount === 0) return [v >>> 0, carryIn]
      switch (type) {
        case 0: return amount < 32 ? [(v << amount) >>> 0, ((v >>> (32 - amount)) & 1) === 1] : [0, amount === 32 ? (v & 1) === 1 : false]
        case 1: return amount < 32 ? [v >>> amount, ((v >>> (amount - 1)) & 1) === 1] : [0, amount === 32 ? (v >>> 31) === 1 : false]
        case 2: return amount < 32 ? [(v >> amount) >>> 0, ((v >> (amount - 1)) & 1) === 1] : [(v >> 31) >>> 0, (v >>> 31) === 1]
        default: { const a = amount & 31; return a === 0 ? [v >>> 0, (v >>> 31) === 1] : [((v >>> a) | (v << (32 - a))) >>> 0, ((v >>> (a - 1)) & 1) === 1] }
      }
    }
    switch (type) {
      case 0: return amount === 0 ? [v >>> 0, carryIn] : [(v << amount) >>> 0, ((v >>> (32 - amount)) & 1) === 1]
      case 1: return amount === 0 ? [0, (v >>> 31) === 1] : [v >>> amount, ((v >>> (amount - 1)) & 1) === 1]
      case 2: return amount === 0 ? [(v >> 31) >>> 0, (v >>> 31) === 1] : [(v >> amount) >>> 0, ((v >> (amount - 1)) & 1) === 1]
      default:
        if (amount === 0) return [(((carryIn ? 1 : 0) << 31) | (v >>> 1)) >>> 0, (v & 1) === 1] // rrx
        return [((v >>> amount) | (v << (32 - amount))) >>> 0, ((v >>> (amount - 1)) & 1) === 1]
    }
  }

  private addFlags(a: number, b: number, carry: number) {
    const r = a + b + carry
    const res = r >>> 0
    this.N = (res >>> 31) === 1
    this.Z = res === 0
    this.C = r > 0xffffffff
    this.V = ((~(a ^ b) & (a ^ res)) >>> 31) === 1
    return res
  }

  private exec(insn: number, pc: number) {
    const m = this.mem
    if (insn >>> 28 === 0xf) {
      // unconditional space: blx imm, pld, barriers
      if ((insn & 0x0e000000) === 0x0a000000) {
        const off = ((insn << 8) >> 6) | ((insn >>> 23) & 2)
        this.r[14] = pc + 4
        this.r[15] = (pc + 8 + off) >>> 0
        this.thumb = true
        return
      }
      return // pld, dmb, dsb, isb: nothing to do in a single-threaded interpreter
    }
    const rn = (insn >>> 16) & 0xf, rd = (insn >>> 12) & 0xf, rs = (insn >>> 8) & 0xf, rm = insn & 0xf
    const op1 = (insn >>> 25) & 7

    if (op1 === 0 || op1 === 1) {
      // multiply
      if (op1 === 0 && (insn & 0x0fc000f0) === 0x00000090) {
        const res = (Math.imul(this.r[rm], this.r[rs]) + ((insn >>> 21) & 1 ? this.r[(insn >>> 12) & 0xf] : 0)) >>> 0
        this.r[(insn >>> 16) & 0xf] = res
        if ((insn >>> 20) & 1) { this.N = (res >>> 31) === 1; this.Z = res === 0 }
        return
      }
      if (op1 === 0 && (insn & 0x0f8000f0) === 0x00800090) {
        const signed = (insn >>> 22) & 1, acc = (insn >>> 21) & 1
        const a = signed ? BigInt(this.r[rm] | 0) : BigInt(this.r[rm]), b = signed ? BigInt(this.r[rs] | 0) : BigInt(this.r[rs])
        let res = a * b
        const lo = rd, hi = rn
        if (acc) res += (BigInt(this.r[hi]) << 32n) | BigInt(this.r[lo])
        const u = BigInt.asUintN(64, res)
        this.r[lo] = Number(u & 0xffffffffn)
        this.r[hi] = Number(u >> 32n)
        if ((insn >>> 20) & 1) { this.N = (this.r[hi] >>> 31) === 1; this.Z = u === 0n }
        return
      }
      if (op1 === 0 && (insn & 0x0ff000f0) === 0x00600090) { // mls
        this.r[(insn >>> 16) & 0xf] = (this.r[(insn >>> 12) & 0xf] - Math.imul(this.r[rm], this.r[rs])) >>> 0
        return
      }
      // bx, blx (register)
      if ((insn & 0x0ffffff0) === 0x012fff10 || (insn & 0x0ffffff0) === 0x012fff30) {
        const t = this.r[rm]
        if ((insn & 0xf0) === 0x30) this.r[14] = pc + 4
        this.thumb = (t & 1) === 1
        this.r[15] = t & ~1
        return
      }
      if ((insn & 0x0fff0ff0) === 0x016f0f10) { this.r[rd] = Math.clz32(this.r[rm]); return }
      if ((insn & 0x0fb00ff0) === 0x01000090) { // swp (old atomics)
        const a = this.r[rn], old = (insn >>> 22) & 1 ? m.r8(a) : m.r32(a)
        if ((insn >>> 22) & 1) m.w8(a, this.r[rm]); else m.w32(a, this.r[rm])
        this.r[rd] = old
        return
      }
      if ((insn & 0x0f9000f0) === 0x01800090) { // ldrex / strex: single threaded, always succeed
        if ((insn >>> 20) & 1) this.r[rd] = m.r32(this.r[rn])
        else { m.w32(this.r[rn], this.r[rm]); this.r[rd] = 0 }
        return
      }
      if ((insn & 0x0fbf0fff) === 0x010f0000) { this.r[rd] = ((this.N ? 1 : 0) << 31) | ((this.Z ? 1 : 0) << 30) | ((this.C ? 1 : 0) << 29) | ((this.V ? 1 : 0) << 28) | 0x10; return } // mrs
      if ((insn & 0x0fb0fff0) === 0x0120f000 || (insn & 0x0fb0f000) === 0x0320f000) { // msr
        const v = (insn >>> 25) & 1 ? this.rotImm(insn) : this.r[rm]
        if ((insn >>> 19) & 1) { this.N = (v >>> 31) === 1; this.Z = ((v >>> 30) & 1) === 1; this.C = ((v >>> 29) & 1) === 1; this.V = ((v >>> 28) & 1) === 1 }
        return
      }
      if ((insn & 0x0ff000f0) === 0x07000010) return // reserved
      // movw / movt
      if ((insn & 0x0ff00000) === 0x03000000) { this.r[rd] = ((insn >>> 4) & 0xf000) | (insn & 0xfff); return }
      if ((insn & 0x0ff00000) === 0x03400000) { this.r[rd] = ((((insn >>> 4) & 0xf000) | (insn & 0xfff)) << 16 | (this.r[rd] & 0xffff)) >>> 0; return }
      if ((insn & 0x0fffff00) === 0x0320f000) return // nop, yield, wfe hints
      // extra loads and stores: ldrh strh ldrsb ldrsh ldrd strd
      if (op1 === 0 && (insn & 0x90) === 0x90 && (insn & 0x60) !== 0) return this.extraLoadStore(insn, pc)
      return this.dataProcessing(insn, pc)
    }

    if (op1 === 2 || (op1 === 3 && !(insn & 0x10))) return this.loadStore(insn, pc)
    if (op1 === 3) return this.media(insn)

    if (op1 === 4) { // ldm / stm
      const p = (insn >>> 24) & 1, u = (insn >>> 23) & 1, w = (insn >>> 21) & 1, l = (insn >>> 20) & 1
      const list = insn & 0xffff
      const n = popcount(list)
      let addr = this.r[rn]
      const base = addr
      let start = u ? (p ? addr + 4 : addr) : (p ? addr - n * 4 : addr - n * 4 + 4)
      const regs: number[] = []
      for (let i = 0; i < 16; i++) if (list & (1 << i)) regs.push(i)
      for (const i of regs) {
        if (l) {
          const v = m.r32(start)
          if (i === 15) { this.thumb = (v & 1) === 1; this.r[15] = v & ~1 } else this.r[i] = v
        } else m.w32(start, i === 15 ? pc + 8 : this.r[i])
        start += 4
      }
      if (w && !(l && list & (1 << rn))) this.r[rn] = (u ? base + n * 4 : base - n * 4) >>> 0
      void addr
      return
    }
    if (op1 === 5) { // b, bl
      const off = (insn << 8) >> 6
      if ((insn >>> 24) & 1) this.r[14] = pc + 4
      this.r[15] = (pc + 8 + off) >>> 0
      return
    }
    if (op1 === 7 && (insn >>> 24) & 1) { this.svc(); return }
    throw new Error(`arm: coprocessor / vfp instruction 0x${insn.toString(16)} at 0x${pc.toString(16)} is not supported yet`)
  }

  private rotImm(insn: number) {
    const rot = ((insn >>> 8) & 0xf) * 2, imm = insn & 0xff
    return rot ? ((imm >>> rot) | (imm << (32 - rot))) >>> 0 : imm
  }

  private dataProcessing(insn: number, pc: number) {
    const op = (insn >>> 21) & 0xf, s = (insn >>> 20) & 1
    const rn = (insn >>> 16) & 0xf, rd = (insn >>> 12) & 0xf
    let b: number, carry = this.C
    if ((insn >>> 25) & 1) {
      b = this.rotImm(insn)
      if ((insn >>> 8) & 0xf) carry = (b >>> 31) === 1
    } else {
      const rm = insn & 0xf, type = (insn >>> 5) & 3
      const byReg = (insn >>> 4) & 1
      const rmv = byReg && rm === 15 ? pc + 12 : this.reg(rm, pc)
      const amount = byReg ? this.r[(insn >>> 8) & 0xf] & 0xff : (insn >>> 7) & 0x1f
      ;[b, carry] = this.shift(rmv, type, amount, this.C, !!byReg)
    }
    const a = this.reg(rn, pc)
    let res: number
    const logical = () => { if (s) { this.N = (res >>> 31) === 1; this.Z = res === 0; this.C = carry } }
    switch (op) {
      case 0x0: res = (a & b) >>> 0; logical(); break
      case 0x1: res = (a ^ b) >>> 0; logical(); break
      case 0x2: res = s ? this.addFlags(a, ~b >>> 0, 1) : (a - b) >>> 0; break
      case 0x3: res = s ? this.addFlags(b, ~a >>> 0, 1) : (b - a) >>> 0; break
      case 0x4: res = s ? this.addFlags(a, b, 0) : (a + b) >>> 0; break
      case 0x5: res = s ? this.addFlags(a, b, this.C ? 1 : 0) : (a + b + (this.C ? 1 : 0)) >>> 0; break
      case 0x6: res = s ? this.addFlags(a, ~b >>> 0, this.C ? 1 : 0) : (a - b - (this.C ? 0 : 1)) >>> 0; break
      case 0x7: res = s ? this.addFlags(b, ~a >>> 0, this.C ? 1 : 0) : (b - a - (this.C ? 0 : 1)) >>> 0; break
      case 0x8: res = (a & b) >>> 0; this.N = (res >>> 31) === 1; this.Z = res === 0; this.C = carry; return
      case 0x9: res = (a ^ b) >>> 0; this.N = (res >>> 31) === 1; this.Z = res === 0; this.C = carry; return
      case 0xa: this.addFlags(a, ~b >>> 0, 1); return
      case 0xb: this.addFlags(a, b, 0); return
      case 0xc: res = (a | b) >>> 0; logical(); break
      case 0xd: res = b >>> 0; logical(); break
      case 0xe: res = (a & ~b) >>> 0; logical(); break
      default: res = ~b >>> 0; logical(); break
    }
    // writing pc from an alu op interworks on armv7 (mov pc, lr returns to thumb callers too)
    if (rd === 15) { this.thumb = (res & 1) === 1; this.r[15] = res & ~1 } else this.r[rd] = res
  }

  private loadStore(insn: number, pc: number) {
    const m = this.mem
    const p = (insn >>> 24) & 1, u = (insn >>> 23) & 1, byte = (insn >>> 22) & 1, w = (insn >>> 21) & 1, l = (insn >>> 20) & 1
    const rn = (insn >>> 16) & 0xf, rd = (insn >>> 12) & 0xf
    let off: number
    if ((insn >>> 25) & 1) { [off] = this.shift(this.r[insn & 0xf], (insn >>> 5) & 3, (insn >>> 7) & 0x1f, this.C, false) } else off = insn & 0xfff
    const base = this.reg(rn, pc)
    const offAddr = (u ? base + off : base - off) >>> 0
    const addr = p ? offAddr : base
    if (l) {
      const v = byte ? m.r8(addr) : m.r32(addr)
      if (!p || w) this.r[rn] = offAddr
      if (rd === 15) { this.thumb = (v & 1) === 1; this.r[15] = v & ~1 } else this.r[rd] = v
    } else {
      const v = rd === 15 ? pc + 8 : this.r[rd]
      if (byte) m.w8(addr, v & 0xff); else m.w32(addr, v)
      if (!p || w) this.r[rn] = offAddr
    }
  }

  private extraLoadStore(insn: number, pc: number) {
    const m = this.mem
    const p = (insn >>> 24) & 1, u = (insn >>> 23) & 1, imm = (insn >>> 22) & 1, w = (insn >>> 21) & 1, l = (insn >>> 20) & 1
    const rn = (insn >>> 16) & 0xf, rd = (insn >>> 12) & 0xf, sh = (insn >>> 5) & 3
    const off = imm ? ((insn >>> 4) & 0xf0) | (insn & 0xf) : this.r[insn & 0xf]
    const base = this.reg(rn, pc)
    const offAddr = (u ? base + off : base - off) >>> 0
    const addr = p ? offAddr : base
    if (l) {
      if (sh === 1) this.r[rd] = m.r16(addr)
      else if (sh === 2) this.r[rd] = (m.r8(addr) << 24) >> 24 >>> 0
      else this.r[rd] = ((m.r16(addr) << 16) >> 16) >>> 0
    } else {
      if (sh === 1) m.w16(addr, this.r[rd])
      else if (sh === 2) { this.r[rd] = m.r32(addr); this.r[rd + 1] = m.r32(addr + 4) } // ldrd
      else { m.w32(addr, this.r[rd]); m.w32(addr + 4, this.r[rd + 1]) } // strd
    }
    if (!p || w) this.r[rn] = offAddr
  }

  private media(insn: number) {
    const rd = (insn >>> 12) & 0xf, rm = insn & 0xf, rn = (insn >>> 16) & 0xf
    // uxtb uxth sxtb sxth (with rotation), and the add forms
    if ((insn & 0x0f8003f0) === 0x06800070) {
      const rot = ((insn >>> 10) & 3) * 8
      const v = rot ? ((this.r[rm] >>> rot) | (this.r[rm] << (32 - rot))) >>> 0 : this.r[rm]
      const kind = (insn >>> 20) & 7
      let x: number
      if (kind === 6) x = v & 0xff
      else if (kind === 7) x = v & 0xffff
      else if (kind === 2) x = (v << 24) >> 24
      else if (kind === 3) x = (v << 16) >> 16
      else if (kind === 4) x = v & 0x00ff00ff // uxtb16
      else throw new Error('arm: unsupported extend')
      this.r[rd] = ((rn === 15 ? 0 : this.r[rn]) + x) >>> 0
      return
    }
    if ((insn & 0x0fe00070) === 0x07e00050) { // ubfx
      const lsb = (insn >>> 7) & 0x1f, width = ((insn >>> 16) & 0x1f) + 1
      this.r[rd] = width === 32 ? this.r[rm] : (this.r[rm] >>> lsb) & ((1 << width) - 1)
      return
    }
    if ((insn & 0x0fe00070) === 0x07a00050) { // sbfx
      const lsb = (insn >>> 7) & 0x1f, width = ((insn >>> 16) & 0x1f) + 1
      this.r[rd] = (((this.r[rm] >>> lsb) << (32 - width)) >> (32 - width)) >>> 0
      return
    }
    if ((insn & 0x0fe00070) === 0x07c00010) { // bfi / bfc
      const lsb = (insn >>> 7) & 0x1f, msb = (insn >>> 16) & 0x1f
      const mask = (((msb - lsb + 1 === 32 ? 0xffffffff : (1 << (msb - lsb + 1)) - 1)) << lsb) >>> 0
      const src = rm === 15 ? 0 : this.r[rm] << lsb
      this.r[rd] = ((this.r[rd] & ~mask) | (src & mask)) >>> 0
      return
    }
    if ((insn & 0x0fff0ff0) === 0x06bf0f30) { const v = this.r[rm]; this.r[rd] = (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0; return } // rev
    if ((insn & 0x0fff0ff0) === 0x06bf0fb0) { const v = this.r[rm]; this.r[rd] = (((v & 0xff) << 8) | ((v >>> 8) & 0xff) | ((v & 0xff0000) << 8) | ((v >>> 8) & 0xff0000)) >>> 0; return } // rev16
    if ((insn & 0x0fff0ff0) === 0x06ff0f30) { // rbit
      let v = this.r[rm], o = 0
      for (let i = 0; i < 32; i++) { o = (o << 1) | (v & 1); v >>>= 1 }
      this.r[rd] = o >>> 0
      return
    }
    if ((insn & 0x0ff000f0) === 0x07100010 || (insn & 0x0ff000f0) === 0x07300010) { // sdiv / udiv (rn = dest here)
      const n = this.r[insn & 0xf], d = this.r[(insn >>> 8) & 0xf]
      const dest = (insn >>> 16) & 0xf
      this.r[dest] = d === 0 ? 0 : (insn & 0x00200000) ? Math.floor(n / d) >>> 0 : (((n | 0) / (d | 0)) | 0) >>> 0
      return
    }
    throw new Error(`arm: media instruction 0x${insn.toString(16)} not supported yet`)
  }

  // linux eabi syscalls (svc 0, number in r7): just enough for small libraries
  private svc() {
    const n = this.r[7]
    switch (n) {
      case 4: { // write(fd, buf, len)
        const s = new TextDecoder().decode(this.mem.u8.subarray(this.r[1], this.r[1] + this.r[2]))
        console.log('[native]', s)
        this.r[0] = this.r[2]
        return
      }
      case 20: case 224: this.r[0] = 1000; return // getpid, gettid
      case 1: case 248: throw new Error('arm: native code called exit')
      default: this.r[0] = (-38) >>> 0 // ENOSYS
    }
  }
}

function popcount(x: number) { let n = 0; while (x) { n += x & 1; x >>>= 1 } return n }
