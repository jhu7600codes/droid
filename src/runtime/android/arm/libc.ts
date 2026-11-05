// the rest of the c library for native code: memory, strings and ctype, stdlib (conversions, sorting,
// environment), printf / scanf, math (soft-float abi: doubles in register pairs), time, process and
// system info, dynamic loading, zlib, sha1, c++ runtime helpers, sockets (none), syscall.
import type { CPU } from './cpu.ts'
import type { Native } from './native.ts'
import { inflateRawSync, Inflater } from '../inflate.ts'

const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer), f32a = new Float32Array(1), u32a = new Uint32Array(f32a.buffer)
const dbl = (lo: number, hi: number) => { u64[0] = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0); return f64[0] }
const bitsD = (x: number) => { f64[0] = x; return u64[0] }
const flt = (b: number) => { u32a[0] = b >>> 0; return f32a[0] }
const bitsF = (x: number) => { f32a[0] = x; return u32a[0] }

export function installLibc(nat: Native) {
  const m = nat.mem, c = nat.cpu
  const R = (i: number) => c.r[i]
  const S = (i: number) => m.r32(c.r[13] + i * 4)
  const def = (name: string, fn: (cpu: CPU) => any) => nat.def(name, fn)
  const enc = new TextEncoder(), dec = new TextDecoder()
  const cstr = (a: number) => m.cstr(a)
  const putStr = (dst: number, s: string, max = Infinity) => { const b = enc.encode(s); const n = Math.min(b.length, max - 1); if (n >= 0) { m.u8.set(b.subarray(0, n), dst); m.u8[dst + n] = 0 } return b.length }

  // ---------- memory ----------
  def('malloc', () => m.malloc(R(0)))
  def('calloc', () => { const n = R(0) * R(1); const a = m.malloc(n); m.u8.fill(0, a, a + n); return a })
  def('realloc', () => { const old = R(0), n = R(1); if (!old) return m.malloc(n); if (!n) { m.free(old); return 0 } const have = m.sizeOf(old); if (have >= n && have - n < 4096) return old; const a = m.malloc(n); m.u8.copyWithin(a, old, old + Math.min(n, have)); m.free(old); return a })
  def('free', () => { m.free(R(0)) })
  def('memalign', () => m.memalign(R(0), R(1)))
  def('posix_memalign', () => { m.w32(R(0), m.memalign(R(1), R(2))); return 0 })
  def('valloc', () => m.memalign(4096, R(0)))
  def('malloc_usable_size', () => m.sizeOf(R(0)))
  def('dlmalloc', () => m.malloc(R(0))); def('dlfree', () => { m.free(R(0)) })
  const memmove = () => { m.u8.copyWithin(R(0), R(1), R(1) + R(2)); return R(0) }
  for (const n of ['memcpy', 'memmove', '__aeabi_memcpy', '__aeabi_memmove', '__aeabi_memcpy4', '__aeabi_memcpy8', '__aeabi_memmove4', '__aeabi_memmove8', '__memcpy_chk', '__memmove_chk']) def(n, memmove)
  def('bcopy', () => { m.u8.copyWithin(R(1), R(0), R(0) + R(2)) })
  def('memset', () => { m.u8.fill(R(1) & 0xff, R(0), R(0) + R(2)); return R(0) })
  def('__memset_chk', () => { m.u8.fill(R(1) & 0xff, R(0), R(0) + R(2)); return R(0) })
  for (const n of ['__aeabi_memset', '__aeabi_memset4', '__aeabi_memset8']) def(n, () => { m.u8.fill(R(2) & 0xff, R(0), R(0) + R(1)); return R(0) })
  for (const n of ['__aeabi_memclr', '__aeabi_memclr4', '__aeabi_memclr8', 'bzero']) def(n, () => { m.u8.fill(0, R(0), R(0) + R(1)) })
  def('memcmp', () => { const a = R(0), b = R(1), n = R(2); for (let i = 0; i < n; i++) { const d = m.u8[a + i] - m.u8[b + i]; if (d) return d } return 0 })
  def('bcmp', () => { const a = R(0), b = R(1), n = R(2); for (let i = 0; i < n; i++) if (m.u8[a + i] !== m.u8[b + i]) return 1; return 0 })
  def('memchr', () => { const a = R(0), ch = R(1) & 0xff, n = R(2); const i = m.u8.subarray(a, a + n).indexOf(ch); return i < 0 ? 0 : a + i })
  def('memrchr', () => { const a = R(0), ch = R(1) & 0xff, n = R(2); const i = m.u8.subarray(a, a + n).lastIndexOf(ch); return i < 0 ? 0 : a + i })
  def('memmem', () => {
    const h = m.u8.subarray(R(0), R(0) + R(1)), nd = m.u8.subarray(R(2), R(2) + R(3))
    if (!nd.length) return R(0)
    outer: for (let i = 0; i + nd.length <= h.length; i++) { for (let j = 0; j < nd.length; j++) if (h[i + j] !== nd[j]) continue outer; return R(0) + i }
    return 0
  })

  // ---------- strings (byte-wise, like c) ----------
  const len = (a: number) => { let e = a; while (m.u8[e]) e++; return e - a }
  def('strlen', () => len(R(0)))
  def('strnlen', () => { let i = 0; while (i < R(1) && m.u8[R(0) + i]) i++; return i })
  const cmp = (a: number, b: number, n: number, fold: boolean) => {
    for (let i = 0; i < n; i++) {
      let x = m.u8[a + i], y = m.u8[b + i]
      if (fold) { if (x >= 65 && x <= 90) x += 32; if (y >= 65 && y <= 90) y += 32 }
      if (x !== y) return x - y
      if (!x) return 0
    }
    return 0
  }
  def('strcmp', () => cmp(R(0), R(1), Infinity, false))
  def('strncmp', () => cmp(R(0), R(1), R(2), false))
  def('strcasecmp', () => cmp(R(0), R(1), Infinity, true))
  def('strncasecmp', () => cmp(R(0), R(1), R(2), true))
  def('strcoll', () => cmp(R(0), R(1), Infinity, false))
  def('strcpy', () => { const n = len(R(1)); m.u8.copyWithin(R(0), R(1), R(1) + n + 1); return R(0) })
  def('stpcpy', () => { const n = len(R(1)); m.u8.copyWithin(R(0), R(1), R(1) + n + 1); return R(0) + n })
  def('__strcpy_chk', () => { const n = len(R(1)); m.u8.copyWithin(R(0), R(1), R(1) + n + 1); return R(0) })
  def('strncpy', () => { let z = false; for (let i = 0; i < R(2); i++) { const b = z ? 0 : m.u8[R(1) + i]; if (!b) z = true; m.u8[R(0) + i] = b } return R(0) })
  def('strlcpy', () => { const n = len(R(1)); if (R(2)) { const k = Math.min(n, R(2) - 1); m.u8.copyWithin(R(0), R(1), R(1) + k); m.u8[R(0) + k] = 0 } return n })
  def('strcat', () => { const e = R(0) + len(R(0)); const n = len(R(1)); m.u8.copyWithin(e, R(1), R(1) + n + 1); return R(0) })
  def('__strcat_chk', () => { const e = R(0) + len(R(0)); const n = len(R(1)); m.u8.copyWithin(e, R(1), R(1) + n + 1); return R(0) })
  def('strncat', () => { const e = R(0) + len(R(0)); let i = 0; for (; i < R(2) && m.u8[R(1) + i]; i++) m.u8[e + i] = m.u8[R(1) + i]; m.u8[e + i] = 0; return R(0) })
  def('strlcat', () => { const d = len(R(0)), s = len(R(1)); const room = R(2) - d - 1; if (room > 0) { const k = Math.min(room, s); m.u8.copyWithin(R(0) + d, R(1), R(1) + k); m.u8[R(0) + d + k] = 0 } return d + s })
  def('strchr', () => { const ch = R(1) & 0xff; for (let p = R(0); ; p++) { if (m.u8[p] === ch) return p; if (!m.u8[p]) return 0 } })
  def('strrchr', () => { const ch = R(1) & 0xff; let last = 0; for (let p = R(0); ; p++) { if (m.u8[p] === ch) last = p; if (!m.u8[p]) return last } })
  const find = (h: number, n: number, fold: boolean) => {
    const nl = len(n)
    if (!nl) return h
    for (let p = h; m.u8[p]; p++) if (cmp(p, n, nl, fold) === 0) return p
    return 0
  }
  def('strstr', () => find(R(0), R(1), false))
  def('strcasestr', () => find(R(0), R(1), true))
  const inSet = (set: number, ch: number) => { for (let p = set; m.u8[p]; p++) if (m.u8[p] === ch) return true; return false }
  def('strpbrk', () => { for (let p = R(0); m.u8[p]; p++) if (inSet(R(1), m.u8[p])) return p; return 0 })
  def('strspn', () => { let i = 0; while (m.u8[R(0) + i] && inSet(R(1), m.u8[R(0) + i])) i++; return i })
  def('strcspn', () => { let i = 0; while (m.u8[R(0) + i] && !inSet(R(1), m.u8[R(0) + i])) i++; return i })
  const tok = (s: number, delim: number, save: number) => {
    let p = s || m.r32(save)
    if (!p) return 0
    while (m.u8[p] && inSet(delim, m.u8[p])) p++
    if (!m.u8[p]) { m.w32(save, 0); return 0 }
    const start = p
    while (m.u8[p] && !inSet(delim, m.u8[p])) p++
    if (m.u8[p]) { m.u8[p] = 0; m.w32(save, p + 1) } else m.w32(save, 0)
    return start
  }
  const tokSave = m.malloc(4)
  def('strtok', () => tok(R(0), R(1), tokSave))
  def('strtok_r', () => tok(R(0), R(1), R(2)))
  def('strsep', () => { const sp = R(0), s = m.r32(sp); if (!s) return 0; let p = s; while (m.u8[p] && !inSet(R(1), m.u8[p])) p++; if (m.u8[p]) { m.u8[p] = 0; m.w32(sp, p + 1) } else m.w32(sp, 0); return s })
  def('strdup', () => { const n = len(R(0)); const a = m.malloc(n + 1); m.u8.copyWithin(a, R(0), R(0) + n + 1); return a })
  def('strndup', () => { let n = 0; while (n < R(1) && m.u8[R(0) + n]) n++; const a = m.malloc(n + 1); m.u8.copyWithin(a, R(0), R(0) + n); m.u8[a + n] = 0; return a })
  const ERR = ['Success', 'Operation not permitted', 'No such file or directory', 'No such process', 'Interrupted system call', 'I/O error', 'No such device or address', 'Argument list too long', 'Exec format error', 'Bad file descriptor', 'No child processes', 'Try again', 'Out of memory', 'Permission denied']
  const errStr = new Map<number, number>()
  const strerror = (e: number) => { let a = errStr.get(e); if (!a) { a = nat.str(ERR[e] ?? `Unknown error ${e}`); errStr.set(e, a) } return a }
  def('strerror', () => strerror(R(0)))
  def('strerror_r', () => { putStr(R(1), ERR[R(0)] ?? `Unknown error ${R(0)}`, R(2)); return 0 })
  def('strsignal', () => nat.str(`Signal ${R(0)}`))
  def('perror', () => { console.warn('[native] ' + (R(0) ? cstr(R(0)) + ': ' : '') + (ERR[nat.getErrno()] ?? 'error')) })

  // ---------- ctype (bionic tables: index c + 1) ----------
  const U = 1, L = 2, N = 4, SP = 8, P = 0x10, C = 0x20, X = 0x40, B = 0x80
  const ctypeTab = m.malloc(260)
  for (let ch = -1; ch < 256; ch++) {
    let f = 0
    if (ch >= 65 && ch <= 90) f |= U
    if (ch >= 97 && ch <= 122) f |= L
    if (ch >= 48 && ch <= 57) f |= N
    if (ch === 32 || (ch >= 9 && ch <= 13)) f |= SP
    if ((ch >= 33 && ch <= 47) || (ch >= 58 && ch <= 64) || (ch >= 91 && ch <= 96) || (ch >= 123 && ch <= 126)) f |= P
    if ((ch >= 0 && ch < 32) || ch === 127) f |= C
    if ((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 70) || (ch >= 97 && ch <= 102)) f |= X
    if (ch === 32) f |= B
    m.u8[ctypeTab + ch + 1] = f
  }
  const lowTab = m.malloc(520), upTab = m.malloc(520)
  for (let ch = -1; ch < 256; ch++) {
    m.w16(lowTab + (ch + 1) * 2, ch >= 65 && ch <= 90 ? ch + 32 : ch & 0xffff)
    m.w16(upTab + (ch + 1) * 2, ch >= 97 && ch <= 122 ? ch - 32 : ch & 0xffff)
  }
  nat.data('_ctype_', 4, (a) => m.w32(a, ctypeTab))
  nat.data('_tolower_tab_', 4, (a) => m.w32(a, lowTab))
  nat.data('_toupper_tab_', 4, (a) => m.w32(a, upTab))
  const ct = (mask: number) => () => (m.u8[ctypeTab + (R(0) & 0xff) + 1] & mask && R(0) < 256 ? 1 : 0)
  def('isalpha', ct(U | L)); def('isdigit', ct(N)); def('isalnum', ct(U | L | N)); def('isspace', ct(SP)); def('isupper', ct(U)); def('islower', ct(L))
  def('isxdigit', ct(X)); def('ispunct', ct(P)); def('iscntrl', ct(C)); def('isprint', ct(U | L | N | P | B)); def('isgraph', ct(U | L | N | P)); def('isblank', () => (R(0) === 32 || R(0) === 9 ? 1 : 0))
  def('isascii', () => (R(0) < 128 ? 1 : 0))
  def('tolower', () => (R(0) >= 65 && R(0) <= 90 ? R(0) + 32 : R(0)))
  def('toupper', () => (R(0) >= 97 && R(0) <= 122 ? R(0) - 32 : R(0)))
  // wide chars (wchar_t is 32-bit)
  const wch = (re: RegExp) => () => (re.test(String.fromCodePoint(R(0) & 0x1fffff)) ? 1 : 0)
  def('iswalpha', wch(/\p{L}/u)); def('iswdigit', wch(/[0-9]/)); def('iswspace', wch(/\s/)); def('iswupper', wch(/\p{Lu}/u)); def('iswlower', wch(/\p{Ll}/u))
  def('iswpunct', wch(/\p{P}|\p{S}/u)); def('iswcntrl', wch(/\p{Cc}/u)); def('iswprint', wch(/[^\p{C}]/u)); def('iswxdigit', wch(/[0-9a-fA-F]/)); def('iswalnum', wch(/\p{L}|\p{N}/u))
  def('towlower', () => String.fromCodePoint(R(0)).toLowerCase().codePointAt(0)!)
  def('towupper', () => String.fromCodePoint(R(0)).toUpperCase().codePointAt(0)!)
  const wlen = (a: number) => { let n = 0; while (m.r32(a + n * 4)) n++; return n }
  def('wcslen', () => wlen(R(0)))
  def('wcscmp', () => { for (let i = 0; ; i++) { const x = m.r32(R(0) + i * 4), y = m.r32(R(1) + i * 4); if (x !== y) return x < y ? -1 : 1; if (!x) return 0 } })
  def('wcsncpy', () => { let z = false; for (let i = 0; i < R(2); i++) { const v = z ? 0 : m.r32(R(1) + i * 4); if (!v) z = true; m.w32(R(0) + i * 4, v) } return R(0) })
  def('wcscpy', () => { const n = wlen(R(1)); m.u8.copyWithin(R(0), R(1), R(1) + n * 4 + 4); return R(0) })
  def('wmemcpy', () => { m.u8.copyWithin(R(0), R(1), R(1) + R(2) * 4); return R(0) })
  def('wmemmove', () => { m.u8.copyWithin(R(0), R(1), R(1) + R(2) * 4); return R(0) })
  def('wmemset', () => { for (let i = 0; i < R(2); i++) m.w32(R(0) + i * 4, R(1)); return R(0) })
  def('wmemcmp', () => { for (let i = 0; i < R(2); i++) { const x = m.r32(R(0) + i * 4), y = m.r32(R(1) + i * 4); if (x !== y) return x < y ? -1 : 1 } return 0 })
  def('wcschr', () => { for (let p = R(0); ; p += 4) { const v = m.r32(p); if (v === R(1)) return p; if (!v) return 0 } })
  def('btowc', () => R(0)); def('wctob', () => (R(0) < 128 ? R(0) : -1)); def('mbtowc', () => { if (!R(1)) return 0; const b = m.u8[R(1)]; if (R(0)) m.w32(R(0), b); return b ? 1 : 0 })
  def('mbstowcs', () => { const s = cstr(R(1)); const cps = [...s].map((x) => x.codePointAt(0)!); if (R(0)) cps.slice(0, R(2)).forEach((cp, i) => m.w32(R(0) + i * 4, cp)); if (R(0) && cps.length < R(2)) m.w32(R(0) + cps.length * 4, 0); return cps.length })
  def('wcstombs', () => { let s = ''; for (let p = R(1); m.r32(p); p += 4) s += String.fromCodePoint(m.r32(p)); return R(0) ? putStr(R(0), s, R(2) + 1) : enc.encode(s).length })
  def('setlocale', () => nat.str('C'))
  def('localeconv', () => { const a = m.malloc(64); m.u8.fill(0, a, a + 64); m.w32(a, nat.str('.')); m.w32(a + 4, nat.str('')); m.w32(a + 8, nat.str('')); return a })

  // ---------- conversions ----------
  const numStart = (a: number) => { let p = a; while (m.u8[ctypeTab + m.u8[p] + 1] & SP) p++; return p }
  const strtoInt = (a: number, endp: number, base: number, unsigned: boolean, wide: boolean): bigint => {
    let p = numStart(a), neg = false
    if (m.u8[p] === 45) { neg = true; p++ } else if (m.u8[p] === 43) p++
    if ((base === 0 || base === 16) && m.u8[p] === 48 && (m.u8[p + 1] | 32) === 120) { base = 16; p += 2 }
    else if (base === 0 && m.u8[p] === 48) base = 8
    else if (base === 0) base = 10
    let v = 0n, any = false
    for (;; p++) {
      const ch = m.u8[p], d = ch >= 48 && ch <= 57 ? ch - 48 : ch >= 97 && ch <= 122 ? ch - 87 : ch >= 65 && ch <= 90 ? ch - 55 : 99
      if (d >= base) break
      v = v * BigInt(base) + BigInt(d); any = true
    }
    if (endp) m.w32(endp, any ? p : a)
    if (neg) v = -v
    const bits = wide ? 64 : 32
    if (!unsigned) { const max = (1n << BigInt(bits - 1)) - 1n; if (v > max) v = max; if (v < -max - 1n) v = -max - 1n }
    return unsigned ? BigInt.asUintN(bits, v) : v
  }
  def('strtol', () => Number(strtoInt(R(0), R(1), R(2), false, false)) | 0)
  def('strtoul', () => Number(strtoInt(R(0), R(1), R(2), true, false)) >>> 0)
  def('strtoll', () => BigInt.asUintN(64, strtoInt(R(0), R(1), R(2), false, true)))
  def('strtoull', () => strtoInt(R(0), R(1), R(2), true, true))
  def('strtoimax', () => BigInt.asUintN(64, strtoInt(R(0), R(1), R(2), false, true)))
  def('strtoumax', () => strtoInt(R(0), R(1), R(2), true, true))
  def('atoi', () => Number(strtoInt(R(0), 0, 10, false, false)) | 0)
  def('atol', () => Number(strtoInt(R(0), 0, 10, false, false)) | 0)
  def('atoll', () => BigInt.asUintN(64, strtoInt(R(0), 0, 10, false, true)))
  const strtod = (a: number, endp: number) => {
    const p = numStart(a)
    const s = cstr(p).slice(0, 512)
    const mm = s.match(/^[+-]?(?:inf(?:inity)?|nan|0x[0-9a-f]*\.?[0-9a-f]*(?:p[+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i)
    if (!mm) { if (endp) m.w32(endp, a); return 0 }
    const t = mm[0].toLowerCase()
    const v = /inf/.test(t) ? (t[0] === '-' ? -Infinity : Infinity) : /nan/.test(t) ? NaN : /^[+-]?0x/.test(t) ? hexFloat(t) : parseFloat(t)
    if (endp) m.w32(endp, p + mm[0].length)
    return v
  }
  const hexFloat = (t: string) => { const mm = t.match(/^([+-]?)0x([0-9a-f]*)\.?([0-9a-f]*)(?:p([+-]?\d+))?$/)!; const v = parseInt((mm[2] || '0') + (mm[3] || ''), 16) / 16 ** (mm[3]?.length ?? 0) * 2 ** +(mm[4] || 0); return mm[1] === '-' ? -v : v }
  def('strtod', () => bitsD(strtod(R(0), R(1))))
  def('strtof', () => bitsF(strtod(R(0), R(1))))
  def('strtold', () => bitsD(strtod(R(0), R(1))))
  def('atof', () => bitsD(strtod(R(0), 0)))

  // ---------- stdlib ----------
  def('abs', () => Math.abs(R(0) | 0)); def('labs', () => Math.abs(R(0) | 0))
  def('llabs', () => { const v = BigInt.asIntN(64, (BigInt(R(1)) << 32n) | BigInt(R(0))); return BigInt.asUintN(64, v < 0n ? -v : v) })
  def('div', () => { const a = R(1) | 0, b = R(2) | 0; m.w32(R(0), (a / b) | 0); m.w32(R(0) + 4, a % b); return R(0) }) // struct return via r0
  def('ldiv', () => { const a = R(1) | 0, b = R(2) | 0; m.w32(R(0), (a / b) | 0); m.w32(R(0) + 4, a % b); return R(0) })
  let seed48 = 0x1234abcd330en
  const next48 = () => { seed48 = (seed48 * 0x5deece66dn + 0xbn) & 0xffffffffffffn; return seed48 }
  def('lrand48', () => Number(next48() >> 17n))
  def('mrand48', () => Number(BigInt.asIntN(32, next48() >> 16n)))
  def('drand48', () => bitsD(Number(next48()) / 2 ** 48))
  def('srand48', () => { seed48 = (BigInt(R(0) >>> 0) << 16n) | 0x330en })
  let rnd = 1
  def('rand', () => { rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0; return (rnd >>> 1) & 0x7fffffff })
  def('srand', () => { rnd = R(0) })
  def('random', () => (Math.random() * 0x7fffffff) | 0); def('srandom', () => {})
  def('arc4random', () => crypto.getRandomValues(new Uint32Array(1))[0])
  def('arc4random_buf', () => { const b = new Uint8Array(Math.min(R(1), 65536)); crypto.getRandomValues(b); m.u8.set(b, R(0)) })
  // qsort / bsearch call back into arm code for the comparisons
  def('qsort', () => {
    const base = R(0), n = R(1), size = R(2), fn = R(3)
    if (n < 2) return
    const items = Array.from({ length: n }, (_, i) => m.u8.slice(base + i * size, base + (i + 1) * size))
    const ta = m.malloc(size), tb = m.malloc(size)
    items.sort((x, y) => { m.u8.set(x, ta); m.u8.set(y, tb); return c.call(fn, [ta, tb]).r0 | 0 })
    items.forEach((it, i) => m.u8.set(it, base + i * size))
    m.free(ta); m.free(tb)
  })
  def('bsearch', () => {
    const key = R(0), base = R(1), n = R(2), size = R(3), fn = S(0)
    let lo = 0, hi = n - 1
    while (lo <= hi) { const mid = (lo + hi) >> 1; const r = c.call(fn, [key, base + mid * size]).r0 | 0; if (r < 0) hi = mid - 1; else if (r > 0) lo = mid + 1; else return base + mid * size }
    return 0
  })
  const env = new Map<string, string>([['PATH', '/system/bin'], ['HOME', '/data'], ['TMPDIR', '/data/local/tmp'], ['ANDROID_DATA', '/data'], ['ANDROID_ROOT', '/system'], ['EXTERNAL_STORAGE', '/sdcard']])
  const envStr = new Map<string, number>()
  def('getenv', () => { const k = cstr(R(0)); const v = env.get(k); if (v == null) return 0; let a = envStr.get(k + '=' + v); if (!a) { a = nat.str(v); envStr.set(k + '=' + v, a) } return a })
  def('setenv', () => { const k = cstr(R(0)); if (R(2) || !env.has(k)) env.set(k, cstr(R(1))); return 0 })
  def('unsetenv', () => { env.delete(cstr(R(0))); return 0 })
  def('putenv', () => { const [k, ...v] = cstr(R(0)).split('='); env.set(k, v.join('=')); return 0 })
  nat.data('environ', 4, (a) => { const arr = m.malloc(8); m.w32(arr, 0); m.w32(a, arr) })
  const exits: [number, number][] = []
  def('atexit', () => { exits.push([R(0), 0]); return 0 })
  def('__cxa_atexit', () => { exits.push([R(0), R(1)]); return 0 })
  def('__aeabi_atexit', () => { exits.push([R(1), R(0)]); return 0 }) // (object, destructor, dso)
  def('__cxa_finalize', () => 0)
  const quit = (code: number) => { console.warn('[native] exit(' + code + ')'); throw new Error(`native code exited (${code})`) }
  def('exit', () => quit(R(0))); def('_exit', () => quit(R(0))); def('_Exit', () => quit(R(0)))
  def('abort', () => { throw new Error('native code called abort()') })
  def('__assert2', () => { throw new Error(`assertion failed: ${cstr(R(3))} (${cstr(R(0))}:${R(1)} ${cstr(R(2))})`) })
  def('__assert', () => { throw new Error(`assertion failed: ${cstr(R(2))} (${cstr(R(0))}:${R(1)})`) })
  def('__stack_chk_fail', () => { throw new Error('native stack corruption detected') })
  nat.data('__stack_chk_guard', 4, (a) => m.w32(a, 0xd401d401))
  def('system', () => -1); def('fork', () => { nat.setErrno(38); return -1 }); def('vfork', () => -1)
  def('execv', () => -1); def('execve', () => -1); def('execvp', () => -1); def('waitpid', () => -1); def('wait', () => -1)

  // ---------- printf / scanf ----------
  const format = (f: string, next: () => number, nextD: () => number, nextL?: () => [number, number]) => {
    let out = ''
    for (let i = 0; i < f.length; i++) {
      if (f[i] !== '%') { out += f[i]; continue }
      const mm = /^%([-+ 0#']*)(\*|\d+)?(?:\.(\*|\d*))?(hh|h|ll|l|L|q|j|z|t)?([diouxXcspfFgGeEaAn%])/.exec(f.slice(i))
      if (!mm) { out += '%'; continue }
      i += mm[0].length - 1
      let [, flags, width, prec, lenM, conv] = mm as any as string[]
      if (width === '*') width = String(next() | 0)
      if (prec === '*') prec = String(next() | 0)
      let s = '', num = false, sign = ''
      switch (conv) {
        case '%': s = '%'; break
        case 's': { const p = next(); s = p ? cstr(p) : '(null)'; if (prec !== undefined && prec !== '') s = s.slice(0, +prec); break }
        case 'c': s = String.fromCharCode(next() & 0xff); break
        case 'p': s = '0x' + (next() >>> 0).toString(16); break
        case 'n': next(); break
        case 'f': case 'F': case 'g': case 'G': case 'e': case 'E': case 'a': case 'A': {
          const v = nextD(); num = true
          if (!isFinite(v)) s = isNaN(v) ? 'nan' : 'inf'
          else {
            const p = prec === undefined || prec === '' ? 6 : +prec
            const a = Math.abs(v)
            if (conv === 'f' || conv === 'F') s = a.toFixed(Math.min(p, 100))
            else if (conv === 'e' || conv === 'E') s = a.toExponential(Math.min(p, 100)).replace(/e([+-])(\d)$/, 'e$10$2')
            else if (conv === 'g' || conv === 'G') { const pp = p || 1; const ex = a === 0 ? 0 : Math.floor(Math.log10(a)); s = ex < -4 || ex >= pp ? a.toExponential(pp - 1).replace(/e([+-])(\d)$/, 'e$10$2') : a.toFixed(Math.max(0, pp - 1 - ex)); if (!flags.includes('#')) s = s.replace(/(\.\d*?)0+(e|$)/, '$1$2').replace(/\.(e|$)/, '$1') }
            else s = a.toString(16)
          }
          if (v < 0 || Object.is(v, -0)) sign = '-'
          if (conv === 'F' || conv === 'E' || conv === 'G') s = s.toUpperCase()
          break
        }
        default: {
          num = true
          let v: bigint
          if (lenM === 'll' || lenM === 'q' || lenM === 'j' || lenM === 'L') { const [lo, hi] = nextL ? nextL() : [next(), next()]; v = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0) } else v = BigInt(next() >>> 0)
          const bits = lenM === 'll' || lenM === 'q' || lenM === 'j' || lenM === 'L' ? 64 : lenM === 'h' ? 16 : lenM === 'hh' ? 8 : 32
          if (conv === 'd' || conv === 'i') { const sv = BigInt.asIntN(bits, v); if (sv < 0n) sign = '-'; s = (sv < 0n ? -sv : sv).toString() }
          else { const uv = BigInt.asUintN(bits, v); s = conv === 'o' ? uv.toString(8) : conv === 'u' ? uv.toString() : uv.toString(16); if (conv === 'X') s = s.toUpperCase(); if (flags.includes('#') && uv !== 0n) s = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + s }
          if (prec !== undefined && prec !== '') s = s.padStart(+prec, '0')
        }
      }
      if (num && !sign) sign = flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''
      const w = width ? +width : 0
      let body = sign + s
      if (body.length < w) body = flags.includes('-') ? body.padEnd(w) : flags.includes('0') && num ? sign + s.padStart(w - sign.length, '0') : body.padStart(w)
      out += body
    }
    return out
  }
  // varargs from registers (from register i on), then the stack; va_list is a plain pointer on arm
  const regArgs = (first: number) => {
    let i = first
    const next = () => (i < 4 ? c.r[i++] : S(i++ - 4))
    // 64-bit values start at an even register (and an 8-aligned stack slot)
    const pair = (): [number, number] => { if (i % 2) i++; return [next(), next()] }
    return { next, nextD: () => { const [lo, hi] = pair(); return dbl(lo, hi) }, nextL: pair }
  }
  const vaArgs = (p: number) => {
    let a = p
    const pair = (): [number, number] => { a = (a + 7) & ~7; const lo = m.r32(a), hi = m.r32(a + 4); a += 8; return [lo, hi] }
    return { next: () => { const v = m.r32(a); a += 4; return v }, nextD: () => { const [lo, hi] = pair(); return dbl(lo, hi) }, nextL: pair }
  }
  const fmtR = (fmtArg: number, first: number) => { const v = regArgs(first); return format(cstr(R(fmtArg)), v.next, v.nextD, v.nextL) }
  const fmtV = (fmtArg: number, va: number) => { const v = vaArgs(va); return format(cstr(R(fmtArg)), v.next, v.nextD, v.nextL) }
  nat.format = format
  const stdout = () => nat.host.get('__sF')! + 84
  def('printf', () => nat.writeFile(stdout(), fmtR(0, 1)))
  def('vprintf', () => nat.writeFile(stdout(), fmtV(0, R(1))))
  def('fprintf', () => nat.writeFile(R(0), fmtR(1, 2)))
  def('vfprintf', () => nat.writeFile(R(0), fmtV(1, R(2))))
  def('dprintf', () => { nat.writeFile(stdout(), fmtR(1, 2)); return 0 })
  def('puts', () => nat.writeFile(stdout(), cstr(R(0)) + '\n'))
  def('sprintf', () => putStr(R(0), fmtR(1, 2)))
  def('__sprintf_chk', () => putStr(R(0), fmtR(3, 4)))
  def('snprintf', () => putStr(R(0), fmtR(2, 3), R(1)))
  def('__snprintf_chk', () => putStr(R(0), fmtR(4, 5), R(1)))
  def('vsprintf', () => putStr(R(0), fmtV(1, R(2))))
  def('vsnprintf', () => putStr(R(0), fmtV(2, R(3)), R(1)))
  def('__vsnprintf_chk', () => putStr(R(0), fmtV(4, S(0)), R(1)))
  def('asprintf', () => { const s = fmtR(1, 2); const b = enc.encode(s); const a = m.malloc(b.length + 1); putStr(a, s, b.length + 1); m.w32(R(0), a); return b.length })
  def('vasprintf', () => { const s = fmtV(1, R(2)); const b = enc.encode(s); const a = m.malloc(b.length + 1); putStr(a, s, b.length + 1); m.w32(R(0), a); return b.length })
  const PRIO = ['', '', 'V', 'D', 'I', 'W', 'E', 'F']
  const alog = (p: number, tag: number, s: string) => { (p >= 6 ? console.warn : console.log)(`${PRIO[p] || '?'}/${cstr(tag)}: ${s}`); return 1 }
  def('__android_log_print', () => alog(R(0), R(1), fmtR(2, 3)))
  def('__android_log_vprint', () => alog(R(0), R(1), fmtV(2, R(3))))
  def('__android_log_write', () => alog(R(0), R(1), cstr(R(2))))
  def('__android_log_buf_write', () => alog(R(1), R(2), cstr(R(3))))
  def('__android_log_assert', () => { throw new Error('android log assert: ' + cstr(R(2))) })
  // scanf: the usual conversions from a string or a FILE
  const scan = (get: () => number, unget: (ch: number) => void, f: string, out: () => number) => {
    let n = 0, ch = get()
    const skipWs = () => { while (ch >= 0 && (ch === 32 || (ch >= 9 && ch <= 13))) ch = get() }
    for (let i = 0; i < f.length; i++) {
      const fc = f[i]
      if (/\s/.test(fc)) { skipWs(); continue }
      if (fc !== '%') { if (ch !== fc.charCodeAt(0)) break; ch = get(); continue }
      const mm = /^%(\*)?(\d+)?(hh|h|ll|l|L|z|j)?([diouxXfgeEaAscp%\[])/.exec(f.slice(i))
      if (!mm) break
      i += mm[0].length - 1
      const [, skip, w, lenM, conv] = mm
      const max = w ? +w : Infinity
      if (conv === '%') { skipWs(); if (ch !== 37) break; ch = get(); continue }
      if (conv === '[') {
        const close = f.indexOf(']', i + 2)
        const set = f.slice(i + 1, close)
        i = close
        const neg = set[0] === '^', chars = neg ? set.slice(1) : set
        const ok = (x: number) => { const s = String.fromCharCode(x); return neg ? !chars.includes(s) : chars.includes(s) }
        let s = ''
        while (ch >= 0 && s.length < max && ok(ch)) { s += String.fromCharCode(ch); ch = get() }
        if (!s) break
        if (!skip) { putStr(out(), s); n++ }
        continue
      }
      if (conv !== 'c') skipWs()
      if (ch < 0) { if (n === 0) n = -1; break }
      if (conv === 'c') { const k = w ? +w : 1; const bytes: number[] = []; while (bytes.length < k && ch >= 0) { bytes.push(ch); ch = get() } if (!skip) { const p = out(); m.u8.set(bytes, p); n++ } continue }
      if (conv === 's') { let s = ''; while (ch >= 0 && !(ch === 32 || (ch >= 9 && ch <= 13)) && s.length < max) { s += String.fromCharCode(ch); ch = get() } if (!skip) { putStr(out(), s); n++ } continue }
      let s = ''
      const isF = /[fgeEaA]/.test(conv)
      const re = isF ? /^[+-]?(\d+\.?\d*|\.\d+)?([eE][+-]?\d*)?$/ : conv === 'x' || conv === 'X' || conv === 'p' ? /^[+-]?(0[xX])?[0-9a-fA-F]*$/ : conv === 'o' ? /^[+-]?[0-7]*$/ : conv === 'i' ? /^[+-]?(0[xX][0-9a-fA-F]*|\d*)$/ : /^[+-]?\d*$/
      while (ch >= 0 && s.length < max && re.test(s + String.fromCharCode(ch))) { s += String.fromCharCode(ch); ch = get() }
      if (!s || s === '-' || s === '+') break
      if (skip) continue
      const p = out()
      if (isF) { const v = parseFloat(s); if (lenM === 'l' || lenM === 'L') m.dv.setFloat64(p, v, true); else m.dv.setFloat32(p, v, true) }
      else {
        const base = conv === 'x' || conv === 'X' || conv === 'p' ? 16 : conv === 'o' ? 8 : conv === 'i' ? (/^[+-]?0[xX]/.test(s) ? 16 : /^[+-]?0\d/.test(s) ? 8 : 10) : 10
        const v = BigInt.asIntN(64, BigInt((s.includes('-') ? -1 : 1) * 0) + (() => { const t = s.replace(/^[+-]/, '').replace(/^0[xX]/, ''); let x = 0n; for (const d of t || '0') x = x * BigInt(base) + BigInt(parseInt(d, base)); return s.startsWith('-') ? -x : x })())
        if (lenM === 'll' || lenM === 'j' || lenM === 'L') m.dv.setBigInt64(p, v, true)
        else if (lenM === 'h') m.w16(p, Number(v)); else if (lenM === 'hh') m.w8(p, Number(v)); else m.w32(p, Number(BigInt.asUintN(32, v)))
      }
      n++
    }
    if (ch >= 0) unget(ch)
    return n
  }
  const strSrc = (a: number) => { let p = a; return { get: () => (m.u8[p] ? m.u8[p++] : (p++, -1)), unget: () => {} } }
  def('sscanf', () => { const src = strSrc(R(0)); const o = regArgs(2); return scan(src.get, src.unget, cstr(R(1)), o.next) })
  def('vsscanf', () => { const src = strSrc(R(0)); const o = vaArgs(R(2)); return scan(src.get, src.unget, cstr(R(1)), o.next) })
  def('fscanf', () => { const f = nat.readFile(R(0)); if (!f) return -1; const o = regArgs(2); return scan(f.get, f.unget, cstr(R(1)), o.next) })
  def('scanf', () => -1)

  // ---------- math (soft-float: double args in r0:r1, r2:r3, result in r0:r1) ----------
  const D0 = () => dbl(R(0), R(1)), D1 = () => dbl(R(2), R(3)), F0 = () => flt(R(0)), F1 = () => flt(R(1))
  const d1: [string, (x: number) => number][] = [['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan], ['asin', Math.asin], ['acos', Math.acos], ['atan', Math.atan], ['sinh', Math.sinh], ['cosh', Math.cosh], ['tanh', Math.tanh], ['asinh', Math.asinh], ['acosh', Math.acosh], ['atanh', Math.atanh],
    ['exp', Math.exp], ['exp2', (x) => 2 ** x], ['expm1', Math.expm1], ['log', Math.log], ['log10', Math.log10], ['log2', Math.log2], ['log1p', Math.log1p], ['sqrt', Math.sqrt], ['cbrt', Math.cbrt],
    ['floor', Math.floor], ['ceil', Math.ceil], ['trunc', Math.trunc], ['round', (x) => (x < 0 ? -Math.round(-x) : Math.round(x))], ['rint', roundEven], ['nearbyint', roundEven], ['fabs', Math.abs]]
  for (const [n, fn] of d1) { def(n, () => bitsD(fn(D0()))); def(n + 'f', () => bitsF(fn(F0()))); def(n + 'l', () => bitsD(fn(D0()))) }
  const d2: [string, (x: number, y: number) => number][] = [['pow', Math.pow], ['atan2', Math.atan2], ['fmod', (x, y) => x % y], ['hypot', Math.hypot], ['fmin', Math.min], ['fmax', Math.max], ['copysign', (x, y) => Math.sign(y) * Math.abs(x) || (Object.is(y, -0) ? -Math.abs(x) : Math.abs(x))], ['remainder', (x, y) => x - roundEven(x / y) * y], ['fdim', (x, y) => Math.max(x - y, 0)]]
  for (const [n, fn] of d2) { def(n, () => bitsD(fn(D0(), D1()))); def(n + 'f', () => bitsF(fn(F0(), F1()))) }
  def('ldexp', () => bitsD(D0() * 2 ** (R(2) | 0))); def('ldexpf', () => bitsF(F0() * 2 ** (R(1) | 0))); def('scalbn', () => bitsD(D0() * 2 ** (R(2) | 0))); def('scalbnf', () => bitsF(F0() * 2 ** (R(1) | 0)))
  const frexp = (x: number) => { if (x === 0 || !isFinite(x)) return [x, 0]; const e = Math.floor(Math.log2(Math.abs(x))) + 1; return [x / 2 ** e, e] }
  def('frexp', () => { const [mm, e] = frexp(D0()); m.w32(R(2), e); return bitsD(mm) })
  def('frexpf', () => { const [mm, e] = frexp(F0()); m.w32(R(1), e); return bitsF(mm) })
  def('modf', () => { const x = D0(), i = Math.trunc(x); m.dv.setFloat64(R(2), i, true); return bitsD(x - i) })
  def('modff', () => { const x = F0(), i = Math.trunc(x); m.dv.setFloat32(R(1), i, true); return bitsF(x - i) })
  def('lrint', () => roundEven(D0()) | 0); def('lrintf', () => roundEven(F0()) | 0); def('lround', () => Math.round(D0()) | 0); def('lroundf', () => Math.round(F0()) | 0)
  def('llrint', () => BigInt.asUintN(64, BigInt(roundEven(D0())))); def('llround', () => BigInt.asUintN(64, BigInt(Math.round(D0()))))
  def('isnan', () => (isNaN(D0()) ? 1 : 0)); def('isnanf', () => (isNaN(F0()) ? 1 : 0)); def('isinf', () => (Math.abs(D0()) === Infinity ? 1 : 0)); def('isinff', () => (Math.abs(F0()) === Infinity ? 1 : 0))
  def('finite', () => (isFinite(D0()) ? 1 : 0)); def('finitef', () => (isFinite(F0()) ? 1 : 0)); def('__isfinite', () => (isFinite(D0()) ? 1 : 0))
  // bionic's fpclassify values are flags (not glibc's 0..4): FP_INFINITE 1, FP_NAN 2, FP_NORMAL 4,
  // FP_SUBNORMAL 8, FP_ZERO 16. code tests them with masks (physx: (c & 3) == 0 for "finite")
  const cls = (x: number, tiny: number) => (isNaN(x) ? 2 : !isFinite(x) ? 1 : x === 0 ? 16 : Math.abs(x) < tiny ? 8 : 4)
  def('__fpclassifyd', () => cls(D0(), 2.2250738585072014e-308)); def('__fpclassifyf', () => cls(F0(), 1.1754943508222875e-38)); def('__fpclassify', () => cls(D0(), 2.2250738585072014e-308))
  def('__signbit', () => (D0() < 0 || Object.is(D0(), -0) ? 1 : 0)); def('__signbitf', () => (F0() < 0 || Object.is(F0(), -0) ? 1 : 0))
  def('sincos', () => { const x = D0(); m.dv.setFloat64(R(2), Math.sin(x), true); m.dv.setFloat64(R(3), Math.cos(x), true) })
  def('sincosf', () => { const x = F0(); m.dv.setFloat32(R(1), Math.sin(x), true); m.dv.setFloat32(R(2), Math.cos(x), true) })
  // integer division helpers (armv7 without the divide instructions)
  def('__aeabi_idiv', () => ((R(1) | 0) === 0 ? 0 : ((R(0) | 0) / (R(1) | 0)) | 0))
  def('__aeabi_uidiv', () => (R(1) === 0 ? 0 : Math.floor(R(0) / R(1))))
  def('__aeabi_idivmod', () => { const a = R(0) | 0, b = R(1) | 0; if (!b) return 0n; const q = (a / b) | 0, r = a - q * b; return (BigInt(r >>> 0) << 32n) | BigInt(q >>> 0) })
  def('__aeabi_uidivmod', () => { const a = R(0), b = R(1); if (!b) return 0n; const q = Math.floor(a / b), r = a - q * b; return (BigInt(r >>> 0) << 32n) | BigInt(q >>> 0) })
  const ll = (lo: number, hi: number) => BigInt.asIntN(64, (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0))
  def('__aeabi_ldivmod', () => { const a = ll(R(0), R(1)), b = ll(R(2), R(3)); if (!b) return 0n; const r = BigInt.asUintN(64, a % b); c.r[2] = Number(r & 0xffffffffn); c.r[3] = Number(r >> 32n); return BigInt.asUintN(64, a / b) })
  def('__aeabi_uldivmod', () => { const a = BigInt.asUintN(64, ll(R(0), R(1))), b = BigInt.asUintN(64, ll(R(2), R(3))); if (!b) return 0n; c.r[2] = Number((a % b) & 0xffffffffn); c.r[3] = Number((a % b) >> 32n); return a / b })
  // long <-> float / double (softfp: floats travel in core registers as raw bits)
  const cv = new DataView(new ArrayBuffer(8))
  const fbits = (x: number) => { cv.setFloat32(0, x, true); return cv.getUint32(0, true) }
  const dbits = (x: number) => { cv.setFloat64(0, x, true); return cv.getBigUint64(0, true) }
  const asF = (u: number) => { cv.setUint32(0, u >>> 0, true); return cv.getFloat32(0, true) }
  const asD = (lo: number, hi: number) => { cv.setUint32(0, lo >>> 0, true); cv.setUint32(4, hi >>> 0, true); return cv.getFloat64(0, true) }
  const toL = (x: number, signed: boolean) => { if (Number.isNaN(x)) return 0n; const t = Math.trunc(x); const v = signed ? (t >= 2 ** 63 ? 2n ** 63n - 1n : t < -(2 ** 63) ? -(2n ** 63n) : BigInt(t)) : (t <= 0 ? 0n : t >= 2 ** 64 ? 2n ** 64n - 1n : BigInt(t)); return BigInt.asUintN(64, v) }
  def('__aeabi_l2f', () => fbits(Number(ll(R(0), R(1)))))
  def('__aeabi_ul2f', () => fbits(Number(BigInt.asUintN(64, ll(R(0), R(1))))))
  def('__aeabi_l2d', () => dbits(Number(ll(R(0), R(1)))))
  def('__aeabi_ul2d', () => dbits(Number(BigInt.asUintN(64, ll(R(0), R(1))))))
  def('__aeabi_f2lz', () => toL(asF(R(0)), true))
  def('__aeabi_f2ulz', () => toL(asF(R(0)), false))
  def('__aeabi_d2lz', () => toL(asD(R(0), R(1)), true))
  def('__aeabi_d2ulz', () => toL(asD(R(0), R(1)), false))

  // ---------- time ----------
  const t0 = performance.now()
  def('time', () => { const t = Math.floor(Date.now() / 1000); if (R(0)) m.w32(R(0), t); return t })
  def('gettimeofday', () => { const t = Date.now(); if (R(0)) { m.w32(R(0), Math.floor(t / 1000)); m.w32(R(0) + 4, (t % 1000) * 1000) } if (R(1)) { m.w32(R(1), 0); m.w32(R(1) + 4, 0) } return 0 })
  // CLOCK_REALTIME 0, MONOTONIC 1, PROCESS / THREAD cputime 2 / 3, MONOTONIC_RAW 4, BOOTTIME 7
  def('clock_gettime', () => {
    const ms = R(0) === 0 ? Date.now() + (performance.now() % 1) : performance.now() - (R(0) === 2 || R(0) === 3 ? t0 : 0)
    m.w32(R(1), Math.floor(ms / 1000)); m.w32(R(1) + 4, Math.floor((ms % 1000) * 1e6))
    return 0
  })
  def('clock_getres', () => { if (R(1)) { m.w32(R(1), 0); m.w32(R(1) + 4, 1000) } return 0 })
  def('clock', () => Math.floor((performance.now() - t0) * 1000))
  def('times', () => { const t = Math.floor((performance.now() - t0) / 10); if (R(0)) { m.w32(R(0), t); m.w32(R(0) + 4, 0); m.w32(R(0) + 8, 0); m.w32(R(0) + 12, 0) } return t })
  def('getrusage', () => { m.u8.fill(0, R(1), R(1) + 72); const t = performance.now() - t0; m.w32(R(1), Math.floor(t / 1000)); m.w32(R(1) + 4, Math.floor((t % 1000) * 1000)); return 0 })
  def('setitimer', () => 0); def('getitimer', () => 0); def('alarm', () => 0)
  // struct tm (int fields): sec min hour mday mon year wday yday isdst gmtoff zone
  const tmBuf = m.malloc(48)
  const writeTm = (dst: number, d: Date, utc: boolean) => {
    const g = (f: string) => (d as any)[(utc ? 'getUTC' : 'get') + f]()
    const vals = [g('Seconds'), g('Minutes'), g('Hours'), g('Date'), g('Month'), g('FullYear') - 1900, g('Day')]
    vals.forEach((v, i) => m.w32(dst + i * 4, v))
    const start = utc ? Date.UTC(d.getUTCFullYear(), 0, 1) : new Date(d.getFullYear(), 0, 1).getTime()
    m.w32(dst + 28, Math.floor((d.getTime() - start) / 864e5)); m.w32(dst + 32, 0); m.w32(dst + 36, utc ? 0 : -d.getTimezoneOffset() * 60); m.w32(dst + 40, 0)
    return dst
  }
  def('gmtime', () => writeTm(tmBuf, new Date(m.r32(R(0)) * 1000), true))
  def('gmtime_r', () => writeTm(R(1), new Date(m.r32(R(0)) * 1000), true))
  def('localtime', () => writeTm(tmBuf, new Date(m.r32(R(0)) * 1000), false))
  def('localtime_r', () => writeTm(R(1), new Date(m.r32(R(0)) * 1000), false))
  const readTm = (a: number) => new Date(m.r32(a + 20) + 1900, m.r32(a + 16), m.r32(a + 12), m.r32(a + 8), m.r32(a + 4), m.r32(a))
  def('mktime', () => Math.floor(readTm(R(0)).getTime() / 1000))
  def('timegm', () => { const a = R(0); return Math.floor(Date.UTC(m.r32(a + 20) + 1900, m.r32(a + 16), m.r32(a + 12), m.r32(a + 8), m.r32(a + 4), m.r32(a)) / 1000) })
  def('difftime', () => bitsD((R(0) | 0) - (R(1) | 0)))
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  def('strftime', () => {
    const d = readTm(R(3)), z = (n: number, w = 2) => String(n).padStart(w, '0')
    const s = cstr(R(2)).replace(/%([a-zA-Z%])/g, (all, k) => ({ Y: String(d.getFullYear()), y: z(d.getFullYear() % 100), m: z(d.getMonth() + 1), d: z(d.getDate()), e: String(d.getDate()).padStart(2), H: z(d.getHours()), I: z(d.getHours() % 12 || 12), M: z(d.getMinutes()), S: z(d.getSeconds()), p: d.getHours() < 12 ? 'AM' : 'PM', a: DAYS[d.getDay()].slice(0, 3), A: DAYS[d.getDay()], b: MONTHS[d.getMonth()].slice(0, 3), h: MONTHS[d.getMonth()].slice(0, 3), B: MONTHS[d.getMonth()], j: z(Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 864e5) + 1, 3), Z: 'UTC', z: '+0000', '%': '%', n: '\n', t: '\t', F: `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`, T: `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`, D: `${z(d.getMonth() + 1)}/${z(d.getDate())}/${z(d.getFullYear() % 100)}`, c: d.toUTCString(), x: d.toLocaleDateString(), X: d.toLocaleTimeString() } as Record<string, string>)[k] ?? all)
    const b = enc.encode(s)
    if (b.length >= R(1)) return 0
    putStr(R(0), s, R(1))
    return b.length
  })
  def('tzset', () => {})
  nat.data('timezone', 4, (a) => m.w32(a, 0))
  nat.data('daylight', 4, (a) => m.w32(a, 0))

  // ---------- process and system ----------
  def('getpid', () => 4242); def('getppid', () => 1); def('getpgrp', () => 4242); def('setsid', () => 4242)
  for (const n of ['getuid', 'geteuid', 'getgid', 'getegid']) def(n, () => 10050)
  def('getresuid', () => { for (let i = 0; i < 3; i++) if (R(i)) m.w32(R(i), 10050); return 0 })
  def('getresgid', () => { for (let i = 0; i < 3; i++) if (R(i)) m.w32(R(i), 10050); return 0 })
  for (const n of ['setuid', 'setgid', 'seteuid', 'setresuid', 'setresgid', 'setpgid']) def(n, () => 0)
  const pw = (() => { const a = m.malloc(40); m.u8.fill(0, a, a + 40); m.w32(a, nat.str('app_50')); m.w32(a + 4, nat.str('')); m.w32(a + 8, 10050); m.w32(a + 12, 10050); m.w32(a + 16, nat.str('/data')); m.w32(a + 20, nat.str('/system/bin/sh')); return a })()
  def('getpwuid', () => pw); def('getpwnam', () => pw)
  def('getpwuid_r', () => { m.w32(S(0), pw); return 0 })
  def('getgrgid', () => 0); def('getgrnam', () => 0); def('getlogin', () => nat.str('app_50'))
  // sysconf: page size, cpus, clock ticks, open files
  def('sysconf', () => ({ 0x27: 4096, 0x28: 4096, 0x60: 1, 0x61: 1, 6: 100, 5: 1024, 0x62: 262144, 0x63: 131072 } as Record<number, number>)[R(0)] ?? -1)
  def('getpagesize', () => 4096)
  nat.data('__page_size', 4, (a) => m.w32(a, 4096))
  def('getdtablesize', () => 1024)
  def('getpriority', () => 0); def('setpriority', () => 0); def('nice', () => 0)
  def('prctl', () => 0)
  def('uname', () => { const a = R(0); m.u8.fill(0, a, a + 65 * 6); ['Linux', 'localhost', '3.4.0-droid', '#1 SMP PREEMPT', 'armv7l', 'localdomain'].forEach((s, i) => putStr(a + i * 65, s, 65)); return 0 })
  def('gethostname', () => { putStr(R(0), 'localhost', R(1)); return 0 })
  def('__system_property_get', () => { const k = cstr(R(0)); const v = ({ 'ro.build.version.sdk': '19', 'ro.build.version.release': '4.4', 'ro.product.model': 'Droid', 'ro.product.manufacturer': 'Danen', 'ro.product.cpu.abi': 'armeabi-v7a', 'ro.hardware': 'droid', 'ro.kernel.qemu': '0', 'ro.debuggable': '0' } as Record<string, string>)[k] ?? ''; return putStr(R(1), v, 92) })
  def('getauxval', () => (R(0) === 16 ? 0x7ffff : R(0) === 6 ? 4096 : 0)) // AT_HWCAP: everything (neon, vfpv3, idiv)

  // ---------- dynamic loading: handles are library indexes + 1 ----------
  let dlErr = 0
  def('dlopen', () => {
    if (!R(0)) return 0x7fff0000 // the main program: searches everything
    const name = cstr(R(0)).split('/').pop()!
    const i = nat.libs.findIndex((l) => l.name === name)
    if (i >= 0) return i + 1
    if (/^lib(c|m|dl|log|z|stdc\+\+|GLESv1_CM|GLESv2|EGL|android|jnigraphics|OpenSLES)\.so$/.test(name)) return 0x7fff0000
    dlErr = nat.str(`dlopen failed: library "${name}" not found`)
    return 0
  })
  def('dlsym', () => {
    const name = cstr(R(1))
    const h = R(0)
    const lib = h > 0 && h <= nat.libs.length ? nat.libs[h - 1] : null
    const a = lib ? lib.exports.get(name) ?? nat.resolveOrZero(name) : nat.resolveOrZero(name)
    if (!a) dlErr = nat.str(`undefined symbol: ${name}`)
    return a
  })
  def('dlclose', () => 0)
  def('dlerror', () => { const e = dlErr; dlErr = 0; return e })
  def('dladdr', () => { const pc = R(0); const l = nat.libs.find((x) => x.segments.some((s) => pc >= s.start && pc < s.end)); if (!l) return 0; m.w32(R(1), nat.str(l.name)); m.w32(R(1) + 4, l.base); m.w32(R(1) + 8, 0); m.w32(R(1) + 12, 0); return 1 })
  // c++ exception tables: the .ARM.exidx of the library that holds pc
  def('__gnu_Unwind_Find_exidx', () => { const pc = R(0); const l = nat.libs.find((x) => x.segments.some((s) => pc >= s.start && pc < s.end)); if (!l || !l.exidx) { m.w32(R(1), 0); return 0 } m.w32(R(1), l.exidx.count); return l.exidx.start })
  def('dl_unwind_find_exidx', () => { const pc = R(0); const l = nat.libs.find((x) => x.segments.some((s) => pc >= s.start && pc < s.end)); if (!l || !l.exidx) { m.w32(R(1), 0); return 0 } m.w32(R(1), l.exidx.count); return l.exidx.start })

  // ---------- c++ runtime bits libraries expect from the system ----------
  // static init guards: first byte = done; a second one marks "in progress"
  def('__cxa_guard_acquire', () => (m.u8[R(0)] ? 0 : (m.u8[R(0) + 1] = 1, 1)))
  def('__cxa_guard_release', () => { m.u8[R(0)] = 1; m.u8[R(0) + 1] = 0 })
  def('__cxa_guard_abort', () => { m.u8[R(0) + 1] = 0 })
  def('__cxa_pure_virtual', () => { throw new Error('pure virtual function called') })
  def('__cxa_call_unexpected', () => { throw new Error('c++ unexpected exception') })
  def('__cxa_begin_cleanup', () => 1)
  def('__cxa_type_match', () => 0)
  def('_Znwj', () => m.malloc(R(0))); def('_Znaj', () => m.malloc(R(0))); def('_ZdlPv', () => { m.free(R(0)) }); def('_ZdaPv', () => { m.free(R(0)) })
  def('_ZnwjRKSt9nothrow_t', () => m.malloc(R(0))); def('_ZnajRKSt9nothrow_t', () => m.malloc(R(0)))

  // ---------- sockets: no networking from native code (yet) ----------
  const net = (ret = -1) => () => { nat.setErrno(97); return ret } // EAFNOSUPPORT
  for (const n of ['socket', 'connect', 'bind', 'listen', 'accept', 'socketpair', 'shutdown']) def(n, net())
  for (const n of ['send', 'sendto', 'sendmsg', 'recv', 'recvfrom', 'recvmsg', 'getsockname', 'getpeername', 'getsockopt', 'setsockopt', 'sendfile']) def(n, net())
  def('select', () => { if (R(4 - 4) === 0 && !S(0)) return 0; return 0 })
  def('poll', () => 0)
  def('epoll_create', () => 100); def('epoll_ctl', () => 0); def('epoll_wait', () => 0)
  def('getaddrinfo', () => -2); def('freeaddrinfo', () => {}); def('gai_strerror', () => nat.str('name resolution is not available'))
  def('gethostbyname', () => 0); def('gethostbyaddr', () => 0); def('__get_h_errno', () => { const a = nat.host.get('__h_errno_slot')!; return a })
  nat.data('__h_errno_slot', 4)
  const ip4 = (s: string) => { const p = s.split('.').map(Number); return p.length === 4 && p.every((x) => x >= 0 && x < 256) ? (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0 : null }
  def('inet_addr', () => ip4(cstr(R(0))) ?? 0xffffffff)
  def('inet_aton', () => { const v = ip4(cstr(R(0))); if (v == null) return 0; m.w32(R(1), v); return 1 })
  def('inet_pton', () => { if (R(0) !== 2) return 0; const v = ip4(cstr(R(1))); if (v == null) return 0; m.w32(R(2), v); return 1 })
  const ipStr = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24].join('.')
  const ntoaBuf = m.malloc(16)
  def('inet_ntoa', () => { putStr(ntoaBuf, ipStr(R(0)), 16); return ntoaBuf })
  def('inet_ntop', () => { if (R(0) !== 2) return 0; putStr(R(2), ipStr(m.r32(R(1))), R(3)); return R(2) })
  def('htonl', () => ((R(0) >>> 24) | ((R(0) >>> 8) & 0xff00) | ((R(0) << 8) & 0xff0000) | (R(0) << 24)) >>> 0)
  def('ntohl', () => ((R(0) >>> 24) | ((R(0) >>> 8) & 0xff00) | ((R(0) << 8) & 0xff0000) | (R(0) << 24)) >>> 0)
  def('htons', () => ((R(0) >>> 8) & 0xff) | ((R(0) & 0xff) << 8)); def('ntohs', () => ((R(0) >>> 8) & 0xff) | ((R(0) & 0xff) << 8))

  // ---------- syscall(n, ...) ----------
  def('syscall', () => {
    const n = R(0)
    if (n === 0xf0002) { c.jit?.invalidate(R(1), R(2)); return 0 } // cacheflush(start, end): compiled blocks there are stale
    if (n === 224) return nat.threads.tid() // gettid
    if (n === 158) return 0 // sched_yield
    if (n === 240) return 0 // futex: bionic's own locks are not used through here
    if (n === 238) return 0 // tkill
    console.warn('native: syscall', n)
    nat.setErrno(38)
    return -1
  })
  def('cacheflush', () => { c.jit?.invalidate(R(0), R(1)); return 0 })
  def('__clear_cache', () => { c.jit?.invalidate(R(0), R(1)); return 0 })

  // ---------- zlib: streaming inflate (inflate.ts), deflate as stored blocks ----------
  // z_stream: next_in 0, avail_in 4, total_in 8, next_out 12, avail_out 16, total_out 20, msg 24, state 28, ... adler 48
  interface Z { mode: 'raw' | 'zlib' | 'gzip' | 'auto'; input: number[]; out: Uint8Array | null; outPos: number; done: boolean; deflate?: boolean; level?: number; inf?: Inflater; head?: number[] }
  const zs = new Map<number, Z>()
  const Z_OK = 0, Z_STREAM_END = 1, Z_BUF_ERROR = -5, Z_DATA_ERROR = -3, Z_FINISH = 4
  const zInit = (s: number, bits: number, deflate = false) => {
    const mode: Z['mode'] = bits < 0 ? 'raw' : bits > 31 ? 'auto' : bits > 15 ? 'gzip' : 'zlib'
    zs.set(s, { mode, input: [], out: null, outPos: 0, done: false, deflate })
    m.w32(s + 8, 0); m.w32(s + 20, 0); m.w32(s + 24, 0); m.w32(s + 28, s)
    return Z_OK
  }
  def('inflateInit_', () => zInit(R(0), 15))
  def('inflateInit2_', () => zInit(R(0), R(1) | 0))
  def('inflateReset', () => { const z = zs.get(R(0)); if (z) { z.inf = undefined; z.head = undefined; z.done = false } m.w32(R(0) + 8, 0); m.w32(R(0) + 20, 0); return Z_OK })
  def('inflateReset2', () => { const z = zs.get(R(0)); if (z) zInit(R(0), R(1) | 0); return Z_OK })
  def('inflateEnd', () => { zs.delete(R(0)); return Z_OK })
  // how long the zlib / gzip header is, once enough of it is there (-1: not yet)
  const headerLen = (b: number[], mode: Z['mode']) => {
    if (mode === 'raw') return 0
    if (b.length < 2) return -1
    if (mode === 'gzip' || (mode === 'auto' && b[0] === 0x1f && b[1] === 0x8b)) {
      if (b.length < 10) return -1
      let p = 10
      const flg = b[3]
      if (flg & 4) { if (b.length < 12) return -1; p += 2 + (b[10] | (b[11] << 8)) }
      if (flg & 8) { while (p < b.length && b[p]) p++; p++ }
      if (flg & 16) { while (p < b.length && b[p]) p++; p++ }
      if (flg & 2) p += 2
      return p <= b.length ? p : -1
    }
    return 2
  }
  def('inflate', () => {
    const s = R(0)
    const z = zs.get(s)
    if (!z) return -2
    let nin = m.r32(s), ain = m.r32(s + 4)
    const nout = m.r32(s + 12), aout = m.r32(s + 16)
    if (!z.inf) {
      // the header first (it can come in pieces too)
      z.head ??= []
      while (ain > 0 && headerLen(z.head, z.mode) < 0) { z.head.push(m.u8[nin++]); ain-- }
      const h = headerLen(z.head, z.mode)
      if (h < 0) { m.w32(s, nin); m.w32(s + 4, 0); m.w32(s + 8, m.r32(s + 8) + m.r32(s + 4)); return Z_OK }
      z.inf = new Inflater()
      if (z.head.length > h) z.inf.push(Uint8Array.from(z.head.slice(h)))
      z.head = undefined
    }
    const inf = z.inf
    const before = ain
    if (ain > 0 && !inf.done) { inf.push(m.u8.subarray(nin, nin + ain)); nin += ain; ain = 0 }
    let wrote = 0
    try {
      for (;;) {
        const t = inf.take(aout - wrote)
        if (t.length) { m.u8.set(t, nout + wrote); wrote += t.length }
        if (wrote >= aout) break
        if (inf.done || !inf.run(aout - wrote)) { const t2 = inf.take(aout - wrote); if (t2.length) { m.u8.set(t2, nout + wrote); wrote += t2.length; continue } break }
      }
      // with nothing left to hand out, still decode up to the next byte: the stream may end there
      if (!inf.done && inf.n === inf.read) inf.run(1)
    } catch { m.w32(s + 24, 0); return Z_DATA_ERROR }
    // like zlib, input is only used as far as the output needed it: the rest goes back to the caller
    // (libpng reads the next chunk only once the input is used up). after the end of the stream, the
    // bytes past it go back too, minus the adler / crc trailer
    let given = before - ain
    const finished = inf.done && inf.n === inf.read
    if (inf.done && before) {
      const trailer = z.mode === 'raw' ? 0 : z.mode === 'zlib' ? 4 : 8
      const back = Math.min(given, Math.max(0, inf.unused - trailer))
      nin -= back; given -= back; ain += back
    } else if (given && inf.n > inf.read) { const back = inf.unpush(given); nin -= back; given -= back; ain += back }
    m.w32(s, nin); m.w32(s + 4, ain); m.w32(s + 8, m.r32(s + 8) + given)
    m.w32(s + 12, nout + wrote); m.w32(s + 16, aout - wrote); m.w32(s + 20, m.r32(s + 20) + wrote)
    const ret_ = finished ? Z_STREAM_END : wrote || given ? Z_OK : Z_BUF_ERROR
    return ret_
  })
  def('deflateInit_', () => zInit(R(0), 15, true))
  def('deflateInit2_', () => zInit(R(0), S(0) | 0, true))
  def('deflateReset', () => { const z = zs.get(R(0)); if (z) { z.input = []; z.out = null; z.outPos = 0 } return Z_OK })
  def('deflateEnd', () => { zs.delete(R(0)); return Z_OK })
  def('deflateBound', () => R(1) + Math.ceil(R(1) / 65535) * 5 + 32)
  def('deflate', () => {
    const s = R(0), flush = R(1)
    const z = zs.get(s)
    if (!z) return -2
    const nin = m.r32(s), ain = m.r32(s + 4)
    for (let i = 0; i < ain; i++) z.input.push(m.u8[nin + i])
    m.w32(s, nin + ain); m.w32(s + 4, 0); m.w32(s + 8, m.r32(s + 8) + ain)
    if (flush !== Z_FINISH) return Z_OK
    if (!z.out) z.out = storedStream(Uint8Array.from(z.input), z.mode)
    const nout = m.r32(s + 12), aout = m.r32(s + 16)
    const k = Math.min(aout, z.out.length - z.outPos)
    m.u8.set(z.out.subarray(z.outPos, z.outPos + k), nout)
    z.outPos += k
    m.w32(s + 12, nout + k); m.w32(s + 16, aout - k); m.w32(s + 20, m.r32(s + 20) + k)
    return z.outPos >= z.out.length ? Z_STREAM_END : Z_OK
  })
  const crcTable = new Uint32Array(256).map((_, n) => { let x = n; for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1; return x >>> 0 })
  const crc32 = (crc: number, b: Uint8Array) => { let x = ~crc >>> 0; for (let i = 0; i < b.length; i++) x = crcTable[(x ^ b[i]) & 0xff] ^ (x >>> 8); return ~x >>> 0 }
  const adler = (b: Uint8Array, start = 1) => { let a = start & 0xffff, d = start >>> 16; for (let i = 0; i < b.length; i++) { a = (a + b[i]) % 65521; d = (d + a) % 65521 } return ((d << 16) | a) >>> 0 }
  def('crc32', () => (R(1) ? crc32(R(0), m.u8.subarray(R(1), R(1) + R(2))) : 0))
  def('adler32', () => (R(1) ? adler(m.u8.subarray(R(1), R(1) + R(2)), R(0)) : 1))
  const storedStream = (b: Uint8Array, mode: Z['mode']) => {
    const parts: number[] = []
    if (mode === 'zlib') parts.push(0x78, 0x01)
    if (mode === 'gzip') parts.push(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3)
    for (let i = 0; i < b.length || i === 0; i += 65535) {
      const n = Math.min(65535, b.length - i), last = i + 65535 >= b.length ? 1 : 0
      parts.push(last, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255)
      for (let j = 0; j < n; j++) parts.push(b[i + j])
      if (!b.length) break
    }
    if (mode === 'zlib') { const a = adler(b); parts.push(a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255) }
    if (mode === 'gzip') { const cr = crc32(0, b); parts.push(cr & 255, (cr >>> 8) & 255, (cr >>> 16) & 255, cr >>> 24, b.length & 255, (b.length >>> 8) & 255, (b.length >>> 16) & 255, b.length >>> 24) }
    return Uint8Array.from(parts)
  }
  def('compress', () => { const out = storedStream(m.u8.slice(R(2), R(2) + R(3)), 'zlib'); m.u8.set(out, R(0)); m.w32(R(1), out.length); return Z_OK })
  def('compress2', () => { const out = storedStream(m.u8.slice(R(2), R(2) + R(3)), 'zlib'); m.u8.set(out, R(0)); m.w32(R(1), out.length); return Z_OK })
  def('compressBound', () => R(0) + Math.ceil(R(0) / 65535) * 5 + 16)
  def('uncompress', () => { try { const out = inflateRawSync(m.u8.slice(R(2) + 2, R(2) + R(3))); m.u8.set(out.subarray(0, m.r32(R(1))), R(0)); m.w32(R(1), Math.min(out.length, m.r32(R(1)))); return Z_OK } catch { return Z_DATA_ERROR } })
  def('zlibVersion', () => nat.str('1.2.8'))
  def('zError', () => nat.str('zlib error'))

  // ---------- sha1 (bionic exports it; SHA1_CTX: state[5], count u64, buffer[64]) ----------
  const sha = new Map<number, number[]>()
  def('SHA1Init', () => { sha.set(R(0), []) })
  def('SHA1Update', () => { const l = sha.get(R(0)) ?? []; for (let i = 0; i < R(2); i++) l.push(m.u8[R(1) + i]); sha.set(R(0), l) })
  def('SHA1Final', () => { const d = sha1(Uint8Array.from(sha.get(R(1)) ?? [])); m.u8.set(d, R(0)); sha.delete(R(1)) })
  const sha1 = (msg: Uint8Array) => {
    const l = msg.length, words = new Uint32Array((((l + 8) >> 6) + 1) * 16)
    for (let i = 0; i < l; i++) words[i >> 2] |= msg[i] << (24 - (i % 4) * 8)
    words[l >> 2] |= 0x80 << (24 - (l % 4) * 8)
    words[words.length - 1] = l * 8
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
    const w = new Uint32Array(80)
    for (let i = 0; i < words.length; i += 16) {
      for (let t = 0; t < 80; t++) w[t] = t < 16 ? words[i + t] : ((w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]) << 1) | ((w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]) >>> 31)
      let a = h0, b = h1, cc = h2, d = h3, e = h4
      for (let t = 0; t < 80; t++) {
        const f = t < 20 ? (b & cc) | (~b & d) : t < 40 ? b ^ cc ^ d : t < 60 ? (b & cc) | (b & d) | (cc & d) : b ^ cc ^ d
        const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6
        const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0
        e = d; d = cc; cc = (b << 30) | (b >>> 2); b = a; a = tmp
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + cc) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
    }
    const out = new Uint8Array(20)
    ;[h0, h1, h2, h3, h4].forEach((h, i) => { out[i * 4] = h >>> 24; out[i * 4 + 1] = (h >>> 16) & 255; out[i * 4 + 2] = (h >>> 8) & 255; out[i * 4 + 3] = h & 255 })
    return out
  }
  void dec
}

function roundEven(x: number) { const r = Math.round(x); return Math.abs(x % 1) === 0.5 ? (r % 2 === 0 ? r : r - 1) : r }
