import { defineConfig } from 'vite'
import { cpSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

// relative base so it works on github pages under /<repo>/ and anywhere else.
// assets/ (aosp import output, logos) is copied as-is, not bundled.
// after the build: sw.js gets the version and shell file list, precache.json lists everything
// for the offline download screen.
const dist = resolve(__dirname, 'dist')

function walk(dir: string, out: string[] = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    statSync(p).isDirectory() ? walk(p, out) : out.push(p)
  }
  return out
}

// one number per build: baked into the app (BUILD) and written to version.json
const version = new Date().toISOString().replace(/\D/g, '').slice(0, 14)

export default defineConfig({
  base: './',
  define: { __DROID_BUILD__: JSON.stringify(version) },
  publicDir: false,
  build: {
    assetsDir: 'app',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        holo: resolve(__dirname, 'holo-test.html'),
      },
    },
  },
  plugins: [
    {
      name: 'droid-static',
      apply: 'build',
      closeBundle() {
        cpSync(resolve(__dirname, 'assets'), join(dist, 'assets'), { recursive: true })
        cpSync(resolve(__dirname, 'public'), dist, { recursive: true })
        for (const f of ['LICENSE', 'NOTICE', 'LICENSE-APACHE-2.0']) cpSync(resolve(__dirname, f), join(dist, 'legal', f))
        const files = walk(dist).map((p) => relative(dist, p).split('\\').join('/'))
        const shell = files.filter((f) => /^(index\.html|manifest\.webmanifest|app\/|assets\/brand\/|assets\/aosp\/(css|fonts)\/|assets\/aosp\/[^/]+\.json$|icons\/)/.test(f))
        const sw = readFileSync(resolve(__dirname, 'src/sw.js'), 'utf8')
        writeFileSync(join(dist, 'sw.js'), sw.replace('__VERSION__', version).replace("'__SHELL__'", JSON.stringify(JSON.stringify(['./', ...shell]))))
        const precache = files.filter((f) => f.startsWith('assets/') || f.startsWith('apps/') || f.startsWith('examples/')).map((p) => {
          const full = /wallpapers_basic|default_wallpaper|\/sounds\/|^examples\//.test(p)
          const b = p.match(/drawable-(\w+)\//)?.[1]
          return { p, s: statSync(join(dist, p)).size, g: full ? 'full' : 'essential', ...(b ? { b } : {}) }
        })
        writeFileSync(join(dist, 'precache.json'), JSON.stringify(precache))
        writeFileSync(join(dist, 'version.json'), JSON.stringify({ version, droid: '4.4', api: 19 }))
      },
    },
  ],
})
