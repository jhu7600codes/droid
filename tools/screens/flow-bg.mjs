// converted kotlin app sets an alarm (long press notify), goes home; the receiver runs in the
// background host and posts a notification with a kitkat ticker
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { if (/missing|stopped|notification|background|alarm|error/i.test(m.text())) console.log('console:', m.text().slice(0, 300)) })
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
  await f.locator('button.h-btn').nth(2).click({ button: 'right' }); await page.waitForTimeout(800)
  console.log('alarms', await page.evaluate(() => JSON.stringify(window.droid_shell.settings.get('bg.alarms'))))
  // close every task, then wait for the alarm tick
  await page.evaluate(() => { window.droid_shell.wm.home() })
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000)
    await page.click('#overlay .h-btn-borderless:last-child', { timeout: 50 }).catch(() => {}) // allow notifications
    if (await page.locator('.sb-ticker').count()) break
  }
  await page.waitForTimeout(300)
  await shot('bg-01-ticker')
  await page.waitForTimeout(6000)
  const b = await page.locator('#statusbar').boundingBox()
  await page.mouse.move(b.x + 40, b.y + 5); await page.mouse.down(); await page.mouse.move(b.x + 40, b.y + 400, { steps: 8 }); await page.mouse.up()
  await page.waitForTimeout(500)
  await shot('bg-02-shade')
}
