// packs every folder in examples/ and games/ into public/<that>/<name>.dpk (run before the build)
import { readdirSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
// examples/ -> public/examples, games/ -> public/games, vte/ (carrier apps) -> public/vte (the store lists them)
execFileSync(process.execPath, ['tools/pack-dpk/vte-apps.mjs'], { stdio: 'inherit' })
for (const [src, out] of [['examples', 'public/examples'], ['games', 'public/games'], ['vte', 'public/vte']]) {
  if (!existsSync(src)) continue
  mkdirSync(out, { recursive: true })
  for (const d of readdirSync(src)) {
    if (!existsSync(`${src}/${d}/manifest.json`)) continue
    execFileSync(process.execPath, ['tools/pack-dpk/pack.mjs', `${src}/${d}`, `${out}/${d}.dpk`, '--integrity'], { stdio: 'inherit' })
  }
}
