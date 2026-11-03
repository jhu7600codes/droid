// css generator: turns the imported drawables (json) into one stylesheet per density bucket.
// what gets generated is decided by components.json (css selector -> android drawable).
//
// units: in droid 1 css px = 1 dp. an image made for density D is drawn at size * 160 / D.
// selectors keep android's "first matching item wins" rule: every state rule has the same
// specificity (states go inside :where()) and rules are written last item first.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ORDER = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi']

const num = (n) => +n.toFixed(3) + 'px'

export function buildCss(out, DENSITIES) {
  const pkgs = {}
  const dirs = ['framework', 'systemui', 'keyguard', ...(fs.existsSync(path.join(out, 'apps')) ? fs.readdirSync(path.join(out, 'apps')).map((a) => 'apps/' + a) : [])]
  for (const p of dirs) {
    const f = path.join(out, p, 'drawables.json')
    if (fs.existsSync(f)) pkgs[p] = JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  const components = JSON.parse(fs.readFileSync(path.join(here, 'components.json'), 'utf8'))
  const warn = new Set()

  // ---------- references ----------
  function parseRef(ref, pkg) {
    const m = String(ref).match(/^@\*?(?:(android):)?(\w+)\/(\w+)$/)
    if (!m) return null
    return { pkg: m[1] ? 'framework' : pkg, type: m[2], name: m[3] }
  }

  function color(v, pkg, depth = 0) {
    if (v == null || depth > 10) return null
    v = String(v).trim()
    if (v.startsWith('#')) {
      let h = v.slice(1)
      if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
      let a = 255
      if (h.length === 8) { a = parseInt(h.slice(0, 2), 16); h = h.slice(2) }
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
      return a === 255 ? `#${h.toLowerCase()}` : `rgba(${r},${g},${b},${+(a / 255).toFixed(3)})`
    }
    const r = parseRef(v, pkg)
    if (!r) return null
    const P = pkgs[r.pkg]
    if (!P) return null
    if (P.values.color?.[r.name] != null) return color(P.values.color[r.name], r.pkg, depth + 1)
    const csl = P.colors[r.name]
    if (csl) { // color state list: use the default (last stateless) item
      const items = (csl.children || []).filter((c) => c.tag === 'item')
      const def = items.find((c) => !Object.keys(c).some((k) => k.startsWith('state_'))) || items[items.length - 1]
      return def ? color(def.color, r.pkg, depth + 1) : null
    }
    if (r.type === 'drawable' && P.values.color?.[r.name]) return color(P.values.color[r.name], r.pkg, depth + 1)
    return null
  }

  function pickBucket(avail, bucket) {
    if (avail[bucket]) return bucket
    const i = ORDER.indexOf(bucket)
    for (let j = i + 1; j < ORDER.length; j++) if (avail[ORDER[j]]) return ORDER[j]
    for (let j = i - 1; j >= 0; j--) if (avail[ORDER[j]]) return ORDER[j]
    if (avail.any) return 'any'
    if (avail.nodpi) return 'nodpi'
    return null
  }
  const dpiOf = (b, target) => (b === 'any' ? 160 : b === 'nodpi' ? DENSITIES[target] : DENSITIES[b])
  const url = (pkg, kind, b, name, ext = 'png') => `url(../${pkg}/${kind}-${b}/${name}.${ext})`

  // returns { css: {prop: value}, size: [w,h] in dp, nine: bool } or null
  function drawable(ref, pkg, bucket, depth = 0) {
    if (depth > 8 || ref == null) return null
    if (String(ref).startsWith('#')) return { css: { 'background-color': color(ref, pkg) } }
    const r = parseRef(ref, pkg)
    if (!r) return null
    const P = pkgs[r.pkg]
    if (!P) return null
    if (r.type === 'color') { const c = color(ref, pkg); return c ? { css: { 'background-color': c } } : null }
    if (r.type === 'mipmap' || r.type === 'drawable') {
      if (P.ninepatch[r.name]) {
        const b = pickBucket(P.ninepatch[r.name], bucket)
        const m = P.ninepatch[r.name][b]
        const s = 160 / dpiOf(b, bucket)
        const sx = m.sx.length ? [m.sx[0][0], m.w - m.sx[m.sx.length - 1][1]] : [0, 0]
        const sy = m.sy.length ? [m.sy[0][0], m.h - m.sy[m.sy.length - 1][1]] : [0, 0]
        const slice = [sy[0], sx[1], sy[1], sx[0]]
        return {
          nine: true,
          multi: m.sx.length > 1 || m.sy.length > 1,
          size: [m.w * s, m.h * s],
          pad: m.pad.map((p) => p * s), // l t r b
          css: {
            'border-image-source': url(r.pkg, 'drawable', b, r.name),
            'border-image-slice': slice.join(' ') + ' fill',
            'border-image-width': slice.map((v) => num(v * s)).join(' '),
          },
        }
      }
      const imgs = P.images[r.name]
      if (imgs) {
        const kind = 'drawable'
        const b = pickBucket(imgs, bucket)
        const { ext, size } = imgs[b]
        const s = 160 / dpiOf(b, bucket)
        const sz = size ? [size[0] * s, size[1] * s] : null
        return {
          size: sz,
          css: {
            'background-image': url(r.pkg, kind, b, r.name, ext),
            'background-size': sz ? `${num(sz[0])} ${num(sz[1])}` : 'contain',
            'background-repeat': 'no-repeat',
            'background-position': 'center',
          },
        }
      }
      const x = P.xml[r.name]
      if (x) return xmlNode(x, r.pkg, bucket, depth + 1, r.name)
      if (P.values.color?.[r.name]) return { css: { 'background-color': color(P.values.color[r.name], r.pkg) } }
    }
    warn.add(`missing ${ref}`)
    return null
  }

  function xmlNode(x, pkg, bucket, depth, name) {
    const child = (tag) => (x.children || []).find((c) => c.tag === tag)
    switch (x.tag) {
      case 'bitmap':
      case 'nine-patch':
        return drawable(x.src, pkg, bucket, depth)
      case 'color':
        return { css: { 'background-color': color(x.color, pkg) } }
      case 'inset':
      case 'clip':
      case 'scale':
      case 'rotate':
        return x.drawable ? drawable(x.drawable, pkg, bucket, depth) : x.children?.[0] ? xmlNode(x.children[0], pkg, bucket, depth + 1) : null
      case 'selector': {
        const it = defaultItem(x)
        return it ? itemDrawable(it, pkg, bucket, depth) : null
      }
      case 'transition':
      case 'animation-list':
      case 'level-list': {
        const it = (x.children || []).find((c) => c.tag === 'item')
        return it ? itemDrawable(it, pkg, bucket, depth) : null
      }
      case 'layer-list': {
        // css can only do one border-image, so: backgrounds stack, the first 9-patch becomes the border-image
        const layers = (x.children || []).filter((c) => c.tag === 'item').map((it) => itemDrawable(it, pkg, bucket, depth)).filter(Boolean)
        if (!layers.length) return null
        const nine = layers.find((l) => l.nine)
        const bg = layers.filter((l) => !l.nine && l.css['background-image']).reverse()
        const col = layers.find((l) => l.css['background-color'])
        const css = { ...(nine?.css || {}) }
        if (bg.length) for (const k of ['background-image', 'background-size', 'background-repeat', 'background-position']) css[k] = bg.map((l) => l.css[k]).join(', ')
        if (col) css['background-color'] = col.css['background-color']
        return { ...(nine || {}), css, size: nine?.size || layers.find((l) => l.size)?.size }
      }
      case 'shape': {
        const css = {}
        const solid = child('solid'), stroke = child('stroke'), corners = child('corners'), grad = child('gradient'), size = child('size')
        if (solid) css['background-color'] = color(solid.color, pkg)
        if (grad) {
          const a = color(grad.startColor, pkg), e = color(grad.endColor, pkg), c = grad.centerColor ? color(grad.centerColor, pkg) : null
          const angle = 90 - (+grad.angle || 0) // android 0 = left to right, css 90deg = left to right
          css['background-image'] = `linear-gradient(${angle}deg, ${[a, c, e].filter(Boolean).join(', ')})`
        }
        if (stroke) css['box-shadow'] = `inset 0 0 0 ${dp(stroke.width)} ${color(stroke.color, pkg)}`
        if (corners?.radius) css['border-radius'] = dp(corners.radius)
        if (x.shape === 'oval') css['border-radius'] = '50%'
        return { css, size: size ? [parseFloat(size.width) || 0, parseFloat(size.height) || 0] : null }
      }
      default:
        warn.add(`unsupported <${x.tag}> in ${name || '?'}`)
        return null
    }
  }

  function dp(v) {
    const n = parseFloat(String(v))
    return isNaN(n) ? '0px' : num(n)
  }

  function itemDrawable(it, pkg, bucket, depth) {
    if (it.drawable) return drawable(it.drawable, pkg, bucket, depth)
    if (it.children?.[0]) return xmlNode(it.children[0], pkg, bucket, depth + 1)
    return null
  }

  const isState = (k) => k.startsWith('state_')
  function defaultItem(sel) {
    const items = (sel.children || []).filter((c) => c.tag === 'item')
    return items.find((c) => !Object.keys(c).some(isState)) || items[items.length - 1]
  }

  // ---------- states ----------
  // android state -> [css when true, css when false]. host = state lives on an ancestor with an <input>
  function stateCss(k, v, host) {
    const on = v === 'true'
    const T = {
      state_pressed: [':active', '.pressed'],
      state_enabled: host ? [':has(input:disabled)', '.disabled'] : [':disabled', '.disabled'],
      state_focused: host ? [':has(input:focus-visible)', '.focused'] : [':focus-visible', '.focused'],
      state_checked: host ? [':has(input:checked)', '.checked'] : [':checked', '.checked', '[aria-checked="true"]'],
      state_selected: ['.selected', '[aria-selected="true"]'],
      state_activated: ['.activated'],
    }[k]
    if (k === 'state_window_focused') return on ? '' : null // the window is always focused: false never matches
    if (!T) return on ? null : '' // unknown state: never true
    const enabledFlip = k === 'state_enabled' // enabled=true means "not disabled"
    const positive = enabledFlip ? !on : on
    return positive ? `:where(${T.join(', ')})` : `:where(${T.map((t) => `:not(${t})`).join('')})`
  }

  function rulesFor(comp, bucket) {
    const prefix = comp.theme ? `.holo-${comp.theme} ` : ''
    const P = comp.pkg || 'framework'
    const rules = []
    const ref = comp.drawable ? `@drawable/${comp.drawable}` : `@color/${comp.color}`
    const r = parseRef(ref, P)
    const x = comp.drawable ? pkgs[r.pkg]?.xml[r.name] : pkgs[r.pkg]?.colors[r.name]
    const target = (conds) => (comp.host ? `${prefix}${comp.host}${conds} ${comp.part}` : `${prefix}${comp.sel}${conds}`)
    const selectorOf = comp.host ? `${comp.host} ${comp.part}` : comp.sel

    if (comp.color) { // text color state list -> color per state
      const items = x?.tag === 'selector' ? x.children.filter((c) => c.tag === 'item') : null
      if (!items) { const c = color(ref, P); if (c) rules.push(`${prefix}${selectorOf} { color: ${c}; }`); return rules }
      for (const it of [...items].reverse()) {
        const conds = Object.entries(it).filter(([k]) => isState(k)).map(([k, v]) => stateCss(k, v, comp.host))
        if (conds.includes(null)) continue
        const c = color(it.color, r.pkg)
        if (c) rules.push(`${target(conds.join(''))} { color: ${c}; }`)
      }
      return rules
    }

    const base = (d) => {
      const css = {
        'background-color': 'transparent', 'background-image': 'none', 'border-image-source': 'none',
        ...d.css,
      }
      if (d.nine && comp.padding !== false) { const [l, t, rr, b] = d.pad; css.padding = [t, rr, b, l].map(num).join(' ') }
      return css
    }
    const fmt = (css) => Object.entries(css).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v};`).join(' ')

    const sel = x?.tag === 'selector' ? x : null
    const def = sel ? itemDrawable(defaultItem(sel), r.pkg, bucket, 0) : drawable(ref, P, bucket)
    if (!def) { warn.add(`nothing for ${comp.sel || comp.part}`); return rules }

    // shared part: border so border-image paints, intrinsic size
    const shared = { 'border-style': 'solid', 'border-width': '0', 'border-color': 'transparent', 'border-image-repeat': 'stretch' }
    if (comp.size && def.size) { shared.width = num(def.size[0]); shared.height = num(def.size[1]) }
    if (comp.minsize && def.size) { shared['min-width'] = num(def.size[0]); shared['min-height'] = num(def.size[1]) }
    if (def.multi) shared['--ninepatch'] = `'${comp.drawable}'`
    rules.push(`${prefix}${selectorOf} { ${fmt(shared)} }`)

    if (!sel) { rules.push(`${prefix}${selectorOf} { ${fmt(base(def))} }`); return rules }
    const items = sel.children.filter((c) => c.tag === 'item')
    for (const it of [...items].reverse()) {
      const conds = Object.entries(it).filter(([k]) => isState(k)).map(([k, v]) => stateCss(k, v, comp.host))
      if (conds.includes(null)) continue
      const d = itemDrawable(it, r.pkg, bucket, 0)
      if (!d) continue
      rules.push(`${target(conds.join(''))} { ${fmt(base(d))} }`)
    }
    return rules
  }

  fs.mkdirSync(path.join(out, 'css'), { recursive: true })
  for (const bucket of ORDER) {
    const lines = [`/* generated by tools/import-aosp from aosp ${'android-4.4.4_r2'} (apache 2.0). do not edit. density ${bucket} */`]
    for (const comp of components) lines.push(...rulesFor(comp, bucket))
    fs.writeFileSync(path.join(out, 'css', `holo-${bucket}.css`), lines.join('\n') + '\n')
  }

  // colors as css variables (density independent)
  const F = pkgs.framework
  const vars = Object.keys(F.values.color || {}).filter((n) => /holo|^(white|black|transparent)$|background_|bright_foreground|dim_foreground|highlighted_text/.test(n))
  const tok = vars.map((n) => `  --c-${n.replace(/_/g, '-')}: ${color('@color/' + n, 'framework')};`).filter((l) => !l.includes('null'))
  fs.writeFileSync(path.join(out, 'css', 'colors.css'), `/* generated: aosp framework colors (apache 2.0) */\n:root {\n${tok.join('\n')}\n}\n`)
  // the multi-region 9-patch metadata, for the canvas renderer
  const nine = {}
  for (const [p, P] of Object.entries(pkgs)) for (const [n, m] of Object.entries(P.ninepatch)) nine[`${p}/${n}`] = m
  fs.writeFileSync(path.join(out, 'ninepatch.json'), JSON.stringify(nine))
  // small image index for the runtime: "pkg/name" -> "ext:bucket,bucket" (9-patches marked with 9)
  const index = {}
  for (const [p, P] of Object.entries(pkgs)) {
    for (const [n, m] of Object.entries(P.images)) { const b = Object.keys(m); index[`${p}/${n}`] = `${m[b[0]].ext}:${b.join(',')}` }
    for (const [n, m] of Object.entries(P.ninepatch)) index[`${p}/${n}`] = `9:${Object.keys(m).join(',')}`
  }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index))
  if (warn.size) console.log('css warnings:\n  ' + [...warn].join('\n  '))
}

// allow running alone: node tools/import-aosp/css.mjs
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { DENSITIES } = await import('./sources.mjs')
  buildCss(path.resolve(here, '../../assets/aosp'), DENSITIES)
  console.log('css rebuilt')
}
