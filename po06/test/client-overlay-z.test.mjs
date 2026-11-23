import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/**
 * issue #18：浮层不许与右侧栏（图片等预览栏）重合 —— 右侧栏出现后要被"挤进"会话窗。
 * 这里是**假 DOM**：视口 1200×900，会话窗（输入卡片）只到 900，右边 300 就是侧栏的地盘。
 * 假 DOM 存在的意义是把"边界取谁、怎么夹紧"钉成可核对的几何契约（真机观感仍要人看）。
 */
function load(doc) {
  const observers = { mutation: [], resize: [] }
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.options = null; observers.mutation.push(this) }
    observe(target, options) { this.target = target; this.options = options }
    disconnect() { this.disconnected = true }
  }
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; this.targets = []; observers.resize.push(this) }
    observe(el) { this.targets.push(el) }
    disconnect() { this.disconnected = true; this.targets = [] }
  }
  const regs = []
  const win = {
    __ModuleLoader__: { load: (r) => regs.push(r) }, innerWidth: 1200, innerHeight: 900,
    getComputedStyle: (el) => ({ position: (el && el.__position) || 'static', ...(el && el.__style ? el.__style : {}) }),
    setTimeout: (fn) => { fn(); return 0 },
    addEventListener: () => {}, removeEventListener: () => {},
  }
  const React = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f() }
  const req = (n) => (n === 'react' ? React : {})
  new Function('window', 'require', 'document', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', source)(win, req, doc, FakeMutationObserver, FakeResizeObserver, (fn) => fn())
  const mod = regs[0].factory(req)
  mod.apply({ slots: { register: () => () => {}, inject: (s, cb) => cb() }, locale: 'en' })
  return { d: mod.__debug, observers }
}

// 假 DOM：document.body.children 是侧栏探测的扫描对象；卡片用 parentElement 串起来。
function fakeDoc({ sidebar = null, cardLeft = 100, cardRight = 900, editable = 'true' } = {}) {
  const body = { children: sidebar ? [sidebar] : [] }
  const card = {
    querySelector: (sel) => (sel.includes('contenteditable') && editable !== 'false' ? {} : null),
    getBoundingClientRect: () => ({ left: cardLeft, right: cardRight, width: cardRight - cardLeft, top: 0, bottom: 700 }),
    parentElement: body,
  }
  return { body, card, node: { parentElement: card } }
}
const fakeSidebar = (left, { position = 'fixed', attrs = {} } = {}) => ({
  __position: position,
  getAttribute: (k) => (k in attrs ? attrs[k] : null),
  contains: () => false,
  getBoundingClientRect: () => ({ left, right: 1200, width: 1200 - left, top: 0, bottom: 900, height: 900 }),
})

// ── 层级（上一轮的兜底，保留）────────────────────────────────────────────
const SIDEBAR_FLOATING = 90    // dsh-better-sidebar 的 FloatingWindow.module.css
const APP_OVERLAY_STACK = 100  // 宿主 overlay stack
test('所有浮层层级都高于边栏浮窗与 app overlay stack（issue #18）', () => {
  const { d } = load(fakeDoc())
  const z = d.overlayZIndex
  assert.ok(z && typeof z === 'object', '层级表要能从 __debug 读到（单一来源，不散落在样式里）')
  for (const [name, value] of Object.entries(z)) {
    assert.equal(typeof value, 'number', name + ' 必须是数字')
    assert.ok(value > APP_OVERLAY_STACK, name + ' 必须高于 app overlay stack(' + APP_OVERLAY_STACK + ')，实际 ' + value)
    assert.ok(value > SIDEBAR_FLOATING, name + ' 必须高于边栏浮窗(' + SIDEBAR_FLOATING + ')，实际 ' + value)
  }
  assert.ok(z.pop < z.help, '选项弹层应低于帮助弹层')
  assert.ok(z.help < z.panel, '帮助应低于设置面板')
  assert.ok(z.panel < z.ov, '设置面板应低于拦截浮层')
  assert.ok(z.ov < z.ball, '拦截浮层应低于悬浮球')
})

// ── 会话窗就是约束边界 ───────────────────────────────────────────────────
test('量到的会话窗就是约束边界（右侧栏那一段不算在内）', () => {
  const dom = fakeDoc()
  const { d } = load(dom)
  const rg = d.composerRegion(dom.node)
  assert.equal(rg.source, 'composer-card', '能量到输入卡片就该用它当边界')
  assert.equal(rg.left, 100); assert.equal(rg.right, 900); assert.equal(rg.w, 800)
  const full = d.composerRegion(null)
  assert.equal(full.source, 'viewport'); assert.equal(full.right, 1200, '量不到 ⇒ 退回视口，绝不因此不显示')
  const narrow = fakeDoc({ cardLeft: 860, cardRight: 900 })
  assert.equal(load(narrow).d.composerRegion(narrow.node).source, 'viewport', '过窄读数不可信')
})

// Model only the measured host rectangles, not React or browser layout.
function conversationFixture() {
  const dom = fakeDoc({ cardLeft: 320, cardRight: 1020 })
  const layout = { left: 288.4, right: 1054.6, top: 143.25, bottom: 730.75, handlesVisible: true }
  dom.card.getBoundingClientRect = () => ({ left: 320, right: 1020, width: 700, top: layout.bottom })
  const handle = side => ({ getBoundingClientRect: () => ({
    width: layout.handlesVisible ? 10 : 0, [side === 'left' ? 'right' : 'left']: layout[side],
  }) })
  const handles = { left: handle('left'), right: handle('right') }
  const content = {
    getBoundingClientRect: () => ({ top: layout.top, width: 1000 }),
    querySelector: selector => handles[selector.match(/"(left|right)"/)?.[1]],
  }
  const scroll = {}, seat = {}
  const closest = {
    '[data-conversation-content]': content, '[data-composer-card]': dom.card,
    '[data-conversation-scroll]': scroll, '[data-composer-seat]': seat,
  }
  dom.node.closest = selector => closest[selector]
  return { dom, layout, content, scroll, seat, handles }
}
const xywh = ({ x, y, w, h }) => ({ x, y, w, h })

test('the host handle inner edges, tabs divider and composer top bound even the default popup', () => {
  const { dom, content, scroll, seat, handles } = conversationFixture()
  const { d } = load(dom)
  const r = d.interceptBounds(dom.node)
  assert.deepEqual([r.left, r.right, r.top, r.bottom], [289, 1054, 144, 730])
  assert.deepEqual([...r.nodes], [dom.node, content, scroll, seat, dom.card, handles.left, handles.right])
  assert.deepEqual(xywh(d.fitIntercept(r, null, {}, 320)), { x: 574, y: 156, w: 460, h: 320 })
})

test('dragging past any corner stops against both edges, not the viewport', () => {
  const { dom } = conversationFixture()
  const { d } = load(dom)
  const r = d.interceptBounds(dom.node)
  for (const [x, y] of [[-500, -500], [-500, 5000], [5000, -500], [5000, 5000]]) {
    const p = d.fitIntercept(r, { x, y }, {}, 360)
    assert.equal(p.x, x < 0 ? r.left : r.right - p.w)
    assert.equal(p.y, y < 0 ? r.top : r.bottom - p.h)
    assert.ok(p.y + p.heightLimit <= r.bottom, 'auto-height growth cannot cross composer before remeasurement')
  }
})

test('resize keeps the top-left fixed, then reflow shrinks and repositions inside changed host edges', () => {
  const { dom, layout } = conversationFixture()
  const { d } = load(dom)
  const start = { x: 560, y: 390 }
  const r = d.interceptBounds(dom.node)
  const resized = d.fitIntercept(r, start, { w: 2000, h: 2000 }, 0, true)
  assert.deepEqual(xywh(resized), { x: 560, y: 390, w: 494, h: 340 })
  // The viewport stays unchanged; host width handles move and the composer grows.
  Object.assign(layout, { left: 530, right: 900, top: 180, bottom: 350 })
  const next = d.interceptBounds(dom.node)
  assert.deepEqual(xywh(d.fitIntercept(next, resized, resized, 0)), { x: 530, y: 180, w: 370, h: 170 })
  assert.deepEqual(xywh(d.fitIntercept(next, resized, {}, 880)), { x: 530, y: 180, w: 370, h: 170 })
})

test('absent or hidden width handles fall back to the owning card without losing the vertical edges', () => {
  const { dom, layout } = conversationFixture()
  const { d } = load(dom)
  layout.handlesVisible = false
  const r = d.interceptBounds(dom.node)
  assert.deepEqual([r.left, r.right, r.top, r.bottom], [320, 1020, 144, 730])
  dom.node.isConnected = false
  assert.equal(d.fitIntercept(d.interceptBounds(dom.node), null, {}, 320).visible, false)
})

test('悬浮球 fallback 不落在侧栏那一段', () => {
  const dom = fakeDoc()
  const { d } = load(dom)
  const r = d.composerRegion(dom.node)
  assert.equal(d.defaultBallPos(r).x, r.right - 76)
  assert.equal(d.defaultBallPos({ left: 0, right: 1200 }).x, 1200 - 76)
})

test('legacy inline positioning can still detect the fixed containing block (issue #51 / PR53)', () => {
  const dom = fakeDoc()
  dom.card.parentElement = {
    __style: { willChange: 'transform' },
    parentElement: dom.body,
    getBoundingClientRect: () => ({ left: 280, top: 652, width: 993, height: 170 }),
  }
  assert.deepEqual(load(dom).d.ovContainingBox(dom.node), { x: 280, y: 652, w: 1200, h: 900 })
})

// ── 右侧栏可能是固定浮层（不压缩会话列）────────────────────────────────────
test('固定右侧栏（不压缩会话列）同样能把浮层挤进来', () => {
  const dom = fakeDoc({ sidebar: fakeSidebar(980), cardRight: 1100 })
  const { d } = load(dom)
  const rg = d.composerRegion(dom.node)
  assert.equal(rg.right, 980, '右缘取 min(卡片右缘, 固定侧栏左缘)')
  assert.equal(rg.source, 'composer-card+sidebar', '要如实标出这次是靠侧栏探测收到的边界')
  const p = d.fitIntercept(d.interceptBounds(dom.node), { x: 760, y: 96 }, {}, 320)
  assert.equal(p.x + p.w, 980, '面板右缘落在侧栏左边，不重合')
})

test('侧栏探测宁可漏认也不误认：非 fixed / 太窄 / 太矮 / 自己的节点都不算', () => {
  const cases = [
    [{ sidebar: fakeSidebar(980, { position: 'relative' }), cardRight: 1100 }, '非 fixed 不算'],
    [{ sidebar: fakeSidebar(1150), cardRight: 1100 }, '太窄（<160）不算'],
    [{ sidebar: fakeSidebar(980, { attrs: { 'data-po06': 'panel' } }), cardRight: 1100 }, '我们自己的浮层不算'],
    [{ sidebar: null, cardRight: 1100 }, '没有侧栏时仍按卡片'],
  ]
  for (const [opts, why] of cases) {
    const dom = fakeDoc(opts)
    assert.equal(load(dom).d.composerRegion(dom.node).source, 'composer-card', why)
  }
})

// ── contenteditable 的写法容错 ───────────────────────────────────────────
test('contenteditable 的其它合法写法也要能认出输入卡片', () => {
  for (const value of ['true', '', 'plaintext-only']) {
    const dom = fakeDoc({ editable: value })
    assert.equal(load(dom).d.composerRegion(dom.node).source, 'composer-card', 'contenteditable=' + JSON.stringify(value) + ' 也要认')
  }
  const off = fakeDoc({ editable: 'false' })
  assert.equal(load(off).d.composerRegion(off.node).source, 'viewport', '显式 false 不算可编辑')
})

// ── 重算触发点：三条都要接 ───────────────────────────────────────────────
test('属性显隐（class/style/hidden）也能触发重算，且卡片被换掉后会重新盯上新卡片', () => {
  const dom = fakeDoc()
  const { d, observers } = load(dom)
  let calls = 0
  const off = d.ovReflowWatch(() => { calls += 1 }, dom.node)
  const mo = observers.mutation[0]
  assert.ok(mo, '要挂上 MutationObserver')
  assert.equal(mo.options.childList, true)
  assert.equal(mo.options.attributes, true, '属性变化必须观察到（侧栏可能只是切 class/hidden）')
  assert.ok(mo.options.attributeFilter.includes('class') && mo.options.attributeFilter.includes('hidden'), '过滤表要含 class/hidden')
  assert.equal(mo.options.subtree, true, '侧栏节点可能不在 body 直属层，要带 subtree')
  const before = calls
  mo.cb()
  assert.ok(calls > before, '触发后必须真的重算')
  const oldCard = observers.resize[0].targets[0]
  const newCard = fakeDoc({}).card
  dom.node.parentElement = newCard
  d.ovReflowAll()
  const ro = observers.resize[observers.resize.length - 1]
  assert.notEqual(ro.targets[0], oldCard, '换了卡片之后不该还盯着旧节点')
  assert.equal(ro.targets[0], newCard, '要盯上新卡片')
  off()
})

test('样式表里不再残留旧的 60/70/80/88 硬编码层级', () => {
  for (const legacy of ['zIndex: 60', 'zIndex: 70', 'zIndex: 80', 'zIndex: 88']) {
    assert.ok(!source.includes(legacy), '不该再有硬编码的 ' + legacy + '（应统一引用层级表）')
  }
})
