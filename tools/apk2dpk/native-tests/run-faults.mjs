// runs native-tests/libfaults-{arm,thumb}.so: null pointer faults reaching SIGSEGV handlers
import fs from 'node:fs'
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { Vfs } from '../../../src/runtime/android/javaio.ts'
import { Native } from '../../../src/runtime/android/arm/native.ts'
let all = true
for (const mode of ['arm', 'thumb']) {
  const vm = new VM(); registerJava(vm)
  const nat = new Native(vm, new Vfs(), 'test')
  const lib = nat.load('libfaults.so', new Uint8Array(fs.readFileSync(new URL(`./libfaults-${mode}.so`, import.meta.url))))
  const out = nat.mem.malloc(512)
  let r = 0
  try { r = nat.cpu.call(lib.exports.get('faults_test'), [out, 512]).r0 } catch (e) { console.log(mode, 'crashed:', e.message) }
  console.log(mode + ':', nat.mem.cstr(out).trim(), r ? 'OK' : 'FAILED', 'frames left', nat.cpu.faultFrames.size)
  if (!r) all = false
}
console.log(all ? 'ALL OK' : 'SOME FAILED')
