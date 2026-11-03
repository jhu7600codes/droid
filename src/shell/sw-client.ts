// registers the service worker (offline-first, spec section 21). a new version installs in the
// background and waits; it takes over on the next boot, like an ota update.
import { settings } from './settings'

export function registerSw() {
  if (!('serviceWorker' in navigator) || location.hostname === 'localhost' && !location.search.includes('sw')) return
  navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
    const check = () => {
      if (reg.waiting) settings.set('ota.ready', true)
    }
    check()
    reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', check))
  }).catch((e) => console.warn('sw', e))
}

// settings > about > system update: apply now (reload into the new version)
export async function applyUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration()
  reg?.waiting?.postMessage('skip-waiting')
  settings.set('ota.ready', false)
  setTimeout(() => location.reload(), 300)
}
