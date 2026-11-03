// package installer screens: install a sample dpk from a file url, then the done screen
export default async ({ page, shot, base }) => {
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none', 'samples.installed': true })))
  await page.reload()
  await page.waitForTimeout(2500)
  await page.evaluate(() => { window.droid_shell.wm.start({ action: 'install', data: 'examples/notes.dpk', type: 'application/x-dpk' }) })
  await page.waitForTimeout(1200)
  await shot('pi-01-install')
  await page.click('.pi-buttons .h-btn-borderless:last-child')
  await page.waitForTimeout(1200)
  await shot('pi-02-done')
}
