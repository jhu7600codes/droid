// converted kotlin app posts an android notification; open the shade, tap it
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { if (/missing pieces|stopped|notification/i.test(m.text())) console.log('console:', m.text().slice(0, 300)) })
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload()
  await page.waitForTimeout(2500)
  await page.evaluate(() => { window.droid_shell.wm.start({ action: 'install', data: 'apk-test/test-kt.apk', type: 'application/vnd.android.package-archive' }) })
  await page.waitForTimeout(2500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(1500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(3000)
  const f = page.frameLocator('.window.visible iframe')
  await f.locator('button.h-btn').nth(1).click(); await page.waitForTimeout(300)
  await f.locator('button.h-btn').nth(2).click(); await page.waitForTimeout(800)
  await page.click('#overlay .h-btn-borderless:last-child').catch(() => {}) // allow notifications
  await page.waitForTimeout(800)
  const b = await page.locator('#statusbar').boundingBox()
  await page.mouse.move(b.x + 40, b.y + 5); await page.mouse.down(); await page.mouse.move(b.x + 40, b.y + 400, { steps: 8 }); await page.mouse.up()
  await page.waitForTimeout(500)
  await shot('n-01-shade')
  await page.click('.note')
  await page.waitForTimeout(3000)
  await shot('n-02-opened')
}
