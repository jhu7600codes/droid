// droid's zlib inflate() (libc.ts) driven the way libpng and friends drive it: input in chunks,
// output a row at a time, Z_PARTIAL_FLUSH, then the end of the stream
import zlib from 'node:zlib'
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { Vfs } from '../../../src/runtime/android/javaio.ts'
import { Native } from '../../../src/runtime/android/arm/native.ts'
const vm = new VM(); registerJava(vm)
const nat = new Native(vm, new Vfs(), 'test'), m = nat.mem
const call = (name, ...a) => nat.cpu.call(nat.resolve(name), a).r0 | 0
let fails = 0
for (const [size, chunk, row, mode] of [[100000, 8192, 1001, 'zlib'], [5000, 1, 7, 'zlib'], [300000, 65536, 4096, 'gzip'], [70000, 333, 70000, 'raw'], [1, 10, 1, 'zlib']]) {
  const src = new Uint8Array(size); for (let i = 0; i < size; i++) src[i] = (i * 31 + (i >> 7)) % (i % 5 ? 256 : 7)
  const comp = new Uint8Array(mode === 'zlib' ? zlib.deflateSync(src) : mode === 'gzip' ? zlib.gzipSync(src) : zlib.deflateRawSync(src))
  const zs = m.malloc(64); m.u8.fill(0, zs, zs + 64)
  call('inflateInit2_', zs, mode === 'zlib' ? 15 : mode === 'gzip' ? 31 : -15, 0, 56)
  const inb = m.malloc(comp.length + 1), outb = m.malloc(size + 16)
  m.u8.set(comp, inb)
  let fed = 0, got = 0, ret = 0, guard = 0
  m.w32(zs + 12, outb); m.w32(zs + 16, 0)
  while (guard++ < 1e6) {
    if (!m.r32(zs + 4) && fed < comp.length) { const k = Math.min(chunk, comp.length - fed); m.w32(zs, inb + fed); m.w32(zs + 4, k); fed += k }
    m.w32(zs + 16, Math.min(row, size - got)); m.w32(zs + 12, outb + got)
    const before = m.r32(zs + 16)
    ret = call('inflate', zs, 1)
    got += before - m.r32(zs + 16)
    if (ret === 1) break
    if (ret !== 0 && ret !== -5) break
    if (ret === -5 && fed >= comp.length) break
  }
  const out = m.u8.slice(outb, outb + got)
  const ok = got === size && out.every((v, i) => v === src[i]) && ret === 1
  if (!ok) { fails++; console.log('FAIL', { size, chunk, row, mode, got, ret, fed, total: comp.length }) }
}
console.log(fails ? 'SOME FAILED' : 'ALL OK')
