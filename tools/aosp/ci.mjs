// on ci (the pages deploy) the build also makes the real android framework: tools/aosp/build.py.
// locally it is skipped unless AOSP=1 (it downloads the aosp sources the first time).
import { spawnSync } from 'node:child_process'
if (process.env.CI || process.env.AOSP) {
  const r = spawnSync('python3', ['tools/aosp/build.py', '--out', 'dist/runtime/aosp'], { stdio: 'inherit' })
  if (r.status) process.exit(r.status)
}
