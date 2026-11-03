// droid.net client (spec section 18): direct when the browser allows it, else through the droid proxy.
// apps never talk to the proxy themselves.
import { settings } from '../shell/settings'
import { DpkError } from './manifest'

export function proxyConfig() {
  const url = (settings.get('proxy.url') as string || '').replace(/\/+$/, '')
  const token = settings.get('proxy.token') as string || ''
  return url ? { url, token } : null
}

export async function proxiedFetch(pkg: string, url: string, init: { method: string; headers: Record<string, string>; body?: ArrayBuffer | string }) {
  const opts: RequestInit = { method: init.method, headers: init.headers, body: init.method === 'GET' || init.method === 'HEAD' ? undefined : init.body, credentials: 'omit', mode: 'cors', redirect: 'follow' }
  try {
    return await fetch(url, opts)
  } catch {
    // cors refused (or offline): try the proxy
    const p = proxyConfig()
    if (!p) throw new DpkError('denied', 'the site refused a direct request and no droid proxy is set (settings > more > droid proxy)')
    const headers = { ...init.headers, 'x-droid-token': p.token, 'x-droid-app': pkg }
    try {
      return await fetch(`${p.url}/fetch?url=${encodeURIComponent(url)}`, { ...opts, headers })
    } catch {
      throw new DpkError('offline', 'the droid proxy is not reachable')
    }
  }
}

// websocket through the proxy, for when a direct one fails
export function proxiedSocketUrl(url: string) {
  const p = proxyConfig()
  if (!p) return null
  return `${p.url.replace(/^http/, 'ws')}/ws?url=${encodeURIComponent(url)}&token=${encodeURIComponent(p.token)}`
}
