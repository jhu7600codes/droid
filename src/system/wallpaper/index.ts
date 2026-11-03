// wallpaper (role: wallpaper): draws the home and lock wallpaper, parallax with launcher pages,
// and the picker activity for the 'set-wallpaper' intent. live wallpapers come in milestone 9.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { layers } from '../../shell/layers'
import { img } from '../../shell/assets'
import { settings } from '../../shell/settings'
import { h, pressable, toast } from '../../shell/ui'
import { shared } from '../../shell/storage'
import { LIVE, startLive, stopLive } from './live'
import './wallpaper.css'

// stock static wallpapers: the kitkat default plus the backgrounds from aosp's basic wallpapers
export const WALLPAPERS = [
  'framework/default_wallpaper',
  ...['pond', 'sky', 'space', 'sunrise', 'sunset', 'night', 'light1'].map((n) => 'apps/wallpapers_basic/' + n),
]
const url = (key: string) => {
  if (key.startsWith('data:') || key.startsWith('blob:') || key.startsWith('#')) return key
  const i = key.lastIndexOf('/')
  return img(key.slice(0, i), key.slice(i + 1))
}

let offset = 0.5
export function setWallpaperOffset(f: number, anim: boolean) {
  offset = f
  const el = layers.wallpaper
  if (!el) return
  el.style.transition = anim ? 'background-position .3s cubic-bezier(.1,.7,.3,1)' : 'none'
  el.style.backgroundPosition = `${f * 100}% center`
}

async function draw() {
  const w = settings.get('wallpaper') as string
  const el = layers.wallpaper
  if (w.startsWith('live:')) { el.style.backgroundImage = 'none'; el.style.backgroundColor = '#000'; startLive(w); return }
  stopLive()
  if (w.startsWith('#')) { el.style.backgroundImage = 'none'; el.style.backgroundColor = w }
  else if (w.startsWith('shared:')) { el.style.backgroundImage = `url("${await shared.url(w.slice(7))}")`; el.style.backgroundColor = '#000' }
  else { el.style.backgroundImage = `url("${url(w)}")`; el.style.backgroundColor = '#000' }
  // wider than the screen so pages can scroll it (like android's wallpaper offsets)
  const wide = (layers.wallpaper.clientWidth || 1) > (layers.wallpaper.clientHeight || 1)
  el.style.backgroundSize = wide ? 'cover' : 'auto 100%'
  setWallpaperOffset(offset, false)
}

function picker(ctx: ActivityContext): Activity {
  const grid = h('div.wp-grid')
  for (const w of WALLPAPERS) {
    const t = pressable(h('div.wp-tile', { style: { backgroundImage: `url("${url(w)}")` } }))
    t.addEventListener('click', () => { settings.set('wallpaper', w); toast('Wallpaper set'); ctx.finish() })
    grid.append(t)
  }
  for (const [k, label] of Object.entries(LIVE)) {
    const t = pressable(h('div.wp-tile.wp-pick.wp-live', {}, label + ' (live)'))
    t.addEventListener('click', () => { settings.set('wallpaper', k); toast('Live wallpaper set'); ctx.finish() })
    grid.append(t)
  }
  for (const c of ['#000000', '#0099cc', '#222222']) {
    const t = pressable(h('div.wp-tile', { style: { background: c } }))
    t.addEventListener('click', () => { settings.set('wallpaper', c); ctx.finish() })
    grid.append(t)
  }
  // pick a photo from the gallery (any app that handles pick image/*)
  const fromGallery = pressable(h('div.wp-tile.wp-pick', {}, 'Gallery'))
  fromGallery.addEventListener('click', async () => {
    const r = await ctx.startForResult({ action: 'pick', type: 'image/*' })
    const data = r.data as { path?: string } | undefined
    if (data?.path) { settings.set('wallpaper', 'shared:' + data.path); ctx.finish() }
  })
  grid.append(fromGallery)
  ctx.root.append(h('div.app.app-dark', {}, h('div.h-actionbar', {}, h('span.h-ab-item.h-ab-home', {}, h('span.h-ab-title', { style: { paddingLeft: '16px' } }, 'Choose wallpaper'))), h('div.content', {}, grid)))
  return {}
}

const app: SystemApp = {
  manifest: {
    id: 'droid.wallpaper', name: 'Wallpapers', version: '4.4', versioncode: 19, type: 'web', main: 'picker',
    activities: { picker: { label: 'Wallpapers' } }, role: 'wallpaper', system: true,
    permissions: ['system.wallpaper'],
    'intent-filters': [{ activity: 'picker', actions: ['set-wallpaper'] }],
  },
  icon: '',
  activities: { picker },
  service() {
    draw()
    settings.on('wallpaper', draw)
    new ResizeObserver(() => draw()).observe(layers.wallpaper)
  },
}
app.icon = ''
export default app
