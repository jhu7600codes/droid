// apk -> dpk (spec section 10). runs in the browser (package installer) and in node (tools/apk2dpk).
// the dpk keeps the original apk files under apk/, plus the runtime bundle and a small index.html.
import { listZip, readEntry } from '../zip.ts'
import { parseAxml, attr, attrString, T } from './axml.ts'
import { parseArsc, resolve } from './arsc.ts'
import { writeZip } from './zipwrite.ts'

export interface Converted { dpk: Uint8Array; manifest: any; report: string[] }

export async function convertApk(apk: ArrayBuffer, runtimeJs: string): Promise<Converted> {
  const files = new Map<string, Uint8Array>()
  for (const e of listZip(apk)) files.set(e.path, await readEntry(apk, e))
  const report: string[] = []
  const mf = files.get('AndroidManifest.xml')
  if (!mf) throw new Error('not an apk: AndroidManifest.xml is missing')
  const man = parseAxml(mf)
  const res = files.has('resources.arsc') ? parseArsc(files.get('resources.arsc')!) : null
  const pkg = man.attrs.find((a) => a.name === 'package')!.value.str!
  const str = (v: any) => (!v ? undefined : v.type === T.STRING ? v.str : v.type === T.REFERENCE && res ? resolve(res, v.data, { density: 240, landscape: false, lang: 'en' })?.str : undefined)
  const app = man.children.find((c) => c.tag === 'application')
  const label = str(app && attr(app, 'label')) || pkg
  const versionName = attrString(man, 'versionName') || '1.0'
  const versionCode = attr(man, 'versionCode')?.data || 1
  const minSdk = man.children.find((c) => c.tag === 'uses-sdk')
  const min = minSdk ? attr(minSdk, 'minSdkVersion')?.data ?? 1 : 1
  if (min > 19) report.push(`needs Android API ${min}, Droid is 19 (it may still run)`)
  const perms = man.children.filter((c) => c.tag === 'uses-permission').map((c) => attrString(c, 'name') || '')
  const PERM: Record<string, string> = { 'android.permission.INTERNET': 'network', 'android.permission.VIBRATE': 'vibrate', 'android.permission.CAMERA': 'camera', 'android.permission.RECORD_AUDIO': 'microphone', 'android.permission.ACCESS_FINE_LOCATION': 'location', 'android.permission.ACCESS_COARSE_LOCATION': 'location', 'android.permission.WRITE_EXTERNAL_STORAGE': 'storage', 'android.permission.READ_EXTERNAL_STORAGE': 'storage' }
  // android before 13 had no notification permission: every converted app may post notifications
  const permissions = [...new Set([...perms.map((p) => PERM[p]).filter(Boolean), 'notifications'])]
  // activities: the launcher one becomes "main"
  const acts = (app?.children || []).filter((c) => c.tag === 'activity' || c.tag === 'activity-alias')
  const full = (n: string) => (n.startsWith('.') ? pkg + n : n.includes('.') ? n : pkg + '.' + n)
  const activities: Record<string, any> = {}
  const map: Record<string, string> = {}
  let main = ''
  acts.forEach((a, i) => {
    const name = full(attrString(a, 'name') || '')
    const isMain = a.children.some((f) => f.tag === 'intent-filter' && f.children.some((x) => x.tag === 'action' && attrString(x, 'name') === 'android.intent.action.MAIN') && f.children.some((x) => x.tag === 'category' && attrString(x, 'name') === 'android.intent.category.LAUNCHER'))
    const key = isMain && !main ? 'main' : `a${i}`
    if (isMain && !main) main = key
    activities[key] = { entry: 'index.html', label: str(attr(a, 'label')) || label, launcher: isMain }
    map[key] = 'L' + name.replace(/\./g, '/') + ';'
  })
  if (!main) throw new Error('the APK has no launcher activity')
  const dexes = [...files.keys()].filter((p) => /^classes\d*\.dex$/.test(p))
  const libs = [...files.keys()].filter((p) => p.startsWith('lib/armeabi-v7a/') && p.endsWith('.so'))
  const otherAbis = [...new Set([...files.keys()].filter((p) => p.startsWith('lib/') && !p.startsWith('lib/armeabi-v7a/')).map((p) => p.split('/')[1]))]
  if (otherAbis.length && !libs.length) report.push(`native code only for ${otherAbis.join(', ')}: Droid runs armeabi-v7a`)
  if (dexes.length > 1) report.push('multidex app')
  // icon: the highest density png we can find
  let icon: string | undefined
  const iconAttr = app && attr(app, 'icon')
  if (iconAttr && res) {
    const e = res.entries.get(iconAttr.data >>> 0)
    const pngs = (e?.values || []).map((v) => v.value?.str).filter((s): s is string => !!s && s.endsWith('.png') && files.has(s))
    icon = pngs.sort((a, b) => files.get(b)!.length - files.get(a)!.length)[0]
  }
  const manifest = {
    id: pkg.toLowerCase().replace(/[^a-z0-9_.]/g, '_'), name: label, version: versionName, versioncode: versionCode, type: 'converted', dpk: '0.1',
    runtime: dexes.length && libs.length ? 'both' : libs.length ? 'arm' : 'dex', shim: 'droid-framework@0.1',
    main, activities, permissions, icon: icon ? 'apk/' + icon : undefined, theme: 'holo-dark', 'legacy-menu': true,
    'converted-from': { package: pkg, version: versionName, versionCode },
  }
  const out = new Map<string, Uint8Array>()
  const enc = new TextEncoder()
  out.set('manifest.json', enc.encode(JSON.stringify(manifest, null, 1)))
  out.set('index.html', enc.encode(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#app{height:100%;overflow:auto}</style></head><body><div id="app"></div><script src="runtime/android-runtime.js"></script></body></html>`))
  out.set('runtime/android-runtime.js', enc.encode(runtimeJs))
  // broadcast receivers (with their actions) and services: run in the background host
  const cls = (n: string) => 'L' + full(n).replace(/\./g, '/') + ';'
  const receivers = (app?.children || []).filter((c) => c.tag === 'receiver').map((r) => ({
    cls: cls(attrString(r, 'name') || ''),
    actions: r.children.filter((f) => f.tag === 'intent-filter').flatMap((f) => f.children.filter((x) => x.tag === 'action').map((x) => attrString(x, 'name') || '')),
  }))
  const services = (app?.children || []).filter((c) => c.tag === 'service').map((x) => cls(attrString(x, 'name') || ''))
  out.set('apk-map.json', enc.encode(JSON.stringify({ pkg, activities: map, libs, receivers, services })))
  ;(manifest as any)['android-receivers'] = [...new Set(receivers.flatMap((r) => r.actions))]
  out.set('manifest.json', enc.encode(JSON.stringify(manifest, null, 1)))
  const kept = [...files.keys()].filter((p) => !p.startsWith('META-INF/') && !(p.startsWith('lib/') && !p.startsWith('lib/armeabi-v7a/')))
  out.set('apk-files.json', enc.encode(JSON.stringify(kept)))
  for (const p of kept) out.set('apk/' + p.toLowerCase().replace(/[^a-z0-9/._-]/g, '_'), files.get(p)!)
  // apk paths are case sensitive and may not fit dpk path rules: keep a mapping when they differ
  const renamed = kept.filter((p) => p !== p.toLowerCase().replace(/[^a-z0-9/._-]/g, '_'))
  if (renamed.length) report.push(`${renamed.length} files renamed for the DPK path rules`)
  return { dpk: await writeZip(out), manifest, report }
}
