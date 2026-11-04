// background work for apps (converted android apps first): alarms, broadcasts and services.
// a job runs in the app's hidden "background host" (its page, without a window), which closes
// a while after its last job. alarms are kept in settings and checked every 15 s while droid runs;
// a browser can't wake a closed page, so alarms that came due meanwhile fire on the next boot.
import { settings } from '../shell/settings'
import { kernel } from '../shell/kernel'
import { h } from '../shell/ui'
import { layers } from '../shell/layers'
import type { Activity, ActivityContext } from '../shell/types'
import { RESULT_CANCELED } from '../shell/types'

export interface Job { kind: 'broadcast' | 'service' | 'activity'; cls?: string; action?: string; extras?: Record<string, unknown> }
interface Alarm { pkg: string; id: string; at: number; interval: number; job: Job }

const KEY = 'bg.alarms'
const alarms = (): Alarm[] => (settings.get(KEY) as Alarm[]) || []
const save = (a: Alarm[]) => settings.set(KEY, a)

export function setAlarm(pkg: string, a: { id: string; at: number; interval?: number; job: Job }) {
  const list = alarms().filter((x) => !(x.pkg === pkg && x.id === a.id))
  list.push({ pkg, id: String(a.id), at: +a.at, interval: Math.max(0, +(a.interval || 0)), job: a.job })
  if (list.filter((x) => x.pkg === pkg).length > 100) throw new Error('too many alarms')
  save(list)
}
export function cancelAlarm(pkg: string, id: string) { save(alarms().filter((x) => !(x.pkg === pkg && x.id === id))) }

// ---------- background hosts ----------
interface Bg { el: HTMLElement; impl: Activity; timer: number; queue: Job[]; ready: Promise<void>; deliver: (j: Job) => void }
const hosts = new Map<string, Bg>()
let box: HTMLElement | null = null

function host(pkg: string): Bg {
  let b = hosts.get(pkg)
  if (b) return b
  const app = kernel.get(pkg)
  if (!app?.create) throw new Error('no such app')
  box ||= h('div.bg-hosts', { style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', opacity: '0', pointerEvents: 'none', left: '-9999px' } })
  if (!box.isConnected) layers.windows.append(box)
  const el = h('div', { style: { width: '360px', height: '640px' } })
  box.append(el)
  let markReady!: () => void
  const ready = new Promise<void>((ok) => (markReady = ok))
  const ctx: ActivityContext = {
    root: el, pkg, name: '__bg', intent: { action: 'background', extras: { background: true } }, manifest: app.manifest,
    finish: () => close(pkg), start: () => {}, startForResult: async () => ({ code: RESULT_CANCELED }), setResult: () => {}, setTitle: () => {},
  }
  const impl = app.create(ctx)
  impl.create?.()
  b = { el, impl, timer: 0, queue: [], ready, deliver: (j) => impl.intent?.({ action: 'background-job', extras: { job: j } }) }
  hosts.set(pkg, b)
  // the page tells us it is up by asking for its first job (bg.idle) - until then jobs wait
  setTimeout(markReady, 4000)
  ;(b as any).markReady = markReady
  return b
}
function close(pkg: string) {
  const b = hosts.get(pkg)
  if (!b) return
  hosts.delete(pkg)
  try { b.impl.destroy?.() } catch { /* gone */ }
  b.el.remove()
}
function keepAlive(pkg: string) {
  const b = hosts.get(pkg)
  if (!b) return
  clearTimeout(b.timer)
  b.timer = window.setTimeout(() => close(pkg), 60000)
}

export async function runInBackground(pkg: string, job: Job) {
  if (job.kind === 'activity') { // the app resolved the activity name when it set the alarm
    const { wm } = await import('../shell/wm')
    const act = (job as any).activity
    wm.start({ package: pkg, action: 'alarm', activity: kernel.get(pkg)?.manifest.activities[act] ? act : undefined, extras: { android: job.extras || {}, androidAction: job.action } })
    return
  }
  const b = host(pkg)
  b.queue.push(job)
  keepAlive(pkg)
  await b.ready
  while (b.queue.length) b.deliver(b.queue.shift()!)
}
// the background page is up (first call) or finished a job
export function idle(pkg: string) {
  const b = hosts.get(pkg)
  if (!b) return
  ;(b as any).markReady?.()
  keepAlive(pkg)
}

// ---------- the alarm clock ----------
function tick() {
  const now = Date.now()
  const list = alarms()
  let changed = false
  for (const a of list) {
    if (a.at > now) continue
    if (!kernel.get(a.pkg)) { a.at = Infinity; changed = true; continue }
    runInBackground(a.pkg, a.job).catch((e) => console.warn('alarm', a.pkg, e))
    if (a.interval > 0) { while (a.at <= now) a.at += a.interval } else a.at = Infinity
    changed = true
  }
  if (changed) save(list.filter((a) => a.at !== Infinity))
}

export function startBackground() {
  setInterval(tick, 15000)
  setTimeout(tick, 5000)
  // boot completed: wake every receiver that listens for it
  setTimeout(() => {
    for (const app of kernel.apps.values()) {
      if (app.manifest.type !== 'converted' || !(app.manifest['android-receivers'] as string[] | undefined)?.includes('android.intent.action.BOOT_COMPLETED')) continue
      runInBackground(app.manifest.id, { kind: 'broadcast', action: 'android.intent.action.BOOT_COMPLETED' }).catch(() => {})
    }
  }, 8000)
}
