import { defineConfig } from 'vite'
import { cpSync } from 'node:fs'
import { resolve } from 'node:path'

// relative base so it works on github pages under /<repo>/ and anywhere else.
// assets/ (aosp import output, logos) is copied as-is, not bundled.
export default defineConfig({
  base: './',
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
      name: 'copy-static-assets',
      closeBundle() {
        cpSync(resolve(__dirname, 'assets'), resolve(__dirname, 'dist/assets'), { recursive: true })
      },
    },
  ],
})
