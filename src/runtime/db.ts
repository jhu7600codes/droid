// indexeddb storage for installed dpks and app data (spec section 8).
// stores: packages (id -> record), files (key "<scope>:<path>" -> Blob), kv (key "<pkg>:<key>" -> json)
// scope is "pkg:<id>" for private files, "app:<id>" for package contents, "shared" for shared storage.

const NAME = 'droid'
let dbp: Promise<IDBDatabase> | null = null

export function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((ok, fail) => {
      const r = indexedDB.open(NAME, 1)
      r.onupgradeneeded = () => {
        const d = r.result
        d.createObjectStore('packages')
        d.createObjectStore('files')
        d.createObjectStore('kv')
      }
      r.onsuccess = () => ok(r.result)
      r.onerror = () => fail(r.error)
    })
  }
  return dbp
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error) })

export async function get<T = any>(store: string, key: string): Promise<T | undefined> {
  return req((await db()).transaction(store).objectStore(store).get(key))
}
export async function put(store: string, key: string, value: unknown) {
  const t = (await db()).transaction(store, 'readwrite')
  t.objectStore(store).put(value, key)
  return new Promise<void>((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error) })
}
export async function del(store: string, key: string) {
  const t = (await db()).transaction(store, 'readwrite')
  t.objectStore(store).delete(key)
  return new Promise<void>((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error) })
}
// keys starting with prefix
export async function keys(store: string, prefix = ''): Promise<string[]> {
  const range = prefix ? IDBKeyRange.bound(prefix, prefix + '￿') : undefined
  return (await req((await db()).transaction(store).objectStore(store).getAllKeys(range))) as string[]
}
export async function delPrefix(store: string, prefix: string) {
  const t = (await db()).transaction(store, 'readwrite')
  t.objectStore(store).delete(IDBKeyRange.bound(prefix, prefix + '￿'))
  return new Promise<void>((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error) })
}
// many puts in one transaction (install)
export async function putMany(store: string, entries: [string, unknown][]) {
  const t = (await db()).transaction(store, 'readwrite')
  const s = t.objectStore(store)
  for (const [k, v] of entries) s.put(v, k)
  return new Promise<void>((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error) })
}
