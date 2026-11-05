// native side of the android runtime: memory layout, libc / liblog host functions, and jni
// (JNIEnv / JavaVM tables whose entries trap into js and talk to the dalvik vm).
import { Jit } from './jit.ts'
import { CPU, Memory, STOP, RETURN_TRAP, SIGRETURN_TRAP, newContext, type HostFn, type Context } from './cpu.ts'
import type { Block } from '../threads.ts'
import { Threads, PThread, installPthreads } from './pthread.ts'
import { installPosix } from './posix.ts'
import { installLibc } from './libc.ts'
import { GL, installGles } from './gles.ts'
import { loadElf, type Lib } from './elf.ts'
import { VM, JObject, JArray, JavaThrow, JThread, splitParams, type JMethod, type JClass } from '../dalvik.ts'
import { jstr } from '../java.ts'

const MB = 1024 * 1024
const ARM_SAMPLE = false

export class Native {
  mem = new Memory(64 * MB)
  cpu = new CPU(this.mem)
  libs: Lib[] = []
  missing = new Set<string>()
  host = new Map<string, number>()
  refs: any[] = [null] // jni handles: index -> java value
  free: number[] = []
  env = 0
  jvm = 0
  // the jni pending exception belongs to the thread that raised it (pthread or java thread)
  private pendingBy = new Map<unknown, JavaThrow>()

  get pending(): JavaThrow | null { return this.pendingBy.get(this.threads?.task()) ?? null }
  set pending(e: JavaThrow | null) { const k = this.threads.task();  if (e) this.pendingBy.set(k, e); else this.pendingBy.delete(k) }
  vm: VM
  vfs: import('../javaio.ts').Vfs
  pkg: string
  threads: Threads
  gles = GL
  heapStart = 0
  fault: { pc: number; lr: number } | null = null // where the last native error happened
  // stdio hooks (posix.ts) and the printf formatter (libc.ts)
  writeFile: (fp: number, s: string) => number = () => -1
  readFile: (fp: number) => { get: () => number; unget: (ch: number) => void } | null = () => null
  format: (f: string, next: () => number, nextD: () => number) => string = (f) => f
  constructor(vm: VM, vfs: import('../javaio.ts').Vfs | null = null, pkg = 'app') {
    this.vm = vm
    this.vfs = vfs ?? (new (class { files = new Map(); dirs = new Set(['/']); norm(p: string) { return p } read() { return null } write() {} exists() { return false } isDir() { return false } mkdirs() { return true } remove() { return false } list() { return [] } text() {} })() as any)
    this.pkg = pkg
    this.mem.brk = 0x10000
    // the main (outside) thread's stack: 8 mb, from the start of memory
    const stack = 8 * MB
    const base = this.mem.sbrk(stack, 4096)
    this.cpu.r[13] = base + stack - 64
    this.cpu.tls = this.mem.malloc(256)
    this.mem.w32(this.cpu.tls, this.cpu.tls)
    this.threads = new Threads(this)
    this.threads.mainStackBase = base
    this.threads.mainStackSize = stack
    this.heapStart = this.mem.brk
    this.libc()
    installLibc(this)
    installPosix(this)
    installPthreads(this)
    installGles(this)
    this.errnoSetup()
    this.jni()
    vm.nativeAsync = this
    // a fault in guest code: SIGSEGV to the program's handler (mono: NullReferenceException), on a
    // linux-shaped frame (siginfo, ucontext with the registers at the fault). no handler: a crash
    this.cpu.onFault = (addr, write, pc) => this.deliverFault(addr, write, pc)
    // hot arm blocks run as compiled javascript (jit.ts); off with ?nojit for comparisons
    if (!(globalThis as any).location?.search?.includes('nojit') && !(globalThis as any).process?.env?.NOJIT) this.cpu.jit = new Jit(this.cpu)
    // ByteBuffer.allocateDirect takes native memory from here on
    ;(vm as any).directAlloc = { alloc: (n: number) => this.mem.memalign(16, n), bytes: () => this.mem.u8 }
    // a native call that runs for seconds without returning says where it is (finding hangs)
    // debugging aid: set ARM_SAMPLE to log where native code is every 8M instructions, with all threads
    if (ARM_SAMPLE) { let t0 = performance.now(), s0 = 0; (globalThis as any).__armSample = (c: any, pc: number) => { const t = performance.now(); console.log(`SAMPLE ${((c.steps - s0) / (t - t0) / 1000).toFixed(1)}M/s at ${this.where(pc | (c.thumb ? 1 : 0))} lr ${this.where(c.r[14])} on ${this.threads.current?.name ?? 'java ' + this.vm.current?.name} | ${[...(this.threads as any).all.values()].map((x: any) => `${x.name}:${x.state ?? 'outside'}${x.block ? '/' + x.block.what : ''}${x.waiting ? '@' + this.where(x.ctx?.r?.[14] ?? 0) : ''}`).join(', ')}`); t0 = t; s0 = c.steps } }
    this.cpu.onSlow = (pc, lr) => console.warn(`native: still running after a long time at ${this.where(pc)} (lr ${this.where(lr)}) on ${this.threads.current?.name ?? 'main'}`)
  }
  private deliverFault(addr: number, write: boolean, pc: number) {
    const h = (this.threads as any).handlers.get(11) as { fn: number; flags: number } | undefined
    if (!h || h.fn < 2) return false
    const c = this.cpu, m = this.mem
    const sp0 = c.r[13]
    // frames below the current sp on this stack are gone (a handler that left by longjmp or by
    // restoring a context itself, as mono's does)
    for (const k of c.faultFrames.keys()) if (k < sp0 && k > sp0 - 0x100000) c.faultFrames.delete(k)
    if (sp0 < 0x20000) return false // no usable stack: a real crash
    const size = 1024, sp = ((sp0 - 128) & ~15) - size
    const info = sp, uc = sp + 128, mc = uc + 20
    m.u8.fill(0, sp, sp + size)
    m.w32(info, 11); m.w32(info + 8, 1) // si_signo SIGSEGV, si_code SEGV_MAPERR
    m.w32(info + 12, addr) // si_addr
    m.w32(mc, 14) // trap_no
    m.w32(mc + 4, write ? 0x800 : 0) // error_code
    for (let i = 0; i < 15; i++) m.w32(mc + 12 + i * 4, c.r[i])
    m.w32(mc + 12 + 15 * 4, pc)
    m.w32(mc + 76, ((c.N ? 1 : 0) << 31 | (c.Z ? 1 : 0) << 30 | (c.C ? 1 : 0) << 29 | (c.V ? 1 : 0) << 28 | (c.thumb ? 0x20 : 0) | 0x10) >>> 0)
    m.w32(mc + 80, addr) // fault_address
    c.faultFrames.set(sp, { uc, fp: c.fp.buf.slice(0), fpscr: c.fp.fpscr })
    c.r[13] = sp
    c.setupCall(h.fn, [11, info, uc], SIGRETURN_TRAP)
    return true
  }
  // lib+offset and the nearest exported symbol below it
  where(a: number) {
    a = (a & ~1) >>> 0
    for (const l of this.libs) if (l.segments.some((s) => a >= s.start && a < s.end)) {
      let best = '', bd = Infinity
      for (const [n, v] of l.exports) { const d = a - ((v & ~1) >>> 0); if (d >= 0 && d < bd) { bd = d; best = n } }
      return `${l.name}+0x${(a - l.base).toString(16)}${best ? ` (${best}+0x${bd.toString(16)})` : ''}`
    }
    for (const [n, v] of this.host) if (v === a) return 'host ' + n
    return '0x' + a.toString(16)
  }
  // errno: one slot per thread
  private errnoSlots = new Map<any, number>()
  private errnoSlot() { const k = this.threads.current ?? this.vm.current; let a = this.errnoSlots.get(k); if (!a) { a = this.mem.malloc(4); this.mem.w32(a, 0); this.errnoSlots.set(k, a) } return a }
  setErrno(e: number) { this.mem.w32(this.errnoSlot(), e) }
  getErrno() { return this.mem.r32(this.errnoSlot()) }
  private errnoSetup() { this.def('__errno', () => this.errnoSlot()); this.def('__errno_location', () => this.errnoSlot()) }
  // a symbol from the loaded libraries or the host, 0 if there is none (no trap made)
  resolveOrZero(name: string) { for (const l of this.libs) { const a = l.exports.get(name); if (a) return a } return this.host.get(name) ?? 0 }

  // ---------- references ----------
  ref(v: any) { if (v == null) return 0; const i = this.free.pop() ?? this.refs.length; this.refs[i] = v; return i * 4 + 0x100000 }
  deref(h: number) { if (!h) return null; return this.refs[(h - 0x100000) / 4] ?? null }
  unref(h: number) { if (!h) return; const i = (h - 0x100000) / 4; if (this.refs[i] !== undefined) { this.refs[i] = undefined; this.free.push(i) } }
  str(s: string) { const b = new TextEncoder().encode(s); const a = this.mem.malloc(b.length + 1); this.mem.u8.set(b, a); this.mem.u8[a + b.length] = 0; return a }

  // ---------- loading ----------
  load(name: string, bytes: Uint8Array) {
    const lib = loadElf(this.cpu, name, bytes, (sym) => this.resolve(sym), this.missing)
    this.libs.push(lib)
    for (const f of lib.init) this.cpu.call(f)
    const onload = lib.exports.get('JNI_OnLoad')
    if (onload) this.cpu.call(onload, [this.jvm, 0])
    return lib
  }
  resolve(name: string): number {
    for (const l of this.libs) { const a = l.exports.get(name); if (a) return a }
    const h = this.host.get(name)
    if (h) return h
    // unknown import: a trap that logs once and returns 0, so the library still loads
    this.missing.add(name)
    const t = this.cpu.hostFn(name, () => { console.warn('native: missing import', name); return 0 })
    this.host.set(name, t)
    return t
  }
  def(name: string, fn: HostFn) { this.host.set(name, this.cpu.hostFn(name, fn)) }
  data(name: string, bytes: number, init?: (a: number) => void) { const a = this.mem.malloc(bytes); init?.(a); this.host.set(name, a) }

  // ---------- calling native methods ----------
  // java native method -> Java_<class>_<name> (or the RegisterNatives table), AAPCS argument passing
  registered = new Map<string, number>()
  private target(m: JMethod) {
    const key = `${m.cls.name}->${m.key}`
    let addr = this.registered.get(key)
    if (!addr) {
      const cls = m.cls.name.slice(1, -1)
      const mangle = (s: string) => s.replace(/_/g, '_1').replace(/;/g, '_2').replace(/\[/g, '_3').replace(/[/$]/g, (c) => (c === '/' ? '_' : '_00024'))
      const short = `Java_${mangle(cls)}_${mangle(m.name)}`
      const long = `${short}__${mangle(m.desc.slice(1, m.desc.indexOf(')')))}`
      for (const l of this.libs) { addr = l.exports.get(short) || l.exports.get(long); if (addr) break }
      if (!addr) throw this.vm.error('Ljava/lang/UnsatisfiedLinkError;', `No implementation found for ${m.cls.name}->${m.key}`)
      this.registered.set(key, addr)
    }
    return addr
  }
  private words(m: JMethod, self: any, args: any[]) {
    const words: number[] = [this.env, this.ref(self ?? this.vm.classObject(m.cls))]
    m.params.forEach((p, i) => {
      const v = args[i]
      if (p === 'J' || p === 'D') {
        if (words.length % 2) words.push(0) // 64-bit values go in an even register pair
        const b = p === 'J' ? BigInt.asUintN(64, v) : f64bits(v)
        words.push(Number(b & 0xffffffffn), Number(b >> 32n))
      } else if (p === 'F') words.push(f32bits(v))
      else if (p[0] === 'L' || p[0] === '[') words.push(this.ref(v))
      else words.push(v | 0)
    })
    return words
  }
  private finishCall(m: JMethod, r0: number, r1: number) {
    const out = this.fromNative(m.ret, r0, r1)
    if (this.pending) { const p = this.pending; this.pending = null; throw p }
    return out
  }
  // java native method -> Java_<class>_<name> (or the RegisterNatives table), AAPCS argument passing.
  // runs to completion on the current context
  call(m: JMethod, self: any, args: any[]) {
    const { r0, r1 } = this.cpu.call(this.target(m), this.words(m, self, args))
    return this.finishCall(m, r0, r1)
  }

  // ---------- resumable native calls from java threads ----------
  // a java (green) thread calling native code gets its own registers and stack, so a long native
  // call (a game's frame) can stop when its slice is over and go on in the next one
  private armOf(t: JThread) {
    let a = (t as any).arm as { ctx: Context; waiting: CPU['waiting']; m: JMethod | null } | undefined
    if (!a) {
      const ctx = newContext()
      const stack = 1024 * 1024
      const base = this.mem.memalign(4096, stack)
      ctx.r[13] = base + stack - 64
      ctx.tls = this.mem.malloc(256)
      this.mem.w32(ctx.tls, ctx.tls)
      a = { ctx, waiting: null, m: null }
      ;(t as any).arm = a
      ;(t as any).armStack = { base, size: stack }
    }
    return a
  }
  // starts the call; done -> its value, else the thread yielded or waits (resume later)
  begin(t: JThread, m: JMethod, self: any, args: any[], deadline: number): { done: true; value: any } | { done: false; block: Block | null } {
    const a = this.armOf(t)
    const addr = this.target(m), words = this.words(m, self, args)
    return this.runOn(t, a, deadline, () => { this.cpu.setupCall(addr, words, RETURN_TRAP); a.m = m })
  }
  resumeCall(t: JThread, deadline: number) {
    const a = this.armOf(t)
    if (a.waiting && !a.waiting.block.ready()) return { done: false as const, block: a.waiting.block }
    return this.runOn(t, a, deadline, () => { if (a.waiting) { const w = a.waiting; a.waiting = null; this.cpu.waiting = w; this.cpu.resume(w.block.finish()) } })
  }
  private runOn(t: JThread, a: { ctx: Context; waiting: CPU['waiting']; m: JMethod | null }, deadline: number, setup: () => void): { done: true; value: any } | { done: false; block: Block | null } {
    const c = this.cpu
    const outside = newContext()
    c.save(outside)
    c.load(a.ctx)
    try {
      if (this.threads.hasSignals(t)) this.threads.deliverFor(t)
      setup()
      const r = c.run(deadline)
      if (r === STOP.RETURN) { const m = a.m!; a.m = null; const r0 = c.r[0], r1 = c.r[1]; c.save(a.ctx); c.load(outside); return { done: true, value: this.finishCall(m, r0, r1) } }
      if (r === STOP.BLOCK) { a.waiting = c.waiting; c.waiting = null; c.save(a.ctx); c.load(outside); return { done: false, block: a.waiting!.block } }
      c.save(a.ctx); c.load(outside)
      if (r === STOP.YIELD) return { done: false, block: null }
      throw new Error('arm: a java thread\'s native call ended oddly (' + r + ')')
    } catch (e) { this.fault = { pc: c.r[15] | (c.thumb ? 1 : 0), lr: c.r[14] }; if (c.r !== outside.r) { c.save(a.ctx); c.load(outside) } throw e }
  }
  signalsPending(t: JThread) { return this.threads.hasSignals(t) }
  takeSignals(t: JThread) { this.signalsOn(t, this.armOf(t)) }
  // runs a java thread's pending signal handlers on its own native stack
  private signalsOn(t: JThread, a: { ctx: Context }) {
    const c = this.cpu, outside = newContext()
    c.save(outside); c.load(a.ctx)
    try { this.threads.deliverFor(t) } finally { c.save(a.ctx); c.load(outside) }
  }
  fromNative(t: string, r0: number, r1: number) {
    if (t === 'V') return undefined
    if (t === 'J') return BigInt.asIntN(64, (BigInt(r1 >>> 0) << 32n) | BigInt(r0 >>> 0))
    if (t === 'D') return bitsf64((BigInt(r1 >>> 0) << 32n) | BigInt(r0 >>> 0))
    if (t === 'F') return bitsf32(r0)
    if (t === 'Z') return r0 & 0xff ? 1 : 0
    if (t[0] === 'L' || t[0] === '[') return this.deref(r0)
    if (t === 'B') return (r0 << 24) >> 24
    if (t === 'S') return (r0 << 16) >> 16
    if (t === 'C') return r0 & 0xffff
    return r0 | 0
  }

  // ---------- libc, liblog (soft-float abi: doubles in r0:r1) ----------
  private libc() {
    const m = this.mem, c = this.cpu
    const R = (i: number) => c.r[i]
    const stackArg = (i: number) => m.r32(c.r[13] + i * 4)
    this.def('malloc', () => m.malloc(R(0)))
    this.def('calloc', () => { const n = R(0) * R(1); const a = m.malloc(n); m.u8.fill(0, a, a + n); return a })
    this.def('realloc', () => { const old = R(0), n = R(1); const a = m.malloc(n); if (old) { m.u8.copyWithin(a, old, old + Math.min(n, m.sizeOf(old))); m.free(old) } return a })
    this.def('free', () => { m.free(R(0)) })
    const memcpy = () => { m.u8.copyWithin(R(0), R(1), R(1) + R(2)); return R(0) }
    for (const n of ['memcpy', 'memmove', '__aeabi_memcpy', '__aeabi_memmove', '__aeabi_memcpy4', '__aeabi_memcpy8']) this.def(n, memcpy)
    this.def('memset', () => { m.u8.fill(R(1) & 0xff, R(0), R(0) + R(2)); return R(0) })
    this.def('__aeabi_memset', () => { m.u8.fill(R(2) & 0xff, R(0), R(0) + R(1)); return R(0) })
    for (const n of ['__aeabi_memclr', '__aeabi_memclr4', '__aeabi_memclr8']) this.def(n, () => { m.u8.fill(0, R(0), R(0) + R(1)) })
    this.def('memcmp', () => { for (let i = 0; i < R(2); i++) { const d = m.u8[R(0) + i] - m.u8[R(1) + i]; if (d) return d } return 0 })
    this.def('strlen', () => { let e = R(0); while (m.u8[e]) e++; return e - R(0) })
    this.def('strcmp', () => { const a = m.cstr(R(0)), b = m.cstr(R(1)); return a < b ? -1 : a > b ? 1 : 0 })
    this.def('strncmp', () => { const a = m.cstr(R(0)).slice(0, R(2)), b = m.cstr(R(1)).slice(0, R(2)); return a < b ? -1 : a > b ? 1 : 0 })
    this.def('strcpy', () => { let i = 0; do m.u8[R(0) + i] = m.u8[R(1) + i]; while (m.u8[R(1) + i++]); return R(0) })
    this.def('strncpy', () => { let z = false; for (let i = 0; i < R(2); i++) { const b = z ? 0 : m.u8[R(1) + i]; if (!b) z = true; m.u8[R(0) + i] = b } return R(0) })
    this.def('strcat', () => { let e = R(0); while (m.u8[e]) e++; let i = 0; do m.u8[e + i] = m.u8[R(1) + i]; while (m.u8[R(1) + i++]); return R(0) })
    this.def('strchr', () => { for (let p = R(0); ; p++) { if (m.u8[p] === (R(1) & 0xff)) return p; if (!m.u8[p]) return 0 } })
    this.def('strrchr', () => { let last = 0; for (let p = R(0); ; p++) { if (m.u8[p] === (R(1) & 0xff)) last = p; if (!m.u8[p]) return last } })
    this.def('strstr', () => { const s = m.cstr(R(0)), i = s.indexOf(m.cstr(R(1))); return i < 0 ? 0 : R(0) + new TextEncoder().encode(s.slice(0, i)).length })
    this.def('strdup', () => this.str(m.cstr(R(0))))
    this.def('atoi', () => parseInt(m.cstr(R(0)), 10) | 0)
    this.def('strtol', () => parseInt(m.cstr(R(0)), R(2) || 10) | 0)
    this.def('abort', () => { throw new Error('native code called abort()') })
    this.def('__stack_chk_fail', () => { throw new Error('native stack corruption detected') })
    this.data('__stack_chk_guard', 4, (a) => m.w32(a, 0xd401d401))
    this.def('__cxa_atexit', () => 0)
    this.def('__cxa_finalize', () => 0)
    this.def('__errno', () => this.host.get('errno_slot')!)
    this.data('errno_slot', 4)
    this.def('time', () => { const t = Math.floor(Date.now() / 1000); if (R(0)) m.w32(R(0), t); return t })
    this.def('gettimeofday', () => { const t = Date.now(); m.w32(R(0), Math.floor(t / 1000)); m.w32(R(0) + 4, (t % 1000) * 1000); return 0 })
    this.def('clock_gettime', () => { const t = performance.now(); m.w32(R(1), Math.floor(t / 1000)); m.w32(R(1) + 4, Math.floor((t % 1000) * 1e6)); return 0 })
    this.def('rand', () => (Math.random() * 0x7fffffff) | 0)
    this.def('srand', () => {})
    this.def('usleep', () => 0)
    this.def('sleep', () => 0)
    this.def('getpid', () => 1000)
    for (const n of ['pthread_mutex_init', 'pthread_mutex_lock', 'pthread_mutex_unlock', 'pthread_mutex_destroy', 'pthread_cond_init', 'pthread_cond_signal', 'pthread_cond_broadcast', 'pthread_attr_init', 'pthread_attr_destroy', 'pthread_setspecific', 'pthread_key_delete']) this.def(n, () => 0)
    this.def('pthread_self', () => 1)
    const keys: number[] = []
    this.def('pthread_key_create', () => { keys.push(0); m.w32(R(0), keys.length); return 0 })
    this.def('pthread_getspecific', () => 0)
    this.def('pthread_once', () => { if (!m.r32(R(0))) { m.w32(R(0), 1); c.call(R(1)) } return 0 })
    // integer division helpers (armv7 without the divide extension)
    this.def('__aeabi_idiv', () => (R(1) | 0) === 0 ? 0 : ((R(0) | 0) / (R(1) | 0)) | 0)
    this.def('__aeabi_uidiv', () => R(1) === 0 ? 0 : Math.floor(R(0) / R(1)))
    this.def('__aeabi_idivmod', () => { const a = R(0) | 0, b = R(1) | 0; if (!b) return 0n; const q = (a / b) | 0, r = a - q * b; return (BigInt(r >>> 0) << 32n) | BigInt(q >>> 0) })
    this.def('__aeabi_uidivmod', () => { const a = R(0), b = R(1); if (!b) return 0n; const q = Math.floor(a / b), r = a - q * b; return (BigInt(r >>> 0) << 32n) | BigInt(q >>> 0) })
    const ll = (lo: number, hi: number) => BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo))
    this.def('__aeabi_ldivmod', () => { const a = ll(R(0), R(1)), b = ll(R(2), R(3)); if (!b) return 0n; const q = a / b, r = a % b; const ur = BigInt.asUintN(64, r); c.r[2] = Number(ur & 0xffffffffn); c.r[3] = Number(ur >> 32n); return q })
    this.def('__aeabi_uldivmod', () => { const a = BigInt.asUintN(64, ll(R(0), R(1))), b = BigInt.asUintN(64, ll(R(2), R(3))); if (!b) return 0n; c.r[2] = Number((a % b) & 0xffffffffn); c.r[3] = Number((a % b) >> 32n); return a / b })
    // soft-float math
    const d = (lo: number, hi: number) => bitsf64((BigInt(hi) << 32n) | BigInt(lo))
    const ret = (x: number) => f64bits(x)
    for (const [n, fn] of [['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan], ['sqrt', Math.sqrt], ['exp', Math.exp], ['log', Math.log], ['floor', Math.floor], ['ceil', Math.ceil], ['fabs', Math.abs], ['atan', Math.atan]] as const) this.def(n, () => ret(fn(d(R(0), R(1)))))
    this.def('pow', () => ret(Math.pow(d(R(0), R(1)), d(R(2), R(3)))))
    this.def('atan2', () => ret(Math.atan2(d(R(0), R(1)), d(R(2), R(3)))))
    for (const [n, fn] of [['sinf', Math.sin], ['cosf', Math.cos], ['sqrtf', Math.sqrt], ['fabsf', Math.abs], ['floorf', Math.floor]] as const) this.def(n, () => f32bits(fn(bitsf32(R(0)))))
    // printf family, with a small formatter that reads varargs (core regs, then the stack)
    const fmt = (f: string, next: () => number, nextD: () => number) => f.replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?(hh|h|ll|l|z)?([diuxXcspfgeE%])/g, (all, flags, width, prec, len, conv) => {
      let s = ''
      if (conv === '%') return '%'
      if (conv === 's') s = m.cstr(next())
      else if (conv === 'c') s = String.fromCharCode(next())
      else if (conv === 'p') s = '0x' + next().toString(16)
      else if ('fgeE'.includes(conv)) { const v = nextD(); s = conv === 'f' ? v.toFixed(prec ? +prec : 6) : String(v) }
      else if (len === 'll') { const lo = next(), hi = next(); const v = ll(lo, hi); s = conv === 'x' || conv === 'X' ? BigInt.asUintN(64, v).toString(16) : conv === 'u' ? BigInt.asUintN(64, v).toString() : v.toString() }
      else { const v = next(); s = conv === 'd' || conv === 'i' ? String(v | 0) : conv === 'u' ? String(v >>> 0) : (v >>> 0).toString(16) }
      if (conv === 'X') s = s.toUpperCase()
      if (width && s.length < +width) s = flags.includes('-') ? s.padEnd(+width) : s.padStart(+width, flags.includes('0') ? '0' : ' ')
      return s
    })
    const varargs = (firstReg: number) => {
      let i = firstReg
      const next = () => (i < 4 ? c.r[i++] : stackArg(i++ - 4))
      const nextD = () => { if (i % 2) i++; const lo = next(), hi = next(); return d(lo, hi) }
      return { next, nextD }
    }
    const fromVaList = (p: number) => {
      let a = p
      return { next: () => { const v = m.r32(a); a += 4; return v }, nextD: () => { a = (a + 7) & ~7; const lo = m.r32(a), hi = m.r32(a + 4); a += 8; return d(lo, hi) } }
    }
    const PRIO = ['', '', 'V', 'D', 'I', 'W', 'E', 'F']
    this.def('__android_log_print', () => { const v = varargs(3); console.log(`${PRIO[R(0)] || '?'}/${m.cstr(R(1))}: ${fmt(m.cstr(R(2)), v.next, v.nextD)}`); return 1 })
    this.def('__android_log_write', () => { console.log(`${PRIO[R(0)] || '?'}/${m.cstr(R(1))}: ${m.cstr(R(2))}`); return 1 })
    this.def('__android_log_vprint', () => { const v = fromVaList(R(3)); console.log(`${PRIO[R(0)] || '?'}/${m.cstr(R(1))}: ${fmt(m.cstr(R(2)), v.next, v.nextD)}`); return 1 })
    const out = (s: string) => console.log('[native] ' + s)
    this.def('printf', () => { const v = varargs(1); const s = fmt(m.cstr(R(0)), v.next, v.nextD); out(s); return s.length })
    this.def('puts', () => { out(m.cstr(R(0))); return 1 })
    const write = (dst: number, max: number, s: string) => { const b = new TextEncoder().encode(s); const n = Math.min(b.length, max - 1); m.u8.set(b.subarray(0, n), dst); m.u8[dst + n] = 0; return b.length }
    this.def('sprintf', () => { const v = varargs(2); return write(R(0), 1 << 20, fmt(m.cstr(R(1)), v.next, v.nextD)) })
    this.def('snprintf', () => { const v = varargs(3); return write(R(0), R(1), fmt(m.cstr(R(2)), v.next, v.nextD)) })
    this.def('vsnprintf', () => { const v = fromVaList(R(3)); return write(R(0), R(1), fmt(m.cstr(R(2)), v.next, v.nextD)) })
    this.def('dlopen', () => 1)
    this.def('dlsym', () => this.resolve(m.cstr(R(1))))
    this.def('dlclose', () => 0)
    this.def('dlerror', () => 0)
  }

  // ---------- jni ----------
  private jni() {
    const m = this.mem, c = this.cpu, vm = this.vm
    const R = (i: number) => c.r[i]
    const stackArg = (i: number) => m.r32(c.r[13] + i * 4)
    const table = new Array(233).fill(0)
    const name = (i: number) => `jni#${i}`
    const set = (i: number, fn: HostFn) => (table[i] = c.hostFn(name(i), fn))
    const guard = (fn: HostFn): HostFn => (cpu) => { try { return fn(cpu) } catch (e) { if (e instanceof JavaThrow) { this.pending = e; return 0 } throw e } }
    const methods: JMethod[] = [null as any]
    const fields: { cls: string; name: string; type: string; isStatic: boolean }[] = [null as any]
    const clsOf = (h: number) => { const o = this.deref(h); return o?.f?.of ?? vm.classOf(o) }
    const jtype = (n: string) => n.startsWith('[') ? n : 'L' + n + ';'

    set(4, () => 0x00010006) // GetVersion
    set(6, guard(() => { const c2 = vm.cls(jtype(m.cstr(R(1)))); vm.init(c2); return this.ref(vm.classObject(c2)) })) // FindClass
    set(10, () => { const k = clsOf(R(1)); return k?.super ? this.ref(vm.classObject(k.super)) : 0 })
    set(11, () => (vm.isSubclass(clsOf(R(1)), clsOf(R(2))) ? 1 : 0))
    set(13, () => { this.pending = new JavaThrow(this.deref(R(1))); return 0 }) // Throw
    set(14, () => { const k = clsOf(R(1)); const o = new JObject(k); o.f.message = m.cstr(R(2)); this.pending = new JavaThrow(o); return 0 }) // ThrowNew
    set(15, () => (this.pending ? this.ref(this.pending.obj) : 0)) // ExceptionOccurred
    set(16, () => { if (this.pending) console.warn('jni exception', jstr(vm, this.pending.obj)) })
    set(17, () => { this.pending = null }) // ExceptionClear
    set(18, () => { throw new Error('FatalError: ' + m.cstr(R(1))) })
    set(19, () => 0); set(20, () => R(1)) // Push/PopLocalFrame
    set(21, () => this.ref(this.deref(R(1)))); set(22, () => this.unref(R(1))); set(23, () => this.unref(R(1))) // New/DeleteGlobalRef, DeleteLocalRef
    set(24, () => (this.deref(R(1)) === this.deref(R(2)) ? 1 : 0)); set(25, () => this.ref(this.deref(R(1)))); set(26, () => 0)
    set(27, () => this.ref(new JObject(clsOf(R(1))))) // AllocObject
    set(31, () => this.ref(vm.classObject(vm.classOf(this.deref(R(1)))))) // GetObjectClass
    set(32, () => (vm.instanceOf(this.deref(R(1)), clsOf(R(2))) ? 1 : 0))
    // no exact match: a method of that name whose parameters accept the given types (a subclass where
    // it takes a superclass), as unity's ReflectionHelper would pick
    const compatible = (k: JClass, key: string) => {
      const name = key.slice(0, key.indexOf('(')), want = splitParams(key.slice(key.indexOf('(')))
      const fits = (decl: string, got: string) => decl === got || (decl[0] === 'L' && got[0] === 'L' && (decl === 'Ljava/lang/Object;' || vm.hasClass(got) && vm.isSubclass(vm.cls(got), vm.cls(decl))))
      for (let c: JClass | null = k; c; c = c.super) for (const mm of c.methods.values()) if (mm.name === name && mm.params.length === want.length && mm.params.every((p, i) => fits(p, want[i]))) return mm
      return null
    }
    const getMethod = (isStatic: boolean) => guard(() => {
      // class names in a signature with dots (unity builds some from Class.getName) mean the same class
      const k = clsOf(R(1)), key = m.cstr(R(2)) + m.cstr(R(3)).replace(/L[^;()]*;/g, (x) => x.replace(/\./g, '/'))
      const mm = vm.findMethod(k, key) ?? compatible(k, key)
      if (!mm) throw vm.error('Ljava/lang/NoSuchMethodError;', `${k.name}->${key}`)
      methods.push(mm)
      void isStatic
      return methods.length - 1
    })
    set(33, getMethod(false)); set(113, getMethod(true))
    // argument readers for Call*Method (varargs), *V (va_list) and *A (jvalue array)
    const readArgs = (mm: JMethod, kind: 'var' | 'v' | 'a', first: number) => {
      let i = first, p = kind === 'v' ? R(first) : kind === 'a' ? R(first) : 0
      const word = () => (kind === 'var' ? (i < 4 ? c.r[i++] : stackArg(i++ - 4)) : (() => { const v = m.r32(p); p += 4; return v })())
      const dword = () => {
        if (kind === 'var') { if (i % 2) i++ } else if (kind === 'v') p = (p + 7) & ~7
        const lo = word(), hi = word()
        return (BigInt(hi) << 32n) | BigInt(lo)
      }
      return mm.params.map((t) => {
        if (kind === 'a') { const lo = m.r32(p), hi = m.r32(p + 4); p += 8; const b = (BigInt(hi) << 32n) | BigInt(lo); return t === 'J' ? BigInt.asIntN(64, b) : t === 'D' ? bitsf64(b) : t === 'F' ? bitsf32(lo) : t[0] === 'L' || t[0] === '[' ? this.deref(lo) : lo | 0 }
        if (t === 'J') return BigInt.asIntN(64, dword())
        if (t === 'D') return bitsf64(dword())
        if (t === 'F') return kind === 'var' ? bitsf64(dword()) : bitsf32(word()) // varargs promote float to double
        const w = word()
        return t[0] === 'L' || t[0] === '[' ? this.deref(w) : w | 0
      })
    }
    const toNative = (t: string, v: any): number | bigint => {
      if (t === 'V') return 0
      if (t === 'J') return BigInt.asUintN(64, v)
      if (t === 'D') return f64bits(v)
      if (t === 'F') return f32bits(v)
      if (t[0] === 'L' || t[0] === '[') return this.ref(v)
      return Number(v) | 0
    }
    // 34..93 Call<T>Method[V|A] and CallNonvirtual<T>Method[V|A], 114..143 CallStatic<T>Method[V|A]
    const TYPES = ['L', 'Z', 'B', 'C', 'S', 'I', 'J', 'F', 'D', 'V']
    TYPES.forEach((t, ti) => {
      ;(['var', 'v', 'a'] as const).forEach((kind, ki) => {
        set(34 + ti * 3 + ki, guard(() => { const mm = methods[R(2)]; const self = this.deref(R(1)); const virt = vm.findMethod(vm.classOf(self), mm.key) || mm; return toNative(mm.ret, vm.invoke(virt, self, readArgs(mm, kind, 3))) }))
        set(64 + ti * 3 + ki, guard(() => { const mm = methods[R(3)]; return toNative(mm.ret, vm.invoke(mm, this.deref(R(1)), readArgs(mm, kind, 4))) }))
        set(114 + ti * 3 + ki, guard(() => { const mm = methods[R(2)]; return toNative(mm.ret, vm.invoke(mm, null, readArgs(mm, kind, 3))) }))
      })
    })
    set(28, guard(() => { const mm = methods[R(2)]; const o = new JObject(clsOf(R(1))); vm.invoke(mm, o, readArgs(mm, 'var', 3)); return this.ref(o) })) // NewObject
    set(29, guard(() => { const mm = methods[R(2)]; const o = new JObject(clsOf(R(1))); vm.invoke(mm, o, readArgs(mm, 'v', 3)); return this.ref(o) }))
    set(30, guard(() => { const mm = methods[R(2)]; const o = new JObject(clsOf(R(1))); vm.invoke(mm, o, readArgs(mm, 'a', 3)); return this.ref(o) }))
    const getField = (isStatic: boolean) => () => { fields.push({ cls: clsOf(R(1)).name, name: m.cstr(R(2)), type: m.cstr(R(3)), isStatic }); return fields.length - 1 }
    set(94, getField(false)); set(144, getField(true))
    const FT = ['L', 'Z', 'B', 'C', 'S', 'I', 'J', 'F', 'D']
    FT.forEach((t, ti) => {
      set(95 + ti, () => { const f = fields[R(2)]; const o = this.deref(R(1)); const v = o?.f[f.name] ?? (t === 'J' ? 0n : t === 'L' ? null : 0); return toNative(f.type, v) })
      set(104 + ti, () => { const f = fields[R(2)]; const o = this.deref(R(1)); o.f[f.name] = valueArg(f.type, 3) })
      set(145 + ti, () => { const f = fields[R(2)]; const k = vm.cls(f.cls); vm.init(k); return toNative(f.type, k.staticValues[f.name]) })
      set(154 + ti, () => { const f = fields[R(2)]; const k = vm.cls(f.cls); k.staticValues[f.name] = valueArg(f.type, 3) })
    })
    const valueArg = (t: string, i: number) => {
      if (t === 'J' || t === 'D') { const lo = i % 2 ? R(i + 1) : R(i), hi = i % 2 ? stackArg(0) : R(i + 1); const b = (BigInt(hi) << 32n) | BigInt(lo); return t === 'J' ? BigInt.asIntN(64, b) : bitsf64(b) }
      if (t === 'F') return bitsf32(R(i))
      if (t[0] === 'L' || t[0] === '[') return this.deref(R(i))
      return R(i) | 0
    }
    // strings
    set(163, () => { let s = ''; for (let i = 0; i < R(2); i++) s += String.fromCharCode(m.r16(R(1) + i * 2)); return this.ref(s) }) // NewString
    set(164, () => String(this.deref(R(1)) ?? '').length)
    set(165, () => { const s = String(this.deref(R(1))); const a = m.malloc(s.length * 2 + 2); for (let i = 0; i < s.length; i++) m.w16(a + i * 2, s.charCodeAt(i)); if (R(2)) m.w8(R(2), 1); return a })
    set(166, () => m.free(R(2)))
    set(167, () => this.ref(m.cstr(R(1)))) // NewStringUTF
    set(168, () => new TextEncoder().encode(String(this.deref(R(1)))).length)
    set(169, () => { if (R(2)) m.w8(R(2), 1); return this.str(String(this.deref(R(1)))) }) // GetStringUTFChars
    set(170, () => m.free(R(2)))
    set(220, () => { const s = String(this.deref(R(1))); for (let i = 0; i < R(3); i++) m.w16(stackArg(0) + i * 2, s.charCodeAt(R(2) + i)) })
    set(221, () => { const s = String(this.deref(R(1))).substr(R(2), R(3)); const b = new TextEncoder().encode(s); m.u8.set(b, stackArg(0)); m.u8[stackArg(0) + b.length] = 0 })
    set(224, () => table[165] && c.host[(table[165] - 0xfff00000) / 4].fn(c)); set(225, () => m.free(R(2)))
    // arrays
    set(171, () => (this.deref(R(1)) as JArray)?.data.length ?? 0)
    set(172, () => { const a = vm.newArray('[' + clsOf(R(2)).name, R(1)); if (R(3)) a.data.fill(this.deref(R(3))); return this.ref(a) })
    set(173, () => this.ref((this.deref(R(1)) as JArray).data[R(2)]))
    set(174, () => { ((this.deref(R(1)) as JArray).data as any[])[R(2)] = this.deref(R(3)) })
    const PRIM = ['Z', 'B', 'C', 'S', 'I', 'J', 'F', 'D']
    const SIZE = [1, 1, 2, 2, 4, 8, 4, 8]
    const elems = new Map<number, JArray>()
    const copyOut = (arr: JArray, t: string, dst: number, start: number, n: number) => {
      const sz = SIZE[PRIM.indexOf(t)]
      for (let i = 0; i < n; i++) {
        const v = (arr.data as any)[start + i], a = dst + i * sz
        if (t === 'J') m.dv.setBigInt64(a, BigInt(v), true); else if (t === 'D') m.dv.setFloat64(a, v, true); else if (t === 'F') m.dv.setFloat32(a, v, true)
        else if (sz === 4) m.w32(a, v); else if (sz === 2) m.w16(a, v); else m.w8(a, v)
      }
    }
    const copyIn = (arr: JArray, t: string, src: number, start: number, n: number) => {
      const sz = SIZE[PRIM.indexOf(t)]
      for (let i = 0; i < n; i++) {
        const a = src + i * sz
        ;(arr.data as any)[start + i] = t === 'J' ? m.dv.getBigInt64(a, true) : t === 'D' ? m.dv.getFloat64(a, true) : t === 'F' ? m.dv.getFloat32(a, true) : sz === 4 ? m.dv.getInt32(a, true) : sz === 2 ? (t === 'C' ? m.r16(a) : m.dv.getInt16(a, true)) : (t === 'Z' ? m.r8(a) : m.dv.getInt8(a))
      }
    }
    PRIM.forEach((t, i) => {
      set(175 + i, () => this.ref(vm.newArray('[' + t, R(1)))) // New<T>Array
      set(183 + i, () => { const arr = this.deref(R(1)) as JArray; const a = m.malloc(arr.data.length * SIZE[i] + 8); copyOut(arr, t, a, 0, arr.data.length); elems.set(a, arr); if (R(2)) m.w8(R(2), 1); return a }) // Get<T>ArrayElements
      set(191 + i, () => { const arr = this.deref(R(1)) as JArray; if (R(3) !== 2) copyIn(arr, t, R(2), 0, arr.data.length); if (R(3) !== 1) { m.free(R(2)); elems.delete(R(2)) } }) // Release<T>ArrayElements
      set(199 + i, () => copyOut(this.deref(R(1)), t, stackArg(0), R(2), R(3))) // Get<T>ArrayRegion
      set(207 + i, () => copyIn(this.deref(R(1)), t, stackArg(0), R(2), R(3))) // Set<T>ArrayRegion
    })
    set(222, () => { const arr = this.deref(R(1)) as JArray; const t = arr.cls.name.slice(1); return table[183 + PRIM.indexOf(t)] && c.host[(table[183 + PRIM.indexOf(t)] - 0xfff00000) / 4].fn(c) })
    set(223, () => { const arr = this.deref(R(1)) as JArray; const t = arr.cls.name.slice(1); copyIn(arr, t, R(2), 0, arr.data.length); if (R(3) !== 1) m.free(R(2)) })
    // natives, monitors, vm
    set(215, () => { // RegisterNatives(env, clazz, methods, n): {name, signature, fnPtr}
      const k = clsOf(R(1))
      for (let i = 0; i < R(3); i++) { const e = R(2) + i * 12; this.registered.set(`${k.name}->${m.cstr(m.r32(e))}${m.cstr(m.r32(e + 4))}`, m.r32(e + 8)) }
      return 0
    })
    set(216, () => 0); set(217, () => 0); set(218, () => 0)
    set(219, () => { m.w32(R(1), this.jvm); return 0 }) // GetJavaVM
    set(226, () => this.ref(this.deref(R(1)))); set(227, () => this.unref(R(1)))
    set(228, () => (this.pending ? 1 : 0)) // ExceptionCheck
    // direct byte buffers (java.nio, see nio.ts): native memory both sides see
    const nio = () => (vm as any).nio as { address(o: any): number; capacity(o: any): number; wrapNative(a: number, n: number, bytes: () => Uint8Array): any }
    set(229, () => this.ref(nio().wrapNative(R(1), R(2), () => m.u8))) // NewDirectByteBuffer(env, addr, jlong capacity: r2 low word)
    set(230, () => nio().address(this.deref(R(1)))) // GetDirectBufferAddress
    set(231, () => BigInt(nio().capacity(this.deref(R(1)))) as any) // GetDirectBufferCapacity
    set(232, () => 1)
    for (let i = 0; i < table.length; i++) if (!table[i]) table[i] = c.hostFn(name(i), () => { this.missing.add(`jni function ${i}`); console.warn('jni function not supported', i); return 0 })
    // JNIEnv: pointer to a pointer to the table
    const tab = m.malloc(table.length * 4)
    table.forEach((f, i) => m.w32(tab + i * 4, f))
    this.env = m.malloc(4)
    m.w32(this.env, tab)
    // JavaVM: DestroyJavaVM, AttachCurrentThread, DetachCurrentThread, GetEnv, AttachCurrentThreadAsDaemon
    const vmt = m.malloc(8 * 4)
    const putEnv = () => { m.w32(R(1), this.env); return 0 }
    ;[0, 0, 0, c.hostFn('DestroyJavaVM', () => 0), c.hostFn('AttachCurrentThread', putEnv), c.hostFn('DetachCurrentThread', () => 0), c.hostFn('GetEnv', putEnv), c.hostFn('AttachCurrentThreadAsDaemon', putEnv)].forEach((f, i) => m.w32(vmt + i * 4, f))
    this.jvm = m.malloc(4)
    m.w32(this.jvm, vmt)
  }
}

const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer), f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer)
export const f64bits = (x: number) => { f64[0] = x; return u64[0] }
export const bitsf64 = (b: bigint) => { u64[0] = BigInt.asUintN(64, b); return f64[0] }
export const f32bits = (x: number) => { f32[0] = x; return u32[0] }
export const bitsf32 = (b: number) => { u32[0] = b >>> 0; return f32[0] }
export { splitParams }
