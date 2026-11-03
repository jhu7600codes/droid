// tiny zip reader for node (store checks)
import zlib from 'node:zlib'
export function listZipNode(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a zip')
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24)
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nl)
    if (!name.endsWith('/')) out.push({ path: name, method, comp, size, off })
    p += 46 + nl + el + cl
  }
  return out
}
export function readEntryNode(buf, e) {
  const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28)
  const raw = buf.subarray(start, start + e.comp)
  return e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)
}
