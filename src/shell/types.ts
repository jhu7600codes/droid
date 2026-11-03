// shared shell types. Manifest follows dpk-spec.md section 4.

export interface ActivityDecl {
  entry?: string // html file (dpk apps)
  label?: string
  launcher?: boolean
  'launch-mode'?: 'standard' | 'single-top'
}

export interface Manifest {
  id: string
  name: string
  version: string
  versioncode: number
  type: 'web' | 'wasm' | 'arm' | 'converted'
  main: string
  activities: Record<string, ActivityDecl>
  icon?: string
  minapi?: number
  permissions?: (string | { name: string; hosts?: string[] })[]
  orientation?: 'portrait' | 'landscape' | 'any'
  theme?: 'holo-dark' | 'holo-light'
  'intent-filters'?: IntentFilter[]
  wasm?: { module: string; memory?: { initial?: number; maximum?: number } }
  role?: string
  system?: boolean
  supports?: ('phone' | 'tablet' | 'desktop')[]
  resizable?: boolean
  'legacy-menu'?: boolean
  dpk?: string
  author?: string
  description?: string
  homepage?: string
  integrity?: Record<string, string>
  'converted-from'?: { package: string; version: string }
  [k: string]: unknown
}

export interface IntentFilter {
  activity: string
  actions: string[]
  mimetypes?: string[]
  schemes?: string[]
}

export interface Intent {
  action?: string // view, send, pick, main, capture, settings ...
  package?: string
  activity?: string
  data?: string
  type?: string
  extras?: Record<string, unknown>
}

export interface Result { code: number; data?: unknown }
export const RESULT_OK = -1
export const RESULT_CANCELED = 0

export type LifecycleEvent = 'create' | 'start' | 'resume' | 'pause' | 'stop' | 'destroy'

// what a running activity of a system app (in-shell, trusted) implements.
// dpk apps implement the same thing through the sdk bridge (see runtime/).
export interface Activity {
  create?(saved?: unknown): void
  start?(): void
  resume?(): void
  pause?(): unknown // may return saved state
  stop?(): void
  destroy?(): void
  back?(): boolean // true = handled, do not pop
  menu?(): void
  intent?(i: Intent): void // single-top relaunch
  result?(requestId: number, r: Result): void
  configchange?(): void
}

export interface ActivityContext {
  root: HTMLElement
  pkg: string
  name: string
  intent: Intent
  manifest: Manifest
  finish(result?: Result): void
  start(i: Intent): void
  startForResult(i: Intent): Promise<Result>
  setResult(r: Result): void
  setTitle(t: string): void
}

export interface SystemApp {
  manifest: Manifest
  icon: string // image url
  iconRef?: [string, string] // aosp image (package, name), resolved at boot for the density
  activities: Record<string, (ctx: ActivityContext) => Activity>
  // background part of a system app (systemui, services): started once at boot
  service?: () => void | Promise<void>
}
