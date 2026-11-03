// danen account (spec sections 19 and 22). local first: the profile lives on this device and works
// with no network. the optional backend (milestone 6) only syncs it. never a google account.
import { settings } from './settings'

export interface Profile {
  nickname: string
  username: string
  salt: string // base64
  hash: string // pbkdf2-sha256 of the password, base64
  created: number
  remote: boolean // true once it exists on the danen backend
}

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function derive(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 150000 }, key, 256)
  return b64(bits)
}

const USER_RE = /^[a-z0-9._-]{3,32}$/

// hook for the backend client (set in milestone 6). returns true if the remote call worked.
export const remote: {
  create?: (p: Profile, password: string) => Promise<void>
  signIn?: (username: string, password: string) => Promise<{ nickname: string }>
} = {}

export const account = {
  get: () => (settings.get('danen.account') as Profile | undefined) || null,
  async create(nickname: string, username: string, password: string) {
    username = username.toLowerCase()
    if (!USER_RE.test(username)) throw new Error('Username: 3 to 32 letters, digits, dots, dashes or underscores.')
    if (password.length < 8) throw new Error('Password: at least 8 characters.')
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const p: Profile = { nickname: nickname.slice(0, 40) || username, username, salt: b64(salt), hash: await derive(password, salt), created: Date.now(), remote: false }
    try { if (remote.create) { await remote.create(p, password); p.remote = true } } catch { /* backend down: local only, sync later */ }
    settings.set('danen.account', p)
    return p
  },
  async signIn(username: string, password: string) {
    username = username.toLowerCase()
    const local = account.get()
    if (local && local.username === username) {
      if ((await derive(password, unb64(local.salt))) !== local.hash) throw new Error('Wrong username or password.')
      return local
    }
    if (!remote.signIn) throw new Error('Can\'t reach danen right now. Create an account on this device, or tap "Not now".')
    const r = await remote.signIn(username, password)
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const p: Profile = { nickname: r.nickname, username, salt: b64(salt), hash: await derive(password, salt), created: Date.now(), remote: true }
    settings.set('danen.account', p)
    return p
  },
  signOut() { settings.set('danen.account', undefined as any) },
}
