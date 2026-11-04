// runs native-tests/libnt.so on droid's arm runtime in node (threads, signals, stdio, files...)
import fs from 'node:fs'
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { Vfs } from '../../../src/runtime/android/javaio.ts'
import { Native } from '../../../src/runtime/android/arm/native.ts'
const vm = new VM()
registerJava(vm)
const nat = new Native(vm, new Vfs(), 'test')
const lib = nat.load('libnt.so', new Uint8Array(fs.readFileSync(new URL('./libnt.so', import.meta.url))))
const out = nat.mem.malloc(4096)
const t = performance.now()
const { r0 } = nat.cpu.call(lib.exports.get('threads_test'), [out, 4096])
console.log(nat.mem.cstr(out))
console.log(r0 ? 'ALL OK' : 'SOME FAILED', `(${Math.round(performance.now() - t)} ms, ${nat.cpu.steps} arm steps)`, nat.missing.size ? 'missing: ' + [...nat.missing].join(', ') : '')
