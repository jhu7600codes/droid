// prints what droid reads from an apk: manifest, resources, dex classes, native libs
import fs from 'node:fs'
import { listZip, readEntry } from '../../src/runtime/zip.ts'
import { parseAxml, attrString } from '../../src/runtime/android/axml.ts'
import { parseArsc } from '../../src/runtime/android/arsc.ts'
import { parseDex } from '../../src/runtime/android/dex.ts'
const buf = fs.readFileSync(process.argv[2] || 'tools/apk2dpk/test.apk')
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
const files = new Map()
for (const e of listZip(ab)) files.set(e.path, await readEntry(ab, e))
const m = parseAxml(files.get('AndroidManifest.xml'))
console.log('package', m.attrs.find((a) => a.name === 'package')?.value.str, 'versionCode', attrString(m, 'versionCode'), 'versionName', attrString(m, 'versionName'))
const show = (n, d = 0) => { if (d < 4) { console.log(' '.repeat(d * 2) + n.tag, n.attrs.map((a) => `${a.name}=${a.value.str ?? a.value.raw ?? '0x' + a.value.data.toString(16)}`).join(' ')); n.children.forEach((c) => show(c, d + 1)) } }
show(m)
const t = parseArsc(files.get('resources.arsc'))
console.log('arsc', t.pkg, [...t.entries].map(([id, e]) => `0x${id.toString(16)} ${e.type}/${e.name}=${e.values.map((v) => v.value?.str ?? v.value?.data).join('|')}`).join('\n  '))
const dex = parseDex(files.get('classes.dex'))
for (const c of dex.classes) console.log('class', c.name, 'super', c.super, 'methods', [...c.directMethods, ...c.virtualMethods].map((x) => x.ref.name + (x.code ? `[${x.code.insns.length}]` : '(native)')).join(' '))
console.log('libs', [...files.keys()].filter((k) => k.startsWith('lib/')))
show(parseAxml(files.get('res/layout/main.xml')))
