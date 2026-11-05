// local only: install any apk from dist/apk-test (APK=name.apk), open it, report what breaks.
// RUN_MS: how long to watch. never commit the apks themselves.
export default async ({ page, shot, base }) => {
  const apk = process.env.APK || 'test.apk'
  page.on('console', (m) => { const t = m.text(); if (/missing|crash|stopped|exception|error|java stack|stack:|died|warn/i.test(t) && !/GL Driver|favicon/.test(t)) console.log('console:', t.slice(0, 600)) })
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)))
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate((a) => { window.droid_shell.wm.start({ action: 'install', data: 'apk-test/' + a, type: 'application/vnd.android.package-archive' }) }, apk)
  await page.waitForSelector('.window.visible .pi-buttons', { timeout: 120000 })
  await page.waitForTimeout(1500)
  await shot('apk-00-installer')
  await page.click('.window.visible .pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(3000)
  await page.click('.window.visible .pi-buttons .h-btn-borderless:last-child').catch(() => {})
  await page.waitForTimeout(Number(process.env.RUN_MS || 15000))
  await shot('apk-01-run')
  if (process.env.DUMP) await dump(page)
  console.log('overlay:', (await page.locator('#overlay').innerText().catch(() => '')).slice(0, 600))
}
// DUMP=1: print the app frame's view tree (tags, classes, sizes, text)
export const dump = async (page) => {
  for (const f of page.frames()) {
    const t = await f.evaluate(() => {
      const root = document.querySelector('.an-content'); if (!root) return null
      const out = []
      const walk = (e, d) => { const r = e.getBoundingClientRect(); out.push(`${'  '.repeat(d)}${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}${e.style.display === 'none' ? ' HIDDEN' : ''} ${e.children.length ? '' : JSON.stringify((e.textContent || '').slice(0, 30))}`); if (d < 14) for (const c of e.children) walk(c, d + 1) }
      walk(root, 0); return out.join('\n')
    }).catch(() => null)
    if (t) console.log(t)
  }
}
