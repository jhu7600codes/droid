// big apk (local only, never committed): dist/apk-test/ss.apk. install, open, report what breaks
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { const t = m.text(); if (/missing|android|stopped|native|exception|error|unity/i.test(t)) console.log('console:', t.slice(0, 700)) })
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)))
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => { window.droid_shell.wm.start({ action: 'install', data: 'apk-test/ss.apk', type: 'application/vnd.android.package-archive' }) })
  await page.waitForTimeout(Number(process.env.CONVERT_MS || 25000))
  await shot('ss-00-installer')
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(4000)
  await page.click('.pi-buttons .h-btn-borderless:last-child').catch(() => {}); await page.waitForTimeout(Number(process.env.RUN_MS || 30000))
  await shot('ss-01-run')
  const dlg = await page.locator('#overlay').innerText().catch(() => '')
  console.log('overlay:', dlg.slice(0, 800))
}
