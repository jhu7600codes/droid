// systemui (role: systemui): status bar, notification shade, quick settings, navigation bar,
// recents and the lockscreen. a system app with a background service and no activities.
import type { SystemApp } from '../../shell/types'
import { layers, screenEl } from '../../shell/layers'
import { img } from '../../shell/assets'
import { h, pressable } from '../../shell/ui'
import { wm } from '../../shell/wm'
import { settings } from '../../shell/settings'
import { notifications } from '../../shell/notify'
import { state as netState, onNetwork } from '../../shell/net'
import { kernel } from '../../shell/kernel'
import { lockscreen } from './lockscreen'
import { recents } from './recents'
import './systemui.css'

const SUI = 'systemui'
const fmtTime = (d: Date) => {
  if (settings.get('time.24h')) return d.toTimeString().slice(0, 5)
  const hr = d.getHours() % 12 || 12
  return `${hr}:${String(d.getMinutes()).padStart(2, '0')}`
}
const fmtDate = (d: Date) => d.toLocaleDateString(settings.get('locale') || 'en', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()

// battery: kitkat draws it in code (BatteryMeterView), so do we
let battery = { level: 1, charging: false }
function batteryIcon(cls = 'sb-battery') {
  const pct = Math.round(battery.level * 100)
  const fill = Math.max(0, Math.min(1, battery.level))
  const low = pct <= 15 && !battery.charging
  return `<svg class="${cls}" viewBox="0 0 10 17"><rect x="3" y="0" width="4" height="2" fill="rgba(255,255,255,.4)"/>
    <rect x="0" y="2" width="10" height="15" fill="rgba(255,255,255,.3)"/>
    <rect x="0" y="${2 + 15 * (1 - fill)}" width="10" height="${15 * fill}" fill="${low ? '#ff4444' : '#fff'}"/>
    ${battery.charging ? '<path d="M6 4 L2 10 H5 L4 15 L8 8 H5 Z" fill="#000" opacity=".6"/>' : ''}</svg>`
}

function signalIcons() {
  const s = netState()
  const out: string[] = []
  if (settings.get('airplane')) out.push(`<img src="${img(SUI, 'stat_sys_signal_flightmode')}">`)
  else {
    if (s.kind === 'drnt') out.push(`<img src="${img(SUI, `stat_sys_wifi_signal_${s.signal}_fully`)}">`)
    // the vte "mobile" bars are always there unless airplane, like a phone with a sim
    const lvl = settings.get('data.on') ? 4 : 0
    if (s.kind === 'vte') out.push(`<span class="sb-stack"><img src="${img(SUI, 'stat_sys_data_fully_connected_lte')}"><img src="${img(SUI, `stat_sys_signal_${lvl}_fully`)}"></span>`)
    else out.push(`<img src="${img(SUI, `stat_sys_signal_${lvl}_fully`)}">`)
  }
  return out.join('')
}

function statusBar() {
  const bar = h('div.sb')
  const left = h('div.sb-left')
  const right = h('div.sb-right')
  const clock = h('span.sb-clock')
  bar.append(left, right)
  const render = () => {
    left.innerHTML = notifications.all().slice(0, 6).map((n) => `<img src="${n.icon}">`).join('')
    right.innerHTML = signalIcons() + batteryIcon()
    clock.textContent = fmtTime(new Date())
    right.append(clock)
  }
  render()
  setInterval(render, 15000)
  notifications.on(render)
  onNetwork(render)
  settings.on('*', render)
  // dark bar for apps, see-through over the launcher and lockscreen (kitkat translucent bars)
  wm.on('change', () => layers.statusbar.classList.toggle('see-through', !!wm.top()?.el.classList.contains('translucent')))
  layers.statusbar.append(bar)
  return render
}

// ---------- navigation bar ----------
function navBar() {
  const nav = h('div.nav')
  const btn = (name: string, fn: () => void, long?: () => void) => {
    const b = pressable(h(`div.nav-btn.nav-${name}`, {}, h('img')))
    b.addEventListener('click', fn)
    if (long) {
      let t = 0
      b.addEventListener('pointerdown', () => (t = window.setTimeout(long, 500)))
      b.addEventListener('pointerup', () => clearTimeout(t))
      b.addEventListener('pointerleave', () => clearTimeout(t))
    }
    return b
  }
  const back = btn('back', () => wm.back())
  const home = btn('home', () => { recents.hide(); shade.close(); wm.home() })
  const rec = btn('recent', () => { shade.close(); recents.toggle() })
  const menu = btn('menu', () => wm.menu())
  nav.append(h('div.nav-gap'), back, home, rec, h('div.nav-gap.menu-slot', {}, menu))
  const icons = () => {
    const land = screenEl.dataset.nav === 'right' ? '_land' : ''
    const ime = document.documentElement.classList.contains('ime-open')
    back.querySelector('img')!.src = img(SUI, ime ? 'ic_sysbar_back_ime' : `ic_sysbar_back${land}`)
    home.querySelector('img')!.src = img(SUI, `ic_sysbar_home${land}`)
    rec.querySelector('img')!.src = img(SUI, `ic_sysbar_recent${land}`)
    menu.querySelector('img')!.src = img(SUI, `ic_sysbar_menu${land}`)
    // the menu button only shows for legacy-menu apps (spec section 20)
    menu.style.visibility = wm.top()?.app.manifest['legacy-menu'] ? 'visible' : 'hidden'
  }
  icons()
  wm.on('change', icons)
  new MutationObserver(icons).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  new MutationObserver(icons).observe(screenEl, { attributes: true, attributeFilter: ['data-nav'] })
  wm.on('change', () => layers.navbar.classList.toggle('see-through', !!wm.top()?.el.classList.contains('translucent')))
  layers.navbar.append(nav)
  // keyboard: escape / alt+left is back (spec section 20)
  addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' || (e.altKey && e.key === 'ArrowLeft')) { e.preventDefault(); wm.back() }
    if (e.altKey && e.key === 'Home') wm.home()
  })
}

// ---------- desktop taskbar (spec section 17): systemui becomes the taskbar ----------
function taskBar() {
  const bar = h('div.taskbar')
  const start = pressable(h('div.tb-start', { title: 'Start' }, h('img', { src: 'assets/brand/droid-d-icon.svg' })))
  start.addEventListener('click', () => document.dispatchEvent(new Event('droid:startmenu')))
  const nav = (name: string, title: string, fn: () => void) => pressable(h('div.tb-nav', { title, onclick: fn }, h('img', { src: img(SUI, name) })))
  const tasks = h('div.tb-tasks')
  const tray = pressable(h('div.tb-tray'))
  tray.addEventListener('click', () => shade.open(false))
  bar.append(start, nav('ic_sysbar_back', 'Back', () => wm.back()), nav('ic_sysbar_home', 'Show desktop', () => wm.home()), nav('ic_sysbar_recent', 'Task view', () => recents.toggle()), tasks, tray)
  const render = () => {
    tasks.innerHTML = ''
    for (const t of wm.tasks) {
      if (t.home) continue
      const top = t.stack[t.stack.length - 1]
      const b = pressable(h('div.tb-task' + (t === wm.front() ? '.on' : ''), { title: top?.title || t.label }, h('img', { src: t.icon }), h('span', {}, top?.title || t.label)))
      // click: focus, or minimize when it is already in front (like a desktop taskbar)
      b.addEventListener('click', () => (t === wm.front() ? wm.minimize(t) : wm.switchTo(t, false)))
      b.addEventListener('auxclick', (e) => { if ((e as MouseEvent).button === 1) wm.removeTask(t) })
      tasks.append(b)
    }
    const d = new Date()
    tray.innerHTML = signalIcons() + batteryIcon() + `<span class="tb-clock">${fmtTime(d)}<br><small>${d.toLocaleDateString(settings.get('locale') || 'en')}</small></span>`
  }
  render()
  wm.on('change', render)
  setInterval(render, 15000)
  settings.on('*', render)
  layers.navbar.append(bar)
}

// ---------- shade + quick settings ----------
const shade = {
  open: (_qs = false) => {},
  close: () => {},
}

function qsTiles(onChange: () => void) {
  const tiles: { id: string; label: () => string; icon: () => string; tap: () => void; long?: () => void }[] = [
    { id: 'user', label: () => settings.get('owner.name') || 'Owner', icon: () => img(SUI, 'ic_qs_default_user'), tap: () => openSettings('users') },
    { id: 'brightness', label: () => 'Brightness', icon: () => img(SUI, settings.get('brightness.auto') ? 'ic_qs_brightness_auto_on' : 'ic_qs_brightness_auto_off'), tap: () => settings.set('brightness.auto', !settings.get('brightness.auto')) },
    { id: 'settings', label: () => 'Settings', icon: () => img(SUI, 'ic_qs_settings'), tap: () => openSettings() },
    { id: 'wifi', label: () => (settings.get('wifi.on') ? (netState().kind === 'drnt' ? netState().name : 'Wi-Fi') : 'Wi-Fi off'), icon: () => img(SUI, settings.get('wifi.on') ? `ic_qs_wifi_full_${Math.max(1, netState().kind === 'drnt' ? netState().signal : 1)}` : 'ic_qs_wifi_no_network'), tap: () => settings.set('wifi.on', !settings.get('wifi.on')), long: () => openSettings('wifi') },
    { id: 'data', label: () => (settings.get('data.on') ? 'VTE' : 'Data off'), icon: () => img(SUI, settings.get('data.on') ? 'ic_qs_signal_full_4g' : 'ic_qs_signal_no_signal'), tap: () => settings.set('data.on', !settings.get('data.on')), long: () => openSettings('data') },
    { id: 'battery', label: () => `${Math.round(battery.level * 100)}%`, icon: () => '', tap: () => openSettings('battery') },
    { id: 'airplane', label: () => 'Airplane mode', icon: () => img(SUI, settings.get('airplane') ? 'ic_qs_airplane_on' : 'ic_qs_airplane_off'), tap: () => settings.set('airplane', !settings.get('airplane')) },
    { id: 'rotation', label: () => (settings.get('rotation.lock') ? 'Rotation locked' : 'Auto rotate'), icon: () => img(SUI, settings.get('rotation.lock') ? 'ic_qs_rotation_locked' : 'ic_qs_auto_rotate'), tap: () => settings.set('rotation.lock', !settings.get('rotation.lock')) },
    { id: 'location', label: () => (settings.get('location.on') ? 'Location' : 'Location off'), icon: () => img(SUI, settings.get('location.on') ? 'ic_qs_location_on' : 'ic_qs_location_off'), tap: () => settings.set('location.on', !settings.get('location.on')) },
  ]
  const grid = h('div.qs-grid')
  const render = () => {
    grid.innerHTML = ''
    for (const t of tiles) {
      const ic = t.id === 'battery' ? batteryIcon('qs-battery') : `<img src="${t.icon()}">`
      const el = pressable(h('div.qs-tile', { html: `<div class="qs-icon">${ic}</div><div class="qs-label">${t.label()}</div>` }))
      el.addEventListener('click', () => { t.tap(); render(); onChange() })
      if (t.long) el.addEventListener('contextmenu', (e) => { e.preventDefault(); t.long!() })
      grid.append(el)
    }
  }
  render()
  settings.on('*', render)
  return { grid, render }
}

function openSettings(page?: string) {
  shade.close()
  wm.start({ action: 'settings', extras: page ? { page } : {} })
}

function buildShade() {
  const root = layers.shade
  const scrim = h('div.shade-scrim')
  const panel = h('div.shade-panel')
  const header = h('div.shade-header')
  const clock = h('div.shade-clock')
  const date = h('div.shade-date')
  const qsBtn = pressable(h('div.shade-hbtn', {}, h('img', { src: img(SUI, 'ic_notify_quicksettings_normal') })))
  const clearBtn = pressable(h('div.shade-hbtn', {}, h('img', { src: img(SUI, 'ic_notify_clear_normal') })))
  header.append(h('div.shade-time', {}, clock, date), h('div', { style: { flex: '1' } }), clearBtn, qsBtn)
  const list = h('div.shade-list')
  const empty = h('div.shade-empty', {}, 'No notifications')
  const qs = qsTiles(() => {})
  const flip = h('div.shade-flip')
  const notes = h('div.shade-notes', {}, list)
  flip.append(notes, h('div.shade-qs', {}, qs.grid))
  const handle = h('div.shade-handle')
  panel.append(header, flip, handle)
  root.append(scrim, panel)

  let openFrac = 0
  let qsMode = false
  const setQs = (on: boolean) => {
    qsMode = on
    panel.classList.toggle('qs', on)
    qsBtn.querySelector('img')!.src = img(SUI, on ? 'ic_notify_open_normal' : 'ic_notify_quicksettings_normal')
    clearBtn.style.visibility = on || !notifications.all().some((n) => !n.ongoing) ? 'hidden' : 'visible'
  }
  const renderList = () => {
    list.innerHTML = ''
    const all = notifications.all()
    if (!all.length) list.append(empty)
    for (const n of all) {
      const app = kernel.get(n.pkg)
      const row = pressable(h('div.note', {},
        h('div.note-icon', {}, h('img', { src: n.largeIcon || app?.icon || n.icon })),
        h('div.note-body', {}, h('div.note-title', {}, n.title), n.text ? h('div.note-text', {}, n.text) : null,
          n.progress != null ? h('div.h-progress.note-prog', {}, h('span.bar', { style: { width: (n.progress < 0 ? 100 : n.progress * 100) + '%' } })) : null),
        h('div.note-time', {}, fmtTime(new Date(n.time))),
      ))
      row.addEventListener('click', () => { close(); n.onclick?.(); if (!n.ongoing) notifications.cancel(n.pkg, n.id) })
      swipeAway(row, () => !n.ongoing && notifications.cancel(n.pkg, n.id))
      list.append(row)
    }
    setQs(qsMode)
  }
  renderList()
  notifications.on(renderList)
  clearBtn.addEventListener('click', () => notifications.clearAll())
  qsBtn.addEventListener('click', () => setQs(!qsMode))

  const tick = () => { const d = new Date(); clock.textContent = fmtTime(d); date.textContent = fmtDate(d) }
  setInterval(tick, 15000)

  const apply = (f: number, anim: boolean) => {
    openFrac = f
    panel.style.transition = scrim.style.transition = anim ? 'transform .25s cubic-bezier(.1,.7,.3,1), opacity .25s' : 'none'
    // desktop: the panel comes up from the taskbar instead of down from the status bar
    panel.style.transform = screenEl.dataset.form === 'desktop' ? `translateY(${(1 - f) * 110}%)` : `translateY(${(f - 1) * 100}%)`
    scrim.style.opacity = String(f * 0.7)
    root.classList.toggle('open', f > 0)
  }
  const open = (withQs = false) => { tick(); setQs(withQs); apply(1, true); wm.cover(true) }
  const close = () => { if (openFrac > 0) { apply(0, true); wm.cover(false) } }
  shade.open = open
  shade.close = close
  apply(0, false)
  scrim.addEventListener('click', close)
  document.addEventListener('droid:back', (e) => { if (openFrac > 0) { e.preventDefault(); e.stopImmediatePropagation(); close() } }, true)

  // drag down from the status bar to open; drag the handle up to close.
  // starting on the right third opens quick settings directly
  const drag = (startEl: HTMLElement, opening: boolean) => {
    startEl.addEventListener('pointerdown', (e) => {
      if (lockscreen.isLocked() && !lockscreen.allowShade()) return
      const y0 = e.clientY
      const scale = parseFloat(screenEl.style.transform.match(/scale\(([\d.]+)\)/)?.[1] || '1')
      const hgt = panel.getBoundingClientRect().height / scale || 400
      if (opening) { tick(); const r = startEl.getBoundingClientRect(); setQs(e.clientX - r.left > r.width * 0.66) }
      startEl.setPointerCapture(e.pointerId)
      let moved = false
      const move = (ev: PointerEvent) => {
        const dy = (ev.clientY - y0) / scale
        if (Math.abs(dy) > 4) moved = true
        apply(Math.max(0, Math.min(1, opening ? dy / hgt : 1 + dy / hgt)), false)
      }
      const up = () => {
        startEl.removeEventListener('pointermove', move)
        const shouldOpen = moved ? openFrac > (opening ? 0.25 : 0.75) : !opening ? false : openFrac > 0
        if (shouldOpen) { apply(1, true); wm.cover(true) } else { apply(0, true); wm.cover(false) }
      }
      startEl.addEventListener('pointermove', move)
      startEl.addEventListener('pointerup', up, { once: true })
      startEl.addEventListener('pointercancel', up, { once: true })
    })
  }
  drag(layers.statusbar, true)
  drag(handle, false)
}

// horizontal swipe to dismiss (notifications, recents)
export function swipeAway(el: HTMLElement, done: () => void, axis: 'x' | 'y' = 'x') {
  el.style.touchAction = axis === 'x' ? 'pan-y' : 'pan-x'
  el.addEventListener('pointerdown', (e) => {
    const p0 = axis === 'x' ? e.clientX : e.clientY
    let d = 0
    let captured = false
    const move = (ev: PointerEvent) => {
      d = (axis === 'x' ? ev.clientX : ev.clientY) - p0
      if (!captured && Math.abs(d) > 10) { captured = true; el.setPointerCapture(ev.pointerId); el.classList.add('swiping') }
      if (captured) {
        el.style.transform = axis === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`
        el.style.opacity = String(1 - Math.min(1, Math.abs(d) / 300))
      }
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      if (!captured) return
      // swallow the click that follows a swipe
      el.addEventListener('click', (ev) => ev.stopImmediatePropagation(), { capture: true, once: true })
      el.style.transition = 'transform .2s, opacity .2s'
      if (Math.abs(d) > 100) {
        el.style.transform = axis === 'x' ? `translateX(${Math.sign(d) * 500}px)` : `translateY(${Math.sign(d) * 800}px)`
        el.style.opacity = '0'
        setTimeout(done, 200)
      } else {
        el.style.transform = ''
        el.style.opacity = ''
      }
      setTimeout(() => { el.style.transition = ''; el.classList.remove('swiping') }, 220)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up, { once: true })
    el.addEventListener('pointercancel', up, { once: true })
  })
}

const app: SystemApp = {
  manifest: {
    id: 'droid.systemui', name: 'System UI', version: '4.4', versioncode: 19, type: 'web', main: 'none',
    activities: {}, role: 'systemui', system: true,
    permissions: ['system.statusbar', 'system.notifications', 'system.windows', 'system.apps'],
  },
  icon: '',
  activities: {},
  async service() {
    const nav = (navigator as any).getBattery?.()
    if (nav) {
      const b = await nav.catch(() => null)
      if (b) {
        const up = () => { battery = { level: b.level, charging: b.charging }; render() }
        b.addEventListener('levelchange', up)
        b.addEventListener('chargingchange', up)
        battery = { level: b.level, charging: b.charging }
      }
    }
    const render = statusBar()
    navBar()
    taskBar()
    buildShade()
    recents.init()
    lockscreen.init()
  },
}
export default app
export { shade }
