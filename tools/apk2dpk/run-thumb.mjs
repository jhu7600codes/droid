// runs test.apk's java code against a thumb-2 build of libhello.so (path as argument)
import fs from 'node:fs'
import { listZip, readEntry } from '../../src/runtime/zip.ts'
import { parseDex } from '../../src/runtime/android/dex.ts'
import { VM } from '../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../src/runtime/android/java.ts'
import { Native } from '../../src/runtime/android/arm/native.ts'
const buf = fs.readFileSync('tools/apk2dpk/test.apk')
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
const files = new Map()
for (const e of listZip(ab)) files.set(e.path, await readEntry(ab, e))
const vm = new VM(); registerJava(vm)
vm.shim('Landroid/app/Activity;', { super: 'Ljava/lang/Object;', methods: { '<init>()V': () => {} } })
vm.addDex(parseDex(files.get('classes.dex')))
const nat = new Native(vm); vm.natives = (m, s, a) => nat.call(m, s, a)
nat.load('libhello.so', fs.readFileSync(process.argv[2]))
const act = vm.newObject('Lcom/droid/hellojni/MainActivity;')
const r = [vm.callVirtual(act, 'stringFromJNI()Ljava/lang/String;'), vm.callVirtual(act, 'add(II)I', [2, 3]), vm.callVirtual(act, 'fib(I)J', [40])]
console.log(process.argv[2].split('/').pop(), r.join(' | '), '| arm steps', nat.cpu.steps)
