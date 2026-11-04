// page mode url rewriting. proxied urls look like  /p/<sid>/<scheme>/<host[:port]>/<path>?<query>
// so relative urls inside a page resolve to the same proxied site on their own; only absolute and
// root-relative urls need rewriting. js is not rewritten on the server; the injected shim handles it.

export function toProxy(raw, pageUrl, sid) {
  if (!raw) return raw
  const s = raw.trim()
  if (/^(#|javascript:|data:|blob:|mailto:|tel:|about:)/i.test(s)) return raw
  let u
  try { u = new URL(s, pageUrl) } catch { return raw }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw
  return `/p/${sid}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`
}

// /p/<sid>/https/example.com/a/b?c -> { sid, url }
export function fromProxy(pathAndQuery) {
  const m = pathAndQuery.match(/^\/p\/([A-Za-z0-9_-]+)\/(https?)\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?/)
  if (!m) return null
  return { sid: m[1], url: `${m[2]}://${m[3]}${m[4] || '/'}${m[5] || ''}` }
}

export function rewriteCss(css, base, sid) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, q, u) => `url(${q}${toProxy(u, base, sid)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/g, (all, q, u) => `@import ${q}${toProxy(u, base, sid)}${q}`)
}

const ATTR = /(<[a-zA-Z][^>]*?\s)(href|src|action|poster|data|formaction|background)(\s*=\s*)(["'])(.*?)\4/gs
const SRCSET = /(<[a-zA-Z][^>]*?\s(?:srcset|imagesrcset)\s*=\s*)(["'])(.*?)\2/gs

export function rewriteHtml(html, pageUrl, sid, shim) {
  let out = html
    // policies inside the page would block the rewritten urls and the shim
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/\sintegrity\s*=\s*(["']).*?\1/gi, '')
    .replace(ATTR, (all, pre, name, eq, q, val) => `${pre}${name}${eq}${q}${toProxy(val.replace(/&amp;/g, '&'), pageUrl, sid).replace(/&/g, '&amp;')}${q}`)
    .replace(SRCSET, (all, pre, q, val) => `${pre}${q}${val.split(',').map((part) => { const [u, ...rest] = part.trim().split(/\s+/); return [toProxy(u, pageUrl, sid), ...rest].join(' ') }).join(', ')}${q}`)
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (all, a, css, b) => a + rewriteCss(css, pageUrl, sid) + b)
    .replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/gs, (all, pre, q, css) => pre + q + rewriteCss(css, pageUrl, sid) + q)
  const tag = `<script>${shim}</script>`
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + tag)
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => m + tag)
  else out = tag + out
  return out
}

// runs inside proxied pages: keeps js-made requests in the proxy and tells the browser app
// what is going on (url, title, icon). parent is the droid browser.
export function shimFor(sid, target) {
  return `(function(){
var SID=${JSON.stringify(sid)}, TARGET=${JSON.stringify(target)};
function toP(u){try{var a=new URL(u,TARGET);if(a.protocol!=='http:'&&a.protocol!=='https:')return u;if(a.origin===location.origin)return u;return '/p/'+SID+'/'+a.protocol.slice(0,-1)+'/'+a.host+a.pathname+a.search+a.hash}catch(e){return u}}
var f=window.fetch;window.fetch=function(i,o){if(typeof i==='string'||i instanceof URL)i=toP(String(i));else if(i&&i.url)i=new Request(toP(i.url),i);return f.call(this,i,o)};
var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=toP(u);return xo.apply(this,arguments)};
function ps(p,a){var d=Object.getOwnPropertyDescriptor(p,a);if(!d||!d.set)return;Object.defineProperty(p,a,{get:d.get,set:function(v){d.set.call(this,toP(v))},configurable:true})}
[[HTMLImageElement,'src'],[HTMLScriptElement,'src'],[HTMLLinkElement,'href'],[HTMLMediaElement,'src'],[HTMLSourceElement,'src'],[HTMLIFrameElement,'src']].forEach(function(x){ps(x[0].prototype,x[1])});
var sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if(/^(src|href|action)$/i.test(n)&&typeof v==='string')v=toP(v);return sa.call(this,n,v)};
var WS=window.WebSocket;window.WebSocket=function(u,p){var a=new URL(u,TARGET.replace(/^http/,'ws'));return new WS((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws?sid='+SID+'&url='+encodeURIComponent(a.href),p)};window.WebSocket.prototype=WS.prototype;
window.open=function(u){parent.postMessage({droid:'open',url:new URL(u,TARGET).href},'*');return null};
var DL=/\.(apk|dpk|zip|7z|rar|tar|gz|pdf|mp3|ogg|wav|mp4|webm|exe|bin|img|iso)$/i;
addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a||e.defaultPrevented)return;var u;try{u=new URL(a.getAttribute('href'),cur())}catch(x){return}
if(!a.hasAttribute('download')&&!DL.test(u.pathname))return;if(u.protocol!=='http:'&&u.protocol!=='https:')return;e.preventDefault();parent.postMessage({droid:'download',url:u.href,name:a.getAttribute('download')||''},'*')},true);
var hp=history.pushState,hr=history.replaceState;
function cur(){var m=location.pathname.match(/^\\/p\\/[^/]+\\/(https?)\\/([^/]+)(.*)$/);return m?m[1]+'://'+m[2]+(m[3]||'/')+location.search+location.hash:TARGET}
function report(){var l=document.querySelector('link[rel~="icon"]');parent.postMessage({droid:'page',url:cur(),title:document.title,icon:l?l.href:''},'*')}
history.pushState=function(){hp.apply(this,arguments);report()};history.replaceState=function(){hr.apply(this,arguments);report()};
addEventListener('DOMContentLoaded',report);addEventListener('load',function(){report();parent.postMessage({droid:'loaded'},'*')});
addEventListener('beforeunload',function(){parent.postMessage({droid:'loading'},'*')});
addEventListener('message',function(e){if(e.source!==parent||!e.data)return;var d=e.data;if(d.cmd==='back')history.back();if(d.cmd==='forward')history.forward();if(d.cmd==='find'&&window.find)window.find(d.q)});
})();`
}

// a document navigation that is really a file (attachment, apk, dpk, binary): the droid browser
// downloads it itself, so the frame gets a tiny page that hands the url over
const DL_TYPES = /^(application\/(octet-stream|vnd\.android\.package-archive|x-dpk|zip|x-zip-compressed|pdf|x-7z-compressed|x-rar-compressed|gzip|x-tar))/i
export function downloadName(url, headers) {
  const cd = headers.get('content-disposition') || ''
  const type = headers.get('content-type') || ''
  const path = new URL(url).pathname
  if (!/attachment/i.test(cd) && !DL_TYPES.test(type) && !/\.(apk|dpk)$/i.test(path)) return null
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i)
  try { return (m ? decodeURIComponent(m[1]) : decodeURIComponent(path.split('/').pop() || '')) || 'download' } catch { return 'download' }
}
export function downloadPage(url, name) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:Roboto,sans-serif;margin:24px;color:#222;background:#fff">Downloading ${name.replace(/[&<>"]/g, '')}…<script>parent.postMessage({droid:'download',url:${JSON.stringify(url)},name:${JSON.stringify(name)},back:true},'*')</script>`
}
