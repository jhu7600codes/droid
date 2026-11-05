// desktop unlock: drag the glowpad handle to the unlock target with a mouse
export default async ({ page, shot, base }) => {
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'swipe' })))
  await page.reload(); await page.waitForTimeout(3000)
  await page.evaluate(() => window.droid_shell?.lockscreen?.lock?.())
  await page.waitForTimeout(800)
  await shot('lock-00')
  const hd = page.locator('.gp-handle')
  console.log('handle visible', await hd.isVisible().catch(() => false), 'form', await page.evaluate(() => document.querySelector('#screen')?.dataset.form))
  const b = await hd.boundingBox()
  console.log('box', JSON.stringify(b))
  const top = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '.' + e.className : null }, [b.x + b.width / 2, b.y + b.height / 2])
  console.log('top element at handle:', top)
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2
  await page.mouse.move(cx, cy); await page.mouse.down()
  for (let i = 1; i <= 20; i++) { await page.mouse.move(cx + i * 6, cy); await page.waitForTimeout(16) }
  await shot('lock-01-drag')
  await page.mouse.up(); await page.waitForTimeout(800)
  console.log('locked after:', await page.evaluate(() => document.querySelector('#screen')?.classList.contains('locked')))
  await shot('lock-02-after')
  await taskbar({ page, shot })
  await clickAndKey({ page })
}
export const taskbar = async ({ page, shot }) => {
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden }); await page.waitForTimeout(600)
  const top = await page.evaluate(() => { const e = document.elementFromPoint(114, 878); return e ? e.tagName + '.' + e.className + ' in ' + e.closest('[id]')?.id : null })
  console.log('top element at taskbar home while locked:', top, 'locked before:', await page.evaluate(() => document.querySelector('#screen')?.classList.contains('locked')))
  await page.mouse.click(158, 878); await page.waitForTimeout(800)
  console.log('locked after taskbar click:', await page.evaluate(() => document.querySelector('#screen')?.classList.contains('locked')))
  await shot('lock-03-taskbar')
}
export const clickAndKey = async ({ page }) => {
  const relock = () => page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden })
  const isLocked = () => page.evaluate(() => document.querySelector('#screen')?.classList.contains('locked'))
  await relock(); await page.waitForTimeout(600)
  await page.click('.gp-handle'); await page.waitForTimeout(500)
  console.log('locked after click:', await isLocked())
  await relock(); await page.waitForTimeout(600)
  await page.keyboard.press('Enter'); await page.waitForTimeout(500)
  console.log('locked after enter:', await isLocked())
}
