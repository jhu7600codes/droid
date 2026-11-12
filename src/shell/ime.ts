// droid keyboard: the kitkat latinime look (dark keys, key preview bubbles, ?123 / =\< pages,
// one-shot shift and caps lock, auto caps, repeating delete, a number pad for numbers).
// it types into shell inputs directly, and into apps through the bridge (host.ts / sdk "ime").
// with the droid keyboard on, inputs get inputmode="none" so the device keyboard stays away.
import { settings } from './settings'
import { img } from './assets'
import { sound } from './sound'
import { screenEl } from './layers'
import './ime.css'

export type Enter = 'enter' | 'go' | 'search' | 'send' | 'next' | 'done'
export interface ImeTarget {
  kind: 'text' | 'number' | 'phone' | 'email' | 'url' | 'password'
  enter: Enter
  multiline: boolean
  autocap: boolean
  key(k: { text?: string; del?: boolean; enter?: boolean }): void
  before?(): string // text before the caret, for auto caps
}

const L = 'apps/latinime'
export const imeEnabled = () => {
  const v = settings.get('ime') as string | undefined
  if (v) return v === 'droid'
  return matchMedia('(pointer: coarse)').matches && screenEl?.dataset.form !== 'desktop'
}

const LETTERS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']
const SYM1 = ['1234567890', '@#$%&-+()', '*"\':;!?']
const SYM2 = ['~`|•√π÷×¶∆', '£¥€¢^°={}', '\\©®™℅[]']
const NUM = ['123', '456', '789']
const PHONE = ['123', '456', '789']

let root: HTMLElement | null = null
let target: ImeTarget | null = null
let page: 'abc' | 'sym1' | 'sym2' = 'abc'
let shift: 0 | 1 | 2 = 0 // off, once, locked
let lastShift = 0
let preview: HTMLElement
let hideTimer = 0

function build() {
  root = document.createElement('div')
  root.id = 'ime'
  root.addEventListener('pointerdown', (e) => e.preventDefault()) // never take focus from the field
  root.addEventListener('contextmenu', (e) => e.preventDefault())
  preview = document.createElement('div')
  preview.className = 'ime-preview'
  screenEl.append(root, preview)
}

function key(label: string | HTMLElement, cls: string, act: () => void, opts: { repeat?: boolean; preview?: boolean; flex?: number } = {}) {
  const k = document.createElement('div')
  k.className = 'ime-key ' + cls
  if (opts.flex) k.style.flex = String(opts.flex)
  if (typeof label === 'string') k.textContent = label
  else k.append(label)
  let rep = 0, delay = 0
  const stop = () => { clearTimeout(delay); clearInterval(rep); k.classList.remove('down'); preview.classList.remove('on') }
  k.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    k.setPointerCapture?.(e.pointerId)
    k.classList.add('down')
    // the key first: the preview bubble and the click sound must never stop it (a sound can throw on
    // browsers that cannot play it)
    act()
    try {
      if (opts.preview && typeof label === 'string') {
        const r = k.getBoundingClientRect(), s = screenEl.getBoundingClientRect(), z = s.width / screenEl.offsetWidth || 1
        preview.textContent = label
        preview.style.left = (r.left - s.left) / z + r.width / z / 2 + 'px'
        preview.style.top = (r.top - s.top) / z + 'px'
        preview.classList.add('on')
      }
      if (settings.get('ime.sound') !== false) sound.play(cls.includes('del') ? 'KeypressDelete' : cls.includes('space') ? 'KeypressSpacebar' : cls.includes('enter') ? 'KeypressReturn' : 'KeypressStandard', 0.5)
    } catch { /* cosmetic */ }
    if (opts.repeat) delay = window.setTimeout(() => { rep = window.setInterval(act, 50) }, 400)
  })
  k.addEventListener('pointerup', stop)
  k.addEventListener('pointercancel', stop)
  return k
}
const icon = (name: string) => { const i = document.createElement('img'); i.src = img(L, name); i.alt = ''; return i }

function type(text: string) {
  if (!target) return
  target.key({ text: shift ? text.toUpperCase() : text })
  if (shift === 1) { shift = 0; draw() }
}
function autoCap() {
  if (!target || !target.autocap || page !== 'abc' || shift === 2) return
  const b = target.before?.() ?? ''
  const want = b === '' || /[.!?]\s+$/.test(b) || /\n$/.test(b)
  if ((shift === 1) !== want) { shift = want ? 1 : 0; draw() }
}

function enterLabel(): string | HTMLElement {
  const e = target?.multiline ? 'enter' : target?.enter || 'enter'
  if (e === 'search') return icon('sym_keyboard_search_holo_dark')
  if (e === 'go') return 'Go'
  if (e === 'send') return 'Send'
  if (e === 'next') return 'Next'
  if (e === 'done') return 'Done'
  return icon('sym_keyboard_return_holo_dark')
}

function row(...keys: HTMLElement[]) { const r = document.createElement('div'); r.className = 'ime-row'; r.append(...keys); return r }

function draw() {
  if (!root || !target) return
  root.innerHTML = ''
  root.dataset.kind = target.kind
  const del = () => key(icon('sym_keyboard_delete_holo_dark'), 'fn del', () => target?.key({ del: true }), { repeat: true, flex: 1.5 })
  const enter = () => key(enterLabel(), 'fn enter', () => { target?.key(target.multiline ? { text: '\n' } : { enter: true }) }, { flex: 1.5 })
  if (target.kind === 'number' || target.kind === 'phone') {
    const pad = target.kind === 'phone' ? PHONE : NUM
    for (const r of pad) root.append(row(...[...r].map((c) => key(c, 'num', () => target?.key({ text: c }), { preview: true }))))
    root.append(row(
      key(target.kind === 'phone' ? '+' : '-', 'num fn', () => target?.key({ text: target!.kind === 'phone' ? '+' : '-' })),
      key('0', 'num', () => target?.key({ text: '0' }), { preview: true }),
      key(target.kind === 'phone' ? '#' : '.', 'num fn', () => target?.key({ text: target!.kind === 'phone' ? '#' : '.' })),
      del(), enter(),
    ))
    return
  }
  const rows = page === 'abc' ? LETTERS : page === 'sym1' ? SYM1 : SYM2
  const letter = (c: string) => key(page === 'abc' && shift ? c.toUpperCase() : c, 'ch', () => type(c), { preview: true })
  root.append(row(...[...rows[0]].map(letter)))
  const r2 = row(...[...rows[1]].map(letter))
  if (page === 'abc') r2.classList.add('indent')
  root.append(r2)
  const left = page === 'abc'
    ? key(icon(shift === 2 ? 'sym_keyboard_shift_locked_holo_dark' : 'sym_keyboard_shift_holo_dark'), 'fn shift' + (shift ? ' on' : ''), () => {
        const now = Date.now()
        shift = shift === 0 ? (now - lastShift < 350 ? 2 : 1) : shift === 1 && now - lastShift < 350 ? 2 : 0
        lastShift = now
        draw()
      }, { flex: 1.5 })
    : key(page === 'sym1' ? '=\\<' : '?123', 'fn', () => { page = page === 'sym1' ? 'sym2' : 'sym1'; draw() }, { flex: 1.5 })
  root.append(row(left, ...[...rows[2]].map(letter), del()))
  const mail = target.kind === 'email', url = target.kind === 'url'
  root.append(row(
    key(page === 'abc' ? '?123' : 'ABC', 'fn small', () => { page = page === 'abc' ? 'sym1' : 'abc'; draw(); autoCap() }, { flex: 1.5 }),
    key(mail ? '@' : url ? '/' : ',', 'ch', () => type(mail ? '@' : url ? '/' : ','), { preview: true }),
    key(icon('sym_keyboard_space_holo_dark'), 'space', () => { target?.key({ text: ' ' }); autoCap() }, { flex: 5 }),
    key('.', 'ch', () => { target?.key({ text: '.' }); autoCap() }, { preview: true }),
    enter(),
  ))
}

function setHeight(px: number) {
  screenEl.style.setProperty('--ime', px + 'px')
  window.dispatchEvent(new Event('droid:ime'))
}

export const ime = {
  open(t: ImeTarget) {
    clearTimeout(hideTimer)
    if (!root) build()
    const same = target && target.kind === t.kind
    target = t
    if (!same) { page = 'abc'; shift = 0 }
    draw()
    autoCap()
    root!.classList.add('on')
    requestAnimationFrame(() => setHeight(root!.offsetHeight))
  },
  // called after each change to the field, so shift can follow the sentence
  changed() { autoCap() },
  close(t?: ImeTarget) {
    if (t && t !== target) return
    hideTimer = window.setTimeout(() => {
      target = null
      root?.classList.remove('on')
      preview?.classList.remove('on')
      setHeight(0)
    }, 80)
  },
  isOpen: () => !!target && !!root?.classList.contains('on'),
}

// ---------- shell inputs (system apps): typing straight into the element ----------
const TEXTY = /^(text|search|email|url|tel|number|password)$/
const editable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  !!el && ((el instanceof HTMLInputElement && TEXTY.test(el.type)) || el instanceof HTMLTextAreaElement) && !(el as HTMLInputElement).readOnly && !(el as HTMLInputElement).disabled

export function kindOf(type: string, inputmode: string): ImeTarget['kind'] {
  if (inputmode === 'numeric' || inputmode === 'decimal' || type === 'number') return 'number'
  if (inputmode === 'tel' || type === 'tel') return 'phone'
  if (inputmode === 'email' || type === 'email') return 'email'
  if (inputmode === 'url' || type === 'url') return 'url'
  if (type === 'password') return 'password'
  return 'text'
}

// insert / delete at the caret of an input or textarea, the way typing would
export function edit(el: HTMLInputElement | HTMLTextAreaElement, k: { text?: string; del?: boolean; enter?: boolean }) {
  if (k.enter) {
    for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true } as any))
    const form = (el as HTMLInputElement).form
    if (form) form.requestSubmit?.()
    return
  }
  // number inputs have no selection api: edit the value as a whole
  let s: number, e: number
  try { s = el.selectionStart ?? el.value.length; e = el.selectionEnd ?? s } catch { s = e = el.value.length }
  const v = el.value
  if (k.del) {
    if (s === e) { if (s === 0) return; s -= /[\udc00-\udfff]/.test(v[s - 1]) && s > 1 ? 2 : 1 }
    el.value = v.slice(0, s) + v.slice(e)
    try { el.setSelectionRange(s, s) } catch { /* number input */ }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
    return
  }
  const t = k.text || ''
  const max = (el as HTMLInputElement).maxLength
  if (max > 0 && v.length - (e - s) + t.length > max) return
  el.value = v.slice(0, s) + t + v.slice(e)
  try { el.setSelectionRange(s + t.length, s + t.length) } catch { /* number input */ }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: t }))
}

export function enterOf(el: HTMLElement): Enter {
  const h = (el.getAttribute('enterkeyhint') || '').toLowerCase()
  if (/^(go|search|send|next|done|enter)$/.test(h)) return h as Enter
  if ((el as HTMLInputElement).type === 'search') return 'search'
  return 'enter'
}

export function initIme() {
  const doc = document
  doc.addEventListener('focusin', (ev) => {
    const el = ev.target as Element
    if (!editable(el) || !screenEl.contains(el)) return
    if (!imeEnabled()) { if (el.dataset.droidIme) { el.inputMode = el.dataset.droidIme === '-' ? '' : el.dataset.droidIme; delete el.dataset.droidIme } return }
    if (!el.dataset.droidIme) { el.dataset.droidIme = el.inputMode || '-'; el.inputMode = 'none' }
    const mode = el.dataset.droidIme === '-' ? '' : el.dataset.droidIme
    const kind = kindOf((el as HTMLInputElement).type || 'text', mode)
    const t: ImeTarget = {
      kind, enter: enterOf(el), multiline: el instanceof HTMLTextAreaElement,
      autocap: kind === 'text' && el.getAttribute('autocapitalize') !== 'none' && el.getAttribute('autocapitalize') !== 'off',
      key: (k) => { edit(el, k); ime.changed() },
      before: () => { try { return el.value.slice(0, el.selectionStart ?? el.value.length) } catch { return el.value } },
    }
    ime.open(t)
    setTimeout(() => el.scrollIntoView?.({ block: 'nearest' }), 250)
    el.addEventListener('focusout', () => ime.close(t), { once: true })
  })
  // back closes the keyboard first, like android
  doc.addEventListener('droid:back', (e) => {
    if (!ime.isOpen()) return
    e.preventDefault()
    ;(doc.activeElement as HTMLElement)?.blur?.()
    ime.close()
  }, true)
  settings.on('ime', () => { if (!imeEnabled()) ime.close() })
}
