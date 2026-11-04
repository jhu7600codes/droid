// kotlin apk: install, use, play the raw sound
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { if (/missing pieces|android|stopped/i.test(m.text())) console.log('console:', m.text().slice(0, 600)) })
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload()
  await page.waitForTimeout(2500)
  await page.evaluate(() => { window.droid_shell.wm.start({ action: 'install', data: 'apk-test/test-kt.apk', type: 'application/vnd.android.package-archive' }) })
  await page.waitForTimeout(2500)
  await page.click('.pi-buttons .h-btn-borderless:last-child')
  await page.waitForTimeout(1500)
  await page.click('.pi-buttons .h-btn-borderless:last-child')
  await page.waitForTimeout(3000)
  const f = page.frameLocator('.window.visible iframe')
  for (let i = 0; i < 3; i++) { await f.locator('button.h-btn').nth(1).click(); await page.waitForTimeout(300) }
  await f.locator('button.h-btn').first().click()
  await page.waitForTimeout(1200)
  await shot('kt-01')
}
