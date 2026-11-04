// streaming inflater vs node's zlib: whole buffers, byte-by-byte feeding, small reads, truncation
import zlib from 'node:zlib'
import { Inflater, inflateRawSync } from '../../../src/runtime/android/inflate.ts'
let fails = 0
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m) } }
const rnd = (n, seed) => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = (x >>> 16) % (i % 7 === 0 ? 256 : 12) } return b }
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
for (const [n, lvl] of [[0, 6], [1, 6], [1000, 0], [70000, 1], [300000, 9], [2000000, 6]]) {
  const src = rnd(n, n + lvl), d = new Uint8Array(zlib.deflateRawSync(src, { level: lvl }))
  ok(eq(inflateRawSync(d), src), `whole ${n}/${lvl}`)
  for (const step of [1, 7, 4096]) {
    if (step === 1 && n > 300000) continue
    const z = new Inflater(), got = []
    for (let i = 0; i < d.length; i += step) { z.push(d.subarray(i, i + step)); z.run(8192); for (let t; (t = z.take(5000)).length;) { got.push(t.slice()); z.run(8192) } }
    while (!z.done && z.run(8192) !== undefined) { const t = z.take(5000); if (!t.length && !z.done) break; got.push(t.slice()) }
    for (let t; (t = z.take(1 << 20)).length;) got.push(t.slice())
    const all = Buffer.concat(got)
    ok(z.done && eq(new Uint8Array(all), src), `stream ${n}/${lvl} step ${step} (${all.length})`)
  }
  if (d.length > 10) { let threw = false; try { inflateRawSync(d.subarray(0, d.length >> 1)) } catch { threw = true } ok(threw, `truncated ${n}`) }
}
// trailing bytes after the stream are left unused
{ const src = rnd(5000, 3), d = new Uint8Array([...zlib.deflateRawSync(src), 1, 2, 3, 4]); const z = new Inflater(); z.push(d); ok(z.run() && z.unused === 4, 'unused ' + z.unused) }
console.log(fails ? `${fails} FAILED` : 'ALL OK')
