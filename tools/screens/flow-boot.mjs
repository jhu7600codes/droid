// boot intros: frames of the field intro (the d falls, the flock leaves) and the lens intro
export default async ({ page, shot, base }) => {
  for (const anim of ['field', 'lens']) {
    await page.goto(base + 'index.html?bootanim=' + anim)
    const t0 = Date.now()
    const at = anim === 'field' ? [1.6, 2.15, 2.5, 3.1, 4.4, 7.2, 8.4] : [0.8, 1.4, 2.2, 2.9, 4.0]
    for (const t of at) { const w = t * 1000 - (Date.now() - t0); if (w > 0) await page.waitForTimeout(w); await page.screenshot({ path: `${process.argv[2]}/${anim}-${t}.png` }) }
    console.log('shot', anim)
  }
}
