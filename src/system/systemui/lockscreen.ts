// kitkat lockscreen: big thin clock, date, owner info, glowpad at the bottom.
// drag the handle to the unlock target (right) or the camera (left). optional pin bouncer.
import { isDesktop } from '../../shell/desktop'
import { layers, screenEl } from '../../shell/layers'
import { img } from '../../shell/assets'
import { h, pressable } from '../../shell/ui'
import { settings } from '../../shell/settings'
import { wm } from '../../shell/wm'
import { kernel } from '../../shell/kernel'
import { sound } from '../../shell/sound'

const KG = 'keyguard'
let locked = false
let root: HTMLElement
let onUnlock: (() => void)[] = []

function clockText() {
  const d = new Date()
  if (settings.get('time.24h')) return d.toTimeString().slice(0, 5)
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`
}

function build() {
  root = h('div.lock')
  const clock = h('div.lock-clock')
  const date = h('div.lock-date')
  const owner = h('div.lock-owner')
  const tick = () => {
    clock.textContent = clockText()
    date.textContent = new Date().toLocaleDateString(settings.get('locale') || 'en', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()
    owner.textContent = settings.get('owner.name') as string
  }
  tick()
  setInterval(tick, 10000)
  const status = h('div.lock-status', {}, clock, date, owner)

  // glowpad
  const pad = h('div.glowpad')
  const ring = h('div.gp-ring')
  const handle = <HTMLImageElement>h('img.gp-handle', { src: img(KG, 'ic_lockscreen_handle_normal'), draggable: false })
  const unlockT = <HTMLImageElement>h('img.gp-target.right', { src: img(KG, 'ic_lockscreen_unlock_normal') })
  const cameraT = <HTMLImageElement>h('img.gp-target.left', { src: img(KG, 'ic_lockscreen_camera_normal') })
  pad.append(ring, unlockT, cameraT, handle)
  const hint = h('div.lock-hint', {}, '')

  let x0 = 0, y0 = 0, scale = 1
  handle.addEventListener('pointerdown', (e) => {
    x0 = e.clientX; y0 = e.clientY
    scale = handle.getBoundingClientRect().width / handle.offsetWidth || 1
    handle.setPointerCapture(e.pointerId)
    pad.classList.add('active')
    handle.src = img(KG, 'ic_lockscreen_handle_pressed')
  })
  const R = 110
  handle.addEventListener('pointermove', (e) => {
    if (!pad.classList.contains('active')) return
    let dx = (e.clientX - x0) / scale, dy = (e.clientY - y0) / scale
    const d = Math.hypot(dx, dy)
    if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R }
    handle.style.transform = `translate(${dx}px, ${dy}px)`
    // a target counts when the handle is mostly toward it and most of the way there (a mouse drag
    // rarely lands exactly on it)
    const near = (tx: number) => Math.hypot(dx - tx, dy) < 40 || (Math.sign(dx) === Math.sign(tx) && Math.abs(dx) > R * 0.6 && Math.abs(dy) < Math.abs(dx))
    unlockT.src = img(KG, near(R) ? 'ic_lockscreen_unlock_activated' : 'ic_lockscreen_unlock_normal')
    cameraT.src = img(KG, near(-R) ? 'ic_lockscreen_camera_activated' : 'ic_lockscreen_camera_normal')
    handle.dataset.hit = near(R) ? 'unlock' : near(-R) ? 'camera' : ''
  })
  const release = () => {
    pad.classList.remove('active')
    handle.style.transform = ''
    handle.src = img(KG, 'ic_lockscreen_handle_normal')
    const hit = handle.dataset.hit
    handle.dataset.hit = ''
    if (hit === 'unlock') attemptUnlock()
    if (hit === 'camera') attemptUnlock(() => wm.start({ action: 'capture', extras: { fromLock: true } }))
  }
  handle.addEventListener('pointerup', release)
  handle.addEventListener('pointercancel', release)
  // a tap shows the hint like kitkat
  // on desktop a click unlocks (a mouse is not a finger); on touch it shows the hint like kitkat
  let moved = false
  handle.addEventListener('pointerdown', () => (moved = false))
  handle.addEventListener('pointermove', (e) => { if (pad.classList.contains('active') && Math.hypot(e.clientX - x0, e.clientY - y0) > 8) moved = true })
  handle.addEventListener('click', (e) => {
    if (moved) return
    if (isDesktop() || (e as PointerEvent).pointerType === 'mouse') return attemptUnlock()
    hint.textContent = 'Swipe to unlock'; setTimeout(() => (hint.textContent = ''), 1500)
  })
  // keyboard: enter or space unlocks
  document.addEventListener('keydown', (e) => {
    if (!locked || root.querySelector('.pin-bouncer')) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); attemptUnlock() }
  })

  root.append(status, h('div', { style: { flex: '1' } }), hint, pad)
  layers.lock.append(root)
  const camOk = () => (cameraT.style.display = kernel.resolve({ action: 'capture' }).length ? '' : 'none')
  camOk()
  kernel.onAppsChanged(camOk)
}

function attemptUnlock(then?: () => void) {
  if (settings.get('lock.type') === 'pin' && settings.get('lock.pin')) return bouncer(then)
  unlock(then)
}

function bouncer(then?: () => void) {
  let entered = ''
  const dots = h('div.pin-dots')
  const msg = h('div.pin-msg', {}, 'Enter PIN')
  const keys = h('div.pin-keys')
  const upd = () => (dots.textContent = '•'.repeat(entered.length))
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫︎', '0', 'OK']) {
    const b = pressable(h('div.pin-key', {}, k))
    b.addEventListener('click', () => {
      if (k === '⌫︎') entered = entered.slice(0, -1)
      else if (k === 'OK') {
        if (entered === settings.get('lock.pin')) { box.remove(); unlock(then) }
        else { msg.textContent = 'Wrong PIN'; entered = '' }
      } else if (entered.length < 16) entered += k
      upd()
    })
    keys.append(b)
  }
  const box = h('div.pin-bouncer', {}, msg, dots, keys)
  root.append(box)
}

function unlock(then?: () => void) {
  locked = false
  if (settings.get('sound.lock') !== false) sound.play('Unlock')
  root.classList.add('unlocking')
  screenEl.classList.remove('locked')
  setTimeout(() => { root.style.display = 'none'; root.classList.remove('unlocking') }, 300)
  wm.cover(false)
  onUnlock.forEach((f) => f())
  then?.()
}

export const lockscreen = {
  init() {
    build()
    root.style.display = 'none'
    // screen off / on: the page being hidden counts as the power button
    document.addEventListener('visibilitychange', () => { if (document.hidden && settings.get('setup.done')) lockscreen.lock() })
  },
  lock() {
    if (settings.get('lock.type') === 'none') return
    if (!locked && settings.get('sound.lock') !== false && settings.get('setup.done')) sound.play('Lock')
    locked = true
    root.style.display = ''
    screenEl.classList.add('locked')
    root.querySelector('.pin-bouncer')?.remove()
    wm.cover(true)
  },
  isLocked: () => locked,
  allowShade: () => false,
  whenUnlocked(f: () => void) { onUnlock.push(f) },
}
