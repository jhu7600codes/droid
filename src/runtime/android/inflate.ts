// synchronous raw-deflate decoder (rfc 1951), for zip entries java code reads synchronously
// (AssetManager.open, native fopen of apk assets). small and plain, after the classic tinf design.

class Tree { counts = new Uint16Array(16); symbols = new Uint16Array(288) }
const lenBase = new Uint16Array(30), lenBits = new Uint8Array(30), distBase = new Uint16Array(30), distBits = new Uint8Array(30)
function bases(bits: Uint8Array, base: Uint16Array, delta: number, first: number) {
  for (let i = 0; i < delta; i++) bits[i] = 0
  for (let i = 0; i < 30 - delta; i++) bits[i + delta] = (i / delta) | 0
  for (let sum = first, i = 0; i < 30; i++) { base[i] = sum; sum += 1 << bits[i] }
}
bases(lenBits, lenBase, 4, 3)
bases(distBits, distBase, 2, 1)
lenBits[28] = 0; lenBase[28] = 258
const fixedLit = new Tree(), fixedDist = new Tree()
;(() => {
  const l = new Uint8Array(288)
  for (let i = 0; i < 144; i++) l[i] = 8
  for (let i = 144; i < 256; i++) l[i] = 9
  for (let i = 256; i < 280; i++) l[i] = 7
  for (let i = 280; i < 288; i++) l[i] = 8
  build(fixedLit, l, 0, 288)
  const d = new Uint8Array(30).fill(5)
  build(fixedDist, d, 0, 30)
})()
function build(t: Tree, lengths: Uint8Array, off: number, num: number) {
  t.counts.fill(0)
  for (let i = 0; i < num; i++) t.counts[lengths[off + i]]++
  t.counts[0] = 0
  const offs = new Uint16Array(16)
  for (let sum = 0, i = 0; i < 16; i++) { offs[i] = sum; sum += t.counts[i] }
  for (let i = 0; i < num; i++) if (lengths[off + i]) t.symbols[offs[lengths[off + i]]++] = i
}

class Reader {
  src: Uint8Array; pos = 0; tag = 0; bits = 0
  out: Uint8Array; n = 0
  constructor(src: Uint8Array, size: number) { this.src = src; this.out = new Uint8Array(size || src.length * 4 + 1024) }
  bit() { if (!this.bits--) { this.tag = this.src[this.pos++] ?? 0; this.bits = 7 } const b = this.tag & 1; this.tag >>>= 1; return b }
  read(num: number, base: number) { let v = 0; for (let i = 0; i < num; i++) v |= this.bit() << i; return v + base }
  sym(t: Tree) {
    let sum = 0, cur = 0, len = 0
    do { cur = 2 * cur + this.bit(); len++; sum += t.counts[len]; cur -= t.counts[len] } while (cur >= 0)
    return t.symbols[sum + cur]
  }
  push(b: number) { if (this.n >= this.out.length) { const o = new Uint8Array(this.out.length * 2); o.set(this.out); this.out = o } this.out[this.n++] = b }
}
const clcIndex = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
function dynamic(r: Reader, lt: Tree, dt: Tree) {
  const lengths = new Uint8Array(288 + 32)
  const hlit = r.read(5, 257), hdist = r.read(5, 1), hclen = r.read(4, 4)
  for (let i = 0; i < 19; i++) lengths[i] = 0
  for (let i = 0; i < hclen; i++) lengths[clcIndex[i]] = r.read(3, 0)
  const code = new Tree()
  build(code, lengths, 0, 19)
  for (let num = 0; num < hlit + hdist;) {
    const s = r.sym(code)
    if (s === 16) { const prev = lengths[num - 1]; for (let k = r.read(2, 3); k; k--) lengths[num++] = prev }
    else if (s === 17) { for (let k = r.read(3, 3); k; k--) lengths[num++] = 0 }
    else if (s === 18) { for (let k = r.read(7, 11); k; k--) lengths[num++] = 0 }
    else lengths[num++] = s
  }
  build(lt, lengths, 0, hlit)
  build(dt, lengths, hlit, hdist)
}
function block(r: Reader, lt: Tree, dt: Tree) {
  for (;;) {
    const s = r.sym(lt)
    if (s === 256) return
    if (s < 256) { r.push(s); continue }
    const i = s - 257
    const len = r.read(lenBits[i], lenBase[i])
    const d = r.sym(dt)
    const off = r.n - r.read(distBits[d], distBase[d])
    for (let k = 0; k < len; k++) r.push(r.out[off + k])
  }
}
export function inflateRawSync(src: Uint8Array, size = 0): Uint8Array {
  const r = new Reader(src, size)
  let last
  do {
    last = r.bit()
    const type = r.read(2, 0)
    if (type === 0) {
      // stored: align to the byte, len, ~len, then raw bytes
      r.bits = 0
      const len = r.src[r.pos] | (r.src[r.pos + 1] << 8)
      r.pos += 4
      for (let i = 0; i < len; i++) r.push(r.src[r.pos++])
    } else if (type === 1) block(r, fixedLit, fixedDist)
    else if (type === 2) { const lt = new Tree(), dt = new Tree(); dynamic(r, lt, dt); block(r, lt, dt) }
    else throw new Error('inflate: bad block type')
  } while (!last)
  return r.n === r.out.length ? r.out : r.out.subarray(0, r.n)
}
