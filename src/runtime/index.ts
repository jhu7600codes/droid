// dpk runtime start: register installed apps, install the sample apps on first boot,
// and accept .dpk files dropped on the screen or opened with ?install=<url>.
import { loadInstalled, parseDpk, installKind, install } from './packages'
import { settings } from '../shell/settings'
import { wm } from '../shell/wm'
import { screenEl } from '../shell/layers'

export const SAMPLES = ['examples/hello.dpk', 'examples/notes.dpk', 'examples/wasmdemo.dpk']

export async function startRuntime() {
  await loadInstalled()
  ;(await import('./background')).startBackground()
  // converted apps from an older converter: convert them again in the background
  setTimeout(() => import('./reconvert').then((m) => m.reconvertOld()).catch((e) => console.warn('reconvert', e)), 3000)
  if (!settings.get('samples.installed')) {
    for (const url of SAMPLES) {
      try {
        const p = await parseDpk(await (await fetch(url)).arrayBuffer())
        if ((await installKind(p.manifest)) === 'install') await install(p, { source: 'sample' })
      } catch (e) { console.warn('sample', url, e) }
    }
    settings.set('samples.installed', true)
  }
  screenEl.addEventListener('dragover', (e) => e.preventDefault())
  screenEl.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => /\.(dpk|apk)$/.test(x.name))
    if (!f) return
    e.preventDefault()
    openDpk(f)
  })
  const q = new URLSearchParams(location.search).get('install')
  if (q) fetch(q).then((r) => r.blob()).then((b) => openDpk(b)).catch(() => {})
  takeShared()
  // drop an .apk / .dpk anywhere on droid to install it
  document.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((x) => x.kind === 'file')) e.preventDefault() })
  document.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find(isPackage)
    if (!f) return
    e.preventDefault()
    openDpk(f)
  })
}

// lets the user pick an .apk / .dpk from the device and installs it. no type filter: iphones grey out
// files whose type they do not know (.apk), and the installer looks at the content anyway
export function pickPackage() {
  const i = document.createElement('input')
  i.type = 'file'
  i.style.display = 'none'
  i.addEventListener('change', () => { const f = i.files?.[0]; if (f) openDpk(f); i.remove() })
  document.body.append(i)
  i.click()
  setTimeout(() => i.remove(), 10 * 60000)
}
// packages shared to droid from another app (android share sheet -> sw.js keeps them for us)
export async function takeShared() {
  if (!new URLSearchParams(location.search).has('shared')) return
  history.replaceState(null, '', location.pathname)
  try {
    const cache = await caches.open('droid-shared')
    for (const req of await cache.keys()) { const r = await cache.match(req); await cache.delete(req); if (r) openDpk(await r.blob()) }
  } catch { /* nothing shared */ }
}
const isPackage = (f: File) => /\.(apk|dpk)$/i.test(f.name) || /android\.package-archive|x-dpk/.test(f.type)

// hands a dpk to the package installer (shows permissions, then installs)
export async function openDpk(file: Blob) {
  const url = URL.createObjectURL(file)
  wm.start({ action: 'install', data: url, type: 'application/x-dpk' })
}
