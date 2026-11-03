// settings > about phone > legal information: droid's own license and every aosp source with its notice
import { page } from '../../shell/appkit'
import { h, pressable } from '../../shell/ui'

export function licensesPage(el: HTMLElement, pop: () => void) {
  const p = page(el, { title: 'Open source licenses', up: pop })
  const list = h('ul.h-list')
  p.content.append(list)
  const show = async (title: string, url: string) => {
    const text = await fetch(url).then((r) => (r.ok ? r.text() : 'not available offline')).catch(() => 'not available offline')
    const view = h('div.lic-text', {}, h('div.t-medium', { style: { color: '#33b5e5', marginBottom: '8px' } }, title), h('pre', {}, text))
    const back = pressable(h('button.h-btn-borderless', { onclick: () => { view.remove(); list.style.display = '' } }, '‹ All licenses'))
    view.prepend(back)
    list.style.display = 'none'
    p.content.append(view)
    p.content.scrollTop = 0
  }
  const item = (title: string, summary: string, url: string) => {
    const li = pressable(h('li.h-item', {}, h('div.lines', {}, h('span.title', {}, title), h('span.summary', {}, summary))))
    li.addEventListener('click', () => show(title, url))
    list.append(li, h('li.h-divider'))
  }
  item('droid', 'MIT license', 'legal/LICENSE')
  item('NOTICE', 'what droid includes and from where', 'legal/NOTICE')
  item('Apache License 2.0', 'license of the android open source project parts', 'legal/LICENSE-APACHE-2.0')
  item('Roboto', 'fonts, apache 2.0', 'assets/aosp/fonts/NOTICE')
  fetch('assets/aosp/manifest.json').then((r) => r.json()).then((m) => {
    for (const [id, s] of Object.entries<any>(m.sources)) item(s.repo.replace(/^https:\/\/android\.googlesource\.com\//, ''), `aosp ${s.tag}, apache 2.0`, `assets/aosp/NOTICE-${id}`)
  }).catch(() => {})
}
