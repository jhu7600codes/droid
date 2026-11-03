// desktop mode (spec section 17): freeform windows. every task gets a frame (title bar, buttons, border).
// activity elements are never moved in the dom (that would reload iframes): they stay in the windows
// layer and are positioned over their frame's content area.
import type { Task } from './wm'
import { h, pressable } from './ui'
import { layers, screenEl } from './layers'

interface Frame { el: HTMLElement; title: HTMLElement; icon: HTMLImageElement; x: number; y: number; w: number; h: number; max: boolean; min: boolean; fixed: boolean; restore?: { x: number; y: number; w: number; h: number } }
const frames = new Map<number, Frame>()
const TITLE = 32, TASKBAR = 40, PHONE = { w: 360, h: 640 }
let cascade = 0
type Hooks = { focus(t: Task): void; close(t: Task): void; resized(t: Task): void }
let hooks: Hooks

export const isDesktop = () => screenEl?.dataset.form === 'desktop'
export const initDesktop = (h2: Hooks) => (hooks = h2)

const area = () => ({ w: screenEl.clientWidth || 1280, h: (screenEl.clientHeight || 800) - TASKBAR })

function frameFor(t: Task): Frame {
  let f = frames.get(t.id)
  if (f) return f
  const app = t.stack[0]?.app
  const m = app?.manifest
  // apps that don't list desktop run in a phone-sized window; only resizable ones can be resized
  const fixed = !m?.supports?.includes('desktop') && !app?.system || (!m?.resizable && !app?.system)
  const phone = !m?.supports?.includes('desktop') && !app?.system
  const a = area()
  const w = phone ? PHONE.w : Math.min(900, a.w - 80), hh = phone ? PHONE.h : Math.min(600, a.h - 80)
  const x = Math.max(0, Math.min(a.w - w, 60 + (cascade % 8) * 32)), y = Math.max(0, Math.min(a.h - hh - TITLE, 40 + (cascade % 8) * 32))
  cascade++
  const icon = h('img.dw-icon', { src: t.icon }) as HTMLImageElement
  const title = h('span.dw-title', {}, t.label)
  const btn = (cls: string, label: string, fn: () => void) => pressable(h(`span.dw-btn.${cls}`, { title: label, onclick: (e: Event) => { e.stopPropagation(); fn() } }))
  const bar = h('div.dw-bar', {}, icon, title, h('span', { style: { flex: '1' } }),
    btn('min', 'Minimize', () => { f!.min = true; hooks.resized(t); layoutAll() }),
    fixed ? null : btn('max', 'Maximize', () => toggleMax(t)),
    btn('close', 'Close', () => hooks.close(t)))
  const el = h('div.dwin', {}, bar)
  if (!fixed) for (const edge of ['e', 's', 'se', 'w', 'sw']) el.append(h(`div.dw-rs.${edge}`, { 'data-edge': edge }))
  layers.windows.append(el)
  f = { el, title, icon, x, y, w, h: hh, max: false, min: false, fixed }
  frames.set(t.id, f)
  el.addEventListener('pointerdown', () => hooks.focus(t), true)
  bar.addEventListener('dblclick', () => !fixed && toggleMax(t))
  drag(bar, t, 'move')
  el.querySelectorAll<HTMLElement>('.dw-rs').forEach((r) => drag(r, t, r.dataset.edge!))
  return f
}

function toggleMax(t: Task) {
  const f = frames.get(t.id)!
  if (f.max) { Object.assign(f, f.restore); f.max = false }
  else { f.restore = { x: f.x, y: f.y, w: f.w, h: f.h }; f.max = true }
  hooks.resized(t)
  layoutAll()
}

function drag(handle: HTMLElement, t: Task, mode: string) {
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.dw-btn')) return
    const f = frames.get(t.id)!
    if (f.max && mode === 'move') return
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const s = screenEl.getBoundingClientRect().width / screenEl.offsetWidth || 1
    const start = { x: e.clientX, y: e.clientY, fx: f.x, fy: f.y, fw: f.w, fh: f.h }
    document.documentElement.classList.add('dw-dragging')
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / s, dy = (ev.clientY - start.y) / s
      const a = area()
      if (mode === 'move') { f.x = Math.max(-f.w + 80, Math.min(a.w - 80, start.fx + dx)); f.y = Math.max(0, Math.min(a.h - TITLE, start.fy + dy)) }
      if (mode.includes('e')) f.w = Math.max(240, start.fw + dx)
      if (mode.includes('s')) f.h = Math.max(160, start.fh + dy)
      if (mode.includes('w')) { const w = Math.max(240, start.fw - dx); f.x = start.fx + (start.fw - w); f.w = w }
      position(t)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      document.documentElement.classList.remove('dw-dragging')
      // drag to the top edge maximizes, like most desktops
      if (mode === 'move' && f.y <= 0 && !f.fixed) toggleMax(t)
      else if (mode !== 'move') hooks.resized(t)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
  })
}

let order: Task[] = []
function position(t: Task) {
  const f = frames.get(t.id)
  const top = t.stack[t.stack.length - 1]
  if (!f || !top) return
  const a = area()
  const r = f.max ? { x: 0, y: 0, w: a.w, h: a.h - TITLE } : { x: f.x, y: f.y, w: f.w, h: f.h }
  const z = String(10 + order.indexOf(t) * 2)
  Object.assign(f.el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + TITLE + 'px', zIndex: z, display: f.min ? 'none' : '' })
  f.el.classList.toggle('maxed', f.max)
  for (const rec of t.stack) {
    const show = rec === top && !f.min
    rec.el.classList.toggle('visible', show)
    Object.assign(rec.el.style, { left: r.x + 'px', top: r.y + TITLE + 'px', width: r.w + 'px', height: r.h + 'px', right: 'auto', bottom: 'auto', zIndex: String(+z + 1) })
  }
  f.title.textContent = top.title || t.label
}

let focused: Task | null = null
function layoutAll() {
  for (const t of order) position(t)
  frames.forEach((f, id) => f.el.classList.toggle('focused', focused?.id === id))
}

// called by the window manager on every change in desktop mode
export function desktopLayout(tasks: Task[], front: Task | undefined) {
  const alive = new Set(tasks.map((t) => t.id))
  for (const [id, f] of frames) if (!alive.has(id)) { f.el.remove(); frames.delete(id) }
  order = tasks.filter((t) => !t.home)
  for (const t of order) frameFor(t)
  focused = front && !front.home ? front : null
  if (focused) frames.get(focused.id)!.min = false
  // the home task is the desktop itself: full screen under the windows
  for (const t of tasks) if (t.home) for (const r of t.stack) {
    r.el.classList.toggle('visible', r === t.stack[t.stack.length - 1])
    // the start menu lives in the launcher window, so it comes above the app windows while open
    Object.assign(r.el.style, { left: '0', top: '0', width: '100%', height: '100%', zIndex: r.el.classList.contains('drawer-open') ? '5000' : '1' })
  }
  layoutAll()
}
export const isMinimized = (t: Task) => !!frames.get(t.id)?.min
export function restore(t: Task) { const f = frames.get(t.id); if (f) f.min = false }
export function minimize(t: Task) { const f = frames.get(t.id); if (f) f.min = true }

// leaving desktop mode: drop the frames and the inline positions
export function leaveDesktop(tasks: Task[]) {
  frames.forEach((f) => f.el.remove())
  frames.clear()
  for (const t of tasks) for (const r of t.stack) for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom']) r.el.style.removeProperty(k)
}
