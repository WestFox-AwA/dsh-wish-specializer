// P11 · **轮次之间不遗传**（用户 2026-09-21 拍板："每次优化都自动根据上下文还有原提示词，
// 独立产生目标，而不是遗传目标"）。
//
// 运行：node po06/test/no-inherit.test.mjs
//
// 背景（真机）：坦克会话第三轮的原话只有"检查坦克还有无问题"，但注入出去的包里仍带着前两轮
// 早已解决的问题与过时的【未决项】。真因两条：
//   ① 旧 `advance_turn` 只退役 `scope:'turn'` 的条目 ⇒ 默认 `task` 的条目**永远 active**；
//   ② 解释层当时**只能加不能销** ⇒ 状态只增不减 ⇒ 每轮重编译都把历史条目重新写进包。
// 现在：推进轮次 = **上一轮整体退场**（退成 `stale`，不删除、留档可追溯），
// 本轮由解释层按「本轮原话 + 会话上下文」**独立重新产生**目标。
import { reduce, activeItems } from '../lib/reducer.js'
import { createState } from '../lib/schema.js'
import { compileAudited } from '../lib/compiler.js'

let pass = 0
const failures = []
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy') }
function eq(a, b, what) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${what || 'value'}: expected ${y}, got ${x}`) }
function t(name, fn) { try { fn(); pass += 1 } catch (e) { failures.push({ name, error: String(e.message || e) }) } }

const sid = 'session-test'
const commit = (state, ops, cause) => {
  const r = reduce(state, { causeId: cause, baseRevision: state.revision, baseInputRevision: state.lastInputRevision, sessionId: sid, ops })
  if (!r.ok) throw new Error(cause + ' rejected: ' + r.code + ' ' + r.reason)
  return r.state
}
const advance = (state, turnId) => commit(state, [{ op: 'advance_turn', turnId }], 'advance:' + turnId)
const mkReq = (id, text) => ({
  op: 'add_item',
  item: { id, kind: 'user_requirement', text, quote: text, sourceRefs: [{ kind: 'human', sessionId: sid, messageId: 'm-' + id }] },
})

t('1 推进轮次 ⇒ 上一轮的条目整体退场（不再只退 scope:turn）', () => {
  let st = createState({ sessionId: sid, taskId: 'default' })
  st = advance(st, 'turn:1')
  st = commit(st, [mkReq('req-a', '把炮管装回炮塔')], 'r1')
  eq(activeItems(st).length, 1, '第一轮 1 条 active')
  st = advance(st, 'turn:2')
  eq(activeItems(st).length, 0, '第二轮开始：一条都不继承')
  eq(st.items.find((x) => x.id === 'req-a').status, 'stale', '退成 stale（不是删除）')
  eq(st.items.find((x) => x.id === 'req-a').staleReason, 'turn-advanced', '退场原因可追溯')
})

t('2 第二轮自己产的目标照常 active（独立产生，不受上一轮影响）', () => {
  let st = createState({ sessionId: sid, taskId: 'default' })
  st = advance(st, 'turn:1')
  st = commit(st, [mkReq('req-a', '把炮管装回炮塔')], 'r1')
  st = advance(st, 'turn:2')
  st = commit(st, [mkReq('req-b', '检查还有无问题')], 'r2')
  eq(activeItems(st).map((x) => x.id), ['req-b'], '只有本轮那条在包里')
})

t('3 编译出的包只含本轮条目（用户看到的"遗留"就是被这条挡住的）', () => {
  let st = createState({ sessionId: sid, taskId: 'default' })
  st = advance(st, 'turn:1')
  st = commit(st, [mkReq('req-a', '修复 UI 无法点击的问题')], 'r1')
  st = advance(st, 'turn:2')
  st = commit(st, [mkReq('req-b', '检查坦克还有无问题')], 'r2')
  const packet = compileAudited(st, { budget: 4000 })
  ok(packet.ok, '编译通过')
  ok(packet.text.includes('检查坦克还有无问题'), '本轮目标在包里')
  ok(!packet.text.includes('修复 UI 无法点击的问题'), '上一轮目标**不在**包里：' + packet.text.slice(0, 120))
})

t('4 待问问题同样不跨轮（上一轮没答的自动转 stale）', () => {
  let st = createState({ sessionId: sid, taskId: 'default' })
  st = advance(st, 'turn:1')
  st = commit(st, [{ op: 'add_question', question: { id: 'q-1', text: '要做哪一型坦克？', decisionId: 'd-1' } }], 'q1')
  eq(st.questions.find((q) => q.id === 'q-1').status, 'proposed', '第一轮是 proposed')
  st = advance(st, 'turn:2')
  eq(st.questions.find((q) => q.id === 'q-1').status, 'stale', '第二轮转 stale（不继承）')
})

t('5 同轮重放不退役本轮条目', () => {
  let st = createState({ sessionId: sid, taskId: 'default' })
  st = advance(st, 'turn:1')
  st = commit(st, [mkReq('req-a', '保留本轮要求')], 'r1')
  // A distinct cause ID forces the reducer to apply the same turn again.
  st = commit(st, [{ op: 'advance_turn', turnId: 'turn:1' }], 'replayed-advance')
  eq(st.turnId, 'turn:1')
  eq(activeItems(st).map(item => item.id), ['req-a'])
  eq(st.items[0].staleReason, undefined)
})

console.log(JSON.stringify({
  suite: 'po06-no-inherit', phase: 'P11', total: pass + failures.length, pass, fail: failures.length, failures,
  note: '轮次之间不遗传：推进轮次 = 上一轮条目与待问问题整体退场（stale，留档），本轮独立重新产生目标。纯函数，不联网、不跑模型。',
}, null, 2))
process.exit(failures.length ? 1 : 0)
