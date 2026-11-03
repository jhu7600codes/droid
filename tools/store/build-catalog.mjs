#!/usr/bin/env node
// builds the danen store catalog from store/apps/<id>/listing.json (spec section 19).
// checks every listing like the github action does: manifest, sizes, permissions, integrity hashes.
// output: dist/store/catalog.json plus the dpks, icons and screenshots next to it.
// usage: node tools/store/build-catalog.mjs [--check]   (--check validates only, used on pull requests)
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { validateManifest, PERMISSIONS } from '../../src/runtime/manifest.ts'
import { listZipNode, readEntryNode } from './zipnode.mjs'

const check = process.argv.includes('--check')
const root = 'store/apps'
const out = 'dist/store'
const errors = []
const apps = []
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const REQUIRED = ['id', 'name', 'author', 'description', 'category', 'dpk']
const CATEGORIES = ['tools', 'games', 'productivity', 'media', 'education', 'social', 'demo']

for (const id of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
  const dir = path.join(root, id)
  const fail = (m) => errors.push(`${id}: ${m}`)
  let l
  try { l = JSON.parse(fs.readFileSync(path.join(dir, 'listing.json'), 'utf8')) } catch { fail('listing.json missing or invalid'); continue }
  for (const k of REQUIRED) if (!l[k]) fail(`listing: missing ${k}`)
  if (l.id !== id) fail('listing id must match the folder name')
  if (!CATEGORIES.includes(l.category)) fail(`category must be one of ${CATEGORIES.join(', ')}`)
  if (String(l.description || '').length > 4000) fail('description too long')
  // dpk: a file in the folder, or "repo:<path>" for apps built from this repo (the samples)
  const dpkPath = String(l.dpk).startsWith('repo:') ? l.dpk.slice(5) : path.join(dir, l.dpk)
  if (!fs.existsSync(dpkPath)) { fail(`dpk not found: ${dpkPath}`); continue }
  const buf = fs.readFileSync(dpkPath)
  if (buf.length > 64 * 1024 * 1024) { fail('dpk bigger than 64 MB'); continue }
  let manifest
  try {
    const entries = listZipNode(buf)
    const files = new Map(entries.map((e) => [e.path, e]))
    manifest = JSON.parse(readEntryNode(buf, files.get('manifest.json')).toString())
    validateManifest(manifest, new Set(files.keys()))
    if (manifest.id !== id) fail(`manifest id ${manifest.id} does not match ${id}`)
    // store apps must ship integrity hashes for every file, and they must match
    if (!manifest.integrity) fail('manifest.integrity is required in the store (pack with --integrity)')
    else {
      for (const e of entries) {
        if (e.path === 'manifest.json') continue
        const want = manifest.integrity[e.path]
        if (!want) fail(`integrity missing for ${e.path}`)
        else if (sha(readEntryNode(buf, e)) !== want) fail(`integrity mismatch for ${e.path}`)
      }
    }
    for (const p of manifest.permissions || []) {
      const n = typeof p === 'string' ? p : p.name
      if (!PERMISSIONS.includes(n)) fail(`permission ${n} not allowed in the store`)
    }
  } catch (e) { fail(e.message); continue }
  const icon = l.icon ? path.join(dir, l.icon) : null
  if (icon && !fs.existsSync(icon)) fail(`icon not found: ${l.icon}`)
  const shots = (l.screenshots || []).map((s) => path.join(dir, s))
  shots.forEach((s) => !fs.existsSync(s) && fail(`screenshot not found: ${s}`))
  if (check) continue
  const dest = path.join(out, id)
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, `${id}-${manifest.versioncode}.dpk`), buf)
  if (icon) fs.copyFileSync(icon, path.join(dest, path.basename(icon)))
  shots.forEach((s) => fs.copyFileSync(s, path.join(dest, path.basename(s))))
  apps.push({
    id, name: l.name, version: manifest.version, versioncode: manifest.versioncode, author: l.author, description: l.description,
    category: l.category, icon: icon ? `${id}/${path.basename(icon)}` : '', screenshots: shots.map((s) => `${id}/${path.basename(s)}`),
    size: buf.length, permissions: (manifest.permissions || []).map((p) => (typeof p === 'string' ? p : p.name)),
    dpk: `${id}/${id}-${manifest.versioncode}.dpk`, sha256: sha(buf), updated: l.updated || new Date().toISOString().slice(0, 10), homepage: l.homepage,
  })
}
if (errors.length) { console.error('store check failed:\n  ' + errors.join('\n  ')); process.exit(1) }
if (!check) {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify({ version: 1, generated: new Date().toISOString(), apps }, null, 1))
}
console.log(`store: ${check ? 'checked' : 'built'} ${check ? fs.readdirSync(root).length : apps.length} apps`)
