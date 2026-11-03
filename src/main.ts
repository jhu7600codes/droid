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
import { settings } from './shell/settings'
import { systemApps } from './system'
import { lockscreen } from './system/systemui/lockscreen'
import { registerSw } from './shell/sw-client'

const screen = document.getElementById('screen')!
createLayers(screen)
let info = measure()
apply(screen, info)

async function start() {
  loadHolo(info.bucket)
  await loadIndex(info.bucket)
  initUi(layers.overlay)
  wm.init(layers.windows)
  for (const a of systemApps) {
    if (a.iconRef) a.icon = img(...a.iconRef)
    kernel.register({ manifest: a.manifest, icon: a.icon, system: true, impl: a })
  }
  for (const a of systemApps) await a.service?.()
  wm.startHome()
  // apps that are installed dpks (milestone 3)
  await import('./runtime').then((m) => m.startRuntime()).catch((e) => console.warn('runtime', e))
  await document.fonts?.ready
}

const ready = start()
const firstBoot = !settings.get('setup.done')
boot(layers.boot, ready, { short: new URLSearchParams(location.search).has('fastboot') }).then(() => {
  if (firstBoot) wm.start({ action: 'setup' })
  else lockscreen.lock()
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
// debugging from the console
;(window as any).droid_shell = { kernel, wm, settings, screen: () => info }
