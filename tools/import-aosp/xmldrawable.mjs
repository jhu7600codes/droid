// turns android xml drawables (and color state lists) into plain json trees.
// the css generator and the runtime both read this json, nobody reads the xml again.
import { XMLParser } from 'fast-xml-parser'

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  ignoreDeclaration: true,
  commentPropName: false,
})

// "android:state_pressed" -> "state_pressed", drop xmlns
function attrs(raw = {}) {
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('xmlns')) continue
    out[k.replace(/^android:/, '')] = v
  }
  return out
}

function node(entry) {
  const tag = Object.keys(entry).find((k) => k !== ':@')
  if (!tag || tag === '#text') return null
  const children = (entry[tag] || []).map(node).filter(Boolean)
  const n = { tag, ...attrs(entry[':@']) }
  if (children.length) n.children = children
  return n
}

export function parseXmlDrawable(text) {
  const doc = parser.parse(text)
  const root = doc.map(node).find(Boolean)
  return root
}

// values need text content, so they use their own small parse
const vparser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: () => true, textNodeName: '_t' })
export function parseValuesFile(text) {
  const doc = vparser.parse(text)
  const res = doc.resources?.[0] || {}
  const out = {}
  const take = (kind, list) => {
    for (const it of list || []) {
      if (typeof it !== 'object' || !it.name) continue
      const v = it._t ?? it['#text']
      if (v == null) continue
      ;(out[kind] ||= {})[it.name] = String(Array.isArray(v) ? v[0] : v).trim()
    }
  }
  take('color', res.color)
  take('dimen', res.dimen)
  take('integer', res.integer)
  take('bool', res.bool)
  for (const it of res.item || []) {
    if (it && ['color', 'dimen', 'integer', 'bool'].includes(it.type)) take(it.type, [it])
  }
  return out
}
