// local only: install any apk from dist/apk-test (APK=name.apk), open it, report what breaks.
// RUN_MS: how long to watch. never commit the apks themselves.
export default async ({ page, shot, base }) => {
  const apk = process.env.APK || 'test.apk'
  page.on('console', (m) => { const t = m.text(); if (/gl calls|gl fps|missing|crash|stopped|exception|error|java stack|stack:|died|warn/i.test(t) && !/GL Driver|favicon/.test(t)) console.log('console:', t.slice(0, 600)) })
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)))
  if (process.env.AOSP) await page.addInitScript(() => { window.__aosp = true })
  if (process.env.NOJIT) await page.addInitScript(() => { window.__nojit = true })
  if (process.env.GLFPS) await page.addInitScript(() => { window.__glfps = true })
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none', ...(window.__aosp ? { 'android.aosp': true, 'dev.enabled': true } : {}) })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate((a) => { window.droid_shell.wm.start({ action: 'install', data: 'apk-test/' + a, type: 'application/vnd.android.package-archive' }) }, apk)
  await page.waitForSelector('.window.visible .pi-buttons', { timeout: 120000 })
  await page.waitForTimeout(1500)
  await shot('apk-00-installer')
  await page.click('.window.visible .pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(3000)
  await page.click('.window.visible .pi-buttons .h-btn-borderless:last-child').catch(() => {})
  await page.waitForTimeout(Number(process.env.RUN_MS || 15000))
  await shot('apk-01-run')
  // STEPS='tap:32,356;wait:2000;back;shot' : taps (page px), waits, the back key, screenshots
  let n = 2
  for (const st of (process.env.STEPS || '').split(';').filter(Boolean)) {
    const [k, a] = st.split(':')
    if (k === 'tap') { const [x, y] = a.split(',').map(Number); await page.mouse.click(x, y); await page.waitForTimeout(1500) }
    else if (k === 'drag') { const [x0, y0, x1, y1] = a.split(',').map(Number); await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= 10; i++) { await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10); await page.waitForTimeout(30) } await page.mouse.up(); await page.waitForTimeout(1500) }
    else if (k === 'wait') await page.waitForTimeout(Number(a))
    else if (k === 'prof') { // prof:ms -> top js functions by self time
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.start')
      await page.waitForTimeout(Number(a))
      const { profile: p } = await cdp.send('Profiler.stop')
      const byId = new Map(p.nodes.map((x) => [x.id, x])), self = new Map(); let tot = 0
      p.samples.forEach((sid, i) => { const nd = byId.get(sid), f = nd.callFrame, key = f.functionName + ' ' + f.url.split('/').pop() + ':' + f.lineNumber; self.set(key, (self.get(key) || 0) + p.timeDeltas[i]); tot += p.timeDeltas[i] })
      console.log('profile', Math.round(tot / 1000), 'ms'); for (const [key, v] of [...self].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log((v / tot * 100).toFixed(1) + '%', key)
    }
    else if (k === 'back') { await page.evaluate(() => window.droid_shell.wm.back()); await page.waitForTimeout(2000) }
    else if (k === 'shot') await shot('apk-' + String(n++).padStart(2, '0') + (a ? '-' + a : ''))
  }
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
