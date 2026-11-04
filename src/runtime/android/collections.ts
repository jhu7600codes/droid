// framework shim, part 7: java.util collections with java semantics (equals / hashCode keys, live
// views, sorted maps and sets, abstract bases that apps subclass), plus Collections and Objects.
// lists keep their items in f.a (a js array); maps keep f.m: id -> [key, value] (insertion ordered).
import { VM, JObject, JArray, JavaThrow, type NativeFn } from './dalvik.ts'
import { jstr, box } from './java.ts'

const OBJ = 'Ljava/lang/Object;'

export function registerCollections(vm: VM) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => {
    const old = vm.shims.get(name)
    vm.shim(name, { super: sup, interfaces: extra.interfaces ?? old?.interfaces, methods: { ...(old?.methods || {}), ...methods }, statics: { ...(old?.statics || {}), ...(extra.statics || {}) } })
  }
  const err = (cls: string, msg = '') => vm.error(cls, msg)

  // ---------- equality ----------
  const objEquals = vm.findMethod(vm.cls(OBJ), 'equals(Ljava/lang/Object;)Z')
  const custom = (x: any) => { if (!(x instanceof JObject)) return false; const e = vm.findMethod(x.cls, 'equals(Ljava/lang/Object;)Z'); return !!e && e !== objEquals }
  const eq = (a: any, b: any): boolean => {
    if (a === b) return true
    if (a == null || b == null) return false
    if (typeof a !== 'object' || typeof b !== 'object') return a === b || (typeof a === 'object' ? false : typeof b === 'object' ? !!vm.callVirtual(b, 'equals(Ljava/lang/Object;)Z', [a]) : false)
    return !!vm.callVirtual(a, 'equals(Ljava/lang/Object;)Z', [b])
  }
  const hash = (x: any): number => {
    if (x == null) return 0
    if (typeof x === 'string') { let h = 0; for (let i = 0; i < x.length; i++) h = (Math.imul(31, h) + x.charCodeAt(i)) | 0; return h }
    if (typeof x === 'number') return x | 0
    if (typeof x === 'bigint') return Number(BigInt.asIntN(32, x ^ (x >> 32n)))
    return vm.callVirtual(x, 'hashCode()I') | 0
  }
  // a stable id for a key inside one map: primitives by value, boxes by value, objects with their own
  // equals by hash + equals, the rest by identity
  let ids = 0
  const ident = new WeakMap<object, string>()
  const keyId = (s: JObject, k: any, create: boolean): string | null => {
    if (k == null) return 'null'
    if (typeof k === 'string') return 's' + k
    if (typeof k === 'number') return 'n' + k
    if (typeof k === 'bigint') return 'l' + k
    if (k instanceof JObject && 'value' in k.f && /^Ljava\/lang\/(Integer|Long|Short|Byte|Character|Boolean|Float|Double);$/.test(k.cls.name)) return 'b' + k.cls.name[11] + String(k.f.value)
    if (s.f.identity || !custom(k)) { let i = ident.get(k); if (!i) { i = 'i' + ++ids; ident.set(k, i) } return i }
    const hb: Map<number, string[]> = (s.f.hb ||= new Map())
    const h = hash(k)
    const list = hb.get(h) || []
    for (const id of list) { const e = s.f.m.get(id); if (e && eq(e[0], k)) return id }
    if (!create) return null
    const id = 'o' + h + '#' + ++ids
    list.push(id)
    hb.set(h, list)
    return id
  }
  const forget = (s: JObject, id: string) => { if (id[0] !== 'o' || !s.f.hb) return; const h = +id.slice(1, id.indexOf('#')); const l = s.f.hb.get(h); if (l) { const i = l.indexOf(id); if (i >= 0) l.splice(i, 1) } }

  // ---------- iterators ----------
  // over a js array snapshot; remove() calls back so the owner can drop the item
  const iter = (items: () => any[], remove?: (x: any, i: number) => void) => {
    const it = new JObject(vm.cls('Ljava/util/Iterator;'))
    let i = 0, last = -1
    it.f.hasNext = () => i < items().length
    it.f.next = () => { last = i; return items()[i++] }
    it.f.remove = () => { if (last < 0) throw err('Ljava/lang/IllegalStateException;'); remove?.(items()[last], last); if (items().length < i) i--; else if (!remove) throw err('Ljava/lang/UnsupportedOperationException;'); i = last; last = -1 }
    return it
  }
  def('Ljava/lang/Iterable;', OBJ, {})
  def('Ljava/util/Iterator;', OBJ, {
    'hasNext()Z': (v, s) => (s.f.hasNext() ? 1 : 0),
    'next()Ljava/lang/Object;': (v, s) => { if (!s.f.hasNext()) throw err('Ljava/util/NoSuchElementException;'); return s.f.next() },
    'remove()V': (v, s) => s.f.remove(),
  })
  def('Ljava/util/ListIterator;', 'Ljava/util/Iterator;', {})
  def('Ljava/util/Enumeration;', OBJ, { 'hasMoreElements()Z': (v, s) => (s.f.hasNext() ? 1 : 0), 'nextElement()Ljava/lang/Object;': (v, s) => { if (!s.f.hasNext()) throw err('Ljava/util/NoSuchElementException;'); return s.f.next() } })
  const enumeration = (items: any[]) => { const e = new JObject(vm.cls('Ljava/util/Enumeration;')); let i = 0; e.f.hasNext = () => i < items.length; e.f.next = () => items[i++]; return e }

  // any collection's items as a js array (ours directly, others through iterator())
  const itemsOf = (c: any): any[] => {
    if (c == null) throw err('Ljava/lang/NullPointerException;', 'collection')
    if (Array.isArray(c.f?.a)) return c.f.a
    if (c.f?.m instanceof Map && c.f.setOf) return [...c.f.m.values()].map((e: any) => e[0])
    if (c instanceof JArray) return [...c.data]
    const out: any[] = []
    const it = vm.callVirtual(c, 'iterator()Ljava/util/Iterator;')
    while (vm.callVirtual(it, 'hasNext()Z')) out.push(vm.callVirtual(it, 'next()Ljava/lang/Object;'))
    return out
  }
  const toArr = (xs: any[], a?: JArray | null) => {
    const t = a && a.cls.name !== '[Ljava/lang/Object;' ? a.cls.name : '[Ljava/lang/Object;'
    const r = a && a.data.length >= xs.length ? a : vm.newArray(t, xs.length)
    xs.forEach((x, i) => ((r.data as any)[i] = x))
    if (r.data.length > xs.length) (r.data as any)[xs.length] = null
    return r
  }
  const str = (xs: any[]) => '[' + xs.map((x) => (x === undefined ? 'null' : jstr(vm, x))).join(', ') + ']'
  const cmpOf = (c: JObject | null) => (a: any, b: any) => {
    if (c) return vm.callVirtual(c, 'compare(Ljava/lang/Object;Ljava/lang/Object;)I', [a, b]) | 0
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return vm.callVirtual(a, 'compareTo(Ljava/lang/Object;)I', [b]) | 0
  }

  // ---------- abstract bases (apps subclass these; defaults go through the virtual methods) ----------
  const vsize = (s: any) => vm.callVirtual(s, 'size()I') | 0
  const viter = (s: any) => itemsOf(s)
  def('Ljava/util/Collection;', OBJ, {}, { interfaces: ['Ljava/lang/Iterable;'] })
  def('Ljava/util/AbstractCollection;', OBJ, {
    '<init>()V': () => {},
    'isEmpty()Z': (v, s) => (vsize(s) ? 0 : 1),
    'contains(Ljava/lang/Object;)Z': (v, s, [x]) => (viter(s).some((y) => eq(x, y)) ? 1 : 0),
    'containsAll(Ljava/util/Collection;)Z': (v, s, [c]) => (itemsOf(c).every((x) => viter(s).some((y) => eq(x, y))) ? 1 : 0),
    'toArray()[Ljava/lang/Object;': (v, s) => toArr(viter(s)),
    'toArray([Ljava/lang/Object;)[Ljava/lang/Object;': (v, s, [a]) => toArr(viter(s), a),
    'addAll(Ljava/util/Collection;)Z': (v, s, [c]) => { let ch = 0; for (const x of itemsOf(c)) ch |= vm.callVirtual(s, 'add(Ljava/lang/Object;)Z', [x]); return ch },
    'add(Ljava/lang/Object;)Z': () => { throw err('Ljava/lang/UnsupportedOperationException;') },
    'toString()Ljava/lang/String;': (v, s) => str(viter(s)),
    'clear()V': (v, s) => { const it = vm.callVirtual(s, 'iterator()Ljava/util/Iterator;'); while (vm.callVirtual(it, 'hasNext()Z')) { vm.callVirtual(it, 'next()Ljava/lang/Object;'); vm.callVirtual(it, 'remove()V') } },
  }, { interfaces: ['Ljava/util/Collection;'] })
  def('Ljava/util/List;', OBJ, {}, { interfaces: ['Ljava/util/Collection;'] })
  def('Ljava/util/AbstractList;', 'Ljava/util/AbstractCollection;', {
    'iterator()Ljava/util/Iterator;': (v, s) => { const n = vsize(s); const xs = Array.from({ length: n }, (_, i) => vm.callVirtual(s, 'get(I)Ljava/lang/Object;', [i])); return iter(() => xs) },
    'listIterator()Ljava/util/ListIterator;': (v, s) => vm.callVirtual(s, 'iterator()Ljava/util/Iterator;'),
    'indexOf(Ljava/lang/Object;)I': (v, s, [x]) => viter(s).findIndex((y) => eq(x, y)),
    'add(Ljava/lang/Object;)Z': (v, s, [x]) => { vm.callVirtual(s, 'add(ILjava/lang/Object;)V', [vsize(s), x]); return 1 },
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => { if (o === s) return 1; if (!o || !vm.instanceOf(o, vm.cls('Ljava/util/List;'))) return 0; const a = viter(s), b = itemsOf(o); return a.length === b.length && a.every((x, i) => eq(x, b[i])) ? 1 : 0 },
    'hashCode()I': (v, s) => viter(s).reduce((h, x) => (Math.imul(31, h) + hash(x)) | 0, 1),
  }, { interfaces: ['Ljava/util/List;'] })
  def('Ljava/util/Set;', OBJ, {}, { interfaces: ['Ljava/util/Collection;'] })
  def('Ljava/util/AbstractSet;', 'Ljava/util/AbstractCollection;', {
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => { if (o === s) return 1; if (!o) return 0; const a = viter(s), b = itemsOf(o); return a.length === b.length && b.every((x) => a.some((y) => eq(x, y))) ? 1 : 0 },
    'hashCode()I': (v, s) => viter(s).reduce((h, x) => (h + hash(x)) | 0, 0),
  }, { interfaces: ['Ljava/util/Set;'] })
  def('Ljava/util/Queue;', OBJ, {}, { interfaces: ['Ljava/util/Collection;'] })
  def('Ljava/util/Deque;', OBJ, {}, { interfaces: ['Ljava/util/Queue;'] })
  def('Ljava/util/AbstractQueue;', 'Ljava/util/AbstractCollection;', {}, { interfaces: ['Ljava/util/Queue;'] })
  def('Ljava/util/SortedSet;', OBJ, {}, { interfaces: ['Ljava/util/Set;'] })
  def('Ljava/util/NavigableSet;', OBJ, {}, { interfaces: ['Ljava/util/SortedSet;'] })
  def('Ljava/util/RandomAccess;', OBJ, {})

  // ---------- array lists, linked lists, deques ----------
  const at = (s: JObject, i: number) => { if (i < 0 || i >= s.f.a.length) throw err('Ljava/lang/IndexOutOfBoundsException;', `Invalid index ${i}, size is ${s.f.a.length}`); return i }
  const list: Record<string, NativeFn> = {
    '<init>()V': (v, s) => { s.f.a = [] },
    '<init>(I)V': (v, s, [n]) => { if (n < 0) throw err('Ljava/lang/IllegalArgumentException;', 'Illegal Capacity: ' + n); s.f.a = [] },
    '<init>(Ljava/util/Collection;)V': (v, s, [c]) => { s.f.a = [...itemsOf(c)] },
    'add(Ljava/lang/Object;)Z': (v, s, [x]) => { s.f.a.push(x); return 1 },
    'add(ILjava/lang/Object;)V': (v, s, [i, x]) => { if (i < 0 || i > s.f.a.length) throw err('Ljava/lang/IndexOutOfBoundsException;', `Invalid index ${i}, size is ${s.f.a.length}`); s.f.a.splice(i, 0, x) },
    'addAll(Ljava/util/Collection;)Z': (v, s, [c]) => { const xs = itemsOf(c); s.f.a.push(...xs); return xs.length ? 1 : 0 },
    'addAll(ILjava/util/Collection;)Z': (v, s, [i, c]) => { const xs = itemsOf(c); s.f.a.splice(i, 0, ...xs); return xs.length ? 1 : 0 },
    'get(I)Ljava/lang/Object;': (v, s, [i]) => s.f.a[at(s, i)],
    'set(ILjava/lang/Object;)Ljava/lang/Object;': (v, s, [i, x]) => { const o = s.f.a[at(s, i)]; s.f.a[i] = x; return o },
    'size()I': (v, s) => s.f.a.length,
    'isEmpty()Z': (v, s) => (s.f.a.length ? 0 : 1),
    'clear()V': (v, s) => { s.f.a.length = 0 },
    'remove(I)Ljava/lang/Object;': (v, s, [i]) => s.f.a.splice(at(s, i), 1)[0],
    'remove(Ljava/lang/Object;)Z': (v, s, [x]) => { const i = s.f.a.findIndex((y: any) => eq(x, y)); if (i < 0) return 0; s.f.a.splice(i, 1); return 1 },
    'removeAll(Ljava/util/Collection;)Z': (v, s, [c]) => { const xs = itemsOf(c), n = s.f.a.length; s.f.a = s.f.a.filter((y: any) => !xs.some((x) => eq(x, y))); return n !== s.f.a.length ? 1 : 0 },
    'retainAll(Ljava/util/Collection;)Z': (v, s, [c]) => { const xs = itemsOf(c), n = s.f.a.length; s.f.a = s.f.a.filter((y: any) => xs.some((x) => eq(x, y))); return n !== s.f.a.length ? 1 : 0 },
    'contains(Ljava/lang/Object;)Z': (v, s, [x]) => (s.f.a.some((y: any) => eq(x, y)) ? 1 : 0),
    'containsAll(Ljava/util/Collection;)Z': (v, s, [c]) => (itemsOf(c).every((x) => s.f.a.some((y: any) => eq(x, y))) ? 1 : 0),
    'indexOf(Ljava/lang/Object;)I': (v, s, [x]) => s.f.a.findIndex((y: any) => eq(x, y)),
    'lastIndexOf(Ljava/lang/Object;)I': (v, s, [x]) => { for (let i = s.f.a.length - 1; i >= 0; i--) if (eq(x, s.f.a[i])) return i; return -1 },
    'iterator()Ljava/util/Iterator;': (v, s) => iter(() => s.f.a, (x, i) => s.f.a.splice(i, 1)),
    'listIterator()Ljava/util/ListIterator;': (v, s) => iter(() => s.f.a, (x, i) => s.f.a.splice(i, 1)),
    'listIterator(I)Ljava/util/ListIterator;': (v, s, [k]) => { const it = iter(() => s.f.a, (x, i) => s.f.a.splice(i, 1)); for (let i = 0; i < k; i++) it.f.next(); return it },
    'subList(II)Ljava/util/List;': (v, s, [a, b]) => { const l = new JObject(vm.cls('Ljava/util/ArrayList;')); l.f.a = s.f.a.slice(a, b); return l },
    'toArray()[Ljava/lang/Object;': (v, s) => toArr(s.f.a),
    'toArray([Ljava/lang/Object;)[Ljava/lang/Object;': (v, s, [a]) => toArr(s.f.a, a),
    'toString()Ljava/lang/String;': (v, s) => str(s.f.a),
    'ensureCapacity(I)V': () => {}, 'trimToSize()V': () => {},
    'clone()Ljava/lang/Object;': (v, s) => { const l = new JObject(s.cls); l.f.a = [...s.f.a]; return l },
    'sort(Ljava/util/Comparator;)V': (v, s, [c]) => { s.f.a.sort(cmpOf(c)) },
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => { if (o === s) return 1; if (!o || !vm.instanceOf(o, vm.cls('Ljava/util/List;'))) return 0; const b = itemsOf(o); return s.f.a.length === b.length && s.f.a.every((x: any, i: number) => eq(x, b[i])) ? 1 : 0 },
    'hashCode()I': (v, s) => s.f.a.reduce((h: number, x: any) => (Math.imul(31, h) + hash(x)) | 0, 1),
  }
  const deque: Record<string, NativeFn> = {
    'addFirst(Ljava/lang/Object;)V': (v, s, [x]) => { s.f.a.unshift(x) }, 'addLast(Ljava/lang/Object;)V': (v, s, [x]) => { s.f.a.push(x) },
    'offerFirst(Ljava/lang/Object;)Z': (v, s, [x]) => { s.f.a.unshift(x); return 1 }, 'offerLast(Ljava/lang/Object;)Z': (v, s, [x]) => { s.f.a.push(x); return 1 },
    'offer(Ljava/lang/Object;)Z': (v, s, [x]) => { s.f.a.push(x); return 1 }, 'push(Ljava/lang/Object;)V': (v, s, [x]) => { s.f.a.unshift(x) },
    'removeFirst()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/NoSuchElementException;'); return s.f.a.shift() },
    'removeLast()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/NoSuchElementException;'); return s.f.a.pop() },
    'pollFirst()Ljava/lang/Object;': (v, s) => s.f.a.shift() ?? null, 'pollLast()Ljava/lang/Object;': (v, s) => s.f.a.pop() ?? null,
    'poll()Ljava/lang/Object;': (v, s) => s.f.a.shift() ?? null, 'pop()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/NoSuchElementException;'); return s.f.a.shift() },
    'remove()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/NoSuchElementException;'); return s.f.a.shift() },
    'getFirst()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/NoSuchElementException;'); return s.f.a[0] },
    'getLast()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/NoSuchElementException;'); return s.f.a[s.f.a.length - 1] },
    'peek()Ljava/lang/Object;': (v, s) => s.f.a[0] ?? null, 'peekFirst()Ljava/lang/Object;': (v, s) => s.f.a[0] ?? null, 'peekLast()Ljava/lang/Object;': (v, s) => s.f.a[s.f.a.length - 1] ?? null,
    'element()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/NoSuchElementException;'); return s.f.a[0] },
    'descendingIterator()Ljava/util/Iterator;': (v, s) => { const r = [...s.f.a].reverse(); return iter(() => r) },
    'removeFirstOccurrence(Ljava/lang/Object;)Z': (v, s, [x]) => { const i = s.f.a.findIndex((y: any) => eq(x, y)); if (i < 0) return 0; s.f.a.splice(i, 1); return 1 },
  }
  def('Ljava/util/ArrayList;', 'Ljava/util/AbstractList;', list, { interfaces: ['Ljava/util/List;', 'Ljava/util/RandomAccess;'] })
  def('Ljava/util/LinkedList;', 'Ljava/util/AbstractList;', { ...list, ...deque }, { interfaces: ['Ljava/util/List;', 'Ljava/util/Deque;'] })
  def('Ljava/util/Vector;', 'Ljava/util/AbstractList;', { ...list, 'addElement(Ljava/lang/Object;)V': (v, s, [x]) => { s.f.a.push(x) }, 'elementAt(I)Ljava/lang/Object;': (v, s, [i]) => s.f.a[at(s, i)], 'elements()Ljava/util/Enumeration;': (v, s) => enumeration([...s.f.a]), 'firstElement()Ljava/lang/Object;': (v, s) => s.f.a[0], 'lastElement()Ljava/lang/Object;': (v, s) => s.f.a[s.f.a.length - 1], 'removeAllElements()V': (v, s) => { s.f.a.length = 0 }, 'removeElementAt(I)V': (v, s, [i]) => { s.f.a.splice(i, 1) }, 'insertElementAt(Ljava/lang/Object;I)V': (v, s, [x, i]) => { s.f.a.splice(i, 0, x) }, 'setElementAt(Ljava/lang/Object;I)V': (v, s, [x, i]) => { s.f.a[i] = x } }, { interfaces: ['Ljava/util/List;', 'Ljava/util/RandomAccess;'] })
  def('Ljava/util/Stack;', 'Ljava/util/Vector;', { '<init>()V': (v, s) => { s.f.a = [] }, 'push(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [x]) => { s.f.a.push(x); return x }, 'pop()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/EmptyStackException;'); return s.f.a.pop() }, 'peek()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/EmptyStackException;'); return s.f.a[s.f.a.length - 1] }, 'empty()Z': (v, s) => (s.f.a.length ? 0 : 1), 'search(Ljava/lang/Object;)I': (v, s, [x]) => { for (let i = s.f.a.length - 1; i >= 0; i--) if (eq(x, s.f.a[i])) return s.f.a.length - i; return -1 } })
  def('Ljava/util/ArrayDeque;', 'Ljava/util/AbstractCollection;', { ...list, ...deque }, { interfaces: ['Ljava/util/Deque;'] })
  def('Ljava/util/concurrent/CopyOnWriteArrayList;', OBJ, list, { interfaces: ['Ljava/util/List;', 'Ljava/util/RandomAccess;'] })
  def('Ljava/util/concurrent/ConcurrentLinkedDeque;', OBJ, { ...list, ...deque }, { interfaces: ['Ljava/util/Deque;'] })
  for (const n of ['EmptyStackException', 'NoSuchElementException', 'ConcurrentModificationException']) vm.shim(`Ljava/util/${n};`, { super: 'Ljava/lang/RuntimeException;', methods: { '<init>()V': () => {}, '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m } } })
  // PriorityQueue: kept sorted
  def('Ljava/util/PriorityQueue;', 'Ljava/util/AbstractQueue;', {
    ...list,
    '<init>()V': (v, s) => { s.f.a = []; s.f.cmp = null },
    '<init>(I)V': (v, s) => { s.f.a = []; s.f.cmp = null },
    '<init>(ILjava/util/Comparator;)V': (v, s, [, c]) => { s.f.a = []; s.f.cmp = c },
    '<init>(Ljava/util/Comparator;)V': (v, s, [c]) => { s.f.a = []; s.f.cmp = c },
    'add(Ljava/lang/Object;)Z': (v, s, [x]) => { pqAdd(s, x); return 1 }, 'offer(Ljava/lang/Object;)Z': (v, s, [x]) => { pqAdd(s, x); return 1 },
    'poll()Ljava/lang/Object;': (v, s) => s.f.a.shift() ?? null, 'peek()Ljava/lang/Object;': (v, s) => s.f.a[0] ?? null,
    'remove()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/NoSuchElementException;'); return s.f.a.shift() },
    'element()Ljava/lang/Object;': (v, s) => { if (!s.f.a.length) throw err('Ljava/util/NoSuchElementException;'); return s.f.a[0] },
    'comparator()Ljava/util/Comparator;': (v, s) => s.f.cmp ?? null,
  }, { interfaces: ['Ljava/util/Queue;'] })
  const pqAdd = (s: JObject, x: any) => { const c = cmpOf(s.f.cmp); let i = s.f.a.length; while (i > 0 && c(s.f.a[i - 1], x) > 0) i--; s.f.a.splice(i, 0, x) }

  // ---------- maps ----------
  const entry = (k: any, v: any, onSet?: (v: any) => void) => { const e = new JObject(vm.cls('Ljava/util/AbstractMap$SimpleEntry;')); e.f.k = k; e.f.v = v; e.f.onSet = onSet; return e }
  def('Ljava/util/Map$Entry;', OBJ, {})
  def('Ljava/util/AbstractMap$SimpleEntry;', OBJ, {
    '<init>(Ljava/lang/Object;Ljava/lang/Object;)V': (v, s, [k, x]) => { s.f.k = k; s.f.v = x },
    'getKey()Ljava/lang/Object;': (v, s) => s.f.k ?? null,
    'getValue()Ljava/lang/Object;': (v, s) => s.f.v ?? null,
    'setValue(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [x]) => { const o = s.f.v; s.f.v = x; s.f.onSet?.(x); return o ?? null },
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o && eq(s.f.k, vm.callVirtual(o, 'getKey()Ljava/lang/Object;')) && eq(s.f.v, vm.callVirtual(o, 'getValue()Ljava/lang/Object;')) ? 1 : 0),
    'hashCode()I': (v, s) => hash(s.f.k) ^ hash(s.f.v),
    'toString()Ljava/lang/String;': (v, s) => `${jstr(vm, s.f.k)}=${jstr(vm, s.f.v)}`,
  }, { interfaces: ['Ljava/util/Map$Entry;'] })
  vm.shim('Ljava/util/AbstractMap$SimpleImmutableEntry;', { super: 'Ljava/util/AbstractMap$SimpleEntry;', methods: {} })
  const entries = (s: JObject): [any, any][] => {
    const all: [any, any][] = [...s.f.m.values()]
    return s.f.sorted ? all.sort((a, b) => cmpOf(s.f.cmp)(a[0], b[0])) : all
  }
  const mput = (s: JObject, k: any, x: any) => {
    if (k == null && s.f.sorted && !s.f.cmp) throw err('Ljava/lang/NullPointerException;', 'null key')
    const id = keyId(s, k, true)!
    const o = s.f.m.get(id)
    s.f.m.set(id, [o ? o[0] : k, x])
    return o ? o[1] ?? null : null
  }
  const mget = (s: JObject, k: any) => { const id = keyId(s, k, false); return id == null ? undefined : s.f.m.get(id) }
  const mdel = (s: JObject, k: any) => { const id = keyId(s, k, false); if (id == null) return null; const o = s.f.m.get(id); if (!o) return null; s.f.m.delete(id); forget(s, id); return o[1] ?? null }
  const mapInit = (s: JObject) => { s.f.m = new Map(); s.f.hb = null }
  const view = (cls: string, items: () => any[], remove: (x: any) => void, contains: (x: any) => boolean) => {
    const o = new JObject(vm.cls(cls))
    o.f.view = { items, remove, contains }
    return o
  }
  const viewMethods: Record<string, NativeFn> = {
    'size()I': (v, s) => s.f.view.items().length,
    'isEmpty()Z': (v, s) => (s.f.view.items().length ? 0 : 1),
    'iterator()Ljava/util/Iterator;': (v, s) => { const xs = s.f.view.items(); return iter(() => xs, (x, i) => { s.f.view.remove(x); xs.splice(i, 1) }) },
    'contains(Ljava/lang/Object;)Z': (v, s, [x]) => (s.f.view.contains(x) ? 1 : 0),
    'remove(Ljava/lang/Object;)Z': (v, s, [x]) => { if (!s.f.view.contains(x)) return 0; s.f.view.remove(x); return 1 },
    'removeAll(Ljava/util/Collection;)Z': (v, s, [c]) => { let ch = 0; for (const x of itemsOf(c)) if (s.f.view.contains(x)) { s.f.view.remove(x); ch = 1 } return ch },
    'retainAll(Ljava/util/Collection;)Z': (v, s, [c]) => { const keep = itemsOf(c); let ch = 0; for (const x of s.f.view.items()) if (!keep.some((y) => eq(x, y))) { s.f.view.remove(x); ch = 1 } return ch },
    'clear()V': (v, s) => { for (const x of s.f.view.items()) s.f.view.remove(x) },
    'toArray()[Ljava/lang/Object;': (v, s) => toArr(s.f.view.items()),
    'toArray([Ljava/lang/Object;)[Ljava/lang/Object;': (v, s, [a]) => toArr(s.f.view.items(), a),
    'toString()Ljava/lang/String;': (v, s) => str(s.f.view.items()),
    'add(Ljava/lang/Object;)Z': () => { throw err('Ljava/lang/UnsupportedOperationException;') },
  }
  def('Ljava/util/MapKeySet;', 'Ljava/util/AbstractSet;', viewMethods, { interfaces: ['Ljava/util/Set;'] })
  def('Ljava/util/MapValues;', 'Ljava/util/AbstractCollection;', viewMethods, { interfaces: ['Ljava/util/Collection;'] })
  def('Ljava/util/MapEntrySet;', 'Ljava/util/AbstractSet;', viewMethods, { interfaces: ['Ljava/util/Set;'] })
  const map: Record<string, NativeFn> = {
    '<init>()V': (v, s) => mapInit(s),
    '<init>(I)V': (v, s) => mapInit(s),
    '<init>(IF)V': (v, s) => mapInit(s),
    '<init>(IFZ)V': (v, s, [, , access]) => { mapInit(s); s.f.access = !!access },
    '<init>(Ljava/util/Map;)V': (v, s, [o]) => { mapInit(s); for (const [k, x] of mapEntries(o)) mput(s, k, x) },
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k, x]) => { if (s.f.access) mdel(s, k); const r = mput(s, k, x); evict(s); return r },
    'putAll(Ljava/util/Map;)V': (v, s, [o]) => { for (const [k, x] of mapEntries(o)) mput(s, k, x) },
    'putIfAbsent(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k, x]) => { const e = mget(s, k); if (e && e[1] != null) return e[1]; mput(s, k, x); return null },
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => { const e = mget(s, k); if (e && s.f.access) { mdel(s, k); mput(s, e[0], e[1]) } return e ? e[1] ?? null : null },
    'getOrDefault(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k, d]) => { const e = mget(s, k); return e ? e[1] ?? null : d },
    'containsKey(Ljava/lang/Object;)Z': (v, s, [k]) => (mget(s, k) ? 1 : 0),
    'containsValue(Ljava/lang/Object;)Z': (v, s, [x]) => ([...s.f.m.values()].some((e: any) => eq(x, e[1])) ? 1 : 0),
    'remove(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => mdel(s, k),
    'size()I': (v, s) => s.f.m.size,
    'isEmpty()Z': (v, s) => (s.f.m.size ? 0 : 1),
    'clear()V': (v, s) => { s.f.m.clear(); s.f.hb = null },
    'keySet()Ljava/util/Set;': (v, s) => view('Ljava/util/MapKeySet;', () => entries(s).map((e) => e[0]), (k) => mdel(s, k), (k) => !!mget(s, k)),
    'values()Ljava/util/Collection;': (v, s) => view('Ljava/util/MapValues;', () => entries(s).map((e) => e[1]), (x) => { for (const [id, e] of s.f.m) if (eq(e[1], x)) { s.f.m.delete(id); forget(s, id); return } }, (x) => [...s.f.m.values()].some((e: any) => eq(x, e[1]))),
    'entrySet()Ljava/util/Set;': (v, s) => view('Ljava/util/MapEntrySet;', () => entries(s).map(([k, x]) => entry(k, x, (nv) => mput(s, k, nv))), (e) => mdel(s, vm.callVirtual(e, 'getKey()Ljava/lang/Object;')), (e) => { const k = vm.callVirtual(e, 'getKey()Ljava/lang/Object;'); const f = mget(s, k); return !!f && eq(f[1], vm.callVirtual(e, 'getValue()Ljava/lang/Object;')) }),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => { if (o === s) return 1; if (!o || !vm.instanceOf(o, vm.cls('Ljava/util/Map;'))) return 0; const b = mapEntries(o); return b.length === s.f.m.size && b.every(([k, x]) => { const e = mget(s, k); return !!e && eq(e[1], x) }) ? 1 : 0 },
    'hashCode()I': (v, s) => [...s.f.m.values()].reduce((h: number, e: any) => (h + (hash(e[0]) ^ hash(e[1]))) | 0, 0),
    'toString()Ljava/lang/String;': (v, s) => '{' + entries(s).map(([k, x]) => `${jstr(vm, k)}=${jstr(vm, x)}`).join(', ') + '}',
    'clone()Ljava/lang/Object;': (v, s) => { const o = new JObject(s.cls); mapInit(o); o.f.sorted = s.f.sorted; o.f.cmp = s.f.cmp; for (const [k, x] of entries(s)) mput(o, k, x); return o },
    'removeEldestEntry(Ljava/util/Map$Entry;)Z': () => 0,
    // Hashtable / old api
    'keys()Ljava/util/Enumeration;': (v, s) => enumeration(entries(s).map((e) => e[0])),
    'elements()Ljava/util/Enumeration;': (v, s) => enumeration(entries(s).map((e) => e[1])),
    'contains(Ljava/lang/Object;)Z': (v, s, [x]) => ([...s.f.m.values()].some((e: any) => eq(x, e[1])) ? 1 : 0),
  }
  // LinkedHashMap with removeEldestEntry (lru caches)
  const evict = (s: JObject) => {
    const m = vm.findMethod(s.cls, 'removeEldestEntry(Ljava/util/Map$Entry;)Z')
    if (!m?.code || !s.f.m.size) return
    const [id, e] = s.f.m.entries().next().value
    if (vm.invoke(m, s, [entry(e[0], e[1])])) { s.f.m.delete(id); forget(s, id) }
  }
  const mapEntries = (o: any): [any, any][] => {
    if (o?.f?.m instanceof Map && !o.f.setOf) return entries(o)
    const out: [any, any][] = []
    const es = vm.callVirtual(o, 'entrySet()Ljava/util/Set;')
    for (const e of itemsOf(es)) out.push([vm.callVirtual(e, 'getKey()Ljava/lang/Object;'), vm.callVirtual(e, 'getValue()Ljava/lang/Object;')])
    return out
  }
  def('Ljava/util/Map;', OBJ, {})
  def('Ljava/util/SortedMap;', OBJ, {}, { interfaces: ['Ljava/util/Map;'] })
  def('Ljava/util/NavigableMap;', OBJ, {}, { interfaces: ['Ljava/util/SortedMap;'] })
  def('Ljava/util/concurrent/ConcurrentMap;', OBJ, {}, { interfaces: ['Ljava/util/Map;'] })
  // AbstractMap for app subclasses: everything through entrySet()
  def('Ljava/util/AbstractMap;', OBJ, {
    '<init>()V': () => {},
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => mapEntries(s).find(([x]) => eq(x, k))?.[1] ?? null,
    'containsKey(Ljava/lang/Object;)Z': (v, s, [k]) => (mapEntries(s).some(([x]) => eq(x, k)) ? 1 : 0),
    'size()I': (v, s) => mapEntries(s).length,
    'isEmpty()Z': (v, s) => (mapEntries(s).length ? 0 : 1),
    'keySet()Ljava/util/Set;': (v, s) => view('Ljava/util/MapKeySet;', () => mapEntries(s).map((e) => e[0]), () => { throw err('Ljava/lang/UnsupportedOperationException;') }, (k) => mapEntries(s).some(([x]) => eq(x, k))),
    'values()Ljava/util/Collection;': (v, s) => view('Ljava/util/MapValues;', () => mapEntries(s).map((e) => e[1]), () => { throw err('Ljava/lang/UnsupportedOperationException;') }, (x) => mapEntries(s).some(([, y]) => eq(x, y))),
    'toString()Ljava/lang/String;': (v, s) => '{' + mapEntries(s).map(([k, x]) => `${jstr(vm, k)}=${jstr(vm, x)}`).join(', ') + '}',
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': () => { throw err('Ljava/lang/UnsupportedOperationException;') },
  }, { interfaces: ['Ljava/util/Map;'] })
  def('Ljava/util/HashMap;', 'Ljava/util/AbstractMap;', map, { interfaces: ['Ljava/util/Map;', 'Ljava/lang/Cloneable;', 'Ljava/io/Serializable;'] })
  def('Ljava/util/LinkedHashMap;', 'Ljava/util/HashMap;', {})
  def('Ljava/util/Hashtable;', OBJ, map, { interfaces: ['Ljava/util/Map;'] })
  def('Ljava/util/Properties;', 'Ljava/util/Hashtable;', { 'getProperty(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => mget(s, k)?.[1] ?? null, 'getProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [k, d]) => mget(s, k)?.[1] ?? d, 'setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/Object;': (v, s, [k, x]) => mput(s, k, x) })
  def('Ljava/util/WeakHashMap;', 'Ljava/util/AbstractMap;', map, { interfaces: ['Ljava/util/Map;'] })
  def('Ljava/util/IdentityHashMap;', 'Ljava/util/AbstractMap;', { ...map, '<init>()V': (v, s) => { mapInit(s); s.f.identity = true }, '<init>(I)V': (v, s) => { mapInit(s); s.f.identity = true } }, { interfaces: ['Ljava/util/Map;'] })
  def('Ljava/util/concurrent/ConcurrentHashMap;', 'Ljava/util/AbstractMap;', map, { interfaces: ['Ljava/util/concurrent/ConcurrentMap;'] })
  def('Ljava/util/concurrent/ConcurrentSkipListMap;', 'Ljava/util/AbstractMap;', { ...map, '<init>()V': (v, s) => { mapInit(s); s.f.sorted = true } }, { interfaces: ['Ljava/util/concurrent/ConcurrentMap;', 'Ljava/util/NavigableMap;'] })
  def('Ljava/util/EnumMap;', 'Ljava/util/AbstractMap;', { ...map, '<init>(Ljava/lang/Class;)V': (v, s) => { mapInit(s); s.f.sorted = true; s.f.cmp = null } }, { interfaces: ['Ljava/util/Map;'] })
  // TreeMap: sorted by key (comparator or compareTo); navigation by sorting the keys
  const sortedKeys = (s: JObject) => entries(s).map((e) => e[0])
  const nav = (s: JObject, k: any, pick: (c: number) => boolean, from: 'first' | 'last') => { const c = cmpOf(s.f.cmp); const ks = sortedKeys(s).filter((x) => pick(c(x, k))); return ks.length ? (from === 'first' ? ks[0] : ks[ks.length - 1]) : null }
  const sub = (s: JObject, keep: (k: any) => boolean) => { const o = new JObject(vm.cls('Ljava/util/TreeMap;')); mapInit(o); o.f.sorted = true; o.f.cmp = s.f.cmp; for (const [k, x] of entries(s)) if (keep(k)) mput(o, k, x); return o }
  def('Ljava/util/TreeMap;', 'Ljava/util/AbstractMap;', {
    ...map,
    '<init>()V': (v, s) => { mapInit(s); s.f.sorted = true; s.f.cmp = null },
    '<init>(Ljava/util/Comparator;)V': (v, s, [c]) => { mapInit(s); s.f.sorted = true; s.f.cmp = c },
    '<init>(Ljava/util/Map;)V': (v, s, [o]) => { mapInit(s); s.f.sorted = true; s.f.cmp = null; for (const [k, x] of mapEntries(o)) mput(s, k, x) },
    'firstKey()Ljava/lang/Object;': (v, s) => { const ks = sortedKeys(s); if (!ks.length) throw err('Ljava/util/NoSuchElementException;'); return ks[0] },
    'lastKey()Ljava/lang/Object;': (v, s) => { const ks = sortedKeys(s); if (!ks.length) throw err('Ljava/util/NoSuchElementException;'); return ks[ks.length - 1] },
    'firstEntry()Ljava/util/Map$Entry;': (v, s) => { const e = entries(s)[0]; return e ? entry(e[0], e[1]) : null },
    'lastEntry()Ljava/util/Map$Entry;': (v, s) => { const es = entries(s); const e = es[es.length - 1]; return e ? entry(e[0], e[1]) : null },
    'pollFirstEntry()Ljava/util/Map$Entry;': (v, s) => { const e = entries(s)[0]; if (!e) return null; mdel(s, e[0]); return entry(e[0], e[1]) },
    'pollLastEntry()Ljava/util/Map$Entry;': (v, s) => { const es = entries(s); const e = es[es.length - 1]; if (!e) return null; mdel(s, e[0]); return entry(e[0], e[1]) },
    'floorKey(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => nav(s, k, (c) => c <= 0, 'last'),
    'ceilingKey(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => nav(s, k, (c) => c >= 0, 'first'),
    'lowerKey(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => nav(s, k, (c) => c < 0, 'last'),
    'higherKey(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => nav(s, k, (c) => c > 0, 'first'),
    'floorEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;': (v, s, [k]) => { const x = nav(s, k, (c) => c <= 0, 'last'); return x == null ? null : entry(x, mget(s, x)![1]) },
    'ceilingEntry(Ljava/lang/Object;)Ljava/util/Map$Entry;': (v, s, [k]) => { const x = nav(s, k, (c) => c >= 0, 'first'); return x == null ? null : entry(x, mget(s, x)![1]) },
    'headMap(Ljava/lang/Object;)Ljava/util/SortedMap;': (v, s, [k]) => sub(s, (x) => cmpOf(s.f.cmp)(x, k) < 0),
    'tailMap(Ljava/lang/Object;)Ljava/util/SortedMap;': (v, s, [k]) => sub(s, (x) => cmpOf(s.f.cmp)(x, k) >= 0),
    'subMap(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/SortedMap;': (v, s, [a, b]) => sub(s, (x) => cmpOf(s.f.cmp)(x, a) >= 0 && cmpOf(s.f.cmp)(x, b) < 0),
    'descendingMap()Ljava/util/NavigableMap;': (v, s) => { const o = sub(s, () => true); const c = s.f.cmp; const rev = new JObject(vm.cls('Ljava/util/Collections$ReverseComparator;')); rev.f.base = c; o.f.cmp = rev; return o },
    'comparator()Ljava/util/Comparator;': (v, s) => s.f.cmp ?? null,
  }, { interfaces: ['Ljava/util/NavigableMap;'] })

  // ---------- sets (a map from item to item) ----------
  const set: Record<string, NativeFn> = {
    '<init>()V': (v, s) => { mapInit(s); s.f.setOf = true },
    '<init>(I)V': (v, s) => { mapInit(s); s.f.setOf = true },
    '<init>(IF)V': (v, s) => { mapInit(s); s.f.setOf = true },
    '<init>(Ljava/util/Collection;)V': (v, s, [c]) => { mapInit(s); s.f.setOf = true; for (const x of itemsOf(c)) sadd(s, x) },
    'add(Ljava/lang/Object;)Z': (v, s, [x]) => (sadd(s, x) ? 1 : 0),
    'addAll(Ljava/util/Collection;)Z': (v, s, [c]) => { let ch = 0; for (const x of itemsOf(c)) if (sadd(s, x)) ch = 1; return ch },
    'remove(Ljava/lang/Object;)Z': (v, s, [x]) => { const id = keyId(s, x, false); if (id == null || !s.f.m.has(id)) return 0; s.f.m.delete(id); forget(s, id); return 1 },
    'removeAll(Ljava/util/Collection;)Z': (v, s, [c]) => { let ch = 0; for (const x of itemsOf(c)) { const id = keyId(s, x, false); if (id != null && s.f.m.delete(id)) { forget(s, id); ch = 1 } } return ch },
    'retainAll(Ljava/util/Collection;)Z': (v, s, [c]) => { const keep = itemsOf(c); let ch = 0; for (const [id, e] of [...s.f.m]) if (!keep.some((y) => eq(e[0], y))) { s.f.m.delete(id); forget(s, id); ch = 1 } return ch },
    'contains(Ljava/lang/Object;)Z': (v, s, [x]) => { const id = keyId(s, x, false); return id != null && s.f.m.has(id) ? 1 : 0 },
    'containsAll(Ljava/util/Collection;)Z': (v, s, [c]) => (itemsOf(c).every((x) => { const id = keyId(s, x, false); return id != null && s.f.m.has(id) }) ? 1 : 0),
    'size()I': (v, s) => s.f.m.size,
    'isEmpty()Z': (v, s) => (s.f.m.size ? 0 : 1),
    'clear()V': (v, s) => { s.f.m.clear(); s.f.hb = null },
    'iterator()Ljava/util/Iterator;': (v, s) => { const xs = sitems(s); return iter(() => xs, (x, i) => { const id = keyId(s, x, false); if (id != null) { s.f.m.delete(id); forget(s, id) } xs.splice(i, 1) }) },
    'toArray()[Ljava/lang/Object;': (v, s) => toArr(sitems(s)),
    'toArray([Ljava/lang/Object;)[Ljava/lang/Object;': (v, s, [a]) => toArr(sitems(s), a),
    'toString()Ljava/lang/String;': (v, s) => str(sitems(s)),
    'clone()Ljava/lang/Object;': (v, s) => { const o = new JObject(s.cls); mapInit(o); o.f.setOf = true; o.f.sorted = s.f.sorted; o.f.cmp = s.f.cmp; for (const x of sitems(s)) sadd(o, x); return o },
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => { if (o === s) return 1; if (!o || !vm.instanceOf(o, vm.cls('Ljava/util/Set;'))) return 0; const b = itemsOf(o); return b.length === s.f.m.size && b.every((x) => { const id = keyId(s, x, false); return id != null && s.f.m.has(id) }) ? 1 : 0 },
    'hashCode()I': (v, s) => sitems(s).reduce((h, x) => (h + hash(x)) | 0, 0),
  }
  const sadd = (s: JObject, x: any) => { const id = keyId(s, x, true)!; if (s.f.m.has(id)) return false; s.f.m.set(id, [x, x]); return true }
  const sitems = (s: JObject) => { const xs = [...s.f.m.values()].map((e: any) => e[0]); return s.f.sorted ? xs.sort(cmpOf(s.f.cmp)) : xs }
  def('Ljava/util/HashSet;', 'Ljava/util/AbstractSet;', set, { interfaces: ['Ljava/util/Set;', 'Ljava/lang/Cloneable;', 'Ljava/io/Serializable;'] })
  def('Ljava/util/LinkedHashSet;', 'Ljava/util/HashSet;', {})
  def('Ljava/util/concurrent/CopyOnWriteArraySet;', 'Ljava/util/AbstractSet;', set, { interfaces: ['Ljava/util/Set;'] })
  def('Ljava/util/TreeSet;', 'Ljava/util/AbstractSet;', {
    ...set,
    '<init>()V': (v, s) => { mapInit(s); s.f.setOf = true; s.f.sorted = true; s.f.cmp = null },
    '<init>(Ljava/util/Comparator;)V': (v, s, [c]) => { mapInit(s); s.f.setOf = true; s.f.sorted = true; s.f.cmp = c },
    '<init>(Ljava/util/Collection;)V': (v, s, [c]) => { mapInit(s); s.f.setOf = true; s.f.sorted = true; s.f.cmp = null; for (const x of itemsOf(c)) sadd(s, x) },
    'first()Ljava/lang/Object;': (v, s) => { const xs = sitems(s); if (!xs.length) throw err('Ljava/util/NoSuchElementException;'); return xs[0] },
    'last()Ljava/lang/Object;': (v, s) => { const xs = sitems(s); if (!xs.length) throw err('Ljava/util/NoSuchElementException;'); return xs[xs.length - 1] },
    'pollFirst()Ljava/lang/Object;': (v, s) => { const x = sitems(s)[0]; if (x === undefined) return null; vm.callVirtual(s, 'remove(Ljava/lang/Object;)Z', [x]); return x },
    'floor(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => sitems(s).filter((x) => cmpOf(s.f.cmp)(x, k) <= 0).pop() ?? null,
    'ceiling(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => sitems(s).find((x) => cmpOf(s.f.cmp)(x, k) >= 0) ?? null,
    'descendingIterator()Ljava/util/Iterator;': (v, s) => { const xs = sitems(s).reverse(); return iter(() => xs) },
    'comparator()Ljava/util/Comparator;': (v, s) => s.f.cmp ?? null,
  }, { interfaces: ['Ljava/util/NavigableSet;'] })

  // ---------- Collections ----------
  const unmod = (c: any) => c // read-only wrappers: the same object (apps that write to them would crash on android anyway)
  const emptyList = () => { const l = new JObject(vm.cls('Ljava/util/ArrayList;')); l.f.a = []; return l }
  const newSet = (xs: any[]) => { const o = new JObject(vm.cls('Ljava/util/HashSet;')); mapInit(o); o.f.setOf = true; for (const x of xs) sadd(o, x); return o }
  const newMap = () => { const o = new JObject(vm.cls('Ljava/util/HashMap;')); mapInit(o); return o }
  def('Ljava/util/Collections$ReverseComparator;', OBJ, { 'compare(Ljava/lang/Object;Ljava/lang/Object;)I': (v, s, [a, b]) => cmpOf(s.f.base ?? null)(b, a), 'reversed()Ljava/util/Comparator;': (v, s) => s.f.base ?? null }, { interfaces: ['Ljava/util/Comparator;'] })
  const rev = (base: any) => { const r = new JObject(vm.cls('Ljava/util/Collections$ReverseComparator;')); r.f.base = base; return r }
  const sortList = (l: any, c: any) => { const xs = [...itemsOf(l)].sort(cmpOf(c)); if (Array.isArray(l.f?.a)) { l.f.a.length = 0; l.f.a.push(...xs) } else xs.forEach((x, i) => vm.callVirtual(l, 'set(ILjava/lang/Object;)Ljava/lang/Object;', [i, x])) }
  const C: Record<string, NativeFn> = {
    'sort(Ljava/util/List;)V': (v, s, [l]) => sortList(l, null),
    'sort(Ljava/util/List;Ljava/util/Comparator;)V': (v, s, [l, c]) => sortList(l, c),
    'reverse(Ljava/util/List;)V': (v, s, [l]) => { l.f.a.reverse() },
    'shuffle(Ljava/util/List;)V': (v, s, [l]) => { const a = l.f.a; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } },
    'shuffle(Ljava/util/List;Ljava/util/Random;)V': (v, s, [l]) => { const a = l.f.a; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } },
    'swap(Ljava/util/List;II)V': (v, s, [l, i, j]) => { const a = l.f.a; [a[i], a[j]] = [a[j], a[i]] },
    'fill(Ljava/util/List;Ljava/lang/Object;)V': (v, s, [l, x]) => { l.f.a.fill(x) },
    'max(Ljava/util/Collection;)Ljava/lang/Object;': (v, s, [c]) => { const xs = itemsOf(c); if (!xs.length) throw err('Ljava/util/NoSuchElementException;'); return xs.reduce((a, b) => (cmpOf(null)(a, b) >= 0 ? a : b)) },
    'min(Ljava/util/Collection;)Ljava/lang/Object;': (v, s, [c]) => { const xs = itemsOf(c); if (!xs.length) throw err('Ljava/util/NoSuchElementException;'); return xs.reduce((a, b) => (cmpOf(null)(a, b) <= 0 ? a : b)) },
    'max(Ljava/util/Collection;Ljava/util/Comparator;)Ljava/lang/Object;': (v, s, [c, k]) => itemsOf(c).reduce((a, b) => (cmpOf(k)(a, b) >= 0 ? a : b)),
    'min(Ljava/util/Collection;Ljava/util/Comparator;)Ljava/lang/Object;': (v, s, [c, k]) => itemsOf(c).reduce((a, b) => (cmpOf(k)(a, b) <= 0 ? a : b)),
    'frequency(Ljava/util/Collection;Ljava/lang/Object;)I': (v, s, [c, x]) => itemsOf(c).filter((y) => eq(x, y)).length,
    'addAll(Ljava/util/Collection;[Ljava/lang/Object;)Z': (v, s, [c, a]) => { let ch = 0; for (const x of a.data) ch |= vm.callVirtual(c, 'add(Ljava/lang/Object;)Z', [x]); return ch },
    'nCopies(ILjava/lang/Object;)Ljava/util/List;': (v, s, [n, x]) => { const l = emptyList(); l.f.a = new Array(n).fill(x); return l },
    'singletonList(Ljava/lang/Object;)Ljava/util/List;': (v, s, [x]) => { const l = emptyList(); l.f.a = [x]; return l },
    'singleton(Ljava/lang/Object;)Ljava/util/Set;': (v, s, [x]) => newSet([x]),
    'singletonMap(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Map;': (v, s, [k, x]) => { const o = newMap(); mput(o, k, x); return o },
    'emptyList()Ljava/util/List;': () => emptyList(), 'emptySet()Ljava/util/Set;': () => newSet([]), 'emptyMap()Ljava/util/Map;': () => newMap(),
    'emptyIterator()Ljava/util/Iterator;': () => iter(() => []), 'emptyListIterator()Ljava/util/ListIterator;': () => iter(() => []),
    'emptyEnumeration()Ljava/util/Enumeration;': () => enumeration([]),
    'enumeration(Ljava/util/Collection;)Ljava/util/Enumeration;': (v, s, [c]) => enumeration([...itemsOf(c)]),
    'list(Ljava/util/Enumeration;)Ljava/util/ArrayList;': (v, s, [e]) => { const l = emptyList(); while (vm.callVirtual(e, 'hasMoreElements()Z')) l.f.a.push(vm.callVirtual(e, 'nextElement()Ljava/lang/Object;')); return l },
    'reverseOrder()Ljava/util/Comparator;': () => rev(null),
    'reverseOrder(Ljava/util/Comparator;)Ljava/util/Comparator;': (v, s, [c]) => rev(c),
    'binarySearch(Ljava/util/List;Ljava/lang/Object;)I': (v, s, [l, k]) => { const a = itemsOf(l); let lo = 0, hi = a.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1, c = cmpOf(null)(a[mid], k); if (c < 0) lo = mid + 1; else if (c > 0) hi = mid - 1; else return mid } return -(lo + 1) },
    'disjoint(Ljava/util/Collection;Ljava/util/Collection;)Z': (v, s, [a, b]) => { const y = itemsOf(b); return itemsOf(a).some((x) => y.some((z) => eq(x, z))) ? 0 : 1 },
    'newSetFromMap(Ljava/util/Map;)Ljava/util/Set;': () => newSet([]),
  }
  for (const k of ['Collection', 'List', 'Set', 'Map', 'SortedMap', 'SortedSet', 'NavigableMap', 'NavigableSet']) {
    C[`unmodifiable${k}(Ljava/util/${k};)Ljava/util/${k};`] = (v, s, [c]) => unmod(c)
    C[`synchronized${k}(Ljava/util/${k};)Ljava/util/${k};`] = (v, s, [c]) => c
    C[`checked${k}(Ljava/util/${k};Ljava/lang/Class;)Ljava/util/${k};`] = (v, s, [c]) => c
  }
  def('Ljava/util/Collections;', OBJ, C, { statics: { EMPTY_LIST: emptyList(), EMPTY_SET: newSet([]), EMPTY_MAP: newMap() } })

  // ---------- Comparator, Objects ----------
  def('Ljava/util/Comparator;', OBJ, {
    'reversed()Ljava/util/Comparator;': (v, s) => rev(s),
    'naturalOrder()Ljava/util/Comparator;': () => null,
    'reverseOrder()Ljava/util/Comparator;': () => rev(null),
  })
  def('Ljava/util/Objects;', OBJ, {
    'equals(Ljava/lang/Object;Ljava/lang/Object;)Z': (v, s, [a, b]) => (eq(a, b) ? 1 : 0),
    'deepEquals(Ljava/lang/Object;Ljava/lang/Object;)Z': (v, s, [a, b]) => (eq(a, b) ? 1 : 0),
    'hashCode(Ljava/lang/Object;)I': (v, s, [a]) => hash(a),
    'hash([Ljava/lang/Object;)I': (v, s, [a]) => (a ? [...a.data].reduce((h: number, x: any) => (Math.imul(31, h) + hash(x)) | 0, 1) : 0),
    'toString(Ljava/lang/Object;)Ljava/lang/String;': (v, s, [a]) => jstr(vm, a),
    'toString(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/String;': (v, s, [a, d]) => (a == null ? d : jstr(vm, a)),
    'requireNonNull(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [a]) => { if (a == null) throw err('Ljava/lang/NullPointerException;'); return a },
    'requireNonNull(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/Object;': (v, s, [a, m]) => { if (a == null) throw err('Ljava/lang/NullPointerException;', m); return a },
    'isNull(Ljava/lang/Object;)Z': (v, s, [a]) => (a == null ? 1 : 0), 'nonNull(Ljava/lang/Object;)Z': (v, s, [a]) => (a == null ? 0 : 1),
    'compare(Ljava/lang/Object;Ljava/lang/Object;Ljava/util/Comparator;)I': (v, s, [a, b, c]) => (a === b ? 0 : cmpOf(c)(a, b)),
  })
  void box; void JavaThrow
}
