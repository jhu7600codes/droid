// minimal zip reader (stored and deflate entries) for .dpk files.
// uses DecompressionStream('deflate-raw'), which browsers and node 22 have.

export interface ZipEntry { path: string; size: number; compressed: number; method: number; offset: number }

const u16 = (d: DataView, o: number) => d.getUint16(o, true)
const u32 = (d: DataView, o: number) => d.getUint32(o, true)

export function listZip(buf: ArrayBuffer): ZipEntry[] {
  const d = new DataView(buf)
  // end of central directory: search backwards for the signature (comment can be up to 64k)
  let eocd = -1
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (u32(d, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('invalid: not a zip file')
  const count = u16(d, eocd + 10)
  let p = u32(d, eocd + 16)
  const out: ZipEntry[] = []
  const dec = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (u32(d, p) !== 0x02014b50) throw new Error('invalid: bad central directory')
    const method = u16(d, p + 10)
    const compressed = u32(d, p + 20)
    const size = u32(d, p + 24)
    const nameLen = u16(d, p + 28), extraLen = u16(d, p + 30), commentLen = u16(d, p + 32)
    const offset = u32(d, p + 42)
    const path = dec.decode(new Uint8Array(buf, p + 46, nameLen))
    if (!path.endsWith('/')) out.push({ path, size, compressed, method, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

export async function readEntry(buf: ArrayBuffer, e: ZipEntry): Promise<Uint8Array> {
  const d = new DataView(buf)
  if (u32(d, e.offset) !== 0x04034b50) throw new Error('invalid: bad local header')
  const start = e.offset + 30 + u16(d, e.offset + 26) + u16(d, e.offset + 28)
  const raw = new Uint8Array(buf, start, e.compressed)
  if (e.method === 0) return raw.slice()
  if (e.method !== 8) throw new Error(`unsupported: zip method ${e.method}`)
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
