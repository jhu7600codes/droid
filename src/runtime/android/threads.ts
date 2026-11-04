// green threads for the android runtime. java threads (dalvik) and native threads (arm pthreads)
// are both "tasks" here: the scheduler hands each runnable task a short time slice from the event
// loop, so a thread that loops forever never freezes the page.
//
// blocking: a task that has to wait (sleep, wait / notify, a contended lock, a semaphore, pthread
// conditions...) reports a Block. the scheduler polls block.ready() and resumes the task once it
// is true. code that runs nested inside js (a ui callback calling into java, java calling native)
// can't give its js stack back to the event loop, so there a block runs the other tasks in place
// until it clears (pump).

export class Block {
  // ready: can the task go on (it checks the time itself for timed waits).
  // until: when to look again at the latest (ms, performance.now), for the scheduler's timer
  constructor(public ready: () => boolean, public until = Infinity, public what = 'wait') {}
  // the value the blocking call returns once it is ready (computed then, e.g. after re-acquiring a lock)
  finish: () => any = () => undefined
  then(f: () => any) { this.finish = f; return this }
}
export const isBlock = (x: unknown): x is Block => x instanceof Block

export interface Task {
  id: number
  name: string
  state: 'runnable' | 'blocked' | 'done'
  block: Block | null
  busy: boolean // running nested further up the js stack right now (the scheduler must not step it)
  // run up to `ms` milliseconds; returns when the slice is used up, the task blocks, or it ends
  step(ms: number): void
}

let nextId = 1
export const taskId = () => nextId++
const now = () => performance.now()

export class Scheduler {
  tasks: Task[] = []
  private ticking = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private ch: MessageChannel | null = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null
  pumpDepth = 0
  slice = 8 // ms per task per turn
  budget = 12 // ms of task work per event loop turn, so input and drawing stay smooth
  onError: (t: Task, e: unknown) => void = (t, e) => console.error(`thread "${t.name}" died`, e)

  constructor() { if (this.ch) this.ch.port1.onmessage = () => this.tick() }

  add(t: Task) { this.tasks.push(t); this.wake() }
  remove(t: Task) { const i = this.tasks.indexOf(t); if (i >= 0) this.tasks.splice(i, 1) }

  // something changed (a lock was freed, a task was added): make sure a turn is coming
  wake() {
    if (this.ticking) return
    this.ticking = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.ch) this.ch.port2.postMessage(0)
    else setTimeout(() => this.tick(), 0)
  }

  // one event-loop turn: round robin over runnable tasks until the budget is used
  private tick() {
    this.ticking = false
    const end = now() + this.budget
    let ran = true
    while (ran && now() < end) {
      ran = false
      for (const t of [...this.tasks]) {
        if (t.busy || t.state === 'done') continue
        if (!this.ready(t)) continue
        ran = true
        this.run(t, Math.min(this.slice, Math.max(1, end - now())))
        if (now() >= end) break
      }
    }
    this.tasks = this.tasks.filter((t) => t.state !== 'done')
    this.plan()
  }

  // is the task able to run (resolves a cleared block)
  private ready(t: Task) {
    if (t.state === 'runnable') return true
    if (t.state !== 'blocked' || !t.block) return false
    if (t.block.ready()) { t.state = 'runnable'; return true } // (until only plans the timer; ready() checks the time itself)
    return false
  }

  private run(t: Task, ms: number) {
    try { t.step(ms) } catch (e) { t.state = 'done'; this.onError(t, e) }
  }

  // next turn: right away if someone can run, else at the soonest timed wake-up
  private plan() {
    if (this.tasks.some((t) => !t.busy && t.state === 'runnable')) return this.wake()
    const soon = Math.min(...this.tasks.filter((t) => t.state === 'blocked' && t.block).map((t) => t.block!.until))
    // blocks that clear through other events (a lock freed from a ui callback) call wake(); poll
    // now and then anyway in case something cleared without telling us
    const wait = Math.max(0, Math.min(isFinite(soon) ? soon - now() : 50, 50))
    if (this.tasks.some((t) => t.state === 'blocked')) this.timer = setTimeout(() => this.wake(), wait)
  }

  // nested code is waiting for `b`: run the other tasks here until it clears (or time runs out)
  pump(self: Task | null, b: Block, limitMs = 60000) {
    if (this.pumpDepth > 16) throw new Error('droid threads: waiting too deep (a deadlock?) on ' + b.what)
    this.pumpDepth++
    const start = now()
    try {
      while (!b.ready()) {
        let ran = false
        for (const t of [...this.tasks]) {
          if (t === self || t.busy || t.state === 'done' || !this.ready(t)) continue
          ran = true
          this.run(t, this.slice)
          if (b.ready()) break
        }
        if (!ran) {
          // nobody else can move: only time can help (a timed wait), else it is a deadlock
          if (!isFinite(b.until) && !this.tasks.some((t) => t !== self && t.state === 'blocked' && isFinite(t.block?.until ?? Infinity))) {
            if (now() - start > 2000) throw new Error('droid threads: deadlock while waiting on ' + b.what)
          }
          const until = Math.min(b.until, ...this.tasks.filter((t) => t.state === 'blocked' && t.block).map((t) => t.block!.until), now() + 5)
          while (now() < until) { /* short busy wait: nested code can't sleep */ }
        }
        if (now() - start > limitMs) throw new Error('droid threads: waited too long on ' + b.what)
      }
    } finally { this.pumpDepth-- }
    return b.finish()
  }
}

export const scheduler = new Scheduler()

// ---------- monitors (java synchronized / wait / notify), owned by tasks ----------
interface Monitor { owner: Task | null; count: number; waiters: { t: Task; notified: boolean }[] }
const monitors = new WeakMap<object, Monitor>()
const strMonitors = new Map<string, Monitor>() // strings are js primitives (interned anyway)
export function monitorOf(o: any): Monitor {
  if (typeof o === 'string') { let m = strMonitors.get(o); if (!m) strMonitors.set(o, (m = { owner: null, count: 0, waiters: [] })); return m }
  let m = monitors.get(o)
  if (!m) monitors.set(o, (m = { owner: null, count: 0, waiters: [] }))
  return m
}
// true if taken, false if the caller has to wait for it
export function tryEnter(o: any, t: Task) {
  const m = monitorOf(o)
  if (!m.owner || m.owner === t) { m.owner = t; m.count++; return true }
  return false
}
export function enterBlock(o: any, t: Task) {
  const m = monitorOf(o)
  return new Block(() => !m.owner || m.owner === t, Infinity, 'lock').then(() => { m.owner = t; m.count++ })
}
export function exit(o: any, t: Task) {
  const m = monitorOf(o)
  if (m.owner !== t) return false
  if (--m.count === 0) { m.owner = null; scheduler.wake() }
  return true
}
export function holds(o: any, t: Task) { return monitorOf(o).owner === t }
// Object.wait: give the monitor back completely, wait for notify (or the timeout), take it again
export function waitOn(o: any, t: Task, ms = 0) {
  const m = monitorOf(o)
  const saved = m.count
  m.owner = null; m.count = 0
  const w = { t, notified: false }
  m.waiters.push(w)
  scheduler.wake()
  const until = ms > 0 ? now() + ms : Infinity
  return new Block(() => (w.notified || now() >= until) && (!m.owner || m.owner === t), until, 'wait').then(() => {
    const i = m.waiters.indexOf(w)
    if (i >= 0) m.waiters.splice(i, 1)
    m.owner = t; m.count = saved
  })
}
export function notify(o: any, all: boolean) {
  const m = monitorOf(o)
  for (const w of m.waiters) { if (!w.notified) { w.notified = true; if (!all) break } }
  scheduler.wake()
}
