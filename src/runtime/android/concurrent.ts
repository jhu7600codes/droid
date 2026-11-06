// framework shim, part 5: java threads and java.util.concurrent on the green threads (threads.ts).
// Thread.start makes a real (green) thread; sleep, join, wait / notify, locks, semaphores, latches,
// blocking queues and executors block properly instead of returning at once.
import { VM, JObject, JThread, JavaThrow, JavaCall, Handled, type NativeFn } from './dalvik.ts'
import { Block, scheduler, waitOn, notify, tryEnter, enterBlock, exit, holds, monitorOf } from './threads.ts'
import { box, unbox } from './java.ts'

const OBJ = 'Ljava/lang/Object;'
const now = () => performance.now()
const ms = (j: any) => Number(j)

export function registerConcurrent(vm: VM) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => vm.shim(name, { super: sup, methods, ...extra })
  const ie = () => vm.error('Ljava/lang/InterruptedException;', 'interrupted')
  // a block that also wakes up (and throws) when the thread is interrupted
  const interruptible = (t: JThread, ready: () => boolean, until: number, what: string, then: () => any = () => undefined) =>
    new Block(() => t.interrupted || ready(), until, what).then(() => { if (t.interrupted) { t.interrupted = false; throw ie() } return then() })

  // ---------- Object monitors ----------
  const objShim = vm.shims.get(OBJ)!
  vm.shim(OBJ, { ...objShim, methods: { ...objShim.methods,
    'wait()V': (v: VM, s: any) => { throw waitOn(s, vm.current) },
    'wait(J)V': (v: VM, s: any, [t]: any[]) => { throw waitOn(s, vm.current, ms(t)) },
    'wait(JI)V': (v: VM, s: any, [t]: any[]) => { throw waitOn(s, vm.current, Math.max(1, ms(t))) },
    'notify()V': (v: VM, s: any) => notify(s, false),
    'notifyAll()V': (v: VM, s: any) => notify(s, true),
  } })

  // ---------- Thread ----------
  const javaThreadOf = (t: JThread): JObject => {
    if (!t.obj) { t.obj = new JObject(vm.cls('Ljava/lang/Thread;')); t.obj.f.name = t.name; t.obj.f.jt = t; t.obj.f.id = t.id }
    return t.obj
  }
  const jt = (s: JObject): JThread | undefined => s.f.jt
  def('Ljava/lang/Runnable;', OBJ, {})
  def('Ljava/lang/Thread$UncaughtExceptionHandler;', OBJ, {})
  def('Ljava/lang/Thread;', OBJ, {
    '<init>()V': (v, s) => { s.f.name ??= 'Thread-' + (++threads) },
    '<init>(Ljava/lang/Runnable;)V': (v, s, [r]) => { s.f.target = r; s.f.name ??= 'Thread-' + (++threads) },
    '<init>(Ljava/lang/Runnable;Ljava/lang/String;)V': (v, s, [r, n]) => { s.f.target = r; s.f.name = n },
    '<init>(Ljava/lang/String;)V': (v, s, [n]) => { s.f.name = n },
    '<init>(Ljava/lang/ThreadGroup;Ljava/lang/Runnable;)V': (v, s, [, r]) => { s.f.target = r; s.f.name ??= 'Thread-' + (++threads) },
    '<init>(Ljava/lang/ThreadGroup;Ljava/lang/Runnable;Ljava/lang/String;)V': (v, s, [, r, n]) => { s.f.target = r; s.f.name = n },
    '<init>(Ljava/lang/ThreadGroup;Ljava/lang/Runnable;Ljava/lang/String;J)V': (v, s, [, r, n]) => { s.f.target = r; s.f.name = n },
    '<init>(Ljava/lang/ThreadGroup;Ljava/lang/String;)V': (v, s, [, n]) => { s.f.name = n },
    'start()V': (v, s) => {
      if (s.f.jt) throw vm.error('Ljava/lang/IllegalThreadStateException;', 'already started')
      // a subclass overriding run() runs that; a plain Thread runs its Runnable's run() directly
      let run = vm.findMethod(vm.classOf(s), 'run()V')!, self: any = s
      if (!run.code && s.f.target) { self = s.f.target; run = vm.findMethod(vm.classOf(self), 'run()V')! }
      if (!run?.code) return // nothing to run (a js runnable): treat as done
      const t = vm.startThread(s.f.name ?? 'Thread', run, self, [], s)
      s.f.jt = t
      s.f.id = t.id
      t.onDone = (err) => {
        if (!err) return
        const h = s.f.handler ?? defaultHandler
        if (h && err instanceof JavaThrow) { try { vm.callVirtual(h, 'uncaughtException(Ljava/lang/Thread;Ljava/lang/Throwable;)V', [s, err.obj]) } catch (e) { console.warn('uncaught handler', e) } }
        else console.warn(`java thread "${t.name}" died:`, err instanceof JavaThrow ? (err.obj.cls.name + ': ' + (err.obj.f.message ?? '')) : err)
      }
    },
    'run()V': (v, s) => { if (s.f.target) vm.callVirtual(s.f.target, 'run()V') },
    'sleep(J)V': (v, s, [t]) => { const me = vm.current, until = now() + ms(t); throw interruptible(me, () => now() >= until, until, 'sleep') },
    'sleep(JI)V': (v, s, [t]) => { const me = vm.current, until = now() + ms(t); throw interruptible(me, () => now() >= until, until, 'sleep') },
    'yield()V': () => { throw new Block(() => true, 0, 'yield') },
    'currentThread()Ljava/lang/Thread;': () => javaThreadOf(vm.current),
    'getName()Ljava/lang/String;': (v, s) => s.f.name ?? 'main',
    'setName(Ljava/lang/String;)V': (v, s, [n]) => { s.f.name = n; if (jt(s)) jt(s)!.name = n },
    'getId()J': (v, s) => BigInt(s.f.id ?? 1),
    'isAlive()Z': (v, s) => (jt(s) && jt(s)!.state !== 'done' ? 1 : 0),
    'isDaemon()Z': (v, s) => (s.f.daemon ? 1 : 0),
    'setDaemon(Z)V': (v, s, [d]) => { s.f.daemon = d },
    'getPriority()I': (v, s) => s.f.priority ?? 5,
    'setPriority(I)V': (v, s, [p]) => { s.f.priority = p },
    'interrupt()V': (v, s) => { const t = jt(s); if (t) { t.interrupted = true; scheduler.wake() } },
    'isInterrupted()Z': (v, s) => (jt(s)?.interrupted ? 1 : 0),
    'interrupted()Z': () => { const t = vm.current, was = t.interrupted; t.interrupted = false; return was ? 1 : 0 },
    'join()V': (v, s) => { const t = jt(s); if (!t || t.state === 'done') return; const me = vm.current; throw interruptible(me, () => t.state === 'done', Infinity, 'join') },
    'join(J)V': (v, s, [m]) => { const t = jt(s); if (!t || t.state === 'done') return; const me = vm.current, until = ms(m) > 0 ? now() + ms(m) : Infinity; throw interruptible(me, () => t.state === 'done' || now() >= until, until, 'join') },
    'setUncaughtExceptionHandler(Ljava/lang/Thread$UncaughtExceptionHandler;)V': (v, s, [h]) => { s.f.handler = h },
    'getUncaughtExceptionHandler()Ljava/lang/Thread$UncaughtExceptionHandler;': (v, s) => s.f.handler ?? defaultHandler,
    'setDefaultUncaughtExceptionHandler(Ljava/lang/Thread$UncaughtExceptionHandler;)V': (v, s, [h]) => { defaultHandler = h },
    'getDefaultUncaughtExceptionHandler()Ljava/lang/Thread$UncaughtExceptionHandler;': () => defaultHandler,
    'getThreadGroup()Ljava/lang/ThreadGroup;': () => null,
    'getContextClassLoader()Ljava/lang/ClassLoader;': () => vm.callStatic('Ljava/lang/ClassLoader;', 'getSystemClassLoader()Ljava/lang/ClassLoader;'),
    'setContextClassLoader(Ljava/lang/ClassLoader;)V': () => {},
    'getStackTrace()[Ljava/lang/StackTraceElement;': () => vm.newArray('[Ljava/lang/StackTraceElement;', 0),
    'holdsLock(Ljava/lang/Object;)Z': (v, s, [o]) => (holds(o, vm.current) ? 1 : 0),
    'toString()Ljava/lang/String;': (v, s) => `Thread[${s.f.name ?? 'main'},${s.f.priority ?? 5},main]`,
  }, { interfaces: ['Ljava/lang/Runnable;'], statics: { MIN_PRIORITY: 1, NORM_PRIORITY: 5, MAX_PRIORITY: 10 } })
  let threads = 0
  let defaultHandler: JObject | null = null
  vm.shim('Ljava/lang/IllegalThreadStateException;', { super: 'Ljava/lang/IllegalArgumentException;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m } } })
  vm.shim('Ljava/lang/IllegalMonitorStateException;', { super: 'Ljava/lang/RuntimeException;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m } } })
  def('Ljava/lang/ThreadLocal;', OBJ, {
    '<init>()V': (v, s) => { s.f.values = new Map() },
    'get()Ljava/lang/Object;': (v, s) => { const m: Map<JThread, any> = s.f.values ??= new Map(); if (!m.has(vm.current)) m.set(vm.current, vm.callVirtual(s, 'initialValue()Ljava/lang/Object;') ?? null); return m.get(vm.current) },
    'set(Ljava/lang/Object;)V': (v, s, [x]) => { (s.f.values ??= new Map()).set(vm.current, x) },
    'remove()V': (v, s) => { s.f.values?.delete(vm.current) },
    'initialValue()Ljava/lang/Object;': () => null,
  })

  // ---------- atomics ----------
  const atomic = (name: string, d: string, zero: any) => def(`Ljava/util/concurrent/atomic/${name};`, 'Ljava/lang/Number;', {
    '<init>()V': (v, s) => { s.f.value = zero },
    [`<init>(${d})V`]: (v, s, [x]) => { s.f.value = x },
    [`get()${d}`]: (v, s) => s.f.value,
    [`set(${d})V`]: (v, s, [x]) => { s.f.value = x },
    [`lazySet(${d})V`]: (v, s, [x]) => { s.f.value = x },
    [`getAndSet(${d})${d}`]: (v, s, [x]) => { const o = s.f.value; s.f.value = x; return o },
    [`compareAndSet(${d}${d})Z`]: (v, s, [e, x]) => { if (s.f.value === e) { s.f.value = x; return 1 } return 0 },
    [`weakCompareAndSet(${d}${d})Z`]: (v, s, [e, x]) => { if (s.f.value === e) { s.f.value = x; return 1 } return 0 },
    ...(d === 'Z' ? {} : {
      [`incrementAndGet()${d}`]: (v, s) => (s.f.value = add(s.f.value, 1)),
      [`decrementAndGet()${d}`]: (v, s) => (s.f.value = add(s.f.value, -1)),
      [`getAndIncrement()${d}`]: (v, s) => { const o = s.f.value; s.f.value = add(o, 1); return o },
      [`getAndDecrement()${d}`]: (v, s) => { const o = s.f.value; s.f.value = add(o, -1); return o },
      [`addAndGet(${d})${d}`]: (v, s, [x]) => (s.f.value = add(s.f.value, x)),
      [`getAndAdd(${d})${d}`]: (v, s, [x]) => { const o = s.f.value; s.f.value = add(o, x); return o },
      [`intValue()I`]: (v, s) => Number(s.f.value) | 0,
      [`longValue()J`]: (v, s) => BigInt(s.f.value),
    }),
    'toString()Ljava/lang/String;': (v, s) => (d === 'Z' ? (s.f.value ? 'true' : 'false') : String(s.f.value)),
  })
  const add = (a: any, b: any) => (typeof a === 'bigint' ? BigInt.asIntN(64, a + BigInt(b)) : (a + b) | 0)
  atomic('AtomicInteger', 'I', 0)
  atomic('AtomicLong', 'J', 0n)
  atomic('AtomicBoolean', 'Z', 0)
  def('Ljava/util/concurrent/atomic/AtomicReference;', OBJ, {
    '<init>()V': (v, s) => { s.f.value = null },
    '<init>(Ljava/lang/Object;)V': (v, s, [x]) => { s.f.value = x },
    'get()Ljava/lang/Object;': (v, s) => s.f.value,
    'set(Ljava/lang/Object;)V': (v, s, [x]) => { s.f.value = x },
    'getAndSet(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [x]) => { const o = s.f.value; s.f.value = x; return o },
    'compareAndSet(Ljava/lang/Object;Ljava/lang/Object;)Z': (v, s, [e, x]) => { if (s.f.value === e) { s.f.value = x; return 1 } return 0 },
  })

  // ---------- TimeUnit ----------
  const UNITS: [string, number][] = [['NANOSECONDS', 1e-6], ['MICROSECONDS', 1e-3], ['MILLISECONDS', 1], ['SECONDS', 1e3], ['MINUTES', 6e4], ['HOURS', 3.6e6], ['DAYS', 8.64e7]]
  def('Ljava/util/concurrent/TimeUnit;', OBJ, {
    'toMillis(J)J': (v, s, [x]) => BigInt(Math.floor(Number(x) * s.f.ms)),
    'toSeconds(J)J': (v, s, [x]) => BigInt(Math.floor((Number(x) * s.f.ms) / 1e3)),
    'toNanos(J)J': (v, s, [x]) => BigInt(Math.floor(Number(x) * s.f.ms * 1e6)),
    'toMicros(J)J': (v, s, [x]) => BigInt(Math.floor(Number(x) * s.f.ms * 1e3)),
    'sleep(J)V': (v, s, [x]) => { const me = vm.current, until = now() + Number(x) * s.f.ms; throw interruptible(me, () => now() >= until, until, 'sleep') },
    'name()Ljava/lang/String;': (v, s) => s.f.name,
    'toString()Ljava/lang/String;': (v, s) => s.f.name,
  })
  const tu = vm.shims.get('Ljava/util/concurrent/TimeUnit;')!
  const units: Record<string, JObject> = {}
  for (const [n, f] of UNITS) { const o = new JObject(vm.cls('Ljava/util/concurrent/TimeUnit;')); o.f.name = n; o.f.ms = f; units[n] = o }
  vm.shim('Ljava/util/concurrent/TimeUnit;', { ...tu, statics: units })
  const toMs = (t: any, unit: JObject | null) => Number(t) * (unit?.f.ms ?? 1)

  // ---------- locks ----------
  // a ReentrantLock is a monitor on a hidden object; Condition is wait / notify on another one
  def('Ljava/util/concurrent/locks/Lock;', OBJ, {})
  def('Ljava/util/concurrent/locks/ReentrantLock;', OBJ, {
    '<init>()V': () => {}, '<init>(Z)V': () => {},
    'lock()V': (v, s) => { if (!tryEnter(s, vm.current)) throw enterBlock(s, vm.current) },
    'lockInterruptibly()V': (v, s) => { if (!tryEnter(s, vm.current)) throw enterBlock(s, vm.current) },
    'tryLock()Z': (v, s) => (tryEnter(s, vm.current) ? 1 : 0),
    'tryLock(JLjava/util/concurrent/TimeUnit;)Z': (v, s, [t, u]) => {
      const me = vm.current
      if (tryEnter(s, me)) return 1
      const until = now() + toMs(t, u)
      const b = enterBlock(s, me)
      throw new Block(() => b.ready() || now() >= until, until, 'lock').then(() => (b.ready() ? (b.finish(), 1) : 0))
    },
    'unlock()V': (v, s) => { if (!exit(s, vm.current)) throw vm.error('Ljava/lang/IllegalMonitorStateException;', 'not the owner') },
    'isLocked()Z': (v, s) => (monitorOf(s).owner ? 1 : 0),
    'isHeldByCurrentThread()Z': (v, s) => (holds(s, vm.current) ? 1 : 0),
    'newCondition()Ljava/util/concurrent/locks/Condition;': (v, s) => { const c = new JObject(vm.cls('Ljava/util/concurrent/locks/Condition;')); c.f.lock = s; return c },
  }, { interfaces: ['Ljava/util/concurrent/locks/Lock;'] })
  // Condition.await: wait on the lock object itself (it is the monitor the lock uses)
  def('Ljava/util/concurrent/locks/Condition;', OBJ, {
    'await()V': (v, s) => { throw waitOn(s.f.lock, vm.current) },
    'awaitNanos(J)J': (v, s, [n]) => { throw waitOn(s.f.lock, vm.current, Math.max(1, Number(n) / 1e6)) },
    'signal()V': (v, s) => notify(s.f.lock, false),
    'signalAll()V': (v, s) => notify(s.f.lock, true),
  })
  vm.shims.get('Ljava/util/concurrent/locks/Condition;')!.methods!['await(JLjava/util/concurrent/TimeUnit;)Z'] = (v, s, [t, u]) => {
    const until = now() + toMs(t, u)
    const b = waitOn(s.f.lock, vm.current, Math.max(1, toMs(t, u)))
    const fin = b.finish
    throw b.then(() => { fin(); return now() < until ? 1 : 0 })
  }
  def('Ljava/util/concurrent/locks/ReadWriteLock;', OBJ, {})
  def('Ljava/util/concurrent/locks/ReentrantReadWriteLock;', OBJ, {
    '<init>()V': (v, s) => { s.f.lock = vm.newObject('Ljava/util/concurrent/locks/ReentrantLock;') },
    'readLock()Ljava/util/concurrent/locks/ReentrantReadWriteLock$ReadLock;': (v, s) => s.f.lock,
    'writeLock()Ljava/util/concurrent/locks/ReentrantReadWriteLock$WriteLock;': (v, s) => s.f.lock,
  }, { interfaces: ['Ljava/util/concurrent/locks/ReadWriteLock;'] })

  // ---------- Semaphore, CountDownLatch ----------
  def('Ljava/util/concurrent/Semaphore;', OBJ, {
    '<init>(I)V': (v, s, [n]) => { s.f.n = n },
    '<init>(IZ)V': (v, s, [n]) => { s.f.n = n },
    'acquire()V': (v, s) => take(s, 1),
    'acquire(I)V': (v, s, [k]) => take(s, k),
    'acquireUninterruptibly()V': (v, s) => take(s, 1),
    'tryAcquire()Z': (v, s) => { if (s.f.n > 0) { s.f.n--; return 1 } return 0 },
    'tryAcquire(I)Z': (v, s, [k]) => { if (s.f.n >= k) { s.f.n -= k; return 1 } return 0 },
    'tryAcquire(JLjava/util/concurrent/TimeUnit;)Z': (v, s, [t, u]) => {
      if (s.f.n > 0) { s.f.n--; return 1 }
      const until = now() + toMs(t, u)
      throw new Block(() => s.f.n > 0 || now() >= until, until, 'semaphore').then(() => { if (s.f.n > 0) { s.f.n--; return 1 } return 0 })
    },
    'release()V': (v, s) => { s.f.n++; scheduler.wake() },
    'release(I)V': (v, s, [k]) => { s.f.n += k; scheduler.wake() },
    'availablePermits()I': (v, s) => s.f.n,
    'drainPermits()I': (v, s) => { const k = Math.max(0, s.f.n); s.f.n = 0; return k },
  })
  const take = (s: JObject, k: number) => {
    if (s.f.n >= k) { s.f.n -= k; return }
    const me = vm.current
    throw interruptible(me, () => s.f.n >= k, Infinity, 'semaphore', () => { s.f.n -= k })
  }
  def('Ljava/util/concurrent/CountDownLatch;', OBJ, {
    '<init>(I)V': (v, s, [n]) => { s.f.n = n },
    'countDown()V': (v, s) => { if (s.f.n > 0 && --s.f.n === 0) scheduler.wake() },
    'getCount()J': (v, s) => BigInt(s.f.n),
    'await()V': (v, s) => { if (s.f.n > 0) throw interruptible(vm.current, () => s.f.n <= 0, Infinity, 'latch') },
    'await(JLjava/util/concurrent/TimeUnit;)Z': (v, s, [t, u]) => {
      if (s.f.n <= 0) return 1
      const until = now() + toMs(t, u)
      throw interruptible(vm.current, () => s.f.n <= 0 || now() >= until, until, 'latch', () => (s.f.n <= 0 ? 1 : 0))
    },
  })

  // ---------- blocking queues ----------
  const queue: Record<string, NativeFn> = {
    '<init>()V': (v, s) => { s.f.items = []; s.f.cap = Infinity },
    '<init>(I)V': (v, s, [n]) => { s.f.items = []; s.f.cap = n },
    '<init>(IZ)V': (v, s, [n]) => { s.f.items = []; s.f.cap = n },
    'put(Ljava/lang/Object;)V': (v, s, [x]) => {
      const q = s.f.items
      if (q.length < s.f.cap) { q.push(x); scheduler.wake(); return }
      throw new Block(() => q.length < s.f.cap, Infinity, 'queue put').then(() => { q.push(x); scheduler.wake() })
    },
    'offer(Ljava/lang/Object;)Z': (v, s, [x]) => { if (s.f.items.length >= s.f.cap) return 0; s.f.items.push(x); scheduler.wake(); return 1 },
    'add(Ljava/lang/Object;)Z': (v, s, [x]) => { if (s.f.items.length >= s.f.cap) throw vm.error('Ljava/lang/IllegalStateException;', 'Queue full'); s.f.items.push(x); scheduler.wake(); return 1 },
    'offer(Ljava/lang/Object;JLjava/util/concurrent/TimeUnit;)Z': (v, s, [x]) => { if (s.f.items.length >= s.f.cap) return 0; s.f.items.push(x); scheduler.wake(); return 1 },
    'take()Ljava/lang/Object;': (v, s) => {
      const q = s.f.items
      if (q.length) { scheduler.wake(); return q.shift() }
      throw interruptible(vm.current, () => q.length > 0, Infinity, 'queue take', () => { scheduler.wake(); return q.shift() })
    },
    'poll()Ljava/lang/Object;': (v, s) => (s.f.items.length ? s.f.items.shift() : null),
    'poll(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;': (v, s, [t, u]) => {
      const q = s.f.items
      if (q.length) return q.shift()
      const until = now() + toMs(t, u)
      throw interruptible(vm.current, () => q.length > 0 || now() >= until, until, 'queue poll', () => (q.length ? q.shift() : null))
    },
    'peek()Ljava/lang/Object;': (v, s) => s.f.items[0] ?? null,
    'element()Ljava/lang/Object;': (v, s) => { if (!s.f.items.length) throw vm.error('Ljava/util/NoSuchElementException;', ''); return s.f.items[0] },
    'remove()Ljava/lang/Object;': (v, s) => { if (!s.f.items.length) throw vm.error('Ljava/util/NoSuchElementException;', ''); return s.f.items.shift() },
    'remove(Ljava/lang/Object;)Z': (v, s, [x]) => { const i = s.f.items.indexOf(x); if (i < 0) return 0; s.f.items.splice(i, 1); return 1 },
    'size()I': (v, s) => s.f.items.length,
    'isEmpty()Z': (v, s) => (s.f.items.length ? 0 : 1),
    'clear()V': (v, s) => { s.f.items.length = 0 },
    'contains(Ljava/lang/Object;)Z': (v, s, [x]) => (s.f.items.includes(x) ? 1 : 0),
    'remainingCapacity()I': (v, s) => (isFinite(s.f.cap) ? s.f.cap - s.f.items.length : 2147483647),
    'drainTo(Ljava/util/Collection;)I': (v, s, [c]) => { const n = s.f.items.length; for (const x of s.f.items.splice(0)) vm.callVirtual(c, 'add(Ljava/lang/Object;)Z', [x]); return n },
  }
  def('Ljava/util/Queue;', OBJ, {}, { interfaces: ['Ljava/util/Collection;'] })
  def('Ljava/util/concurrent/BlockingQueue;', OBJ, {}, { interfaces: ['Ljava/util/Queue;'] })
  for (const n of ['LinkedBlockingQueue', 'ArrayBlockingQueue', 'LinkedBlockingDeque', 'PriorityBlockingQueue', 'ConcurrentLinkedQueue', 'SynchronousQueue'])
    def(`Ljava/util/concurrent/${n};`, OBJ, queue, { interfaces: ['Ljava/util/concurrent/BlockingQueue;'] })

  // ---------- executors and futures ----------
  // a pool is one worker thread per pool that takes tasks off a queue (enough for apps' background work)
  const future = (task: any, callable: boolean) => { const f = new JObject(vm.cls('Ljava/util/concurrent/FutureTask;')); f.f.task = task; f.f.callable = callable; f.f.done = false; return f }
  const runFuture = (f: JObject) => {
    if (f.f.cancelled) return
    try { f.f.value = f.f.callable ? vm.callVirtual(f.f.task, 'call()Ljava/lang/Object;') : (vm.callVirtual(f.f.task, 'run()V'), f.f.result ?? null) }
    catch (e) { if (e instanceof JavaThrow) f.f.error = e.obj; else throw e }
    f.f.done = true
    f.f.onDone?.(f)
    scheduler.wake()
  }
  def('Ljava/util/concurrent/Future;', OBJ, {})
  def('Ljava/util/concurrent/FutureTask;', OBJ, {
    '<init>(Ljava/util/concurrent/Callable;)V': (v, s, [c]) => { s.f.task = c; s.f.callable = true },
    '<init>(Ljava/lang/Runnable;Ljava/lang/Object;)V': (v, s, [r, x]) => { s.f.task = r; s.f.callable = false; s.f.result = x },
    'run()V': (v, s) => {
      // a java task runs as a frame of this thread, so it can wait (network, locks) like any java code
      if (s.f.cancelled || s.f.done) return
      const key = s.f.callable ? 'call()Ljava/lang/Object;' : 'run()V'
      const target = s.f.task ? vm.findMethod(vm.classOf(s.f.task), key) : null
      if (!target?.code || target.native) return runFuture(s)
      const finish = () => { s.f.done = true; s.f.onDone?.(s); scheduler.wake() }
      throw new JavaCall(target, s.f.task, [], (r) => { s.f.value = s.f.callable ? r : (s.f.result ?? null); finish(); return undefined },
        (e) => { s.f.error = e.obj; finish(); return new Handled(undefined) })
    },
    'get()Ljava/lang/Object;': (v, s) => { if (s.f.done) return result(s); throw interruptible(vm.current, () => s.f.done || s.f.cancelled, Infinity, 'future', () => result(s)) },
    'get(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;': (v, s, [t, u]) => {
      if (s.f.done) return result(s)
      const until = now() + toMs(t, u)
      throw interruptible(vm.current, () => s.f.done || s.f.cancelled || now() >= until, until, 'future', () => { if (!s.f.done) throw vm.error('Ljava/util/concurrent/TimeoutException;', 'timeout'); return result(s) })
    },
    'isDone()Z': (v, s) => (s.f.done || s.f.cancelled ? 1 : 0),
    'cancel(Z)Z': (v, s) => { if (s.f.done) return 0; s.f.cancelled = true; scheduler.wake(); return 1 },
    'isCancelled()Z': (v, s) => (s.f.cancelled ? 1 : 0),
  }, { interfaces: ['Ljava/util/concurrent/Future;', 'Ljava/lang/Runnable;'] })
  const result = (f: JObject) => {
    if (f.f.cancelled) throw vm.error('Ljava/util/concurrent/CancellationException;', 'cancelled')
    if (f.f.error) { const e = new JObject(vm.cls('Ljava/util/concurrent/ExecutionException;')); e.f.cause = f.f.error; e.f.message = String(f.f.error.f.message ?? ''); throw new JavaThrow(e) }
    return f.f.value ?? null
  }
  for (const n of ['ExecutionException', 'TimeoutException']) vm.shim(`Ljava/util/concurrent/${n};`, { super: 'Ljava/lang/Exception;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m } } })
  vm.shim('Ljava/util/concurrent/CancellationException;', { super: 'Ljava/lang/IllegalStateException;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m } } })
  vm.shim('Ljava/util/concurrent/RejectedExecutionException;', { super: 'Ljava/lang/RuntimeException;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m } } })

  // the worker: a java-visible Runnable implemented in js, run as a green thread
  const workerRun = (pool: JObject) => {
    const q: JObject[] = pool.f.queue
    if (pool.f.shutdown && !q.length) return
    if (!q.length) throw new Block(() => q.length > 0 || pool.f.shutdown, Infinity, 'executor idle').then(() => { throw again })
    const f = q.shift()!
    pool.f.active++
    try { runFuture(f) } finally { pool.f.active-- }
    throw again
  }
  // "again": the worker method runs once per task; rethrowing a marker re-enters it (see below)
  const again = Symbol('again')
  def('Ljava/util/concurrent/Executor;', OBJ, {})
  def('Ljava/util/concurrent/ExecutorService;', OBJ, {}, { interfaces: ['Ljava/util/concurrent/Executor;'] })
  def('Ljava/util/concurrent/ScheduledExecutorService;', OBJ, {}, { interfaces: ['Ljava/util/concurrent/ExecutorService;'] })
  // each task runs on its own green java thread (at most pool.f.max at once, in order), so a task
  // can block on anything (locks, futures, network) like on a real worker thread
  const submit = (pool: JObject, f: JObject, delay = 0) => {
    if (pool.f.shutdown) throw vm.error('Ljava/util/concurrent/RejectedExecutionException;', 'shut down')
    if (delay > 0) setTimeout(() => { pool.f.queue.push(f); drain(pool) }, delay)
    else { pool.f.queue.push(f); drain(pool) }
    return f
  }
  const drain = (pool: JObject) => {
    while (pool.f.active < pool.f.max && pool.f.queue.length) {
      const f = pool.f.queue.shift() as JObject
      if (f.f.cancelled) continue
      launch(pool, f)
    }
    scheduler.wake()
  }
  const launch = (pool: JObject, f: JObject) => {
    // a FutureTask the app made itself: run what it wraps, and finish that future
    let target = f, task = f.f.task
    if (task instanceof JObject && task.cls.name === 'Ljava/util/concurrent/FutureTask;' && !vm.findDexClass(task.cls.name)) { target = task; task = task.f.task }
    const callable = target.f.callable
    const m = vm.findMethod(vm.classOf(task), callable ? 'call()Ljava/lang/Object;' : 'run()V')
    if (!m) { target.f.done = true; f.f.done = true; return }
    pool.f.active++
    const t = vm.startThread(`pool-${pool.f.n}-thread-${++pool.f.tn}`, m, task, [])
    t.onDone = (err) => {
      if (err) { if (err instanceof JavaThrow) target.f.error = err.obj; else console.warn('pool task', err) }
      else target.f.value = callable ? t.lastValue ?? null : target.f.result ?? null
      for (const x of new Set([target, f])) { if (x !== target) { x.f.value = target.f.value; x.f.error = target.f.error } x.f.done = true; x.f.onDone?.(x) }
      pool.f.active--
      drain(pool)
    }
  }
  let pools = 0
  const pool: Record<string, NativeFn> = {
    '<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;)V': (v, s, [core, max]) => initPool(s, Math.max(core, Math.min(max, 64))),
    '<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/ThreadFactory;)V': (v, s, [core, max]) => initPool(s, Math.max(core, Math.min(max, 64))),
    'getActiveCount()I': (v, s) => s.f.active, 'getQueue()Ljava/util/concurrent/BlockingQueue;': () => null, 'setCorePoolSize(I)V': (v, s, [n]) => { s.f.max = Math.max(1, n); drain(s) }, 'allowCoreThreadTimeOut(Z)V': () => {},
    'invokeAll(Ljava/util/Collection;)Ljava/util/List;': (v, s, [c]) => { const l = vm.newObject('Ljava/util/ArrayList;'); const fs = [...(vm.callVirtual(c, 'toArray()[Ljava/lang/Object;') as any).data].map((x: any) => submit(s, future(x, true))); for (const f of fs) vm.callVirtual(l, 'add(Ljava/lang/Object;)Z', [f]); const done = () => fs.every((f) => f.f.done); if (done()) return l; throw new Block(done, Infinity, 'invokeAll').then(() => l) },
    'execute(Ljava/lang/Runnable;)V': (v, s, [r]) => { submit(s, future(r, false)) },
    'submit(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;': (v, s, [r]) => submit(s, future(r, false)),
    'submit(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;': (v, s, [c]) => submit(s, future(c, true)),
    'submit(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Future;': (v, s, [r, x]) => { const f = future(r, false); f.f.result = x; return submit(s, f) },
    'schedule(Ljava/lang/Runnable;JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;': (v, s, [r, t, u]) => submit(s, future(r, false), toMs(t, u)),
    'schedule(Ljava/util/concurrent/Callable;JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;': (v, s, [c, t, u]) => submit(s, future(c, true), toMs(t, u)),
    'scheduleAtFixedRate(Ljava/lang/Runnable;JJLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;': (v, s, [r, d, p, u]) => repeat(s, r, toMs(d, u), toMs(p, u)),
    'scheduleWithFixedDelay(Ljava/lang/Runnable;JJLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;': (v, s, [r, d, p, u]) => repeat(s, r, toMs(d, u), toMs(p, u)),
    'shutdown()V': (v, s) => { s.f.shutdown = true; scheduler.wake() },
    'shutdownNow()Ljava/util/List;': (v, s) => { s.f.shutdown = true; s.f.queue.length = 0; scheduler.wake(); return vm.newObject('Ljava/util/ArrayList;') },
    'isShutdown()Z': (v, s) => (s.f.shutdown ? 1 : 0),
    'isTerminated()Z': (v, s) => (s.f.shutdown && !s.f.queue.length && !s.f.active ? 1 : 0),
    'awaitTermination(JLjava/util/concurrent/TimeUnit;)Z': (v, s, [t, u]) => {
      const until = now() + toMs(t, u)
      const done = () => s.f.shutdown && !s.f.queue.length && !s.f.active
      if (done()) return 1
      throw new Block(() => done() || now() >= until, until, 'await termination').then(() => (done() ? 1 : 0))
    },
  }
  const initPool = (s: JObject, max = 64) => { s.f.queue = []; s.f.active = 0; s.f.shutdown = false; s.f.max = Math.max(1, max); s.f.n = ++pools; s.f.tn = 0; return s }
  const repeat = (s: JObject, r: JObject, delay: number, period: number) => {
    const f = future(r, false)
    const tick = () => { if (s.f.shutdown || f.f.cancelled) return; s.f.queue.push(future(r, false)); drain(s); setTimeout(tick, Math.max(1, period)) }
    setTimeout(tick, Math.max(0, delay))
    return f
  }
  def('Ljava/util/concurrent/ThreadPoolExecutor;', OBJ, pool, { interfaces: ['Ljava/util/concurrent/ScheduledExecutorService;'] })
  def('Ljava/util/concurrent/ScheduledThreadPoolExecutor;', 'Ljava/util/concurrent/ThreadPoolExecutor;', { '<init>(I)V': (v, s, [n]) => initPool(s, n) })
  const newPool = (max: number) => initPool(new JObject(vm.cls('Ljava/util/concurrent/ScheduledThreadPoolExecutor;')), max)
  def('Ljava/util/concurrent/Executors;', OBJ, {
    'newSingleThreadExecutor()Ljava/util/concurrent/ExecutorService;': () => newPool(1),
    'newSingleThreadExecutor(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;': () => newPool(1),
    'newFixedThreadPool(I)Ljava/util/concurrent/ExecutorService;': (v, s, [n]) => newPool(n),
    'newFixedThreadPool(ILjava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;': (v, s, [n]) => newPool(n),
    'newCachedThreadPool()Ljava/util/concurrent/ExecutorService;': () => newPool(64),
    'newCachedThreadPool(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;': () => newPool(64),
    'newScheduledThreadPool(I)Ljava/util/concurrent/ScheduledExecutorService;': (v, s, [n]) => newPool(n),
    'newSingleThreadScheduledExecutor()Ljava/util/concurrent/ScheduledExecutorService;': () => newPool(1),
  })
  // ExecutorCompletionService: futures land in a queue as they finish
  def('Ljava/util/concurrent/ExecutorCompletionService;', OBJ, {
    '<init>(Ljava/util/concurrent/Executor;)V': (v, s, [e]) => { s.f.ex = e; s.f.done = [] },
    '<init>(Ljava/util/concurrent/Executor;Ljava/util/concurrent/BlockingQueue;)V': (v, s, [e]) => { s.f.ex = e; s.f.done = [] },
    'submit(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;': (v, s, [c]) => completing(s, future(c, true)),
    'submit(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Future;': (v, s, [r, x]) => { const f = future(r, false); f.f.result = x; return completing(s, f) },
    'take()Ljava/util/concurrent/Future;': (v, s) => { if (s.f.done.length) return s.f.done.shift(); throw interruptible(vm.current, () => s.f.done.length > 0, Infinity, 'completion', () => s.f.done.shift()) },
    'poll()Ljava/util/concurrent/Future;': (v, s) => s.f.done.shift() ?? null,
    'poll(JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/Future;': (v, s, [t, u]) => {
      if (s.f.done.length) return s.f.done.shift()
      const until = now() + toMs(t, u)
      throw interruptible(vm.current, () => s.f.done.length > 0 || now() >= until, until, 'completion', () => s.f.done.shift() ?? null)
    },
  }, { interfaces: ['Ljava/util/concurrent/CompletionService;'] })
  def('Ljava/util/concurrent/CompletionService;', OBJ, {})
  const completing = (s: JObject, f: JObject) => {
    f.f.onDone = (x: JObject) => { s.f.done.push(x); scheduler.wake() }
    if (s.f.ex?.f?.queue) return submit(s.f.ex, f)
    // somebody else's executor: hand it the future as a runnable
    vm.callVirtual(s.f.ex, 'execute(Ljava/lang/Runnable;)V', [f])
    return f
  }
  def('Ljava/util/concurrent/ScheduledFuture;', OBJ, {}, { interfaces: ['Ljava/util/concurrent/Future;'] })
  def('Ljava/util/concurrent/Callable;', OBJ, {})
  def('Ljava/util/concurrent/ThreadFactory;', OBJ, {})

  void box; void unbox
}
