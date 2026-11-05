// touch dispatch: a GLSurfaceView subclass takes touches in its top half (moves too), the bottom half
// falls through to Activity.onTouchEvent (test.apk's GlActivity)
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { const t = m.text(); if (/touch|crash|error/i.test(t)) console.log('console:', t.slice(0, 200)) })
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => { window.droid_shell.wm.start({ action: 'install', data: 'apk-test/test.apk', type: 'application/vnd.android.package-archive' }) })
  await page.waitForTimeout(2500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(1500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(2500)
  await page.evaluate(() => window.droid_shell.wm.start({ package: 'com.droid.hellojni', activity: 'a2' }))
  await page.waitForTimeout(3000)
  await page.mouse.move(100, 150); await page.mouse.down(); await page.mouse.move(140, 170, { steps: 2 }); await page.mouse.up()
  await page.waitForTimeout(500)
  await page.mouse.click(200, 500)
  await page.waitForTimeout(800)
  await shot('touch-01')
}
