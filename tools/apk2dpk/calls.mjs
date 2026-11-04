// prints the calls (and string constants) inside methods of an apk, in order. usage:
// node tools/apk2dpk/calls.mjs app.apk 'Lcom/unity3d/player/UnityPlayer;' [methodName]
import fs from 'node:fs'
import { listZip, readEntry } from '../../src/runtime/zip.ts'
import { parseDex } from '../../src/runtime/android/dex.ts'
import { insnSize } from '../../src/runtime/android/dalvik.ts'
const buf = fs.readFileSync(process.argv[2]); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
const want = process.argv[3], only = process.argv[4]
for (const e of listZip(ab)) {
  if (!/^classes\d*\.dex$/.test(e.path)) continue
  const d = parseDex(await readEntry(ab, e))
  for (const c of d.classes) {
    if (c.name !== want) continue
    console.log('class', c.name, 'extends', c.super, 'implements', c.interfaces.join(' '))
    console.log('  fields', c.instanceFields.map((f) => f.ref.name + ':' + f.ref.type).join(' '), '| static', c.staticFields.map((f) => f.ref.name + ':' + f.ref.type).join(' '))
    for (const m of [...c.directMethods, ...c.virtualMethods]) {
      if (only && m.ref.name !== only) continue
      console.log(' method', m.ref.key)
      const ins = m.code?.insns
      if (!ins) continue
      for (let pc = 0; pc < ins.length; pc += insnSize(ins, pc)) {
        const op = ins[pc] & 0xff
        if ((op >= 0x6e && op <= 0x72) || (op >= 0x74 && op <= 0x78)) { const r = d.methods[ins[pc + 1]]; console.log('    call', r.cls + '->' + r.key) }
        else if (op === 0x1a) console.log('    "' + d.strings[ins[pc + 1]] + '"')
        else if (op === 0x22) console.log('    new', d.types[ins[pc + 1]])
      }
    }
  }
}
