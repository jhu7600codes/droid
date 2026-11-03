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
}
const list = new Map<string, Notification>()
const subs = new Set<() => void>()
const fire = () => subs.forEach((f) => f())

export const notifications = {
  all: () => [...list.values()].sort((a, b) => b.time - a.time),
  post(n: Omit<Notification, 'time'> & { time?: number; silent?: boolean }) {
    const isNew = !list.has(n.pkg + ':' + n.id)
    list.set(n.pkg + ':' + n.id, { time: Date.now(), ...n })
    if (isNew && !n.silent && !n.ongoing) sound.play('notifications/' + ((settings.get('sound.notification') as string) || 'Tejat'))
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
  on(f: () => void) {
    subs.add(f)
    return () => subs.delete(f)
  },
}
