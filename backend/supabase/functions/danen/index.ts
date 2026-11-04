// danen edge function (deno, supabase). routes:
//   POST /account/create   {username, nickname, password} -> {session, nickname}
//   POST /account/signin   {username, password}           -> {session, nickname}
//   POST /account/delete   (session)                       -> {}  removes the account and all its data
//   GET  /sync             (session)                       -> {items: {key: {value, updated}}}
//   PUT  /sync             (session) {items: {key: value}} -> {updated}
//   POST /push/subscribe   (session) {pkg, subscription}   -> {}
//   GET  /vapid                                            -> {key} public web push key
//   POST /push/send        (session) {pkg?, title, body}   -> {sent}  push to your own devices
//   POST /push/admin       (x-danen-push-secret) {username, pkg?, title, body} -> {sent}  server-side sends
// the vapid key pair is generated on first use and kept in the config table (service role only).
// session = "authorization: Danen <token>". passwords: pbkdf2-sha256, 210k rounds, per-user salt.
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const ORIGINS = (Deno.env.get('DANEN_ORIGINS') || '*').split(',')
const enc = new TextEncoder()
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))

async function pbkdf2(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 210000 }, key, 256))
}
function same(a: string, b: string) { // constant time compare
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

// small per-ip limiter (per function instance)
const hits = new Map<string, { t: number; n: number }>()
function limited(ip: string, max: number) {
  const now = Date.now()
  const h = hits.get(ip)
  if (!h || now - h.t > 60000) { hits.set(ip, { t: now, n: 1 }); return false }
  return ++h.n > max
}

function cors(req: Request) {
  const o = req.headers.get('origin') || ''
  return {
    'access-control-allow-origin': ORIGINS.includes('*') ? '*' : ORIGINS.includes(o) ? o : ORIGINS[0],
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    vary: 'origin',
  }
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(req) } })

async function newSession(userId: string) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, '')
  await db.from('sessions').insert({ token_hash: await sha(token), user_id: userId })
  return token
}
async function userOf(req: Request) {
  const m = (req.headers.get('authorization') || '').match(/^Danen (.+)$/)
  if (!m) return null
  const h = await sha(m[1])
  const { data } = await db.from('sessions').select('user_id').eq('token_hash', h).maybeSingle()
  if (!data) return null
  await db.from('sessions').update({ last_used: new Date().toISOString() }).eq('token_hash', h)
  return data.user_id as string
}

// ---------- web push ----------
let vapid: { publicKey: string; privateKey: string } | null = null
async function getVapid() {
  if (vapid) return vapid
  const { data } = await db.from('config').select('key, value').in('key', ['vapid_public', 'vapid_private'])
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]))
  if (m.vapid_public && m.vapid_private) vapid = { publicKey: m.vapid_public, privateKey: m.vapid_private }
  else {
    const k = webpush.generateVAPIDKeys()
    // insert-only: if another instance won the race, read theirs instead
    await db.from('config').upsert([{ key: 'vapid_public', value: k.publicKey }, { key: 'vapid_private', value: k.privateKey }], { onConflict: 'key', ignoreDuplicates: true })
    vapid = null
    return getVapid()
  }
  webpush.setVapidDetails(Deno.env.get('DANEN_PUSH_CONTACT') || 'mailto:push@danen.invalid', vapid.publicKey, vapid.privateKey)
  return vapid
}
async function pushTo(userId: string, pkg: string | null, msg: { title: string; body: string; data?: unknown }) {
  await getVapid()
  let q = db.from('push_subs').select('pkg, endpoint, keys').eq('user_id', userId)
  if (pkg) q = q.eq('pkg', pkg)
  const { data } = await q
  let sent = 0
  for (const s of data || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ ...msg, pkg: s.pkg }), { TTL: 86400 })
      sent++
    } catch (e) {
      // gone subscriptions are removed
      if ((e as any)?.statusCode === 404 || (e as any)?.statusCode === 410) await db.from('push_subs').delete().eq('user_id', userId).eq('endpoint', s.endpoint)
    }
  }
  return sent
}
const clean = (m: any) => ({ title: String(m?.title || 'droid').slice(0, 120), body: String(m?.body || '').slice(0, 500), data: m?.data ?? null })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) })
  const path = new URL(req.url).pathname.replace(/^.*\/danen/, '')
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'ip'
  try {
    if (path === '/vapid') return json(req, { key: (await getVapid()).publicKey })
    if (path === '/push/admin' && req.method === 'POST') {
      const secret = Deno.env.get('DANEN_PUSH_SECRET')
      if (!secret || !same(req.headers.get('x-danen-push-secret') || '', secret)) return json(req, { error: 'not allowed' }, 403)
      const b = await req.json()
      const { data: u } = await db.from('users').select('id').eq('username', String(b.username || '').toLowerCase()).maybeSingle()
      if (!u) return json(req, { error: 'no such user' }, 404)
      return json(req, { sent: await pushTo(u.id, b.pkg ? String(b.pkg) : null, clean(b)) })
    }

    if (path === '/account/create' && req.method === 'POST') {
      if (limited('c' + ip, 5)) return json(req, { error: 'slow down' }, 429)
      const { username, nickname, password } = await req.json()
      const u = String(username || '').toLowerCase()
      if (!/^[a-z0-9._-]{3,32}$/.test(u)) return json(req, { error: 'bad username' }, 400)
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) return json(req, { error: 'password: at least 8 characters' }, 400)
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)))
      const { data, error } = await db.from('users').insert({ username: u, nickname: String(nickname || u).slice(0, 40), pw_salt: salt, pw_hash: await pbkdf2(password, salt) }).select('id, nickname').single()
      if (error) return json(req, { error: error.code === '23505' ? 'that username is taken' : 'could not create account' }, 409)
      return json(req, { session: await newSession(data.id), nickname: data.nickname })
    }

    if (path === '/account/signin' && req.method === 'POST') {
      if (limited('s' + ip, 10)) return json(req, { error: 'slow down' }, 429)
      const { username, password } = await req.json()
      const { data } = await db.from('users').select('id, nickname, pw_salt, pw_hash').eq('username', String(username || '').toLowerCase()).maybeSingle()
      const hash = await pbkdf2(String(password || ''), data?.pw_salt || 'x')
      if (!data || !same(hash, data.pw_hash)) return json(req, { error: 'wrong username or password' }, 401)
      return json(req, { session: await newSession(data.id), nickname: data.nickname })
    }

    const user = await userOf(req)
    if (!user) return json(req, { error: 'sign in again' }, 401)

    if (path === '/account/delete' && req.method === 'POST') {
      await db.from('users').delete().eq('id', user)
      return json(req, {})
    }
    if (path === '/sync' && req.method === 'GET') {
      const { data } = await db.from('sync').select('key, value, updated_at').eq('user_id', user).limit(5000)
      return json(req, { items: Object.fromEntries((data || []).map((r) => [r.key, { value: r.value, updated: r.updated_at }])) })
    }
    if (path === '/sync' && req.method === 'PUT') {
      const text = await req.text()
      if (text.length > 5 * 1024 * 1024) return json(req, { error: 'too large' }, 413)
      const { items } = JSON.parse(text)
      const rows = Object.entries(items || {}).slice(0, 1000).map(([key, value]) => ({ user_id: user, key: key.slice(0, 200), value, updated_at: new Date().toISOString() }))
      if (rows.length) await db.from('sync').upsert(rows)
      return json(req, { updated: rows.length })
    }
    if (path === '/push/subscribe' && req.method === 'POST') {
      const { pkg, subscription } = await req.json()
      if (!subscription?.endpoint?.startsWith('https://')) return json(req, { error: 'bad subscription' }, 400)
      await db.from('push_subs').upsert({ user_id: user, pkg: String(pkg).slice(0, 100), endpoint: subscription.endpoint, keys: subscription.keys || {} })
      return json(req, {})
    }
    if (path === '/push/send' && req.method === 'POST') {
      if (limited('p' + user, 30)) return json(req, { error: 'slow down' }, 429)
      const b = await req.json()
      return json(req, { sent: await pushTo(user, b.pkg ? String(b.pkg) : null, clean(b)) })
    }
    return json(req, { error: 'not found' }, 404)
  } catch {
    return json(req, { error: 'server error' }, 500)
  }
})
