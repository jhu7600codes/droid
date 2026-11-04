// opengl es 2 from native code: GLSurfaceView + a native renderer (test.apk's GlActivity)
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { const t = m.text(); if (/gl|missing|error|stopped|crash/i.test(t)) console.log('console:', t.slice(0, 300)) })
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => { window.droid_shell.wm.start({ action: 'install', data: 'apk-test/test.apk', type: 'application/vnd.android.package-archive' }) })
  await page.waitForTimeout(2500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(1500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(2500)
  await page.evaluate(() => window.droid_shell.wm.start({ package: 'com.droid.hellojni', activity: 'a2' }))
  const t0 = Date.now()
  await page.waitForTimeout(1500)
  await page.mouse.click(30, 300) // the page stays responsive while frames render
  console.log('click answered after', Date.now() - t0, 'ms')
  await page.waitForTimeout(3500)
  await shot('gl-01')
}
