// the five VTE carrier apps share vte/app.js and take their icons from src/shell/vte-logos.ts:
// copies both into vte/<carrier>/ and store/apps/<id>/ (run before packing; examples.mjs calls it)
import fs from 'node:fs'
import { LOGOS } from '../../src/shell/vte-logos.ts'
for (const id of Object.keys(LOGOS)) {
  const dir = `vte/${id}`
  if (!fs.existsSync(dir + '/manifest.json')) continue
  fs.copyFileSync('vte/app.js', dir + '/app.js')
  fs.writeFileSync(dir + '/icon.svg', LOGOS[id] + '\n')
  const pkg = JSON.parse(fs.readFileSync(dir + '/manifest.json', 'utf8')).id
  if (fs.existsSync(`store/apps/${pkg}`)) fs.writeFileSync(`store/apps/${pkg}/icon.svg`, LOGOS[id] + '\n')
}
