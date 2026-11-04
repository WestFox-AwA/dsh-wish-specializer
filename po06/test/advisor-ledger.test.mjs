// 顾问台账（2026-10-20 重构 2/4）：会话级、去重、由顾问自己销账。
//
// 用户的要求：旧结论不要机械作废，要让"有智能的顾问"每次被调用时先结旧账。
// 所以本套件钉住：记账/去重/只保留最近 N 条/显式销账/清空/渲染成顾问输入。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLedger, LEDGER_MAX_OPEN } from '../lib/advisor-ledger.js'

test('记账 + 去重：同一句话不会记两遍，但会刷新"这轮又提到"', () => {
  const L = createLedger()
  L.add('s1', { claim: '中微子能量没交代', severity: 'major' }, { turn: 1 })
  L.add('s1', { claim: '中微子能量没交代', severity: 'major' }, { turn: 3 })
  const open = L.open('s1')
  assert.equal(open.length, 1, '去重')
  assert.equal(open[0].lastCheckedTurn, 3, '刷新了检查轮次')
  assert.equal(open[0].severity, 'major')
})

test('会话隔离：另一个会话看不到这边欠的账', () => {
  const L = createLedger()
  L.add('s1', { claim: 'A' }, { turn: 1 })
  assert.equal(L.open('s2').length, 0)
})

test('销账必须由顾问显式给出：resolved / obsolete / unknown', () => {
  const L = createLedger()
  const a = L.add('s1', { claim: '轮廓像玩具' }, { turn: 1 })
  const b = L.add('s1', { claim: '材质没分区' }, { turn: 1 })
  L.applyUpdates('s1', [
    { id: a.id, status: 'resolved', note: '已按体积重做' },
    { id: b.id, status: 'still-open' },
  ], { turn: 2 })
  const open = L.open('s1')
  assert.equal(open.length, 1, '只留下没销的那条')
  assert.equal(open[0].claim, '材质没分区')
})

test('unknown 也算未结（顾问判断不了，不能偷偷销掉）', () => {
  const L = createLedger()
  const a = L.add('s1', { claim: '证据够了没有' }, { turn: 1 })
  L.applyUpdates('s1', [{ id: a.id, status: 'unknown' }], { turn: 2 })
  assert.equal(L.open('s1').length, 1)
})

test('超过上限时折叠最久未检查的，注入里不出现', () => {
  const L = createLedger()
  for (let i = 0; i < LEDGER_MAX_OPEN + 5; i++) L.add('s1', { claim: '结论' + i }, { turn: i })
  const text = L.render('s1')
  assert.ok(text.split('\n').length <= LEDGER_MAX_OPEN + 1, '渲染不超过上限')
  assert.ok(!text.includes('结论0'), '最老的被折叠')
})

test('清空即干净（顾问关掉/会话结束）', () => {
  const L = createLedger()
  L.add('s1', { claim: 'A' }, { turn: 1 })
  L.clear('s1')
  assert.equal(L.open('s1').length, 0)
  assert.equal(L.render('s1'), '')
})

test('渲染成顾问输入的一段，没有未结项就返回空串', () => {
  const L = createLedger()
  assert.equal(L.render('s1'), '')
  L.add('s1', { claim: '地面接触阴影缺失' }, { turn: 1 })
  assert.match(L.render('s1'), /你上次留下的未结结论[\s\S]*地面接触阴影缺失/)
})

test('顾问报告里的 resolvedClaims 会原样保留（供台账销账）', async () => {
  const { parseAdvisorReport } = await import('../lib/advisor.js')
  const parsed = parseAdvisorReport(JSON.stringify({
    verdict: 'gaps', summary: '现在还有两处没结。', findings: [], checks: [],
    resolvedClaims: [{ id: 'adv-1', status: 'resolved', note: '已按新材质重做' }],
  }), [], 'review_result')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.report.resolvedClaims, [{ id: 'adv-1', status: 'resolved', note: '已按新材质重做' }])
})

test('issue #46：回灌有上限、去重，并显式说明还有多少条没列入', () => {
  const L = createLedger()
  for (let i = 0; i < 12; i++) L.add('s1', { claim: '未结结论 ' + i, severity: 'minor' }, { turn: i })
  // 重复表述不应重复回灌
  L.add('s1', { claim: '未结结论 3', severity: 'minor' }, { turn: 20 })
  const text = L.render('s1', false)
  const items = (text.match(/^- \[/gm) || []).length
  assert.ok(items <= LEDGER_MAX_OPEN, '回灌条目不得超过上限，实际 ' + items)
  assert.ok(text.includes('未列入'), '超出上限要显式说明，不许无声截断')
  const claims = text.split(String.fromCharCode(10)).filter((line) => line.startsWith('- ['))
  assert.equal(new Set(claims).size, claims.length, '同一句话不得重复出现')
})
