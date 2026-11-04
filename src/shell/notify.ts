import { sound } from './sound'
import { settings } from './settings'
// notifications (spec section 9 system.notify). systemui draws them, apps post them.
export interface Notification {
  id: string
  pkg: string
  title: string
  text?: string
  icon: string // small icon url
  largeIcon?: string
  time: number
  ongoing?: boolean
  progress?: number // 0..1, or -1 for indeterminate
  onclick?: () => void
  ticker?: string // shown in the status bar when it arrives (kitkat)
}
const list = new Map<string, Notification>()
const subs = new Set<() => void>()
const posted = new Set<(n: Notification) => void>()
const fire = () => subs.forEach((f) => f())

export const notifications = {
  all: () => [...list.values()].sort((a, b) => b.time - a.time),
  post(n: Omit<Notification, 'time'> & { time?: number; silent?: boolean }) {
    const isNew = !list.has(n.pkg + ':' + n.id)
    list.set(n.pkg + ':' + n.id, { time: Date.now(), ...n })
    if (isNew && !n.silent && !n.ongoing) sound.play('notifications/' + ((settings.get('sound.notification') as string) || 'Tejat'))
    if (isNew && !n.silent) posted.forEach((f) => f(list.get(n.pkg + ':' + n.id)!))
    fire()
  },
  cancel(pkg: string, id: string) {
    list.delete(pkg + ':' + id)
    fire()
  },
  clearAll() {
    for (const [k, n] of list) if (!n.ongoing) list.delete(k)
    fire()
  },
  // new notifications only (the status bar ticker)
  onPosted(f: (n: Notification) => void) { posted.add(f) },
  on(f: () => void) {
    subs.add(f)
    return () => subs.delete(f)
  },
}
