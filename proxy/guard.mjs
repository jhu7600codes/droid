// the parts that keep the proxy from being an open relay: tokens, rate limits, ssrf checks.
import net from 'node:net'
import dns from 'node:dns'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

export const config = {
  port: +(process.env.PORT || 8787),
  dataDir: process.env.DATA_DIR || './data',
  // comma separated tokens that always work (for people who self-host for themselves)
  staticTokens: (process.env.DROID_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // open: anyone can get a token from POST /register (rate limited per ip). closed: only DROID_TOKENS
  registration: process.env.REGISTRATION || 'open',
  // shell origins allowed to call /fetch with cors (comma separated, * for any)
  origins: (process.env.ORIGINS || '*').split(',').map((s) => s.trim()),
  allowHosts: (process.env.ALLOW_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean), // optional allowlist
  allowPorts: (process.env.ALLOW_PORTS || '80,443').split(',').map(Number),
  perMinute: +(process.env.RATE_PER_MINUTE || 300),
  bytesPerDay: +(process.env.BYTES_PER_DAY || 2 * 1024 ** 3),
  maxResponse: +(process.env.MAX_RESPONSE || 100 * 1024 ** 2),
  timeoutMs: +(process.env.TIMEOUT_MS || 60000),
}

// ---------- tokens (only sha-256 hashes are stored) ----------
const tokenFile = path.join(config.dataDir, 'tokens.json')
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex')
let tokens = new Set()
try { tokens = new Set(JSON.parse(fs.readFileSync(tokenFile, 'utf8'))) } catch { /* first run */ }
for (const t of config.staticTokens) tokens.add(hash(t))
const saveTokens = () => {
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.writeFileSync(tokenFile, JSON.stringify([...tokens]))
}
export const validToken = (t) => !!t && tokens.has(hash(String(t)))
export function newToken() {
  const t = crypto.randomBytes(24).toString('base64url')
  tokens.add(hash(t))
  saveTokens()
  return t
}

// ---------- rate limits ----------
const buckets = new Map() // key -> { minute, count, day, bytes }
function bucket(key) {
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) buckets.set(key, (b = { minute: now, count: 0, day: now, bytes: 0 }))
  if (now - b.minute > 60000) { b.minute = now; b.count = 0 }
  if (now - b.day > 86400000) { b.day = now; b.bytes = 0 }
  return b
}
export function allowRequest(key, perMinute = config.perMinute) {
  const b = bucket(key)
  if (b.count >= perMinute || b.bytes >= config.bytesPerDay) return false
  b.count++
  return true
}
export function countBytes(key, n) { bucket(key).bytes += n }
setInterval(() => { const old = Date.now() - 2 * 86400000; for (const [k, b] of buckets) if (b.day < old) buckets.delete(k) }, 3600000).unref()

// ---------- ssrf: no loopback, private, link-local, cgnat, multicast, reserved ----------
const blocked = new net.BlockList()
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
]) blocked.addSubnet(a, p, 'ipv4')
for (const [a, p] of [['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(a, p, 'ipv6')
// note: BlockList also matches ipv4 against ipv4-mapped ipv6 subnets, so mapped and nat64
// addresses are unwrapped here instead of being listed
// only for the automated tests (loopback upstream), never in production
const TEST_LOOPBACK = process.env.NODE_ENV === 'test' && process.env.DANGER_ALLOW_LOOPBACK_FOR_TESTS === '1'
export function isBlockedIp(ip) {
  if (TEST_LOOPBACK && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return false
  const m = ip.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i)
  if (m) return isBlockedIp(m[1])
  return blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4')
}

// checks the url itself (scheme, port, host allowlist, literal ips)
export function checkUrl(raw) {
  let u
  try { u = new URL(raw) } catch { return 'bad url' }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return 'only http, https, ws and wss'
  const port = +(u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80))
  if (!config.allowPorts.includes(port)) return `port ${port} is not allowed`
  if (u.username || u.password) return 'no credentials in urls'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host) && isBlockedIp(host)) return 'address not allowed'
  if (!TEST_LOOPBACK && /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return 'address not allowed'
  if (config.allowHosts.length && !config.allowHosts.some((h) => h === host || (h.startsWith('*.') && host.endsWith(h.slice(1))))) return 'host not on the allowlist'
  return null
}

// dns lookup used for every outgoing connection: checks the address it actually connects to,
// so dns rebinding can't sneak a private address in after checkUrl
export function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err)
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }]
    const ok = list.filter((a) => !isBlockedIp(a.address))
    if (!ok.length) return cb(Object.assign(new Error('address not allowed'), { code: 'EBLOCKED' }))
    if (options.all) cb(null, ok)
    else cb(null, ok[0].address, ok[0].family)
  })
}
