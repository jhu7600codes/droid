// small kit for system app screens: holo action bar with up button and menu, and preference lists
// (header, item, switch, checkbox, list choice, slider) like android's PreferenceScreen.
import { h, pressable, dialog } from './ui'
import { img } from './assets'
import { settings } from './settings'

export interface Screen { root: HTMLElement; content: HTMLElement; bar: HTMLElement; title(t: string): void; menu(items: { title: string; icon?: string; onclick: () => void; always?: boolean }[]): void }

// a full-screen page with an action bar. up = back arrow before the icon
export function page(parent: HTMLElement, o: { title: string; icon?: string; up?: () => void; theme?: 'dark' | 'light' }): Screen {
  const titleEl = h('span.h-ab-title', {}, o.title)
  const home = pressable(h('span.h-ab-item.h-ab-home', {}, o.up ? h('i.h-ab-up') : null, o.icon ? h('img', { src: o.icon }) : h('span', { style: { width: '16px' } }), titleEl))
  if (o.up) home.addEventListener('click', o.up)
  const actions = h('span.ab-actions', { style: { display: 'flex', height: '100%' } })
  const bar = h('div.h-actionbar', {}, home, h('span', { style: { flex: '1' } }), actions)
  const content = h('div.content')
  const root = h(`div.app.app-${o.theme || 'dark'}.holo-${o.theme || 'dark'}`, {}, bar, content)
  parent.append(root)
  return {
    root, content, bar,
    title: (t) => (titleEl.textContent = t),
    menu(items) {
      actions.innerHTML = ''
      const shown = items.filter((i) => i.always && i.icon)
      for (const it of shown) actions.append(pressable(h('span.h-ab-item', { onclick: it.onclick, title: it.title }, h('img', { src: it.icon }))))
      const rest = items.filter((i) => !(i.always && i.icon))
      if (rest.length) {
        const o2 = pressable(h('span.h-ab-item', {}, h('i.h-ab-overflow')))
        o2.addEventListener('click', () => {
          const menu = h('div.h-menu.ab-menu')
          const scrim = h('div.ab-menu-scrim', { onclick: (e: Event) => e.target === scrim && close() }, menu)
          const close = () => { scrim.remove(); document.removeEventListener('droid:back', back, true) }
          const back = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); close() }
          for (const it of rest) menu.append(pressable(h('span', { onclick: () => { close(); it.onclick() } }, it.title)))
          root.append(scrim)
          document.addEventListener('droid:back', back, true)
        })
        actions.append(o2)
      }
    },
  }
}

export type Pref =
  | { type: 'header'; title: string }
  | { type: 'item'; title: string; summary?: string | (() => string); icon?: string; onclick?: () => void; disabled?: boolean }
  | { type: 'switch' | 'check'; title: string; summary?: string | (() => string); icon?: string; key?: string; get?: () => boolean; set?: (v: boolean) => void; onclick?: () => void }
  | { type: 'list'; title: string; key?: string; options: [string, string][]; get?: () => string; set?: (v: string) => void; icon?: string; summary?: () => string }
  | { type: 'slider'; title: string; min: number; max: number; step: number; get: () => number; set: (v: number) => void; label?: (v: number) => string }
  | { type: 'custom'; el: HTMLElement }

// renders prefs into el; re-renders when settings change
export function prefs(el: HTMLElement, list: () => Pref[]) {
  const ul = h('ul.h-list.prefs')
  el.append(ul)
  const sum = (s?: string | (() => string)) => (typeof s === 'function' ? s() : s)
  const render = () => {
    ul.innerHTML = ''
    let lastHeader = true
    for (const p of list()) {
      if (p.type === 'header') { ul.append(h('li.h-section', {}, p.title)); lastHeader = true; continue }
      if (!lastHeader) ul.append(h('li.h-divider'))
      lastHeader = false
      if (p.type === 'custom') { ul.append(h('li.pref-custom', {}, p.el)); continue }
      if (p.type === 'slider') {
        const lab = h('span.summary')
        const r = h('input.pref-range', { type: 'range', min: p.min, max: p.max, step: p.step, value: String(p.get()) }) as HTMLInputElement
        const upd = () => (lab.textContent = p.label ? p.label(+r.value) : r.value)
        r.addEventListener('input', () => { p.set(+r.value); upd() })
        upd()
        ul.append(h('li.h-item.pref-slider', {}, h('div.lines', {}, h('span.title', {}, p.title), r, lab)))
        continue
      }
      const icon = 'icon' in p && p.icon ? h('img.pref-icon', { src: p.icon }) : null
      if (p.type === 'item') {
        const li = pressable(h('li.h-item' + (p.disabled ? '.disabled' : ''), {}, icon, h('div.lines', {}, h('span.title', {}, p.title), sum(p.summary) ? h('span.summary', {}, sum(p.summary)!) : null)))
        if (p.onclick && !p.disabled) li.addEventListener('click', p.onclick)
        ul.append(li)
        continue
      }
      if (p.type === 'switch' || p.type === 'check') {
        const get = p.get || (() => !!settings.get(p.key!))
        const set = p.set || ((v: boolean) => settings.set(p.key!, v))
        const input = h('input', { type: 'checkbox', checked: get() }) as HTMLInputElement
        const ctl = p.type === 'switch' ? h('label.h-switch', { onclick: (e: Event) => e.stopPropagation() }, input, h('span.track', {}, h('span.thumb', {}, get() ? 'ON' : 'OFF'))) : (input.className = 'h-check', input)
        input.addEventListener('change', () => { set(input.checked); render() })
        const li = pressable(h('li.h-item', {}, icon, h('div.lines', {}, h('span.title', {}, p.title), sum(p.summary) ? h('span.summary', {}, sum(p.summary)!) : null), ctl))
        li.addEventListener('click', () => { if (p.onclick) p.onclick(); else { set(!get()); render() } })
        ul.append(li)
        continue
      }
      if (p.type === 'list') {
        const get = p.get || (() => String(settings.get(p.key!)))
        const set = p.set || ((v: string) => settings.set(p.key!, v))
        const cur = p.options.find((o) => o[0] === get())
        const li = pressable(h('li.h-item', {}, icon, h('div.lines', {}, h('span.title', {}, p.title), h('span.summary', {}, p.summary ? p.summary() : cur?.[1] || ''))))
        li.addEventListener('click', async () => {
          const r = await dialog({ title: p.title, kind: 'single', items: p.options.map((o) => o[1]), checked: p.options.findIndex((o) => o[0] === get()), cancel: 'Cancel' })
          if (r.button === 'item') { set(p.options[r.index!][0]); render() }
        })
        ul.append(li)
      }
    }
  }
  render()
  const off = settings.on('*', () => requestAnimationFrame(render))
  return { render, dispose: off }
}

export const ic = (pkg: string, name: string) => img(pkg, name)

// stack of pages inside one activity (settings sub screens), back pops
export function pageStack(root: HTMLElement) {
  const stack: { el: HTMLElement; dispose?: () => void }[] = []
  return {
    push(build: (parent: HTMLElement, pop: () => void) => (() => void) | void) {
      const el = h('div.page-layer')
      root.append(el)
      const prev = stack[stack.length - 1]
      if (prev) prev.el.classList.add('covered')
      const d = build(el, () => this.pop()) || undefined
      stack.push({ el, dispose: d })
      el.classList.add('page-in')
    },
    pop() {
      if (stack.length <= 1) return false
      const top = stack.pop()!
      top.dispose?.()
      top.el.classList.add('page-out')
      setTimeout(() => top.el.remove(), 180)
      stack[stack.length - 1].el.classList.remove('covered')
      return true
    },
    depth: () => stack.length,
  }
}
