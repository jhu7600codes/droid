// shared storage for system apps (the same "shared:" area dpks reach with the storage permission).
// paths look like dcim/camera/img_20261103_101500.jpg
import * as store from '../runtime/db'

const K = (p: string) => 'shared:' + p.replace(/^\/+/, '')
const urls = new Map<string, string>()

export const shared = {
  async list(dir = '') {
    const prefix = K(dir ? dir.replace(/\/?$/, '/') : '')
    return (await store.keys('files', prefix)).map((k) => k.slice(prefix.length))
  },
  // every file under dir, full paths
  async all(dir = '') {
    return (await store.keys('files', K(dir))).map((k) => k.slice(7))
  },
  read: (p: string) => store.get<Blob>('files', K(p)),
  async write(p: string, b: Blob) { await store.put('files', K(p), b); window.dispatchEvent(new CustomEvent('shared:changed', { detail: p })) },
  async remove(p: string) {
    await store.del('files', K(p))
    if (urls.has(p)) { URL.revokeObjectURL(urls.get(p)!); urls.delete(p) }
    window.dispatchEvent(new CustomEvent('shared:changed', { detail: p }))
  },
  // object url for a shared file (cached)
  async url(p: string) {
    if (urls.has(p)) return urls.get(p)!
    const b = await shared.read(p)
    if (!b) return ''
    const u = URL.createObjectURL(b)
    urls.set(p, u)
    return u
  },
}

export const stamp = (d = new Date()) => {
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}
