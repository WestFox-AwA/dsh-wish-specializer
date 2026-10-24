// issue #37：用依赖项识别并驱动真实 ControlBar 的提示决策与 DOM effect。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

function load(data) {
  const registrations = []
  const notices = []
  const doc = {
    createElement: () => {
      const attributes = {}
      return {
        style: {}, appendChild() {},
        setAttribute(name, value) { attributes[name] = value },
        getAttribute: (name) => attributes[name] ?? null,
      }
    },
    body: {
      appendChild(element) {
        if (element.getAttribute('data-po06') === 'preset-notice-backdrop') notices.push(element)
      },
    },
  }
  const win = {
    __ModuleLoader__: { load: (entry) => registrations.push(entry) },
    addEventListener() {}, removeEventListener() {},
    setInterval() { return 1 }, clearInterval() {}, setTimeout() { return 1 }, clearTimeout() {},
    setTimeout() { return 1 }, clearTimeout() {},
  }
  const states = new Map()
  const effects = []
  let stateIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    useState(initial) {
      const index = stateIndex++
      if (!states.has(index)) states.set(index, typeof initial === 'function' ? initial() : initial)
      return [states.get(index), (value) => states.set(index, typeof value === 'function' ? value(states.get(index)) : value)]
    },
    useRef: (current) => ({ current }),
    useEffect: (effect, deps) => effects.push({ effect, deps }),
    useLayoutEffect: (effect, deps) => effects.push({ effect, deps }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const require = (name) => name === 'react' ? React : {}
  new Function('window', 'require', 'document', 'CustomEvent', 'fetch', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', source)(
    win, require, doc, globalThis.CustomEvent, async () => { throw new Error('unexpected fetch') },
    class { observe() {} disconnect() {} }, class { observe() {} disconnect() {} }, () => 0)
  const mod = registrations[0].factory(require)
  mod.apply({ slots: { register: () => () => {}, inject: (_name, cb) => cb() }, locale: 'en' })
  function render() {
    stateIndex = 0
    mod.__debug.ControlBar({ sessionId: 'session-1', inputActions: {} })
  }
  function decisionEffect() {
    const matches = effects.filter(({ effect, deps }) => deps?.length === 3 && deps[0] === 'session-1' && deps[2] === data?.settings?.presetNoticeDismissed && effect.toString().includes('intro: true'))
    assert.ok(matches.length >= 1, '必须找到目标提示 effect')
    return matches.at(-1).effect
  }
  // 只提供生产 useStatus 的快照，不执行网络轮询；其余真实 hooks 全部照常运行。
  states.set(0, { data, error: null })
  render()
  return {
    notices,
    decide() { decisionEffect()() },
    showNotice() {
      const before = effects.length
      render()
      const matches = effects.slice(before).filter(({ deps }) => deps?.length === 1 && deps[0]?.preset === '' && deps[0]?.intro === true)
      assert.equal(matches.length, 1, 'notice 状态更新后必须注册对应的 DOM effect')
      matches[0].effect()
    },
  }
}

test('issue #37：首个 status 快照未到时不抢先弹，dismissed 到达后也不弹', () => {
  const pending = load(null)
  pending.decide()
  assert.equal(pending.notices.length, 0, '未知不能当成未关闭')
  const dismissed = load({ settings: { presetNoticeDismissed: true } })
  dismissed.decide()
  assert.equal(dismissed.notices.length, 0, '已关闭的快照到达后也不能弹')
  dismissed.decide()
  assert.equal(dismissed.notices.length, 0, '后续决策不得翻回弹窗')
})

test('issue #37：首个快照明确未关闭时仍提示一次，不永久抑制新用户提示', () => {
  const pending = load(null)
  pending.decide()
  assert.equal(pending.notices.length, 0)
  const visible = load({ settings: { presetNoticeDismissed: false } })
  visible.decide()
  visible.showNotice()
  assert.equal(visible.notices.length, 1, '首个真实快照未关闭时必须仍提示新用户')
  visible.decide()
  assert.equal(visible.notices.length, 1, '不得每次 status 轮询都重复提示')
})
