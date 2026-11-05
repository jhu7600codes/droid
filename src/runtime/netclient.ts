// droid.net client (spec section 18): direct when the browser allows it, else through the droid proxy.
// apps never talk to the proxy themselves.
import { settings } from '../shell/settings'
import { DpkError } from './manifest'

// the proxy hands out a token on POST /register: droid asks once when only the address is set
let registering: Promise<void> | null = null
export async function ensureProxyToken() {
  const url = ((settings.get('proxy.url') as string) || '').replace(/\/+$/, '')
  if (!url || settings.get('proxy.token')) return
  registering ||= fetch(url + '/register', { method: 'POST' }).then((r) => r.json()).then((d) => { if (d.token) settings.set('proxy.token', d.token) }).catch(() => {}).finally(() => { registering = null })
  await registering
}

export function proxyConfig() {
  const url = (settings.get('proxy.url') as string || '').replace(/\/+$/, '')
  const token = settings.get('proxy.token') as string || ''
  return url ? { url, token } : null
}

import { state } from '../shell/net'

// on vte: count the bytes, and slow things down when "slow network" is on (cosmetic)
async function vte(r: Response) {
  if (state().kind !== 'vte') return r
  if (settings.get('vte.slow')) await new Promise((ok) => setTimeout(ok, 600 + Math.random() * 900))
  const n = +(r.headers.get('content-length') || 0)
  settings.set('vte.used', ((settings.get('vte.used') as number) || 0) + n)
  return r
}

export async function proxiedFetch(pkg: string, url: string, init: { method: string; headers: Record<string, string>; body?: ArrayBuffer | string }) {
  if (state().kind === 'none' && settings.get('airplane')) throw new DpkError('offline', 'airplane mode is on')
  return vte(await rawFetch(pkg, url, init))
}

async function rawFetch(pkg: string, url: string, init: { method: string; headers: Record<string, string>; body?: ArrayBuffer | string }) {
  const opts: RequestInit = { method: init.method, headers: init.headers, body: init.method === 'GET' || init.method === 'HEAD' ? undefined : init.body, credentials: 'omit', mode: 'cors', redirect: 'follow' }
  // plain http from an https page is blocked (mixed content): straight to the proxy. a direct try
  // leaves out user-agent (it would force a cors preflight; the proxy sends it)
  const mixed = location.protocol === 'https:' && /^http:/i.test(url)
  try {
    if (mixed) throw new Error('mixed content')
    const direct = Object.fromEntries(Object.entries(init.headers || {}).filter(([k]) => k.toLowerCase() !== 'user-agent'))
    return await fetch(url, { ...opts, headers: direct })
  } catch {
    // cors refused (or offline): try the proxy
    await ensureProxyToken()
    const p = proxyConfig()
    if (!p) throw new DpkError('denied', 'the site refused a direct request and no Droid proxy is set (settings > more > Droid proxy)')
    const headers = { ...init.headers, 'x-droid-token': p.token, 'x-droid-app': pkg }
    try {
      return await fetch(`${p.url}/fetch?url=${encodeURIComponent(url)}`, { ...opts, headers })
    } catch {
      throw new DpkError('offline', 'the Droid proxy is not reachable')
    }
  }
}

// websocket through the proxy, for when a direct one fails
export function proxiedSocketUrl(url: string) {
  const p = proxyConfig()
  if (!p) return null
  return `${p.url.replace(/^http/, 'ws')}/ws?url=${encodeURIComponent(url)}&token=${encodeURIComponent(p.token)}`
}
