// libcore.io.Posix (what libcore's java calls for the os) on droid's virtual file system.
// file descriptors are small ints over in-memory files; errors are ErrnoExceptions like android's.
import type { VM, JObject, JArray } from '../dalvik.ts'
import { jstr } from '../java.ts'
import type { Vfs } from '../javaio.ts'

const ENOENT = 2, EBADF = 9, EEXIST = 17, ENOTDIR = 20, EISDIR = 21, EINVAL = 22
const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0x40, O_EXCL = 0x80, O_TRUNC = 0x200, O_APPEND = 0x400

export function registerPosix(vm: VM, fs: Vfs) {
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  const err = (fn: string, errno: number) => vm.error('Llibcore/io/ErrnoException;', `${fn} failed: errno ${errno}`)
  const errno = (fn: string, n: number) => { const e = err(fn, n); e.obj.f.functionName = fn; e.obj.f.errno = n; return e }
  interface Fd { path: string; pos: number; append: boolean; write: boolean }
  const fds = new Map<number, Fd>()
  let nextFd = 100
  const fdOf = (fd: JObject | null): number => fd?.f.descriptor ?? -1
  const newFd = (n: number) => { const f = vm.newObject('Ljava/io/FileDescriptor;'); f.f.descriptor = n; return f }
  const stat = (p: string) => {
    const isDir = fs.isDir(p), b = fs.read(p)
    if (!isDir && !b) throw errno('stat', ENOENT)
    const mode = isDir ? 0o040755 : 0o100644, t = BigInt(Math.floor(Date.now() / 1000)), size = BigInt(b?.length ?? 4096)
    return vm.newObject('Llibcore/io/StructStat;', '<init>(JJIJIIJJJJJJJ)V', [0n, BigInt(p.length), mode, 1n, 10000, 10000, 0n, size, t, t, t, 4096n, (size + 511n) / 512n])
  }
  const bytes = (a: JArray) => new Uint8Array((a.data as Int8Array).buffer, (a.data as Int8Array).byteOffset, a.data.length)
  const ids: Record<string, () => number> = { getuid: () => 10000, geteuid: () => 10000, getgid: () => 10000, getegid: () => 10000, getpid: () => 1000, getppid: () => 1, gettid: () => vm.current.id }
  const posix: Record<string, any> = {}
  for (const [k, f] of Object.entries(ids)) posix[k] = () => f()
  Object.assign(posix, {
    access: (v: VM, s: JObject, [p]: any[]) => { if (!fs.exists(text(p))) throw errno('access', ENOENT); return 1 },
    stat: (v: VM, s: JObject, [p]: any[]) => stat(text(p)),
    lstat: (v: VM, s: JObject, [p]: any[]) => stat(text(p)),
    fstat: (v: VM, s: JObject, [fd]: any[]) => { const f = fds.get(fdOf(fd)); if (!f) throw errno('fstat', EBADF); return stat(f.path) },
    mkdir: (v: VM, s: JObject, [p]: any[]) => { const x = text(p); if (fs.exists(x)) throw errno('mkdir', EEXIST); fs.mkdirs(x) },
    remove: (v: VM, s: JObject, [p]: any[]) => { if (!fs.remove(text(p))) throw errno('remove', ENOENT) },
    rename: (v: VM, s: JObject, [a, b]: any[]) => { const d = fs.read(text(a)); if (!d) throw errno('rename', ENOENT); fs.remove(text(a)); fs.write(text(b), d) },
    chmod: () => {}, fchmod: () => {}, chown: () => {}, fchown: () => {}, fsync: () => {}, fdatasync: () => {}, ftruncate: (v: VM, s: JObject, [fd, len]: any[]) => { const f = fds.get(fdOf(fd)); if (f) { const d = fs.read(f.path) ?? new Uint8Array(); fs.write(f.path, d.slice(0, Number(len))) } },
    open: (v: VM, s: JObject, [p, flags]: any[]) => {
      const path = text(p)
      if (fs.isDir(path) && flags & (O_WRONLY | O_RDWR)) throw errno('open', EISDIR)
      const exists = !!fs.read(path) || fs.isDir(path)
      if (!exists && !(flags & O_CREAT)) throw errno('open', ENOENT)
      if (exists && flags & O_CREAT && flags & O_EXCL) throw errno('open', EEXIST)
      if (!exists || flags & O_TRUNC) { if (!fs.isDir(path.slice(0, path.lastIndexOf('/')) || '/') && !fs.exists(path.slice(0, path.lastIndexOf('/')))) throw errno('open', ENOENT); fs.write(path, new Uint8Array()) }
      const n = nextFd++
      fds.set(n, { path, pos: 0, append: !!(flags & O_APPEND), write: !!(flags & (O_WRONLY | O_RDWR)) })
      return newFd(n)
    },
    close: (v: VM, s: JObject, [fd]: any[]) => { fds.delete(fdOf(fd)) },
    read: (v: VM, s: JObject, [fd, buf, off, n]: any[]) => {
      const f = fds.get(fdOf(fd)); if (!f) throw errno('read', EBADF)
      if (!(buf as any)?.data) return 0 // a ByteBuffer: not used by the framework's file paths
      const d = fs.read(f.path) ?? new Uint8Array(), k = Math.max(0, Math.min(n, d.length - f.pos))
      bytes(buf).set(d.subarray(f.pos, f.pos + k), off); f.pos += k
      return k
    },
    write: (v: VM, s: JObject, [fd, buf, off, n]: any[]) => {
      const f = fds.get(fdOf(fd)); if (!f) throw errno('write', EBADF)
      if (!(buf as any)?.data) return 0
      const d = fs.read(f.path) ?? new Uint8Array(), at = f.append ? d.length : f.pos
      const out = new Uint8Array(Math.max(d.length, at + n)); out.set(d); out.set(bytes(buf).subarray(off, off + n), at)
      fs.write(f.path, out); f.pos = at + n
      return n
    },
    lseek: (v: VM, s: JObject, [fd, off, whence]: any[]) => { const f = fds.get(fdOf(fd)); if (!f) throw errno('lseek', EBADF); const len = fs.read(f.path)?.length ?? 0; f.pos = Number(whence === 0 ? off : whence === 1 ? BigInt(f.pos) + off : BigInt(len) + off); return BigInt(f.pos) },
    sysconf: (v: VM, s: JObject, [name]: any[]) => (name === 0x27 ? 4096n : name === 0x60 || name === 0x61 ? 4n : 1024n),
    strerror: (v: VM, s: JObject, [n]: any[]) => ({ [ENOENT]: 'No such file or directory', [EBADF]: 'Bad file descriptor', [EEXIST]: 'File exists', [ENOTDIR]: 'Not a directory', [EISDIR]: 'Is a directory', [EINVAL]: 'Invalid argument' } as Record<number, string>)[n] ?? 'errno ' + n,
    getenv: (v: VM, s: JObject, [k]: any[]) => vm.callStatic('Ljava/lang/System;', 'getenv(Ljava/lang/String;)Ljava/lang/String;', [k]),
    setenv: () => {}, unsetenv: () => {},
    uname: () => vm.newObject('Llibcore/io/StructUtsname;', '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V', ['Linux', 'droid', '3.4.0', '#1 droid', 'armv7l']),
    isatty: () => 0, prctl: () => 0, setsid: () => 1000, umask: () => 0o022, fcntlVoid: () => 0, fcntlLong: () => 0, fcntlFlock: () => 0,
    getsockname: () => null, socket: () => { throw errno('socket', 97) }, kill: () => {},
    readlink: (v: VM, s: JObject, [p]: any[]) => text(p),
    statvfs: () => vm.newObject('Llibcore/io/StructStatVfs;', '<init>(JJJJJJJJJJJ)V', [4096n, 4096n, 1n << 20n, 1n << 19n, 1n << 19n, 1n << 16n, 1n << 15n, 1n << 15n, 0n, 0n, 255n]),
  })
  vm.registerNatives('Llibcore/io/Posix;', posix)
}
