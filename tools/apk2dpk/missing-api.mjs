// lists the framework methods an apk's code calls that droid's shims don't have yet, grouped by
// class and sorted by how many call sites use them. usage: node tools/apk2dpk/missing-api.mjs app.apk [prefix-filter]
import fs from 'node:fs'
import { listZip, readEntry } from '../../src/runtime/zip.ts'
import { parseDex } from '../../src/runtime/android/dex.ts'
import { parseArsc } from '../../src/runtime/android/arsc.ts'
import { VM } from '../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../src/runtime/android/java.ts'
import { Vfs, registerJavaIo } from '../../src/runtime/android/javaio.ts'
import { registerReflect } from '../../src/runtime/android/reflect.ts'
import { registerConcurrent } from '../../src/runtime/android/concurrent.ts'
import { registerAndroid } from '../../src/runtime/android/android.ts'

const buf = fs.readFileSync(process.argv[2])
const only = process.argv[3] || ''
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
const files = new Map()
for (const e of listZip(ab)) if (/^(classes\d*\.dex|resources\.arsc)$/.test(e.path)) files.set(e.path, await readEntry(ab, e))
globalThis.document ??= { createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, append() {}, addEventListener() {}, setAttribute() {} }) }
const vm = new VM()
registerJava(vm)
registerJavaIo(vm, new Vfs())
registerReflect(vm)
registerConcurrent(vm)
const fake = new Proxy({}, { get: () => () => Promise.resolve() })
registerAndroid(vm, { vfs: new Vfs(), pkg: 'x', files, res: parseArsc(files.get('resources.arsc')), root: document.createElement('div'), droid: { system: fake, app: fake, prefs: fake, background: fake, media: fake, device: fake }, prefs: new Map(), density: 2, landscape: false, lang: 'en', intent: {}, self: 'main', activityFor: () => null })
const dexes = [...files.keys()].filter((k) => k.endsWith('.dex')).map((k) => parseDex(files.get(k)))
const defined = new Set(dexes.flatMap((d) => d.classes.map((c) => c.name)))
const W = {}
for (let o = 0; o < 256; o++) W[o] = 1
for (const o of [0x02, 0x05, 0x08, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c, 0x1f, 0x20, 0x22, 0x23, 0x29, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d]) W[o] = 2
for (let o = 0x44; o <= 0x6d; o++) W[o] = 2
for (let o = 0x90; o <= 0xaf; o++) W[o] = 2
for (let o = 0xd0; o <= 0xe2; o++) W[o] = 2
for (const o of [0x03, 0x06, 0x09, 0x14, 0x17, 0x1b, 0x24, 0x25, 0x26, 0x2a, 0x2b, 0x2c]) W[o] = 3
for (let o = 0x6e; o <= 0x78; o++) W[o] = 3
W[0x18] = 5
// count call sites per method ref (invoke-* opcodes 0x6e..0x72, 0x74..0x78)
const uses = new Map()
for (const d of dexes) for (const c of d.classes) {
  if (only && !c.name.startsWith(only)) continue
  for (const m of [...c.directMethods, ...c.virtualMethods]) {
    const ins = m.code?.insns
    if (!ins) continue
    for (let pc = 0; pc < ins.length;) {
      const op = ins[pc] & 0xff
      if ((op >= 0x6e && op <= 0x72) || (op >= 0x74 && op <= 0x78)) { const r = d.methods[ins[pc + 1]]; const k = r.cls + '->' + r.key; uses.set(k, (uses.get(k) || 0) + 1) }
      pc += width(op, ins, pc)
    }
  }
}
function width(op, ins, pc) {
  if (op === 0x00) { const id = ins[pc]; if (id === 0x100) return 4 + ins[pc + 1] * 2; if (id === 0x200) return 2 + ins[pc + 1] * 4; if (id === 0x300) return 4 + Math.ceil((ins[pc + 1] * (ins[pc + 2] | (ins[pc + 3] << 16))) / 2); return 1 }
  return W[op] ?? 1
}
// is it covered: the class (or a super shim) has the method key
const covered = (cls, key) => {
  for (let c = vm.shims.has(cls) ? cls : null; c; c = vm.shims.get(c)?.super) if (vm.shims.get(c)?.methods?.[key]) return true
  return false
}
const out = new Map()
for (const [k, n] of uses) {
  const [cls, key] = k.split('->')
  if (defined.has(cls) || covered(cls, key)) continue
  if (!out.has(cls)) out.set(cls, [])
  out.get(cls).push([key, n])
}
const rows = [...out].sort((a, b) => b[1].reduce((s, x) => s + x[1], 0) - a[1].reduce((s, x) => s + x[1], 0))
for (const [cls, ms] of rows) console.log(cls + (vm.shims.has(cls) ? '' : '  (no shim)') + '\n  ' + ms.sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join('\n  '))
console.log(`\n${rows.length} classes, ${rows.reduce((s, r) => s + r[1].length, 0)} methods missing`)
