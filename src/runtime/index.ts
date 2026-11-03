// dpk runtime start: register installed apps, install the sample apps on first boot,
// and accept .dpk files dropped on the screen or opened with ?install=<url>.
import { loadInstalled, parseDpk, installKind, install } from './packages'
import { settings } from '../shell/settings'
import { wm } from '../shell/wm'
import { screenEl } from '../shell/layers'

export const SAMPLES = ['examples/hello.dpk', 'examples/notes.dpk', 'examples/wasmdemo.dpk']

export async function startRuntime() {
  await loadInstalled()
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
}

// hands a dpk to the package installer (shows permissions, then installs)
export async function openDpk(file: Blob) {
  const url = URL.createObjectURL(file)
  wm.start({ action: 'install', data: url, type: 'application/x-dpk' })
}
