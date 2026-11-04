// settings > about > tap Droid version 5 times: the egg, then long press for the pigeon flock
export default async ({ page, shot, base }) => {
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload()
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.droid_shell.wm.start({ action: 'settings', extras: { page: 'about' } }))
  await page.waitForTimeout(1500)
  const row = page.locator('.window.visible').getByText('Droid version', { exact: true })
  for (let i = 0; i < 5; i++) { await row.click(); await page.waitForTimeout(150) }
  await page.waitForTimeout(1200)
  await shot('egg-01')
  const t = await page.locator('.egg-tile').boundingBox()
  await page.mouse.move(t.x + 90, t.y + 90); await page.mouse.down(); await page.waitForTimeout(900); await page.mouse.up()
  await page.waitForTimeout(3500)
  await shot('egg-02-flock')
}
