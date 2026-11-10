// opengl es 2.0 for native code, on webgl2. gl names (ints) map to webgl objects; the default
// framebuffer is an offscreen one that eglSwapBuffers copies to the canvas in one go (a frame can take
// several time slices to draw). client-side vertex arrays and indices are uploaded at draw time.
// soft-float abi: float arguments arrive as bits in core registers.
import type { CPU } from './cpu.ts'
import type { Native } from './native.ts'

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer)
const F = (b: number) => { u32[0] = b >>> 0; return f32[0] }

export interface GlSurface { canvas: HTMLCanvasElement; width: number; height: number }
// one gl for the whole runtime (egl in java and gles in native code share it)

export class Gles {
  gl: WebGL2RenderingContext | null = null
  surface: GlSurface | null = null
  fbo: WebGLFramebuffer | null = null
  private color: WebGLRenderbuffer | null = null
  private depth: WebGLRenderbuffer | null = null
  private fbW = 0
  private fbH = 0
  contexts = new Map<HTMLCanvasElement, WebGL2RenderingContext>()
  frames = 0

  // eglMakeCurrent: the canvas's webgl2 context, with a default framebuffer of the surface size
  makeCurrent(s: GlSurface | null) {
    this.surface = s
    if (!s) { this.gl = null; return true }
    let gl = this.contexts.get(s.canvas)
    if (!gl) {
      gl = (s.canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, premultipliedAlpha: false }) as WebGL2RenderingContext | null) ?? undefined
      if (!gl) return false
      this.contexts.set(s.canvas, gl)
      gl.getExtension('EXT_color_buffer_float')
      gl.getExtension('OES_texture_float_linear')
      gl.getExtension('EXT_texture_filter_anisotropic')
    }
    this.gl = gl
    this.resize(s.width, s.height)
    return true
  }
  resize(w: number, h: number) {
    const gl = this.gl!
    if (this.fbo && this.fbW === w && this.fbH === h) return
    if (this.fbo) { gl.deleteFramebuffer(this.fbo); gl.deleteRenderbuffer(this.color); gl.deleteRenderbuffer(this.depth) }
    this.fbW = w; this.fbH = h
    this.fbo = gl.createFramebuffer()
    this.color = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.color)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h)
    this.depth = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.color)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.depth)
    gl.viewport(0, 0, w, h)
  }
  // eglSwapBuffers: show the finished frame
  private fpsAt = 0
  private fpsN = 0
  swap() {
    // frame rate, for testing (window.__glfps = true logs it every 5 s)
    if ((globalThis as any).__glfps) { this.fpsN++; const t = performance.now(); if (!this.fpsAt) this.fpsAt = t; if (t - this.fpsAt > 5000) { console.log('gl fps', (this.fpsN * 1000 / (t - this.fpsAt)).toFixed(1)); this.fpsAt = t; this.fpsN = 0 } }
    const gl = this.gl, s = this.surface
    if (!gl || !s || !this.fbo) return
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
    const scissor = gl.isEnabled(gl.SCISSOR_TEST)
    if (scissor) gl.disable(gl.SCISSOR_TEST)
    if (s.canvas.width !== this.fbW || s.canvas.height !== this.fbH) { s.canvas.width = this.fbW; s.canvas.height = this.fbH }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.blitFramebuffer(0, 0, this.fbW, this.fbH, 0, 0, this.fbW, this.fbH, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw)
    if (scissor) gl.enable(gl.SCISSOR_TEST)
    this.frames++
  }
}

export function installGles(nat: Native) {
  const m = nat.mem, c = nat.cpu
  const R = (i: number) => c.r[i]
  const S = (i: number) => m.r32(c.r[13] + i * 4)
  const G = nat.gles
  // window.__glfps also counts gl calls per kind (every 5 s, the busiest ones)
  const counts = new Map<string, number>(); let countAt = 0
  const counting = () => !!((globalThis as any).__glfps)
  const def = (name: string, fn: (cpu: CPU) => any) => nat.def(name, (cpu: CPU) => {
    if (counting()) {
      counts.set(name, (counts.get(name) || 0) + 1)
      const t = performance.now()
      if (!countAt) countAt = t
      if (t - countAt > 5000) { console.log('gl calls/s', [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ' ' + Math.round(v * 1000 / (t - countAt))).join(', ')); counts.clear(); countAt = t }
    }
    return fn(cpu)
  })
  const gl = () => { if (!G.gl) throw new Error('gl call with no current context'); return G.gl }
  // copies out of guest memory (webgl refuses views of a resizable buffer)
  const bytes = (p: number, n: number) => m.u8.slice(p, p + n)
  const floats = (p: number, n: number) => new Float32Array(m.u8.slice(p, p + n * 4).buffer)
  const ints = (p: number, n: number) => new Int32Array(m.u8.slice(p, p + n * 4).buffer)

  // ---------- names ----------
  class Names<T> {
    by = new Map<number, T>(); ids = new Map<T, number>(); next = 1
    add(o: T) { while (this.by.has(this.next)) this.next++; const id = this.next++; this.by.set(id, o); this.ids.set(o, id); return id }
    get(id: number) { return id ? this.by.get(id) ?? null : null }
    // gles makes the object when a name nobody generated is first bound (webgl does not)
    bind(id: number, make: () => T | null) { if (!id) return null; let o = this.by.get(id); if (!o) { o = make()!; this.by.set(id, o); this.ids.set(o, id) } return o }
    id(o: T | null) { return o ? this.ids.get(o) ?? 0 : 0 }
    del(id: number) { const o = this.by.get(id); if (o) { this.ids.delete(o); this.by.delete(id) } return o }
  }
  const tex = new Names<WebGLTexture>(), buf = new Names<WebGLBuffer>(), fbs = new Names<WebGLFramebuffer>(), rbs = new Names<WebGLRenderbuffer>()
  const progs = new Names<WebGLProgram>(), shaders = new Names<WebGLShader>()
  const gen = (names: Names<any>, make: () => any) => () => { for (let i = 0; i < R(0); i++) m.w32(R(1) + i * 4, names.add(make())) }
  const del = (names: Names<any>, kill: (o: any) => void) => () => { for (let i = 0; i < R(0); i++) { const o = names.del(m.r32(R(1) + i * 4)); if (o) kill(o) } }
  def('glGenTextures', gen(tex, () => gl().createTexture()))
  def('glDeleteTextures', del(tex, (o) => gl().deleteTexture(o)))
  def('glGenBuffers', gen(buf, () => gl().createBuffer()))
  def('glDeleteBuffers', del(buf, (o) => { gl().deleteBuffer(o); shadow.delete(o) }))
  for (const sfx of ['', 'OES']) {
    def('glGenFramebuffers' + sfx, gen(fbs, () => gl().createFramebuffer()))
    def('glDeleteFramebuffers' + sfx, del(fbs, (o) => gl().deleteFramebuffer(o)))
    def('glGenRenderbuffers' + sfx, gen(rbs, () => gl().createRenderbuffer()))
    def('glDeleteRenderbuffers' + sfx, del(rbs, (o) => gl().deleteRenderbuffer(o)))
    def('glBindFramebuffer' + sfx, () => { gl().bindFramebuffer(R(0), R(1) ? fbs.bind(R(1), () => gl().createFramebuffer()) : G.fbo) })
    def('glBindRenderbuffer' + sfx, () => { gl().bindRenderbuffer(R(0), rbs.bind(R(1), () => gl().createRenderbuffer())) })
    def('glRenderbufferStorage' + sfx, () => { gl().renderbufferStorage(R(0), rbFormat(R(1)), R(2), R(3)) })
    def('glFramebufferRenderbuffer' + sfx, () => { gl().framebufferRenderbuffer(R(0), R(1) === 0x8d20 + 0 && false ? R(1) : R(1), R(2), rbs.get(R(3))) })
    def('glFramebufferTexture2D' + sfx, () => { gl().framebufferTexture2D(R(0), R(1), R(2), tex.get(R(3)), S(0)) })
    def('glCheckFramebufferStatus' + sfx, () => gl().checkFramebufferStatus(R(0)))
    def('glGenerateMipmap' + sfx, () => { gl().generateMipmap(R(0)) })
    def('glGetRenderbufferParameteriv' + sfx, () => { m.w32(R(2), gl().getRenderbufferParameter(R(0), R(1)) | 0) })
    def('glGetFramebufferAttachmentParameteriv' + sfx, () => { const v = gl().getFramebufferAttachmentParameter(R(0), R(1), R(2)); m.w32(R(3), typeof v === 'number' ? v : v instanceof WebGLTexture ? tex.id(v) : v instanceof WebGLRenderbuffer ? rbs.id(v) : 0) })
  }
  // es2 unsized formats -> webgl2 sized ones where webgl2 needs them
  const rbFormat = (f: number) => ({ 0x81a5: 0x81a5, 0x81a6: 0x81a6, 0x88f0: 0x88f0, 0x8d48: 0x8d48, 0x8056: 0x8056, 0x8057: 0x8057, 0x8d62: 0x8d62, 0x8058: 0x8058, 0x8051: 0x8051 } as Record<number, number>)[f] ?? f

  // ---------- state ----------
  def('glEnable', () => { if (R(0) !== 0x0b10 && R(0) !== 0x0bc0 && R(0) !== 0x8865) gl().enable(R(0)) }) // (es1 caps ignored)
  def('glDisable', () => { if (R(0) !== 0x0b10 && R(0) !== 0x0bc0 && R(0) !== 0x8865) gl().disable(R(0)) })
  def('glIsEnabled', () => (gl().isEnabled(R(0)) ? 1 : 0))
  def('glViewport', () => { gl().viewport(R(0) | 0, R(1) | 0, R(2), R(3)) })
  def('glScissor', () => { gl().scissor(R(0) | 0, R(1) | 0, R(2), R(3)) })
  def('glClearColor', () => { gl().clearColor(F(R(0)), F(R(1)), F(R(2)), F(R(3))) })
  def('glClearDepthf', () => { gl().clearDepth(F(R(0))) })
  def('glClearStencil', () => { gl().clearStencil(R(0)) })
  def('glClear', () => { gl().clear(R(0)) })
  def('glColorMask', () => { gl().colorMask(!!R(0), !!R(1), !!R(2), !!R(3)) })
  def('glDepthMask', () => { gl().depthMask(!!R(0)) })
  def('glDepthFunc', () => { gl().depthFunc(R(0)) })
  def('glDepthRangef', () => { gl().depthRange(F(R(0)), F(R(1))) })
  def('glBlendFunc', () => { gl().blendFunc(R(0), R(1)) })
  def('glBlendFuncSeparate', () => { gl().blendFuncSeparate(R(0), R(1), R(2), R(3)) })
  def('glBlendEquation', () => { gl().blendEquation(R(0)) })
  def('glBlendEquationSeparate', () => { gl().blendEquationSeparate(R(0), R(1)) })
  def('glBlendColor', () => { gl().blendColor(F(R(0)), F(R(1)), F(R(2)), F(R(3))) })
  def('glCullFace', () => { gl().cullFace(R(0)) })
  def('glFrontFace', () => { gl().frontFace(R(0)) })
  def('glLineWidth', () => { gl().lineWidth(F(R(0))) })
  def('glPolygonOffset', () => { gl().polygonOffset(F(R(0)), F(R(1))) })
  def('glStencilFunc', () => { gl().stencilFunc(R(0), R(1) | 0, R(2)) })
  def('glStencilFuncSeparate', () => { gl().stencilFuncSeparate(R(0), R(1), R(2) | 0, R(3)) })
  def('glStencilMask', () => { gl().stencilMask(R(0)) })
  def('glStencilMaskSeparate', () => { gl().stencilMaskSeparate(R(0), R(1)) })
  def('glStencilOp', () => { gl().stencilOp(R(0), R(1), R(2)) })
  def('glStencilOpSeparate', () => { gl().stencilOpSeparate(R(0), R(1), R(2), R(3)) })
  def('glHint', () => { if (R(0) === 0x8192) gl().hint(R(0), R(1)) })
  def('glPixelStorei', () => { if (R(0) === 0x0cf5) unpackAlign = R(1); if (R(0) === 0x0d05) packAlign = R(1); if (R(0) === 0x0cf5 || R(0) === 0x0d05) gl().pixelStorei(R(0), R(1)) }) // unpack / pack alignment
  let unpackAlign = 4, packAlign = 4
  def('glSampleCoverage', () => { gl().sampleCoverage(F(R(0)), !!R(1)) })
  def('glFinish', () => { gl().finish() })
  def('glFlush', () => { gl().flush() })
  def('glGetError', () => (G.gl ? G.gl.getError() : 0))

  // ---------- queries ----------
  const strs = new Map<number, number>()
  const EXT = ['GL_OES_texture_npot', 'GL_OES_depth24', 'GL_OES_packed_depth_stencil', 'GL_OES_rgb8_rgba8', 'GL_OES_standard_derivatives', 'GL_OES_element_index_uint', 'GL_OES_mapbuffer', 'GL_OES_depth_texture', 'GL_EXT_texture_filter_anisotropic', 'GL_OES_texture_float', 'GL_OES_texture_half_float', 'GL_EXT_blend_minmax']
  def('glGetString', () => {
    const n = R(0)
    let a = strs.get(n)
    if (!a) {
      const g = G.gl
      const etc1 = g?.getExtension('WEBGL_compressed_texture_etc1')
      const s3tc = g?.getExtension('WEBGL_compressed_texture_s3tc')
      const ext = [...EXT, ...(etc1 ? ['GL_OES_compressed_ETC1_RGB8_texture'] : []), ...(s3tc ? ['GL_EXT_texture_compression_dxt1', 'GL_EXT_texture_compression_s3tc'] : [])].join(' ')
      const v = ({ 0x1f00: 'Danen', 0x1f01: 'Droid WebGL', 0x1f02: 'OpenGL ES 2.0 (WebGL 2)', 0x8b8c: 'OpenGL ES GLSL ES 1.00', 0x1f03: ext } as Record<number, string>)[n]
      if (v == null) return 0
      a = nat.str(v)
      strs.set(n, a)
    }
    return a
  })
  // es2 parameters webgl answers differently (bindings are objects there, some names differ)
  const nameOf = (v: any) => v instanceof WebGLTexture ? tex.id(v) : v instanceof WebGLBuffer ? buf.id(v) : v instanceof WebGLFramebuffer ? (v === G.fbo ? 0 : fbs.id(v)) : v instanceof WebGLRenderbuffer ? rbs.id(v) : v instanceof WebGLProgram ? progs.id(v) : 0
  const getv = (pname: number): number[] => {
    const g = gl()
    switch (pname) {
      case 0x8b4c: return [16] // MAX_VERTEX_TEXTURE_IMAGE_UNITS
      case 0x8dfb: return [g.getParameter(g.MAX_VERTEX_UNIFORM_VECTORS)] // MAX_VERTEX_UNIFORM_VECTORS
      case 0x8dfd: return [g.getParameter(g.MAX_FRAGMENT_UNIFORM_VECTORS)]
      case 0x8dfc: return [g.getParameter(g.MAX_VARYING_VECTORS)]
      case 0x86a2: return [G.gl?.getExtension('WEBGL_compressed_texture_etc1') ? 1 : 0] // NUM_COMPRESSED_TEXTURE_FORMATS
      case 0x86a3: return G.gl?.getExtension('WEBGL_compressed_texture_etc1') ? [0x8d64] : []
      case 0x8b9a: return [g.RGBA] // IMPLEMENTATION_COLOR_READ_FORMAT
      case 0x8b9b: return [g.UNSIGNED_BYTE]
      case 0x0d50: case 0x0d51: case 0x0d52: case 0x0d53: return [8] // red / green / blue / alpha bits
      case 0x0d56: return [24] // depth bits
      case 0x0d57: return [8] // stencil bits
      case 0x84ff: return [Math.min(16, g.getParameter(0x84ff) || 1)] // max anisotropy
      case 0x8df8: return [0] // NUM_SHADER_BINARY_FORMATS
    }
    const v = g.getParameter(pname)
    if (v == null) return [0]
    if (typeof v === 'number') return [v]
    if (typeof v === 'boolean') return [v ? 1 : 0]
    if (ArrayBuffer.isView(v)) return Array.from(v as any as number[]).map(Number)
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'boolean' ? (x ? 1 : 0) : Number(x)))
    return [nameOf(v)]
  }
  def('glGetIntegerv', () => getv(R(0)).forEach((x, i) => m.w32(R(1) + i * 4, x | 0)))
  def('glGetFloatv', () => getv(R(0)).forEach((x, i) => m.dv.setFloat32(R(1) + i * 4, x, true)))
  def('glGetBooleanv', () => getv(R(0)).forEach((x, i) => (m.u8[R(1) + i] = x ? 1 : 0)))

  // ---------- buffers ----------
  // element buffers keep a copy so draws can find the highest index (for client-side attributes)
  const shadow = new Map<WebGLBuffer, Uint8Array>()
  let arrayBuf: WebGLBuffer | null = null, elemBuf: WebGLBuffer | null = null
  const bound = (target: number) => (target === 0x8893 ? elemBuf : arrayBuf)
  def('glBindBuffer', () => { const b = buf.bind(R(1), () => gl().createBuffer()); gl().bindBuffer(R(0), b); if (R(0) === 0x8892) arrayBuf = b; else if (R(0) === 0x8893) elemBuf = b })
  def('glBufferData', () => {
    const data = R(2) ? bytes(R(2), R(1)) : new Uint8Array(R(1))
    gl().bufferData(R(0), data, R(3))
    const b = bound(R(0)); if (b) shadow.set(b, data)
  })
  def('glBufferSubData', () => {
    const data = bytes(R(3), R(2))
    gl().bufferSubData(R(0), R(1), data)
    const b = bound(R(0)); const sh = b && shadow.get(b); if (sh && R(1) + R(2) <= sh.length) sh.set(data, R(1))
  })
  // glMapBufferOES: a block in guest memory, uploaded on unmap
  const maps = new Map<number, number>()
  def('glMapBufferOES', () => { const b = bound(R(0)); const sh = b && shadow.get(b); const n = sh?.length ?? 0; const a = m.malloc(Math.max(1, n)); if (sh) m.u8.set(sh, a); maps.set(R(0), a); return a })
  def('glUnmapBufferOES', () => { const a = maps.get(R(0)); if (!a) return 0; const b = bound(R(0)); const sh = b && shadow.get(b); const n = sh?.length ?? 0; const data = bytes(a, n); gl().bufferSubData(R(0), 0, data); if (b) shadow.set(b, data); m.free(a); maps.delete(R(0)); return 1 })
  def('glGetBufferPointervOES', () => { m.w32(R(2), maps.get(R(0)) ?? 0) })

  // ---------- textures ----------
  def('glActiveTexture', () => { gl().activeTexture(R(0)) })
  def('glBindTexture', () => { gl().bindTexture(R(0), tex.bind(R(1), () => gl().createTexture())) })
  def('glTexParameteri', () => { gl().texParameteri(R(0), R(1), R(2) | 0) })
  def('glTexParameterf', () => { const p = R(1); if (p === 0x84fe) gl().getExtension('EXT_texture_filter_anisotropic'); gl().texParameterf(R(0), p, F(R(2))) })
  def('glTexParameteriv', () => { gl().texParameteri(R(0), R(1), m.r32(R(2)) | 0) })
  const BPP: Record<number, number> = { 0x1906: 1, 0x1909: 1, 0x190a: 2, 0x1907: 3, 0x1908: 4 } // alpha, luminance, luminance_alpha, rgb, rgba
  const texBytes = (w: number, h: number, format: number, type: number, pack = false) => {
    const bpp = type === 0x1401 ? BPP[format] ?? 4 : type === 0x1406 ? (BPP[format] ?? 4) * 4 : type === 0x8d61 ? (BPP[format] ?? 4) * 2 : type === 0x1403 || type === 0x1405 ? (type === 0x1405 ? 4 : 2) : 2
    const align = pack ? packAlign : unpackAlign, row = Math.ceil((w * bpp) / align) * align
    return { size: h ? row * (h - 1) + w * bpp : 0, view: (b: Uint8Array) => (type === 0x1401 ? b : type === 0x1406 ? new Float32Array(b.buffer) : type === 0x1405 ? new Uint32Array(b.buffer) : new Uint16Array(b.buffer)) }
  }
  // es2 (format, type) -> webgl2 internal format
  const internal = (fmt: number, type: number) => {
    if (fmt === 0x1902) return type === 0x1405 ? 0x81a6 : 0x81a5 // depth component -> DEPTH_COMPONENT24 / 16
    if (fmt === 0x84f9) return 0x88f0 // depth stencil -> DEPTH24_STENCIL8
    if (type === 0x1406) return fmt === 0x1908 ? 0x8814 : fmt === 0x1907 ? 0x8815 : fmt // float -> RGBA32F / RGB32F
    if (type === 0x8d61) return fmt === 0x1908 ? 0x881a : fmt === 0x1907 ? 0x881b : fmt // half float -> RGBA16F / RGB16F
    return fmt
  }
  const glType = (fmt: number, type: number) => (fmt === 0x84f9 ? 0x84fa : type === 0x8d61 ? 0x140b : type) // HALF_FLOAT_OES -> HALF_FLOAT
  def('glTexImage2D', () => {
    const [target, level, , w, h] = [R(0), R(1) | 0, R(2), R(3), S(0)], fmt = S(2), type = S(3), ptr = S(4)
    const t = texBytes(w, h, fmt, type)
    const data = ptr ? t.view(bytes(ptr, t.size)) : null
    const gfmt = fmt === 0x1902 || fmt === 0x84f9 ? fmt : fmt
    gl().texImage2D(target, level, internal(fmt, type), w, h, 0, gfmt === 0x84f9 ? 0x84f9 : gfmt, glType(fmt, type), data as any)
  })
  def('glTexSubImage2D', () => {
    const [target, level, x, y] = [R(0), R(1) | 0, R(2) | 0, R(3) | 0], w = S(0), h = S(1), fmt = S(2), type = S(3), ptr = S(4)
    const t = texBytes(w, h, fmt, type)
    gl().texSubImage2D(target, level, x, y, w, h, fmt, glType(fmt, type), t.view(bytes(ptr, t.size)) as any)
  })
  def('glCopyTexImage2D', () => { gl().copyTexImage2D(R(0), R(1), R(2), R(3) | 0, S(0) | 0, S(1), S(2), 0) })
  def('glCopyTexSubImage2D', () => { gl().copyTexSubImage2D(R(0), R(1), R(2) | 0, R(3) | 0, S(0) | 0, S(1) | 0, S(2), S(3)) })
  // compressed: the format if webgl has it, else etc1 decoded here (the engine decodes the others itself)
  def('glCompressedTexImage2D', () => {
    const [target, level, fmt, w] = [R(0), R(1) | 0, R(2), R(3)], h = S(0), size = S(2), ptr = S(3)
    const g = gl()
    const data = bytes(ptr, size)
    if (fmt === 0x8d64 && !g.getExtension('WEBGL_compressed_texture_etc1')) { g.texImage2D(target, level, g.RGB, w, h, 0, g.RGB, g.UNSIGNED_BYTE, decodeEtc1(data, w, h)); return }
    if (fmt >= 0x83f0 && fmt <= 0x83f3) g.getExtension('WEBGL_compressed_texture_s3tc')
    g.compressedTexImage2D(target, level, fmt, w, h, 0, data)
  })
  def('glCompressedTexSubImage2D', () => { gl().compressedTexSubImage2D(R(0), R(1), R(2), R(3), S(0), S(1), S(2), bytes(S(4), S(3))) })
  def('glReadPixels', () => {
    const [x, y, w, h] = [R(0) | 0, R(1) | 0, R(2), R(3)], fmt = S(0), type = S(1), ptr = S(2)
    const t = texBytes(w, h, fmt, type, true)
    const out = new Uint8Array(t.size)
    gl().readPixels(x, y, w, h, fmt, type, t.view(out) as any)
    m.u8.set(out, ptr)
  })

  // ---------- shaders and programs ----------
  def('glCreateShader', () => shaders.add(gl().createShader(R(0))!))
  def('glDeleteShader', () => { const s = shaders.del(R(0)); if (s) gl().deleteShader(s) })
  def('glShaderSource', () => {
    let src = ''
    for (let i = 0; i < R(1); i++) { const p = m.r32(R(2) + i * 4); const len = R(3) ? m.r32(R(3) + i * 4) | 0 : -1; src += len >= 0 ? new TextDecoder().decode(bytes(p, len)) : m.cstr(p) }
    gl().shaderSource(shaders.get(R(0))!, src)
  })
  def('glCompileShader', () => {
    const sh = shaders.get(R(0))!, g = gl()
    g.compileShader(sh)
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) console.warn('gl: shader did not compile:', (g.getShaderInfoLog(sh) || '').slice(0, 300), '|', (g.getShaderSource(sh) || '').slice(0, 200).replace(/\s+/g, ' '))
  })
  def('glGetShaderiv', () => {
    const s = shaders.get(R(0))!, g = gl()
    const v = R(1) === 0x8b84 ? (g.getShaderInfoLog(s) || '').length + 1 : R(1) === 0x8b88 ? (g.getShaderSource(s) || '').length + 1 : g.getShaderParameter(s, R(1))
    m.w32(R(2), typeof v === 'boolean' ? (v ? 1 : 0) : v | 0)
  })
  const putLog = (s: string, max: number, lenp: number, dst: number) => { const b = new TextEncoder().encode(s); const n = Math.max(0, Math.min(b.length, max - 1)); m.u8.set(b.subarray(0, n), dst); if (max > 0) m.u8[dst + n] = 0; if (lenp) m.w32(lenp, n) }
  def('glGetShaderInfoLog', () => putLog(gl().getShaderInfoLog(shaders.get(R(0))!) || '', R(1), R(2), R(3)))
  def('glGetShaderSource', () => putLog(gl().getShaderSource(shaders.get(R(0))!) || '', R(1), R(2), R(3)))
  def('glCreateProgram', () => progs.add(gl().createProgram()!))
  def('glDeleteProgram', () => { const p = progs.del(R(0)); if (p) { gl().deleteProgram(p); uniforms.delete(p) } })
  def('glAttachShader', () => { gl().attachShader(progs.get(R(0))!, shaders.get(R(1))!) })
  def('glDetachShader', () => { gl().detachShader(progs.get(R(0))!, shaders.get(R(1))!) })
  def('glBindAttribLocation', () => { gl().bindAttribLocation(progs.get(R(0))!, R(1), m.cstr(R(2))) })
  def('glLinkProgram', () => {
    const p = progs.get(R(0))!, g = gl()
    g.linkProgram(p); uniforms.delete(p)
    if (!g.getProgramParameter(p, g.LINK_STATUS)) console.warn('gl: program did not link:', (g.getProgramInfoLog(p) || '').slice(0, 300))
  })
  def('glValidateProgram', () => { gl().validateProgram(progs.get(R(0))!) })
  def('glUseProgram', () => { const p = progs.get(R(0)); gl().useProgram(p); current = p })
  let current: WebGLProgram | null = null
  def('glGetProgramiv', () => {
    const p = progs.get(R(0))!, g = gl()
    let v: any
    if (R(1) === 0x8b84) v = (g.getProgramInfoLog(p) || '').length + 1
    else if (R(1) === 0x8b87) { const n = g.getProgramParameter(p, g.ACTIVE_UNIFORMS); v = 1; for (let i = 0; i < n; i++) v = Math.max(v, (g.getActiveUniform(p, i)?.name.length ?? 0) + 1) } // ACTIVE_UNIFORM_MAX_LENGTH
    else if (R(1) === 0x8b8a) { const n = g.getProgramParameter(p, g.ACTIVE_ATTRIBUTES); v = 1; for (let i = 0; i < n; i++) v = Math.max(v, (g.getActiveAttrib(p, i)?.name.length ?? 0) + 1) }
    else v = g.getProgramParameter(p, R(1))
    m.w32(R(2), typeof v === 'boolean' ? (v ? 1 : 0) : v | 0)
  })
  def('glGetProgramInfoLog', () => putLog(gl().getProgramInfoLog(progs.get(R(0))!) || '', R(1), R(2), R(3)))
  // (program, index, bufsize, *length, *size, *type, *name)
  const active = (info: WebGLActiveInfo | null) => {
    if (!info) return
    putLog(info.name, R(2), R(3), S(2))
    m.w32(S(0), info.size); m.w32(S(1), info.type)
  }
  def('glGetActiveAttrib', () => active(gl().getActiveAttrib(progs.get(R(0))!, R(1))))
  def('glGetActiveUniform', () => active(gl().getActiveUniform(progs.get(R(0))!, R(1))))
  def('glGetAttribLocation', () => gl().getAttribLocation(progs.get(R(0))!, m.cstr(R(1))))
  // uniform locations: small ints per program; an array's elements get consecutive numbers
  const uniforms = new Map<WebGLProgram, { byName: Map<string, number>; locs: (WebGLUniformLocation | null)[] }>()
  const uTable = (p: WebGLProgram) => {
    let t = uniforms.get(p)
    if (!t) {
      t = { byName: new Map(), locs: [null] }
      const g = gl(), n = g.getProgramParameter(p, g.ACTIVE_UNIFORMS) | 0
      for (let i = 0; i < n; i++) {
        const info = g.getActiveUniform(p, i)!
        const base = info.name.replace(/\[0\]$/, '')
        const first = t.locs.length
        for (let k = 0; k < info.size; k++) t.locs.push(g.getUniformLocation(p, info.size > 1 ? `${base}[${k}]` : info.name))
        t.byName.set(base, first)
        if (info.size > 1) for (let k = 0; k < info.size; k++) t.byName.set(`${base}[${k}]`, first + k)
      }
      uniforms.set(p, t)
    }
    return t
  }
  def('glGetUniformLocation', () => { const p = progs.get(R(0)); if (!p) return -1; return uTable(p).byName.get(m.cstr(R(1)).replace(/\[0\]$/, '')) ?? -1 })
  const loc = (l: number) => (current && l > 0 ? uTable(current).locs[l] ?? null : null)
  def('glUniform1i', () => { gl().uniform1i(loc(R(0) | 0), R(1) | 0) })
  def('glUniform1f', () => { gl().uniform1f(loc(R(0) | 0), F(R(1))) })
  def('glUniform4f', () => { gl().uniform4f(loc(R(0) | 0), F(R(1)), F(R(2)), F(R(3)), F(S(0))) })
  // arrays may span several locations: set each element
  const uv = (n: number, set: (l: WebGLUniformLocation | null, v: Float32Array) => void) => () => {
    const l = R(0) | 0, count = R(1), p = R(2)
    if (!current || l < 0) return
    const t = uTable(current)
    for (let k = 0; k < count; k++) set(t.locs[l + k] ?? null, floats(p + k * n * 4, n))
  }
  def('glUniform1fv', uv(1, (l, v) => gl().uniform1fv(l, v)))
  def('glUniform2fv', uv(2, (l, v) => gl().uniform2fv(l, v)))
  def('glUniform3fv', uv(3, (l, v) => gl().uniform3fv(l, v)))
  def('glUniform4fv', uv(4, (l, v) => gl().uniform4fv(l, v)))
  def('glUniform1iv', () => { if (current) for (let k = 0; k < R(1); k++) gl().uniform1i(uTable(current).locs[(R(0) | 0) + k] ?? null, m.r32(R(2) + k * 4) | 0) })
  const um = (n: number) => () => { const l = R(0) | 0, count = R(1), p = S(0); if (!current || l < 0) return; const t = uTable(current); for (let k = 0; k < count; k++) { const lo = t.locs[l + k] ?? null; const v = floats(p + k * n * n * 4, n * n); if (n === 4) gl().uniformMatrix4fv(lo, !!R(2), v); else if (n === 3) gl().uniformMatrix3fv(lo, !!R(2), v); else gl().uniformMatrix2fv(lo, !!R(2), v) } }
  def('glUniformMatrix4fv', () => { const l = R(0) | 0, count = R(1), p = R(3); if (!current || l < 0) return; const t = uTable(current); for (let k = 0; k < count; k++) gl().uniformMatrix4fv(t.locs[l + k] ?? null, !!R(2), floats(p + k * 64, 16)) })
  def('glUniformMatrix3fv', () => { const l = R(0) | 0, count = R(1), p = R(3); if (!current || l < 0) return; const t = uTable(current); for (let k = 0; k < count; k++) gl().uniformMatrix3fv(t.locs[l + k] ?? null, !!R(2), floats(p + k * 36, 9)) })
  def('glUniformMatrix2fv', () => { const l = R(0) | 0, count = R(1), p = R(3); if (!current || l < 0) return; const t = uTable(current); for (let k = 0; k < count; k++) gl().uniformMatrix2fv(t.locs[l + k] ?? null, !!R(2), floats(p + k * 16, 4)) })
  void um
  def('glGetUniformfv', () => { const v = gl().getUniform(progs.get(R(0))!, uTable(progs.get(R(0))!).locs[R(1)]!); const a = typeof v === 'number' ? [v] : Array.from(v as Float32Array); a.forEach((x, i) => m.dv.setFloat32(R(2) + i * 4, x, true)) })
  def('glGetUniformiv', () => { const v = gl().getUniform(progs.get(R(0))!, uTable(progs.get(R(0))!).locs[R(1)]!); const a = typeof v === 'number' || typeof v === 'boolean' ? [Number(v)] : Array.from(v as Int32Array); a.forEach((x, i) => m.w32(R(2) + i * 4, x | 0)) })

  // ---------- vertex attributes, client arrays, draws ----------
  interface Attr { enabled: boolean; size: number; type: number; norm: boolean; stride: number; ptr: number; client: boolean }
  const attrs: Attr[] = Array.from({ length: 16 }, () => ({ enabled: false, size: 4, type: 0x1406, norm: false, stride: 0, ptr: 0, client: false }))
  const TSIZE: Record<number, number> = { 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4, 0x140c: 4 }
  def('glEnableVertexAttribArray', () => { attrs[R(0)].enabled = true; gl().enableVertexAttribArray(R(0)) })
  def('glDisableVertexAttribArray', () => { attrs[R(0)].enabled = false; gl().disableVertexAttribArray(R(0)) })
  def('glVertexAttribPointer', () => {
    const a = attrs[R(0)]
    Object.assign(a, { size: R(1), type: R(2), norm: !!R(3), stride: S(0), ptr: S(1), client: !arrayBuf })
    if (arrayBuf) gl().vertexAttribPointer(R(0), R(1), R(2), !!R(3), S(0), S(1))
  })
  def('glVertexAttrib4f', () => { gl().vertexAttrib4f(R(0), F(R(1)), F(R(2)), F(R(3)), F(S(0))) })
  def('glVertexAttrib4fv', () => { gl().vertexAttrib4fv(R(0), floats(R(1), 4)) })
  def('glVertexAttrib3fv', () => { gl().vertexAttrib3fv(R(0), floats(R(1), 3)) })
  def('glVertexAttrib2fv', () => { gl().vertexAttrib2fv(R(0), floats(R(1), 2)) })
  def('glVertexAttrib1f', () => { gl().vertexAttrib1f(R(0), F(R(1))) })
  def('glGetVertexAttribiv', () => { const a = attrs[R(0)]; const v = ({ 0x8622: a.enabled ? 1 : 0, 0x8623: a.size, 0x8624: a.stride, 0x8625: a.type, 0x886a: a.norm ? 1 : 0 } as Record<number, number>)[R(1)] ?? 0; m.w32(R(2), v) })
  def('glGetVertexAttribPointerv', () => { m.w32(R(2), attrs[R(0)].ptr) })
  // client arrays: copy the used range into a scratch buffer per attribute
  const scratch: (WebGLBuffer | null)[] = []
  const uploadClient = (vertices: number) => {
    const g = gl()
    let any = false
    attrs.forEach((a, i) => {
      if (!a.enabled || !a.client) return
      any = true
      const elem = a.size * (TSIZE[a.type] ?? 4), stride = a.stride || elem
      const n = Math.max(0, (vertices - 1) * stride + elem)
      scratch[i] ||= g.createBuffer()
      g.bindBuffer(g.ARRAY_BUFFER, scratch[i])
      g.bufferData(g.ARRAY_BUFFER, bytes(a.ptr, n), g.STREAM_DRAW)
      g.vertexAttribPointer(i, a.size, a.type, a.norm, a.stride, 0)
    })
    if (any) g.bindBuffer(g.ARRAY_BUFFER, arrayBuf)
  }
  def('glDrawArrays', () => { uploadClient((R(1) | 0) + R(2)); gl().drawArrays(R(0), R(1) | 0, R(2)) })
  let idxScratch: WebGLBuffer | null = null
  def('glDrawElements', () => {
    const g = gl(), mode = R(0), count = R(1), type = R(2), p = R(3)
    const isz = type === 0x1401 ? 1 : type === 0x1403 ? 2 : 4
    const clientAttrs = attrs.some((a) => a.enabled && a.client)
    let idx: Uint8Array | null = null
    if (!elemBuf) idx = bytes(p, count * isz)
    else if (clientAttrs) { const sh = shadow.get(elemBuf); if (sh) idx = sh.subarray(p, p + count * isz) }
    if (clientAttrs && idx) {
      const v = isz === 1 ? idx : isz === 2 ? new Uint16Array(idx.slice().buffer) : new Uint32Array(idx.slice().buffer)
      let max = 0
      for (let i = 0; i < v.length; i++) if (v[i] > max) max = v[i]
      uploadClient(max + 1)
    }
    if (!elemBuf) {
      idxScratch ||= g.createBuffer()
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, idxScratch)
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, idx!, g.STREAM_DRAW)
      g.drawElements(mode, count, type, 0)
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, null)
    } else g.drawElements(mode, count, type, p)
  })

  // ---------- opengl es 1 (only for engines' fallback paths): accepted, not drawn ----------
  for (const n of ['glAlphaFunc', 'glClientActiveTexture', 'glColor4f', 'glColorPointer', 'glDisableClientState', 'glEnableClientState', 'glFogf', 'glFogfv', 'glFogx', 'glLightModelf', 'glLightModelfv', 'glLightf', 'glLightfv', 'glLoadIdentity', 'glLoadMatrixf', 'glMaterialf', 'glMaterialfv', 'glMatrixMode', 'glNormalPointer', 'glShadeModel', 'glTexCoordPointer', 'glTexEnvf', 'glTexEnvfv', 'glTexEnvi', 'glVertexPointer', 'glPushMatrix', 'glPopMatrix', 'glMultMatrixf', 'glOrthof', 'glFrustumf', 'glTranslatef', 'glRotatef', 'glScalef'])
    def(n, () => 0)
  def('glReleaseShaderCompiler', () => 0)
  def('glShaderBinary', () => 0)
  def('glGetShaderPrecisionFormat', () => { m.w32(R(2), 127); m.w32(R(2) + 4, 127); m.w32(R(3), 23) })
  def('glIsTexture', () => (tex.get(R(0)) ? 1 : 0)); def('glIsBuffer', () => (buf.get(R(0)) ? 1 : 0)); def('glIsProgram', () => (progs.get(R(0)) ? 1 : 0)); def('glIsShader', () => (shaders.get(R(0)) ? 1 : 0))
  def('glIsFramebuffer', () => (fbs.get(R(0)) ? 1 : 0)); def('glIsRenderbuffer', () => (rbs.get(R(0)) ? 1 : 0))
}

// ---------- etc1 -> rgb (for browsers without WEBGL_compressed_texture_etc1) ----------
const ETC_MOD = [[2, 8, -2, -8], [5, 17, -5, -17], [9, 29, -9, -29], [13, 42, -13, -42], [18, 60, -18, -60], [24, 80, -24, -80], [33, 106, -33, -106], [47, 183, -47, -183]]
export function decodeEtc1(src: Uint8Array, w: number, h: number) {
  const out = new Uint8Array(w * h * 3)
  const clamp = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : x)
  let p = 0
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
    const hi = ((src[p] << 24) | (src[p + 1] << 16) | (src[p + 2] << 8) | src[p + 3]) >>> 0
    const lo = ((src[p + 4] << 24) | (src[p + 5] << 16) | (src[p + 6] << 8) | src[p + 7]) >>> 0
    p += 8
    const diff = (hi >>> 1) & 1, flip = hi & 1
    const cw1 = (hi >>> 5) & 7, cw2 = (hi >>> 2) & 7
    let c1: number[], c2: number[]
    if (diff) {
      const r = (hi >>> 27) & 31, g = (hi >>> 19) & 31, b = (hi >>> 11) & 31
      const dr = ((hi >>> 24) & 7) << 29 >> 29, dg = ((hi >>> 16) & 7) << 29 >> 29, db = ((hi >>> 8) & 7) << 29 >> 29
      const e = (x: number) => (x << 3) | (x >> 2)
      c1 = [e(r), e(g), e(b)]; c2 = [e(r + dr), e(g + dg), e(b + db)]
    } else {
      const e = (x: number) => (x << 4) | x
      c1 = [e((hi >>> 28) & 15), e((hi >>> 20) & 15), e((hi >>> 12) & 15)]
      c2 = [e((hi >>> 24) & 15), e((hi >>> 16) & 15), e((hi >>> 8) & 15)]
    }
    for (let i = 0; i < 16; i++) {
      const x = i >> 2, y = i & 3 // pixel index runs down the columns
      const second = flip ? y >= 2 : x >= 2
      const base = second ? c2 : c1, mods = ETC_MOD[second ? cw2 : cw1]
      const idx = (((lo >>> (i + 16)) & 1) << 1) | ((lo >>> i) & 1)
      const mod = mods[[0, 1, 2, 3][idx === 0 ? 0 : idx === 1 ? 1 : idx === 2 ? 2 : 3]]
      const px = bx + x, py = by + y
      if (px >= w || py >= h) continue
      const o = (py * w + px) * 3
      out[o] = clamp(base[0] + mod); out[o + 1] = clamp(base[1] + mod); out[o + 2] = clamp(base[2] + mod)
    }
  }
  return out
}

export const GL = new Gles()
