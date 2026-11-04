// every app, one screenshot each, in the form given by FORM (phone | tablet | desktop)
const FORM = process.env.FORM || 'phone'
const APPS = [
  ['home', null], ['allapps', null], ['quick-settings', null], ['recents', null],
  ['settings', { package: 'droid.settings', action: 'main' }], ['wifi', { action: 'networks', extras: { page: 'wifi' } }],
  ['camera', { package: 'droid.camera', action: 'main' }], ['gallery', { package: 'droid.gallery', action: 'main' }],
  ['files', { package: 'droid.files', action: 'main' }], ['browser', { package: 'droid.browser', action: 'main' }],
  ['clock', { package: 'droid.deskclock', action: 'main' }], ['calculator', { package: 'droid.calculator', action: 'main' }],
  ['store', { package: 'droid.store', action: 'main' }], ['danen-account', { action: 'danen-account' }],
  ['wallpapers', { action: 'set-wallpaper' }], ['hello', { package: 'com.droid.hello', action: 'main' }],
  ['notes', { package: 'com.droid.notes', action: 'main' }], ['wasm-demo', { package: 'com.droid.wasmdemo', action: 'main' }],
  ['hello-jni-apk', 'apk-test/test.apk'], ['kotlin-apk', 'apk-test/test-kt.apk'], ['lockscreen', null],
]
export default async ({ page, shot, base }) => {
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate((f) => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none', 'screen.form': f, 'location.pretend': { lat: 55.7558, lon: 37.6173 }, 'net.saved': ['jhfi'], 'owner.name': 'jhu' })), FORM)
  await page.reload()
  await page.waitForTimeout(3000)
  const clean = () => page.evaluate(() => { const w = window.droid_shell.wm; for (const t of [...w.tasks]) if (!t.home) w.removeTask(t); w.home() })
  let i = 0
  for (const [name, target] of APPS) {
    const n = String(++i).padStart(2, '0') + '-' + name
    await clean(); await page.waitForTimeout(300)
    if (name === 'home') { await shot(n); continue }
    if (name === 'allapps') { await page.evaluate(() => document.dispatchEvent(new Event('droid:startmenu'))); if (FORM !== 'desktop') await page.click('.allapps').catch(() => {}); await page.waitForTimeout(400); await shot(n); await page.keyboard.press('Escape'); continue }
    if (name === 'quick-settings') {
      if (FORM === 'desktop') await page.click('.tb-tray')
      else { const b = await page.locator('#statusbar').boundingBox(); await page.mouse.move(b.x + b.width * 0.9, b.y + 5); await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.9, b.y + 500, { steps: 8 }); await page.mouse.up() }
      await page.waitForTimeout(500); await shot(n); await page.evaluate(() => window.droid_shell.wm.back()); continue
    }
    if (name === 'recents') {
      for (const p of ['droid.settings', 'droid.calculator', 'droid.deskclock']) { await page.evaluate((p) => { window.droid_shell.wm.start({ package: p, action: 'main' }) }, p); await page.waitForTimeout(500) }
      await page.evaluate(() => document.querySelector('.nav-recent, .tb-nav[title="Task view"]')?.click())
      await page.waitForTimeout(500); await shot(n); await page.evaluate(() => window.droid_shell.wm.back()); continue
    }
    if (name === 'lockscreen') { await page.evaluate(() => { const s = window.droid_shell.settings; s.set('lock.type', 'slide') }); await page.evaluate(() => import('./app/x.js').catch(() => {})); await page.reload(); await page.waitForTimeout(3500); await shot(n); continue }
    if (typeof target === 'string') {
      await page.evaluate((u) => { window.droid_shell.wm.start({ action: 'install', data: u, type: 'application/vnd.android.package-archive' }) }, target)
      await page.waitForTimeout(2500)
      await page.click('.pi-buttons .h-btn-borderless:last-child').catch(() => {})
      await page.waitForTimeout(1500)
      await page.click('.pi-buttons .h-btn-borderless:last-child').catch(() => {})
      await page.waitForTimeout(3000); await shot(n); continue
    }
    await page.evaluate((t) => { window.droid_shell.wm.start(t) }, target)
    await page.waitForTimeout(name === 'store' || name === 'camera' ? 2200 : 1300)
    await shot(n)
  }
}
