// packs every folder in examples/ into public/examples/<name>.dpk (run before the build)
import { readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
for (const d of readdirSync('examples')) {
  if (!existsSync(`examples/${d}/manifest.json`)) continue
  execFileSync(process.execPath, ['tools/pack-dpk/pack.mjs', `examples/${d}`, `public/examples/${d}.dpk`, '--integrity'], { stdio: 'inherit' })
}
