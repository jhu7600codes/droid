#!/usr/bin/env node
// apk -> dpk. usage: node tools/apk2dpk/convert.mjs app.apk [out.dpk]   (run `npm run build` once for the runtime bundle)
import fs from 'node:fs'
import { convertApk } from '../../src/runtime/android/convert.ts'
const [src, out] = process.argv.slice(2)
const buf = fs.readFileSync(src)
const runtime = fs.readFileSync('public/runtime/android-runtime.js', 'utf8')
const r = await convertApk(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), runtime)
const dest = out || `${r.manifest.id}.dpk`
fs.writeFileSync(dest, r.dpk)
console.log(`${dest}: ${r.manifest.name} ${r.manifest.version} (${r.manifest.type}, runtime ${r.manifest.runtime}, ${(r.dpk.length / 1024).toFixed(0)} KB)`)
for (const l of r.report) console.log('  note:', l)
