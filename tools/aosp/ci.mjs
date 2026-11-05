// on ci (the pages deploy) the build also makes the real android framework: tools/aosp/build.py.
// locally it is skipped unless AOSP=1 (it downloads the aosp sources the first time).
import { spawnSync } from 'node:child_process'
if (process.env.CI || process.env.AOSP) {
  const r = spawnSync('python3', ['tools/aosp/build.py', '--out', 'dist/runtime/aosp'], { stdio: 'inherit' })
  // never break the deploy over it: the runtime falls back to its own framework pieces
  if (r.status) console.warn('::warning::the aosp framework build failed (exit ' + r.status + '); deploying without it')
}
