// manifest and package validation (dpk-spec.md sections 3, 4, 11, 12).
// erasable typescript only: node runs this file directly for tools/pack-dpk.

export const SPEC_VERSION = '2.0'
export const API_LEVEL = 19
export const LIMITS = { total: 64 * 1024 * 1024, file: 20 * 1024 * 1024, files: 5000, extras: 256 * 1024, saved: 64 * 1024 }
export const PERMISSIONS = ['network', 'storage', 'notifications', 'vibrate', 'clipboard', 'camera', 'microphone', 'location', 'fullscreen', 'background-audio', 'danen', 'vte']
export const SYSTEM_PERMISSIONS = ['system.statusbar', 'system.notifications', 'system.wallpaper', 'system.settings', 'system.windows', 'system.networks', 'system.apps']
const TYPES = ['web', 'wasm', 'arm', 'converted']

export class DpkError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
const bad = (m: string) => { throw new DpkError('invalid', m) }

// paths inside: lowercase, forward slashes, no .., not absolute
export function checkPath(p: string) {
  if (p !== p.toLowerCase()) bad(`path must be lowercase: ${p}`)
  if (p.includes('\\') || p.startsWith('/') || p.split('/').includes('..') || p.split('/').includes('.')) bad(`bad path: ${p}`)
}

export function validateManifest(m: any, files?: Set<string>, opts: { system?: boolean } = {}) {
  if (!m || typeof m !== 'object') bad('manifest.json is not an object')
  for (const k of ['id', 'name', 'version', 'versioncode', 'type', 'main', 'activities']) if (m[k] == null) bad(`manifest: missing ${k}`)
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(m.id)) bad('manifest: id must be reverse-dns, lowercase (com.example.app)')
  if (typeof m.name !== 'string' || !m.name.trim()) bad('manifest: name must be text')
  if (!Number.isInteger(m.versioncode) || m.versioncode < 1) bad('manifest: versioncode must be a positive integer')
  if (!TYPES.includes(m.type)) bad(`manifest: type must be one of ${TYPES.join(', ')}`)
  if (m.dpk != null) {
    const major = parseInt(String(m.dpk).split('.')[0], 10)
    if (major > parseInt(SPEC_VERSION, 10)) throw new DpkError('unsupported', `this Droid supports DPK spec ${SPEC_VERSION}, the app needs ${m.dpk}`)
  }
  if ((m.minapi ?? 1) > API_LEVEL) throw new DpkError('unsupported', `the app needs Droid API ${m.minapi}, this is API ${API_LEVEL}`)
  if (typeof m.activities !== 'object' || !Object.keys(m.activities).length) bad('manifest: activities is empty')
  if (!m.activities[m.main]) bad(`manifest: main activity "${m.main}" is not in activities`)
  for (const [name, a] of Object.entries<any>(m.activities)) {
    if (m.type === 'web' || m.type === 'wasm') {
      if (!a.entry) bad(`activity ${name}: missing entry`)
      checkPath(a.entry)
      if (files && !files.has(a.entry)) bad(`activity ${name}: entry ${a.entry} is not in the package`)
    }
    if (a['launch-mode'] && !['standard', 'single-top'].includes(a['launch-mode'])) bad(`activity ${name}: bad launch-mode`)
  }
  if (m.icon) { checkPath(m.icon); if (files && !files.has(m.icon)) bad(`icon ${m.icon} is not in the package`) }
  for (const p of m.permissions || []) {
    const name = typeof p === 'string' ? p : p?.name
    if (SYSTEM_PERMISSIONS.includes(name)) { if (!opts.system) bad(`permission ${name} is only for system apps`) }
    else if (!PERMISSIONS.includes(name)) bad(`unknown permission ${name}`)
  }
  for (const f of m['intent-filters'] || []) {
    if (!m.activities[f.activity]) bad(`intent filter for unknown activity ${f.activity}`)
    if (!Array.isArray(f.actions) || !f.actions.length) bad('intent filter without actions')
  }
  if (m.type === 'wasm') {
    if (!m.wasm?.module) bad('wasm apps need wasm.module')
    checkPath(m.wasm.module)
    if (files && !files.has(m.wasm.module)) bad(`wasm module ${m.wasm.module} is not in the package`)
  }
  if (m.type === 'arm' && (!m.abi || m.abi !== 'armeabi-v7a')) bad('arm apps need abi: armeabi-v7a')
  if (m.type === 'converted' && !['dex', 'arm', 'both'].includes(m.runtime)) bad('converted apps need runtime: dex, arm or both')
  if ((m.role || m.system) && !opts.system) bad('only system apps may declare role or system')
  return m
}

export function checkSizes(files: { path: string; size: number }[]) {
  if (files.length > LIMITS.files) throw new DpkError('toolarge', `more than ${LIMITS.files} files`)
  let total = 0
  for (const f of files) {
    if (f.size > LIMITS.file) throw new DpkError('toolarge', `${f.path} is bigger than 20 MB`)
    total += f.size
  }
  if (total > LIMITS.total) throw new DpkError('toolarge', 'package is bigger than 64 MB')
}

export async function sha256(data: Uint8Array) {
  const h = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const permName = (p: string | { name: string }) => (typeof p === 'string' ? p : p.name)
