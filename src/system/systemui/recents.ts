// recent apps (kitkat): a vertical list of task thumbnails with icon and label,
// newest at the bottom, swipe sideways to dismiss, tap to switch.
import { layers } from '../../shell/layers'
import { h } from '../../shell/ui'
import { wm, type Task } from '../../shell/wm'
import { swipeAway } from './index'

let root: HTMLElement
let shown = false

function thumb(t: Task): HTMLElement {
  const top = t.stack[t.stack.length - 1]
  const box = h('div.rc-thumb')
  // system app windows are plain dom, so a scaled live copy works as a thumbnail.
  // dpk apps run in iframes, their copy would be empty: they get their icon instead.
  if (top && !top.el.querySelector('iframe')) {
    const copy = top.el.cloneNode(true) as HTMLElement
    copy.classList.add('visible')
    copy.classList.remove('win-open', 'win-close', 'win-reveal', 'win-home', 'win-to-back')
    copy.style.cssText = 'position:absolute;left:0;top:0;display:block;pointer-events:none;'
    copy.style.width = top.el.offsetWidth + 'px'
    copy.style.height = top.el.offsetHeight + 'px'
    copy.style.transform = `scale(${150 / Math.max(1, top.el.offsetWidth)})`
    copy.style.transformOrigin = '0 0'
    box.append(copy)
  } else box.append(h('img.rc-bigicon', { src: t.icon }))
  return box
}

function render() {
  root.innerHTML = ''
  const list = h('div.rc-list')
  const tasks = wm.tasks.filter((t) => !t.home)
  if (!tasks.length) list.append(h('div.rc-empty', {}, 'No recent apps'))
  for (const t of tasks) {
    const row = h('div.rc-item', {}, thumb(t), h('div.rc-meta', {}, h('img.rc-icon', { src: t.icon }), h('div.rc-label', {}, t.stack[t.stack.length - 1]?.title || t.label)))
    row.addEventListener('click', () => { recents.hide(); wm.switchTo(t) })
    swipeAway(row, () => { wm.removeTask(t); row.remove(); if (!wm.tasks.some((x) => !x.home)) recents.hide() })
    list.append(row)
  }
  root.append(list)
  root.addEventListener('click', (e) => { if (e.target === root || e.target === list) recents.hide() })
  requestAnimationFrame(() => (list.scrollTop = list.scrollHeight))
}

export const recents = {
  init() {
    root = h('div.recents')
    layers.recents.append(root)
    document.addEventListener('droid:back', (e) => { if (shown) { e.preventDefault(); e.stopImmediatePropagation(); recents.hide() } }, true)
  },
  toggle() { shown ? this.hide() : this.show() },
  show() {
    shown = true
    render()
    root.classList.add('shown')
    wm.cover(true)
  },
  hide() {
    if (!shown) return
    shown = false
    root.classList.remove('shown')
    wm.cover(false)
  },
}
