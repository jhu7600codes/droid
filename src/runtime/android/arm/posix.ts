// files, stdio and memory mapping for native code, on the runtime's in-memory file system (javaio.ts).
// fds 0-2 go to the console; the app's apk is a file there too (engines read their data from it).
// /proc/self/maps is generated from the loaded libraries (garbage collectors read it).
import type { CPU } from './cpu.ts'
import type { Native } from './native.ts'

const ENOENT = 2, EBADF = 9, EACCES = 13, EEXIST = 17, ENOTDIR = 20, EISDIR = 21, EINVAL = 22, ENOSYS = 38, ESPIPE = 29
const O_ACCMODE = 3, O_CREAT = 0x40, O_EXCL = 0x80, O_TRUNC = 0x200, O_APPEND = 0x400, O_DIRECTORY = 0x4000

interface Fd { path: string; data: Uint8Array; pos: number; flags: number; dirty: boolean; dir?: string[]; console?: 'out' | 'err' | 'in' }

export function installPosix(nat: Native) {
  const m = nat.mem, c = nat.cpu
  const R = (i: number) => c.r[i]
  const S = (i: number) => m.r32(c.r[13] + i * 4) // stack argument i (after r0-r3)
  const def = (name: string, fn: (cpu: CPU) => any) => nat.def(name, fn)
  const fs = nat.vfs!
  const err = (e: number) => { nat.setErrno(e); return -1 }
  const enc = new TextEncoder(), dec = new TextDecoder()
  const fds = new Map<number, Fd>()
  fds.set(0, { path: '/dev/stdin', data: new Uint8Array(), pos: 0, flags: 0, dirty: false, console: 'in' })
  fds.set(1, { path: '/dev/stdout', data: new Uint8Array(), pos: 0, flags: 1, dirty: false, console: 'out' })
  fds.set(2, { path: '/dev/stderr', data: new Uint8Array(), pos: 0, flags: 1, dirty: false, console: 'err' })
  let nextFd = 3
  const lines: Record<string, string> = { out: '', err: '' }
  const consoleWrite = (k: 'out' | 'err', b: Uint8Array) => {
    lines[k] += dec.decode(b)
    let i
    while ((i = lines[k].indexOf('\n')) >= 0) { const l = lines[k].slice(0, i); lines[k] = lines[k].slice(i + 1); (k === 'err' ? console.warn : console.log)('[native] ' + l) }
  }
  const procText = (p: string): string | null => {
    if (p === '/proc/self/maps' || /^\/proc\/\d+\/maps$/.test(p)) return maps()
    if (p === '/proc/self/stat' || /^\/proc\/\d+\/stat$/.test(p)) return '4242 (droid) R 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0\n'
    if (p === '/proc/self/status') return 'Name:\tdroid\nState:\tR (running)\nPid:\t4242\nVmRSS:\t65536 kB\n'
    if (p === '/proc/self/cmdline') return nat.vm ? 'droid\0' : ''
    if (p === '/proc/self/exe') return ''
    // (boehm gc counts the cpuN lines and wants more than 100 bytes)
    if (p === '/proc/stat') return 'cpu  4705 356 584 3699176 23060 0 277 0 0 0\ncpu0 1393 280 234 925349 5800 0 166 0 0 0\ncpu1 1137 23 112 924938 5751 0 50 0 0 0\nintr 114930548 113199788 3 0 5 263 0 4 [...]\nctxt 1990473\nbtime 1062191376\nprocesses 2915\nprocs_running 1\nprocs_blocked 0\n'
    return null
  }
  const hex = (x: number) => (x >>> 0).toString(16).padStart(8, '0')
  const maps = () => {
    const out: string[] = []
    for (const l of nat.libs) for (const s of l.segments) out.push(`${hex(s.start)}-${hex(s.end)} ${s.prot} 00000000 b3:19 1 /data/data/${nat.pkg}/lib/${l.name}`)
    out.push(`${hex(nat.heapStart)}-${hex(m.brk)} rw-p 00000000 00:00 0 [heap]`)
    const st = nat.threads.mainStackBase
    out.push(`${hex(st)}-${hex(st + nat.threads.mainStackSize)} rw-p 00000000 00:00 0 [stack]`)
    return out.join('\n') + '\n'
  }
  const openPath = (path: string, flags: number): number => {
    const p = fs.norm(path)
    const proc = procText(p)
    if (proc != null) { const fd = nextFd++; fds.set(fd, { path: p, data: enc.encode(proc), pos: 0, flags, dirty: false }); return fd }
    if (p === '/dev/null' || p === '/dev/zero' || p === '/dev/urandom' || p === '/dev/random') { const fd = nextFd++; fds.set(fd, { path: p, data: new Uint8Array(), pos: 0, flags, dirty: false }); return fd }
    if (fs.isDir(p)) { if ((flags & O_ACCMODE) !== 0) return err(EISDIR); const fd = nextFd++; fds.set(fd, { path: p, data: new Uint8Array(), pos: 0, flags, dirty: false, dir: fs.list(p) }); return fd }
    if (flags & O_DIRECTORY) return err(ENOTDIR)
    let data = fs.read(p)
    if (data && (flags & O_CREAT) && (flags & O_EXCL)) return err(EEXIST)
    if (!data) { if (!(flags & O_CREAT)) return err(ENOENT); data = new Uint8Array(); fs.write(p, data) }
    if (flags & O_TRUNC) { data = new Uint8Array(); fs.write(p, data) }
    const fd = nextFd++
    fds.set(fd, { path: p, data, pos: flags & O_APPEND ? data.length : 0, flags, dirty: false })
    return fd
  }
  const fdRead = (f: Fd, dst: number, n: number) => {
    if (f.console) return 0
    if (f.path === '/dev/zero') { m.u8.fill(0, dst, dst + n); return n }
    if (f.path === '/dev/urandom' || f.path === '/dev/random') { for (let i = 0; i < n; i += 65536) { const b = new Uint8Array(Math.min(65536, n - i)); crypto.getRandomValues(b); m.u8.set(b, dst + i) } return n }
    const k = Math.max(0, Math.min(n, f.data.length - f.pos))
    m.u8.set(f.data.subarray(f.pos, f.pos + k), dst)
    f.pos += k
    return k
  }
  const fdWrite = (f: Fd, src: number, n: number) => {
    const b = m.u8.slice(src, src + n)
    if (f.console) { if (f.console !== 'in') consoleWrite(f.console, b); return n }
    if (f.path === '/dev/null') return n
    const end = (f.flags & O_APPEND ? f.data.length : f.pos) + n
    if (end > f.data.length) { const g = new Uint8Array(Math.max(end, f.data.length * 2)); g.set(f.data); f.data = g.subarray(0, end); }
    f.data.set(b, end - n)
    f.pos = end
    f.dirty = true
    fs.write(f.path, f.data)
    return n
  }
  const fd = (i: number) => fds.get(i)

  def('open', () => openPath(m.cstr(R(0)), R(1)))
  def('__open', () => openPath(m.cstr(R(0)), R(1)))
  def('openat', () => openPath(m.cstr(R(1)), R(2)))
  def('creat', () => openPath(m.cstr(R(0)), O_CREAT | O_TRUNC | 1))
  def('close', () => (fds.delete(R(0)) || R(0) < 3 ? 0 : err(EBADF)))
  def('read', () => { const f = fd(R(0)); return f ? fdRead(f, R(1), R(2)) : err(EBADF) })
  def('write', () => { const f = fd(R(0)); return f ? fdWrite(f, R(1), R(2)) : err(EBADF) })
  def('pread', () => { const f = fd(R(0)); if (!f) return err(EBADF); const k = Math.max(0, Math.min(R(2), f.data.length - R(3))); m.u8.set(f.data.subarray(R(3), R(3) + k), R(1)); return k })
  // off64_t needs an even register pair: it goes on the stack (fd r0, buf r1, count r2)
  def('pread64', () => { const f = fd(R(0)); if (!f) return err(EBADF); const o = S(0), n = R(2); const k = Math.max(0, Math.min(n, f.data.length - o)); m.u8.set(f.data.subarray(o, o + k), R(1)); return k })
  def('writev', () => { const f = fd(R(0)); if (!f) return err(EBADF); let n = 0; for (let i = 0; i < R(2); i++) n += fdWrite(f, m.r32(R(1) + i * 8), m.r32(R(1) + i * 8 + 4)); return n })
  def('readv', () => { const f = fd(R(0)); if (!f) return err(EBADF); let n = 0; for (let i = 0; i < R(2); i++) n += fdRead(f, m.r32(R(1) + i * 8), m.r32(R(1) + i * 8 + 4)); return n })
  const seek = (f: Fd, off: number, whence: number) => { const p = whence === 0 ? off : whence === 1 ? f.pos + off : f.data.length + off; if (p < 0) return err(EINVAL); f.pos = p; return p }
  def('lseek', () => { const f = fd(R(0)); if (!f) return err(EBADF); if (f.console) return err(ESPIPE); return seek(f, R(1) | 0, R(2)) })
  // off64_t is r2:r3 (even pair), whence on the stack
  def('lseek64', () => { const f = fd(R(0)); if (!f) return err(EBADF); const r = seek(f, R(2) | 0, S(0)); return r < 0 ? -1n : BigInt(r) })
  def('fsync', () => 0); def('fdatasync', () => 0)
  def('ftruncate', () => { const f = fd(R(0)); if (!f) return err(EBADF); f.data = f.data.slice(0, R(1)); fs.write(f.path, f.data); return 0 })
  def('truncate', () => { const p = m.cstr(R(0)); const d = fs.read(p); if (!d) return err(ENOENT); fs.write(p, d.slice(0, R(1))); return 0 })
  def('dup', () => { const f = fd(R(0)); if (!f) return err(EBADF); const n = nextFd++; fds.set(n, f); return n })
  def('dup2', () => { const f = fd(R(0)); if (!f) return err(EBADF); fds.set(R(1), f); return R(1) })
  def('fcntl', () => (fd(R(0)) ? (R(1) === 1 || R(1) === 3 ? 0 : 0) : err(EBADF)))
  def('ioctl', () => err(ENOSYS))
  def('flock', () => 0)
  def('pipe', () => { const a = nextFd++, b = nextFd++; const shared: Fd = { path: '/pipe', data: new Uint8Array(), pos: 0, flags: 2, dirty: false }; fds.set(a, shared); fds.set(b, shared); m.w32(R(0), a); m.w32(R(0) + 4, b); return 0 })
  def('isatty', () => (R(0) < 3 ? 1 : 0))
  def('access', () => { const p = fs.norm(m.cstr(R(0))); return fs.exists(p) || procText(p) != null ? 0 : err(ENOENT) })
  def('unlink', () => (fs.remove(m.cstr(R(0))) ? 0 : err(ENOENT)))
  def('remove', () => (fs.remove(m.cstr(R(0))) ? 0 : err(ENOENT)))
  def('rmdir', () => (fs.remove(m.cstr(R(0))) ? 0 : err(ENOENT)))
  def('mkdir', () => { const p = m.cstr(R(0)); if (fs.exists(p)) return err(EEXIST); fs.mkdirs(p); return 0 })
  def('rename', () => { const a = m.cstr(R(0)), b = m.cstr(R(1)); const d = fs.read(a); if (!d) return err(ENOENT); fs.remove(a); fs.write(b, d); return 0 })
  def('chdir', () => { cwd = fs.norm(m.cstr(R(0))); return 0 })
  let cwd = '/'
  def('getcwd', () => { const b = enc.encode(cwd); const dst = R(0) || m.malloc(b.length + 1); m.u8.set(b, dst); m.u8[dst + b.length] = 0; return dst })
  def('readlink', () => { const p = m.cstr(R(0)); if (p === '/proc/self/exe') { const b = enc.encode('/system/bin/app_process'); const n = Math.min(b.length, R(2)); m.u8.set(b.subarray(0, n), R(1)); return n } return err(EINVAL) })
  def('chmod', () => 0); def('utime', () => 0); def('umask', () => 0o22)
  // struct stat (bionic arm, 104 bytes)
  const writeStat = (dst: number, size: number, dir: boolean) => {
    m.u8.fill(0, dst, dst + 104)
    m.w32(dst + 12, 1); m.w32(dst + 16, dir ? 0o40755 : 0o100644); m.w32(dst + 20, 1)
    m.w32(dst + 48, size); m.w32(dst + 56, 4096); m.w32(dst + 64, Math.ceil(size / 512))
    const t = Math.floor(Date.now() / 1000)
    m.w32(dst + 72, t); m.w32(dst + 80, t); m.w32(dst + 88, t); m.w32(dst + 96, 1)
    return 0
  }
  const statPath = (p: string, dst: number) => {
    p = fs.norm(p)
    const proc = procText(p)
    if (proc != null) return writeStat(dst, 0, false)
    if (fs.isDir(p)) return writeStat(dst, 4096, true)
    const d = fs.read(p)
    if (!d) return err(ENOENT)
    return writeStat(dst, d.length, false)
  }
  for (const n of ['stat', 'lstat', 'stat64', 'lstat64']) def(n, () => statPath(m.cstr(R(0)), R(1)))
  for (const n of ['fstat', 'fstat64']) def(n, () => { const f = fd(R(0)); if (!f) return err(EBADF); return writeStat(R(1), f.data.length, !!f.dir) })
  def('fstatat', () => statPath(m.cstr(R(1)), R(2)))
  def('statfs', () => { m.u8.fill(0, R(1), R(1) + 84); m.w32(R(1) + 4, 4096); m.w32(R(1) + 8, 1 << 20); m.w32(R(1) + 16, 1 << 18); m.w32(R(1) + 24, 1 << 18); return 0 })

  // directories: DIR* is a small handle with the names; struct dirent (bionic): ino u64, off i64, reclen u16, type u8, name[256]
  const dirs = new Map<number, { names: string[]; i: number; ent: number; path: string }>()
  def('opendir', () => {
    const p = fs.norm(m.cstr(R(0)))
    if (!fs.isDir(p)) { nat.setErrno(fs.exists(p) ? ENOTDIR : ENOENT); return 0 }
    const h = m.malloc(16), ent = m.malloc(280)
    dirs.set(h, { names: ['.', '..', ...fs.list(p)], i: 0, ent, path: p })
    return h
  })
  def('fdopendir', () => { const f = fd(R(0)); if (!f?.dir) return 0; const h = m.malloc(16), ent = m.malloc(280); dirs.set(h, { names: ['.', '..', ...f.dir], i: 0, ent, path: f.path }); return h })
  def('readdir', () => {
    const d = dirs.get(R(0))
    if (!d || d.i >= d.names.length) return 0
    const name = d.names[d.i++]
    m.u8.fill(0, d.ent, d.ent + 280)
    m.w32(d.ent, d.i); m.w32(d.ent + 8, d.i); m.w16(d.ent + 16, 280)
    m.u8[d.ent + 18] = fs.isDir(d.path + '/' + name) || name === '.' || name === '..' ? 4 : 8
    const b = enc.encode(name)
    m.u8.set(b.subarray(0, 255), d.ent + 19)
    return d.ent
  })
  def('readdir_r', () => { const d = dirs.get(R(0)); if (!d || d.i >= d.names.length) { m.w32(R(2), 0); return 0 } const name = d.names[d.i++]; m.u8.fill(0, R(1), R(1) + 280); m.w16(R(1) + 16, 280); m.u8[R(1) + 18] = fs.isDir(d.path + '/' + name) ? 4 : 8; m.u8.set(enc.encode(name).subarray(0, 255), R(1) + 19); m.w32(R(2), R(1)); return 0 })
  def('closedir', () => { const d = dirs.get(R(0)); if (d) { m.free(d.ent); m.free(R(0)); dirs.delete(R(0)) } return 0 })
  def('rewinddir', () => { const d = dirs.get(R(0)); if (d) d.i = 0 })
  def('dirfd', () => -1)

  // ---------- stdio: FILE* points at a small struct we own; bionic's __sF has stdin, stdout, stderr ----------
  interface File { fd: number; eof: boolean; err: boolean; unget: number[] }
  const files = new Map<number, File>()
  const FILE_SIZE = 84
  nat.data('__sF', FILE_SIZE * 3, (a) => { for (let i = 0; i < 3; i++) { files.set(a + i * FILE_SIZE, { fd: i, eof: false, err: false, unget: [] }); m.w16(a + i * FILE_SIZE + 14, i) } })
  const file = (p: number) => files.get(p)
  const openFile = (fdn: number) => { if (fdn < 0) return 0; const a = m.malloc(FILE_SIZE); m.u8.fill(0, a, a + FILE_SIZE); m.w16(a + 14, fdn); files.set(a, { fd: fdn, eof: false, err: false, unget: [] }); return a }
  const modeFlags = (mode: string) => { const plus = mode.includes('+'); if (mode[0] === 'r') return plus ? 2 : 0; if (mode[0] === 'w') return (plus ? 2 : 1) | O_CREAT | O_TRUNC; if (mode[0] === 'a') return (plus ? 2 : 1) | O_CREAT | O_APPEND; return 0 }
  def('fopen', () => openFile(openPath(m.cstr(R(0)), modeFlags(m.cstr(R(1))))))
  def('fopen64', () => openFile(openPath(m.cstr(R(0)), modeFlags(m.cstr(R(1))))))
  def('fdopen', () => openFile(R(0)))
  def('freopen', () => { const f = file(R(2)); if (!f) return 0; f.fd = openPath(m.cstr(R(0)), modeFlags(m.cstr(R(1)))); f.eof = false; return f.fd < 0 ? 0 : R(2) })
  def('fclose', () => { const f = file(R(0)); if (!f) return -1; if (f.fd > 2) fds.delete(f.fd); files.delete(R(0)); if (R(0) < nat.host.get('__sF')! || R(0) >= nat.host.get('__sF')! + FILE_SIZE * 3) m.free(R(0)); return 0 })
  def('fileno', () => file(R(0))?.fd ?? -1)
  const fread = (dst: number, size: number, n: number, fp: number) => {
    const f = file(fp), d = f && fd(f.fd)
    if (!f || !d) return 0
    let total = size * n, got = 0
    while (f.unget.length && total) { m.u8[dst + got++] = f.unget.pop()!; total-- }
    const k = fdRead(d, dst + got, total)
    got += k
    if (k < total) f.eof = true
    return size ? Math.floor(got / size) : 0
  }
  def('fread', () => fread(R(0), R(1), R(2), R(3)))
  def('fwrite', () => { const f = file(R(3)), d = f && fd(f.fd); if (!d) return 0; return R(1) ? Math.floor(fdWrite(d, R(0), R(1) * R(2)) / R(1)) : 0 })
  def('fputs', () => { const f = file(R(1)), d = f && fd(f.fd); if (!d) return -1; const s = R(0); let e = s; while (m.u8[e]) e++; fdWrite(d, s, e - s); return 1 })
  const putc = () => { const f = file(R(1)), d = f && fd(f.fd); if (!d) return -1; const a = m.malloc(1); m.u8[a] = R(0) & 0xff; fdWrite(d, a, 1); m.free(a); return R(0) & 0xff }
  for (const n of ['fputc', 'putc', 'putc_unlocked']) def(n, putc)
  def('putchar', () => { consoleWrite('out', Uint8Array.of(R(0) & 0xff)); return R(0) & 0xff })
  const getc = (fp: number) => { const f = file(fp), d = f && fd(f.fd); if (!f || !d) return -1; if (f.unget.length) return f.unget.pop()!; if (d.pos >= d.data.length) { f.eof = true; return -1 } return d.data[d.pos++] }
  for (const n of ['fgetc', 'getc', 'getc_unlocked']) def(n, () => getc(R(0)))
  def('ungetc', () => { const f = file(R(1)); if (!f || (R(0) | 0) < 0) return -1; f.unget.push(R(0) & 0xff); f.eof = false; return R(0) & 0xff })
  def('fgets', () => {
    const dst = R(0), n = R(1), fp = R(2)
    let i = 0
    while (i < n - 1) { const ch = getc(fp); if (ch < 0) break; m.u8[dst + i++] = ch; if (ch === 10) break }
    if (!i) return 0
    m.u8[dst + i] = 0
    return dst
  })
  def('fflush', () => 0)
  def('fseek', () => { const f = file(R(0)), d = f && fd(f.fd); if (!d) return -1; f!.unget.length = 0; f!.eof = false; return seek(d, R(1) | 0, R(2)) < 0 ? -1 : 0 })
  def('fseeko', () => { const f = file(R(0)), d = f && fd(f.fd); if (!d) return -1; f!.unget.length = 0; f!.eof = false; return seek(d, R(1) | 0, R(2)) < 0 ? -1 : 0 })
  def('ftell', () => { const f = file(R(0)), d = f && fd(f.fd); return d ? d.pos - f!.unget.length : -1 })
  def('ftello', () => { const f = file(R(0)), d = f && fd(f.fd); return d ? d.pos - f!.unget.length : -1 })
  def('rewind', () => { const f = file(R(0)), d = f && fd(f.fd); if (d) { d.pos = 0; f!.eof = false; f!.unget.length = 0 } })
  def('fgetpos', () => { const f = file(R(0)), d = f && fd(f.fd); if (!d) return -1; m.w32(R(1), d.pos); return 0 })
  def('fsetpos', () => { const f = file(R(0)), d = f && fd(f.fd); if (!d) return -1; d.pos = m.r32(R(1)); f!.eof = false; return 0 })
  def('feof', () => (file(R(0))?.eof ? 1 : 0))
  def('ferror', () => (file(R(0))?.err ? 1 : 0))
  def('clearerr', () => { const f = file(R(0)); if (f) { f.eof = false; f.err = false } })
  def('setvbuf', () => 0); def('setbuf', () => 0); def('setlinebuf', () => 0)
  def('tmpfile', () => openFile(openPath('/data/local/tmp/tmp' + Math.random().toString(36).slice(2), O_CREAT | 2)))
  def('mkstemp', () => { const p = m.cstr(R(0)).replace(/X{6}$/, Math.random().toString(36).slice(2, 8).padEnd(6, '0')); m.u8.set(enc.encode(p), R(0)); return openPath(p, O_CREAT | 2) })
  def('popen', () => 0); def('pclose', () => -1)
  // what printf-like functions write to (stdio.ts formats, this writes)
  nat.writeFile = (fp: number, s: string) => { const f = file(fp), d = f && fd(f.fd); if (!d) return -1; const b = enc.encode(s); const a = m.malloc(b.length + 1); m.u8.set(b, a); fdWrite(d, a, b.length); m.free(a); return b.length }
  nat.readFile = (fp: number) => { const f = file(fp), d = f && fd(f.fd); if (!f || !d) return null; return { get: () => getc(fp), unget: (ch: number) => { if (ch >= 0) f.unget.push(ch) } } }

  // ---------- memory mapping ----------
  // anonymous maps are plain (page-aligned) blocks; file maps copy the file in; nothing is shared
  const mapped = new Map<number, number>()
  def('mmap', () => {
    const len = R(1), flags = R(3), fdn = S(0) | 0, off = S(1)
    if (!len) return err(EINVAL) >>> 0
    const a = m.memalign(4096, len)
    m.u8.fill(0, a, a + len)
    if (!(flags & 0x20) && fdn >= 0) { const f = fd(fdn); if (!f) { m.free(a); nat.setErrno(EBADF); return 0xffffffff } m.u8.set(f.data.subarray(off, off + len), a) }
    mapped.set(a, len)
    return a
  })
  def('mmap64', () => { const len = R(1), flags = R(3), fdn = S(0) | 0; const off = S(2); const a = m.memalign(4096, len); m.u8.fill(0, a, a + len); if (!(flags & 0x20) && fdn >= 0) { const f = fd(fdn); if (f) m.u8.set(f.data.subarray(off, off + len), a) } mapped.set(a, len); return a })
  def('munmap', () => { if (mapped.has(R(0))) { mapped.delete(R(0)); m.free(R(0)) } return 0 })
  def('mremap', () => { const old = R(0), n = R(2); const a = m.memalign(4096, n); m.u8.fill(0, a, a + n); m.u8.copyWithin(a, old, old + Math.min(R(1), n)); if (mapped.has(old)) { mapped.delete(old); m.free(old) } mapped.set(a, n); return a })
  def('mprotect', () => 0); def('madvise', () => 0); def('mlock', () => 0); def('munlock', () => 0); def('msync', () => 0)
  void EACCES
}
