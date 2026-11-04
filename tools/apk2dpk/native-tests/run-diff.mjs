// runs the arm / thumb builds of diff.c on droid's emulator and compares with the host's output
import fs from 'node:fs'
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { Vfs } from '../../../src/runtime/android/javaio.ts'
import { Native } from '../../../src/runtime/android/arm/native.ts'
const want = fs.readFileSync(new URL('./diff-expected.txt', import.meta.url), 'utf8').trim().split('\n')
let ok = true
for (const v of ['arm-O0', 'arm-O2', 'thumb-O0', 'thumb-O2']) {
  const vm = new VM(); registerJava(vm)
  const nat = new Native(vm, new Vfs(), 'test')
  const lib = nat.load('libdiff.so', new Uint8Array(fs.readFileSync(new URL(`./libdiff-${v}.so`, import.meta.url))))
  const out = nat.mem.malloc(4096)
  let got = []
  try { nat.cpu.call(lib.exports.get('diff_test'), [out, 4096]); got = nat.mem.cstr(out).trim().split('\n') } catch (e) { console.log(v, 'crashed:', e.message); ok = false; continue }
  const bad = want.filter((w, i) => got[i] !== w).map((w) => w.split(' ')[0])
  console.log(v.padEnd(9), bad.length ? 'DIFFERS in ' + bad.join(', ') : 'same', nat.missing.size ? 'missing: ' + [...nat.missing].join(', ') : '')
  if (bad.length) ok = false
}
console.log(ok ? 'ALL OK' : 'SOME DIFFER')
