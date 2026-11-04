// the droid proxy for deno deploy (same api as proxy/server.mjs, spec section 18):
//   GET /health, POST /register, POST /session, ANY /fetch?url=, GET /p/<sid>/..., WS /ws?url=
// tokens and sessions live in deno kv (hashed), limits per token, ssrf checks on every hop.
// deploy: link the repo on dash.deno.com with entrypoint proxy/deno/main.ts (no build step).
import { toProxy, fromProxy, rewriteHtml, rewriteCss, shimFor } from './rewrite.mjs'

const env = (k: string, d = '') => Deno.env.get(k) ?? d
const cfg = {
  registration: env('REGISTRATION', 'open'),
  origins: env('ORIGINS', '*').split(','),
  allowHosts: env('ALLOW_HOSTS').split(',').filter(Boolean),
  allowPorts: env('ALLOW_PORTS', '80,443').split(',').map(Number),
  perMinute: +env('RATE_PER_MINUTE', '300'),
  bytesPerDay: +env('BYTES_PER_DAY', String(2 * 1024 ** 3)),
  maxResponse: +env('MAX_RESPONSE', String(100 * 1024 ** 2)),
  timeoutMs: +env('TIMEOUT_MS', '60000'),
  staticTokens: env('DROID_TOKENS').split(',').filter(Boolean),
}
const kv = await Deno.openKv(env('KV_PATH') || undefined)
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')
const rand = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]!))

async function validToken(t: string | null) {
  if (!t) return null
  const h = await sha(t)
  if (cfg.staticTokens.includes(t)) return h.slice(0, 16)
  return (await kv.get(['token', h])).value ? h.slice(0, 16) : null
}

// ---------- limits (per isolate; good enough against abuse on the free tier) ----------
const buckets = new Map<string, { minute: number; count: number; day: number; bytes: number }>()
function bucket(k: string) {
  const now = Date.now()
  let b = buckets.get(k)
  if (!b) buckets.set(k, (b = { minute: now, count: 0, day: now, bytes: 0 }))
  if (now - b.minute > 60000) { b.minute = now; b.count = 0 }
  if (now - b.day > 86400000) { b.day = now; b.bytes = 0 }
  return b
}
const allow = (k: string, per = cfg.perMinute) => { const b = bucket(k); if (b.count >= per || b.bytes >= cfg.bytesPerDay) return false; b.count++; return true }

// ---------- ssrf ----------
const v4 = (ip: string) => ip.split('.').reduce((n, x) => n * 256 + +x, 0)
const V4_BLOCK: [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
function blockedIp(ip: string): boolean {
  const mapped = ip.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return blockedIp(mapped[1])
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) { const n = v4(ip); return V4_BLOCK.some(([b, p]) => Math.floor(n / 2 ** (32 - p)) === Math.floor(v4(b) / 2 ** (32 - p))) }
  const x = ip.toLowerCase()
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith('2001:db8')
}
async function checkUrl(raw: string | null): Promise<string | null> {
  let u: URL
  try { u = new URL(raw || '') } catch { return 'bad url' }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return 'only http, https, ws and wss'
  const port = +(u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80))
  if (!cfg.allowPorts.includes(port)) return `port ${port} is not allowed`
  if (u.username || u.password) return 'no credentials in urls'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return 'address not allowed'
  if (cfg.allowHosts.length && !cfg.allowHosts.some((h) => h === host || (h.startsWith('*.') && host.endsWith(h.slice(1))))) return 'host not on the allowlist'
  if (/^[\d.]+$/.test(host) || host.includes(':')) return blockedIp(host) ? 'address not allowed' : null
  // resolve and check every address (deno's fetch can't pin the ip, so rebinding is narrowed, not closed)
  const addrs: string[] = []
  for (const t of ['A', 'AAAA'] as const) { try { addrs.push(...(await Deno.resolveDns(host, t))) } catch { /* no records */ } }
  if (!addrs.length) return 'host not found'
  return addrs.some(blockedIp) ? 'address not allowed' : null
}

// ---------- cookie jars ----------
type Cookie = { name: string; value: string; domain: string; path: string; expires: number; hostOnly: boolean }
class Jar {
  c: Cookie[] = []
  store(url: string, sc: string[]) {
    const u = new URL(url)
    for (const line of sc) {
      const [pair, ...attrs] = line.split(';')
      const i = pair.indexOf('=')
      if (i < 1) continue
      const c: Cookie = { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: u.hostname, path: '/', expires: Infinity, hostOnly: true }
      for (const a of attrs) {
        const [k, v = ''] = a.split('=').map((s) => s.trim())
        const key = k.toLowerCase()
        if (key === 'domain' && v) { const d = v.replace(/^\./, '').toLowerCase(); if (u.hostname === d || u.hostname.endsWith('.' + d)) { c.domain = d; c.hostOnly = false } }
        if (key === 'path' && v) c.path = v
        if (key === 'max-age') c.expires = Date.now() + +v * 1000
        if (key === 'expires') c.expires = Date.parse(v) || Infinity
      }
      this.c = this.c.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path))
      if (c.expires > Date.now()) this.c.push(c)
    }
    if (this.c.length > 300) this.c.splice(0, this.c.length - 300)
  }
  header(url: string) {
    const u = new URL(url), now = Date.now()
    return this.c.filter((c) => c.expires > now && (c.hostOnly ? u.hostname === c.domain : u.hostname === c.domain || u.hostname.endsWith('.' + c.domain)) && u.pathname.startsWith(c.path)).map((c) => `${c.name}=${c.value}`).join('; ')
  }
}
// sessions are kept in kv so any isolate can serve them; jars are cached in memory
const jars = new Map<string, Jar>()
async function session(sid: string) {
  const s = (await kv.get<{ key: string; jar: Cookie[] }>(['session', sid])).value
  if (!s) return null
  let jar = jars.get(sid)
  if (!jar) { jar = new Jar(); jar.c = s.jar || []; jars.set(sid, jar) }
  return { key: s.key, jar, save: () => kv.set(['session', sid], { key: s.key, jar: jar!.c }, { expireIn: 12 * 3600 * 1000 }) }
}

// ---------- helpers ----------
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'origin', 'referer', 'content-length', 'accept-encoding'])
const DROP = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'strict-transport-security', 'set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'alt-svc', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'report-to', 'nel'])
function corsHeaders(req: Request): Record<string, string> {
  const o = req.headers.get('origin') || ''
  const ok = cfg.origins.includes('*') || cfg.origins.includes(o)
  return ok ? { 'access-control-allow-origin': cfg.origins.includes('*') ? '*' : o, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS', 'access-control-expose-headers': '*', vary: 'origin' } : { vary: 'origin' }
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...corsHeaders(req) } })
function outHeaders(req: Request, extra: Record<string, string> = {}) {
  const h: Record<string, string> = {}
  req.headers.forEach((v, k) => { if (!HOP.has(k) && !k.startsWith('x-droid-') && !k.startsWith('sec-') && !k.startsWith('access-control-')) h[k] = v })
  return { ...h, ...extra }
}
async function upstream(url: string, init: RequestInit & { follow?: boolean }, jar: Jar | null, hops = 0): Promise<{ r: Response; url: string }> {
  const bad = await checkUrl(url)
  if (bad) throw Object.assign(new Error(bad), { status: 403 })
  const headers = new Headers(init.headers)
  const cookie = jar?.header(url)
  if (cookie) headers.set('cookie', cookie)
  const r = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) })
  const sc = r.headers.getSetCookie()
  if (jar && sc.length) jar.store(url, sc)
  if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location') && hops < 8 && init.follow !== false) {
    const next = new URL(r.headers.get('location')!, url).href
    const method = r.status === 303 || ((r.status === 301 || r.status === 302) && init.method === 'POST') ? 'GET' : init.method
    return upstream(next, { ...init, method, body: method === 'GET' ? undefined : init.body }, jar, hops + 1)
  }
  return { r, url }
}
// counts bytes and enforces the size cap while streaming
function metered(body: ReadableStream<Uint8Array> | null, key: string) {
  if (!body) return null
  let n = 0
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) { n += chunk.length; if (n > cfg.maxResponse) { ctl.error(new Error('response too large')); return } ctl.enqueue(chunk) },
    flush() { bucket(key).bytes += n },
  }))
}
const errorPage = (url: string, reason: string, status = 502) => new Response(`<!doctype html><meta charset=utf-8><body style="font-family:sans-serif"><script>parent.postMessage({droid:'error',url:${JSON.stringify(url)},reason:${JSON.stringify(reason)}},'*')</script><p>${reason.replace(/[<>&"]/g, '')}</p>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

// ---------- routes ----------
async function handleFetch(req: Request, u: URL) {
  const key = await validToken(req.headers.get('x-droid-token') || u.searchParams.get('token'))
  if (!key) return json(req, { error: 'token required' }, 401)
  if (!allow(key)) return json(req, { error: 'rate limited' }, 429)
  const app = (req.headers.get('x-droid-app') || 'app').slice(0, 100)
  const jk = key + '|' + app
  let jar = jars.get(jk)
  if (!jar) jars.set(jk, (jar = new Jar()))
  try {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer()
    const { r } = await upstream(u.searchParams.get('url')!, { method: req.method, headers: outHeaders(req), body }, jar)
    const h = new Headers(corsHeaders(req))
    r.headers.forEach((v, k) => { if (!DROP.has(k)) h.set(k, v) })
    return new Response(metered(r.body, key), { status: r.status, headers: h })
  } catch (e) {
    return json(req, { error: (e as Error).message === 'address not allowed' ? 'address not allowed' : 'upstream failed' }, (e as any).status || 502)
  }
}

async function handlePage(req: Request, u: URL) {
  const p = fromProxy(u.pathname + u.search)
  const s = p && (await session(p.sid))
  if (!p || !s) return errorPage(p?.url || '', 'session expired, reload the page', 403)
  if (!allow(s.key)) return errorPage(p.url, 'too many requests, slow down', 429)
  try {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer()
    const isDoc = ['document', 'iframe'].includes(req.headers.get('sec-fetch-dest') || '')
    const { r } = await upstream(p.url, { method: req.method, headers: outHeaders(req, { referer: new URL(p.url).origin + '/' }), body, follow: !isDoc }, s.jar)
    await s.save()
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location')) return new Response(null, { status: r.status, headers: { location: toProxy(r.headers.get('location'), p.url, p.sid), 'cache-control': 'no-store' } })
    const type = r.headers.get('content-type') || ''
    const h = new Headers({ 'referrer-policy': 'no-referrer' })
    r.headers.forEach((v, k) => { if (!DROP.has(k) && k !== 'location') h.set(k, v) })
    if (/text\/html|application\/xhtml/.test(type)) { const html = await r.text(); bucket(s.key).bytes += html.length; return new Response(rewriteHtml(html, p.url, p.sid, shimFor(p.sid, p.url)), { status: r.status, headers: h }) }
    if (/text\/css/.test(type)) { const css = await r.text(); bucket(s.key).bytes += css.length; return new Response(rewriteCss(css, p.url, p.sid), { status: r.status, headers: h }) }
    return new Response(metered(r.body, s.key), { status: r.status, headers: h })
  } catch (e) {
    return errorPage(p.url, (e as any).status === 403 ? 'this address is not allowed' : 'webpage not available')
  }
}

async function handleWs(req: Request, u: URL) {
  const sid = u.searchParams.get('sid')
  const key = sid ? (await session(sid))?.key : await validToken(u.searchParams.get('token'))
  const target = u.searchParams.get('url')
  if (!key || (await checkUrl(target)) || !allow(key)) return new Response('forbidden', { status: 403 })
  const { socket, response } = Deno.upgradeWebSocket(req)
  const up = new WebSocket(target!)
  up.binaryType = 'arraybuffer'
  const queue: (string | ArrayBuffer)[] = []
  up.onopen = () => queue.splice(0).forEach((m) => up.send(m))
  up.onmessage = (e) => { bucket(key).bytes += (e.data as any).length || (e.data as ArrayBuffer).byteLength || 0; if (socket.readyState === 1) socket.send(e.data) }
  socket.onmessage = (e) => { if (up.readyState === 1) up.send(e.data); else queue.push(e.data) }
  const close = () => { try { socket.close() } catch { /* closed */ } try { up.close() } catch { /* closed */ } }
  up.onclose = close; up.onerror = close; socket.onclose = close; socket.onerror = close
  return response
}

async function rescue(req: Request, u: URL) {
  const ref = req.headers.get('referer')
  const p = ref ? fromProxy(new URL(ref).pathname + new URL(ref).search) : null
  if (!p) return json(req, { error: 'not found' }, 404)
  return new Response(null, { status: 307, headers: { location: toProxy(u.pathname + u.search, p.url, p.sid) } })
}

export async function handler(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
  const u = new URL(req.url)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) })
  try {
    if (u.pathname === '/health') return json(req, { ok: true, droid: 'proxy 0.1 (deno)' })
    if (u.pathname === '/register' && req.method === 'POST') {
      if (cfg.registration !== 'open') return json(req, { error: 'registration is closed on this proxy' }, 403)
      const ip = (info?.remoteAddr as Deno.NetAddr | undefined)?.hostname || 'ip'
      if (!allow('reg|' + ip, 5)) return json(req, { error: 'rate limited' }, 429)
      const token = rand(24)
      await kv.set(['token', await sha(token)], true)
      return json(req, { token })
    }
    if (u.pathname === '/session' && req.method === 'POST') {
      const key = await validToken(req.headers.get('x-droid-token'))
      if (!key) return json(req, { error: 'token required' }, 401)
      const sid = rand(16)
      await kv.set(['session', sid], { key, jar: [] }, { expireIn: 12 * 3600 * 1000 })
      return json(req, { sid })
    }
    if (u.pathname === '/fetch') return handleFetch(req, u)
    if (u.pathname.startsWith('/p/')) return handlePage(req, u)
    if (u.pathname === '/ws' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') return handleWs(req, u)
    return rescue(req, u)
  } catch {
    return json(req, { error: 'proxy error' }, 500)
  }
}

if (import.meta.main) Deno.serve({ port: +env('PORT', '8000') }, handler)
