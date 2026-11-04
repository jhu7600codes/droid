// the droid proxy (dpk spec section 18). small, self-hostable, not an open relay.
//   GET  /health
//   POST /register              -> { token }        (when REGISTRATION=open, rate limited per ip)
//   POST /session  {app, tab}   -> { sid }           (x-droid-token header; a page session with its own cookie jar)
//   ANY  /fetch?url=...                              (x-droid-token header; droid.net.fetch relay with cors)
//   GET  /p/<sid>/<scheme>/<host>/<path>             (page mode for the browser: rewritten, framing allowed)
//   WS   /ws?url=...&token=... or &sid=...           (websocket relay)
// no page content or bodies are ever logged.
import http from 'node:http'
import crypto from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Agent, fetch } from 'undici'
import { WebSocketServer, WebSocket } from 'ws'
import { config, validToken, newToken, allowRequest, countBytes, checkUrl, safeLookup } from './guard.mjs'
import { toProxy, fromProxy, rewriteHtml, rewriteCss, shimFor } from './deno/rewrite.mjs'

// every outgoing connection goes through safeLookup (blocks private addresses after dns too).
// tls to the origin is always verified (undici default, never turned off)
const agent = new Agent({ connect: { lookup: safeLookup, timeout: 15000 }, headersTimeout: config.timeoutMs, bodyTimeout: config.timeoutMs })

// ---------- sessions and cookie jars (per app and tab, never shared) ----------
const sessions = new Map() // sid -> { token, app, tab, jar, last }
const jars = new Map() // "token|app" -> jar, for /fetch
const SESSION_IDLE = 12 * 3600 * 1000
setInterval(() => { const t = Date.now() - SESSION_IDLE; for (const [k, s] of sessions) if (s.last < t) sessions.delete(k) }, 600000).unref()
const tokenKey = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16)

class Jar {
  constructor() { this.c = [] }
  store(url, setCookies) {
    const u = new URL(url)
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';')
      const i = pair.indexOf('=')
      if (i < 1) continue
      const c = { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: u.hostname, path: '/', expires: Infinity, hostOnly: true }
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
    if (this.c.length > 500) this.c.splice(0, this.c.length - 500)
  }
  header(url) {
    const u = new URL(url)
    const now = Date.now()
    return this.c.filter((c) => c.expires > now && (c.hostOnly ? u.hostname === c.domain : u.hostname === c.domain || u.hostname.endsWith('.' + c.domain)) && u.pathname.startsWith(c.path))
      .map((c) => `${c.name}=${c.value}`).join('; ')
  }
}

// ---------- helpers ----------
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'origin', 'referer', 'content-length', 'accept-encoding'])
const DROP_RESPONSE = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'strict-transport-security', 'set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'alt-svc', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'report-to', 'nel'])
const clientIp = (req) => req.socket.remoteAddress || '?'

function cors(req, res) {
  const origin = req.headers.origin
  const ok = config.origins.includes('*') || (origin && config.origins.includes(origin))
  if (ok) {
    res.setHeader('access-control-allow-origin', config.origins.includes('*') ? '*' : origin)
    res.setHeader('access-control-allow-headers', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS')
    res.setHeader('access-control-expose-headers', '*')
    res.setHeader('access-control-max-age', '600')
  }
  res.setHeader('vary', 'origin')
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = []
  let n = 0
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('body too large'); chunks.push(c) }
  return Buffer.concat(chunks)
}

// fetch with manual redirects so every hop gets checked
async function upstream(url, init, jar, hops = 0) {
  const bad = checkUrl(url)
  if (bad) throw Object.assign(new Error(bad), { status: 403 })
  const headers = { ...init.headers }
  const cookie = jar?.header(url)
  if (cookie) headers.cookie = cookie
  const r = await fetch(url, { ...init, headers, redirect: 'manual', dispatcher: agent, signal: AbortSignal.timeout(config.timeoutMs) })
  const sc = r.headers.getSetCookie?.() || []
  if (jar && sc.length) jar.store(url, sc)
  if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location') && hops < 8 && init.follow !== false) {
    const next = new URL(r.headers.get('location'), url).href
    const method = r.status === 303 || ((r.status === 301 || r.status === 302) && init.method === 'POST') ? 'GET' : init.method
    return upstream(next, { ...init, method, body: method === 'GET' ? undefined : init.body }, jar, hops + 1)
  }
  return { r, url }
}

// streams the body with byte counting and the size cap
async function pipeBody(r, res, key) {
  if (!r.body) return res.end()
  let n = 0
  const counter = new Transform({
    transform(chunk, enc, cb) {
      n += chunk.length
      if (n > config.maxResponse) return cb(new Error('response too large'))
      cb(null, chunk)
    },
  })
  try { await pipeline(Readable.fromWeb(r.body), counter, res) } catch { res.destroy() }
  countBytes(key, n)
}

function outHeaders(req, extra = {}) {
  const h = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || k.startsWith('x-droid-') || k.startsWith('sec-') || k.startsWith('access-control-')) continue
    h[k] = v
  }
  return { ...h, ...extra }
}

// ---------- routes ----------
async function handleFetch(req, res, u) {
  const token = req.headers['x-droid-token'] || u.searchParams.get('token')
  if (!validToken(token)) return send(res, 401, { error: 'token required' })
  const key = tokenKey(token)
  if (!allowRequest(key)) return send(res, 429, { error: 'rate limited' })
  const target = u.searchParams.get('url')
  const app = String(req.headers['x-droid-app'] || 'app').slice(0, 100)
  let jar = jars.get(key + '|' + app)
  if (!jar) jars.set(key + '|' + app, (jar = new Jar()))
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
  try {
    const { r } = await upstream(target, { method: req.method, headers: outHeaders(req), body }, jar)
    const h = {}
    r.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k)) h[k] = v })
    res.writeHead(r.status, h)
    await pipeBody(r, res, key)
  } catch (e) {
    send(res, e.status || 502, { error: e.message === 'address not allowed' || e.code === 'EBLOCKED' ? 'address not allowed' : 'upstream failed' })
  }
}

function errorPage(res, url, reason, status = 502) {
  const safe = (s) => String(s).replace(/[<>&"]/g, '')
  send(res, status, `<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;background:#fff"><script>parent.postMessage({droid:'error',url:${JSON.stringify(url)},reason:${JSON.stringify(reason)}},'*')</script><p>${safe(reason)}</p>`, 'text/html; charset=utf-8')
}

async function handlePage(req, res, u) {
  const p = fromProxy(u.pathname + u.search)
  const s = p && sessions.get(p.sid)
  if (!s) return errorPage(res, p?.url || '', 'session expired, reload the page', 403)
  s.last = Date.now()
  if (!allowRequest(s.key)) return errorPage(res, p.url, 'too many requests, slow down', 429)
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
  try {
    const headers = outHeaders(req, { referer: new URL(p.url).origin + '/' })
    // documents: let the browser see redirects so its url bar is right
    const isDoc = req.headers['sec-fetch-dest'] === 'document' || req.headers['sec-fetch-dest'] === 'iframe'
    const { r } = await upstream(p.url, { method: req.method, headers, body, follow: !isDoc }, s.jar)
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location')) {
      res.writeHead(r.status, { location: toProxy(r.headers.get('location'), p.url, p.sid), 'cache-control': 'no-store' })
      return res.end()
    }
    const type = r.headers.get('content-type') || ''
    const h = { 'referrer-policy': 'no-referrer' }
    r.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k) && k !== 'location') h[k] = v })
    if (/text\/html|application\/xhtml/.test(type)) {
      const html = await r.text()
      countBytes(s.key, html.length)
      if (html.length > config.maxResponse) return errorPage(res, p.url, 'page too large')
      res.writeHead(r.status, { ...h, 'content-type': type })
      return res.end(rewriteHtml(html, p.url, p.sid, shimFor(p.sid, p.url)))
    }
    if (/text\/css/.test(type)) {
      const css = await r.text()
      countBytes(s.key, css.length)
      res.writeHead(r.status, { ...h, 'content-type': type })
      return res.end(rewriteCss(css, p.url, p.sid))
    }
    res.writeHead(r.status, h)
    await pipeBody(r, res, s.key)
  } catch (e) {
    if (res.headersSent) return res.destroy()
    errorPage(res, p.url, e.code === 'EBLOCKED' || e.status === 403 ? 'this address is not allowed' : 'webpage not available')
  }
}

// root-relative urls made by page scripts land on the proxy root: send them back into the session
function rescue(req, res, u) {
  const ref = req.headers.referer && new URL(req.headers.referer)
  const p = ref && fromProxy(ref.pathname + ref.search)
  if (!p) return send(res, 404, { error: 'not found' })
  res.writeHead(307, { location: toProxy(u.pathname + u.search, p.url, p.sid) })
  res.end()
}

const regLimit = new Map()
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://proxy')
    cors(req, res)
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    if (u.pathname === '/health') return send(res, 200, { ok: true, droid: 'proxy 0.1' })
    if (u.pathname === '/register' && req.method === 'POST') {
      if (config.registration !== 'open') return send(res, 403, { error: 'registration is closed on this proxy' })
      if (!allowRequest('reg|' + clientIp(req), 5)) return send(res, 429, { error: 'rate limited' })
      return send(res, 200, { token: newToken() })
    }
    if (u.pathname === '/session' && req.method === 'POST') {
      const token = req.headers['x-droid-token']
      if (!validToken(token)) return send(res, 401, { error: 'token required' })
      const b = JSON.parse((await readBody(req, 4096)).toString() || '{}')
      const sid = crypto.randomBytes(16).toString('base64url')
      sessions.set(sid, { key: tokenKey(token), app: String(b.app || 'browser').slice(0, 100), tab: String(b.tab || '0').slice(0, 40), jar: new Jar(), last: Date.now() })
      return send(res, 200, { sid })
    }
    if (u.pathname === '/fetch') return handleFetch(req, res, u)
    if (u.pathname.startsWith('/p/')) return handlePage(req, res, u)
    return rescue(req, res, u)
  } catch {
    if (!res.headersSent) send(res, 500, { error: 'proxy error' })
  }
})

// ---------- websocket relay ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://proxy')
  if (u.pathname !== '/ws') return socket.destroy()
  const sid = u.searchParams.get('sid')
  const token = u.searchParams.get('token')
  const key = sid && sessions.get(sid) ? sessions.get(sid).key : validToken(token) ? tokenKey(token) : null
  const target = u.searchParams.get('url')
  if (!key || checkUrl(target) || !allowRequest(key)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy() }
  wss.handleUpgrade(req, socket, head, (client) => {
    const up = new WebSocket(target, { lookup: safeLookup, handshakeTimeout: 15000, headers: { 'user-agent': req.headers['user-agent'] || 'droid' } })
    const queue = []
    up.on('open', () => queue.splice(0).forEach((m) => up.send(m.data, { binary: m.binary })))
    up.on('message', (d, binary) => { countBytes(key, d.length); client.readyState === 1 && client.send(d, { binary }) })
    client.on('message', (d, binary) => { countBytes(key, d.length); up.readyState === 1 ? up.send(d, { binary }) : queue.push({ data: d, binary }) })
    const close = () => { try { client.close() } catch {} try { up.close() } catch {} }
    up.on('close', close); up.on('error', close); client.on('close', close); client.on('error', close)
  })
})

server.listen(config.port, () => console.log(`droid proxy on :${config.port} (registration ${config.registration})`))
export default server
