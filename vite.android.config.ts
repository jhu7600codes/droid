// builds the android runtime that goes inside every converted dpk (public/runtime/android-runtime.js)
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public/runtime', emptyOutDir: false, minify: process.env.NOMINIFY ? false : true,
    lib: { entry: resolve(__dirname, 'src/runtime/android/entry.ts'), formats: ['iife'], name: 'droidAndroid', fileName: () => 'android-runtime.js' },
  },
})
