#!/usr/bin/env node
// import-aosp: clones the kitkat tag (shallow + sparse), picks resources, converts them for the web
// and writes assets/aosp/ plus assets/aosp/manifest.json (what came from where).
//
// usage: node tools/import-aosp/import.mjs [--cache dir] [--skip-clone]
// the clone lives in the cache dir (default tools/import-aosp/.cache), never in git.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TAG, MIRROR, sources, DENSITIES, EXCLUDE } from './sources.mjs'
import { parseNinePatch } from './ninepatch.mjs'
import { parseXmlDrawable, parseValuesFile } from './xmldrawable.mjs'
import { buildCss } from './css.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const cache = path.resolve(opt('--cache', path.join(here, '.cache')))
const skipClone = args.includes('--skip-clone')
const out = path.join(root, 'assets/aosp')

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()

function clone(src) {
  const dir = path.join(cache, src.id)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(cache, { recursive: true })
    console.log(`clone ${src.repo} @ ${TAG}`)
    git(cache, 'clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', TAG, MIRROR + src.repo, src.id)
  }
  if (!skipClone) git(dir, 'sparse-checkout', 'set', '--no-cone', ...src.paths)
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') }
}

const excluded = (name) => EXCLUDE.some((re) => re.test(name))
const manifest = { tag: TAG, generated: new Date().toISOString().slice(0, 10), sources: {}, files: {}, excluded: [] }

function write(rel, data, from) {
  const p = path.join(out, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  manifest.files[rel] = from
}

// qualifier dir -> bucket name we ship it under, or null to skip.
// we only take plain density dirs for now (no land, ldrtl, sw600dp: those come with tablet mode).
function bucketOf(dirName) {
  const m = dirName.match(/^(drawable|mipmap)(?:-(mdpi|hdpi|xhdpi|xxhdpi|nodpi))?$/)
  if (!m) return null
  return { kind: m[1], bucket: m[2] || 'any' }
}

function importRes(src, dir, res) {
  const base = path.join(dir, res.from)
  const index = { ninepatch: {}, images: {}, xml: {}, colors: {}, values: {} }
  // images[name] = { mdpi: 'w h', ... } so the css generator can pick a density without touching disk
  for (const d of fs.readdirSync(base)) {
    const b = bucketOf(d)
    const full = path.join(base, d)
    if (b) {
      for (const f of fs.readdirSync(full)) {
        const name = f.replace(/\.9\.png$|\.png$|\.xml$|\.jpg$/, '')
        if (excluded(name)) { manifest.excluded.push(`${res.from}/${d}/${f}`); continue }
        const from = `${src.repo}/${res.from}/${d}/${f}`
        const buf = fs.readFileSync(path.join(full, f))
        const outDir = `${res.to}/${b.kind}-${b.bucket}`
        if (f.endsWith('.9.png')) {
          const { png, meta } = parseNinePatch(buf)
          write(`${outDir}/${name}.png`, png, from)
          ;(index.ninepatch[name] ||= {})[b.bucket] = meta
        } else if (f.endsWith('.png') || f.endsWith('.jpg')) {
          const ext = f.endsWith('.jpg') ? 'jpg' : 'png'
          write(`${outDir}/${name}.${ext}`, buf, from)
          const size = ext === 'png' ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null
          ;(index.images[name] ||= {})[b.bucket] = { ext, size }
        } else if (f.endsWith('.xml')) {
          try { index.xml[name] = parseXmlDrawable(fs.readFileSync(path.join(full, f), 'utf8')) }
          catch (e) { console.warn('bad xml', from, e.message) }
          manifest.files[`${res.to}/drawables.json#${name}`] = from
        }
      }
    } else if (d === 'color') {
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.xml')) continue
        index.colors[f.replace(/\.xml$/, '')] = parseXmlDrawable(fs.readFileSync(path.join(full, f), 'utf8'))
      }
    } else if (d === 'values') {
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.xml')) continue
        const v = parseValuesFile(fs.readFileSync(path.join(full, f), 'utf8'))
        for (const [k, m] of Object.entries(v)) Object.assign((index.values[k] ||= {}), m)
      }
    }
  }
  write(`${res.to}/drawables.json`, JSON.stringify(index), `${src.repo}/${res.from}`)
  const counts = Object.fromEntries(Object.entries(index).map(([k, v]) => [k, Object.keys(v).length]))
  console.log(res.to, counts)
}

async function importFonts(src, dir) {
  const { compress } = (await import('wawoff2')).default
  const fdir = path.join(dir, src.fonts.from)
  const faces = []
  for (const f of fs.readdirSync(fdir).filter((f) => src.fonts.pick.test(f)).sort()) {
    const woff2 = await compress(fs.readFileSync(path.join(fdir, f)))
    const name = f.replace(/\.ttf$/, '')
    write(`fonts/${name}.woff2`, Buffer.from(woff2), `${src.repo}/${src.fonts.from}/${f}`)
    const family = name.startsWith('RobotoCondensed') ? 'Roboto Condensed' : 'Roboto'
    const style = /Italic/.test(name) ? 'italic' : 'normal'
    const weight = /Thin/.test(name) ? 100 : /Light/.test(name) ? 300 : /Medium/.test(name) ? 500 : /Bold/.test(name) ? 700 : /Black/.test(name) ? 900 : 400
    faces.push(`@font-face { font-family: '${family}'; src: url(./${name}.woff2) format('woff2'); font-weight: ${weight}; font-style: ${style}; font-display: swap; }`)
  }
  write('fonts/fonts.css', faces.join('\n') + '\n', 'generated')
  // apache license + notice that ship with the fonts
  for (const f of ['NOTICE', 'README.txt']) {
    if (fs.existsSync(path.join(fdir, f))) write(`fonts/${f}`, fs.readFileSync(path.join(fdir, f)), `${src.repo}/${src.fonts.from}/${f}`)
  }
}

fs.rmSync(out, { recursive: true, force: true })
for (const src of sources) {
  const { dir, commit } = clone(src)
  manifest.sources[src.id] = { repo: MIRROR + src.repo, tag: TAG, commit }
  for (const res of src.res || []) importRes(src, dir, res)
  if (src.fonts) await importFonts(src, dir)
  if (src.notice) write(`NOTICE-${src.id}`, fs.readFileSync(path.join(dir, src.notice)), `${src.repo}/${src.notice}`)
}
write('manifest.json', JSON.stringify(manifest, null, 1), 'generated')
buildCss(out, DENSITIES)
console.log('done:', Object.keys(manifest.files).length, 'files,', manifest.excluded.length, 'excluded')
