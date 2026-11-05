// system settings: a small key-value store with change events.
// kept in localStorage so it is there synchronously at boot (it is tiny).
// app data and installed dpks live in indexeddb (see store.ts), not here.

export interface SystemSettings {
  'setup.done': boolean
  'owner.name': string
  locale: string
  'screen.mode': 'auto' | 'preset' | 'custom'
  'screen.preset': string // key of PRESETS in screen.ts
  'screen.custom': { w: number; h: number; dpi: number }
  'screen.fit': 'auto' | 'fit' | 'native'
  'screen.scale': number // display size: 0.85 small .. 1.3 largest, changes density only
  'screen.renderScale': number
  'screen.form': 'auto' | 'phone' | 'tablet' | 'desktop'
  'font.scale': number
  'lock.type': 'none' | 'slide' | 'pin'
  'lock.pin': string
  wallpaper: string
  brightness: number
  'brightness.auto': boolean
  'airplane': boolean
  'wifi.on': boolean
  'data.on': boolean
  'bt.on': boolean
  'location.on': boolean
  'rotation.lock': boolean
  'time.24h': boolean
  'sound.touch': boolean
  'proxy.url': string
  [k: string]: unknown
}

const DEFAULTS: Partial<SystemSettings> = {
  'setup.done': false,
  'owner.name': '',
  locale: 'en',
  'screen.mode': 'auto',
  'screen.preset': 'phone-hdpi',
  'screen.custom': { w: 480, h: 800, dpi: 240 },
  'screen.fit': 'auto',
  'screen.scale': 1,
  'screen.renderScale': 1,
  'screen.form': 'auto',
  'font.scale': 1,
  'lock.type': 'slide',
  'lock.pin': '',
  wallpaper: 'framework/default_wallpaper',
  brightness: 1,
  'brightness.auto': false,
  airplane: false,
  'wifi.on': true,
  'data.on': true,
  'bt.on': false,
  'location.on': false,
  'rotation.lock': false,
  'time.24h': false,
  'sound.touch': true,
  // the public droid proxy on deno deploy; changing it needs developer options
  'proxy.url': 'https://sweet-moose-8098.vedeo.deno.net',
  // the danen backend (supabase edge function); changing it needs developer options
  'danen.backend': 'https://kicqdpzodcwiuzrdriie.supabase.co/functions/v1/danen',
  'dev.enabled': false,
  'boot.anim': 'field', // boot intro: field (jhu's scene) or lens
}

const KEY = 'droid.settings'
let data: Record<string, unknown> = {}
try { data = JSON.parse(localStorage.getItem(KEY) || '{}') } catch { data = {} }
const listeners = new Map<string, Set<(v: unknown) => void>>()

export const settings = {
  get<K extends keyof SystemSettings>(k: K): SystemSettings[K] {
    return (k in data ? data[k as string] : DEFAULTS[k]) as SystemSettings[K]
  },
  set<K extends keyof SystemSettings>(k: K, v: SystemSettings[K]) {
    data[k as string] = v
    try { localStorage.setItem(KEY, JSON.stringify(data)) } catch { /* private mode: keep in memory */ }
    for (const fn of listeners.get(k as string) || []) fn(v)
    for (const fn of listeners.get('*') || []) fn(k)
  },
  // fn runs on change; returns an unsubscribe function
  on(k: keyof SystemSettings | '*', fn: (v: any) => void) {
    let s = listeners.get(k as string)
    if (!s) listeners.set(k as string, (s = new Set()))
    s.add(fn)
    return () => s!.delete(fn)
  },
  reset() {
    data = {}
    try { localStorage.removeItem(KEY) } catch { /* ignore */ }
  },
}
