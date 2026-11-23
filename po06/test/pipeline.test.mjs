import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handleUserInput } from '../lib/pipeline.js'
import { renderOptimizerPacket } from '../lib/optimizer-protocol.js'

const value = (over = {}) => ({ intent: { text: 'Improve the current result', relation: 'continue' }, add: ['Keep useful feedback comparable.'], scaffold: [], ask: [], ...over })
const session = { id: 'pipeline-session', append() { throw new Error('pipeline must not append events') } }
const input = (interpret, over = {}) => ({ messageId: 'm1', text: 'Original input stays with the host.', interpret, ...over })
const pureAdapter = (snapshot = null) => new Proxy({ intentStateOf: () => snapshot }, {
  set() { throw new Error('pipeline must not mutate the adapter') },
  get(target, name) {
    if (['initIntent', 'commitUserInput', 'commit', 'setIntentText'].includes(name)) throw new Error('pipeline must not call ' + String(name))
    return target[name]
  },
})

function checkPacket(result, ok, status) {
  assert.equal(result.ok, ok); assert.equal(result.status, status)
  assert.equal(result.packet.ok, ok); assert.equal(result.packet.status, status)
  assert.equal(result.packet.chars, result.packet.text.length)
}

test('one interpretation returns a complete packet without state initialization, mutation or publication', async () => {
  const adapter = pureAdapter(); let calls = 0
  const out = await handleUserInput(adapter, session, input(async args => {
    calls++; assert.equal(args.userText, 'Original input stays with the host.')
    assert.equal(args.sessionId, session.id); assert.equal(args.state, null)
    assert.equal(args.retryEmpty, undefined)
    return JSON.stringify(value())
  }))
  assert.equal(calls, 1); checkPacket(out, true, 'ready')
  assert.equal(out.outcome, 'committed'); assert.equal(out.zeroAddition, false)
  assert.equal(out.packet.text, renderOptimizerPacket(out.optimizer, 'zh'))
  assert.equal(out.understanding.summary, 'Improve the current result')
  assert.deepEqual(out.trace.map(row => row.step), ['interpret', 'parse', 'render'])
})

test('a detached optimizer snapshot excludes old machine advice', async () => {
  const snapshot = { revision: 42, items: [{ id: 'human', kind: 'user_requirement', text: 'Keep this input' }, { id: 'old', kind: 'proposal', text: 'Old advice' }], counts: { items: 2 } }
  await handleUserInput(pureAdapter(snapshot), session, input(async ({ state }) => {
    assert.deepEqual(state.items.map(item => item.id), ['human'])
    state.items[0].text = 'An interpreter cannot mutate host state'
    return value()
  }))
  assert.equal(snapshot.items[0].text, 'Keep this input'); assert.equal(snapshot.items.length, 2)
  assert.equal(snapshot.revision, 42)
})

test('language stays with the run even if shared adapter settings change while awaiting the model', async () => {
  const adapter = { language: 'zh' }; let complete, entered
  const started = new Promise(resolve => { entered = resolve })
  const pending = handleUserInput(adapter, session, input(() => { entered(); return new Promise(resolve => { complete = resolve }) }))
  await started; adapter.language = 'en'
  complete(value())
  const out = await pending
  assert.ok(out.packet.text.startsWith('请优先考虑')); assert.ok(out.packet.text.includes('【制作建议】'))
  assert.deepEqual(out.trace.find(row => row.step === 'render'), { step: 'render', ok: true, status: 'ready', chars: out.packet.chars, language: 'zh' })
})

test('structured advice accepts text and question fields, preserving prose and citation IDs', async () => {
  const raw = value({ add: [{ id: 'a1', text: 'Keep PBR, roughness, AO and 中文 unchanged.' }], scaffold: [{ id: 's1', text: 'Comparable local feedback.' }], ask: [{ id: 'q1', question: 'Which setting?' }] })
  const before = structuredClone(raw)
  const out = await handleUserInput(pureAdapter(), session, input(async () => raw, { policy: { englishMode: true } }))
  checkPacket(out, true, 'ready')
  assert.deepEqual(out.optimizer.add, [raw.add[0].text])
  assert.deepEqual(out.optimizer.sourceIds, { add: ['a1'], scaffold: ['s1'], ask: ['q1'] })
  assert.ok(out.packet.text.includes(raw.add[0].text)); assert.ok(out.packet.text.includes('Which setting?'))
  assert.deepEqual(raw, before)
  assert.equal(out.patch, undefined)
})

test('valid advice survives missing or invalid optional IDs', async () => {
  const raw = value({ add: [
    { text: 'Keep the first suggestion without a citation.' },
    { id: '  ', text: 'Keep the second suggestion with a blank ID.' },
    { id: 42, text: 'Keep the third suggestion with a non-string ID.' },
    { id: 'real-id', text: 'Keep the fourth suggestion and its real citation.' },
  ] })
  const out = await handleUserInput(pureAdapter(), session, input(async () => raw))
  checkPacket(out, true, 'ready')
  assert.deepEqual(out.optimizer.add, raw.add.map(row => row.text))
  assert.deepEqual(out.optimizer.sourceIds.add, [null, null, null, 'real-id'])
  assert.deepEqual(out.packet.dropped, [])
})

test('valid intent with no advice succeeds as empty without retries or an invented fallback', async () => {
  let calls = 0
  const out = await handleUserInput(pureAdapter({ items: [{ kind: 'user_requirement', text: 'Stale tank requirement' }] }), session, input(async () => { calls++; return value({ add: [] }) }))
  checkPacket(out, true, 'empty'); assert.equal(out.outcome, 'understood')
  assert.equal(out.packet.text, ''); assert.equal(out.zeroAddition, true); assert.equal(calls, 1)
  assert.equal(out.understanding.relation, 'continue')
})

test('bad JSON, missing intent and blank completion fail honestly in one call', async () => {
  for (const raw of ['{"intent":oops}', { ops: [] }, { intent: { text: '' }, add: ['not a valid intent'] }, '']) {
    let calls = 0
    const out = await handleUserInput(pureAdapter(), session, input(async () => { calls++; return raw }))
    checkPacket(out, false, 'failed'); assert.equal(out.packet.text, ''); assert.equal(calls, 1)
    assert.equal(out.optimizer, null); assert.ok(out.code)
  }
})

test('all-invalid supplied advice fails with drop evidence while partial valid advice succeeds in one call', async () => {
  let calls = 0
  const run = add => handleUserInput(pureAdapter(), session, input(async () => { calls++; return value({ add }) }))
  const malformed = await run([17, { bogus: 1 }])
  checkPacket(malformed, false, 'failed'); assert.equal(malformed.code, 'BAD_OPTIMIZER_SHAPE')
  assert.equal(malformed.packet.text, ''); assert.equal(malformed.packet.dropped.length, 2)
  assert.equal(malformed.warnings.length, 2); assert.equal(malformed.trace.some(row => row.step === 'render'), false)
  assert.equal(calls, 1)
  const partial = await run([17, { id: 'a1', text: 'A meaningful surviving direction.' }, { bogus: 1 }])
  checkPacket(partial, true, 'ready'); assert.deepEqual(partial.optimizer.add, ['A meaningful surviving direction.'])
  assert.deepEqual(partial.optimizer.sourceIds.add, ['a1']); assert.equal(partial.packet.dropped.length, 2)
  assert.ok(partial.packet.text.includes('A meaningful surviving direction.')); assert.equal(calls, 2)
})

test('provider exceptions return a failed empty packet and preserve the actual reason', async () => {
  let calls = 0
  const out = await handleUserInput(pureAdapter(), session, input(async () => { calls++; throw new Error('provider down') }))
  checkPacket(out, false, 'failed'); assert.equal(out.outcome, 'interpret-threw')
  assert.equal(out.reason, 'provider down'); assert.equal(out.packet.text, ''); assert.equal(calls, 1)
})

test('abort before starting avoids model work; abort during interpretation discards its result', async () => {
  const early = new AbortController(); early.abort(); let calls = 0
  const before = await handleUserInput(pureAdapter(), session, input(async () => { calls++; return value() }, { signal: early.signal }))
  checkPacket(before, false, 'aborted'); assert.equal(calls, 0)
  const during = new AbortController()
  const after = await handleUserInput(pureAdapter(), session, input(async () => { calls++; during.abort(); return value() }, { signal: during.signal }))
  checkPacket(after, false, 'aborted'); assert.equal(after.packet.text, ''); assert.equal(calls, 1)
  assert.equal(after.trace.some(row => row.step === 'parse' || row.step === 'render'), false)
})

test('fences, trailing prose and structural recovery do not require another model call', async () => {
  const fenced = '```json\n' + JSON.stringify(value()) + '\n```\nExtra prose {not JSON}'
  const out = await handleUserInput(pureAdapter(), session, input(async () => fenced))
  checkPacket(out, true, 'ready')
  const recovered = await handleUserInput(pureAdapter(), session, input(async () => '{"intent":{"text":"t","relation":"new"},"add":["a"],"ask":["q"}'))
  checkPacket(recovered, true, 'ready'); assert.ok(recovered.warnings.some(w => w.startsWith('json-bracket-repair:')))
})

test('long lists and repeated directions are preserved without a compiler budget', async () => {
  const rows = Array.from({ length: 17 }, (_, index) => index + ': ' + 'A meaningful direction. '.repeat(60).trimEnd())
  rows.push(rows[0])
  const out = await handleUserInput(pureAdapter(), session, input(async () => value({ add: rows })))
  checkPacket(out, true, 'ready'); assert.equal(out.optimizer.add.length, rows.length)
  for (const row of rows) assert.ok(out.packet.text.includes(row))
  assert.ok(out.packet.text.includes('18. ' + rows[0])); assert.deepEqual(out.packet.dropped, [])
})

for (const line of [4650, 4672]) {
  const fixtureName = line === 4650 ? 'optimizer-wire-4650.json' : 'optimizer-object-response.json'
  const stored = JSON.parse(readFileSync(new URL('./fixtures/' + fixtureName, import.meta.url), 'utf8'))
  const fixture = line === 4650 ? stored : { source: { line: 4672, interpretTextChars: 1860, observedPacketChars: 370 }, response: stored }
  for (const language of ['zh', 'en']) test('replay wire line ' + line + ' retains every object advice in ' + language, async () => {
    let calls = 0
    const out = await handleUserInput(pureAdapter(), session, input(async () => { calls++; return JSON.stringify(fixture.response) }, { language }))
    checkPacket(out, true, 'ready'); assert.equal(calls, 1)
    assert.equal(JSON.stringify(fixture.response).length, fixture.source.interpretTextChars)
    for (const field of ['add', 'scaffold', 'ask']) {
      assert.equal(out.optimizer[field].length, fixture.response[field].length)
      assert.deepEqual(out.optimizer.sourceIds[field], fixture.response[field].map(row => row.id))
      for (const row of fixture.response[field]) assert.ok(out.packet.text.includes(row.text), field + ': ' + row.id)
    }
    assert.deepEqual(Object.keys(out.optimizer).sort(), ['version', 'intent', 'clarify', 'add', 'scaffold', 'ask', 'decide', 'sourceIds'].sort())
    assert.ok(out.packet.chars > fixture.source.observedPacketChars)
    assert.doesNotMatch(out.packet.text, /unk-unevaluated-input|这一轮没有从中提取到可执行内容/)
    assert.equal(out.trace.filter(row => row.step === 'render').length, 1)
  })
}
