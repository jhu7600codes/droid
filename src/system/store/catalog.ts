// the danen store catalog (built by tools/store/build-catalog.mjs into store/catalog.json on github pages).
// cached so the store can be browsed offline.
import { settings } from '../../shell/settings'
import { storeApi } from '../../shell/danen-remote'

export interface Listing {
  id: string; name: string; version: string; versioncode: number; author: string; description: string
  category: string; icon: string; screenshots: string[]; size: number; permissions: string[]
  dpk: string; sha256: string; updated: string; homepage?: string
  community?: boolean // published from droid with a danen account (not reviewed); converted?: made from an apk
  converted?: boolean
}
export interface Catalog { version: number; generated: string; apps: Listing[]; base: string }

const CACHE = 'droid.store.catalog'
export const catalogUrl = () => (settings.get('store.catalog') as string) || 'store/catalog.json'

export async function loadCatalog(fresh = false): Promise<Catalog> {
  const url = new URL(catalogUrl(), document.baseURI).href
  if (!fresh || !navigator.onLine) {
    try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); if (c && (!navigator.onLine || !fresh)) { if (!fresh) refresh(url); return c } } catch { /* none */ }
  }
  return refresh(url)
}
async function refresh(url: string): Promise<Catalog> {
  const [c, community] = await Promise.all([
    fetch(url, { cache: 'no-cache' }).then((r) => r.json()),
    storeApi.apps().then((r) => r.apps).catch(() => [] as Listing[]), // the community side may be unreachable
  ])
  c.base = url.replace(/[^/]+$/, '')
  // community listings never shadow the main store's apps
  const main = new Set((c.apps as Listing[]).map((a) => a.id))
  c.apps = [...c.apps, ...community.filter((a: Listing) => !main.has(a.id)).map((a: Listing) => ({ ...a, community: true }))]
  try { localStorage.setItem(CACHE, JSON.stringify(c)) } catch { /* full */ }
  return c
}
// listing paths are relative to the catalog
export const abs = (c: Catalog, p: string) => new URL(p, c.base).href
