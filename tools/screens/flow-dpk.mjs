// installs a dpk from the built site (DPK=games/coil.dpk) and drives it: STEPS like flow-apk
// (tap:x,y;drag:x0,y0,x1,y1;wait:ms;shot:name). page errors and app console errors are printed.
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { if (m.type() === 'error' || /exception|error/i.test(m.text())) console.log('console:', m.text().slice(0, 300)) })
  page.on('pageerror', (e) => console.log('pageerror', e.message))
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate((d) => window.droid_shell.wm.start({ action: 'install', data: d, type: 'application/x-dpk' }), process.env.DPK)
  await page.waitForTimeout(2000)
  await page.click('.pi-buttons .h-btn-borderless:last-child').catch(() => {}); await page.waitForTimeout(1500)
  await page.click('.pi-buttons .h-btn-borderless:last-child').catch(() => {}); await page.waitForTimeout(Number(process.env.RUN_MS || 3000))
  await shot('dpk-01-open')
  let n = 2
  for (const st of (process.env.STEPS || '').split(';').filter(Boolean)) {
    const [k, a] = st.split(':')
    if (k === 'tap') { const [x, y] = a.split(',').map(Number); await page.mouse.click(x, y); await page.waitForTimeout(400) }
    else if (k === 'drag') { const [x0, y0, x1, y1] = a.split(',').map(Number); await page.mouse.move(x0, y0); await page.mouse.down(); for (let i = 1; i <= 8; i++) { await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8); await page.waitForTimeout(16) } await page.mouse.up(); await page.waitForTimeout(200) }
    else if (k === 'wait') await page.waitForTimeout(Number(a))
    else if (k === 'shot') await shot('dpk-' + String(n++).padStart(2, '0') + (a ? '-' + a : ''))
  }
}
