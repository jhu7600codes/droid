// asset file descriptors: AssetManager.openFd() gives a java FileDescriptor whose number points at the
// asset's bytes here (android maps the apk; droid keeps the bytes). SoundPool and MediaPlayer read them.
const byFd = new Map<number, Uint8Array>()
let nextFd = 1000

export function fdFor(bytes: Uint8Array): number { const fd = nextFd++; byFd.set(fd, bytes); return fd }
// the bytes behind a java FileDescriptor object (or a raw fd number), if it is an asset's
export function fdBytes(fd: any): Uint8Array | null {
  const n = typeof fd === 'number' ? fd : fd?.f?.descriptor
  return typeof n === 'number' ? byFd.get(n) ?? null : null
}
export function fdClose(n: number) { byFd.delete(n) }
