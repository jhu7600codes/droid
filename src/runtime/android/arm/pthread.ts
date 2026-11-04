// native threads: pthreads on the green threads (threads.ts). each pthread has its own registers and
// stack and is scheduled like a java thread. the "outside" context (java calling native, nested from js)
// counts as one pthread per java thread. mutexes, conditions, semaphores, keys, once, join, signals
// (enough for a stop-the-world garbage collector: pthread_kill + sigsuspend), setjmp / longjmp.
import { CPU, STOP, THREAD_EXIT_TRAP, SIGRETURN_TRAP, newContext, type Context } from './cpu.ts'
import { Block, scheduler, taskId, type Task } from '../threads.ts'
import { JThread } from '../dalvik.ts'
import type { Native } from './native.ts'

const EBUSY = 16, EINVAL = 22, ETIMEDOUT = 110, EDEADLK = 35, EPERM = 1, ESRCH = 3, EINTR = 4, EAGAIN = 11
const now = () => performance.now()

export class PThread implements Task {
  id = taskId()
  name: string
  state: Task['state'] = 'runnable'
  block: Block | null = null
  busy = false
  ctx: Context = newContext()
  waiting: CPU['waiting'] = null
  handle = 0 // the pthread_t value
  stackBase = 0
  stackSize = 0
  exitValue = 0
  jthread: JThread // the java thread it is when it calls jni
  tls = new Map<number, number>()
  pendingSignals: number[] = []
  sigmask = 0
  handled = 0 // signals handled so far (sigsuspend waits for one more)
  inSignal: { ctx: Context; waiting: CPU['waiting']; block: Block | null; state: Task['state'] }[] = []
  detached = false
  errno = 0
  nat: Native
  constructor(nat: Native, name: string) { this.nat = nat; this.name = name; this.jthread = new JThread(nat.vm, name); this.jthread.busy = true }
  step(ms: number) { this.nat.threads.step(this, ms) }
}

// the per-java-thread view of the outside context (no own registers: it is whatever runs nested)
interface Outside { handle: number; tls: Map<number, number>; pendingSignals: number[]; sigmask: number; handled: number; errno: number; stackBase: number; stackSize: number; name: string; jthread: JThread }

export class Threads {
  nat: Native
  current: PThread | null = null // the pthread whose context the cpu holds (null: the outside)
  all = new Map<number, PThread | Outside>() // handle -> thread
  private outside = new Map<JThread, Outside>()
  private keys: { used: boolean; dtor: number }[] = []
  handlers = new Map<number, { fn: number; flags: number; mask: number }>()
  mainStackBase = 0
  mainStackSize = 0
  private signalDepth = 0

  constructor(nat: Native) {
    this.nat = nat
    nat.cpu.pump = (b) => this.pump(b)
    // signals for the outside threads are delivered while they wait in place
    scheduler.pollers.add(() => this.deliverOutside())
  }

  // the thread (pthread or outside view) running right now
  me(): PThread | Outside {
    if (this.current) return this.current
    const jt = this.nat.vm.current
    let o = this.outside.get(jt)
    if (!o) {
      // a java thread runs native code on its own stack (resumable calls) or, for calls made from
      // the runtime itself, on the main one: its stack is whichever holds the current sp
      const nat = this.nat, main = this
      const onOwn = () => { const a = (jt as any).armStack; const sp = nat.cpu.r[13]; return a && (main.nat.vm.current !== jt || (sp >= a.base && sp <= a.base + a.size)) ? a : null }
      o = { handle: this.nat.mem.malloc(64), tls: new Map(), pendingSignals: [], sigmask: 0, handled: 0, errno: 0,
        get stackBase() { return onOwn()?.base ?? main.mainStackBase }, get stackSize() { return onOwn()?.size ?? main.mainStackSize },
        name: jt.name, jthread: jt }
      this.nat.mem.w32(o.handle + 4, 1000 + this.outside.size) // tid at +4, like bionic's pthread_internal_t
      this.outside.set(jt, o)
      this.all.set(o.handle, o)
    }
    return o
  }
  task(): Task { return this.current ?? this.nat.vm.current }
  tid(t = this.me()) { return this.nat.mem.r32(t.handle + 4) }

  // a nested wait: other threads run until it clears
  pump(b: Block) { return scheduler.pump(this.task(), b) }

  // ---------- creating and running pthreads ----------
  create(entry: number, arg: number, stackSize: number, name = 'pthread') {
    const m = this.nat.mem, c = this.nat.cpu
    const t = new PThread(this.nat, name)
    t.stackSize = Math.max(64 * 1024, stackSize || 1024 * 1024)
    t.stackBase = m.memalign(4096, t.stackSize)
    t.handle = m.malloc(64)
    m.w32(t.handle + 4, 2000 + t.id)
    t.ctx.tls = m.malloc(256)
    m.w32(t.ctx.tls, t.ctx.tls) // tls slot 0: itself (bionic TLS_SLOT_SELF)
    m.w32(t.ctx.tls + 4, 2000 + t.id) // slot 1: thread id
    // set up the first call on the new context
    const keep = { r: c.r, fp: c.fp, N: c.N, Z: c.Z, C: c.C, V: c.V, thumb: c.thumb, it: c.it, tls: c.tls } as Context
    c.save(keep)
    c.load(t.ctx)
    c.r[13] = (t.stackBase + t.stackSize - 16) >>> 0
    c.setupCall(entry, [arg], THREAD_EXIT_TRAP)
    c.save(t.ctx)
    c.load(keep)
    this.all.set(t.handle, t)
    scheduler.add(t)
    return t
  }

  step(t: PThread, ms: number) {
    const c = this.nat.cpu, vm = this.nat.vm
    const outsideCtx = newContext()
    c.save(outsideCtx)
    const prevCur = this.current, prevJ = vm.current
    c.load(t.ctx)
    this.current = t
    vm.current = t.jthread
    t.busy = true
    try {
      let go = true
      // a signal handler first (it runs on top of whatever the thread was doing, waits included)
      if (t.pendingSignals.length && !this.blockedSignal(t)) this.enterSignal(t)
      else if (t.waiting) {
        if (!t.waiting.block.ready()) { t.state = 'blocked'; t.block = t.waiting.block; go = false }
        else { const w = t.waiting; t.waiting = null; t.block = null; c.waiting = w; c.resume(w.block.finish()) }
      }
      if (go) {
        const r = c.run(performance.now() + ms)
        if (r === STOP.BLOCK) { t.waiting = c.waiting; c.waiting = null; t.block = t.waiting!.block; t.state = 'blocked' }
        else if (r === STOP.EXIT) { t.exitValue = c.r[0]; this.finish(t) }
        else if (r === STOP.SIGRETURN) this.leaveSignal(t)
        else if (r === STOP.RETURN) throw new Error('arm: a thread returned to the call trap')
      }
    } catch (e) {
      t.state = 'done'
      console.warn(`native thread "${t.name}" crashed:`, (e as Error)?.message || e)
    } finally {
      c.save(t.ctx)
      c.load(outsideCtx)
      this.current = prevCur
      vm.current = prevJ
      t.busy = false
    }
  }
  private finish(t: PThread) {
    t.state = 'done'
    // pthread_key destructors are not run (apps rarely depend on them)
    if (t.detached) this.all.delete(t.handle)
    scheduler.wake()
  }

  // ---------- signals ----------
  private blockedSignal(t: PThread | Outside) { return t.pendingSignals.every((s) => (t.sigmask >>> (s - 1)) & 1) }
  send(target: PThread | Outside, sig: number) {
    if (!sig) return 0
    const h = this.handlers.get(sig)
    if (!h || h.fn === 0 || h.fn === 1) return 0 // default / ignore: nothing to do here
    target.pendingSignals.push(sig)
    if (target instanceof PThread && target.state === 'blocked') target.state = 'runnable'
    scheduler.wake()
    return 0
  }
  private nextSignal(t: PThread | Outside) {
    const i = t.pendingSignals.findIndex((s) => !((t.sigmask >>> (s - 1)) & 1))
    return i < 0 ? 0 : t.pendingSignals.splice(i, 1)[0]
  }
  // runs the handler on top of the pthread's current state; SIGRETURN restores it
  private enterSignal(t: PThread) {
    const c = this.nat.cpu, m = this.nat.mem
    const sig = this.nextSignal(t)
    const h = this.handlers.get(sig)
    if (!h) return
    t.handled++
    const saved = newContext()
    c.save(saved)
    const copy: Context = { ...saved, r: saved.r.slice(), fp: Object.assign(Object.create(Object.getPrototypeOf(saved.fp)), { buf: saved.fp.buf.slice(0), fpscr: saved.fp.fpscr }) }
    copy.fp.s = new Float32Array(copy.fp.buf); copy.fp.d = new Float64Array(copy.fp.buf); copy.fp.u = new Uint32Array(copy.fp.buf); copy.fp.b = new Uint8Array(copy.fp.buf)
    t.inSignal.push({ ctx: copy, waiting: t.waiting, block: t.block, state: 'runnable' })
    t.waiting = null; t.block = null
    const mask = t.sigmask
    t.sigmask |= h.mask | (1 << (sig - 1))
    ;(t.inSignal[t.inSignal.length - 1] as any).mask = mask
    // siginfo and a ucontext (with the interrupted sp / pc) on the stack, below the red zone
    let sp = (c.r[13] - 256 - 128) & ~15
    const info = sp, uc = sp + 128
    m.u8.fill(0, info, info + 256)
    m.w32(info, sig)
    m.w32(uc + 20 + 13 * 4 + 12, copy.r[13]); m.w32(uc + 20 + 15 * 4 + 12, copy.r[15])
    c.r[13] = sp
    c.setupCall(h.fn, [sig, info, uc], SIGRETURN_TRAP)
  }
  private leaveSignal(t: PThread) {
    const c = this.nat.cpu
    const s = t.inSignal.pop()!
    t.sigmask = (s as any).mask ?? t.sigmask
    // continue exactly where the signal came in (inside a wait, the wait goes on)
    s.ctx.fp && c.load(s.ctx)
    t.waiting = s.waiting
    t.block = s.block
    if (s.waiting) { t.state = 'blocked'; t.block = s.waiting.block }
  }
  // a java thread with signals waiting (they run before its native code goes on; see Native.runOn)
  hasSignals(jt: JThread) { const o = this.outside.get(jt); return !!o && o.pendingSignals.length > 0 && !this.blockedSignal(o) }
  deliverFor(jt: JThread) { const prev = this.nat.vm.current; this.nat.vm.current = jt; try { this.deliverOutside() } finally { this.nat.vm.current = prev } }
  // outside threads (java calling native) take their signals while they wait in place
  private deliverOutside() {
    if (this.current || this.signalDepth > 4) return
    const o = this.outside.get(this.nat.vm.current)
    if (!o || !o.pendingSignals.length) return
    const sig = this.nextSignal(o)
    const h = this.handlers.get(sig)
    if (!h) return
    const m = this.nat.mem
    const mask = o.sigmask
    o.sigmask |= h.mask | (1 << (sig - 1))
    o.handled++
    this.signalDepth++
    try {
      const info = m.malloc(256)
      m.w32(info, sig)
      this.nat.cpu.call(h.fn, [sig, info, info + 128])
      m.free(info)
    } finally { this.signalDepth--; o.sigmask = mask }
  }

  // ---------- keys (thread-specific data) ----------
  keyCreate(dtor: number) { const i = this.keys.findIndex((k) => !k.used); const k = i >= 0 ? i : this.keys.length; this.keys[k] = { used: true, dtor }; return k }
  keyDelete(k: number) { if (this.keys[k]) this.keys[k].used = false }
}

// ---------- the libc side ----------
export function installPthreads(nat: Native) {
  const m = nat.mem, c = nat.cpu
  const R = (i: number) => c.r[i]
  const T = nat.threads
  const def = (name: string, fn: (cpu: CPU) => any) => nat.def(name, fn)
  const fromHandle = (h: number) => T.all.get(h)

  // the main (outside) stack bounds, for collectors that ask
  def('pthread_create', () => {
    const attr = R(1)
    const size = attr ? m.r32(attr + 8) : 0
    const t = T.create(R(2), R(3), size)
    if (attr && m.r32(attr) & 1) t.detached = true
    m.w32(R(0), t.handle)
    return 0
  })
  def('pthread_self', () => T.me().handle)
  def('pthread_equal', () => (R(0) === R(1) ? 1 : 0))
  def('gettid', () => T.tid())
  def('pthread_exit', () => {
    const t = T.current
    if (!t) throw new Error('pthread_exit on the main thread')
    c.r[0] = R(0)
    c.r[15] = THREAD_EXIT_TRAP
    return R(0)
  })
  def('pthread_join', () => {
    const t = fromHandle(R(0)), out = R(1)
    if (!(t instanceof PThread)) return ESRCH
    if (t === T.current) return EDEADLK
    const done = () => { if (out) m.w32(out, t.exitValue); T.all.delete(t.handle); return 0 }
    if (t.state === 'done') return done()
    throw new Block(() => t.state === 'done', Infinity, 'pthread_join').then(done)
  })
  def('pthread_detach', () => { const t = fromHandle(R(0)); if (t instanceof PThread) { t.detached = true; if (t.state === 'done') T.all.delete(t.handle) } return 0 })
  def('pthread_kill', () => { const t = fromHandle(R(0)); if (!t) return ESRCH; return T.send(t, R(1)) })
  def('tkill', () => { for (const t of T.all.values()) if (T.tid(t) === R(0)) return T.send(t, R(1)); return -1 })
  def('pthread_sigmask', () => sigmask())
  def('sigprocmask', () => sigmask())
  const sigmask = () => {
    const t = T.me(), how = R(0), set = R(1), old = R(2)
    if (old) m.w32(old, t.sigmask)
    if (set) { const v = m.r32(set); t.sigmask = how === 0 ? t.sigmask | v : how === 1 ? t.sigmask & ~v : v }
    return 0
  }
  // struct sigaction (bionic arm): handler, mask, flags, restorer
  def('sigaction', () => {
    const sig = R(0), act = R(1), old = R(2)
    const cur = T.handlers.get(sig)
    if (old) { m.w32(old, cur?.fn ?? 0); m.w32(old + 4, cur?.mask ?? 0); m.w32(old + 8, cur?.flags ?? 0); m.w32(old + 12, 0) }
    if (act) T.handlers.set(sig, { fn: m.r32(act), mask: m.r32(act + 4), flags: m.r32(act + 8) })
    return 0
  })
  def('bsd_signal', () => { const old = T.handlers.get(R(0))?.fn ?? 0; T.handlers.set(R(0), { fn: R(1), mask: 0, flags: 0 }); return old })
  def('signal', () => { const old = T.handlers.get(R(0))?.fn ?? 0; T.handlers.set(R(0), { fn: R(1), mask: 0, flags: 0 }); return old })
  def('raise', () => T.send(T.me(), R(0)))
  def('kill', () => (R(0) === 4242 || R(0) === 0 ? T.send(T.me(), R(1)) : -1))
  // sigsuspend: wait (with the given mask) until one more signal has been handled, then -1 / EINTR
  def('sigsuspend', () => {
    const t = T.me()
    const saved = t.sigmask, start = t.handled
    t.sigmask = m.r32(R(0))
    const done = () => { t.sigmask = saved; nat.setErrno(EINTR); return -1 }
    if (t instanceof PThread) throw new Block(() => t.handled > start || t.pendingSignals.some((s) => !((t.sigmask >>> (s - 1)) & 1)), Infinity, 'sigsuspend').then(() => (t.handled > start ? done() : (throwAgain(t, start, saved))))
    T.pump(new Block(() => t.handled > start, Infinity, 'sigsuspend'))
    return done()
  })
  // woken for a signal that is not handled yet: wait again (the handler runs first on the next step)
  const throwAgain = (t: PThread, start: number, saved: number): never => {
    throw new Block(() => t.handled > start, Infinity, 'sigsuspend').then(() => { t.sigmask = saved; nat.setErrno(EINTR); return -1 })
  }
  for (const n of ['sigemptyset', 'sigfillset']) def(n, () => { m.w32(R(0), n === 'sigfillset' ? 0xffffffff : 0); return 0 })
  def('sigaddset', () => { m.w32(R(0), m.r32(R(0)) | (1 << (R(1) - 1))); return 0 })
  def('sigdelset', () => { m.w32(R(0), m.r32(R(0)) & ~(1 << (R(1) - 1))); return 0 })
  def('sigismember', () => ((m.r32(R(0)) >>> (R(1) - 1)) & 1))
  def('sigaltstack', () => 0)

  // ---------- attributes ----------
  // pthread_attr_t (bionic): flags, stack_base, stack_size, guard_size, sched_policy, sched_priority
  def('pthread_attr_init', () => { m.u8.fill(0, R(0), R(0) + 24); m.w32(R(0) + 8, 1024 * 1024); m.w32(R(0) + 12, 4096); return 0 })
  def('pthread_attr_destroy', () => 0)
  def('pthread_attr_setstacksize', () => { m.w32(R(0) + 8, R(1)); return 0 })
  def('pthread_attr_getstacksize', () => { m.w32(R(1), m.r32(R(0) + 8)); return 0 })
  def('pthread_attr_setdetachstate', () => { m.w32(R(0), (m.r32(R(0)) & ~1) | (R(1) & 1)); return 0 })
  def('pthread_attr_getdetachstate', () => { m.w32(R(1), m.r32(R(0)) & 1); return 0 })
  def('pthread_attr_setschedparam', () => 0)
  def('pthread_attr_getschedparam', () => { m.w32(R(1), 0); return 0 })
  def('pthread_attr_setschedpolicy', () => 0)
  def('pthread_attr_setguardsize', () => 0)
  def('pthread_attr_getstack', () => { m.w32(R(1), m.r32(R(0) + 4)); m.w32(R(2), m.r32(R(0) + 8)); return 0 })
  def('pthread_getattr_np', () => {
    const t = fromHandle(R(0)) ?? T.me()
    m.u8.fill(0, R(1), R(1) + 24)
    m.w32(R(1) + 4, t.stackBase); m.w32(R(1) + 8, t.stackSize)
    return 0
  })
  def('pthread_getschedparam', () => { m.w32(R(1), 0); m.w32(R(2), 0); return 0 })
  def('pthread_setschedparam', () => 0)
  def('sched_get_priority_max', () => 99)
  def('sched_get_priority_min', () => 1)
  def('sched_yield', () => { if (T.current) throw new Block(() => true, 0, 'yield'); return 0 })
  def('pthread_setname_np', () => 0)

  // ---------- mutexes ----------
  // pthread_mutex_t is one word; bionic keeps the type in it (0x4000 recursive, 0x8000 error check)
  interface Mx { owner: Task | null; count: number; type: number }
  const mutexes = new Map<number, Mx>()
  const mx = (a: number): Mx => { let x = mutexes.get(a); if (!x) mutexes.set(a, (x = { owner: null, count: 0, type: (m.r32(a) & 0xc000) >>> 14 })); return x }
  def('pthread_mutexattr_init', () => { m.w32(R(0), 0); return 0 })
  def('pthread_mutexattr_destroy', () => 0)
  def('pthread_mutexattr_settype', () => { m.w32(R(0), R(1)); return 0 })
  def('pthread_mutexattr_gettype', () => { m.w32(R(1), m.r32(R(0))); return 0 })
  def('pthread_mutexattr_setpshared', () => 0)
  def('pthread_mutex_init', () => { const type = R(1) ? m.r32(R(1)) & 3 : 0; m.w32(R(0), type << 14); mutexes.set(R(0), { owner: null, count: 0, type }); return 0 })
  def('pthread_mutex_destroy', () => { mutexes.delete(R(0)); return 0 })
  const lock = (a: number, me: Task, wait: boolean): number | Block => {
    const x = mx(a)
    if (!x.owner) { x.owner = me; x.count = 1; return 0 }
    if (x.owner === me) { if (x.type === 1) { x.count++; return 0 } if (x.type === 2) return EDEADLK; if (!wait) return EBUSY }
    if (!wait) return EBUSY
    return new Block(() => !x.owner || x.owner.state === 'done', Infinity, 'mutex').then(() => { x.owner = me; x.count = 1; return 0 })
  }
  def('pthread_mutex_lock', () => { const r = lock(R(0), T.task(), true); if (r instanceof Block) throw r; return r })
  def('pthread_mutex_trylock', () => lock(R(0), T.task(), false))
  def('pthread_mutex_unlock', () => {
    const x = mx(R(0))
    if (x.owner !== T.task()) return x.owner ? EPERM : 0
    if (--x.count <= 0) { x.owner = null; x.count = 0; scheduler.wake() }
    return 0
  })
  def('pthread_mutex_timedlock', () => {
    const r = lock(R(0), T.task(), true)
    if (!(r instanceof Block)) return r
    const until = absUntil(R(1))
    const me = T.task()
    const x = mx(R(0))
    throw new Block(() => !x.owner || now() >= until, until, 'mutex').then(() => { if (x.owner) return ETIMEDOUT; x.owner = me; x.count = 1; return 0 })
  })
  // absolute CLOCK_REALTIME timespec -> performance.now() time
  const absUntil = (ts: number) => (ts ? m.r32(ts) * 1000 + m.r32(ts + 4) / 1e6 - Date.now() + now() : Infinity)

  // ---------- conditions ----------
  const conds = new Map<number, { waiters: { notified: boolean }[] }>()
  const cond = (a: number) => { let x = conds.get(a); if (!x) conds.set(a, (x = { waiters: [] })); return x }
  def('pthread_cond_init', () => { conds.set(R(0), { waiters: [] }); return 0 })
  def('pthread_cond_destroy', () => { conds.delete(R(0)); return 0 })
  def('pthread_condattr_init', () => 0); def('pthread_condattr_destroy', () => 0); def('pthread_condattr_setpshared', () => 0); def('pthread_condattr_setclock', () => 0)
  def('pthread_cond_signal', () => { const w = cond(R(0)).waiters.find((x) => !x.notified); if (w) { w.notified = true; scheduler.wake() } return 0 })
  def('pthread_cond_broadcast', () => { for (const w of cond(R(0)).waiters) w.notified = true; scheduler.wake(); return 0 })
  const condWait = (cv: number, mu: number, until: number) => {
    const me = T.task(), x = mx(mu), cq = cond(cv)
    const saved = x.count
    if (x.owner === me) { x.owner = null; x.count = 0; scheduler.wake() }
    const w = { notified: false }
    cq.waiters.push(w)
    return new Block(() => (w.notified || now() >= until) && (!x.owner || x.owner === me), until, 'cond').then(() => {
      const i = cq.waiters.indexOf(w)
      if (i >= 0) cq.waiters.splice(i, 1)
      x.owner = me; x.count = saved || 1
      return w.notified ? 0 : ETIMEDOUT
    })
  }
  def('pthread_cond_wait', () => { throw condWait(R(0), R(1), Infinity) })
  def('pthread_cond_timedwait', () => { throw condWait(R(0), R(1), absUntil(R(2))) })
  def('pthread_cond_timedwait_relative_np', () => { throw condWait(R(0), R(1), R(2) ? now() + m.r32(R(2)) * 1000 + m.r32(R(2) + 4) / 1e6 : Infinity) })
  def('pthread_cond_timeout_np', () => { throw condWait(R(0), R(1), now() + R(2)) })

  // ---------- read-write locks (as plain mutexes) ----------
  for (const n of ['pthread_rwlock_rdlock', 'pthread_rwlock_wrlock']) def(n, () => { const r = lock(R(0), T.task(), true); if (r instanceof Block) throw r; return r })
  for (const n of ['pthread_rwlock_tryrdlock', 'pthread_rwlock_trywrlock']) def(n, () => lock(R(0), T.task(), false))
  def('pthread_rwlock_unlock', () => { const x = mx(R(0)); if (x.owner === T.task() && --x.count <= 0) { x.owner = null; x.count = 0; scheduler.wake() } return 0 })
  def('pthread_rwlock_init', () => 0); def('pthread_rwlock_destroy', () => 0)

  // ---------- semaphores: the count lives in the sem_t word ----------
  def('sem_init', () => { m.w32(R(0), R(2)); return 0 })
  def('sem_destroy', () => 0)
  def('sem_post', () => { m.w32(R(0), m.r32(R(0)) + 1); scheduler.wake(); return 0 })
  def('sem_getvalue', () => { m.w32(R(1), m.r32(R(0)) | 0); return 0 })
  def('sem_trywait', () => { const v = m.r32(R(0)) | 0; if (v > 0) { m.w32(R(0), v - 1); return 0 } nat.setErrno(EAGAIN); return -1 })
  def('sem_wait', () => {
    const a = R(0), v = m.r32(a) | 0
    if (v > 0) { m.w32(a, v - 1); return 0 }
    throw new Block(() => (m.r32(a) | 0) > 0, Infinity, 'sem_wait').then(() => { m.w32(a, m.r32(a) - 1); return 0 })
  })
  def('sem_timedwait', () => {
    const a = R(0), v = m.r32(a) | 0
    if (v > 0) { m.w32(a, v - 1); return 0 }
    const until = absUntil(R(1))
    throw new Block(() => (m.r32(a) | 0) > 0 || now() >= until, until, 'sem_timedwait').then(() => { if ((m.r32(a) | 0) > 0) { m.w32(a, m.r32(a) - 1); return 0 } nat.setErrno(ETIMEDOUT); return -1 })
  })

  // ---------- keys, once ----------
  def('pthread_key_create', () => { m.w32(R(0), T.keyCreate(R(1))); return 0 })
  def('pthread_key_delete', () => { T.keyDelete(R(0)); return 0 })
  def('pthread_getspecific', () => T.me().tls.get(R(0)) ?? 0)
  def('pthread_setspecific', () => { T.me().tls.set(R(0), R(1)); return 0 })
  // pthread_once_t: 0 not yet, 1 running, 2 done
  def('pthread_once', () => {
    const a = R(0), fn = R(1)
    const s = m.r32(a)
    if (s === 2) return 0
    if (s === 1) throw new Block(() => m.r32(a) === 2, Infinity, 'pthread_once').then(() => 0)
    m.w32(a, 1)
    c.call(fn)
    m.w32(a, 2)
    scheduler.wake()
    return 0
  })
  def('__pthread_cleanup_push', () => 0)
  def('__pthread_cleanup_pop', () => { if (R(1)) { const fn = m.r32(R(0) + 4), arg = m.r32(R(0) + 8); if (fn) c.call(fn, [arg]) } return 0 })

  // ---------- sleeping ----------
  const sleepFor = (ms: number) => {
    if (ms <= 0) { if (T.current) throw new Block(() => true, 0, 'sleep').then(() => 0); return 0 }
    const until = now() + ms
    throw new Block(() => now() >= until, until, 'sleep').then(() => 0)
  }
  def('usleep', () => sleepFor(R(0) / 1000))
  def('sleep', () => sleepFor(R(0) * 1000))
  def('nanosleep', () => sleepFor(m.r32(R(0)) * 1000 + m.r32(R(0) + 4) / 1e6))

  // ---------- setjmp / longjmp: r4-r11, sp, lr and d8-d15 in the jmp_buf ----------
  const save = (buf: number) => {
    for (let i = 4; i <= 11; i++) m.w32(buf + (i - 4) * 4, c.r[i])
    m.w32(buf + 32, c.r[13]); m.w32(buf + 36, c.r[14])
    for (let i = 8; i < 16; i++) { m.dv.setFloat64(buf + 40 + (i - 8) * 8, c.fp.d[i], true) }
  }
  const restore = (buf: number, v: number) => {
    for (let i = 4; i <= 11; i++) c.r[i] = m.r32(buf + (i - 4) * 4)
    c.r[13] = m.r32(buf + 32)
    const lr = m.r32(buf + 36)
    for (let i = 8; i < 16; i++) c.fp.d[i] = m.dv.getFloat64(buf + 40 + (i - 8) * 8, true)
    c.r[0] = v || 1
    // continue after the setjmp call (its return address), as if it returned v
    c.thumb = (lr & 1) === 1
    c.r[15] = lr & ~1
    c.r[14] = lr
    return c.r[0]
  }
  for (const n of ['setjmp', '_setjmp']) def(n, () => { save(R(0)); return 0 })
  def('sigsetjmp', () => { save(R(0)); m.w32(R(0) + 104, R(1) ? T.me().sigmask : 0xffffffff); return 0 })
  for (const n of ['longjmp', '_longjmp']) def(n, () => restore(R(0), R(1)))
  def('siglongjmp', () => { const mk = m.r32(R(0) + 104); if (mk !== 0xffffffff) T.me().sigmask = mk; return restore(R(0), R(1)) })
}

export { STOP, SIGRETURN_TRAP, EINVAL }
