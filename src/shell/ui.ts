// holo toasts and dialogs drawn by the shell (spec section 9, ui helpers).
// they live in the #overlay layer above the windows.

import { sound } from './sound'
import { settings } from './settings'

let layer: HTMLElement
// kitkat's touch sound on taps (settings > sound > touch sounds)
const touchSound = () => { if (settings.get('sound.touch')) sound.play('Effect_Tick', 0.5) }
let toastBox: HTMLElement
export function initUi(overlay: HTMLElement) {
  layer = overlay
  toastBox = document.createElement('div')
  toastBox.className = 'toasts'
  layer.appendChild(toastBox)
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// h('div.a.b', {attrs}, ...children) - tiny dom helper used by all system apps
export function h<K extends keyof HTMLElementTagNameMap>(spec: K | string, props: Record<string, any> = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElement {
  const [tag, ...cls] = spec.split('.')
  const el = document.createElement(tag || 'div')
  if (cls.length) el.className = cls.join(' ')
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k === 'html') el.innerHTML = v
    else if (k in el && typeof v !== 'string') (el as any)[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids) if (c != null && c !== false) el.append(c)
  return el
}

// pressed state for touch: android shows the pressed drawable on touch down
export function pressable(el: HTMLElement) {
  el.addEventListener('click', touchSound)
  const on = () => el.classList.add('pressed')
  const off = () => el.classList.remove('pressed')
  el.addEventListener('pointerdown', on)
  for (const e of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(e, off)
  return el
}

export function toast(text: string, duration: 'short' | 'long' | number = 'short') {
  const t = h('div.h-toast.toast-in', {}, text)
  toastBox.appendChild(t)
  const ms = duration === 'long' ? 3500 : duration === 'short' ? 2000 : duration
  setTimeout(() => {
    t.classList.add('toast-out')
    setTimeout(() => t.remove(), 300)
  }, ms)
}

export interface DialogOptions {
  title?: string
  message?: string
  kind?: 'alert' | 'confirm' | 'list' | 'input' | 'single' | 'multi'
  items?: (string | { label: string; icon?: string })[]
  checked?: number | number[]
  value?: string
  placeholder?: string
  ok?: string
  cancel?: string
  neutral?: string
  theme?: 'dark' | 'light'
  body?: HTMLElement // custom content (system apps)
  cancelable?: boolean
}
export interface DialogResult { button: 'ok' | 'cancel' | 'neutral' | 'item'; index?: number; checked?: number[]; value?: string }

export function dialog(o: DialogOptions): Promise<DialogResult> {
  return new Promise((done) => {
    const kind = o.kind || (o.items ? 'list' : o.cancel ? 'confirm' : 'alert')
    const scrim = h(`div.h-scrim.holo-${o.theme || 'dark'}.dialog-in`)
    const box = h('div.h-dialog')
    let checked = new Set<number>(Array.isArray(o.checked) ? o.checked : o.checked != null ? [o.checked] : [])
    let input: HTMLInputElement | null = null
    const close = (r: DialogResult) => {
      scrim.classList.add('dialog-out')
      setTimeout(() => scrim.remove(), 150)
      document.removeEventListener('droid:back', onBack, true)
      done(r)
    }
    const onBack = (e: Event) => {
      e.stopImmediatePropagation()
      e.preventDefault()
      if (o.cancelable !== false) close({ button: 'cancel' })
    }
    if (o.title) box.append(h('div.d-title', {}, o.title), h('div.d-title-line'))
    if (o.message) box.append(h('div.d-body', {}, o.message))
    if (o.body) box.append(h('div.d-body', {}, o.body))
    if (o.items) {
      const list = h('ul.h-list.d-list')
      o.items.forEach((it, i) => {
        const label = typeof it === 'string' ? it : it.label
        const ic = typeof it === 'string' ? null : it.icon
        const mark = kind === 'single' ? h('input.h-radio', { type: 'radio', checked: checked.has(i) }) : kind === 'multi' ? h('input.h-check', { type: 'checkbox', checked: checked.has(i) }) : null
        const li = pressable(h('li.h-item.small', {
          onclick: () => {
            if (kind === 'multi') { checked.has(i) ? checked.delete(i) : checked.add(i); (mark as HTMLInputElement).checked = checked.has(i); return }
            if (kind === 'single') { checked = new Set([i]); list.querySelectorAll('input').forEach((m, j) => ((m as HTMLInputElement).checked = j === i)); if (!o.ok) close({ button: 'item', index: i }); return }
            close({ button: 'item', index: i })
          },
        }, ic ? h('img.d-icon', { src: ic }) : null, h('span.title', { style: { flex: '1' } }, label), mark))
        list.append(li)
      })
      box.append(h('div.d-body.list', {}, list))
    }
    if (kind === 'input') {
      input = h('input.h-edit', { value: o.value || '', placeholder: o.placeholder || '' }) as HTMLInputElement
      box.append(h('div.d-body', {}, input))
      setTimeout(() => input!.focus(), 50)
    }
    const buttons: HTMLElement[] = []
    const btn = (label: string, r: () => DialogResult) => buttons.push(pressable(h('button.h-btn-borderless', { onclick: () => close(r()) }, label)))
    const val = () => ({ value: input?.value, checked: [...checked], index: [...checked][0] })
    if (o.cancel || kind === 'confirm' || kind === 'input') btn(o.cancel || 'Cancel', () => ({ button: 'cancel' }))
    if (o.neutral) btn(o.neutral, () => ({ button: 'neutral', ...val() }))
    if (o.ok || kind === 'alert' || kind === 'confirm' || kind === 'input' || kind === 'multi') btn(o.ok || 'OK', () => ({ button: 'ok', ...val() }))
    if (buttons.length) box.append(h('div.d-buttons', {}, ...buttons))
    scrim.append(box)
    scrim.addEventListener('click', (e) => { if (e.target === scrim && o.cancelable !== false) close({ button: 'cancel' }) })
    document.addEventListener('droid:back', onBack, true)
    layer.appendChild(scrim)
  })
}

// indeterminate progress dialog; returns a function that closes it
export function progress(message: string) {
  const scrim = h('div.h-scrim.holo-dark.dialog-in', {}, h('div.h-dialog', {}, h('div.d-body.d-progress', {}, h('span.h-spin', {}, h('i')), h('span', {}, message))))
  layer.appendChild(scrim)
  return () => scrim.remove()
}
