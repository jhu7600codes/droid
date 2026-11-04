// calculator, after the kitkat aosp calculator: big display, digit pad, operator column,
// advanced panel (swipe left or the menu). its own expression parser, no eval.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { h, pressable } from '../../shell/ui'
import './calculator.css'

const FN: Record<string, (x: number) => number> = { sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log: Math.log10, '√︎': Math.sqrt }
const fact = (n: number): number => (n < 0 || !Number.isInteger(n) ? NaN : n > 170 ? Infinity : n <= 1 ? 1 : n * fact(n - 1))

// shunting yard over tokens; unary minus, implicit multiply before ( and functions
export function evaluate(src: string): number {
  const toks = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').match(/\d*\.?\d+(e[+-]?\d+)?|sin|cos|tan|ln|log|√︎|π|e|[-+*/^()!%]/g) || []
  let i = 0
  const peek = () => toks[i], next = () => toks[i++]
  function primary(): number {
    const t = next()
    if (t === undefined) throw new Error('end')
    if (t === '-') return -power()
    if (t === '+') return power()
    if (t === '(') { const v = expr(); if (peek() === ')') next(); return v }
    if (t === 'π') return Math.PI
    if (t === 'e') return Math.E
    if (FN[t]) return FN[t](t === '√︎' ? power() : primary())
    const n = parseFloat(t)
    if (isNaN(n)) throw new Error('bad')
    return n
  }
  function postfix(): number {
    let v = primary()
    for (;;) {
      if (peek() === '!') { next(); v = fact(v) }
      else if (peek() === '%') { next(); v = v / 100 }
      else if (peek() && /^[\d.(πe]|^(sin|cos|tan|ln|log|√︎)$/.test(peek()!)) v *= primary() // 2π, 3(4)
      else return v
    }
  }
  function power(): number { const b = postfix(); if (peek() === '^') { next(); return Math.pow(b, power()) } return b }
  function term(): number { let v = power(); while (peek() === '*' || peek() === '/') v = next() === '*' ? v * power() : v / power(); return v }
  function expr(): number { let v = term(); while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term(); return v }
  const v = expr()
  if (i < toks.length) throw new Error('bad')
  return v
}
const show = (n: number) => (!isFinite(n) || isNaN(n) ? 'Error' : String(+n.toPrecision(12)).replace('-', '−'))

function calculator(ctx: ActivityContext): Activity {
  let text = ''
  let done = false
  const input = h('div.calc-in')
  const result = h('div.calc-out')
  const disp = h('div.calc-display', {}, input, result)
  const live = () => {
    input.textContent = text
    input.scrollLeft = input.scrollWidth
    try { result.textContent = text && /[-+×÷^!%(]/.test(text) ? show(evaluate(text)) : '' } catch { result.textContent = '' }
  }
  const press = (k: string) => {
    if (k === '=') { try { text = show(evaluate(text)); done = true } catch { result.textContent = 'Error' } ; input.textContent = text; result.textContent = ''; return }
    if (k === 'DEL') { text = done ? '' : text.slice(0, -1); done = false; return live() }
    if (k === 'CLR') { text = ''; done = false; return live() }
    if (done && /[\d.πe]/.test(k)) text = ''
    done = false
    text += ['sin', 'cos', 'tan', 'ln', 'log'].includes(k) ? k + '(' : k
    live()
  }
  const key = (k: string, cls = '') => pressable(h('div.calc-key' + cls, { onclick: () => press(k) }, k === 'DEL' ? 'DEL' : k))
  const digits = h('div.calc-digits', {}, ...['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '='].map((k) => key(k)))
  const ops = h('div.calc-ops', {}, key('DEL'), key('÷'), key('×'), key('−'), key('+'))
  const adv = h('div.calc-adv', {}, ...['sin', 'cos', 'tan', 'ln', 'log', '!', 'π', 'e', '^', '(', ')', '√︎'].map((k) => key(k, '.adv')))
  const pad = h('div.calc-pad', {}, digits, ops, adv)
  // long press on DEL clears, like kitkat
  let t = 0
  ops.firstChild!.addEventListener('pointerdown', () => (t = window.setTimeout(() => press('CLR'), 500)))
  ops.firstChild!.addEventListener('pointerup', () => clearTimeout(t))
  let x0 = 0
  pad.addEventListener('pointerdown', (e) => (x0 = e.clientX))
  pad.addEventListener('pointerup', (e) => { if (e.clientX - x0 < -60) pad.classList.add('show-adv'); if (e.clientX - x0 > 60) pad.classList.remove('show-adv') })
  const onKey = (e: KeyboardEvent) => {
    const m: Record<string, string> = { '*': '×', '/': '÷', '-': '−', Enter: '=', Backspace: 'DEL', Escape: 'CLR' }
    const k = m[e.key] || e.key
    if (/^[\d.+×÷−=^()!%]$|^DEL$|^CLR$/.test(k)) { e.preventDefault(); press(k) }
  }
  ctx.root.append(h('div.app.calc', {}, disp, pad))
  return {
    resume: () => addEventListener('keydown', onKey),
    pause: () => { removeEventListener('keydown', onKey); return undefined },
    menu: () => pad.classList.toggle('show-adv'),
    back: () => { if (pad.classList.contains('show-adv')) { pad.classList.remove('show-adv'); return true } return false },
  }
}

const app: SystemApp = {
  manifest: {
    id: 'droid.calculator', name: 'Calculator', version: '4.4', versioncode: 19, type: 'web', main: 'calc',
    activities: { calc: { label: 'Calculator', launcher: true } }, system: true, supports: ['phone', 'tablet', 'desktop'],
  },
  icon: '',
  iconRef: ['apps/calculator', 'ic_launcher_calculator'],
  activities: { calc: calculator },
}
export default app
