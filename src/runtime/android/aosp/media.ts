// android.media.MediaPlayer on a browser <video>: android's own MediaPlayer/VideoView code runs,
// the decoding and drawing are the browser's. the video sits over the SurfaceView's window.
import type { VM, JObject, JMethod } from '../dalvik.ts'
import { jstr } from '../java.ts'
import type { Vfs } from '../javaio.ts'
import { fdBytes } from './fds.ts'

export interface MediaHost {
  later: (m: JMethod, self: JObject | null, args: any[]) => void
  windowOf: (surfaceObj: number) => number | null
  // show (window id) or hide (null) a player's element
  show?: (el: HTMLVideoElement, window: number | null) => void
  // a url the element can load (droid's proxy for http on an https page)
  mediaUrl?: (url: string) => Promise<string>
}

interface P { el: HTMLVideoElement | null; ref: any; prepared: boolean; failed: boolean; url: string; blob: string; loading?: boolean; wantPlay?: boolean }

export function registerAospMedia(vm: VM, vfs: Vfs, host: MediaHost) {
  const players = new Map<number, P>()
  let nextH = 1
  const P = (s: JObject) => players.get(s.f.mNativeContext)
  const MP = 'Landroid/media/MediaPlayer;'
  let postM: JMethod | null = null
  const post = (p: P, what: number, a1 = 0, a2 = 0) => {
    postM ??= vm.findMethod(vm.cls(MP), 'postEventFromNative(Ljava/lang/Object;IIILjava/lang/Object;)V')
    if (postM && p.ref) host.later(postM, null, [p.ref, what, a1, a2, null])
  }
  const make = (p: P) => {
    if (p.el || typeof document === 'undefined') return p.el
    const el = document.createElement('video')
    el.playsInline = true; el.preload = 'auto'
    el.setAttribute('playsinline', '')
    el.style.cssText = 'position:absolute;pointer-events:none;background:#000;object-fit:contain;display:none'
    el.addEventListener('loadedmetadata', () => { if (p.prepared) return; p.prepared = true; post(p, 5, el.videoWidth, el.videoHeight); post(p, 1) })
    el.addEventListener('ended', () => { if (!el.loop) post(p, 2) })
    el.addEventListener('seeked', () => post(p, 4))
    el.addEventListener('progress', () => { try { if (el.duration) post(p, 3, Math.round((el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0) / el.duration * 100)) } catch { /* not yet */ } })
    el.addEventListener('waiting', () => post(p, 200, 701))
    el.addEventListener('playing', () => post(p, 200, 702))
    el.addEventListener('error', () => { p.failed = true; post(p, 100, 1, -1004) })
    return (p.el = el)
  }
  const source = (p: P, path: string) => {
    if (p.blob) { URL.revokeObjectURL(p.blob); p.blob = '' }
    // files the app wrote (or its assets copied out): a blob; everything else as is
    if (!/^[a-z]+:/i.test(path) || path.startsWith('file:')) {
      const b = vfs.read(path.replace(/^file:\/\//, ''))
      if (b && typeof Blob !== 'undefined') { p.blob = URL.createObjectURL(new Blob([b.slice()])); path = p.blob }
    }
    p.url = path; p.prepared = false; p.failed = false
  }
  const ms = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) : 0)
  vm.registerNatives(MP, {
    native_init: () => {},
    native_setup: (v, s, [ref]) => { const h = nextH++; players.set(h, { el: null, ref, prepared: false, failed: false, url: '', blob: '' }); s.f.mNativeContext = h },
    native_finalize: (v, s) => { const p = P(s); if (p?.el) { p.el.remove(); p.el.src = '' } players.delete(s.f.mNativeContext) },
    _release: (v, s) => { const p = P(s); if (p?.el) { p.el.pause(); p.el.removeAttribute('src'); p.el.load(); p.el.remove() } if (p?.blob) URL.revokeObjectURL(p.blob); players.delete(s.f.mNativeContext) },
    _reset: (v, s) => { const p = P(s); if (!p) return; p.el?.pause(); p.prepared = false; p.url = '' },
    '_setDataSource(Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;)V': (v, s, [path]) => { const p = P(s); if (p) source(p, jstr(vm, path)) },
    '_setDataSource(Ljava/io/FileDescriptor;JJ)V': (v, s, [fd, off, len]) => {
      const p = P(s); if (!p) return
      // an asset's file descriptor (AssetManager.openFd): a blob of its bytes
      const b = fdBytes(fd)
      if (b && typeof Blob !== 'undefined') {
        if (p.blob) URL.revokeObjectURL(p.blob)
        const part = b.subarray(Number(off), Number(off) + (Number(len) > 0 ? Number(len) : b.length))
        p.blob = URL.createObjectURL(new Blob([part.slice()])); p.url = p.blob; p.prepared = false; p.failed = false
      } else source(p, fd?.f.path ?? '')
    },
    prepareAsync: (v, s) => {
      const p = P(s); if (!p) return
      const el = make(p)
      if (!el) { p.prepared = true; post(p, 5); post(p, 1); return }
      const url = p.url
      p.loading = true
      Promise.resolve(/^http:/i.test(url) && host.mediaUrl ? host.mediaUrl(url).catch(() => url) : url).then((u) => {
        if (p.url !== url) return
        el.src = u; el.load(); p.loading = false
        if (p.wantPlay) { p.wantPlay = false; el.play().catch(() => post(p, 100, 1, -38)) }
      })
    },
    // prepare() (the blocking one) returns at once: waiting for the browser to load the file inside a
    // call from native code would hold the page's only thread, so it could never load. it loads behind
    // and start() plays as soon as it can; a file that fails reports MEDIA_ERROR then
    prepare: (v, s) => {
      const p = P(s); if (!p) return
      const el = make(p)
      p.prepared = true
      if (!el) return
      const url = p.url
      p.loading = true
      Promise.resolve(/^http:/i.test(url) && host.mediaUrl ? host.mediaUrl(url).catch(() => url) : url).then((u) => {
        if (p.url !== url) return
        el.src = u; el.load(); p.loading = false
        if (p.wantPlay) { p.wantPlay = false; el.play().catch(() => post(p, 100, 1, -38)) }
      })
    },
    _start: (v, s) => {
      const p = P(s); if (!p?.el) return
      if (p.loading) { p.wantPlay = true; return }
      p.el.play().catch(() => post(p, 100, 1, -38))
    },
    _pause: (v, s) => { const p = P(s); if (p) p.wantPlay = false; p?.el?.pause() },
    _stop: (v, s) => { const p = P(s); if (p?.el) { p.el.pause(); p.el.currentTime = 0 } },
    isPlaying: (v, s) => { const e = P(s)?.el; return e && !e.paused && !e.ended ? 1 : 0 },
    seekTo: (v, s, [t]) => { const p = P(s); if (p?.el) p.el.currentTime = t / 1000; else if (p) post(p, 4) },
    getCurrentPosition: (v, s) => ms(P(s)?.el?.currentTime ?? 0),
    getDuration: (v, s) => ms(P(s)?.el?.duration ?? 0),
    getVideoWidth: (v, s) => P(s)?.el?.videoWidth ?? 0,
    getVideoHeight: (v, s) => P(s)?.el?.videoHeight ?? 0,
    setLooping: (v, s, [l]) => { const p = P(s); if (p) { const e = make(p); if (e) e.loop = !!l } },
    isLooping: (v, s) => (P(s)?.el?.loop ? 1 : 0),
    setVolume: (v, s, [l, r]) => { const p = P(s); if (p) { const e = make(p); if (e) e.volume = Math.max(0, Math.min(1, Math.max(l, r))) } },
    _setVideoSurface: (v, s, [surface]) => {
      const p = P(s); if (!p) return
      const e = make(p); if (!e) return
      const id = surface ? host.windowOf(surface.f.mNativeObject) : null
      host.show?.(e, id)
    },
    setAudioStreamType: () => {}, setAudioSessionId: () => {}, getAudioSessionId: () => 1, attachAuxEffect: () => {}, setAuxEffectSendLevel: () => {},
    setNextMediaPlayer: () => {}, native_invoke: () => 0, native_getMetadata: () => 0, native_setMetadataFilter: () => 0,
    native_pullBatteryData: () => 0, native_setRetransmitEndpoint: () => 0, updateProxyConfig: () => {},
  })
}
