// the droid sdk, app side (spec section 9). this file runs inside the app's sandboxed iframe.
// the shell puts it into the iframe's srcdoc; it waits for the 'droid:boot' message with a
// MessagePort and the package files, builds the page from them and exposes window.droid.
// plain js on purpose: it is injected as text. types for app developers are in droid.d.ts.
(function () {
  'use strict'
  var port = null
  var nextId = 1
  var pending = {}
  var handlers = {}
  var files = {} // path -> blob url (inside this sandbox's own origin)
  var info = null
  var base = ''

  function call(name, args, transfer) {
    return new Promise(function (ok, fail) {
      var id = nextId++
      pending[id] = { ok: ok, fail: fail }
      port.postMessage({ id: id, call: name, args: args || [] }, transfer || [])
    })
  }
  function emit(name, data) {
    var list = handlers[name] || []
    var out
    for (var i = 0; i < list.length; i++) {
      try { var r = list[i](data); if (r !== undefined) out = r } catch (e) { console.error(e) }
    }
    return out
  }
  function DroidError(code, message) { var e = new Error(message || code); e.code = code; return e }

  function onPortMessage(e) {
    var m = e.data
    if (m.id && pending[m.id]) {
      var p = pending[m.id]
      delete pending[m.id]
      if (m.error) p.fail(DroidError(m.error.code, m.error.message))
      else p.ok(m.value)
      return
    }
    if (m.ev) {
      // events that want an answer (pause -> saved state, back -> handled)
      var r = emit(m.ev, m.data)
      if (m.reply) Promise.resolve(r).then(function (v) { port.postMessage({ reply: m.reply, value: v === undefined ? null : v }) }, function () { port.postMessage({ reply: m.reply, value: null }) })
    }
  }

  // ---- resolving package paths (relative urls resolve against the fake base) ----
  function pathOf(url) {
    try {
      var u = new URL(url, base)
      if (u.origin !== 'https://dpk.invalid') return null
      var p = decodeURIComponent(u.pathname).replace(/^\/[^/]+\//, '')
      return p
    } catch (e) { return null }
  }
  function resolve(url) {
    var p = pathOf(url)
    return p != null && files[p] ? files[p] : null
  }

  // ---- the public api ----
  var droid = {
    version: '4.4',
    api: 19,
    on: function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); return function () { handlers[name] = handlers[name].filter(function (f) { return f !== fn }) } },
    asset: function (path) { return resolve(path) },
    app: {
      info: function () { return info },
      start: function (intent) { return call('intent.start', [intent]) },
      finish: function (code, data) { return call('app.finish', [code, data]) },
    },
    intent: {
      start: function (i) { return call('intent.start', [i]) },
      startforresult: function (i) { return call('intent.startforresult', [i]) },
      setresult: function (code, data) { return call('intent.setresult', [code, data]) },
      current: function () { return info && info.intent },
      OK: -1, CANCELED: 0,
    },
    toast: function (text, duration) { return call('ui.toast', [String(text), duration || 'short']) },
    dialog: function (opts) { return call('ui.dialog', [opts]) },
    actionbar: {
      set: function (opts) { return call('ui.actionbar', [opts]) },
      title: function (t) { return call('ui.actionbar', [{ title: t }]) },
      menu: function (items) { return call('ui.actionbar', [{ menu: items }]) },
      hide: function () { return call('ui.actionbar', [{ visible: false }]) },
      show: function () { return call('ui.actionbar', [{ visible: true }]) },
    },
    progress: function (show, text) { return call('ui.progress', [show, text]) },
    prefs: {
      get: function (k, def) { return call('prefs.get', [k]).then(function (v) { return v === undefined || v === null ? def : v }) },
      set: function (k, v) { return call('prefs.set', [k, v]) },
      remove: function (k) { return call('prefs.remove', [k]) },
      keys: function () { return call('prefs.keys', []) },
    },
    files: {
      // scope: 'private' (default), 'shared' (needs storage), 'package' (read only)
      read: function (path, opts) { opts = opts || {}; return call('files.read', [path, opts.scope || 'private', opts.as || 'text']) },
      write: function (path, data, opts) { opts = opts || {}; return call('files.write', [path, data, opts.scope || 'private', opts.type]) },
      list: function (dir, opts) { opts = opts || {}; return call('files.list', [dir || '', opts.scope || 'private']) },
      delete: function (path, opts) { opts = opts || {}; return call('files.delete', [path, opts.scope || 'private']) },
    },
    system: {
      vibrate: function (p) { return call('system.vibrate', [p]) },
      clipboard: {
        read: function () { return call('system.clipboard.read', []) },
        write: function (t) { return call('system.clipboard.write', [String(t)]) },
      },
      notify: function (n) { return call('system.notify', [n]) },
      cancel: function (id) { return call('system.cancel', [id]) },
      orientation: function (o) { return call('system.orientation', [o]) },
      keepawake: function (on) { return call('system.keepawake', [!!on]) },
      fullscreen: function (on) { return call('system.fullscreen', [on !== false]) },
      // just this app's window without the status bar (android's FLAG_FULLSCREEN; no permission)
      statusbar: function (visible) { return call('ui.statusbar', [visible !== false]) },
      exit: function () { return call('app.finish', [0]) },
    },
    // background work for converted apps (alarms, broadcast receivers, services)
    background: {
      alarm: function (a) { return call('bg.alarm.set', [a]) },
      cancel: function (id) { return call('bg.alarm.cancel', [id]) },
      run: function (job) { return call('bg.run', [job]) },
      idle: function () { return call('bg.idle', []) },
    },
    runtime: {
      aosp: function () { return call('runtime.aosp', []) },
    },
    device: {
      info: function () { return call('device.info', []) },
    },
    // droid's keyboard for apps that draw their own text fields (a canvas): show({ kind, enter,
    // multiline, autocap, force }), text(before the cursor, for auto-capitals), hide(); keys arrive
    // as "ime" events ({ text } | { del } | { enter })
    ime: {
      show: function (o) { return call('ime.show', [o || {}]) },
      text: function (t) { return call('ime.text', [String(t || '')]) },
      hide: function () { return call('ime.hide', []) },
    },
    // VTE (permission "vte"): the vSIMs on this droid's Danen account, for carrier apps
    vte: {
      carriers: function () { return call('vte.carriers', []) },
      sims: function () { return call('vte.sims', []) },
      plan: function (carrier, plan) { return call('vte.plan', [carrier, plan]) },
      usage: function (carrier) { return call('vte.usage', [carrier]) },
      open: function (what) { return call('vte.open', [what]) },
    },
    net: {
      mediaUrl: function (url) { return call('net.mediaUrl', [String(url)]) },
      fetch: function (url, init) {
        init = init || {}
        var body = init.body
        return Promise.resolve(body instanceof Blob ? body.arrayBuffer() : body).then(function (b) {
          return call('net.fetch', [String(url), { method: init.method || 'GET', headers: init.headers || {}, body: b }])
        }).then(function (r) { var nb = r.status === 101 || r.status === 204 || r.status === 205 || r.status === 304; return new Response(nb ? null : r.body, { status: r.status < 200 || r.status > 599 ? 200 : r.status, statusText: r.statusText, headers: r.headers }) })
      },
      websocket: function (url, protocols) { return new BridgeSocket(url, protocols) },
      state: function () { return call('net.state', []) },
      isonline: function () { return navigator.onLine },
    },
    danen: {
      account: function () { return call('danen.account', []) },
      sync: { get: function (k) { return call('danen.sync.get', [k]) }, set: function (k, v) { return call('danen.sync.set', [k, v]) } },
      push: {
        subscribe: function () { return call('danen.push.subscribe', []) },
        send: function (title, body, data) { return call('danen.push.send', [title, body, data]) },
      },
    },
    // c and other wasm modules: instantiate with the droid import table (docs/sdk.md)
    wasm: {
      instantiate: function (path, extra) { return instantiateWasm(path, extra || {}) },
    },
  }

  // websocket through the bridge (the shell connects and enforces the network permission)
  function BridgeSocket(url, protocols) {
    var self = this
    this.url = url
    this.readyState = 0
    this.onopen = this.onmessage = this.onclose = this.onerror = null
    var sock = call('net.ws.open', [url, protocols || []])
    sock.then(function (id) { self._id = id }, function (e) { self.readyState = 3; self.onerror && self.onerror(e); self.onclose && self.onclose({ code: 1006 }) })
    droid.on('ws', function (m) {
      if (m.id !== self._id) return
      if (m.type === 'open') { self.readyState = 1; self.onopen && self.onopen({}) }
      if (m.type === 'message') self.onmessage && self.onmessage({ data: m.data })
      if (m.type === 'close') { self.readyState = 3; self.onclose && self.onclose({ code: m.code, reason: m.reason }) }
      if (m.type === 'error') self.onerror && self.onerror({})
    })
    this.send = function (d) { sock.then(function (id) { call('net.ws.send', [id, d]) }) }
    this.close = function (code, reason) { sock.then(function (id) { call('net.ws.close', [id, code, reason]) }) }
  }

  // ---- wasm import table: strings are (pointer, length) in utf-8 ----
  function instantiateWasm(path, extra) {
    var mem = null
    var dec = new TextDecoder()
    var str = function (p, n) { return dec.decode(new Uint8Array(mem.buffer, p, n)) }
    var env = {
      droid_log: function (p, n) { console.log(str(p, n)) },
      droid_toast: function (p, n) { droid.toast(str(p, n)) },
      droid_vibrate: function (ms) { droid.system.vibrate(ms) },
      droid_title: function (p, n) { droid.actionbar.title(str(p, n)) },
      droid_prefs_set: function (kp, kn, vp, vn) { droid.prefs.set(str(kp, kn), str(vp, vn)) },
      droid_now: function () { return Date.now() },
      droid_random: function () { return Math.random() },
      droid_width: function () { return innerWidth },
      droid_height: function () { return innerHeight },
    }
    for (var k in extra.env || {}) env[k] = extra.env[k]
    var imports = Object.assign({}, extra, { env: env })
    var url = resolve(path)
    if (!url) return Promise.reject(DroidError('notfound', path))
    return fetch(url).then(function (r) { return r.arrayBuffer() }).then(function (b) { return WebAssembly.instantiate(b, imports) }).then(function (res) {
      mem = res.instance.exports.memory
      return res.instance
    })
  }

  // ---- make relative urls in the app work: fetch, xhr, src setters ----
  var realFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url
    if (input instanceof URL) url = input.href
    if (/^(blob|data):/.test(url)) return realFetch(input, init)
    var local = url && resolve(url)
    if (local) return realFetch(local, init)
    var p = url && pathOf(url)
    if (p != null) return Promise.resolve(new Response('not found', { status: 404 }))
    // outside the package: only through droid.net (permission checked by the shell)
    return droid.net.fetch(url, init)
  }
  var xopen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (m, url) {
    var local = resolve(url)
    arguments[1] = local || url
    return xopen.apply(this, arguments)
  }
  function patchSrc(proto, attr) {
    var d = Object.getOwnPropertyDescriptor(proto, attr)
    if (!d || !d.set) return
    Object.defineProperty(proto, attr, {
      get: d.get,
      set: function (v) { d.set.call(this, resolve(v) || v) },
      configurable: true,
    })
  }
  ;[[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src']].forEach(function (x) { patchSrc(x[0].prototype, x[1]) })
  var setAttr = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (n, v) {
    if ((n === 'src' || n === 'href') && typeof v === 'string' && !(this instanceof HTMLAnchorElement)) v = resolve(v) || v
    return setAttr.call(this, n, v)
  }

  // links: other html in the package opens that activity, http(s) opens the browser.
  // installed after document.write (document.open drops document listeners)
  function installLinks() { document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]')
    if (!a) return
    var href = a.getAttribute('href')
    if (!href || href.charAt(0) === '#') return
    e.preventDefault()
    var p = pathOf(href)
    if (p != null) call('intent.startpath', [p])
    else droid.intent.start({ action: 'view', data: new URL(href, base).href })
  }, true) }

  // ---- droid keyboard: text fields ask the shell for it, keys come back as "ime" events ----
  // no text selection outside text fields (like android views)
  function installIme(on) {
    var st = document.createElement('style')
    st.textContent = 'html{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}input,textarea,[contenteditable],[contenteditable] *{-webkit-user-select:text;user-select:text}'
    document.head.appendChild(st)
    if (!on) return
    var TEXTY = /^(text|search|email|url|tel|number|password)$/
    var cur = null
    function ok(el) { return el && ((el.tagName === 'INPUT' && TEXTY.test(el.type)) || el.tagName === 'TEXTAREA') && !el.readOnly && !el.disabled }
    function kind(el) {
      var m = el.getAttribute('inputmode') || '', t = el.type
      if (m === 'numeric' || m === 'decimal' || t === 'number') return 'number'
      if (m === 'tel' || t === 'tel') return 'phone'
      if (m === 'email' || t === 'email') return 'email'
      if (m === 'url' || t === 'url') return 'url'
      if (t === 'password') return 'password'
      return 'text'
    }
    function before(el) { try { return el.value.slice(0, el.selectionStart == null ? el.value.length : el.selectionStart) } catch (e) { return el.value } }
    document.addEventListener('focusin', function (e) {
      var el = e.target
      if (!ok(el)) return
      cur = el
      var k = kind(el)
      el.setAttribute('inputmode', 'none')
      var h = (el.getAttribute('enterkeyhint') || '').toLowerCase()
      var ac = el.getAttribute('autocapitalize')
      call('ime.show', [{ kind: k, enter: /^(go|search|send|next|done)$/.test(h) ? h : el.type === 'search' ? 'search' : 'enter', multiline: el.tagName === 'TEXTAREA', autocap: k === 'text' && ac !== 'none' && ac !== 'off' }])
      call('ime.text', [before(el)])
    })
    document.addEventListener('focusout', function (e) { if (e.target === cur) { cur = null; call('ime.hide', []) } })
    droid.on('ime', function (k) {
      var el = cur
      if (!el) return
      if (k.enter) {
        ['keydown', 'keypress', 'keyup'].forEach(function (t) { el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })) })
        if (el.form && el.form.requestSubmit) el.form.requestSubmit()
        return
      }
      var s, end, v = el.value
      try { s = el.selectionStart == null ? v.length : el.selectionStart; end = el.selectionEnd == null ? s : el.selectionEnd } catch (x) { s = end = v.length }
      if (k.del) {
        if (s === end) { if (s === 0) return; s -= /[\udc00-\udfff]/.test(v[s - 1]) && s > 1 ? 2 : 1 }
        el.value = v.slice(0, s) + v.slice(end)
        try { el.setSelectionRange(s, s) } catch (x) {}
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
      } else {
        var t = k.text || ''
        if (el.maxLength > 0 && v.length - (end - s) + t.length > el.maxLength) return
        el.value = v.slice(0, s) + t + v.slice(end)
        try { el.setSelectionRange(s + t.length, s + t.length) } catch (x) {}
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: t }))
      }
      call('ime.text', [before(el)])
    })
  }

  // ---- building the page ----
  var JS = /\.m?js$/
  function rewriteJs(text, path) {
    // relative import specifiers -> absolute fake urls, which the import map turns into blob urls
    return text.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, function (m, pre, q, spec) {
      return pre + q + new URL(spec, base0 + path).href + q
    })
  }
  function rewriteCss(text, path) {
    return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
      if (/^(data:|blob:|#)/.test(u)) return m
      var p = pathOf(new URL(u, base0 + path).href)
      return p != null && files[p] ? 'url("' + files[p] + '")' : m
    })
  }
  var base0 = ''
  function build(msg) {
    info = msg.info
    base0 = 'https://dpk.invalid/' + info.id + '/'
    var entryDir = msg.entry.indexOf('/') >= 0 ? msg.entry.replace(/[^/]+$/, '') : ''
    base = base0 + entryDir
    var raw = msg.files // path -> {bytes, type}
    var dec = new TextDecoder()
    var paths = Object.keys(raw)
    // css first needs image urls, js needs nothing but the map: do binaries, then css, then js
    paths.sort(function (a, b) { return rank(a) - rank(b) })
    function rank(p) { return /\.css$/.test(p) ? 1 : JS.test(p) ? 2 : 0 }
    var imports = {}
    paths.forEach(function (p) {
      var f = raw[p]
      var data = f.bytes
      if (/\.css$/.test(p)) data = rewriteCss(dec.decode(f.bytes), p)
      else if (JS.test(p)) data = rewriteJs(dec.decode(f.bytes), p)
      files[p] = URL.createObjectURL(new Blob([data], { type: f.type }))
      if (JS.test(p)) imports[base0 + p] = files[p]
    })
    var html = dec.decode(raw[msg.entry].bytes)
    var doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('[src],[href]').forEach(function (el) {
      var attr = el.hasAttribute('src') ? 'src' : 'href'
      if (el.tagName === 'A') return
      var v = el.getAttribute(attr)
      if (el.tagName === 'SCRIPT' && el.type === 'module') {
        // module entry: import it by its fake url so its relative imports work through the map
        var abs = new URL(v, base).href
        el.removeAttribute('src')
        el.textContent = 'import ' + JSON.stringify(abs)
        return
      }
      var r = resolve(v)
      if (r) el.setAttribute(attr, r)
    })
    doc.querySelectorAll('script[type=module]:not([src])').forEach(function (s) { s.textContent = rewriteJs(s.textContent, msg.entry) })
    doc.querySelectorAll('style').forEach(function (s) { s.textContent = rewriteCss(s.textContent, msg.entry) })
    doc.querySelectorAll('[style]').forEach(function (el) { el.setAttribute('style', rewriteCss(el.getAttribute('style'), msg.entry)) })
    var head = doc.head
    var csp = doc.createElement('meta')
    csp.httpEquiv = 'Content-Security-Policy'
    csp.content = msg.csp
    var b = doc.createElement('base')
    b.href = base
    var map = doc.createElement('script')
    map.type = 'importmap'
    map.textContent = JSON.stringify({ imports: imports })
    // the holo look and roboto, straight from the shell's static assets (allowed by the csp)
    ;(msg.links || []).slice().reverse().forEach(function (href) {
      var l = doc.createElement('link')
      l.rel = 'stylesheet'
      l.href = href
      head.insertBefore(l, head.firstChild)
    })
    head.insertBefore(map, head.firstChild)
    head.insertBefore(b, head.firstChild)
    head.insertBefore(csp, head.firstChild)
    doc.documentElement.classList.add(msg.theme)
    var out = '<!doctype html>' + doc.documentElement.outerHTML
    document.open()
    document.write(out)
    document.close()
    window.droid = droid
    installLinks()
    installIme(msg.ime)
    // create fires once the page's own scripts ran (modules run deferred, so wait for load)
    var fire = function () { emit('create', msg.saved); port.postMessage({ ready: true }) }
    if (document.readyState === 'complete') setTimeout(fire, 0)
    else window.addEventListener('load', function () { setTimeout(fire, 0) })
  }

  window.droid = droid
  window.addEventListener('message', function boot(e) {
    if (e.source !== parent || !e.data || e.data.type !== 'droid:boot') return
    window.removeEventListener('message', boot)
    port = e.ports[0]
    port.onmessage = onPortMessage
    build(e.data)
  })
})()
