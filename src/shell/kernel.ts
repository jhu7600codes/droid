// the kernel: app registry, roles and intent resolution. nothing visible lives here.
import type { Manifest, Intent, SystemApp, Activity, ActivityContext } from './types'
import { settings } from './settings'

export interface AppEntry {
  manifest: Manifest
  icon: string
  system: boolean
  impl?: SystemApp // system apps run in the shell
  // dpk apps: the runtime makes activities (set by runtime/ in milestone 3)
  create?: (ctx: ActivityContext) => Activity
}

type Listener = () => void
const apps = new Map<string, AppEntry>()
const changed = new Set<Listener>()

// user-replaceable roles: settings key role.<name> -> package id
const roleKey = (r: string) => `role.${r}`

export const kernel = {
  apps,
  register(e: AppEntry) {
    apps.set(e.manifest.id, e)
    changed.forEach((f) => f())
  },
  unregister(id: string) {
    apps.delete(id)
    changed.forEach((f) => f())
  },
  onAppsChanged(f: Listener) {
    changed.add(f)
    return () => changed.delete(f)
  },
  get(id: string) {
    return apps.get(id)
  },
  // the app holding a role: the user's pick if it still exists, else the first system app with it
  role(role: string): AppEntry | undefined {
    const pick = settings.get(roleKey(role)) as string | undefined
    if (pick && apps.get(pick)?.manifest.role === role) return apps.get(pick)
    for (const a of apps.values()) if (a.system && a.manifest.role === role) return a
    return undefined
  },
  setRole(role: string, id: string) {
    settings.set(roleKey(role), id)
  },
  // launcher entries: every activity with launcher: true
  launchables() {
    const out: { app: AppEntry; activity: string; label: string }[] = []
    for (const app of apps.values()) {
      for (const [name, a] of Object.entries(app.manifest.activities)) {
        if (a.launcher) out.push({ app, activity: name, label: a.label || app.manifest.name })
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  },
  // spec section 6: explicit = package (+activity), implicit = action + data/type matched against intent-filters
  resolve(i: Intent): { app: AppEntry; activity: string }[] {
    if (i.package) {
      const app = apps.get(i.package)
      if (!app) return []
      return [{ app, activity: i.activity || app.manifest.main }]
    }
    const out: { app: AppEntry; activity: string }[] = []
    const scheme = i.data?.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
    for (const app of apps.values()) {
      for (const f of app.manifest['intent-filters'] || []) {
        if (!i.action || !f.actions.includes(i.action)) continue
        if (f.schemes && (!scheme || !f.schemes.includes(scheme))) continue
        if (f.mimetypes && i.type && !f.mimetypes.some((m) => mimeMatch(m, i.type!))) continue
        if (f.mimetypes && !i.type && !scheme) continue
        out.push({ app, activity: f.activity })
      }
    }
    return out
  },
}

function mimeMatch(pattern: string, type: string) {
  if (pattern === '*/*' || pattern === type) return true
  const [a, b] = pattern.split('/')
  const [c, d] = type.split('/')
  return (a === '*' || a === c) && (b === '*' || b === d)
}
