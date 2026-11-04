// node run-detail.mjs lib.so want.txt: runs diff_test of a DETAIL build, prints the first differences
import fs from 'node:fs'
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { Vfs } from '../../../src/runtime/android/javaio.ts'
import { Native } from '../../../src/runtime/android/arm/native.ts'
const vm = new VM(); registerJava(vm)
const nat = new Native(vm, new Vfs(), 'test')
const lib = nat.load('libone.so', new Uint8Array(fs.readFileSync(process.argv[2])))
const size = 4 << 20, out = nat.mem.malloc(size)
nat.cpu.call(lib.exports.get('diff_test'), [out, size])
const got = nat.mem.cstr(out).split('\n'), want = fs.readFileSync(process.argv[3], 'utf8').split('\n')
let shown = 0
for (let i = 0; i < want.length && shown < 6; i++) if (got[i] !== want[i]) { console.log(`#${i} line ${want[i].split(' ')[0]}: want ${want[i].split(' ')[1]} got ${got[i]}`); shown++ }
if (!shown) console.log('same', want.length, 'values')
