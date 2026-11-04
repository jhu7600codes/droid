// client for the danen backend (backend/supabase/functions/danen). off until settings has danen.backend.
import { settings } from './settings'
import { remote } from './danen'

export const backendUrl = () => ((settings.get('danen.backend') as string) || '').replace(/\/+$/, '')

async function call(path: string, method = 'GET', body?: unknown) {
  const url = backendUrl()
  if (!url) throw new Error('no danen backend set')
  const session = settings.get('danen.session') as string | undefined
  const r = await fetch(url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { authorization: 'Danen ' + session } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.error || 'danen is not reachable'), { status: r.status })
  return data
}

export function installRemote() {
  remote.create = async (p, password) => {
    if (!backendUrl()) throw new Error('local only')
    const r = await call('/account/create', 'POST', { username: p.username, nickname: p.nickname, password })
    settings.set('danen.session', r.session)
  }
  remote.signIn = backendUrl() ? async (username, password) => {
    const r = await call('/account/signin', 'POST', { username, password })
    settings.set('danen.session', r.session)
    return { nickname: r.nickname }
  } : undefined
}

export const danenApi = {
  getSync: () => call('/sync'),
  putSync: (items: Record<string, unknown>) => call('/sync', 'PUT', { items }),
  subscribe: (pkg: string, subscription: unknown) => call('/push/subscribe', 'POST', { pkg, subscription }),
  vapid: () => call('/vapid'),
  push: (pkg: string | null, title: string, body: string, data?: unknown) => call('/push/send', 'POST', { pkg, title, body, data }),
  deleteAccount: () => call('/account/delete', 'POST'),
}
