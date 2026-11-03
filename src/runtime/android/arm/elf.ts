// elf32 arm shared object loader: maps PT_LOAD segments, applies relocations (relative, abs32,
// glob_dat, jump_slot), resolves imports against other loaded libraries and the host (libc, liblog),
// runs init arrays. the runtime then looks up Java_* symbols and JNI_OnLoad.
import type { CPU } from './cpu.ts'

export interface Lib { name: string; base: number; exports: Map<string, number>; init: number[] }
export type Resolver = (name: string, isData: boolean) => number

export function loadElf(cpu: CPU, name: string, bytes: Uint8Array, resolve: Resolver, missing: Set<string>): Lib {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (d.getUint32(0) !== 0x7f454c46) throw new Error(`${name}: not an elf file`)
  if (bytes[4] !== 1) throw new Error(`${name}: only 32-bit libraries (armeabi-v7a) are supported`)
  if (d.getUint16(18, true) !== 40) throw new Error(`${name}: not an arm library`)
  const phoff = d.getUint32(28, true), phnum = d.getUint16(44, true), phentsize = d.getUint16(42, true)
  const segs: { type: number; off: number; vaddr: number; filesz: number; memsz: number }[] = []
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize
    segs.push({ type: d.getUint32(o, true), off: d.getUint32(o + 4, true), vaddr: d.getUint32(o + 8, true), filesz: d.getUint32(o + 16, true), memsz: d.getUint32(o + 20, true) })
  }
  const loads = segs.filter((s) => s.type === 1)
  const size = Math.max(...loads.map((s) => s.vaddr + s.memsz))
  const mem = cpu.mem
  const base = (mem.brk + 0xfff) & ~0xfff
  mem.brk = (base + size + 0xfff) & ~0xfff
  if (mem.brk > mem.heapTop) mem.heapTop = mem.brk
  for (const s of loads) mem.u8.set(bytes.subarray(s.off, s.off + s.filesz), base + s.vaddr)

  // dynamic section
  const dyn = segs.find((s) => s.type === 2)
  const tags = new Map<number, number[]>()
  if (dyn) {
    for (let o = dyn.off; o < dyn.off + dyn.filesz; o += 8) {
      const tag = d.getInt32(o, true), val = d.getUint32(o + 4, true)
      if (tag === 0) break
      if (!tags.has(tag)) tags.set(tag, [])
      tags.get(tag)!.push(val)
    }
  }
  const t = (tag: number) => tags.get(tag)?.[0]
  const fileOff = (vaddr: number) => { const s = loads.find((x) => vaddr >= x.vaddr && vaddr < x.vaddr + x.filesz); return s ? vaddr - s.vaddr + s.off : -1 }
  const strtab = fileOff(t(5) ?? 0), symtab = fileOff(t(6) ?? 0)
  const str = (o: number) => { let e = strtab + o; while (bytes[e]) e++; return new TextDecoder().decode(bytes.subarray(strtab + o, e)) }
  // symbol count: from DT_HASH (nchain), or by walking DT_GNU_HASH
  let nsyms = 0
  if (t(4) != null) nsyms = d.getUint32(fileOff(t(4)!) + 4, true)
  else if (t(0x6ffffef5) != null) {
    const h = fileOff(t(0x6ffffef5)!)
    const nbuckets = d.getUint32(h, true), symoffset = d.getUint32(h + 4, true), bloomSize = d.getUint32(h + 8, true)
    const buckets = h + 16 + bloomSize * 4
    let max = symoffset
    for (let i = 0; i < nbuckets; i++) max = Math.max(max, d.getUint32(buckets + i * 4, true))
    const chains = buckets + nbuckets * 4
    while (max >= symoffset && !(d.getUint32(chains + (max - symoffset) * 4, true) & 1)) max++
    nsyms = max + 1
  }
  const syms: { name: string; value: number; shndx: number; type: number }[] = []
  for (let i = 0; i < nsyms; i++) {
    const o = symtab + i * 16
    syms.push({ name: str(d.getUint32(o, true)), value: d.getUint32(o + 4, true), type: bytes[o + 12] & 0xf, shndx: d.getUint16(o + 14, true) })
  }
  const exports = new Map<string, number>()
  for (const s of syms) if (s.shndx !== 0 && s.name) exports.set(s.name, (base + s.value) >>> 0)

  const symAddr = (i: number) => {
    const s = syms[i]
    if (!s) return 0
    if (s.shndx !== 0) return (base + s.value) >>> 0
    const a = resolve(s.name, s.type === 1)
    if (!a) missing.add(`${name}: ${s.name}`)
    return a
  }
  const applyRel = (vaddr: number, sz: number, ent: number, rela: boolean) => {
    const o0 = fileOff(vaddr)
    for (let o = o0; o < o0 + sz; o += ent) {
      const off = d.getUint32(o, true), info = d.getUint32(o + 4, true)
      const type = info & 0xff, sym = info >>> 8
      const where = base + off
      const addend = rela ? d.getInt32(o + 8, true) : mem.r32(where)
      switch (type) {
        case 23: mem.w32(where, base + addend); break // R_ARM_RELATIVE
        case 2: mem.w32(where, symAddr(sym) + addend); break // R_ARM_ABS32
        case 21: case 22: mem.w32(where, symAddr(sym) + (rela ? addend : 0)); break // GLOB_DAT, JUMP_SLOT
        case 0: break
        default: missing.add(`${name}: relocation type ${type}`)
      }
    }
  }
  if (t(17) != null) applyRel(t(17)!, t(18) ?? 0, t(19) ?? 8, false) // DT_REL
  if (t(7) != null) applyRel(t(7)!, t(8) ?? 0, t(9) ?? 12, true) // DT_RELA
  if (t(23) != null) applyRel(t(23)!, t(2) ?? 0, t(20) === 7 ? 12 : 8, t(20) === 7) // DT_JMPREL

  const init: number[] = []
  if (t(12)) init.push(base + t(12)!)
  if (t(25) != null) { const a = base + t(25)!; for (let i = 0; i < (t(27) ?? 0) / 4; i++) { const f = mem.r32(a + i * 4); if (f && f !== 0xffffffff) init.push(f) } }
  return { name, base, exports, init }
}
