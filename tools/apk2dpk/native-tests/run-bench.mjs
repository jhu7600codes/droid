// times native-tests/libbench.so on droid's arm runtime (NOJIT=1 for the interpreter alone)
import fs from 'node:fs'
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { Vfs } from '../../../src/runtime/android/javaio.ts'
import { Native } from '../../../src/runtime/android/arm/native.ts'
const vm = new VM(); registerJava(vm)
const nat = new Native(vm, new Vfs(), 'test')
const lib = nat.load('libbench.so', new Uint8Array(fs.readFileSync(new URL('./libbench.so', import.meta.url))))
const names = ['crc', 'insertion sort', 'float dot', 'fib(24)']
for (let w = 0; w < 4; w++) {
  const s0 = nat.cpu.steps, t = performance.now()
  const r = nat.cpu.call(lib.exports.get('bench'), [w]).r0
  const ms = performance.now() - t
  console.log(`${names[w].padEnd(15)} ${ms.toFixed(0).padStart(6)} ms  result ${r >>> 0}`)
}
console.log('compiled blocks:', nat.cpu.jit?.compiled ?? 'jit off')
