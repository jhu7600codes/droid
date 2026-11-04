// droid shell entry: builds the screen, shows the boot animation, starts the system apps
// (systemui, wallpaper, launcher), then the setup wizard on first boot or the lockscreen.
import './shell/shell.css'
import { loadHolo } from './shell/density'
import { loadIndex, setBucket, img } from './shell/assets'
import { measure, apply, watch } from './shell/screen'
import { createLayers, layers } from './shell/layers'
import { boot } from './shell/boot'
import { kernel } from './shell/kernel'
import { wm } from './shell/wm'
import { initUi } from './shell/ui'
import { initIme } from './shell/ime'
import { settings } from './shell/settings'
import { systemApps } from './system'
import { lockscreen } from './system/systemui/lockscreen'
import { registerSw, watchUpdates } from './shell/sw-client'

// startup errors are kept so a stuck boot can show them (no dev tools needed, e.g. on an iphone)
const bootErrors: string[] = []
addEventListener('error', (e) => bootErrors.push(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`))
addEventListener('unhandledrejection', (e) => bootErrors.push('promise: ' + ((e.reason as Error)?.message || String(e.reason))))
// a step that hangs (a browser bug, a slow database) must not keep droid on the boot screen
const within = <T,>(p: Promise<T> | T | undefined, ms: number, what: string) => Promise.race([
  Promise.resolve(p).catch((e) => { bootErrors.push(`${what}: ${(e as Error)?.message || e}`) }),
  new Promise<void>((ok) => setTimeout(() => { bootErrors.push(`${what}: took longer than ${ms / 1000}s, skipped`); ok() }, ms)),
])

if (new URLSearchParams(location.search).has('v')) history.replaceState(null, '', location.pathname)
const screen = document.getElementById('screen')!
createLayers(screen)
let info = measure()
apply(screen, info)

async function start() {
  loadHolo(info.bucket)
  await loadIndex(info.bucket)
  initUi(layers.overlay)
  initIme()
  wm.init(layers.windows)
  for (const a of systemApps) {
    if (a.iconRef) a.icon = img(...a.iconRef)
    kernel.register({ manifest: a.manifest, icon: a.icon, system: true, impl: a })
  }
  for (const a of systemApps) await within(a.service?.(), 6000, a.manifest.id)
  wm.startHome()
  // apps that are installed dpks (milestone 3)
  await within(import('./runtime').then((m) => m.startRuntime()), 10000, 'app runtime')
  await within(document.fonts?.ready, 3000, 'fonts')
}

const ready = start().catch((e) => { bootErrors.push('start: ' + ((e as Error)?.stack || e)); showBootErrors(true) })
// still booting after 20s: show what went wrong
setTimeout(() => { if (layers.boot.querySelector('#intro')) showBootErrors(false) }, 20000)
function showBootErrors(fatal: boolean) {
  if (document.getElementById('boot-errors')) return
  const box = document.createElement('div')
  box.id = 'boot-errors'
  box.style.cssText = 'position:absolute;left:8px;right:8px;bottom:8px;max-height:60%;overflow:auto;background:rgba(40,0,0,.92);color:#fff;font:12px/1.4 monospace;padding:10px;z-index:99;border:1px solid #f44;white-space:pre-wrap;word-break:break-word'
  box.textContent = (fatal ? 'Droid could not start.' : 'Droid is taking too long to start.') + '\n' + navigator.userAgent + '\n\n' + (bootErrors.join('\n') || 'no errors were reported') + '\n\n'
  const reset = document.createElement('button')
  reset.textContent = 'Reload'
  reset.onclick = () => location.reload()
  box.append(reset)
  layers.boot.append(box)
}
;(window as any).droid_boot_errors = bootErrors
const firstBoot = !settings.get('setup.done')
boot(layers.boot, ready, { short: new URLSearchParams(location.search).has('fastboot') }).then(() => {
  if (firstBoot) wm.start({ action: 'setup' })
  else lockscreen.lock()
  // a tapped push notification opens its app (?open=<package>)
  const open = new URLSearchParams(location.search).get('open')
  if (open && kernel.get(open)) wm.start({ package: open, action: 'main' })
})

watch((s) => {
  const bucketChanged = s.bucket !== info.bucket
  info = s
  apply(screen, s)
  if (bucketChanged) { loadHolo(s.bucket); setBucket(s.bucket) }
  wm.relayout()
  wm.configchange()
})
registerSw()
watchUpdates()
import('./shell/push').then((m) => m.listenForPushes())
// offline-first (spec section 21): once the service worker runs, quietly fetch the essential set
// (shell, system apps, this density's images) unless it is done already or the connection is metered
import('./shell/offline').then(async ({ offline }) => {
  if (!('serviceWorker' in navigator) || settings.get('offline.level')) return
  await navigator.serviceWorker.ready
  if (await offline.metered()) return
  setTimeout(() => offline.download('essential', () => {}), 15000)
})
// brightness and battery saver apply to the whole screen
const look = () => {
  screen.style.filter = settings.get('brightness') < 1 ? `brightness(${settings.get('brightness')})` : ''
  screen.classList.toggle('no-anim', !!settings.get('battery.saver'))
}
look()
settings.on('brightness', look)
settings.on('battery.saver', look)
// developer options: layout bounds, show taps, animation scale
const dev = () => {
  screen.classList.toggle('dev-bounds', !!settings.get('dev.bounds'))
  screen.classList.toggle('no-anim', !!settings.get('battery.saver') || settings.get('dev.anim') === 0)
}
dev()
settings.on('*', dev)
screen.addEventListener('pointerdown', (e) => {
  if (!settings.get('dev.taps')) return
  const r = screen.getBoundingClientRect(), k = r.width / screen.offsetWidth || 1
  const dot = document.createElement('div')
  dot.className = 'dev-tap'
  dot.style.left = (e.clientX - r.left) / k + 'px'
  dot.style.top = (e.clientY - r.top) / k + 'px'
  layers.overlay.append(dot)
  setTimeout(() => dot.remove(), 400)
}, true)
screen.addEventListener('animationstart', (e) => {
  const sc = settings.get('dev.anim') as number | undefined
  if (sc && sc !== 1) (e.target as Element).getAnimations?.().forEach((a) => (a.playbackRate = 1 / sc))
}, true)
// debugging from the console
;(window as any).droid_shell = { kernel, wm, settings, screen: () => info }
