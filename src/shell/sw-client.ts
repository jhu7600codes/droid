// service worker (offline-first, spec section 21) and system updates.
// every build has its own number (BUILD, baked in at build time). version.json on the server says
// what is deployed; when the two differ an update is ready: a notification, and Settings > About >
// System updates restarts into it.
import { settings } from './settings'

declare const __DROID_BUILD__: string
export const BUILD: string = typeof __DROID_BUILD__ === 'string' ? __DROID_BUILD__ : 'dev'

export function registerSw() {
  if (!('serviceWorker' in navigator) || location.hostname === 'localhost' && !location.search.includes('sw')) return
  navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {})
  }).catch((e) => console.warn('sw', e))
}

// the deployed build, or null when offline / unknown
export async function latestBuild(): Promise<string | null> {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
    return r.ok ? String((await r.json()).version) : null
  } catch { return null }
}

let notified = ''
export async function checkUpdate() {
  if (BUILD === 'dev') return false
  const latest = await latestBuild()
  const ready = !!latest && latest > BUILD
  settings.set('ota.ready', ready ? latest : false)
  if (ready && notified !== latest) {
    notified = latest!
    const { notifications } = await import('./notify')
    notifications.post({
      id: 'ota', pkg: 'droid.settings', title: 'System update available', text: 'Touch to restart and install', ticker: 'System update available',
      icon: 'assets/brand/droid-d-icon.svg',
      onclick: () => import('./wm').then(({ wm }) => wm.start({ action: 'system-update' })),
    })
  }
  return ready
}

// checks on boot and every 30 minutes
export function watchUpdates() {
  const r = settings.get('ota.ready')
  if (r && String(r) <= BUILD) settings.set('ota.ready', false) // just updated
  setTimeout(checkUpdate, 10000)
  setInterval(checkUpdate, 30 * 60 * 1000)
  addEventListener('online', () => checkUpdate())
}

// restart into the deployed build: a fresh url skips the browser's page cache (github pages keeps
// pages for 10 minutes), and the service worker always fetches pages from the network when online
export async function applyUpdate() {
  const latest = settings.get('ota.ready') || (await latestBuild()) || Date.now()
  settings.set('ota.ready', false)
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
  await reg?.update().catch(() => {})
  location.replace(location.pathname + '?v=' + latest)
}
