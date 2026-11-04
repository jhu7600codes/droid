// local only: run ss.apk and profile the page while it runs; prints the hottest functions
import ss from './flow-ss.mjs'
export default async (ctx) => {
  const { page } = ctx
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
  page.on('console', async (m) => {
    if (!/Creating OpenGL/.test(m.text())) return
    setTimeout(() => cdp.send('Profiler.start'), Number(process.env.PROF_DELAY || 0))
    setTimeout(async () => {
      const { profile } = await cdp.send('Profiler.stop')
      const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]))
      const counts = new Map(); for (const s of profile.samples) counts.set(s, (counts.get(s) || 0) + 1)
      for (const [id, c] of counts) { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.slice(-30)}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + c) }
      const tot = profile.samples.length
      console.log('PROFILE total', tot); for (const [k, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${(100 * c / tot).toFixed(1)}% ${k}`)
    }, Number(process.env.PROF_DELAY || 0) + Number(process.env.PROF_MS || 8000))
  })
  process.env.RUN_MS ||= '15000'
  await ss({ ...ctx, shot: async () => {} }).catch((e) => console.log('flow err', e.message.slice(0, 100)))
}
