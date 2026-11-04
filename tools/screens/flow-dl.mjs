// droid browser on the live site: open /secret through the proxy, tap the kotlin apk, it lands in
// download/ with a notification, tapping it opens the installer
export default async ({ page, shot }) => {
  const live = 'https://jhu7600codes.github.io/droid/'
  page.on('console', (m) => { if (/download|error/i.test(m.text())) console.log('console:', m.text().slice(0, 200)) })
  await page.goto(live + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(3000)
  await page.evaluate((u) => window.droid_shell.wm.start({ action: 'view', data: u }), live + 'secret/')
  await page.waitForTimeout(7000)
  await shot('dl-01-secret')
  const f = page.frameLocator('.window.visible iframe.visible, .window.visible iframe').first()
  await f.getByText('Kotlin test (notifications, alarms, sound)').click()
  await page.waitForTimeout(6000)
  await shot('dl-02-after')
  const files = await page.evaluate(async () => {
    const r = indexedDB.open('droid'); await new Promise((ok) => (r.onsuccess = ok))
    const tx = r.result.transaction('files'); const keys = await new Promise((ok) => { const q = tx.objectStore('files').getAllKeys(); q.onsuccess = () => ok(q.result) })
    return keys.filter((k) => String(k).includes('download/'))
  }).catch((e) => 'idb ' + e.message)
  console.log('files', JSON.stringify(files))
  const b = await page.locator('#statusbar').boundingBox()
  await page.mouse.move(b.x + 40, b.y + 5); await page.mouse.down(); await page.mouse.move(b.x + 40, b.y + 400, { steps: 8 }); await page.mouse.up()
  await page.waitForTimeout(600)
  await shot('dl-03-shade')
  await page.locator('.note', { hasText: 'Download complete' }).click()
  await page.waitForTimeout(4000)
  await shot('dl-04-install')
}
