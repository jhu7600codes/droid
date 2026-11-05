// more of the java library apps lean on: regular expressions (java.util.regex and String's regex
// methods, translated to js regexps), dates (Date, Calendar, TimeZone, SimpleDateFormat, DateFormat),
// numbers (NumberFormat, DecimalFormat), digests (MD5, SHA-1, SHA-256), SecureRandom, URL encoding,
// android.util.Base64, float / double bits, RandomAccessFile, ssl stubs, InetAddress.
import { VM, JObject, JArray, type NativeFn } from './dalvik.ts'
import { jstr } from './java.ts'

const OBJ = 'Ljava/lang/Object;'

// ---------- java regex -> js ----------
const POSIX: Record<string, string> = {
  Lower: 'a-z', Upper: 'A-Z', ASCII: '\\x00-\\x7f', Alpha: 'a-zA-Z', Digit: '0-9', Alnum: 'a-zA-Z0-9', Punct: '!-\\/:-@\\[-`{-~',
  Graph: '!-~', Print: ' -~', Blank: ' \\t', Cntrl: '\\x00-\\x1f\\x7f', XDigit: '0-9a-fA-F', Space: ' \\t\\n\\x0b\\f\\r',
  javaLowerCase: 'a-z', javaUpperCase: 'A-Z', javaWhitespace: ' \\t\\n\\x0b\\f\\r', L: '\\p{L}', IsAlphabetic: '\\p{L}', IsDigit: '\\d', IsLetter: '\\p{L}',
}
export function javaRegex(src: string, flags = 0): RegExp {
  let f = 'u'
  if (flags & 2) f += 'i' // CASE_INSENSITIVE
  if (flags & 8) f += 'm' // MULTILINE
  if (flags & 32) f += 's' // DOTALL
  if (flags & 16) return new RegExp(src.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), f) // LITERAL
  // leading inline flags (?ims)
  src = src.replace(/^\(\?([imsux]+)\)/, (_, fl: string) => { for (const c of fl) if ('ims'.includes(c) && !f.includes(c)) f += c; return '' })
  let out = '', inClass = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      const n = src[i + 1]
      if (n === 'Q') { const e = src.indexOf('\\E', i + 2); const lit = src.slice(i + 2, e < 0 ? undefined : e); out += lit.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'); i = e < 0 ? src.length : e + 1; continue }
      if (n === 'p' || n === 'P') {
        const m = /^\{(?:Is|In)?([A-Za-z]+)\}/.exec(src.slice(i + 2))
        if (m && POSIX[m[1]] !== undefined) {
          const set = POSIX[m[1]]
          out += inClass ? (n === 'p' ? set : '') : n === 'p' ? `[${set}]` : `[^${set}]`
          i += 1 + m[0].length
          continue
        }
        out += c + n; i++; continue
      }
      if (n === 'z' || n === 'Z') { out += '$(?![\\s\\S])'; i++; continue }
      if (n === 'A') { out += '(?<![\\s\\S])'; i++; continue }
      if (n === 'h') { out += '[ \\t\\xA0\\u1680\\u180e\\u2000-\\u200a\\u202f\\u205f\\u3000]'; i++; continue }
      out += c + (n ?? ''); i++; continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      // java allows [a-z&&[^b]] intersections: rare, kept as is (js has no such thing)
      out += c === '/' ? '\\/' : c
      continue
    }
    if (c === '[') { inClass = true; out += c; if (src[i + 1] === '^') { out += '^'; i++ } if (src[i + 1] === ']') { out += '\\]'; i++ } continue }
    // possessive quantifiers (x*+ x++ x?+ {n}+): plain greedy ones here
    if (c === '+' && i > 0 && /[*+?}]/.test(src[i - 1]) && src[i - 2] !== '\\') continue
    out += c
  }
  return new RegExp(out, f)
}
// java replacement strings: \x is a literal x, $n / ${name} are groups
export function javaReplacement(rep: string) {
  let out = ''
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i]
    if (c === '\\') { const n = rep[++i] ?? ''; out += n === '$' ? '$$' : n; continue }
    if (c === '$') {
      if (rep[i + 1] === '{') { const e = rep.indexOf('}', i); out += `$<${rep.slice(i + 2, e)}>`; i = e; continue }
      const m = /^\d+/.exec(rep.slice(i + 1))
      if (m) { out += '$' + m[0]; i += m[0].length; continue }
      throw new Error('Illegal group reference')
    }
    out += c
  }
  return out
}

// ---------- digests ----------
function md5(data: Uint8Array) {
  const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0
  const len = data.length, n = ((len + 8) >>> 6) + 1, w = new Int32Array(n * 16)
  for (let i = 0; i < len; i++) w[i >> 2] |= data[i] << ((i % 4) * 8)
  w[len >> 2] |= 0x80 << ((len % 4) * 8)
  w[n * 16 - 2] = (len * 8) | 0; w[n * 16 - 1] = Math.floor(len / 0x20000000)
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476
  for (let blk = 0; blk < n * 16; blk += 16) {
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let F: number, g: number
      if (i < 16) { F = (b & c) | (~b & d); g = i } else if (i < 32) { F = (d & b) | (~d & c); g = (5 * i + 1) % 16 } else if (i < 48) { F = b ^ c ^ d; g = (3 * i + 5) % 16 } else { F = c ^ (b | ~d); g = (7 * i) % 16 }
      const t = d; d = c; c = b
      const x = (a + F + K[i] + w[blk + g]) | 0, s = S[(i >> 4) * 4 + (i % 4)]
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0; a = t
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0
  }
  const out = new Uint8Array(16), v = new DataView(out.buffer)
  ;[a0, b0, c0, d0].forEach((x, i) => v.setInt32(i * 4, x, true))
  return out
}
function shaBlocks(data: Uint8Array) {
  const len = data.length, n = ((len + 8) >>> 6) + 1, w = new Int32Array(n * 16)
  for (let i = 0; i < len; i++) w[i >> 2] |= data[i] << (24 - (i % 4) * 8)
  w[len >> 2] |= 0x80 << (24 - (len % 4) * 8)
  w[n * 16 - 1] = (len * 8) | 0; w[n * 16 - 2] = Math.floor(len / 0x20000000)
  return w
}
function sha1(data: Uint8Array) {
  const w0 = shaBlocks(data), h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0], w = new Int32Array(80)
  for (let blk = 0; blk < w0.length; blk += 16) {
    for (let i = 0; i < 80; i++) w[i] = i < 16 ? w0[blk + i] : ((x) => (x << 1) | (x >>> 31))(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16])
    let [a, b, c, d, e] = h
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc | 0 : 0xca62c1d6 | 0
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0
  }
  const out = new Uint8Array(20), v = new DataView(out.buffer)
  h.forEach((x, i) => v.setInt32(i * 4, x))
  return out
}
const K256 = new Int32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2])
function sha256(data: Uint8Array) {
  const w0 = shaBlocks(data), w = new Int32Array(64)
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const r = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let blk = 0; blk < w0.length; blk += 16) {
    for (let i = 0; i < 64; i++) w[i] = i < 16 ? w0[blk + i] : (w[i - 16] + (r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10))) | 0
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh
  }
  const out = new Uint8Array(32), v = new DataView(out.buffer)
  h.forEach((x, i) => v.setInt32(i * 4, x))
  return out
}
export const DIGESTS: Record<string, { len: number; fn: (d: Uint8Array) => Uint8Array }> = {
  MD5: { len: 16, fn: md5 }, 'SHA-1': { len: 20, fn: sha1 }, SHA1: { len: 20, fn: sha1 }, SHA: { len: 20, fn: sha1 }, 'SHA-256': { len: 32, fn: sha256 }, SHA256: { len: 32, fn: sha256 },
}

// ---------- time zones ----------
// offset in minutes east of utc for a zone id at an instant
function zoneOffset(id: string, ms: number): number {
  if (id === 'UTC' || id === 'GMT' || id === 'Z') return 0
  const fixed = /^(?:GMT|UTC)?([+-])(\d{1,2}):?(\d{2})?$/.exec(id)
  if (fixed) return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3] || 0))
  if (id === 'default') return -new Date(ms).getTimezoneOffset()
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: id, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms))
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value)
    return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000) / 60000)
  } catch { return 0 }
}
const defaultZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'default' } catch { return 'default' } }

// broken-down wall time in a zone
function fields(ms: number, zone: string) {
  const off = zoneOffset(zone, ms)
  const d = new Date(ms + off * 60000)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), dow: d.getUTCDay(), off,
    doy: Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1 }
}
function fromFields(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, zone: string) {
  const guess = Date.UTC(y, mo, d, h, mi, s, ms)
  let t = guess - zoneOffset(zone, guess) * 60000
  t = guess - zoneOffset(zone, t) * 60000 // once more around dst changes
  return t
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number, w: number) => String(Math.abs(n)).padStart(w, '0')
const offStr = (off: number, colon: boolean) => `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60), 2)}${colon ? ':' : ''}${pad(Math.abs(off) % 60, 2)}`

// SimpleDateFormat patterns: tokens (letter runs) and literals
function tokens(p: string) {
  const out: { t: string; n: number }[] = []
  for (let i = 0; i < p.length;) {
    const c = p[i]
    if (c === "'") {
      if (p[i + 1] === "'") { out.push({ t: "'", n: 0 }); i += 2; continue }
      const e = p.indexOf("'", i + 1)
      out.push({ t: p.slice(i + 1, e < 0 ? undefined : e), n: 0 }); i = e < 0 ? p.length : e + 1; continue
    }
    if (/[a-zA-Z]/.test(c)) { let j = i; while (p[j] === c) j++; out.push({ t: c, n: j - i }); i = j; continue }
    out.push({ t: c, n: 0 }); i++
  }
  return out
}
export function formatDate(pattern: string, ms: number, zone: string) {
  const f = fields(ms, zone)
  return tokens(pattern).map(({ t, n }) => {
    if (!n) return t
    switch (t) {
      case 'G': return f.y > 0 ? 'AD' : 'BC'
      case 'y': case 'Y': return n === 2 ? pad(f.y % 100, 2) : pad(f.y, n)
      case 'M': case 'L': return n >= 4 ? MONTHS[f.mo] : n === 3 ? MONTHS[f.mo].slice(0, 3) : pad(f.mo + 1, n)
      case 'd': return pad(f.d, n)
      case 'D': return pad(f.doy, n)
      case 'E': return n >= 4 ? DAYS[f.dow] : DAYS[f.dow].slice(0, 3)
      case 'u': return String(f.dow || 7)
      case 'a': return f.h < 12 ? 'AM' : 'PM'
      case 'H': return pad(f.h, n)
      case 'k': return pad(f.h || 24, n)
      case 'K': return pad(f.h % 12, n)
      case 'h': return pad(f.h % 12 || 12, n)
      case 'm': return pad(f.mi, n)
      case 's': return pad(f.s, n)
      case 'S': return pad(f.ms, 3).slice(0, Math.max(n, 3)).padEnd(n, '0').slice(0, n)
      case 'z': return zone === 'UTC' || zone === 'GMT' ? zone : 'GMT' + offStr(f.off, true)
      case 'Z': return offStr(f.off, false)
      case 'X': return f.off === 0 ? 'Z' : n === 1 ? offStr(f.off, false).slice(0, 3) : offStr(f.off, n >= 3)
      case 'w': { const jan1 = new Date(Date.UTC(f.y, 0, 1)).getUTCDay(); return pad(Math.floor((f.doy + jan1 - 1) / 7) + 1, n) }
      default: return t.repeat(n)
    }
  }).join('')
}
// parses with the pattern; null when the text does not fit
export function parseDate(pattern: string, text: string, zone: string): number | null {
  let pos = 0
  let y = 1970, mo = 0, d = 1, h = 0, mi = 0, s = 0, ms = 0, pm = -1, off: number | null = null
  const num = (max: number) => { const m = new RegExp(`^[+-]?\\d{1,${max}}`).exec(text.slice(pos)); if (!m) throw 0; pos += m[0].length; return Number(m[0]) }
  const word = (list: string[]) => {
    const rest = text.slice(pos).toLowerCase()
    for (const full of list) for (const w of [full, full.slice(0, 3)]) if (rest.startsWith(w.toLowerCase())) { pos += w.length; return list.indexOf(full) }
    throw 0
  }
  try {
    const toks = tokens(pattern)
    toks.forEach(({ t, n }, k) => {
      // a number right before another number field takes exactly its width
      const next = toks[k + 1]
      const width = next && next.n && /[yMdHhkKmsS]/.test(next.t) ? n : 10
      if (!n) { if (text.startsWith(t, pos)) pos += t.length; else if (t.trim() === '') { /* tolerant */ } else throw 0; return }
      switch (t) {
        case 'y': case 'Y': { const v = num(width === n ? n : 4); y = n <= 2 && v < 100 ? 2000 + v - (v > 68 ? 100 : 0) : v; break }
        case 'M': case 'L': mo = n >= 3 ? word(MONTHS) : num(width === n ? n : 2) - 1; break
        case 'd': d = num(width === n ? n : 2); break
        case 'E': word(DAYS); break
        case 'H': case 'k': h = num(width === n ? n : 2) % 24; break
        case 'h': case 'K': h = num(width === n ? n : 2) % 12; break
        case 'a': pm = word(['AM', 'PM']); break
        case 'm': mi = num(width === n ? n : 2); break
        case 's': s = num(width === n ? n : 2); break
        case 'S': { const st = pos; const v = num(width === n ? n : 9); const digits = pos - st; ms = Math.round(v / 10 ** Math.max(0, digits - 3) * (digits < 3 ? 10 ** (3 - digits) : 1)); break }
        case 'z': case 'Z': case 'X': {
          const rest = text.slice(pos)
          const m = /^(?:Z|(?:GMT|UTC)?([+-])(\d{2}):?(\d{2})?|GMT|UTC)/.exec(rest)
          if (!m) throw 0
          pos += m[0].length
          off = m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0
          break
        }
        default: throw 0
      }
    })
  } catch { return null }
  if (pm === 1 && h < 12) h += 12
  if (off !== null) return Date.UTC(y, mo, d, h, mi, s, ms) - off * 60000
  return fromFields(y, mo, d, h, mi, s, ms, zone)
}

export function registerJavaMore(vm: VM) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => {
    const old = vm.shims.get(name)
    vm.shim(name, { super: old?.super ?? sup, interfaces: [...(old?.interfaces || []), ...(extra.interfaces || [])], methods: { ...(old?.methods || {}), ...methods }, statics: { ...(old?.statics || {}), ...(extra.statics || {}) } })
  }
  const obj = (cls: string, f: Record<string, any> = {}) => { const o = new JObject(vm.cls(cls)); Object.assign(o.f, f); return o }
  const str = (x: any) => (x == null ? null : jstr(vm, x))
  const strArray = (a: string[]) => { const r = vm.newArray('[Ljava/lang/String;', a.length); a.forEach((x, i) => ((r.data as any)[i] = x)); return r }
  const bytes = (a: JArray, off = 0, len = a.data.length - off) => { const d = a.data as Int8Array; return new Uint8Array(d.buffer, d.byteOffset + off, len) }
  const byteArray = (u: Uint8Array) => { const r = vm.newArray('[B', u.length); (r.data as Int8Array).set(new Int8Array(u.buffer, u.byteOffset, u.length)); return r }
  const ex = (cls: string, msg: string) => vm.error(cls, msg)
  const deviceLang = (((globalThis as any).navigator?.language || 'en') as string).slice(0, 2).toLowerCase()
  // java.util.Locale: language / country / variant; the default is the device's
  const NAMES: Record<string, string> = { en: 'English', ru: 'русский', de: 'Deutsch', fr: 'français', es: 'español', it: 'italiano', ja: '日本語', ko: '한국어', zh: '中文', pt: 'português', uk: 'українська', pl: 'polski', tr: 'Türkçe', nl: 'Nederlands' }
  const locale = (lang: string, country = '', variant = '') => obj('Ljava/util/Locale;', { lang: lang.toLowerCase(), country: country.toUpperCase(), variant })
  const deviceCountry = (() => { const m = /-([A-Za-z]{2})$/.exec((globalThis as any).navigator?.language || ''); return m ? m[1].toUpperCase() : deviceLang === 'en' ? 'US' : '' })()
  let defaultLocale: JObject | null = null
  const localeStr = (s: JObject) => [s.f.lang, s.f.country, s.f.variant].filter((x, i) => x || i === 0).join('_').replace(/_+$/, '')
  def('Ljava/util/Locale;', OBJ, {
    '<init>(Ljava/lang/String;)V': (v, s, [l]) => { Object.assign(s.f, { lang: String(l).toLowerCase(), country: '', variant: '' }) },
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [l, c]) => { Object.assign(s.f, { lang: String(l).toLowerCase(), country: String(c).toUpperCase(), variant: '' }) },
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (v, s, [l, c, x]) => { Object.assign(s.f, { lang: String(l).toLowerCase(), country: String(c).toUpperCase(), variant: String(x) }) },
    'getDefault()Ljava/util/Locale;': () => (defaultLocale ??= locale(deviceLang || 'en', deviceCountry)),
    'setDefault(Ljava/util/Locale;)V': (v, s, [l]) => { defaultLocale = l },
    'getLanguage()Ljava/lang/String;': (v, s) => s.f.lang, 'getCountry()Ljava/lang/String;': (v, s) => s.f.country, 'getVariant()Ljava/lang/String;': (v, s) => s.f.variant,
    'getISO3Language()Ljava/lang/String;': (v, s) => ({ en: 'eng', ru: 'rus', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', ja: 'jpn', zh: 'zho', pt: 'por', uk: 'ukr' } as Record<string, string>)[s.f.lang] ?? s.f.lang,
    'getISO3Country()Ljava/lang/String;': (v, s) => ({ US: 'USA', GB: 'GBR', RU: 'RUS', DE: 'DEU', FR: 'FRA', UA: 'UKR' } as Record<string, string>)[s.f.country] ?? s.f.country,
    'getDisplayLanguage()Ljava/lang/String;': (v, s) => NAMES[s.f.lang] ?? s.f.lang,
    'getDisplayLanguage(Ljava/util/Locale;)Ljava/lang/String;': (v, s) => NAMES[s.f.lang] ?? s.f.lang,
    'getDisplayCountry()Ljava/lang/String;': (v, s) => s.f.country, 'getDisplayName()Ljava/lang/String;': (v, s) => NAMES[s.f.lang] ?? localeStr(s),
    'toString()Ljava/lang/String;': (v, s) => localeStr(s),
    'toLanguageTag()Ljava/lang/String;': (v, s) => [s.f.lang, s.f.country].filter(Boolean).join('-'),
    'hashCode()I': (v, s) => [...localeStr(s)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o instanceof JObject && o.f.lang === s.f.lang && o.f.country === s.f.country && o.f.variant === s.f.variant ? 1 : 0),
    'getAvailableLocales()[Ljava/util/Locale;': () => { const a = vm.newArray('[Ljava/util/Locale;', 2); a.data[0] = locale('en', 'US'); a.data[1] = locale(deviceLang || 'en', deviceCountry); return a },
  })
  const lc = vm.cls('Ljava/util/Locale;')
  Object.assign(lc.staticValues, { ENGLISH: locale('en'), US: locale('en', 'US'), UK: locale('en', 'GB'), ROOT: locale(''), GERMAN: locale('de'), GERMANY: locale('de', 'DE'), FRENCH: locale('fr'), FRANCE: locale('fr', 'FR'), ITALIAN: locale('it'), JAPANESE: locale('ja'), JAPAN: locale('ja', 'JP'), KOREAN: locale('ko'), CHINESE: locale('zh'), CHINA: locale('zh', 'CN'), CANADA: locale('en', 'CA') })

  // java.util.UUID: two 64-bit halves
  const uuid = (hi: bigint, lo: bigint) => obj('Ljava/util/UUID;', { hi: BigInt.asIntN(64, hi), lo: BigInt.asIntN(64, lo) })
  const u64 = (b: Uint8Array, o: number) => Array.from(b.slice(o, o + 8)).reduce((x: bigint, y: number) => (x << 8n) | BigInt(y), 0n)
  const uuidStr = (s: JObject) => { const h = (BigInt.asUintN(64, s.f.hi).toString(16).padStart(16, '0') + BigInt.asUintN(64, s.f.lo).toString(16).padStart(16, '0')); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` }
  def('Ljava/util/UUID;', OBJ, {
    '<init>(JJ)V': (v, s, [hi, lo]) => { s.f.hi = BigInt.asIntN(64, hi); s.f.lo = BigInt.asIntN(64, lo) },
    'randomUUID()Ljava/util/UUID;': () => {
      const b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80 // version 4, ietf variant
      return uuid(u64(b, 0), u64(b, 8))
    },
    'nameUUIDFromBytes([B)Ljava/util/UUID;': (v, s, [arr]) => {
      // version 3 wants md5; a sha-256 based stand-in keeps names stable on this device
      const src = new Uint8Array(arr.data.buffer, arr.data.byteOffset, arr.data.length)
      let h1 = 0x811c9dc5n, h2 = 0xcbf29ce484222325n
      for (const x of src) { h1 = BigInt.asUintN(64, (h1 ^ BigInt(x)) * 0x100000001b3n); h2 = BigInt.asUintN(64, (h2 ^ BigInt(x)) * 0x100000001b3n + 7n) }
      const hi = (h1 & ~0xf000n) | 0x3000n, lo = (h2 & 0x3fffffffffffffffn) | 0x8000000000000000n
      return uuid(hi, lo)
    },
    'fromString(Ljava/lang/String;)Ljava/util/UUID;': (v, s, [str]) => {
      const h = String(str).replace(/-/g, '')
      if (!/^[0-9a-fA-F]{32}$/.test(h)) throw vm.error('Ljava/lang/IllegalArgumentException;', 'Invalid UUID string: ' + str)
      return uuid(BigInt('0x' + h.slice(0, 16)), BigInt('0x' + h.slice(16)))
    },
    'toString()Ljava/lang/String;': (v, s) => uuidStr(s),
    'getMostSignificantBits()J': (v, s) => s.f.hi, 'getLeastSignificantBits()J': (v, s) => s.f.lo,
    'version()I': (v, s) => Number((BigInt.asUintN(64, s.f.hi) >> 12n) & 0xfn),
    'hashCode()I': (v, s) => { const x = BigInt.asUintN(64, BigInt(s.f.hi) ^ BigInt(s.f.lo)); return Number(BigInt.asIntN(32, (x >> 32n) ^ x)) },
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o instanceof JObject && o.f.hi === s.f.hi && o.f.lo === s.f.lo ? 1 : 0),
    'compareTo(Ljava/util/UUID;)I': (v, s, [o]) => (s.f.hi !== o.f.hi ? (s.f.hi < o.f.hi ? -1 : 1) : s.f.lo !== o.f.lo ? (s.f.lo < o.f.lo ? -1 : 1) : 0),
  })

  for (const [e, sup] of [['Ljava/util/regex/PatternSyntaxException;', 'Ljava/lang/IllegalArgumentException;'], ['Ljava/text/ParseException;', 'Ljava/lang/Exception;'], ['Ljava/security/NoSuchAlgorithmException;', 'Ljava/security/GeneralSecurityException;'], ['Ljava/security/GeneralSecurityException;', 'Ljava/lang/Exception;'], ['Ljava/io/UnsupportedEncodingException;', 'Ljava/io/IOException;']] as const)
    if (!vm.shims.has(e)) def(e, sup, { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m }, '<init>()V': () => {}, '<init>(Ljava/lang/String;I)V': (v, s, [m]) => { s.f.message = m } })
  const compile = (re: string, flags = 0) => { try { return javaRegex(re, flags) } catch (e) { throw ex('Ljava/util/regex/PatternSyntaxException;', `${(e as Error).message}: ${re}`) } }

  // ---------- String's regex methods and other gaps ----------
  // java's split: a zero-width match at the start makes no leading empty string; limit > 0 caps the
  // parts; limit 0 drops trailing empty strings (all of them, so ",".split(",") is empty)
  const javaSplit = (s: string, re: string, limit: number) => {
    const base = compile(re), r = new RegExp(base.source, base.flags + 'g')
    const parts: string[] = []
    let last = 0, found = false
    while (limit <= 0 || parts.length < limit - 1) {
      const m = r.exec(s)
      if (!m) break
      if (m[0] === '') { r.lastIndex++; if (m.index === 0 || m.index >= s.length) continue }
      found = true
      parts.push(s.slice(last, m.index))
      last = m.index + m[0].length
    }
    if (!found) return [s]
    parts.push(s.slice(last))
    if (limit === 0) while (parts.length && parts[parts.length - 1] === '') parts.pop()
    return parts
  }
  const S = (fn: (s: string, a: any[]) => any): NativeFn => (v, s, a) => fn(String(s), a)
  def('Ljava/lang/String;', OBJ, {
    'matches(Ljava/lang/String;)Z': S((s, [re]) => { const r = compile(String(re)); const m = new RegExp(`^(?:${r.source})$`, r.flags).exec(s); return m ? 1 : 0 }),
    'replaceAll(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': S((s, [re, rep]) => s.replace(new RegExp(compile(String(re)).source, compile(String(re)).flags + 'g'), javaReplacement(String(rep)))),
    'replaceFirst(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': S((s, [re, rep]) => s.replace(compile(String(re)), javaReplacement(String(rep)))),
    'split(Ljava/lang/String;I)[Ljava/lang/String;': S((s, [re, limit]) => strArray(javaSplit(s, String(re), limit))),
    'split(Ljava/lang/String;)[Ljava/lang/String;': S((s, [re]) => strArray(javaSplit(s, String(re), 0))),
    'indexOf(Ljava/lang/String;I)I': S((s, [x, from]) => s.indexOf(String(x), Math.max(0, from))),
    'lastIndexOf(Ljava/lang/String;I)I': S((s, [x, from]) => (from < 0 ? -1 : s.lastIndexOf(String(x), from))),
    'regionMatches(ILjava/lang/String;II)Z': S((s, [to, o, oo, len]) => (to >= 0 && oo >= 0 && to + len <= s.length && oo + len <= String(o).length && s.substr(to, len) === String(o).substr(oo, len) ? 1 : 0)),
    'regionMatches(ZILjava/lang/String;II)Z': S((s, [ic, to, o, oo, len]) => {
      if (to < 0 || oo < 0 || to + len > s.length || oo + len > String(o).length) return 0
      const a = s.substr(to, len), b = String(o).substr(oo, len)
      return (ic ? a.toLowerCase() === b.toLowerCase() : a === b) ? 1 : 0
    }),
  })
  // StringBuilder / StringBuffer extras (the text is in f.s)
  for (const n of ['Ljava/lang/StringBuilder;', 'Ljava/lang/StringBuffer;']) def(n, OBJ, {
    [`append(Ljava/lang/CharSequence;II)${n}`]: (v, s, [x, a, b]) => { s.f.s += (x == null ? 'null' : jstr(vm, x)).slice(a, b); return s },
    [`append([CII)${n}`]: (v, s, [arr, off, len]) => { s.f.s += String.fromCharCode(...(arr.data as Uint16Array).subarray(off, off + len)); return s },
    'indexOf(Ljava/lang/String;I)I': (v, s, [x, from]) => s.f.s.indexOf(String(x), Math.max(0, from)),
    'lastIndexOf(Ljava/lang/String;I)I': (v, s, [x, from]) => s.f.s.lastIndexOf(String(x), from),
    'getChars(II[CI)V': (v, s, [a, b, dst, at]) => { for (let i = a; i < b; i++) (dst.data as Uint16Array)[at + i - a] = s.f.s.charCodeAt(i) },
  })
  def('Ljava/util/Vector;', 'Ljava/util/AbstractList;', { 'copyInto([Ljava/lang/Object;)V': (v, s, [arr]) => { s.f.a.forEach((x: any, i: number) => ((arr.data as any)[i] = x)) } })

  // ---------- java.util.regex ----------
  def('Ljava/util/regex/Pattern;', OBJ, {
    'compile(Ljava/lang/String;)Ljava/util/regex/Pattern;': (v, s, [re]) => obj('Ljava/util/regex/Pattern;', { src: String(re), flags: 0, re: compile(String(re)) }),
    'compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;': (v, s, [re, fl]) => obj('Ljava/util/regex/Pattern;', { src: String(re), flags: fl, re: compile(String(re), fl) }),
    'matches(Ljava/lang/String;Ljava/lang/CharSequence;)Z': (v, s, [re, x]) => { const r = compile(String(re)); return new RegExp(`^(?:${r.source})$`, r.flags).test(jstr(vm, x)) ? 1 : 0 },
    'quote(Ljava/lang/String;)Ljava/lang/String;': (v, s, [x]) => `\\Q${x}\\E`,
    'pattern()Ljava/lang/String;': (v, s) => s.f.src, 'toString()Ljava/lang/String;': (v, s) => s.f.src, 'flags()I': (v, s) => s.f.flags,
    'matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;': (v, s, [x]) => obj('Ljava/util/regex/Matcher;', { p: s, text: jstr(vm, x), pos: 0, m: null, appendPos: 0 }),
    'split(Ljava/lang/CharSequence;)[Ljava/lang/String;': (v, s, [x]) => vm.callVirtual(jstr(vm, x), 'split(Ljava/lang/String;I)[Ljava/lang/String;', [s.f.src, 0]),
    'split(Ljava/lang/CharSequence;I)[Ljava/lang/String;': (v, s, [x, lim]) => vm.callVirtual(jstr(vm, x), 'split(Ljava/lang/String;I)[Ljava/lang/String;', [s.f.src, lim]),
  }, { statics: { UNIX_LINES: 1, CASE_INSENSITIVE: 2, COMMENTS: 4, MULTILINE: 8, LITERAL: 16, DOTALL: 32, UNICODE_CASE: 64, CANON_EQ: 128, UNICODE_CHARACTER_CLASS: 256 } })
  const pre = (s: JObject): RegExp => s.f.p.f.re
  const need = (s: JObject) => { if (!s.f.m) throw ex('Ljava/lang/IllegalStateException;', 'No match found'); return s.f.m as RegExpExecArray }
  const run = (s: JObject, from: number, sticky: boolean, whole: boolean) => {
    const r = new RegExp(whole ? `^(?:${pre(s).source})$` : pre(s).source, pre(s).flags + (sticky ? 'y' : 'g'))
    r.lastIndex = from
    const m = r.exec(s.f.text)
    s.f.m = m
    if (m) s.f.pos = m.index + m[0].length + (m[0] === '' ? 1 : 0)
    return m ? 1 : 0
  }
  const groupIdx = (m: RegExpExecArray, g: number) => { if (g < 0 || g >= m.length) throw ex('Ljava/lang/IndexOutOfBoundsException;', 'No group ' + g); return m[g] ?? null }
  // start / end of group g: js gives only the match's index; groups are found inside the match text
  const groupStart = (m: RegExpExecArray, g: number) => { if (g === 0) return m.index; const x = m[g]; if (x == null) return -1; const i = m[0].indexOf(x); return i < 0 ? -1 : m.index + i }
  const replaceIn = (s: JObject, rep: string, all: boolean) => s.f.text.replace(new RegExp(pre(s).source, pre(s).flags + (all ? 'g' : '')), javaReplacement(rep))
  def('Ljava/util/regex/Matcher;', OBJ, {
    'find()Z': (v, s) => (s.f.pos > s.f.text.length ? 0 : run(s, s.f.pos, false, false)),
    'find(I)Z': (v, s, [from]) => run(s, from, false, false),
    'matches()Z': (v, s) => run(s, 0, true, true),
    'lookingAt()Z': (v, s) => run(s, 0, true, false),
    'group()Ljava/lang/String;': (v, s) => need(s)[0],
    'group(I)Ljava/lang/String;': (v, s, [g]) => groupIdx(need(s), g),
    'group(Ljava/lang/String;)Ljava/lang/String;': (v, s, [n]) => need(s).groups?.[String(n)] ?? null,
    'groupCount()I': (v, s) => new RegExp(pre(s).source + '|', pre(s).flags).exec('')!.length - 1,
    'start()I': (v, s) => need(s).index, 'end()I': (v, s) => need(s).index + need(s)[0].length,
    'start(I)I': (v, s, [g]) => groupStart(need(s), g),
    'end(I)I': (v, s, [g]) => { const m = need(s); const st = groupStart(m, g); return st < 0 ? -1 : st + (m[g] ?? '').length },
    'reset()Ljava/util/regex/Matcher;': (v, s) => { s.f.pos = 0; s.f.m = null; s.f.appendPos = 0; return s },
    'reset(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;': (v, s, [x]) => { s.f.text = jstr(vm, x); s.f.pos = 0; s.f.m = null; s.f.appendPos = 0; return s },
    'replaceAll(Ljava/lang/String;)Ljava/lang/String;': (v, s, [rep]) => replaceIn(s, String(rep), true),
    'replaceFirst(Ljava/lang/String;)Ljava/lang/String;': (v, s, [rep]) => replaceIn(s, String(rep), false),
    'hitEnd()Z': (v, s) => (s.f.pos >= s.f.text.length ? 1 : 0),
    'pattern()Ljava/util/regex/Pattern;': (v, s) => s.f.p,
    'usePattern(Ljava/util/regex/Pattern;)Ljava/util/regex/Matcher;': (v, s, [p]) => { s.f.p = p; return s },
    'appendReplacement(Ljava/lang/StringBuffer;Ljava/lang/String;)Ljava/util/regex/Matcher;': (v, s, [sb, rep]) => appendRep(s, sb, String(rep)),
    'appendReplacement(Ljava/lang/StringBuilder;Ljava/lang/String;)Ljava/util/regex/Matcher;': (v, s, [sb, rep]) => appendRep(s, sb, String(rep)),
    'appendTail(Ljava/lang/StringBuffer;)Ljava/lang/StringBuffer;': (v, s, [sb]) => { sb.f.s += s.f.text.slice(s.f.appendPos); return sb },
    'appendTail(Ljava/lang/StringBuilder;)Ljava/lang/StringBuilder;': (v, s, [sb]) => { sb.f.s += s.f.text.slice(s.f.appendPos); return sb },
  })
  const appendRep = (s: JObject, sb: JObject, rep: string) => {
    const m = need(s)
    sb.f.s += s.f.text.slice(s.f.appendPos, m.index) + m[0].replace(new RegExp(pre(s).source, pre(s).flags), javaReplacement(rep))
    s.f.appendPos = m.index + m[0].length
    return s
  }

  // ---------- dates ----------
  const now = () => BigInt(Date.now())
  const ms = (x: any) => Number(x)
  def('Ljava/util/Date;', OBJ, {
    '<init>()V': (v, s) => { s.f.t = now() },
    '<init>(J)V': (v, s, [t]) => { s.f.t = BigInt(t) },
    '<init>(III)V': (v, s, [y, mo, d]) => { s.f.t = BigInt(fromFields(1900 + y, mo, d, 0, 0, 0, 0, defaultZone())) },
    '<init>(IIIII)V': (v, s, [y, mo, d, h, mi]) => { s.f.t = BigInt(fromFields(1900 + y, mo, d, h, mi, 0, 0, defaultZone())) },
    '<init>(IIIIII)V': (v, s, [y, mo, d, h, mi, se]) => { s.f.t = BigInt(fromFields(1900 + y, mo, d, h, mi, se, 0, defaultZone())) },
    'getTime()J': (v, s) => s.f.t, 'setTime(J)V': (v, s, [t]) => { s.f.t = BigInt(t) },
    'before(Ljava/util/Date;)Z': (v, s, [o]) => (s.f.t < o.f.t ? 1 : 0), 'after(Ljava/util/Date;)Z': (v, s, [o]) => (s.f.t > o.f.t ? 1 : 0),
    'compareTo(Ljava/util/Date;)I': (v, s, [o]) => (s.f.t < o.f.t ? -1 : s.f.t > o.f.t ? 1 : 0),
    'compareTo(Ljava/lang/Object;)I': (v, s, [o]) => (s.f.t < o.f.t ? -1 : s.f.t > o.f.t ? 1 : 0),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o instanceof JObject && o.f.t === s.f.t ? 1 : 0),
    'hashCode()I': (v, s) => Number(BigInt.asIntN(32, s.f.t ^ (s.f.t >> 32n))),
    'toString()Ljava/lang/String;': (v, s) => formatDate('EEE MMM dd HH:mm:ss z yyyy', ms(s.f.t), defaultZone()),
    'getYear()I': (v, s) => fields(ms(s.f.t), defaultZone()).y - 1900, 'getMonth()I': (v, s) => fields(ms(s.f.t), defaultZone()).mo,
    'getDate()I': (v, s) => fields(ms(s.f.t), defaultZone()).d, 'getDay()I': (v, s) => fields(ms(s.f.t), defaultZone()).dow,
    'getHours()I': (v, s) => fields(ms(s.f.t), defaultZone()).h, 'getMinutes()I': (v, s) => fields(ms(s.f.t), defaultZone()).mi,
    'getSeconds()I': (v, s) => fields(ms(s.f.t), defaultZone()).s, 'getTimezoneOffset()I': (v, s) => -fields(ms(s.f.t), defaultZone()).off,
    'clone()Ljava/lang/Object;': (v, s) => obj('Ljava/util/Date;', { t: s.f.t }),
  }, { interfaces: ['Ljava/lang/Comparable;', 'Ljava/lang/Cloneable;', 'Ljava/io/Serializable;'] })
  const date = (t: number | bigint) => obj('Ljava/util/Date;', { t: BigInt(t) })

  const zone = (id: string) => obj('Ljava/util/TimeZone;', { id })
  def('Ljava/util/TimeZone;', OBJ, {
    'getDefault()Ljava/util/TimeZone;': () => zone(defaultZone()),
    'getTimeZone(Ljava/lang/String;)Ljava/util/TimeZone;': (v, s, [id]) => { const z = String(id); try { if (z !== 'UTC' && z !== 'GMT' && !/^(GMT|UTC)?[+-]/.test(z)) new Intl.DateTimeFormat('en-US', { timeZone: z }) ; return zone(z) } catch { return zone('GMT') } },
    'setDefault(Ljava/util/TimeZone;)V': () => {},
    'getID()Ljava/lang/String;': (v, s) => s.f.id, 'getDisplayName()Ljava/lang/String;': (v, s) => s.f.id,
    'getRawOffset()I': (v, s) => zoneOffset(s.f.id, Date.UTC(new Date().getUTCFullYear(), 0, 1)) * 60000,
    'getOffset(J)I': (v, s, [t]) => zoneOffset(s.f.id, Number(t)) * 60000,
    'inDaylightTime(Ljava/util/Date;)Z': (v, s, [d]) => (zoneOffset(s.f.id, ms(d.f.t)) !== zoneOffset(s.f.id, Date.UTC(new Date(ms(d.f.t)).getUTCFullYear(), 0, 1)) ? 1 : 0),
    'useDaylightTime()Z': () => 1,
    'getAvailableIDs()[Ljava/lang/String;': () => strArray(['UTC', 'GMT', defaultZone()]),
  })

  // Calendar (a gregorian one): millis + zone; fields computed when asked
  const CAL = 'Ljava/util/Calendar;', GREG = 'Ljava/util/GregorianCalendar;'
  const calNew = (t = Date.now(), z = defaultZone()) => obj(GREG, { t, zone: z, lenient: true, firstDay: 1 })
  const calGet = (s: JObject, f: number) => {
    const x = fields(s.f.t, s.f.zone)
    switch (f) {
      case 0: return x.y > 0 ? 1 : 0
      case 1: return x.y
      case 2: return x.mo
      case 3: { const jan1 = new Date(Date.UTC(x.y, 0, 1)).getUTCDay(); return Math.floor((x.doy + jan1 - 1) / 7) + 1 }
      case 4: { const first = new Date(Date.UTC(x.y, x.mo, 1)).getUTCDay(); return Math.floor((x.d + first - 1) / 7) + 1 }
      case 5: return x.d
      case 6: return x.doy
      case 7: return x.dow + 1
      case 8: return Math.floor((x.d - 1) / 7) + 1
      case 9: return x.h < 12 ? 0 : 1
      case 10: return x.h % 12
      case 11: return x.h
      case 12: return x.mi
      case 13: return x.s
      case 14: return x.ms
      case 15: return zoneOffset(s.f.zone, Date.UTC(x.y, 0, 1)) * 60000
      case 16: return (x.off - zoneOffset(s.f.zone, Date.UTC(x.y, 0, 1))) * 60000
      default: return 0
    }
  }
  const calSet = (s: JObject, f: number, val: number) => {
    const x = fields(s.f.t, s.f.zone)
    const p = { y: x.y, mo: x.mo, d: x.d, h: x.h, mi: x.mi, s: x.s, ms: x.ms }
    switch (f) {
      case 1: p.y = val; break
      case 2: p.mo = val; break
      case 5: p.d = val; break
      case 6: p.mo = 0; p.d = val; break
      case 7: p.d += val - 1 - x.dow; break
      case 9: p.h = (p.h % 12) + (val ? 12 : 0); break
      case 10: p.h = (p.h >= 12 ? 12 : 0) + val; break
      case 11: p.h = val; break
      case 12: p.mi = val; break
      case 13: p.s = val; break
      case 14: p.ms = val; break
      default: return
    }
    s.f.t = fromFields(p.y, p.mo, p.d, p.h, p.mi, p.s, p.ms, s.f.zone)
  }
  const calAdd = (s: JObject, f: number, n: number) => {
    if (f === 1 || f === 2) {
      const x = fields(s.f.t, s.f.zone)
      const total = x.y * 12 + x.mo + (f === 1 ? n * 12 : n), y = Math.floor(total / 12), mo = total - y * 12
      const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
      s.f.t = fromFields(y, mo, Math.min(x.d, dim), x.h, x.mi, x.s, x.ms, s.f.zone)
      return
    }
    const unit: Record<number, number> = { 3: 7 * 86400000, 4: 7 * 86400000, 5: 86400000, 6: 86400000, 7: 86400000, 8: 7 * 86400000, 10: 3600000, 11: 3600000, 12: 60000, 13: 1000, 14: 1 }
    if (f === 5 || f === 6 || f === 7 || f === 3 || f === 4 || f === 8) { // calendar days keep the wall clock time across dst
      const x = fields(s.f.t, s.f.zone)
      s.f.t = fromFields(x.y, x.mo, x.d + n * (unit[f] / 86400000), x.h, x.mi, x.s, x.ms, s.f.zone)
    } else s.f.t += n * (unit[f] ?? 0)
  }
  const calMethods: Record<string, NativeFn> = {
    '<init>()V': (v, s) => { Object.assign(s.f, { t: Date.now(), zone: defaultZone(), lenient: true, firstDay: 1 }) },
    '<init>(III)V': (v, s, [y, mo, d]) => { Object.assign(s.f, { zone: defaultZone(), lenient: true, firstDay: 1 }); s.f.t = fromFields(y, mo, d, 0, 0, 0, 0, s.f.zone) },
    '<init>(IIIII)V': (v, s, [y, mo, d, h, mi]) => { Object.assign(s.f, { zone: defaultZone(), lenient: true, firstDay: 1 }); s.f.t = fromFields(y, mo, d, h, mi, 0, 0, s.f.zone) },
    '<init>(IIIIII)V': (v, s, [y, mo, d, h, mi, se]) => { Object.assign(s.f, { zone: defaultZone(), lenient: true, firstDay: 1 }); s.f.t = fromFields(y, mo, d, h, mi, se, 0, s.f.zone) },
    '<init>(Ljava/util/TimeZone;)V': (v, s, [z]) => { Object.assign(s.f, { t: Date.now(), zone: z?.f.id ?? defaultZone(), lenient: true, firstDay: 1 }) },
    'getInstance()Ljava/util/Calendar;': () => calNew(),
    'getInstance(Ljava/util/TimeZone;)Ljava/util/Calendar;': (v, s, [z]) => calNew(Date.now(), z?.f.id ?? defaultZone()),
    'getInstance(Ljava/util/Locale;)Ljava/util/Calendar;': () => calNew(),
    'getInstance(Ljava/util/TimeZone;Ljava/util/Locale;)Ljava/util/Calendar;': (v, s, [z]) => calNew(Date.now(), z?.f.id ?? defaultZone()),
    'get(I)I': (v, s, [f]) => calGet(s, f),
    'set(II)V': (v, s, [f, x]) => calSet(s, f, x),
    'set(III)V': (v, s, [y, mo, d]) => { const x = fields(s.f.t, s.f.zone); s.f.t = fromFields(y, mo, d, x.h, x.mi, x.s, x.ms, s.f.zone) },
    'set(IIIII)V': (v, s, [y, mo, d, h, mi]) => { const x = fields(s.f.t, s.f.zone); s.f.t = fromFields(y, mo, d, h, mi, x.s, x.ms, s.f.zone) },
    'set(IIIIII)V': (v, s, [y, mo, d, h, mi, se]) => { const x = fields(s.f.t, s.f.zone); s.f.t = fromFields(y, mo, d, h, mi, se, x.ms, s.f.zone) },
    'add(II)V': (v, s, [f, n]) => calAdd(s, f, n),
    'roll(II)V': (v, s, [f, n]) => calAdd(s, f, n),
    'getTime()Ljava/util/Date;': (v, s) => date(s.f.t),
    'setTime(Ljava/util/Date;)V': (v, s, [d]) => { s.f.t = ms(d.f.t) },
    'getTimeInMillis()J': (v, s) => BigInt(s.f.t),
    'setTimeInMillis(J)V': (v, s, [t]) => { s.f.t = Number(t) },
    'getTimeZone()Ljava/util/TimeZone;': (v, s) => zone(s.f.zone),
    'setTimeZone(Ljava/util/TimeZone;)V': (v, s, [z]) => { s.f.zone = z?.f.id ?? defaultZone() },
    'clear()V': (v, s) => { s.f.t = fromFields(1970, 0, 1, 0, 0, 0, 0, s.f.zone) },
    'clear(I)V': (v, s, [f]) => calSet(s, f, f === 5 ? 1 : 0),
    'getActualMaximum(I)I': (v, s, [f]) => { const x = fields(s.f.t, s.f.zone); return f === 5 ? new Date(Date.UTC(x.y, x.mo + 1, 0)).getUTCDate() : f === 6 ? (new Date(Date.UTC(x.y, 1, 29)).getUTCMonth() === 1 ? 366 : 365) : f === 2 ? 11 : f === 11 ? 23 : f === 12 || f === 13 ? 59 : f === 7 ? 7 : 0 },
    'getActualMinimum(I)I': (v, s, [f]) => (f === 5 || f === 6 || f === 7 ? 1 : 0),
    'getMaximum(I)I': (v, s, [f]) => ({ 2: 11, 5: 31, 6: 366, 7: 7, 11: 23, 12: 59, 13: 59, 14: 999 } as Record<number, number>)[f] ?? 0,
    'getMinimum(I)I': (v, s, [f]) => (f === 5 || f === 6 || f === 7 ? 1 : 0),
    'getFirstDayOfWeek()I': (v, s) => s.f.firstDay, 'setFirstDayOfWeek(I)V': (v, s, [d]) => { s.f.firstDay = d },
    'setLenient(Z)V': (v, s, [l]) => { s.f.lenient = !!l }, 'isLenient()Z': (v, s) => (s.f.lenient ? 1 : 0),
    'before(Ljava/lang/Object;)Z': (v, s, [o]) => (o?.f?.t !== undefined && s.f.t < o.f.t ? 1 : 0),
    'after(Ljava/lang/Object;)Z': (v, s, [o]) => (o?.f?.t !== undefined && s.f.t > o.f.t ? 1 : 0),
    'compareTo(Ljava/util/Calendar;)I': (v, s, [o]) => Math.sign(s.f.t - o.f.t),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o instanceof JObject && o.f.t === s.f.t && o.f.zone === s.f.zone ? 1 : 0),
    'hashCode()I': (v, s) => s.f.t | 0,
    'clone()Ljava/lang/Object;': (v, s) => obj(GREG, { ...s.f }),
    'isLeapYear(I)Z': (v, s, [y]) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 1 : 0),
    'toString()Ljava/lang/String;': (v, s) => `java.util.GregorianCalendar[time=${s.f.t},zone=${s.f.zone}]`,
  }
  const calStatics = { ERA: 0, YEAR: 1, MONTH: 2, WEEK_OF_YEAR: 3, WEEK_OF_MONTH: 4, DATE: 5, DAY_OF_MONTH: 5, DAY_OF_YEAR: 6, DAY_OF_WEEK: 7, DAY_OF_WEEK_IN_MONTH: 8, AM_PM: 9, HOUR: 10, HOUR_OF_DAY: 11, MINUTE: 12, SECOND: 13, MILLISECOND: 14, ZONE_OFFSET: 15, DST_OFFSET: 16,
    SUNDAY: 1, MONDAY: 2, TUESDAY: 3, WEDNESDAY: 4, THURSDAY: 5, FRIDAY: 6, SATURDAY: 7, JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5, JULY: 6, AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11, AM: 0, PM: 1, SHORT: 1, LONG: 2, ALL_STYLES: 0 }
  def(CAL, OBJ, calMethods, { statics: calStatics, interfaces: ['Ljava/lang/Cloneable;', 'Ljava/io/Serializable;', 'Ljava/lang/Comparable;'] })
  def(GREG, CAL, calMethods, { statics: { ...calStatics, BC: 0, AD: 1 } })

  // SimpleDateFormat / DateFormat
  const SDF = 'Ljava/text/SimpleDateFormat;', DF = 'Ljava/text/DateFormat;'
  const sdf = (pattern: string) => obj(SDF, { pattern, zone: defaultZone(), lenient: true })
  const STYLE_DATE = ['EEEE, MMMM d, yyyy', 'MMMM d, yyyy', 'MMM d, yyyy', 'M/d/yy'], STYLE_TIME = ['h:mm:ss a z', 'h:mm:ss a z', 'h:mm:ss a', 'h:mm a']
  const parse = (s: JObject, text: string) => {
    const t = parseDate(s.f.pattern, text, s.f.zone)
    if (t === null || Number.isNaN(t)) throw ex('Ljava/text/ParseException;', `Unparseable date: "${text}"`)
    return date(t)
  }
  const dfMethods: Record<string, NativeFn> = {
    '<init>()V': (v, s) => { Object.assign(s.f, { pattern: 'M/d/yy h:mm a', zone: defaultZone(), lenient: true }) },
    '<init>(Ljava/lang/String;)V': (v, s, [p]) => { Object.assign(s.f, { pattern: String(p), zone: defaultZone(), lenient: true }) },
    '<init>(Ljava/lang/String;Ljava/util/Locale;)V': (v, s, [p]) => { Object.assign(s.f, { pattern: String(p), zone: defaultZone(), lenient: true }) },
    'format(Ljava/util/Date;)Ljava/lang/String;': (v, s, [d]) => formatDate(s.f.pattern, ms(d.f.t), s.f.zone),
    'format(Ljava/lang/Object;)Ljava/lang/String;': (v, s, [d]) => formatDate(s.f.pattern, typeof d === 'bigint' || typeof d === 'number' ? Number(d) : d?.f?.t !== undefined ? ms(d.f.t) : Number(d?.f?.v ?? 0), s.f.zone),
    'parse(Ljava/lang/String;)Ljava/util/Date;': (v, s, [t]) => parse(s, String(t)),
    'setTimeZone(Ljava/util/TimeZone;)V': (v, s, [z]) => { s.f.zone = z?.f.id ?? defaultZone() },
    'getTimeZone()Ljava/util/TimeZone;': (v, s) => zone(s.f.zone),
    'setLenient(Z)V': (v, s, [l]) => { s.f.lenient = !!l }, 'isLenient()Z': (v, s) => (s.f.lenient ? 1 : 0),
    'toPattern()Ljava/lang/String;': (v, s) => s.f.pattern, 'applyPattern(Ljava/lang/String;)V': (v, s, [p]) => { s.f.pattern = String(p) },
    'toLocalizedPattern()Ljava/lang/String;': (v, s) => s.f.pattern,
    'getDateInstance()Ljava/text/DateFormat;': () => sdf(STYLE_DATE[2]),
    'getDateInstance(I)Ljava/text/DateFormat;': (v, s, [st]) => sdf(STYLE_DATE[st] ?? STYLE_DATE[2]),
    'getDateInstance(ILjava/util/Locale;)Ljava/text/DateFormat;': (v, s, [st]) => sdf(STYLE_DATE[st] ?? STYLE_DATE[2]),
    'getTimeInstance()Ljava/text/DateFormat;': () => sdf(STYLE_TIME[2]),
    'getTimeInstance(I)Ljava/text/DateFormat;': (v, s, [st]) => sdf(STYLE_TIME[st] ?? STYLE_TIME[2]),
    'getTimeInstance(ILjava/util/Locale;)Ljava/text/DateFormat;': (v, s, [st]) => sdf(STYLE_TIME[st] ?? STYLE_TIME[2]),
    'getDateTimeInstance()Ljava/text/DateFormat;': () => sdf(`${STYLE_DATE[2]} ${STYLE_TIME[2]}`),
    'getDateTimeInstance(II)Ljava/text/DateFormat;': (v, s, [a, b]) => sdf(`${STYLE_DATE[a] ?? STYLE_DATE[2]} ${STYLE_TIME[b] ?? STYLE_TIME[2]}`),
    'getDateTimeInstance(IILjava/util/Locale;)Ljava/text/DateFormat;': (v, s, [a, b]) => sdf(`${STYLE_DATE[a] ?? STYLE_DATE[2]} ${STYLE_TIME[b] ?? STYLE_TIME[2]}`),
    'getInstance()Ljava/text/DateFormat;': () => sdf(`${STYLE_DATE[3]} ${STYLE_TIME[3]}`),
  }
  const dfStatics = { FULL: 0, LONG: 1, MEDIUM: 2, SHORT: 3, DEFAULT: 2 }
  def('Ljava/text/Format;', OBJ, {})
  def(DF, 'Ljava/text/Format;', dfMethods, { statics: dfStatics })
  def(SDF, DF, dfMethods, { statics: dfStatics })
  // android.text.format.DateFormat (helpers on top)
  def('Landroid/text/format/DateFormat;', OBJ, {
    'getTimeFormat(Landroid/content/Context;)Ljava/text/DateFormat;': () => sdf('h:mm a'),
    'getDateFormat(Landroid/content/Context;)Ljava/text/DateFormat;': () => sdf('M/d/yyyy'),
    'getMediumDateFormat(Landroid/content/Context;)Ljava/text/DateFormat;': () => sdf('MMM d, yyyy'),
    'getLongDateFormat(Landroid/content/Context;)Ljava/text/DateFormat;': () => sdf('MMMM d, yyyy'),
    'is24HourFormat(Landroid/content/Context;)Z': () => { try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 ? 0 : 1 } catch { return 0 } },
    'format(Ljava/lang/CharSequence;J)Ljava/lang/CharSequence;': (v, s, [p, t]) => formatDate(androidPattern(jstr(vm, p)), Number(t), defaultZone()),
    'format(Ljava/lang/CharSequence;Ljava/util/Date;)Ljava/lang/CharSequence;': (v, s, [p, d]) => formatDate(androidPattern(jstr(vm, p)), ms(d.f.t), defaultZone()),
    'format(Ljava/lang/CharSequence;Ljava/util/Calendar;)Ljava/lang/CharSequence;': (v, s, [p, c]) => formatDate(androidPattern(jstr(vm, p)), c.f.t, c.f.zone),
  })
  // android's DateFormat.format uses kk for 24h hours and 'A' / 'a' differently; close enough
  const androidPattern = (p: string) => p.replace(/k/g, 'H')

  // NumberFormat / DecimalFormat (grouping, fraction digits, a few patterns)
  const NF = 'Ljava/text/NumberFormat;', DCF = 'Ljava/text/DecimalFormat;'
  const nf = (o: Partial<{ min: number; max: number; group: boolean; percent: boolean; int: boolean; minInt: number }> = {}) => obj(DCF, { min: 0, max: 3, group: true, percent: false, minInt: 1, ...o })
  const fromPattern = (s: JObject, p: string) => {
    const [, frac = ''] = p.split('.')
    const intPart = p.split('.')[0]
    Object.assign(s.f, { group: intPart.includes(','), min: (frac.match(/0/g) || []).length, max: (frac.match(/[0#]/g) || []).length, percent: p.includes('%'), minInt: Math.max(1, (intPart.replace(/[^0]/g, '')).length), pattern: p })
  }
  const fmtNum = (s: JObject, x: number) => {
    if (s.f.percent) x *= 100
    if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? '∞' : '-∞'
    let t = Math.abs(x).toFixed(s.f.max)
    if (s.f.max > s.f.min) t = t.replace(new RegExp(`0{1,${s.f.max - s.f.min}}$`), '').replace(/\.$/, '')
    let [ip, fp] = t.split('.')
    ip = ip.padStart(s.f.minInt, '0')
    if (s.f.group) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return (x < 0 && Number(t) !== 0 ? '-' : '') + ip + (fp ? '.' + fp : '') + (s.f.percent ? '%' : '')
  }
  const nfMethods: Record<string, NativeFn> = {
    '<init>()V': (v, s) => { Object.assign(s.f, { min: 0, max: 3, group: true, percent: false, minInt: 1 }) },
    '<init>(Ljava/lang/String;)V': (v, s, [p]) => fromPattern(s, String(p)),
    '<init>(Ljava/lang/String;Ljava/text/DecimalFormatSymbols;)V': (v, s, [p]) => fromPattern(s, String(p)),
    'applyPattern(Ljava/lang/String;)V': (v, s, [p]) => fromPattern(s, String(p)),
    'getInstance()Ljava/text/NumberFormat;': () => nf(), 'getNumberInstance()Ljava/text/NumberFormat;': () => nf(),
    'getInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;': () => nf(), 'getNumberInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;': () => nf(),
    'getIntegerInstance()Ljava/text/NumberFormat;': () => nf({ max: 0 }), 'getIntegerInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;': () => nf({ max: 0 }),
    'getPercentInstance()Ljava/text/NumberFormat;': () => nf({ max: 0, percent: true }), 'getPercentInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;': () => nf({ max: 0, percent: true }),
    'getCurrencyInstance()Ljava/text/NumberFormat;': () => nf({ min: 2, max: 2 }), 'getCurrencyInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;': () => nf({ min: 2, max: 2 }),
    'format(J)Ljava/lang/String;': (v, s, [x]) => fmtNum(s, Number(x)),
    'format(D)Ljava/lang/String;': (v, s, [x]) => fmtNum(s, x),
    'format(Ljava/lang/Object;)Ljava/lang/String;': (v, s, [x]) => fmtNum(s, Number(typeof x === 'object' && x ? x.f?.v ?? 0 : x)),
    'parse(Ljava/lang/String;)Ljava/lang/Number;': (v, s, [t]) => { const n = Number(String(t).replace(/,/g, '').replace(/%$/, '')); if (Number.isNaN(n)) throw ex('Ljava/text/ParseException;', `Unparseable number: "${t}"`); return vm.callStatic('Ljava/lang/Double;', 'valueOf(D)Ljava/lang/Double;', [s.f.percent ? n / 100 : n]) },
    'setMaximumFractionDigits(I)V': (v, s, [n]) => { s.f.max = n; if (s.f.min > n) s.f.min = n },
    'setMinimumFractionDigits(I)V': (v, s, [n]) => { s.f.min = n; if (s.f.max < n) s.f.max = n },
    'setMinimumIntegerDigits(I)V': (v, s, [n]) => { s.f.minInt = n }, 'setMaximumIntegerDigits(I)V': () => {},
    'getMaximumFractionDigits()I': (v, s) => s.f.max, 'getMinimumFractionDigits()I': (v, s) => s.f.min,
    'setGroupingUsed(Z)V': (v, s, [g]) => { s.f.group = !!g }, 'isGroupingUsed()Z': (v, s) => (s.f.group ? 1 : 0),
    'setParseIntegerOnly(Z)V': () => {}, 'setRoundingMode(Ljava/math/RoundingMode;)V': () => {},
    'toPattern()Ljava/lang/String;': (v, s) => s.f.pattern ?? '#,##0.###',
  }
  def(NF, 'Ljava/text/Format;', nfMethods)
  def(DCF, NF, nfMethods)
  def('Ljava/text/DecimalFormatSymbols;', OBJ, { '<init>()V': () => {}, '<init>(Ljava/util/Locale;)V': () => {}, 'getInstance()Ljava/text/DecimalFormatSymbols;': () => obj('Ljava/text/DecimalFormatSymbols;'), 'getDecimalSeparator()C': () => 46, 'getGroupingSeparator()C': () => 44, 'getMinusSign()C': () => 45 })

  // ---------- digests, random ----------
  def('Ljava/security/MessageDigest;', OBJ, {
    'getInstance(Ljava/lang/String;)Ljava/security/MessageDigest;': (v, s, [alg]) => {
      const a = String(alg).toUpperCase()
      if (!DIGESTS[a]) throw ex('Ljava/security/NoSuchAlgorithmException;', `MessageDigest ${alg} implementation not found`)
      return obj('Ljava/security/MessageDigest;', { alg: a, parts: [] as Uint8Array[] })
    },
    'update([B)V': (v, s, [a]) => { s.f.parts.push(bytes(a).slice()) },
    'update([BII)V': (v, s, [a, off, len]) => { s.f.parts.push(bytes(a, off, len).slice()) },
    'update(B)V': (v, s, [b]) => { s.f.parts.push(new Uint8Array([b & 0xff])) },
    'digest()[B': (v, s) => { const total = s.f.parts.reduce((n: number, p: Uint8Array) => n + p.length, 0), all = new Uint8Array(total); let o = 0; for (const p of s.f.parts) { all.set(p, o); o += p.length } s.f.parts = []; return byteArray(DIGESTS[s.f.alg].fn(all)) },
    'digest([B)[B': (v, s, [a]) => { s.f.parts.push(bytes(a).slice()); return vm.callVirtual(s, 'digest()[B', []) },
    'reset()V': (v, s) => { s.f.parts = [] },
    'getAlgorithm()Ljava/lang/String;': (v, s) => s.f.alg,
    'getDigestLength()I': (v, s) => DIGESTS[s.f.alg].len,
    'isEqual([B[B)Z': (v, s, [a, b]) => (a.data.length === b.data.length && (a.data as Int8Array).every((x: number, i: number) => x === (b.data as Int8Array)[i]) ? 1 : 0),
  })
  def('Ljava/security/SecureRandom;', 'Ljava/util/Random;', {
    '<init>()V': () => {}, '<init>([B)V': () => {},
    'getInstance(Ljava/lang/String;)Ljava/security/SecureRandom;': () => obj('Ljava/security/SecureRandom;'),
    'nextBytes([B)V': (v, s, [a]) => { crypto.getRandomValues(a.data as Int8Array<ArrayBuffer>) },
    'nextInt()I': () => crypto.getRandomValues(new Int32Array(1))[0],
    'nextInt(I)I': (v, s, [n]) => { if (n <= 0) throw ex('Ljava/lang/IllegalArgumentException;', 'n must be positive'); return crypto.getRandomValues(new Uint32Array(1))[0] % n },
    'nextLong()J': () => crypto.getRandomValues(new BigInt64Array(1))[0],
    'nextDouble()D': () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32,
    'nextBoolean()Z': () => crypto.getRandomValues(new Uint8Array(1))[0] & 1,
    'setSeed(J)V': () => {}, 'setSeed([B)V': () => {},
    'generateSeed(I)[B': (v, s, [n]) => byteArray(crypto.getRandomValues(new Uint8Array(n))),
  })

  // ---------- url encoding, base64 ----------
  const enc = new TextEncoder(), dec = new TextDecoder()
  const urlEncode = (x: string) => [...enc.encode(x)].map((b) => (/[A-Za-z0-9.\-*_]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : b === 32 ? '+' : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('')
  const urlDecode = (x: string) => {
    const out: number[] = []
    for (let i = 0; i < x.length; i++) {
      const c = x[i]
      if (c === '+') out.push(32)
      else if (c === '%' && /^[0-9a-fA-F]{2}$/.test(x.substr(i + 1, 2))) { out.push(parseInt(x.substr(i + 1, 2), 16)); i += 2 }
      else if (c === '%') throw ex('Ljava/lang/IllegalArgumentException;', 'URLDecoder: Illegal hex characters in escape (%) pattern')
      else out.push(...enc.encode(c))
    }
    return dec.decode(new Uint8Array(out))
  }
  def('Ljava/net/URLEncoder;', OBJ, { 'encode(Ljava/lang/String;)Ljava/lang/String;': (v, s, [x]) => urlEncode(String(x)), 'encode(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [x]) => urlEncode(String(x)) })
  def('Ljava/net/URLDecoder;', OBJ, { 'decode(Ljava/lang/String;)Ljava/lang/String;': (v, s, [x]) => urlDecode(String(x)), 'decode(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [x]) => urlDecode(String(x)) })
  // android.util.Base64 (flags: NO_PADDING 1, NO_WRAP 2, CRLF 4, URL_SAFE 8)
  const b64enc = (u: Uint8Array, flags: number) => {
    let s = ''
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
    let t = btoa(s)
    if (flags & 8) t = t.replace(/\+/g, '-').replace(/\//g, '_')
    if (flags & 1) t = t.replace(/=+$/, '')
    if (!(flags & 2)) t = t.replace(/(.{76})/g, flags & 4 ? '$1\r\n' : '$1\n') + (t.length ? (flags & 4 ? '\r\n' : '\n') : '')
    return t
  }
  const b64dec = (t: string) => {
    const clean = t.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/')
    let bin: string
    try { bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4)) } catch { throw ex('Ljava/lang/IllegalArgumentException;', 'bad base-64') }
    const u = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
    return u
  }
  def('Landroid/util/Base64;', OBJ, {
    'encode([BI)[B': (v, s, [a, f]) => byteArray(enc.encode(b64enc(bytes(a), f))),
    'encode([BIII)[B': (v, s, [a, off, len, f]) => byteArray(enc.encode(b64enc(bytes(a, off, len), f))),
    'encodeToString([BI)Ljava/lang/String;': (v, s, [a, f]) => b64enc(bytes(a), f),
    'encodeToString([BIII)Ljava/lang/String;': (v, s, [a, off, len, f]) => b64enc(bytes(a, off, len), f),
    'decode(Ljava/lang/String;I)[B': (v, s, [t]) => byteArray(b64dec(String(t))),
    'decode([BI)[B': (v, s, [a]) => byteArray(b64dec(dec.decode(bytes(a)))),
    'decode([BIII)[B': (v, s, [a, off, len]) => byteArray(b64dec(dec.decode(bytes(a, off, len)))),
  }, { statics: { DEFAULT: 0, NO_PADDING: 1, NO_WRAP: 2, CRLF: 4, URL_SAFE: 8, NO_CLOSE: 16 } })

  // ---------- float / double bits ----------
  const dv = new DataView(new ArrayBuffer(8))
  def('Ljava/lang/Double;', 'Ljava/lang/Number;', {
    'doubleToLongBits(D)J': (v, s, [x]) => { dv.setFloat64(0, Number.isNaN(x) ? NaN : x); return Number.isNaN(x) ? 0x7ff8000000000000n : dv.getBigInt64(0) },
    'doubleToRawLongBits(D)J': (v, s, [x]) => { dv.setFloat64(0, x); return dv.getBigInt64(0) },
    'longBitsToDouble(J)D': (v, s, [b]) => { dv.setBigInt64(0, BigInt(b)); return dv.getFloat64(0) },
  })
  def('Ljava/lang/Float;', 'Ljava/lang/Number;', {
    'floatToIntBits(F)I': (v, s, [x]) => { if (Number.isNaN(x)) return 0x7fc00000; dv.setFloat32(0, x); return dv.getInt32(0) },
    'floatToRawIntBits(F)I': (v, s, [x]) => { dv.setFloat32(0, x); return dv.getInt32(0) },
    'intBitsToFloat(I)F': (v, s, [b]) => { dv.setInt32(0, b); return dv.getFloat32(0) },
  })

  // ---------- ssl: droid's apps are offline, these only need to exist ----------
  def('Ljavax/net/ssl/SSLContext;', OBJ, {
    'getInstance(Ljava/lang/String;)Ljavax/net/ssl/SSLContext;': (v, s, [p]) => obj('Ljavax/net/ssl/SSLContext;', { protocol: String(p) }),
    'getDefault()Ljavax/net/ssl/SSLContext;': () => obj('Ljavax/net/ssl/SSLContext;', { protocol: 'TLS' }),
    'init([Ljavax/net/ssl/KeyManager;[Ljavax/net/ssl/TrustManager;Ljava/security/SecureRandom;)V': () => {},
    'getSocketFactory()Ljavax/net/ssl/SSLSocketFactory;': () => obj('Ljavax/net/ssl/SSLSocketFactory;'),
    'getProtocol()Ljava/lang/String;': (v, s) => s.f.protocol,
  })
  def('Ljavax/net/SocketFactory;', OBJ, {})
  def('Ljavax/net/ssl/SSLSocketFactory;', 'Ljavax/net/SocketFactory;', { 'getDefault()Ljavax/net/SocketFactory;': () => obj('Ljavax/net/ssl/SSLSocketFactory;') })
  def('Ljavax/net/ssl/HttpsURLConnection;', 'Ljava/net/HttpURLConnection;', {
    'setDefaultSSLSocketFactory(Ljavax/net/ssl/SSLSocketFactory;)V': () => {},
    'setDefaultHostnameVerifier(Ljavax/net/ssl/HostnameVerifier;)V': () => {},
    'getDefaultSSLSocketFactory()Ljavax/net/ssl/SSLSocketFactory;': () => obj('Ljavax/net/ssl/SSLSocketFactory;'),
  })
  def('Ljava/net/InetAddress;', OBJ, {
    'getByName(Ljava/lang/String;)Ljava/net/InetAddress;': (v, s, [h]) => {
      const host = String(h ?? 'localhost')
      if (host === 'localhost' || host === '' || /^127\./.test(host) || host === '0.0.0.0') return obj('Ljava/net/InetAddress;', { host, addr: host === 'localhost' || !host ? '127.0.0.1' : host })
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return obj('Ljava/net/InetAddress;', { host, addr: host })
      throw ex('Ljava/net/UnknownHostException;', `Unable to resolve host "${host}": No address associated with hostname`)
    },
    'getLocalHost()Ljava/net/InetAddress;': () => obj('Ljava/net/InetAddress;', { host: 'localhost', addr: '127.0.0.1' }),
    'getHostAddress()Ljava/lang/String;': (v, s) => s.f.addr, 'getHostName()Ljava/lang/String;': (v, s) => s.f.host,
    'isLoopbackAddress()Z': (v, s) => (/^127\./.test(s.f.addr) ? 1 : 0),
    'toString()Ljava/lang/String;': (v, s) => `${s.f.host}/${s.f.addr}`,
  })
  void str
}
