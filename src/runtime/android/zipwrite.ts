// small zip writer (deflate via CompressionStream), works in browsers and node 22
const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
async function deflate(b: Uint8Array) { return new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()) }

export async function writeZip(files: Map<string, Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [], central: Uint8Array[] = []
  let off = 0
  for (const [path, data] of files) {
    const name = new TextEncoder().encode(path)
    const store = /\.(png|jpe?g|ogg|mp3|so|zip)$/i.test(path)
    const body = store ? data : await deflate(data)
    const crc = crc32(data)
    const h = new DataView(new ArrayBuffer(30))
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, store ? 0 : 8, true); h.setUint16(12, 0x21, true)
    h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true)
    parts.push(new Uint8Array(h.buffer), name, body)
    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, store ? 0 : 8, true); c.setUint16(14, 0x21, true)
    c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true)
    central.push(new Uint8Array(c.buffer), name)
    off += 30 + name.length + body.length
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0)
  const e = new DataView(new ArrayBuffer(22))
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.size, true); e.setUint16(10, files.size, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true)
  const all = [...parts, ...central, new Uint8Array(e.buffer)]
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0))
  let p = 0
  for (const b of all) { out.set(b, p); p += b.length }
  return out
}
