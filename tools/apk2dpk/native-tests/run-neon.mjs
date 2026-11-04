// runs native-tests/libneon-{arm,thumb}.so (neon intrinsics vs scalar references) on droid's arm runtime
import fs from 'node:fs'
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { Vfs } from '../../../src/runtime/android/javaio.ts'
import { Native } from '../../../src/runtime/android/arm/native.ts'
let ok = true
for (const mode of ['arm', 'thumb']) {
  const vm = new VM()
  registerJava(vm)
  const nat = new Native(vm, new Vfs(), 'test')
  const lib = nat.load('libneon.so', new Uint8Array(fs.readFileSync(new URL(`./libneon-${mode}.so`, import.meta.url))))
  const out = nat.mem.malloc(16384)
  let r = 0
  try { r = nat.cpu.call(lib.exports.get('neon_test'), [out, 16384]).r0 } catch (e) { console.log(mode, 'crashed:', e.message) }
  console.log(mode + ':', nat.mem.cstr(out).trim())
  if (!r) ok = false
}
console.log(ok ? 'ALL OK' : 'SOME FAILED')
