// browser downloads: the file is fetched (directly, or through the Droid proxy when the site
// refuses), saved to download/ in shared storage, with a progress notification like kitkat's
// download manager. tapping a finished APK or DPK opens the package installer.
import { notifications } from '../../shell/notify'
import { shared } from '../../shell/storage'
import { toast } from '../../shell/ui'
import { brand } from '../../shell/assets'
import { proxyConfig, ensureProxyToken } from '../../runtime/netclient'

const PKG = 'droid.browser'
let nextId = 1

async function get(url: string) {
  try {
    const r = await fetch(url, { credentials: 'omit', mode: 'cors' })
    if (r.ok) return r
  } catch { /* cors or offline: try the proxy */ }
  await ensureProxyToken()
  const p = proxyConfig()
  if (!p) throw new Error('the site refused a direct download and no Droid proxy is set')
  const r = await fetch(`${p.url}/fetch?url=${encodeURIComponent(url)}`, { headers: { 'x-droid-token': p.token, 'x-droid-app': PKG } })
  if (!r.ok) throw new Error(`the server answered ${r.status}`)
  return r
}

const clean = (n: string) => n.toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'download'

async function freeName(name: string) {
  const have = new Set(await shared.list('download'))
  if (!have.has(name)) return name
  const m = name.match(/^(.*?)(\.[^.]*)?$/)!
  for (let i = 1; ; i++) { const n = `${m[1]}-${i}${m[2] || ''}`; if (!have.has(n)) return n }
}

// the proxy rewrites links to /p/<session>/<scheme>/<host>/<path>; a link read back from a page
// can carry that form glued onto the site's address. turn it into the real address again.
export function realUrl(url: string) {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\/p\/[^/]+\/(https?)\/([^/]+)(\/.*)?$/)
    return m ? `${m[1]}://${m[2]}${m[3] || '/'}${u.search}${u.hash}` : url
  } catch { return url }
}

export async function download(url: string, suggested = '') {
  url = realUrl(url)
  const id = 'dl' + nextId++
  const fromUrl = (() => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') } catch { return '' } })()
  let name = clean(suggested || fromUrl)
  const icon = brand('droid-d-icon')
  let first = true
  const show = (text: string, progress: number) => {
    notifications.post({ id, pkg: PKG, title: name, text, icon, progress, ongoing: true, silent: !first, ticker: `Downloading ${name}` })
    first = false
  }
  toast('Starting download…')
  show('Starting download…', -1)
  try {
    const r = await get(url)
    const total = Number(r.headers.get('content-length')) || 0
    const type = r.headers.get('content-type')?.split(';')[0] || ''
    const parts: Uint8Array[] = []
    let got = 0, last = 0
    const reader = r.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      got += value.length
      if (Date.now() - last > 300) { last = Date.now(); show(total ? `${Math.round((got / total) * 100)}%` : `${(got / 1024).toFixed(0)} KB`, total ? got / total : -1) }
    }
    if (!/\.[a-z0-9]{2,4}$/.test(name) && type === 'application/vnd.android.package-archive') name += '.apk'
    name = await freeName(name)
    const blob = new Blob(parts as BlobPart[], { type: /\.apk$/.test(name) ? 'application/vnd.android.package-archive' : /\.dpk$/.test(name) ? 'application/x-dpk' : type })
    await shared.write('download/' + name, blob)
    notifications.cancel(PKG, id)
    notifications.post({
      id, pkg: PKG, title: name, text: 'Download complete', icon, ticker: `${name} downloaded`,
      onclick: () => open('download/' + name),
    })
  } catch (e) {
    notifications.cancel(PKG, id)
    notifications.post({ id, pkg: PKG, title: name, text: 'Download unsuccessful', icon })
    toast(`Download failed: ${(e as Error).message}`)
  }
}

export async function open(path: string) {
  const b = await shared.read(path)
  if (!b) return toast('The file is gone')
  if (/\.(dpk|apk)$/.test(path)) return (await import('../../runtime')).openDpk(b)
  const { wm } = await import('../../shell/wm')
  wm.start({ action: 'view', data: 'shared:' + path, type: b.type })
}
