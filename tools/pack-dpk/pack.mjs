#!/usr/bin/env node
// pack-dpk: folder -> .dpk (zip with manifest.json at the root), validated like the shell does.
// usage: node tools/pack-dpk/pack.mjs <folder> [out.dpk] [--integrity] [--system]
//   --integrity  writes sha-256 hashes of every file into the manifest (spec section 11)
//   --system     allow system-only fields (role, system, system.* permissions)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { validateManifest, checkPath, checkSizes, sha256 } from '../../src/runtime/manifest.ts'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const [dir, outArg] = args.filter((a) => !a.startsWith('--'))
if (!dir) { console.error('usage: pack-dpk <folder> [out.dpk] [--integrity] [--system]'); process.exit(2) }

function walk(d, base = d, out = []) {
  for (const f of fs.readdirSync(d).sort()) {
    if (f.startsWith('.')) continue
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) walk(p, base, out)
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out
}

// files listed in .dpkignore (one pattern per line, * wildcard) stay out of the package
const ignoreFile = path.join(dir, '.dpkignore')
const ignore = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')) : []
const paths = walk(dir).filter((p) => !ignore.some((r) => r.test(p)))
const files = new Map(paths.map((p) => [p, fs.readFileSync(path.join(dir, p))]))
for (const p of paths) checkPath(p)
checkSizes(paths.map((p) => ({ path: p, size: files.get(p).length })))

const manifest = JSON.parse(files.get('manifest.json')?.toString() || 'null')
if (flags.has('--integrity')) {
  manifest.integrity = {}
  for (const [p, data] of files) if (p !== 'manifest.json') manifest.integrity[p] = await sha256(data)
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
}
validateManifest(manifest, new Set(files.keys()), { system: flags.has('--system') })

// warn about code or assets loaded from outside the package (they break offline, spec section 21)
for (const [p, data] of files) {
  if (!/\.(html|js|mjs|css)$/.test(p)) continue
  const t = data.toString()
  const hits = t.match(/(src|href)\s*=\s*["']https?:\/\/[^"']+|url\(\s*["']?https?:\/\/[^)]+|import\s*(?:[^'"]*from\s*)?["']https?:\/\/[^"']+/g)
  if (hits) console.warn(`warning: ${p} loads from outside the package (won't work offline): ${hits.slice(0, 3).join(', ')}`)
}

// zip writer: deflate everything except already compressed formats
const STORE = /\.(png|jpe?g|gif|webp|mp3|mp4|webm|ogg|woff2?|zip|dpk)$/i
const local = [], central = []
let offset = 0
for (const [p, data] of [...files].sort(([a], [b]) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a.localeCompare(b)))) {
  const name = Buffer.from(p)
  const crc = zlib.crc32(data)
  const store = STORE.test(p)
  const comp = store ? data : zlib.deflateRawSync(data, { level: 9 })
  const method = store ? 0 : 8
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8)
  h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12) // fixed 1980-01-01 time: reproducible builds
  h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26)
  local.push(h, name, comp)
  const c = Buffer.alloc(46)
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10)
  c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14)
  c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42)
  central.push(c, name)
  offset += 30 + name.length + comp.length
}
const cd = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10)
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
const out = outArg || `${manifest.id}-${manifest.version}.dpk`
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.writeFileSync(out, Buffer.concat([...local, cd, end]))
console.log(`${out}: ${manifest.id} ${manifest.version} (${files.size} files, ${(fs.statSync(out).size / 1024).toFixed(1)} KB)`)
