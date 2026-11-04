// window manager: tasks, back stack, lifecycle, results (spec section 5).
// a task is a stack of activities. the home task (launcher) always sits at the bottom.
import { kernel, type AppEntry } from './kernel'
import type { Activity, ActivityContext, Intent, Result, LifecycleEvent } from './types'
import { RESULT_CANCELED } from './types'
import { dialog } from './ui'
import { settings } from './settings'
import { isDesktop, desktopLayout, leaveDesktop, isMinimized, initDesktop, restore, minimize } from './desktop'

export interface ActivityRecord {
  id: number
  app: AppEntry
  name: string
  intent: Intent
  el: HTMLElement
  impl: Activity
  state: LifecycleEvent
  saved?: unknown
  result: Result
  onResult?: (r: Result) => void
  task: Task
  title: string
}
export interface Task { id: number; pkg: string; stack: ActivityRecord[]; home?: boolean; label: string; icon: string }

let layer: HTMLElement
let nextId = 1
const tasks: Task[] = [] // last = front
type WmEvent = 'change' | 'front'
const listeners = new Map<WmEvent, Set<() => void>>()
const emit = (e: WmEvent) => listeners.get(e)?.forEach((f) => f())

function life(r: ActivityRecord, ev: LifecycleEvent) {
  if (r.state === ev) return
  r.state = ev
  try {
    if (ev === 'pause') r.saved = r.impl.pause?.() ?? r.saved
    else (r.impl as any)[ev]?.()
  } catch (e) { console.error(`${r.app.manifest.id}/${r.name} ${ev}`, e) }
}

// moves a record through the states in order until it reaches target
const ORDER: LifecycleEvent[] = ['create', 'start', 'resume', 'pause', 'stop', 'destroy']
function moveTo(r: ActivityRecord, target: 'resume' | 'pause' | 'stop' | 'destroy') {
  if (target === 'resume') {
    if (r.state === 'pause') return life(r, 'resume')
    if (r.state === 'stop' || r.state === 'create') { life(r, 'start'); return life(r, 'resume') }
    if (r.state === 'start') return life(r, 'resume')
    return
  }
  const want = ORDER.indexOf(target)
  for (const ev of ['pause', 'stop', 'destroy'] as const) {
    if (ORDER.indexOf(ev) > want) break
    if (ORDER.indexOf(r.state) < ORDER.indexOf(ev)) life(r, ev)
  }
}

const front = () => tasks[tasks.length - 1]
const top = () => front()?.stack[front().stack.length - 1]

let wasDesktop = false
function layout() {
  if (isDesktop()) {
    wasDesktop = true
    desktopLayout(tasks, front())
    // desktop: the focused window is resumed, other visible windows are paused (they lost focus)
    for (const t of tasks) t.stack.forEach((r, i) => {
      const top = i === t.stack.length - 1
      if (top && t === front()) moveTo(r, 'resume')
      else if (top && !isMinimized(t)) { if (r.state !== 'pause') { moveTo(r, 'resume'); moveTo(r, 'pause') } }
      else if (r.state === 'resume' || r.state === 'start' || r.state === 'pause') moveTo(r, 'stop')
    })
  } else {
    if (wasDesktop) { leaveDesktop(tasks); wasDesktop = false }
    // only the top activity of the front task is visible (plus the one animating out)
    for (const t of tasks) {
      t.stack.forEach((r, i) => {
        const visible = t === front() && i === t.stack.length - 1
        r.el.classList.toggle('visible', visible)
        r.el.style.zIndex = String(tasks.indexOf(t) * 100 + i)
      })
    }
    for (const t of tasks) for (const r of t.stack) {
      const visible = r.el.classList.contains('visible')
      if (visible) moveTo(r, 'resume')
      else if (r.state === 'resume' || r.state === 'start' || r.state === 'pause') moveTo(r, 'stop')
    }
  }
  document.documentElement.dataset.front = top()?.app.manifest.id || ''
  // developer option "don't keep activities": background tasks go away at once
  if (settings.get('dev.nokeep') && !isDesktop()) for (const t of [...tasks]) if (t !== front() && !t.home) setTimeout(() => tasks.includes(t) && t !== front() && wm.removeTask(t), 400)
  emit('change')
}

function animate(el: HTMLElement, cls: string, then?: () => void) {
  el.classList.add(cls)
  const done = () => { el.classList.remove(cls); then?.() }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return done()
  el.addEventListener('animationend', done, { once: true })
  setTimeout(() => el.classList.contains(cls) && done(), 450) // safety net
}

function makeRecord(app: AppEntry, name: string, intent: Intent, task: Task): ActivityRecord {
  const decl = app.manifest.activities[name]
  const theme = app.manifest.theme === 'holo-light' ? 'holo-light' : 'holo-dark'
  const el = document.createElement('div')
  el.className = `window ${theme}`
  el.dataset.pkg = app.manifest.id
  const rec = { id: nextId++, app, name, intent, el, state: 'create', result: { code: RESULT_CANCELED }, task, title: decl?.label || app.manifest.name } as unknown as ActivityRecord
  const ctx: ActivityContext = {
    root: el,
    pkg: app.manifest.id,
    name,
    intent,
    manifest: app.manifest,
    finish: (r) => { if (r) rec.result = r; finish(rec) },
    start: (i) => { wm.start(i, rec) },
    startForResult: (i) => new Promise((ok) => wm.start(i, rec, ok)),
    setResult: (r) => (rec.result = r),
    setTitle: (t) => { rec.title = t; emit('change') },
  }
  const factory = app.impl?.activities[name] || app.create
  if (!factory) throw new Error(`no activity ${name} in ${app.manifest.id}`)
  rec.impl = factory(ctx)
  el.classList.toggle('translucent', !!(rec.impl as any).translucent)
  layer.appendChild(el)
  life(rec, 'create')
  return rec
}

function finish(rec: ActivityRecord) {
  const t = rec.task
  const i = t.stack.indexOf(rec)
  if (i < 0) return
  const wasTop = rec === top()
  t.stack.splice(i, 1)
  const destroy = () => { moveTo(rec, 'destroy'); rec.el.remove() }
  rec.onResult?.(rec.result)
  if (!t.stack.length && !t.home) tasks.splice(tasks.indexOf(t), 1)
  if (wasTop) animate(rec.el, 'win-close', destroy)
  else destroy()
  layout()
  const n = top()
  if (wasTop && n) animate(n.el, 'win-reveal')
}

async function choose(matches: { app: AppEntry; activity: string }[]) {
  if (matches.length === 1) return matches[0]
  const r = await dialog({ title: 'Complete action using', kind: 'list', items: matches.map((m) => ({ label: m.app.manifest.name, icon: m.app.icon })) })
  return r.button === 'item' ? matches[r.index!] : null
}

export const wm = {
  init(el: HTMLElement) {
    layer = el
    initDesktop({
      focus: (t) => { if (front() !== t) wm.switchTo(t, false) },
      close: (t) => wm.removeTask(t),
      resized: (t) => { layout(); t.stack.forEach((r) => r.impl.configchange?.()) },
    })
  },
  relayout: () => layout(),
  minimize(t: Task) { minimize(t); const h = tasks.find((x) => x.home); if (h) { tasks.splice(tasks.indexOf(h), 1); tasks.push(h) } layout() },
  tasks,
  front,
  top,
  on(e: WmEvent, f: () => void) {
    let s = listeners.get(e)
    if (!s) listeners.set(e, (s = new Set()))
    s.add(f)
    return () => s!.delete(f)
  },

  // starts the home task (launcher role). called once at boot.
  startHome() {
    const app = kernel.role('launcher')
    if (!app) throw new Error('no launcher')
    let t = tasks.find((x) => x.home)
    if (!t) {
      t = { id: nextId++, pkg: app.manifest.id, stack: [], home: true, label: app.manifest.name, icon: app.icon }
      tasks.unshift(t)
      t.stack.push(makeRecord(app, app.manifest.main, { action: 'main' }, t))
    }
    layout()
  },

  // spec section 6. from = the calling activity (same task unless it is a launcher start)
  async start(i: Intent, from?: ActivityRecord, onResult?: (r: Result) => void) {
    const matches = kernel.resolve(i)
    if (!matches.length) {
      onResult?.({ code: RESULT_CANCELED })
      dialog({ title: 'No app', message: 'No app can perform this action.' })
      return null
    }
    const m = await choose(matches)
    if (!m) { onResult?.({ code: RESULT_CANCELED }); return null }
    const { app, activity } = m
    const decl = app.manifest.activities[activity]
    const newTask = !from || from.task.home || (i.action === 'main' && !onResult)
    let task: Task
    if (newTask) {
      // launcher starts bring an existing task of that app to the front
      const existing = tasks.find((t) => !t.home && t.pkg === app.manifest.id)
      if (existing && i.action === 'main') {
        tasks.splice(tasks.indexOf(existing), 1)
        tasks.push(existing)
        layout()
        animate(top()!.el, 'win-open')
        return top()!
      }
      task = { id: nextId++, pkg: app.manifest.id, stack: [], label: app.manifest.name, icon: app.icon }
      tasks.push(task)
    } else task = from!.task
    const cur = task.stack[task.stack.length - 1]
    if (decl?.['launch-mode'] === 'single-top' && cur && cur.app === app && cur.name === activity) {
      cur.impl.intent?.(i)
      return cur
    }
    // pause the current one before the new one is created (android order)
    const prev = top()
    if (prev) moveTo(prev, 'pause')
    const rec = makeRecord(app, activity, i, task)
    rec.onResult = onResult
    task.stack.push(rec)
    layout()
    animate(rec.el, 'win-open')
    return rec
  },

  // back button: dialogs and the activity get the first chance
  back() {
    const ev = new Event('droid:back', { cancelable: true })
    document.dispatchEvent(ev)
    if (ev.defaultPrevented) return
    const r = top()
    if (!r) return
    if (r.impl.back?.()) return
    if (r.task.home && r.task.stack.length === 1) return
    finish(r)
  },

  menu() { top()?.impl.menu?.() },

  // home: the front task goes to the background, the home task comes forward
  home() {
    document.dispatchEvent(new Event('droid:home'))
    const h = tasks.find((t) => t.home)
    if (!h) return
    if (isDesktop()) { tasks.forEach((t) => !t.home && minimize(t)); tasks.splice(tasks.indexOf(h), 1); tasks.push(h); layout(); return }
    if (front() === h) { h.stack.slice(1).forEach((r) => finish(r)); (h.stack[0].impl as any).home?.(); return }
    const old = top()
    tasks.splice(tasks.indexOf(h), 1)
    tasks.push(h)
    if (old) animate(old.el, 'win-to-back')
    layout()
    animate(top()!.el, 'win-home')
  },

  // recents: bring a task to the front
  switchTo(t: Task, anim = true) {
    restore(t)
    tasks.splice(tasks.indexOf(t), 1)
    tasks.push(t)
    layout()
    if (anim) animate(top()!.el, 'win-open')
  },
  removeTask(t: Task) {
    if (t.home) return
    for (const r of [...t.stack].reverse()) { moveTo(r, 'destroy'); r.el.remove() }
    tasks.splice(tasks.indexOf(t), 1)
    layout()
  },
  // shell kills background tasks when it needs memory (spec: allowed any time after stop)
  kill(t: Task) { this.removeTask(t) },
  configchange() { for (const t of tasks) for (const r of t.stack) r.impl.configchange?.() },
  // pause/resume the top activity when the shade or lockscreen covers it
  cover(on: boolean) {
    const r = top()
    if (!r) return
    on ? moveTo(r, 'pause') : moveTo(r, 'resume')
  },
}
