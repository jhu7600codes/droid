// raw-deflate decoder (rfc 1951), synchronous and streaming: zip entries java reads synchronously
// (AssetManager.open, native fopen of apk assets) and zlib's inflate() for native code, which feeds
// input in pieces and takes output in pieces. input can stop anywhere: the decoder goes back to the
// last symbol it finished and waits for more. it never reads past what it was given.

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
const clcIndex = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
const NEED = Symbol('need input')
const WINDOW = 32768

export class Inflater {
  // input not yet decoded (src[pos..len]), plus the bit buffer
  private src = new Uint8Array(4096); private len = 0; private pos = 0
  private buf = 0; private cnt = 0
  // output: out[0..n]; the reader takes from `read`; everything before keeps only a 32k window
  out = new Uint8Array(65536); n = 0; read = 0
  done = false
  private state: 'header' | 'stored' | 'codes' = 'header'
  private last = 0
  private storedLeft = 0
  private lt: Tree = fixedLit; private dt: Tree = fixedDist

  push(b: Uint8Array) {
    if (!b.length) return
    if (this.len + b.length > this.src.length) {
      // drop what was decoded already; grow if that is not enough
      const keep = this.len - this.pos
      if (keep + b.length <= this.src.length) this.src.copyWithin(0, this.pos, this.len)
      else { const o = new Uint8Array(Math.max(this.src.length * 2, keep + b.length)); o.set(this.src.subarray(this.pos, this.len)); this.src = o }
      this.len = keep; this.pos = 0
    }
    this.src.set(b, this.len); this.len += b.length
  }
  // gives back the last k pushed bytes not decoded yet (at most what is still waiting); returns how many
  unpush(k: number) { const n = Math.min(k, this.len - this.pos); this.len -= n; return n }
  // bytes given but not used by the stream (after it ended: what follows it, e.g. a zlib/gzip trailer)
  get unused() { return this.len - this.pos + (this.cnt >> 3) }

  private need(k: number) {
    while (this.cnt < k) {
      if (this.pos >= this.len) throw NEED
      this.buf |= this.src[this.pos++] << this.cnt; this.cnt += 8
    }
  }
  private bits(k: number) {
    if (!k) return 0
    this.need(k)
    const v = this.buf & ((1 << k) - 1)
    this.buf >>>= k; this.cnt -= k
    return v
  }
  private sym(t: Tree) {
    let sum = 0, cur = 0, len = 0
    do {
      if (!this.cnt) this.need(1)
      cur = 2 * cur + (this.buf & 1); this.buf >>>= 1; this.cnt--
      len++; sum += t.counts[len]; cur -= t.counts[len]
      if (len > 15) throw new Error('inflate: bad code')
    } while (cur >= 0)
    return t.symbols[sum + cur]
  }
  private room(k: number) {
    if (this.n + k <= this.out.length) return
    // drop what the reader took, keeping a window for back references
    const drop = Math.max(0, Math.min(this.read, this.n - WINDOW))
    if (drop > 0 && this.n - drop + k <= this.out.length) { this.out.copyWithin(0, drop, this.n); this.n -= drop; this.read -= drop; return }
    const o = new Uint8Array(Math.max(this.out.length * 2, this.n - drop + k + WINDOW))
    o.set(this.out.subarray(drop, this.n)); this.out = o; this.n -= drop; this.read -= drop
  }
  // save/restore of the reading position, so running out of input can go back to a whole symbol
  private mark() { return [this.pos, this.buf, this.cnt] as const }
  private back(m: readonly [number, number, number]) { this.pos = m[0]; this.buf = m[1]; this.cnt = m[2] }

  // decodes as far as the input goes; stops early once `limit` bytes are waiting to be read.
  // true once the final block ended
  run(limit = Infinity): boolean {
    while (!this.done) {
      if (this.n - this.read >= limit) return false
      const m = this.mark()
      try {
        if (this.state === 'header') {
          const last = this.bits(1), type = this.bits(2)
          if (type === 0) {
            this.buf >>>= this.cnt & 7; this.cnt -= this.cnt & 7
            const ln = this.bits(16), nl = this.bits(16)
            if ((ln ^ 0xffff) !== nl) throw new Error('inflate: bad stored block')
            this.last = last; this.storedLeft = ln; this.state = 'stored'
          } else if (type === 1) { this.last = last; this.lt = fixedLit; this.dt = fixedDist; this.state = 'codes' }
          else if (type === 2) { this.dynamic(); this.last = last; this.state = 'codes' }
          else throw new Error('inflate: bad block type')
        } else if (this.state === 'stored') {
          // whole bytes: the bit buffer is byte aligned here
          while (this.storedLeft > 0 && this.cnt >= 8) { this.room(1); this.out[this.n++] = this.buf & 0xff; this.buf >>>= 8; this.cnt -= 8; this.storedLeft-- }
          const k = Math.min(this.storedLeft, this.len - this.pos)
          if (k > 0) { this.room(k); this.out.set(this.src.subarray(this.pos, this.pos + k), this.n); this.n += k; this.pos += k; this.storedLeft -= k }
          if (this.storedLeft > 0) return false
          this.endBlock()
        } else {
          for (let i = 0; i < 4096; i++) {
            if (this.n - this.read >= limit) return false
            const mm = this.mark()
            try {
              const s = this.sym(this.lt)
              if (s === 256) { this.endBlock(); break }
              if (s < 256) { this.room(1); this.out[this.n++] = s; continue }
              const li = s - 257
              if (li >= 29) throw new Error('inflate: bad length')
              const len = lenBase[li] + this.bits(lenBits[li])
              const d = this.sym(this.dt)
              if (d >= 30) throw new Error('inflate: bad distance')
              const dist = distBase[d] + this.bits(distBits[d])
              this.room(len)
              let from = this.n - dist
              if (from < 0) throw new Error('inflate: distance too far back')
              const o = this.out
              for (let k = 0; k < len; k++) o[this.n++] = o[from++]
            } catch (e) { if (e === NEED) { this.back(mm); return false } throw e }
          }
        }
      } catch (e) { if (e === NEED) { this.back(m); return false } throw e }
    }
    return true
  }
  private endBlock() { this.state = 'header'; if (this.last) this.done = true }
  private dynamic() {
    const lengths = new Uint8Array(288 + 32)
    const hlit = this.bits(5) + 257, hdist = this.bits(5) + 1, hclen = this.bits(4) + 4
    for (let i = 0; i < hclen; i++) lengths[clcIndex[i]] = this.bits(3)
    const code = new Tree()
    build(code, lengths, 0, 19)
    const all = new Uint8Array(hlit + hdist)
    for (let num = 0; num < hlit + hdist;) {
      const s = this.sym(code)
      if (s === 16) { if (!num) throw new Error('inflate: bad lengths'); const prev = all[num - 1]; for (let k = this.bits(2) + 3; k; k--) all[num++] = prev }
      else if (s === 17) { for (let k = this.bits(3) + 3; k; k--) all[num++] = 0 }
      else if (s === 18) { for (let k = this.bits(7) + 11; k; k--) all[num++] = 0 }
      else all[num++] = s
    }
    const lt = new Tree(), dt = new Tree()
    build(lt, all, 0, hlit)
    build(dt, all, hlit, hdist)
    this.lt = lt; this.dt = dt
  }
  // hands out up to k decoded bytes
  take(k: number) {
    const e = Math.min(this.n, this.read + k)
    const v = this.out.subarray(this.read, e)
    this.read = e
    return v
  }
}

export function inflateRawSync(src: Uint8Array, size = 0): Uint8Array {
  const z = new Inflater()
  if (size) z.out = new Uint8Array(size + 1)
  z.push(src)
  if (!z.run()) throw new Error('inflate: data ends early')
  return z.out.slice(0, z.n)
}
