// gallery (spec section 23), modeled on the kitkat aosp gallery: albums, a photo grid, a full screen
// viewer with swipe, pinch zoom, delete, share and set as wallpaper, and video playback.
// handles 'view' and 'pick' for images and videos. everything stays on the device.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { RESULT_OK } from '../../shell/types'
import { page, pageStack } from '../../shell/appkit'
import { h, pressable, dialog, toast } from '../../shell/ui'
import { img } from '../../shell/assets'
import { settings } from '../../shell/settings'
import { shared } from '../../shell/storage'
import { screenEl } from '../../shell/layers'
import './gallery.css'

const G = 'apps/gallery'
const F = 'framework'
const isImg = (p: string) => /\.(jpe?g|png|gif|webp)$/i.test(p)
const isVid = (p: string) => /\.(webm|mp4|mov|m4v)$/i.test(p)
const media = (p: string) => isImg(p) || isVid(p)
const ALBUM_NAMES: Record<string, string> = { 'dcim/camera': 'Camera', download: 'Download', pictures: 'Pictures', 'pictures/screenshots': 'Screenshots' }

async function albums() {
  const all = (await shared.all('')).filter(media).sort().reverse()
  const map = new Map<string, string[]>()
  for (const p of all) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    if (!map.has(dir)) map.set(dir, [])
    map.get(dir)!.push(p)
  }
  return [...map].map(([dir, items]) => ({ dir, name: ALBUM_NAMES[dir] || dir.split('/').pop() || 'Storage', items }))
}

async function thumbOf(p: string, el: HTMLElement) {
  if (isImg(p)) el.style.backgroundImage = `url("${await shared.url(p)}")`
  else { el.classList.add('vid'); el.append(h('img.g-play', { src: img(G, 'ic_gallery_play') })) }
}

function gallery(ctx: ActivityContext): Activity {
  const pick = ctx.intent.action === 'pick'
  const want = ctx.intent.type || '*/*'
  const ok = (p: string) => (want.startsWith('image') ? isImg(p) : want.startsWith('video') ? isVid(p) : media(p))
  const stack = pageStack(ctx.root)
  const viewing = { on: false }

  const albumList = (el: HTMLElement) => {
    const p = page(el, { title: pick ? 'Choose picture' : 'Gallery', icon: img(G, 'ic_launcher_gallery'), up: pick ? () => ctx.finish() : undefined })
    p.menu([{ title: 'Camera', icon: img(F, 'ic_menu_camera'), always: true, onclick: () => ctx.start({ action: 'capture' }) }])
    const grid = h('div.g-albums')
    p.content.append(grid)
    const render = async () => {
      grid.innerHTML = ''
      const list = (await albums()).map((a) => ({ ...a, items: a.items.filter(ok) })).filter((a) => a.items.length)
      if (!list.length) grid.append(h('div.g-empty', {}, 'No pictures or videos yet. Take some with the camera.'))
      for (const a of list) {
        const cover = h('div.g-cover')
        thumbOf(a.items[0], cover)
        const tile = pressable(h('div.g-album', {}, cover, h('div.g-album-label', {}, h('span', {}, a.name), h('span.g-count', {}, String(a.items.length))), a.dir === 'dcim/camera' ? h('img.g-badge', { src: img(G, 'ic_cameraalbum_overlay') }) : null))
        tile.addEventListener('click', () => stack.push((e2, pop) => albumGrid(e2, pop, a.name, a.items)))
        grid.append(tile)
      }
    }
    render()
    const onCh = () => render()
    addEventListener('shared:changed', onCh)
    return () => removeEventListener('shared:changed', onCh)
  }

  const albumGrid = (el: HTMLElement, pop: () => void, name: string, items: string[]) => {
    const p = page(el, { title: name, icon: img(G, 'ic_launcher_gallery'), up: pop })
    const grid = h('div.g-grid')
    p.content.append(grid)
    items.forEach((it, i) => {
      const t = pressable(h('div.g-cell'))
      thumbOf(it, t)
      t.addEventListener('click', () => (pick ? choose(it) : stack.push((e2, pop2) => viewer(e2, pop2, items, i))))
      grid.append(t)
    })
  }

  async function choose(path: string) {
    const data: Record<string, unknown> = { path, type: isImg(path) ? 'image/jpeg' : 'video/*' }
    // a downscaled data url for sandboxed apps (they may not have the storage permission)
    if (isImg(path)) {
      const im = new Image()
      im.src = await shared.url(path)
      await im.decode().catch(() => {})
      const s = Math.min(1, 1280 / Math.max(im.naturalWidth || 1, im.naturalHeight || 1))
      const c = document.createElement('canvas')
      c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s)
      c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height)
      data.url = c.toDataURL('image/jpeg', 0.85)
    }
    ctx.finish({ code: RESULT_OK, data })
  }

  const viewer = (el: HTMLElement, pop: () => void, items: string[], start: number) => {
    let i = start
    viewing.on = true
    const strip = h('div.g-strip')
    const bar = h('div.g-vbar')
    const root = h('div.g-viewer', {}, strip, bar)
    el.append(root)
    let chrome = true
    screenEl.classList.add('hide-sb')
    const titleEl = h('span.h-ab-title')
    const ab = h('div.h-actionbar.transparent.g-ab', {}, pressable(h('span.h-ab-item.h-ab-home', { onclick: pop }, h('i.h-ab-up'), h('img', { src: img(G, 'ic_launcher_gallery') }), titleEl)), h('span', { style: { flex: '1' } }),
      pressable(h('span.h-ab-item', { onclick: () => share() }, h('img', { src: img(F, 'ic_menu_share_holo_dark') }))),
      pressable(h('span.h-ab-item', { onclick: () => del() }, h('img', { src: img(F, 'ic_menu_delete') }))),
      pressable(h('span.h-ab-item', { onclick: () => setWall() }, h('img', { src: img(F, 'ic_menu_set_as') }))))
    root.append(ab)
    const slides = items.map(() => h('div.g-slide'))
    strip.append(...slides)
    const loaded = new Set<number>()
    const load = async (n: number) => {
      if (n < 0 || n >= items.length || loaded.has(n)) return
      loaded.add(n)
      const p = items[n]
      const u = await shared.url(p)
      slides[n].append(isImg(p) ? h('img.g-full', { src: u, draggable: false }) : h('video.g-full', { src: u, controls: true, playsInline: true }))
    }
    const show = (n: number, anim = true) => {
      i = Math.max(0, Math.min(items.length - 1, n))
      strip.style.transition = anim ? 'transform .25s cubic-bezier(.1,.7,.3,1)' : 'none'
      strip.style.transform = `translateX(${-i * 100}%)`
      titleEl.textContent = items[i].split('/').pop()!
      load(i); load(i - 1); load(i + 1)
      slides.forEach((s, k) => k !== i && s.querySelector('video')?.pause())
      resetZoom()
    }
    // swipe between items, pinch to zoom, double tap zoom, tap toggles the bars
    let zoom = 1, zx = 0, zy = 0
    const pts = new Map<number, { x: number; y: number }>()
    let startDist = 0, startZoom = 1, x0 = 0, y0 = 0, moved = false, startZx = 0, startZy = 0
    const imgEl = () => slides[i].querySelector<HTMLElement>('.g-full')
    const applyZoom = () => { const e = imgEl(); if (e) e.style.transform = `translate(${zx}px, ${zy}px) scale(${zoom})` }
    const resetZoom = () => { zoom = 1; zx = zy = 0; slides.forEach((s) => { const e = s.querySelector<HTMLElement>('.g-full'); if (e) e.style.transform = '' }) }
    const scale = () => strip.getBoundingClientRect().width / strip.offsetWidth || 1
    strip.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      strip.setPointerCapture(e.pointerId)
      if (pts.size === 2) { const [a, b] = [...pts.values()]; startDist = Math.hypot(a.x - b.x, a.y - b.y); startZoom = zoom }
      x0 = e.clientX; y0 = e.clientY; moved = false; startZx = zx; startZy = zy
    })
    strip.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const s = scale()
      if (pts.size === 2) {
        const [a, b] = [...pts.values()]
        zoom = Math.max(1, Math.min(5, (startZoom * Math.hypot(a.x - b.x, a.y - b.y)) / startDist))
        applyZoom(); moved = true; return
      }
      const dx = (e.clientX - x0) / s, dy = (e.clientY - y0) / s
      if (Math.abs(dx) + Math.abs(dy) > 8) moved = true
      if (zoom > 1) { zx = startZx + dx; zy = startZy + dy; applyZoom(); return }
      strip.style.transition = 'none'
      strip.style.transform = `translateX(calc(${-i * 100}% + ${dx}px))`
    })
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      pts.delete(e.pointerId)
      if (pts.size) return
      const dx = (e.clientX - x0) / scale()
      if (zoom === 1 && moved) show(Math.abs(dx) > 60 ? i - Math.sign(dx) : i)
      else if (!moved) {
        // double tap: zoom in or out; single tap: bars
        const now = Date.now()
        if (now - lastTap < 300) { zoom = zoom > 1 ? 1 : 2.5; zx = zy = 0; applyZoom() }
        else setTimeout(() => { if (Date.now() - lastTap >= 300) { chrome = !chrome; root.classList.toggle('bare', !chrome) } }, 310)
        lastTap = now
      }
    }
    let lastTap = 0
    strip.addEventListener('pointerup', up)
    strip.addEventListener('pointercancel', up)

    async function share() {
      const p = items[i]
      ctx.start({ action: 'send', type: isImg(p) ? 'image/jpeg' : 'video/*', data: 'shared:' + p, extras: { path: p } })
    }
    async function del() {
      const r = await dialog({ title: 'Delete', message: 'Delete this item?', cancel: 'Cancel', ok: 'OK' })
      if (r.button !== 'ok') return
      await shared.remove(items[i])
      items.splice(i, 1)
      slides[i].remove(); slides.splice(i, 1)
      ;[...loaded].forEach((k) => loaded.delete(k))
      slides.forEach((s) => (s.innerHTML = ''))
      if (!items.length) return pop()
      show(Math.min(i, items.length - 1), false)
    }
    async function setWall() {
      if (!isImg(items[i])) return toast('Only pictures can be wallpaper')
      settings.set('wallpaper', 'shared:' + items[i])
      toast('Wallpaper set')
    }
    show(start, false)
    return () => { viewing.on = false; screenEl.classList.remove('hide-sb'); slides.forEach((s) => s.querySelector('video')?.pause()) }
  }

  // view intent for one file
  const d = ctx.intent.data
  if (ctx.intent.action === 'view' && d) {
    const path = d.startsWith('shared:') ? d.slice(7) : null
    if (path) stack.push((el, pop) => viewer(el, () => (stack.depth() > 1 ? pop() : ctx.finish()), [path], 0))
    else { const v = h('div.g-viewer', {}, h(/video/.test(ctx.intent.type || '') ? 'video.g-full' : 'img.g-full', { src: d, controls: true })); ctx.root.append(v) }
  } else stack.push((el) => albumList(el))

  return {
    back: () => stack.pop(),
    resume() { if (viewing.on) screenEl.classList.add('hide-sb') },
    pause() { screenEl.classList.remove('hide-sb'); return undefined },
  }
}

const app: SystemApp = {
  manifest: {
    id: 'droid.gallery', name: 'Gallery', version: '4.4', versioncode: 19, type: 'web', main: 'gallery',
    activities: { gallery: { label: 'Gallery', launcher: true } }, system: true,
    'intent-filters': [
      { activity: 'gallery', actions: ['view', 'pick'], mimetypes: ['image/*', 'video/*'] },
    ],
    permissions: ['storage', 'system.wallpaper'],
  },
  icon: '',
  iconRef: ['apps/gallery', 'ic_launcher_gallery'],
  activities: { gallery },
}
export default app
