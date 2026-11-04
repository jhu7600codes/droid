// system updates screen when there is nothing new: it must settle on "up to date"
export default async ({ page, shot, base }) => {
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => window.droid_shell.wm.start({ action: 'system-update' }))
  await page.waitForTimeout(4000)
  console.log('status:', await page.locator('.window.visible .upd-msg').innerText())
  await shot('upd-01')
}
