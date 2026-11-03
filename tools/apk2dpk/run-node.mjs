// smoke test without a browser: java code and the arm library of test.apk, run in node
import fs from 'node:fs'
import { listZip, readEntry } from '../../src/runtime/zip.ts'
import { parseDex } from '../../src/runtime/android/dex.ts'
import { VM, JObject } from '../../src/runtime/android/dalvik.ts'
import { registerJava, jstr } from '../../src/runtime/android/java.ts'
import { Native } from '../../src/runtime/android/arm/native.ts'
const buf = fs.readFileSync(process.argv[2] || 'tools/apk2dpk/test.apk')
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
const files = new Map()
for (const e of listZip(ab)) files.set(e.path, await readEntry(ab, e))
const vm = new VM()
registerJava(vm)
vm.shim('Landroid/app/Activity;', { super: 'Ljava/lang/Object;', methods: { '<init>()V': () => {} } })
vm.addDex(parseDex(files.get('classes.dex')))
const nat = new Native(vm)
vm.natives = (m, self, args) => nat.call(m, self, args)
nat.load('libhello.so', files.get('lib/armeabi-v7a/libhello.so'))
const A = 'Lcom/droid/hellojni/MainActivity;'
const act = vm.newObject(A)
const call = (key, args = []) => vm.callVirtual(act, key, args)
console.log('javaWork  :', call('javaWork()Ljava/lang/String;'))
console.log('jni string:', call('stringFromJNI()Ljava/lang/String;'))
console.log('jni add   :', call('add(II)I', [2, 3]))
console.log('jni fib40 :', call('fib(I)J', [40]))
console.log('steps     : dalvik', vm.steps, 'arm', nat.cpu.steps, '| missing', [...vm.missing, ...nat.missing].join(', ') || 'none')
