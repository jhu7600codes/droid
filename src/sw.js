// droid service worker (plain js, copied by vite.config.ts). VERSION and SHELL are filled in at build time (vite.config.ts).
// shell files are precached on install. everything else is cache-first once it was fetched or
// downloaded by the offline screen (cache 'droid-offline').
const VERSION = '__VERSION__'
const SHELL = JSON.parse('__SHELL__')
const SHELL_CACHE = 'droid-shell-' + VERSION

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)))
})
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // keep the previous shell too: a page still running the old version can load its old chunks
    const old = (await caches.keys()).filter((k) => k.startsWith('droid-shell-') && k !== SHELL_CACHE).sort()
    for (const k of old.slice(0, -1)) await caches.delete(k)
    await self.clients.claim()
  })())
})
self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting() })

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  if (url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/version.json')) return
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: url.pathname.endsWith('.html') || url.pathname.endsWith('/') })
    if (hit) return hit
    try {
      const res = await fetch(req)
      // keep what we fetched so it works offline next time (assets only, they are versioned by path)
      if (res.ok && url.pathname.includes('/assets/')) {
        const c = await caches.open('droid-offline')
        c.put(req, res.clone())
      }
      return res
    } catch {
      return new Response('offline', { status: 503, statusText: 'offline' })
    }
  })())
})

// web push from the danen backend: { title, body, pkg }
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch (err) { d = { title: 'droid', body: e.data && e.data.text() } }
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    const visible = cs.find((c) => c.visibilityState === 'visible')
    if (visible) { visible.postMessage({ droidPush: d }); return }
    return self.registration.showNotification(d.title || 'droid', { body: d.body || '', icon: 'icons/icon-192.png', data: d })
  }))
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const pkg = e.notification.data && e.notification.data.pkg
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    if (cs[0]) { cs[0].postMessage({ droidOpen: pkg }); return cs[0].focus() }
    return self.clients.openWindow('./' + (pkg ? '?open=' + encodeURIComponent(pkg) : ''))
  }))
})
