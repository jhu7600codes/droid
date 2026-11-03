// the danen store catalog (built by tools/store/build-catalog.mjs into store/catalog.json on github pages).
// cached so the store can be browsed offline.
import { settings } from '../../shell/settings'

export interface Listing {
  id: string; name: string; version: string; versioncode: number; author: string; description: string
  category: string; icon: string; screenshots: string[]; size: number; permissions: string[]
  dpk: string; sha256: string; updated: string; homepage?: string
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
  const c = await (await fetch(url, { cache: 'no-cache' })).json()
  c.base = url.replace(/[^/]+$/, '')
  try { localStorage.setItem(CACHE, JSON.stringify(c)) } catch { /* full */ }
  return c
}
// listing paths are relative to the catalog
export const abs = (c: Catalog, p: string) => new URL(p, c.base).href
