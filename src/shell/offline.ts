// offline download (spec section 21). precache.json (written at build time) lists every file with
// its size and group. "essential" = shell and system apps, "full" = also wallpapers, sounds, sample apps.
// images are only taken for the current density bucket.
import { settings } from './settings'

interface Entry { p: string; s: number; g: 'essential' | 'full'; b?: string }
const CACHE = 'droid-offline'
let paused = false
let list: Entry[] | null = null

async function entries() {
  if (!list) list = await fetch('precache.json').then((r) => (r.ok ? r.json() : [])).catch(() => [])
  return list!
}
function pick(all: Entry[], kind: 'essential' | 'full') {
  const bucket = document.documentElement.dataset.density
  return all.filter((e) => (kind === 'full' || e.g === 'essential') && (!e.b || e.b === bucket || e.b === 'nodpi' || e.b === 'any'))
}

export const offline = {
  async estimate(kind: 'essential' | 'full') {
    const e = pick(await entries(), kind)
    return { files: e.length, bytes: e.reduce((n, x) => n + x.s, 0) }
  },
  async metered() {
    const c = (navigator as any).connection
    return !!(c && (c.saveData || c.type === 'cellular' || /2g|3g/.test(c.effectiveType || '')))
  },
  pause() { paused = true },
  // downloads what is missing; resumes where it stopped (the cache remembers what is done)
  async download(kind: 'essential' | 'full', onProgress: (done: number, total: number) => void) {
    paused = false
    navigator.storage?.persist?.().catch(() => {})
    const todo = pick(await entries(), kind)
    const cache = await caches.open(CACHE)
    let done = 0
    const queue = [...todo]
    const worker = async () => {
      while (queue.length && !paused) {
        const e = queue.shift()!
        if (!(await cache.match(e.p))) {
          try { await cache.add(e.p) } catch { queue.push(e); await new Promise((r) => setTimeout(r, 1000)); continue }
        }
        onProgress(++done, todo.length)
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    if (!paused) settings.set('offline.level', kind)
  },
  async usage() {
    const est = await navigator.storage?.estimate?.()
    return { used: est?.usage || 0, quota: est?.quota || 0, persisted: (await navigator.storage?.persisted?.()) || false }
  },
  async clear() { await caches.delete(CACHE); settings.set('offline.level', '') },
}
