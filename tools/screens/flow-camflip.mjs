// camera: switch to the front camera (and back, and fast double taps): the preview keeps running
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { if (/camera|error/i.test(m.text())) console.log('console:', m.text().slice(0, 200)) })
  await page.context().grantPermissions(['camera', 'microphone']).catch(() => {})
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => window.droid_shell.wm.start({ package: 'droid.camera', action: 'main' }))
  await page.waitForTimeout(2500)
  const live = () => page.evaluate(() => { const v = document.querySelector('.window.visible video'); return v ? `${v.videoWidth}x${v.videoHeight} ${v.srcObject?.active ? 'live' : 'dead'}` : 'no video' })
  console.log('back:', await live())
  await page.click('.window.visible .cam-flip'); await page.waitForTimeout(1500)
  console.log('front:', await live())
  await page.click('.window.visible .cam-flip'); await page.click('.window.visible .cam-flip'); await page.click('.window.visible .cam-flip')
  await page.waitForTimeout(2000)
  console.log('after fast taps:', await live(), 'dialog:', await page.locator('#overlay').innerText().catch(() => ''))
  await shot('camflip')
}
