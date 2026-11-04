// registers the service worker (offline-first, spec section 21). a new version installs in the
// background and waits; it takes over on the next boot, like an ota update.
import { settings } from './settings'

// a waiting version installs on the next boot: called before the boot animation, it swaps the
// worker and reloads once (a plain refresh never activates a waiting worker)
export async function bootUpdate() {
  if (!('serviceWorker' in navigator)) return false
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  if (!reg?.waiting || !navigator.serviceWorker.controller || sessionStorage.getItem('droid.ota') === reg.waiting.scriptURL + VERSION_KEY()) return false
  sessionStorage.setItem('droid.ota', reg.waiting.scriptURL + VERSION_KEY())
  await swap(reg)
  return true
}
const VERSION_KEY = () => String(Date.now() / 60000 | 0) // one try a minute at most
function swap(reg: ServiceWorkerRegistration) {
  return new Promise<void>((done) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => { location.reload(); done() }, { once: true })
    reg.waiting!.postMessage('skip-waiting')
    setTimeout(() => { location.reload(); done() }, 4000) // safety net
  })
}

export function registerSw() {
  if (!('serviceWorker' in navigator) || location.hostname === 'localhost' && !location.search.includes('sw')) return
  navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {})
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000)
    const check = () => {
      const ready = !!reg.waiting && !!navigator.serviceWorker.controller
      if (ready && !settings.get('ota.ready')) {
        import('./notify').then(({ notifications }) => notifications.post({
          id: 'ota', pkg: 'droid.settings', title: 'System update downloaded', text: 'Touch to restart and install', ticker: 'System update downloaded',
          icon: 'assets/brand/droid-d-icon.svg',
          onclick: () => import('./wm').then(({ wm }) => wm.start({ action: 'system-update' })),
        }))
      }
      settings.set('ota.ready', ready)
    }
    check()
    reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', check))
  }).catch((e) => console.warn('sw', e))
}

// settings > about > system update: apply now (reload into the new version)
export async function applyUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration()
  settings.set('ota.ready', false)
  if (reg?.waiting) await swap(reg)
  else location.reload()
}
