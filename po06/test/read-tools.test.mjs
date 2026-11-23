// Read-only interpretation uses the real read/glob/grep tools with a fake, network-free LLM.
// Guard the original failures: the stream signal must reach the host and reasoning must
// reach the UI. One optimization run owns all tool continuations; invalid output never
// starts a separate tool-free retry. Both successful and rejected output retain actual usage.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { runReadOnlyToolLoop, drainWithTools, executeReadOnlyTool, toolResultMessages, assistantToolCallMessage } from '../lib/read-tools.js'
import { interpretViaLlm } from '../lib/index.js'
import { handleUserInput } from '../lib/pipeline.js'
import { loadLlmLib, toolResultShape } from '../lib/llm-lib.js'
import { fileURLToPath } from 'node:url'

// ⚠ **必须在这里就把"宿主 llm 模块"指到夹具上**（在下面任何用例调用之前）：
// 工具结果的形状由该模块决定（0.1.7+ 有 `createToolResultMessage`）。测试环境里解析不到
// 真实宿主安装树，若不指过来，循环会因为"形状不明"不造结果消息、悄悄收敛 ⇒
// 用例就分不清"形状检测坏了"和"模块没装"（2026-09-24 实测撞到过）。
const FIXTURE_LLM = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'llm-lib-017.mjs')
process.env.DSH_PO06_LLM_LIB = FIXTURE_LLM

let pass = 0
const failures = []
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy') }
function eq(a, b, what) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${what || 'value'}: expected ${y}, got ${x}`) }
/**
 * ⚠ 用例可以是 **async**（本套件要 await 真跑的循环）。写法必须 **收集 promise 再统一 await**：
 * 第一版直接 `fn()`，于是 async 用例里抛的错变成**未处理的 rejection**——摘要照样打印 `pass 8 / fail 0`，
 * 退出码却是 1（"全绿"和"没跑"看起来一样，正是本项目最防的那种假绿）。
 */
const pending = []
function t(name, fn) { pending.push(Promise.resolve().then(fn).then(() => { pass += 1 }, (e) => { failures.push({ name, error: String((e && e.message) || e) }) })) }

const DIRS = []
process.on('exit', () => { for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } } })
function tmpRoot() {
  const d = mkdtempSync(join(tmpdir(), 'po06-rt-'))
  DIRS.push(d)
  writeFileSync(join(d, 'note.txt'), 'hello from the tool root\n', 'utf8')
  return d
}

/** 把一串 chunk 包成一个**异步可迭代**的流（宿主 `llm.stream` 的返回形状）。 */
function streamOf(chunks) {
  return (async function* gen() { for (const c of chunks) yield c })()
}
const textDelta = (s) => ({ type: 'text-delta', text: s })
const reasonDelta = (s) => ({ type: 'reasoning-delta', text: s })
const usageChunk = (n) => ({ type: 'usage', usage: { totalTokens: n } })
const toolCall = (id, name, args) => ([
  { type: 'tool-call-delta', id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'block-end', block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
])
const finish = (reason = 'stop') => ({ type: 'finish', reason: { kind: reason } })

/** 桩 llm：按调用次序吐预设的 chunk 序列，并**记下每次调用收到的参数**（形状可核）。 */
function stubLlm(sequences) {
  const calls = []
  return {
    calls,
    stream(opts) {
      calls.push(opts)
      const seq = sequences[Math.min(calls.length - 1, sequences.length - 1)]
      return streamOf(seq)
    },
  }
}

// ── ① 工具路径**真的跑起来了**（`signal is not defined` 那类"整条分支当场死"的回归守卫）──
t('工具循环真的跑了一轮、真的执行了工具（不是 0 轮就抛）', async () => {
  const root = tmpRoot()
  const llm = stubLlm([
    [...toolCall('c1', 'read', { path: 'note.txt' }), finish()],
    [textDelta('{"ops":[]}'), usageChunk(7), finish()],
  ])
  const r = await runReadOnlyToolLoop({ llm, cfg: { provider: 'p', model: 'm' }, system: 'S', messages: [], root, count: 2 })
  eq(r.ok, true, '不应失败：' + JSON.stringify({ error: r.error, rounds: r.rounds }))
  eq(r.error, null, '不该有任何 error（`signal is not defined` 就是从这里冒出来的）')
  ok(r.rounds >= 1, '至少跑过一轮：' + r.rounds)
  eq(r.toolCalls, 1, '应当执行了 1 次工具调用')
  ok(r.trace.some((x) => x.tool === 'read'), '工具轨迹里应看到 read：' + JSON.stringify(r.trace))
})

// ── ② 取消信号**真的传下去了**（用户按「跳过并发送」时模型调用要当场停）──
t('取消信号传到宿主流的参数里（不是只在注释里存在）', async () => {
  const root = tmpRoot()
  const ac = new AbortController()
  const llm = stubLlm([[textDelta('{"ops":[]}'), finish()]])
  await runReadOnlyToolLoop({ llm, cfg: { provider: 'p', model: 'm' }, system: 'S', messages: [], root, count: 1, signal: ac.signal })
  eq(llm.calls.length, 1, '应当调用了一次流')
  ok(llm.calls[0].signal === ac.signal, '流的参数里必须带上调用方给的 signal')
  // 反向确认：没给信号时**不许**凭空造一个（免得宿主以为这次可取消）
  const llm2 = stubLlm([[textDelta('x'), finish()]])
  await runReadOnlyToolLoop({ llm: llm2, cfg: {}, system: 'S', messages: [], root, count: 1 })
  ok(!('signal' in llm2.calls[0]), '没给 signal 时不应传这个字段')
})

// ── ③ 思维片段**到得了 sink**（界面之所以能看到思考，全靠这一条）──
t('工具的思维增量进 sink（开工具时界面才有"思考"可显示）', async () => {
  const seen = []
  const s = streamOf([reasonDelta('先看目录'), textDelta('{"ops":[]}'), finish()])
  const r = await drainWithTools(s, Date.now(), (d) => seen.push(d))
  eq(r.reasoning, '先看目录', 'reasoning 要收全')
  ok(seen.some((d) => d.reasoning === '先看目录'), '思维增量必须流给 sink：' + JSON.stringify(seen))
  ok(seen.some((d) => typeof d.reasoningChars === 'number'), '每条都要带累计字数（界面按它判断有没有新内容）')
})

t('工具不可用时普通流仍回传思维', async () => {
  const seen = []
  const llm = stubLlm([[reasonDelta('没有授权的项目根目录'), textDelta('plain result'), usageChunk(7), finish()]])
  const r = await interpretViaLlm({
    llm, cfg: { provider: 'p', model: 'm' }, userPrompt: 'x', system: 'S',
    tools: { enabled: true, root: '', reason: 'missing-root' }, onDelta: delta => seen.push(delta),
  })
  eq(r.via, 'plain')
  eq(r.context, null)
  eq(r.text, 'plain result')
  eq(llm.calls.length, 1, 'unavailable tools do not create a second request')
  ok(seen.some(delta => delta.reasoning === '没有授权的项目根目录'), 'plain stream reasoning must reach the UI sink')
})

// A failed interpretation stays in the same run; the streamed reasoning and usage are retained.
t('tool prose is rejected by the production parser without a tool-free retry', async () => {
  const root = tmpRoot()
  const llm = stubLlm([
    [reasonDelta('先检查当前文件的内容'), textDelta('我看了 note.txt，内容是 hello。'), usageChunk(11), finish()],
    [textDelta('{"intent":{"text":"unused retry"},"add":[],"scaffold":[],"ask":[]}'), usageChunk(99), finish()],
  ])
  const seen = []
  const r = await interpretViaLlm({
    llm, cfg: { provider: 'p', model: 'm' }, userPrompt: 'x',
    system: 'S+TOOLS', tools: { enabled: true, root, count: 2, reason: 'enabled' },
    onDelta: delta => seen.push(delta),
  })
  eq(r.via, 'tools', 'retain the actual tool-path result')
  eq(llm.calls.length, 1, 'no alternate no-tools model call is authorized')
  ok(seen.some(delta => String(delta.reasoning || '').includes('先检查当前文件的内容')), 'reasoning reaches the UI even when parsing fails')
  eq(r.usage.totalTokens, 11, 'account for the rejected call without invented retry usage')
  const parsed = await handleUserInput({}, { id: 'tool-prose' }, {
    messageId: 'prose-run', text: 'x', interpret: async () => { if (r.error) throw new Error(r.error); return r.text },
  })
  eq(parsed.ok, false, 'prose cannot become an optimizer packet')
  eq(parsed.status, 'failed')
  eq(parsed.packet.text, '')
  ok(parsed.reason, 'parser failure remains attributable')
})

// Valid v3 JSON after a real read is accepted by the same production parser.
t('tool JSON produces v3 directions with complete tool usage accounting', async () => {
  const root = tmpRoot()
  const raw = JSON.stringify({ intent: { text: 'read note.txt', relation: 'new' },
    add: [{ id: 'add-1', text: '保留 note.txt 的 hello 内容。' }], scaffold: [], ask: [] })
  const llm = stubLlm([
    [...toolCall('c1', 'read', { path: 'note.txt' }), usageChunk(7), finish()],
    [textDelta(raw), usageChunk(13), finish()],
  ])
  const r = await interpretViaLlm({
    llm, cfg: { provider: 'p', model: 'm' }, userPrompt: 'x',
    system: 'S+TOOLS', tools: { enabled: true, root, count: 2, reason: 'enabled' },
  })
  eq(r.via, 'tools')
  eq(r.error, null)
  eq(r.context.toolCalls, 1, 'one real read is recorded')
  eq(r.context.toolsEnabled, true)
  eq(r.usage.totalTokens, 20, 'both model rounds count toward real usage')
  eq(llm.calls.length, 2, 'tool continuation is not a new optimization attempt')
  const parsed = await handleUserInput({}, { id: 'tool-v3' }, {
    messageId: 'read-run', text: 'read note.txt', interpret: async () => r.text,
  })
  eq(parsed.ok, true)
  eq(parsed.status, 'ready')
  ok(parsed.packet.text.includes('保留 note.txt 的 hello 内容。'), 'real direction reaches the packet')
})

// ── ⑥ 不给 root / 关掉工具时**不许**走工具路径（三重与条件回归）──
t('没有 root ⇒ 工具路径不启动（错误也要如实回报）', async () => {
  const llm = stubLlm([[textDelta('{"ops":[]}'), finish()]])
  const r = await runReadOnlyToolLoop({ llm, cfg: {}, system: 'S', messages: [], root: '', count: 3 })
  eq(r.ok, false, '没有根目录就该拒绝')
  eq(r.error, 'no-root', '错因要具体：' + r.error)
  eq(llm.calls.length, 0, '一次模型调用都不该发生（不许先花钱再说）')
})

// ── ⑦ 工具执行本身：越界要拒、未知工具要拒（只读边界不能被绕过）──
t('只读边界：越界路径与未知工具都被明确拒绝', () => {
  const root = tmpRoot()
  const out = executeReadOnlyTool(root, 'read', { path: '../secret.txt' })
  eq(out.ok, false, '越界必须拒绝')
  ok(String(out.text).includes('拒绝'), '拒绝理由要能被模型读到：' + out.text)
  const unknown = executeReadOnlyTool(root, 'write', { path: 'note.txt' })
  eq(unknown.ok, false, '未知工具必须拒绝（本循环只有 read/glob/grep）')
})

// ── ⑧ 变异守卫的定点：`drainWithTools` 的 sink 抛错**不许**带垮模型调用 ──
t('sink 抛错不影响收集（展示层坏了不能拖累解释）', async () => {
  const s = streamOf([reasonDelta('r'), textDelta('{"ops":[]}'), finish()])
  const r = await drainWithTools(s, Date.now(), () => { throw new Error('界面炸了') })
  eq(r.text, '{"ops":[]}', '正文仍要收全')
  eq(r.reasoning, 'r', '思维仍要收全')
  eq(r.error, null, 'sink 的问题不该被记成模型错误')
})

// ── ⑨ 工具结果的**消息形状**（0.1.7 真机缺陷的守卫）──────────────────────────
// 为什么必须钉死：旧代码把结果塞进 **user 消息的 `tool-result` 块**，而 0.1.7 起工具结果
// 是**一等 `role:'tool'` 消息**。形状错了**不会报错**，只会让宿主在建流时回一句
// `llm.error: cannot represent user/tool-result content`（台账 `UNSUPPORTED_CONTENT`）
// ⇒ 开了"只读工具"的每一轮，工具循环第 2 轮就断。原来这条路径**一个测试都没有**。
t('工具结果的形状 = 0.1.7 的一等 tool 消息（不是塞进 user 的 tool-result 块）', async () => {
  // `env` 由调用方显式给（`loadLlmLib` 的默认是空表，为的是让候选顺序可单测）
  const loaded = await loadLlmLib({ env: process.env })
  ok(loaded.ok === true, '夹具模块要能被解析到：' + JSON.stringify(loaded.reason || loaded))
  const msgs = toolResultMessages(
    [{ id: 'c1', name: 'read', arguments: '{}' }],
    [{ ok: true, text: 'hello from the tool root' }],
    loaded,
  )
  eq(msgs.length, 1, '一次调用一条结果消息')
  const m = msgs[0]
  eq(m.role, 'tool', '必须是 tool 角色：' + JSON.stringify(m))
  eq(m.toolCallId, 'c1', '要带 provider 给的调用 id')
  eq(m.source && m.source.kind, 'tool', 'source.kind 是 tool')
  eq(m.source && m.source.callId, 'c1', 'source.callId 也要带')
  eq(m.isError, false, '成功不算错')
  eq(m.content.length, 1, '内容块**直接**是 content（不再包一层 tool-result）')
  eq(m.content[0].type, 'text', '结果正文是文本块')
  ok(String(m.content[0].text).includes('hello'), '正文要在：' + JSON.stringify(m.content[0]))
  ok(!JSON.stringify(m.content).includes('tool-result'), '**不得**再出现 tool-result 这种内容块类型')
  const asst = assistantToolCallMessage([{ id: 'c1', name: 'read', arguments: '{"path":"note.txt"}' }], 'p', 'm', loaded.mod)
  eq(asst.role, 'assistant', '助手请求工具仍是 assistant')
  eq(asst.content[0].type, 'tool-call', '带 tool-call 块')
  eq(asst.source.kind, 'model', 'source.kind 是 model')
})

t('只认旧形状的宿主 ⇒ 退回 user + tool-result 块（代次差异只在一处决定）', () => {
  const legacy = { createUserMessage: (i) => ({ role: 'user', content: i.content, source: i.source }) }
  const shape = toolResultShape(legacy)
  eq(shape.shape, 'legacy-user-block', '没有 createToolResultMessage 就用旧形状')
  const msgs = toolResultMessages([{ id: 'c9' }], [{ ok: false, text: '读取被拒绝' }], shape)
  eq(msgs.length, 1, '仍然要产出消息')
  eq(msgs[0].role, 'user', '旧形状是 user 角色')
  eq(msgs[0].content[0].type, 'tool-result', '旧形状用 tool-result 块')
  eq(msgs[0].content[0].toolCallId, 'c9', '块里带调用 id')
  eq(msgs[0].content[0].isError, true, '失败要标 isError')
  eq(toolResultShape({}).shape, 'none', '两个工厂都没有 ⇒ 形状未知（不得猜）')
  eq(toolResultMessages([{ id: 'c' }], [{}], null).length, 0, '形状未知时不造消息（宁可不发，也不发模型读不懂的）')
})


// A recoverable first object is accepted with an explicit warning, without another model call.
t('mixed output recovers the complete v3 object with a visible warning in the same run', async () => {
  const root = tmpRoot()
  const head = JSON.stringify({ intent: { text: 'read note.txt', relation: 'new' },
    add: [{ text: '使用读取到的 hello 内容。' }], scaffold: [], ask: [] })
  const mixed = head + '\n\n等一下，中间这段是散文。\n' + '{"extra":"x"}'
  const llm = stubLlm([
    [...toolCall('c1', 'read', { path: 'note.txt' }), usageChunk(5), finish()],
    [textDelta(mixed), usageChunk(9), finish()],
    [textDelta('{"intent":{"text":"unused retry"},"add":[],"scaffold":[],"ask":[]}'), usageChunk(99), finish()],
  ])
  const r = await interpretViaLlm({
    llm, cfg: { provider: 'p', model: 'm' }, userPrompt: 'x',
    system: 'S+TOOLS', tools: { enabled: true, root, count: 2, reason: 'enabled' },
  })
  eq(r.via, 'tools')
  eq(llm.calls.length, 2, 'read plus final output consume exactly two calls, with no tool-free retry')
  eq(r.context.toolCalls, 1)
  eq(r.usage.totalTokens, 14, 'invalid final JSON does not erase usage from either call')
  const parsed = await handleUserInput({}, { id: 'mixed-tool-output' }, {
    messageId: 'mixed-run', text: 'x', interpret: async () => { if (r.error) throw new Error(r.error); return r.text },
  })
  eq(parsed.ok, true)
  eq(parsed.status, 'ready')
  ok(parsed.packet.text.includes('使用读取到的 hello 内容。'), 'recover the real direction from the complete v3 object')
  ok(parsed.warnings.includes('json-balanced-scan'), 'recovery is explicitly recorded')
})

t('malformed mixed objects still fail the production parser without retry and retain usage', async () => {
  const root = tmpRoot()
  const raw = '{"intent": nope,"add": bad}\n中间散文\n{"extra": invalid}'
  const llm = stubLlm([[textDelta(raw), usageChunk(19), finish()]])
  const r = await interpretViaLlm({
    llm, cfg: { provider: 'p', model: 'm' }, userPrompt: 'x', system: 'S+TOOLS',
    tools: { enabled: true, root, count: 2, reason: 'enabled' },
  })
  const parsed = await handleUserInput({}, { id: 'invalid-tool-output' }, {
    messageId: 'invalid-run', text: 'x', interpret: async () => { if (r.error) throw new Error(r.error); return r.text },
  })
  eq(parsed.ok, false)
  eq(parsed.status, 'failed')
  eq(parsed.code, 'BAD_JSON')
  eq(parsed.packet.text, '')
  eq(llm.calls.length, 1, 'invalid output cannot trigger an alternate model call')
  eq(r.usage.totalTokens, 19, 'rejected output still has real token cost')
})
await Promise.all(pending)
console.log(JSON.stringify({
  suite: 'po06-read-tools', phase: 'P10',
  total: pass + failures.length, pass, fail: failures.length, failures,
}, null, 2))
if (failures.length > 0) process.exit(1)
