// launcher (role: launcher), modeled on aosp launcher3 from kitkat:
// workspace pages with a search bar, page indicator, hotseat with the all apps button in the middle,
// the all apps drawer, drag to move or remove, long press on empty space for the overview.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { img } from '../../shell/assets'
import { h, toast, dialog } from '../../shell/ui'
import { kernel, type AppEntry } from '../../shell/kernel'
import { wm } from '../../shell/wm'
import { screenEl, layers } from '../../shell/layers'
import { setWallpaperOffset } from '../wallpaper/index'
import './launcher.css'
import { SEARCH } from '../browser'

const L3 = 'apps/launcher3'
const KEY = 'droid.launcher'
interface Cell { pkg: string; activity: string }
interface Layout { pages: (Cell | null)[][]; hotseat: (Cell | null)[] }
const COLS = 4, ROWS = 4, HOTSEAT = 5, ALLAPPS_SLOT = 2

const DEFAULT_HOTSEAT = ['droid.browser', 'droid.contacts', null, 'droid.camera', 'droid.gallery']
const DEFAULT_PAGE = ['droid.settings', 'droid.store', 'droid.deskclock', 'droid.calculator', 'droid.files', 'droid.music', 'droid.email', 'droid.calendar']

function load(): Layout {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (l?.pages) return l
  } catch { /* fall through */ }
  const cell = (id: string | null): Cell | null => {
    const a = id && kernel.get(id)
    if (!a) return null
    const act = Object.entries(a.manifest.activities).find(([, d]) => d.launcher)
    return act ? { pkg: id!, activity: act[0] } : null
  }
  const page: (Cell | null)[] = Array(COLS * ROWS).fill(null)
  // default apps sit on the bottom row first, like stock
  DEFAULT_PAGE.map(cell).filter(Boolean).forEach((c, i) => (page[COLS * ROWS - COLS * (1 + Math.floor(i / COLS)) + (i % COLS)] = c))
  return { pages: [page, Array(COLS * ROWS).fill(null), Array(COLS * ROWS).fill(null)], hotseat: DEFAULT_HOTSEAT.map(cell) }
}
const save = (l: Layout) => { try { localStorage.setItem(KEY, JSON.stringify(l)) } catch { /* ignore */ } }

function iconEl(app: AppEntry, activity: string, label?: string) {
  const decl = app.manifest.activities[activity]
  return h('div.ic', { 'data-pkg': app.manifest.id, 'data-act': activity },
    h('img', { src: app.icon, draggable: false }),
    h('span', {}, label || decl?.label || app.manifest.name))
}

function launch(cell: Cell, from: HTMLElement) {
  from.classList.add('launching')
  setTimeout(() => from.classList.remove('launching'), 250)
  wm.start({ package: cell.pkg, activity: cell.activity, action: 'main' })
}

function launcher(ctx: ActivityContext): Activity & { translucent: boolean; home(): void } {
  let layout = load()
  let page = 0
  const root = h('div.launcher')
  const search = h('div.l-search', {}, h('img', { src: img(L3, 'ic_home_search_normal_holo') }), h('span', {}, 'Search'))
  search.addEventListener('click', async () => {
    const r = await dialog({ title: 'Search', kind: 'input', placeholder: 'Search the web', ok: 'Search' })
    if (r.button === 'ok' && r.value) wm.start({ action: 'view', data: SEARCH(r.value) })
  })
  const pagesWrap = h('div.l-pages')
  const strip = h('div.l-strip')
  pagesWrap.append(strip)
  const indicator = h('div.l-indicator')
  const hotseat = h('div.l-hotseat')
  const dropBar = h('div.l-dropbar', {}, h('div.l-drop.remove', {}, h('img', { src: img(L3, 'ic_launcher_clear_normal_holo') }), 'Remove'), h('div.l-drop.uninstall', {}, h('img', { src: img(L3, 'ic_launcher_trashcan_normal_holo') }), 'Uninstall'), h('div.l-drop.info', {}, h('img', { src: img(L3, 'ic_launcher_info_normal_holo') }), 'App info'))
  root.append(dropBar, search, pagesWrap, indicator, hotseat)
  ctx.root.append(root)

  const drawer = allApps(ctx, (cell) => { addToHome(cell); }, () => layout)
  const onStart = () => (drawer.isOpen() ? drawer.close() : drawer.open())
  document.addEventListener('droid:startmenu', onStart)
  // clicking a window or the desktop closes the start menu
  document.addEventListener('pointerdown', (e) => { if (drawer.isOpen() && screenEl.dataset.form === 'desktop' && !(e.target as HTMLElement).closest('.l-drawer, .tb-start')) drawer.close() }, true)

  function render() {
    strip.innerHTML = ''
    layout.pages.forEach((cells, p) => {
      const pg = h('div.l-page', { 'data-page': p })
      cells.forEach((c, i) => {
        const slot = h('div.l-cell', { 'data-page': p, 'data-i': i })
        const app = c && kernel.get(c.pkg)
        if (c && app) slot.append(bindIcon(iconEl(app, c.activity), c, { page: p, i }))
        pg.append(slot)
      })
      strip.append(pg)
    })
    hotseat.innerHTML = ''
    for (let i = 0; i < HOTSEAT; i++) {
      const slot = h('div.l-cell.hs', { 'data-hs': i })
      if (i === ALLAPPS_SLOT) {
        const all = h('div.ic.allapps', {}, h('img', { src: img(L3, 'ic_allapps') }))
        all.addEventListener('pointerdown', () => (all.querySelector('img')!.src = img(L3, 'ic_allapps_pressed')))
        all.addEventListener('pointerup', () => (all.querySelector('img')!.src = img(L3, 'ic_allapps')))
        all.addEventListener('click', () => drawer.open())
        slot.append(all)
      } else {
        const c = layout.hotseat[i]
        const app = c && kernel.get(c.pkg)
        if (c && app) { const ic = bindIcon(iconEl(app, c.activity), c, { hs: i }); ic.querySelector('span')!.remove(); slot.append(ic) }
      }
      hotseat.append(slot)
    }
    indicator.innerHTML = layout.pages.map((_, i) => `<img src="${img(L3, i === page ? 'ic_pageindicator_current' : 'ic_pageindicator_default')}">`).join('')
    goTo(page, false)
  }

  // ---------- paging ----------
  const width = () => pagesWrap.clientWidth || 1
  function goTo(p: number, anim = true) {
    page = Math.max(0, Math.min(layout.pages.length - 1, p))
    strip.style.transition = anim ? 'transform .3s cubic-bezier(.1,.7,.3,1)' : 'none'
    strip.style.transform = `translateX(${-page * width()}px)`
    setWallpaperOffset(layout.pages.length > 1 ? page / (layout.pages.length - 1) : 0.5, anim)
    indicator.querySelectorAll('img').forEach((im, i) => ((im as HTMLImageElement).src = img(L3, i === page ? 'ic_pageindicator_current' : 'ic_pageindicator_default')))
  }
  let swipe: { x: number; y: number; t: number; on: boolean } | null = null
  const scaleOf = () => parseFloat(screenEl.style.transform.match(/scale\(([\d.]+)\)/)?.[1] || '1')
  pagesWrap.addEventListener('pointerdown', (e) => {
    if (dragging) return
    swipe = { x: e.clientX, y: e.clientY, t: performance.now(), on: false }
  })
  pagesWrap.addEventListener('pointermove', (e) => {
    if (!swipe || dragging) return
    const dx = (e.clientX - swipe.x) / scaleOf()
    if (!swipe.on && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(e.clientY - swipe.y)) { swipe.on = true; pagesWrap.setPointerCapture(e.pointerId); cancelLong() }
    if (!swipe.on) {
      // swipe up on the workspace opens all apps, a swipe down opens the shade like newer launchers
      return
    }
    let off = -page * width() + dx
    const max = -(layout.pages.length - 1) * width()
    if (off > 0) off /= 3
    if (off < max) off = max + (off - max) / 3
    strip.style.transition = 'none'
    strip.style.transform = `translateX(${off}px)`
    setWallpaperOffset(Math.max(0, Math.min(1, -off / width() / Math.max(1, layout.pages.length - 1))), false)
  })
  const endSwipe = (e: PointerEvent) => {
    if (!swipe) return
    if (swipe.on) {
      const dx = (e.clientX - swipe.x) / scaleOf()
      const v = dx / (performance.now() - swipe.t)
      const target = Math.abs(dx) > width() / 2 || Math.abs(v) > 0.4 ? page - Math.sign(dx) : page
      goTo(target)
      pagesWrap.addEventListener('click', (ev) => ev.stopPropagation(), { capture: true, once: true })
    }
    swipe = null
  }
  pagesWrap.addEventListener('pointerup', endSwipe)
  pagesWrap.addEventListener('pointercancel', endSwipe)

  // ---------- long press: drag icons, or overview on empty space ----------
  let longT = 0
  const cancelLong = () => clearTimeout(longT)
  type Pos = { page?: number; i?: number; hs?: number }
  let dragging: { cell: Cell; from: Pos; ghost: HTMLElement } | null = null

  function bindIcon(el: HTMLElement, cell: Cell, from: Pos) {
    el.addEventListener('click', () => !dragging && launch(cell, el))
    el.addEventListener('pointerdown', (e) => {
      el.classList.add('pressed')
      longT = window.setTimeout(() => startDrag(e, el, cell, from), 450)
    })
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => { el.classList.remove('pressed'); if (!dragging) cancelLong() })
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    return el
  }

  function startDrag(e: PointerEvent, el: HTMLElement, cell: Cell, from: Pos) {
    swipe = null
    const s = scaleOf()
    const r = el.getBoundingClientRect()
    const sr = screenEl.getBoundingClientRect()
    const ghost = el.cloneNode(true) as HTMLElement
    ghost.classList.add('l-ghost')
    ghost.style.left = (r.left - sr.left) / s + 'px'
    ghost.style.top = (r.top - sr.top) / s + 'px'
    layers.overlay.append(ghost)
    el.style.visibility = 'hidden'
    dragging = { cell, from, ghost }
    root.classList.add('dragging')
    const app = kernel.get(cell.pkg)
    dropBar.querySelector<HTMLElement>('.uninstall')!.style.display = app?.system ? 'none' : ''
    navigator.vibrate?.(20)
    const ox = e.clientX, oy = e.clientY
    const gx = parseFloat(ghost.style.left), gy = parseFloat(ghost.style.top)
    let over: Element | null = null
    const move = (ev: PointerEvent) => {
      ghost.style.left = gx + (ev.clientX - ox) / s + 'px'
      ghost.style.top = gy + (ev.clientY - oy) / s + 'px'
      ghost.style.display = 'none'
      over = document.elementFromPoint(ev.clientX, ev.clientY)
      ghost.style.display = ''
      dropBar.querySelectorAll('.l-drop').forEach((d) => d.classList.toggle('hover', d.contains(over)))
      // dragging to the screen edge flips pages
      const x = (ev.clientX - sr.left) / s
      if (x < 12 && page > 0) { goTo(page - 1); }
      else if (x > width() - 12 && page < layout.pages.length - 1) goTo(page + 1)
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      const drop = over?.closest('.l-drop, .l-cell') as HTMLElement | null
      el.style.visibility = ''
      ghost.remove()
      root.classList.remove('dragging')
      const d = dragging!
      dragging = null
      if (!drop) return
      if (drop.classList.contains('remove')) { clear(d.from); persist(); return }
      if (drop.classList.contains('info')) { wm.start({ action: 'settings', extras: { page: 'app', pkg: d.cell.pkg } }); return }
      if (drop.classList.contains('uninstall')) { wm.start({ action: 'uninstall', data: 'package:' + d.cell.pkg }); return }
      const target: Pos = drop.dataset.hs != null ? { hs: +drop.dataset.hs } : { page: +drop.dataset.page!, i: +drop.dataset.i! }
      if (target.hs === ALLAPPS_SLOT) return
      const existing = get(target)
      put(target, d.cell)
      if (d.from.page != null || d.from.hs != null) put(d.from, existing)
      persist()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const get = (t: Pos) => (t.hs != null ? layout.hotseat[t.hs] : t.page != null ? layout.pages[t.page][t.i!] : null)
  const put = (t: Pos, c: Cell | null) => { if (t.hs != null) layout.hotseat[t.hs] = c; else if (t.page != null) layout.pages[t.page][t.i!] = c }
  const clear = (t: Pos) => put(t, null)
  const persist = () => { save(layout); render() }

  function addToHome(cell: Cell) {
    for (let p = page; p < page + layout.pages.length; p++) {
      const pg = layout.pages[p % layout.pages.length]
      const i = pg.findIndex((c) => !c)
      if (i >= 0) { pg[i] = cell; persist(); goTo(p % layout.pages.length); toast('Added to Home screen'); return }
    }
    toast('No more room on this Home screen.')
  }

  // overview (long press on empty workspace): wallpapers, widgets, settings
  pagesWrap.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.ic')) return
    longT = window.setTimeout(() => overview(), 600)
  })
  pagesWrap.addEventListener('pointerup', cancelLong)
  pagesWrap.addEventListener('pointermove', (e) => { if (swipe && Math.hypot(e.clientX - swipe.x, e.clientY - swipe.y) > 10) cancelLong() })
  function overview() {
    swipe = null
    const bar = h('div.l-overview', {},
      h('div.l-ov-btn', { onclick: () => { close(); wm.start({ action: 'set-wallpaper' }) } }, h('img', { src: img(L3, 'ic_wallpaper') }), 'Wallpapers'),
      h('div.l-ov-btn', { onclick: () => { close(); toast('Widgets come with a later droid version') } }, h('img', { src: img(L3, 'ic_widget') }), 'Widgets'),
      h('div.l-ov-btn', { onclick: () => { close(); wm.start({ action: 'settings' }) } }, h('img', { src: img(L3, 'ic_setting') }), 'Settings'))
    root.classList.add('overview')
    root.append(bar)
    const close = () => { root.classList.remove('overview'); bar.remove(); document.removeEventListener('droid:back', onBack, true) }
    const onBack = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); close() }
    document.addEventListener('droid:back', onBack, true)
    setTimeout(() => pagesWrap.addEventListener('click', close, { once: true }), 0)
  }

  render()
  kernel.onAppsChanged(() => {
    // drop cells of uninstalled apps
    layout.pages = layout.pages.map((p) => p.map((c) => (c && kernel.get(c.pkg) ? c : null)))
    layout.hotseat = layout.hotseat.map((c) => (c && kernel.get(c.pkg) ? c : null))
    save(layout)
    render()
    drawer.refresh()
  })
  const ro = new ResizeObserver(() => goTo(page, false))
  ro.observe(pagesWrap)

  return {
    translucent: true,
    back() { if (drawer.isOpen()) { drawer.close(); return true } return true },
    home() { if (drawer.isOpen()) drawer.close(); else goTo(0) },
    resume() { root.classList.add('resumed') },
    configchange() { render() },
  }
}

// ---------- all apps ----------
function allApps(ctx: ActivityContext, onAdd: (c: Cell) => void, _layout: () => Layout) {
  const el = h('div.l-drawer')
  const tabs = h('div.l-tabs', {}, h('div.l-tab.selected', {}, 'Apps'), h('div.l-tab', {}, 'Widgets'))
  tabs.lastChild!.addEventListener('click', () => toast('Widgets come with a later droid version'))
  const grid = h('div.l-grid')
  // the start menu (desktop mode) has a search field on top
  const q = h('input.h-edit.l-search-in', { placeholder: 'Search apps', oninput: () => filter() }) as HTMLInputElement
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') (grid.querySelector('.ic:not([hidden])') as HTMLElement | null)?.click() })
  const filter = () => grid.querySelectorAll<HTMLElement>('.ic').forEach((ic) => (ic.hidden = !ic.textContent!.toLowerCase().includes(q.value.toLowerCase())))
  el.append(tabs, q, grid)
  ctx.root.append(el)
  let open = false
  const refresh = () => {
    grid.innerHTML = ''
    for (const l of kernel.launchables()) {
      const ic = iconEl(l.app, l.activity, l.label)
      const cell = { pkg: l.app.manifest.id, activity: l.activity }
      let t = 0
      ic.addEventListener('click', () => { api.close(); launch(cell, ic) })
      ic.addEventListener('dblclick', (e) => e.preventDefault())
      ic.addEventListener('pointerdown', () => { ic.classList.add('pressed'); t = window.setTimeout(() => { api.close(); onAdd(cell) }, 500) })
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) ic.addEventListener(ev, () => { ic.classList.remove('pressed'); clearTimeout(t) })
      ic.addEventListener('contextmenu', (e) => e.preventDefault())
      grid.append(ic)
    }
  }
  refresh()
  const api = {
    open() { open = true; el.classList.add('open'); ctx.root.classList.add('drawer-open'); wm.relayout(); grid.scrollTop = 0; q.value = ''; filter(); if (screenEl.dataset.form === 'desktop') setTimeout(() => q.focus(), 50) },
    close() { open = false; el.classList.remove('open'); ctx.root.classList.remove('drawer-open'); wm.relayout() },
    isOpen: () => open,
    refresh,
  }
  return api
}

const app: SystemApp = {
  manifest: {
    id: 'droid.launcher', name: 'Launcher', version: '4.4', versioncode: 19, type: 'web', main: 'home',
    activities: { home: { label: 'Launcher' } }, role: 'launcher', system: true,
    permissions: ['system.apps', 'system.wallpaper'],
    supports: ['phone', 'tablet', 'desktop'],
  },
  icon: '',
  activities: { home: launcher },
}
export default app
