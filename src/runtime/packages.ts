// install, update, uninstall (spec section 11) and the list of installed dpks.
import { listZip, readEntry } from './zip'
import { validateManifest, checkPath, checkSizes, sha256, DpkError } from './manifest'
import * as store from './db'
import type { Manifest } from '../shell/types'
import { kernel } from '../shell/kernel'
import { hostActivity } from './host'

export interface PackageRecord {
  manifest: Manifest
  installed: number
  updated: number
  size: number
  files: string[]
  grants: Record<string, 'granted' | 'denied'> // permission -> user choice
  source?: string // where it came from (store, file, sample)
}

const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  wasm: 'application/wasm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  txt: 'text/plain', xml: 'application/xml', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', so: 'application/octet-stream', dex: 'application/octet-stream',
}
export const mimeOf = (p: string) => MIME[p.split('.').pop()!.toLowerCase()] || 'application/octet-stream'

export interface Parsed { manifest: Manifest; files: Map<string, Uint8Array>; size: number }

// reads and checks a .dpk without installing it
export async function parseDpk(buf: ArrayBuffer): Promise<Parsed> {
  const entries = listZip(buf)
  checkSizes(entries.map((e) => ({ path: e.path, size: e.size })))
  const files = new Map<string, Uint8Array>()
  for (const e of entries) { checkPath(e.path); files.set(e.path, await readEntry(buf, e)) }
  const mf = files.get('manifest.json')
  if (!mf) throw new DpkError('invalid', 'manifest.json is missing')
  let manifest: Manifest
  try { manifest = JSON.parse(new TextDecoder().decode(mf)) } catch { throw new DpkError('invalid', 'manifest.json is not valid json') }
  validateManifest(manifest, new Set(files.keys()))
  // optional integrity map: path -> sha-256 hex
  if (manifest.integrity) {
    for (const [p, hash] of Object.entries(manifest.integrity)) {
      const f = files.get(p)
      if (!f) throw new DpkError('invalid', `integrity lists ${p} but it is missing`)
      if ((await sha256(f)) !== String(hash).toLowerCase()) throw new DpkError('invalid', `integrity check failed for ${p}`)
    }
  }
  return { manifest, files, size: [...files.values()].reduce((n, f) => n + f.length, 0) }
}

export async function getPackage(id: string) {
  return store.get<PackageRecord>('packages', id)
}

// 'install' | 'update' | 'downgrade' | 'same'
export async function installKind(m: Manifest) {
  const old = await getPackage(m.id)
  if (!old) return 'install'
  if (m.versioncode > old.manifest.versioncode) return 'update'
  if (m.versioncode === old.manifest.versioncode) return 'same'
  return 'downgrade'
}

export async function install(p: Parsed, opts: { allowDowngrade?: boolean; source?: string } = {}) {
  const { manifest, files } = p
  if (kernel.get(manifest.id)?.system) throw new DpkError('denied', 'system apps cannot be replaced')
  const old = await getPackage(manifest.id)
  if (old && manifest.versioncode <= old.manifest.versioncode && !opts.allowDowngrade) throw new DpkError('invalid', 'a newer or equal version is already installed')
  // package contents are replaced, private storage (pkg:<id>, kv) is kept on update
  await store.delPrefix('files', `app:${manifest.id}:`)
  await store.putMany('files', [...files].map(([path, data]) => [`app:${manifest.id}:${path}`, new Blob([data as BlobPart], { type: mimeOf(path) })]))
  const rec: PackageRecord = {
    manifest, installed: old?.installed || Date.now(), updated: Date.now(), size: p.size,
    files: [...files.keys()], grants: old?.grants || {}, source: opts.source || old?.source,
  }
  await store.put('packages', manifest.id, rec)
  await register(rec)
  return rec
}

export async function uninstall(id: string) {
  await store.delPrefix('files', `app:${id}:`)
  await store.delPrefix('files', `pkg:${id}:`)
  await store.delPrefix('kv', `${id}:`)
  await store.del('packages', id)
  kernel.unregister(id)
}

export async function setGrant(id: string, perm: string, v: 'granted' | 'denied' | null) {
  const r = await getPackage(id)
  if (!r) return
  if (v) r.grants[perm] = v
  else delete r.grants[perm]
  await store.put('packages', id, r)
}

const iconUrls = new Map<string, string>()
async function register(rec: PackageRecord) {
  const id = rec.manifest.id
  let icon = 'assets/brand/default-app-icon.svg'
  if (rec.manifest.icon) {
    const blob = await store.get<Blob>('files', `app:${id}:${rec.manifest.icon}`)
    if (blob) {
      if (iconUrls.has(id)) URL.revokeObjectURL(iconUrls.get(id)!)
      icon = URL.createObjectURL(blob)
      iconUrls.set(id, icon)
    }
  }
  kernel.register({ manifest: rec.manifest, icon, system: false, create: (ctx) => hostActivity(rec.manifest.id, ctx) })
}

export async function loadInstalled() {
  for (const id of await store.keys('packages')) {
    const rec = await getPackage(id)
    if (rec) await register(rec)
  }
}

export async function listPackages(): Promise<PackageRecord[]> {
  const out: PackageRecord[] = []
  for (const id of await store.keys('packages')) { const r = await getPackage(id); if (r) out.push(r) }
  return out
}
