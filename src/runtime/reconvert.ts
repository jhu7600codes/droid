// converted apks are converted again when droid's converter gets better (CONVERTER_VERSION):
// the apk is rebuilt from the installed package (its original copy, or the unpacked files), run
// through the current converter and installed over the old one. app data stays (same package id).
import { getPackage, listPackages, parseDpk, install } from './packages'
import * as store from './db'

const norm = (p: string) => p.toLowerCase().replace(/[^a-z0-9/._-]/g, '_')
const file = async (id: string, p: string) => { const b = await store.get<Blob>('files', `app:${id}:${p}`); return b ? new Uint8Array(await b.arrayBuffer()) : null }

async function apkOf(id: string): Promise<ArrayBuffer | null> {
  const rec = await getPackage(id)
  if (!rec) return null
  // native apps keep the original apk in parts
  const parts = rec.files.filter((f) => /^original\/apk\.\d+$/.test(f)).sort((a, b) => +a.split('.').pop()! - +b.split('.').pop()!)
  if (parts.length) {
    const chunks = await Promise.all(parts.map((p) => file(id, p)))
    const all = new Uint8Array(chunks.reduce((n, c) => n + (c?.length || 0), 0))
    let o = 0
    for (const c of chunks) { if (c) { all.set(c, o); o += c.length } }
    return all.buffer
  }
  // the others: the unpacked apk files, zipped up again
  const list = await file(id, 'apk-files.json')
  if (!list) return null
  const files = new Map<string, Uint8Array>()
  for (const p of JSON.parse(new TextDecoder().decode(list)) as string[]) { const b = await file(id, 'apk/' + norm(p)); if (b) files.set(p, b) }
  if (!files.has('AndroidManifest.xml')) return null
  const { writeZip } = await import('./android/zipwrite')
  const z = await writeZip(files)
  return z.buffer.slice(z.byteOffset, z.byteOffset + z.length) as ArrayBuffer
}

export async function reconvertOld() {
  const { convertApk, CONVERTER_VERSION } = await import('./android/convert')
  const old = (await listPackages()).filter((r) => r.manifest.type === 'converted' && ((r.manifest as any)['converted-from']?.converter ?? 0) < CONVERTER_VERSION)
  if (!old.length) return
  const runtime = await (await fetch('runtime/android-runtime.js')).text()
  for (const r of old) {
    try {
      const apk = await apkOf(r.manifest.id)
      if (!apk) { console.warn('reconvert: nothing to rebuild', r.manifest.id); continue }
      const c = await convertApk(apk, runtime)
      const p = await parseDpk(c.dpk.buffer.slice(c.dpk.byteOffset, c.dpk.byteOffset + c.dpk.length) as ArrayBuffer)
      if (p.manifest.id !== r.manifest.id) continue
      await install(p, { allowDowngrade: true, source: r.source })
      console.info('reconverted', r.manifest.id, 'with converter', CONVERTER_VERSION)
    } catch (e) { console.warn('reconvert failed', r.manifest.id, e) }
  }
}
