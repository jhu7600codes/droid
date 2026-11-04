// framework shim, part 3: java.io on a small in-memory file system (shared with the native side).
// seeded with what apps look at on a phone (/proc/cpuinfo, /proc/meminfo); the app's own files
// live under /data/data/<pkg>/ and stay for the session.
import { VM, JObject, JArray, type NativeFn } from './dalvik.ts'

const OBJ = 'Ljava/lang/Object;'
const enc = new TextEncoder(), dec = new TextDecoder()

export class Vfs {
  files = new Map<string, Uint8Array>()
  dirs = new Set<string>(['/', '/proc', '/data', '/data/data', '/sdcard', '/system', '/system/lib'])
  constructor() {
    this.text('/proc/cpuinfo', [
      'Processor\t: ARMv7 Processor rev 0 (v7l)', 'processor\t: 0', 'BogoMIPS\t: 1500.00', '',
      'Features\t: swp half thumb fastmult vfp edsp neon vfpv3 tls vfpv4 idiva idivt', 'CPU implementer\t: 0x51',
      'CPU architecture: 7', 'CPU variant\t: 0x0', 'CPU part\t: 0x06f', 'CPU revision\t: 0', '', 'Hardware\t: Droid', 'Revision\t: 0000', 'Serial\t\t: 0000000000000000', '',
    ].join('\n'))
    this.text('/proc/meminfo', 'MemTotal:        1048576 kB\nMemFree:          524288 kB\nBuffers:           16384 kB\nCached:           131072 kB\n')
  }
  norm(p: string) {
    const out: string[] = []
    for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s) }
    return '/' + out.join('/')
  }
  text(p: string, s: string) { this.write(p, enc.encode(s)) }
  write(p: string, b: Uint8Array) { p = this.norm(p); this.mkdirs(p.slice(0, p.lastIndexOf('/')) || '/'); this.files.set(p, b) }
  read(p: string) { return this.files.get(this.norm(p)) ?? null }
  exists(p: string) { p = this.norm(p); return this.files.has(p) || this.dirs.has(p) }
  isDir(p: string) { return this.dirs.has(this.norm(p)) }
  mkdirs(p: string) { p = this.norm(p); const parts = p.split('/').filter(Boolean); let cur = ''; for (const s of parts) { cur += '/' + s; this.dirs.add(cur) } this.dirs.add('/') ; return true }
  remove(p: string) { p = this.norm(p); return this.files.delete(p) || this.dirs.delete(p) }
  list(p: string) {
    p = this.norm(p)
    const pre = p === '/' ? '/' : p + '/'
    const names = new Set<string>()
    for (const k of [...this.files.keys(), ...this.dirs]) if (k.startsWith(pre) && k !== p) names.add(k.slice(pre.length).split('/')[0])
    return [...names]
  }
}

export function registerJavaIo(vm: VM, fs: Vfs) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => vm.shim(name, { super: sup, methods, ...extra })
  const fnf = (p: string) => vm.error('Ljava/io/FileNotFoundException;', `${p}: open failed: ENOENT (No such file or directory)`)
  const bytesOf = (a: JArray) => new Uint8Array((a.data as Int8Array).buffer, (a.data as Int8Array).byteOffset, a.data.length)

  vm.shim('Ljava/io/FileNotFoundException;', { super: 'Ljava/io/IOException;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m }, '<init>()V': () => {} } })
  vm.shim('Ljava/io/EOFException;', { super: 'Ljava/io/IOException;', methods: { '<init>()V': () => {} } })
  def('Ljava/io/Closeable;', OBJ, {})
  def('Ljava/io/Flushable;', OBJ, {})

  // ---------- File ----------
  const path = (s: JObject): string => s.f.path
  const file = (p: string) => { const f = new JObject(vm.cls('Ljava/io/File;')); f.f.path = fs.norm(p); return f }
  def('Ljava/io/File;', OBJ, {
    '<init>(Ljava/lang/String;)V': (v, s, [p]) => { s.f.path = fs.norm(p) },
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [d, n]) => { s.f.path = fs.norm((d ?? '') + '/' + n) },
    '<init>(Ljava/io/File;Ljava/lang/String;)V': (v, s, [d, n]) => { s.f.path = fs.norm((d ? path(d) : '') + '/' + n) },
    'getPath()Ljava/lang/String;': (v, s) => path(s),
    'getAbsolutePath()Ljava/lang/String;': (v, s) => path(s),
    'getCanonicalPath()Ljava/lang/String;': (v, s) => path(s),
    'getAbsoluteFile()Ljava/io/File;': (v, s) => s,
    'getName()Ljava/lang/String;': (v, s) => path(s).split('/').pop() || '',
    'getParent()Ljava/lang/String;': (v, s) => path(s).slice(0, path(s).lastIndexOf('/')) || '/',
    'getParentFile()Ljava/io/File;': (v, s) => file(path(s).slice(0, path(s).lastIndexOf('/')) || '/'),
    'exists()Z': (v, s) => (fs.exists(path(s)) ? 1 : 0),
    'isDirectory()Z': (v, s) => (fs.isDir(path(s)) ? 1 : 0),
    'isFile()Z': (v, s) => (fs.read(path(s)) ? 1 : 0),
    'canRead()Z': (v, s) => (fs.exists(path(s)) ? 1 : 0),
    'canWrite()Z': () => 1,
    'length()J': (v, s) => BigInt(fs.read(path(s))?.length ?? 0),
    'lastModified()J': () => BigInt(Date.now()),
    'mkdir()Z': (v, s) => (fs.mkdirs(path(s)) ? 1 : 0),
    'mkdirs()Z': (v, s) => (fs.mkdirs(path(s)) ? 1 : 0),
    'delete()Z': (v, s) => (fs.remove(path(s)) ? 1 : 0),
    'createNewFile()Z': (v, s) => { if (fs.exists(path(s))) return 0; fs.write(path(s), new Uint8Array()); return 1 },
    'renameTo(Ljava/io/File;)Z': (v, s, [to]) => { const b = fs.read(path(s)); if (!b) return 0; fs.remove(path(s)); fs.write(path(to), b); return 1 },
    'list()[Ljava/lang/String;': (v, s) => { if (!fs.isDir(path(s))) return null; const n = fs.list(path(s)); const a = vm.newArray('[Ljava/lang/String;', n.length); n.forEach((x, i) => (a.data[i] = x)); return a },
    'listFiles()[Ljava/io/File;': (v, s) => { if (!fs.isDir(path(s))) return null; const n = fs.list(path(s)); const a = vm.newArray('[Ljava/io/File;', n.length); n.forEach((x, i) => (a.data[i] = file(path(s) + '/' + x))); return a },
    'toString()Ljava/lang/String;': (v, s) => path(s),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o?.f?.path === path(s) ? 1 : 0),
    'hashCode()I': (v, s) => { let h = 0; for (const c of path(s)) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0; return h },
    'getFreeSpace()J': () => 1n << 30n, 'getTotalSpace()J': () => 4n << 30n, 'getUsableSpace()J': () => 1n << 30n,
    'setReadable(Z)Z': () => 1, 'setWritable(Z)Z': () => 1, 'setExecutable(Z)Z': () => 1,
  }, { statics: { separator: '/', separatorChar: 47, pathSeparator: ':', pathSeparatorChar: 58 } })

  // ---------- byte streams ----------
  // an input stream object keeps { buf: Uint8Array, pos }
  const inMethods = (): Record<string, NativeFn> => ({
    'read()I': (v, s) => (s.f.pos < s.f.buf.length ? s.f.buf[s.f.pos++] : -1),
    'read([B)I': (v, s, [a]) => readInto(s, a, 0, a.data.length),
    'read([BII)I': (v, s, [a, off, n]) => readInto(s, a, off, n),
    'available()I': (v, s) => s.f.buf.length - s.f.pos,
    'skip(J)J': (v, s, [n]) => { const k = Math.min(Number(n), s.f.buf.length - s.f.pos); s.f.pos += k; return BigInt(k) },
    'close()V': () => {},
    'mark(I)V': (v, s) => { s.f.mark = s.f.pos },
    'reset()V': (v, s) => { s.f.pos = s.f.mark ?? 0 },
    'markSupported()Z': () => 1,
  })
  const readInto = (s: JObject, a: JArray, off: number, n: number) => {
    const left = s.f.buf.length - s.f.pos
    if (left <= 0) return n === 0 ? 0 : -1
    const k = Math.min(n, left)
    bytesOf(a).set(s.f.buf.subarray(s.f.pos, s.f.pos + k), off)
    s.f.pos += k
    return k
  }
  def('Ljava/io/InputStream;', OBJ, { '<init>()V': () => {}, ...inMethods() }, { interfaces: ['Ljava/io/Closeable;'] })
  const openIn = (s: JObject, p: string) => { const b = fs.read(p); if (!b) throw fnf(p); s.f.buf = b; s.f.pos = 0 }
  def('Ljava/io/FileInputStream;', 'Ljava/io/InputStream;', {
    '<init>(Ljava/lang/String;)V': (v, s, [p]) => openIn(s, p),
    '<init>(Ljava/io/File;)V': (v, s, [f]) => openIn(s, path(f)),
  })
  def('Ljava/io/ByteArrayInputStream;', 'Ljava/io/InputStream;', {
    '<init>([B)V': (v, s, [a]) => { s.f.buf = bytesOf(a).slice(); s.f.pos = 0 },
    '<init>([BII)V': (v, s, [a, o, n]) => { s.f.buf = bytesOf(a).slice(o, o + n); s.f.pos = 0 },
  })
  def('Ljava/io/BufferedInputStream;', 'Ljava/io/InputStream;', {
    '<init>(Ljava/io/InputStream;)V': (v, s, [i]) => { s.f.buf = drain(i); s.f.pos = 0 },
    '<init>(Ljava/io/InputStream;I)V': (v, s, [i]) => { s.f.buf = drain(i); s.f.pos = 0 },
  })
  // any input stream into bytes (our own streams directly, others through read())
  const drain = (i: JObject): Uint8Array => {
    if (i?.f?.buf instanceof Uint8Array) return i.f.buf.subarray(i.f.pos)
    const out: number[] = []
    for (let b; (b = vm.callVirtual(i, 'read()I')) >= 0;) out.push(b)
    return Uint8Array.from(out)
  }

  // output streams collect bytes; file streams write the file on every flush / close
  const outMethods = (): Record<string, NativeFn> => ({
    'write(I)V': (v, s, [b]) => { push(s, Uint8Array.of(b & 0xff)) },
    'write([B)V': (v, s, [a]) => { push(s, bytesOf(a).slice()) },
    'write([BII)V': (v, s, [a, o, n]) => { push(s, bytesOf(a).slice(o, o + n)) },
    'flush()V': (v, s) => s.f.sync?.(),
    'close()V': (v, s) => s.f.sync?.(),
  })
  const push = (s: JObject, b: Uint8Array) => {
    const cur: Uint8Array = s.f.buf ?? new Uint8Array(0)
    const n = new Uint8Array(cur.length + b.length); n.set(cur); n.set(b, cur.length)
    s.f.buf = n
    if (s.f.target) vm.callVirtual(s.f.target, 'write([B)V', [byteArray(b)])
  }
  const byteArray = (b: Uint8Array) => { const a = vm.newArray('[B', b.length); (a.data as Int8Array).set(new Int8Array(b.buffer, b.byteOffset, b.length)); return a }
  def('Ljava/io/OutputStream;', OBJ, { '<init>()V': () => {}, ...outMethods() }, { interfaces: ['Ljava/io/Closeable;', 'Ljava/io/Flushable;'] })
  const openOut = (s: JObject, p: string, append: boolean) => { s.f.buf = append ? fs.read(p) ?? new Uint8Array() : new Uint8Array(); s.f.sync = () => fs.write(p, s.f.buf); s.f.sync() }
  def('Ljava/io/FileOutputStream;', 'Ljava/io/OutputStream;', {
    '<init>(Ljava/lang/String;)V': (v, s, [p]) => openOut(s, p, false),
    '<init>(Ljava/lang/String;Z)V': (v, s, [p, ap]) => openOut(s, p, !!ap),
    '<init>(Ljava/io/File;)V': (v, s, [f]) => openOut(s, path(f), false),
    '<init>(Ljava/io/File;Z)V': (v, s, [f, ap]) => openOut(s, path(f), !!ap),
  })
  def('Ljava/io/ByteArrayOutputStream;', 'Ljava/io/OutputStream;', {
    '<init>()V': (v, s) => { s.f.buf = new Uint8Array() },
    '<init>(I)V': (v, s) => { s.f.buf = new Uint8Array() },
    'toByteArray()[B': (v, s) => byteArray(s.f.buf),
    'size()I': (v, s) => s.f.buf.length,
    'reset()V': (v, s) => { s.f.buf = new Uint8Array() },
    'toString()Ljava/lang/String;': (v, s) => dec.decode(s.f.buf),
    'toString(Ljava/lang/String;)Ljava/lang/String;': (v, s) => dec.decode(s.f.buf),
  })
  def('Ljava/io/BufferedOutputStream;', 'Ljava/io/OutputStream;', {
    '<init>(Ljava/io/OutputStream;)V': (v, s, [o]) => { s.f.target = o; s.f.sync = () => vm.callVirtual(o, 'flush()V') },
    '<init>(Ljava/io/OutputStream;I)V': (v, s, [o]) => { s.f.target = o; s.f.sync = () => vm.callVirtual(o, 'flush()V') },
  })

  // ---------- character streams ----------
  // readers decode the whole source up front: { text, pos }
  const readerMethods = (): Record<string, NativeFn> => ({
    'read()I': (v, s) => (s.f.pos < s.f.text.length ? s.f.text.charCodeAt(s.f.pos++) : -1),
    'read([C)I': (v, s, [a]) => readChars(s, a, 0, a.data.length),
    'read([CII)I': (v, s, [a, o, n]) => readChars(s, a, o, n),
    'ready()Z': (v, s) => (s.f.pos < s.f.text.length ? 1 : 0),
    'close()V': () => {},
    'skip(J)J': (v, s, [n]) => { const k = Math.min(Number(n), s.f.text.length - s.f.pos); s.f.pos += k; return BigInt(k) },
    'readLine()Ljava/lang/String;': (v, s) => {
      const t: string = s.f.text
      if (s.f.pos >= t.length) return null
      let e = t.indexOf('\n', s.f.pos)
      if (e < 0) e = t.length
      let line = t.slice(s.f.pos, e)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      s.f.pos = e + 1
      s.f.line = (s.f.line ?? 0) + 1
      return line
    },
    'getLineNumber()I': (v, s) => s.f.line ?? 0,
  })
  const readChars = (s: JObject, a: JArray, o: number, n: number) => {
    const left = s.f.text.length - s.f.pos
    if (left <= 0) return -1
    const k = Math.min(n, left)
    for (let i = 0; i < k; i++) a.data[o + i] = s.f.text.charCodeAt(s.f.pos + i)
    s.f.pos += k
    return k
  }
  const textOf = (r: JObject): string => {
    if (typeof r?.f?.text === 'string') return r.f.text.slice(r.f.pos)
    let out = ''
    for (let c; (c = vm.callVirtual(r, 'read()I')) >= 0;) out += String.fromCharCode(c)
    return out
  }
  def('Ljava/io/Reader;', OBJ, { '<init>()V': (v, s) => { s.f.text = ''; s.f.pos = 0 }, ...readerMethods() }, { interfaces: ['Ljava/io/Closeable;'] })
  const fromText = (s: JObject, t: string) => { s.f.text = t; s.f.pos = 0 }
  def('Ljava/io/InputStreamReader;', 'Ljava/io/Reader;', {
    '<init>(Ljava/io/InputStream;)V': (v, s, [i]) => fromText(s, dec.decode(drain(i))),
    '<init>(Ljava/io/InputStream;Ljava/lang/String;)V': (v, s, [i]) => fromText(s, dec.decode(drain(i))),
  })
  def('Ljava/io/FileReader;', 'Ljava/io/InputStreamReader;', {
    '<init>(Ljava/lang/String;)V': (v, s, [p]) => { const b = fs.read(p); if (!b) throw fnf(p); fromText(s, dec.decode(b)) },
    '<init>(Ljava/io/File;)V': (v, s, [f]) => { const b = fs.read(path(f)); if (!b) throw fnf(path(f)); fromText(s, dec.decode(b)) },
  })
  def('Ljava/io/StringReader;', 'Ljava/io/Reader;', { '<init>(Ljava/lang/String;)V': (v, s, [t]) => fromText(s, t ?? '') })
  def('Ljava/io/BufferedReader;', 'Ljava/io/Reader;', {
    '<init>(Ljava/io/Reader;)V': (v, s, [r]) => fromText(s, textOf(r)),
    '<init>(Ljava/io/Reader;I)V': (v, s, [r]) => fromText(s, textOf(r)),
  })
  def('Ljava/io/LineNumberReader;', 'Ljava/io/BufferedReader;', {
    '<init>(Ljava/io/Reader;)V': (v, s, [r]) => fromText(s, textOf(r)),
    '<init>(Ljava/io/Reader;I)V': (v, s, [r]) => fromText(s, textOf(r)),
  })
  const writerMethods = (): Record<string, NativeFn> => ({
    'write(Ljava/lang/String;)V': (v, s, [t]) => wr(s, String(t)),
    'write(I)V': (v, s, [c]) => wr(s, String.fromCharCode(c)),
    'write([C)V': (v, s, [a]) => wr(s, String.fromCharCode(...a.data)),
    'write([CII)V': (v, s, [a, o, n]) => wr(s, String.fromCharCode(...Array.prototype.slice.call(a.data, o, o + n))),
    'write(Ljava/lang/String;II)V': (v, s, [t, o, n]) => wr(s, String(t).slice(o, o + n)),
    'append(Ljava/lang/CharSequence;)Ljava/io/Writer;': (v, s, [t]) => { wr(s, String(t)); return s },
    'newLine()V': (v, s) => wr(s, '\n'),
    'flush()V': (v, s) => s.f.sync?.(),
    'close()V': (v, s) => s.f.sync?.(),
    'toString()Ljava/lang/String;': (v, s) => s.f.out ?? '',
  })
  const wr = (s: JObject, t: string) => { s.f.out = (s.f.out ?? '') + t; if (s.f.target) vm.callVirtual(s.f.target, 'write(Ljava/lang/String;)V', [t]) }
  def('Ljava/io/Writer;', OBJ, { '<init>()V': () => {}, ...writerMethods() }, { interfaces: ['Ljava/io/Closeable;', 'Ljava/io/Flushable;'] })
  def('Ljava/io/StringWriter;', 'Ljava/io/Writer;', { '<init>()V': (v, s) => { s.f.out = '' }, 'getBuffer()Ljava/lang/StringBuffer;': (v, s) => s.f.out })
  def('Ljava/io/FileWriter;', 'Ljava/io/Writer;', {
    '<init>(Ljava/lang/String;)V': (v, s, [p]) => { s.f.out = ''; s.f.sync = () => fs.text(p, s.f.out) },
    '<init>(Ljava/io/File;)V': (v, s, [f]) => { s.f.out = ''; s.f.sync = () => fs.text(path(f), s.f.out) },
    '<init>(Ljava/lang/String;Z)V': (v, s, [p, ap]) => { s.f.out = ap ? dec.decode(fs.read(p) ?? new Uint8Array()) : ''; s.f.sync = () => fs.text(p, s.f.out) },
  })
  def('Ljava/io/OutputStreamWriter;', 'Ljava/io/Writer;', {
    '<init>(Ljava/io/OutputStream;)V': (v, s, [o]) => { s.f.sync = () => { vm.callVirtual(o, 'write([B)V', [byteArray(enc.encode(s.f.out ?? ''))]); s.f.out = ''; vm.callVirtual(o, 'flush()V') } },
    '<init>(Ljava/io/OutputStream;Ljava/lang/String;)V': (v, s, [o]) => { s.f.sync = () => { vm.callVirtual(o, 'write([B)V', [byteArray(enc.encode(s.f.out ?? ''))]); s.f.out = ''; vm.callVirtual(o, 'flush()V') } },
  })
  def('Ljava/io/BufferedWriter;', 'Ljava/io/Writer;', {
    '<init>(Ljava/io/Writer;)V': (v, s, [w]) => { s.f.sync = () => { vm.callVirtual(w, 'write(Ljava/lang/String;)V', [s.f.out ?? '']); s.f.out = ''; vm.callVirtual(w, 'flush()V') } },
    '<init>(Ljava/io/Writer;I)V': (v, s, [w]) => { s.f.sync = () => { vm.callVirtual(w, 'write(Ljava/lang/String;)V', [s.f.out ?? '']); s.f.out = ''; vm.callVirtual(w, 'flush()V') } },
  })
  return { file }
}
