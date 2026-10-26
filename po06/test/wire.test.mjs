// Production wiring: the real apply() registers the pre-send API, dynamic context and event observer.
// Fake model streams are the only generation boundary; parser, renderer, run ownership,
// HTTP handlers, context composition and injection-card consumption all execute for real.
// Independent wire parsing, model routing, store and gate regression tests remain below.
import { readFileSync, mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHostContext as fakeCtx, fakeLlm, controlledLlm, fakeSession, emit, headerEvent, finishChunk, flushHostEvents, deferred } from './host-wire-harness.mjs'
import {
  isRealUserInput, extractUserText, extractMessageId, extractObservedModel,
  resolveInterpreterCfg, decideInterpret, resolveProfileName,
} from '../lib/wire.js'
import { safeSessionFile, statePath, createStateStore, inheritStateForFork } from '../lib/store.js'

// ⚠ 必须在**第一次 import index.js 之前**设置：index.js 在模块加载时读 DSH_HOME。
// 否则单测会往**真实 home** 里写台账与状态文件——测试污染用户环境是不可接受的。
//
// 临时目录**一律经 tempHome() 创建**，由 exit 钩子统一清理。
// 为什么强调"一律"：第一版只给主目录加了清理，后来新增的两个淘汰测试各自 mkdtemp，
// 于是又攒了 76 个——**同一个错误犯第二次的原因就是"清理"没有被收进一个出口**。
const TEMP_DIRS = []
function tempHome(prefix = 'po06-test-') {
  const d = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(d)
  return d
}
process.on('exit', () => {
  for (const d of TEMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
})
const TEST_HOME = tempHome()
process.env.DSH_HOME = TEST_HOME

const HERE = dirname(fileURLToPath(import.meta.url))
process.env.DSH_PO06_LLM_LIB = join(HERE, 'fixtures', 'llm-lib-017.mjs')

let pass = 0
const failures = []
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy') }
function eq(a, b, what) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${what || 'value'}: expected ${y}, got ${x}`) }
function t(name, fn) { try { fn(); pass += 1 } catch (e) { failures.push({ name, error: String(e.message || e) }) } }
const ta = async (name, fn) => { try { await fn(); pass += 1 } catch (e) { failures.push({ name, error: String(e.message || e) }) } }

const USER_TEXT = '帮我写一个把秒数格式化的函数，用 Python，不要解释。'
const userEvent = (text = USER_TEXT, id = 'm-1') => ({
  type: 'user/message',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
/** 插件自己的投递：形状与宿主实测日志一致（EV-0078 抓到的那条）。 */
const pluginEvent = (text, id = 'm-plugin') => ({
  type: 'user/message',
  data: {
    id, role: 'user',
    source: { kind: 'plugin', plugin: '@dsh-external/dsh-wish-specializer', form: 'snapshot' },
    content: [{ type: 'text', text }],
  },
})

// ── 1. 只认"人"的输入：防自激循环 ─────────────────────────────────────
// 投递本身也是一条 user/message。若不过滤来源，包会触发解释、解释产出新包，
// 形成自激循环——这是本模块最容易写错、后果最严重的一处。
t('只有 source.kind=user 才算用户输入（否则会自激循环）', () => {
  eq(isRealUserInput(userEvent()), true, '真人输入')
  eq(isRealUserInput(pluginEvent('意图包')), false,
    '**插件自己的投递绝不能被当成用户输入**（自激循环）')
  eq(isRealUserInput({
    type: 'user/message',
    data: { source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: 'x' }] },
  }), false, '技能目录不算')
  eq(isRealUserInput({ type: 'request/header', data: {} }), false, '别的类型不算')
  eq(isRealUserInput({ type: 'user/message', data: {} }), false, '没有 source 不算')
  eq(isRealUserInput(null), false, 'null 不算')
})

t('取文本：只取 text 块、逐块去空白、拼接', () => {
  eq(extractUserText(userEvent()), USER_TEXT, '单块')
  eq(extractUserText({
    type: 'user/message',
    data: { content: [{ type: 'text', text: '  a  ' }, { type: 'image' }, { type: 'text', text: 'b' }] },
  }), 'a\nb', '多块拼接且忽略非文本块（逐块去空白，便于逐字引文比对）')
  eq(extractUserText({ type: 'user/message', data: { content: [{ type: 'text', text: '   ' }] } }),
    '', '全空白 ⇒ 空（会被当成没有输入，不解释）')
  eq(extractUserText({ type: 'user/message', data: { content: 'raw' } }), 'raw', '字符串内容')
  eq(extractUserText({ type: 'user/message', data: { content: [] } }), '', '空')
  eq(extractUserText({ type: 'user/message', data: {} }), '', '没有 content')
})

t('消息 id 是幂等键，缺了必须返回 null（不得用随机值兜底）', () => {
  eq(extractMessageId(userEvent()), 'm-1', '正常')
  eq(extractMessageId({ type: 'user/message', data: { id: '' } }), null, '空串不算')
  eq(extractMessageId({ type: 'user/message', data: {} }), null, '缺失不算')
})

// ── 2. 解释层用哪个模型 ───────────────────────────────────────────────
t('从会话事件里读出宿主自己在用的模型', () => {
  eq(extractObservedModel({
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
  }), { provider: 'deepseek-official', model: 'deepseek-flash' }, 'request/header')
  eq(extractObservedModel({ type: 'request/context', data: { provider: 'p', model: 'm' } }),
    { provider: 'p', model: 'm' }, 'request/context')
  eq(extractObservedModel({ type: 'request/header', data: { header: { config: { provider: 'p' } } } }),
    null, '缺 model ⇒ null（不猜）')
  eq(extractObservedModel({ type: 'user/message', data: {} }), null, '别的类型不提供模型')
})

t('模型解析：显式配置优先，否则用观测到的，都没有 ⇒ 明确失败', () => {
  const cfg = { interpreter: { provider: 'cfg-p', model: 'cfg-m' } }
  eq(resolveInterpreterCfg({ config: cfg, observed: { provider: 'obs-p', model: 'obs-m' } }),
    { ok: true, provider: 'cfg-p', model: 'cfg-m', source: 'config', reasoningEffort: null }, '配置优先')
  eq(resolveInterpreterCfg({ observed: { provider: 'obs-p', model: 'obs-m' } }),
    { ok: true, provider: 'obs-p', model: 'obs-m', source: 'observed', reasoningEffort: null }, '退回观测值')
  eq(resolveInterpreterCfg({}), { ok: false, reason: 'no-model-route' }, '都没有 ⇒ 不解释（不编造）')
  // 半截配置不得把观测值带偏，也不得拼出一个 provider/model 混搭的组合
  eq(resolveInterpreterCfg({ config: { interpreter: { provider: 'cfg-p' } }, observed: { provider: 'obs-p', model: 'obs-m' } }),
    { ok: true, provider: 'obs-p', model: 'obs-m', source: 'observed', reasoningEffort: null }, '半截配置 ⇒ 整体退回观测值')
  eq(resolveInterpreterCfg({ config: { interpreter: { provider: '', model: 'm' } } }).ok, false, '空串不算有效配置')
})

// ── 3. 跳过原因必须说得清（EV-0078 的教训：什么都不发生时查不出原因）──
t('每个跳过原因都有独立代码，且优先级明确', () => {
  const good = { isUserInput: true, text: 'x', gateEnabled: true, cfg: { ok: true }, llmAvailable: true }
  eq(decideInterpret(good), { ok: true, reason: 'ok' }, '全绿才解释')
  eq(decideInterpret({ ...good, isUserInput: false }).reason, 'not-user-input', '非用户输入')
  eq(decideInterpret({ ...good, text: '' }).reason, 'empty-text', '空输入不解释')
  eq(decideInterpret({ ...good, gateEnabled: false }).reason, 'gate-disabled', '闸门未启用')
  eq(decideInterpret({ ...good, gateEnabled: undefined }).reason, 'gate-disabled', '闸门未判定（保守）')
  eq(decideInterpret({ ...good, llmAvailable: false }).reason, 'llm-unavailable', '没有 LLM 服务')
  eq(decideInterpret({ ...good, cfg: { ok: false, reason: 'no-model-route' } }).reason, 'no-model-route', '没有模型路由')
  eq(decideInterpret({ ...good, cfg: null }).reason, 'no-model-route', 'cfg 缺失')
})

// ── 3b. profile 解析（静态探测查的是哪个目录）─────────────────────────
// 写死 `profiles/web` 的后果不是报错，而是**在别的 profile 下回答另一个 profile 的问题**
// ——查错对象的缺陷最阴，因为结论看起来永远有（EV-0081）。
t('profile 解析：--profile / --profile= / 裸子命令 / 兜底', () => {
  eq(resolveProfileName({ argv: ['node', 'dsh', '--profile', 'headless', '任务'] }).name, 'headless', '--profile X')
  eq(resolveProfileName({ argv: ['node', 'dsh', '--profile=headless'] }).name, 'headless', '--profile=X')
  eq(resolveProfileName({ argv: ['node', 'dsh', 'web'] }).name, 'web', '裸子命令 web')
  eq(resolveProfileName({ argv: ['node', 'dsh'] }).name, 'web', '什么都没给 ⇒ 默认 web')
  eq(resolveProfileName({ argv: ['node', 'dsh', '--profile', 'headless'] }).source, 'argv', '来源可复核')
  // profile 不存在 ⇒ 退回 web，但**如实标注**退回过，不假装就是 web
  const fb = resolveProfileName({ argv: ['node', 'dsh', '--profile', 'nope'], profileExists: () => false })
  eq(fb, { name: 'web', source: 'fallback', requested: 'nope' }, '不存在时退回并标注')
  eq(resolveProfileName({ argv: ['node', 'dsh', '--profile', 'headless'], profileExists: () => true }).source, 'argv',
    '存在时不得退回')
  // 顺序：--profile 优先于裸子命令
  eq(resolveProfileName({ argv: ['node', 'dsh', '--profile', 'tui', 'web'] }).name, 'tui', '--profile 优先')
  // 形态健壮性
  eq(resolveProfileName({}).name, 'web', '无参')
  eq(resolveProfileName({ argv: 'not-an-array' }).name, 'web', '非数组输入不炸')
})

// ── 3b2. DSH Desktop 把 profile 目录当**位置参数**（issue #14）──────────────
// 真机 argv 形状（路径为示意）：桌面端**不传 `--profile`**，profile 目录直接就是位置参数。
// 修前：这些参数含分隔符 ⇒ 被 `PROFILE_NAME_RE` 挡掉 ⇒ 退回默认 `web`，而进程实际跑的是 `desktop`；
// 后果与 EV-0081/EV-0121 同形——不报错、只给错答案（守卫据此判断旧插件是否仍在装配时会答错对象）。
t('profile 解析：DSH Desktop 的路径形态位置参数（issue #14）', () => {
  const argv = [
    'C:\\app\\DeepSeek Harness.exe', '--expose-internals',
    'C:\\app\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
    'C:\\app\\resources\\app.asar\\dsh',
    'C:\\home\\.dsh\\profiles\\desktop',
    'C:\\app\\resources\\runtime\\primary-runtime',
  ]
  const exists = (n) => n === 'desktop'
  eq(resolveProfileName({ argv, profileExists: exists }).name, 'desktop', '路径末段就是 profile 名')
  eq(resolveProfileName({ argv, profileExists: exists }).source, 'subcommand', '来源可复核')
  // 存在性检查是**必需**的：argv 里 `…/app.asar/dsh` 的末段 `dsh` 也过得了名字正则
  eq(resolveProfileName({ argv, profileExists: () => false }).name, 'web', '校验不过 ⇒ 不认，且如实退回')
  // 显式形式仍然优先于路径推断
  eq(resolveProfileName({ argv: [...argv, '--profile', 'headless'], profileExists: (n) => n === 'desktop' || n === 'headless' }).name,
    'headless', '--profile 优先于路径推断')
  // POSIX 形态同样成立（Linux/macOS 上的桌面端）
  eq(resolveProfileName({ argv: ['/usr/bin/node', '/app/dsh', '/home/u/.dsh/profiles/tui'], profileExists: (n) => n === 'tui' }).name,
    'tui', 'POSIX 路径')
})

// ── 3c. **不许再用写死的 profile 清单**（EV-0121）──────────────────────
// 曾经写死 `['web','headless','tui']`，而宿主实际发行 5 个模板
// （`acp / web / headless / sdk / sdk-minimal`）⇒ `dsh sdk …` 解析不出 profile、
// 退回 `web` ⇒ 插件去查 **profiles/web 的清单**，而进程跑的是 `sdk`。
// 与 EV-0081 修掉的那个缺陷**同形**：查错对象、不报错、只给错答案。
// 而双重拦截守卫据此可能给出**相反**的结论（该拒的放行、该放的拒绝）。
t('profile 解析：**宿主发行的 5 个模板**都要认（写死清单时 sdk 会被解析成 web）', () => {
  const exists = (n) => ['web', 'headless', 'acp', 'sdk', 'sdk-minimal', 'po06beta'].includes(n)
  for (const name of ['web', 'headless', 'acp', 'sdk', 'sdk-minimal']) {
    const r = resolveProfileName({ argv: ['node', 'dsh', name, '任务'], profileExists: exists })
    eq(r.name, name, '裸子命令 ' + name)
    eq(r.source, 'subcommand', '来源')
  }
  // **自建 profile 也要认**：判据靠"它真的是不是 profile 目录"，不靠任何清单
  eq(resolveProfileName({ argv: ['node', 'dsh', 'po06beta'], profileExists: exists }).name, 'po06beta',
    '自建 profile（清单里不可能有）')
})

t('profile 解析：**不存在的名字不当成 profile**；flag 的取值不被误认', () => {
  const exists = (n) => ['web', 'headless', 'sdk'].includes(n)
  // `tui` 不是宿主的任何模板 ⇒ 不得当成子命令（旧清单里恰恰有它）
  eq(resolveProfileName({ argv: ['node', 'dsh', 'tui'], profileExists: exists }).name, 'web', 'tui 不存在 ⇒ 默认 web')
  // 任务文本里的词不是 profile
  eq(resolveProfileName({ argv: ['node', 'dsh', 'run', 'the', 'tests'], profileExists: exists }).name, 'web',
    '普通位置参数不冒充 profile')
  // flag 的取值要跳过：`--port 0 sdk` 里的 `0` 不是 profile，`sdk` 是
  eq(resolveProfileName({ argv: ['node', 'dsh', '--port', '0', 'sdk'], profileExists: exists }).name, 'sdk',
    'flag 取值被跳过')
})

// Production coverage follows the pre-send transaction: interpret once, accept once, then observe.
const OBJECT_RESPONSE = readFileSync(join(HERE, 'fixtures', 'optimizer-object-response.json'), 'utf8')
const OBJECT_VALUE = JSON.parse(OBJECT_RESPONSE)
const optimizerReply = (text = '保持输出纯函数，覆盖零值与跨小时边界。') => JSON.stringify({
  intent: { text: USER_TEXT, relation: 'new' }, add: [{ id: 'add-1', text }], scaffold: [], ask: [],
})

async function within(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('host harness timed out: ' + label)), 2000)
    })])
  } finally { clearTimeout(timer) }
}

async function wireHost({ sid, llm = fakeLlm(optimizerReply()), policy = {}, observed = true, enabled = true, cwd } = {}) {
  writeFileSync(join(TEST_HOME, 'po06.json'), JSON.stringify({
    settingsVersion: 1, enabled: true, rollout: { mode: 'all' },
    advisor: false, readTools: false, englishMode: false, ...policy,
  }), 'utf8')
  const mod = await import('../lib/index.js')
  mod.__resetObservedModelsForTest()
  const ctx = fakeCtx({ llm })
  mod.apply(ctx, {})
  mod.adapter.invalidatePolicy()
  const session = ctx.addSession(sid, { cwd })
  mod.adapter.enableGate.set(sid, { enabled, code: enabled ? 'test-enabled' : 'test-disabled', reason: 'host harness' })
  if (observed) emit(ctx, session, headerEvent())
  const interpret = (messageId, text = USER_TEXT) => within(ctx.post('/interpret', { sessionId: sid, messageId, text }), 'interpret ' + messageId)
  const submit = (runId, text, disposition = 'send', originalText = USER_TEXT) =>
    ctx.post('/packet', { sessionId: sid, runId, text, disposition, originalText, outgoingText: originalText })
  return { mod, ctx, session, llm, interpret, submit, context: () => ctx.context(session) }
}

await ta('observer never starts or catches up optimization after user/message or a later model header', async () => {
  const h = await wireHost({ sid: 'wire-observer-only', observed: false })
  emit(h.ctx, h.session, userEvent(USER_TEXT, 'already-sent'))
  emit(h.ctx, h.session, headerEvent())
  emit(h.ctx, h.session, pluginEvent('plugin notice'))
  await flushHostEvents()
  eq(h.llm.calls.length, 0, 'observation must not create a model call')
  eq(h.mod.adapter.getIntentText(h.session.id), '', 'no post-send packet or catch-up')
  eq(h.session.appended, [], 'unprepared events do not create injection cards')
})

await ta('real object-array response completes once; HTTP preview, accepted packet, context and full card agree exactly', async () => {
  const llm = controlledLlm()
  const h = await wireHost({ sid: 'wire-object-response', llm })
  const request = h.ctx.start('POST', '/interpret', { sessionId: h.session.id, messageId: 'object-run', text: OBJECT_VALUE.intent.text })
  const call = await within(llm.waitForCall(), 'object stream')
  const completion = deferred()
  call.complete(OBJECT_RESPONSE, { blockOnly: true, finishGate: completion.promise })
  await within(call.textSeen, 'object text arrived')
  await flushHostEvents()
  eq(request.settled, false, 'complete-looking JSON alone cannot finish the HTTP request')
  eq(h.mod.adapter.optimizationRuns.get(h.session.id).status, 'running', 'finish still belongs to the active run')
  eq(h.mod.adapter.getIntentText(h.session.id), '', 'do not expose an unfinished packet')
  completion.resolve()
  const response = await within(request.promise, 'object completion')
  eq(response.status, 200, 'valid object arrays succeed: ' + JSON.stringify(response.body))
  eq(response.body.ok, true)
  eq(response.body.status, 'ready')
  eq(response.body.runId, 'object-run', 'messageId is the stable run identity')
  const preview = response.body.packet
  ok(preview.length > 0, 'positive fixture must produce real directions')
  for (const section of ['add', 'scaffold', 'ask']) for (const item of OBJECT_VALUE[section]) {
    ok(preview.includes(item.text), section + ' object text survives parsing and rendering: ' + item.id)
  }
  eq(llm.calls.length, 1, 'accept the recorded response without retry or alternate compiler call')
  eq(response.body.usageTotal, 15, 'usage reaches the completed response')
  for (const phase of ['gateMs', 'routeMs', 'promptMs', 'modelMs', 'optimizationMs', 'englishRepairMs', 'taskTranslationMs', 'totalMs']) {
    ok(Number.isFinite(response.body.timings?.[phase]) && response.body.timings[phase] >= 0, 'completed result exposes real phase time: ' + phase)
  }
  // Both are wall-clock readings taken a few statements apart; equality is not guaranteed.
  ok(Math.abs(response.body.timings.totalMs - response.body.ms) <= 2, 'the two wall clock readings describe the same run')
  ok(response.body.timings.totalMs >= response.body.timings.modelMs, 'wall time includes model time')
  const finalLedger = readFileSync(join(TEST_HOME, 'po06-wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).findLast(row => row.sessionId === h.session.id && row.trigger === 'intercept-result')
  eq(finalLedger.timings, response.body.timings, 'wire result and client response share the same phase readings')
  eq(call.options.provider, 'wire-provider', 'use the observed provider')
  eq(call.options.model, 'wire-model', 'use the observed model')
  for (const key of ['maxTokens', 'max_tokens', 'maxOutputTokens']) ok(!(key in call.options), 'model output is not capped: ' + key)
  eq(h.mod.adapter.optimizationRuns.get(h.session.id).result.packet, preview, 'store before resolving the response')
  eq((await h.ctx.getApi('/packet?session=' + h.session.id)).body.packet, preview, 'GET preview reads the same sealed result')
  eq(h.context(), preview, 'actual context provider reads the exact preview when advisor is off')
  eq(h.session.appended, [], 'interpret must not append session state or synthetic user messages')
  eq(h.mod.adapter.intentStateOf(h.session), null, 'v3 production does not create legacy reducer state')
  eq(existsSync(statePath(TEST_HOME, h.session.id)), false, 'v3 production does not write reducer state to disk')

  const accepted = preview + '\n\n' + '用户审查后保留的完整细节。'.repeat(430)
  const submitted = await h.submit('object-run', accepted, 'send', OBJECT_VALUE.intent.text)
  eq(submitted.status, 200)
  eq(submitted.body.runId, 'object-run')
  eq(submitted.body.packet, accepted, 'return the final accepted text')
  eq(h.context(), accepted, 'actual context uses final accepted text')
  eq(h.mod.adapter.getWorkingText(h.session.id), accepted, 'working packet does not gain a second renderer')
  eq((await h.ctx.getApi('/packet?session=' + h.session.id)).body.packet, accepted)
  emit(h.ctx, h.session, { ...userEvent(OBJECT_VALUE.intent.text, 'host-message-id'), seq: 71 })
  await flushHostEvents()
  eq(h.session.appended.map(event => event.type), ['command/run', 'command/done'], 'only known host command anchors are appended after publication')
  const anchor = h.session.appended[0]
  eq(anchor.data.name, 'po06-inject')
  const { id } = JSON.parse(anchor.data.args)
  const byId = (await h.ctx.getApi('/injection?id=' + id)).body.injection
  const bySession = (await h.ctx.getApi('/injection?session=' + h.session.id)).body.injection
  eq(byId.injected, accepted, 'card is byte-for-byte final accepted text, including its tail beyond 4000 characters')
  eq(bySession.injected, accepted, 'session lookup returns that same card')
  eq(byId.chars, accepted.length)
  eq(byId.anchorSeq, 71)
  eq(byId.truncated, false)
  const run = h.mod.adapter.optimizationRuns.get(h.session.id)
  eq(run.submission, null, 'observer consumes explicit submission once')
  eq(run.applied.runId, 'object-run')
  emit(h.ctx, h.session, { ...userEvent(OBJECT_VALUE.intent.text, 'host-message-id'), seq: 71 })
  emit(h.ctx, h.session, pluginEvent(accepted))
  emit(h.ctx, h.session, headerEvent())
  await flushHostEvents()
  eq(llm.calls.length, 1, 'card and model observation never rerun the optimizer')
  eq(h.session.appended.length, 2, 'consumed submission yields only one card')
  eq(h.context(), accepted)
})

await ta('client run id binds to the actual sent message without losing understanding or duplicating task sources', async () => {
  const h = await wireHost({ sid: 'wire-submitted-capability', llm: fakeLlm(OBJECT_RESPONSE) })
  const runId = 'dsh-po06-client-run-identity'
  const actualMessageId = 'actual-host-human-message'
  const text = OBJECT_VALUE.intent.text
  const ready = await h.interpret(runId, text)
  eq(ready.status, 200)
  const before = structuredClone(h.mod.adapter.capability.status(h.session.id).current)
  eq(before.inputId, runId, 'pre-send interpretation owns the client run id')
  eq(before.sourceMessages, 1, 'one human draft is represented before sending')
  ok(before.optimizer?.add?.length > 0, 'positive control: optimizer directions have settled')
  ok(before.understanding?.summary, 'positive control: machine understanding has settled')
  eq((await h.submit(runId, ready.body.packet, 'send', text)).status, 200)

  const sent = { ...userEvent(text, actualMessageId), seq: 113 }
  emit(h.ctx, h.session, sent)
  await flushHostEvents()
  const task = h.mod.adapter.capability.taskContext(h.session)
  const after = h.mod.adapter.capability.status(h.session.id).current
  eq(task.currentInputId, actualMessageId, 'advisor task identity uses the actual host message id')
  eq(task.sourceRequestId, actualMessageId, 'task origin is rebound to that same human message')
  eq(task.inputs.map(input => ({ id: input.id, text: input.text, seq: input.seq })),
    [{ id: actualMessageId, text, seq: 113 }], 'submission replaces the draft source rather than adding another source')
  eq(after.inputId, actualMessageId)
  eq(after.sourceMessages, 1, 'observing the accepted send cannot duplicate taskInputs')
  eq(after.optimizer, before.optimizer, 'binding preserves the settled optimizer output')
  eq(after.understanding, before.understanding, 'binding preserves the settled machine understanding')
  eq(task.understanding, before.understanding, 'the advisor receives the preserved understanding')
  eq(h.context(), ready.body.packet, 'identity binding does not alter the accepted packet')

  emit(h.ctx, h.session, sent)
  emit(h.ctx, h.session, headerEvent())
  await flushHostEvents()
  const repeatedTask = h.mod.adapter.capability.taskContext(h.session)
  const repeated = h.mod.adapter.capability.status(h.session.id).current
  eq(repeatedTask.currentInputId, actualMessageId)
  eq(repeatedTask.inputs.length, 1, 'seeding or repeated observation never recreates the draft source')
  eq(repeated.sourceMessages, 1)
  eq(repeated.optimizer, before.optimizer)
  eq(repeated.understanding, before.understanding)
  eq(h.llm.calls.length, 1, 'identity binding cannot rerun the optimizer')
})

await ta('unmatched API or slash human input cannot claim a prepared packet or rearm it for a late original event', async () => {
  for (const [name, unrelatedText] of [
    ['api', 'A separate API client sent this unrelated human request.'],
    ['slash', '/help show the available commands'],
  ]) {
    const h = await wireHost({ sid: 'wire-unmatched-' + name })
    const runId = 'dsh-po06-prepared-' + name
    const unrelatedId = 'actual-unrelated-' + name
    const ready = await h.interpret(runId)
    eq(ready.status, 200)
    ok(ready.body.packet.length > 0, 'positive control: packet is ready before the unrelated event')
    eq((await h.submit(runId, ready.body.packet, 'send', USER_TEXT)).status, 200)
    const prepared = h.mod.adapter.optimizationRuns.get(h.session.id)
    eq(prepared.status, 'submitted')
    eq(prepared.submission.outgoingText, USER_TEXT, 'an explicit original/outgoing message owns the prepared packet')
    eq(h.mod.adapter.capability.status(h.session.id).current.inputId, runId)

    emit(h.ctx, h.session, { ...userEvent(unrelatedText, unrelatedId), seq: 201 })
    await flushHostEvents()
    const cancelled = h.mod.adapter.optimizationRuns.get(h.session.id)
    eq(cancelled.status, 'cancelled', 'unmatched real input invalidates the pending optimization')
    eq(cancelled.controller.signal.aborted, true)
    eq(cancelled.submission, null, 'unmatched input cannot leave a consumable pending packet')
    eq(cancelled.applied, null, 'unmatched input never claims the prepared submission')
    eq(cancelled.result, null, 'the rejected packet is invalidated')
    eq(h.session.appended, [], 'unrelated human input gets no injection-card anchors')
    eq(h.mod.adapter.getInjection(h.session.id), null, 'unrelated human input gets no injection record')
    eq(h.context(), '', 'the prepared packet cannot leak into unrelated input context')
    const unrelatedTask = h.mod.adapter.capability.taskContext(h.session)
    const unrelatedState = h.mod.adapter.capability.status(h.session.id).current
    eq(unrelatedTask.currentInputId, unrelatedId, 'unrelated input keeps its actual host identity')
    eq(unrelatedTask.inputs.filter(input => input.id === unrelatedId).map(input => ({ id: input.id, text: input.text, seq: input.seq })),
      [{ id: unrelatedId, text: unrelatedText, seq: 201 }], 'the actual unrelated human text remains its task source')
    eq(unrelatedState.optimizer, null, 'optimizer output is not bound to the unrelated message')
    eq(unrelatedState.understanding, null, 'the original draft understanding is not assigned to unrelated input')

    const lateId = 'actual-late-original-' + name
    emit(h.ctx, h.session, { ...userEvent(USER_TEXT, lateId), seq: 202 })
    emit(h.ctx, h.session, headerEvent())
    await flushHostEvents()
    const lateTask = h.mod.adapter.capability.taskContext(h.session)
    const lateState = h.mod.adapter.capability.status(h.session.id).current
    eq(lateTask.currentInputId, lateId, 'a late original event is observed as its own actual human input')
    eq(lateState.optimizer, null, 'matching text arriving late cannot restore cancelled optimizer output')
    eq(lateState.understanding, null)
    eq(h.mod.adapter.optimizationRuns.get(h.session.id).status, 'cancelled')
    eq(h.mod.adapter.optimizationRuns.get(h.session.id).submission, null)
    eq(h.mod.adapter.optimizationRuns.get(h.session.id).applied, null)
    eq(h.session.appended, [], 'the late original event cannot claim the cancelled result or create a card')
    eq((await h.ctx.getApi('/injection?session=' + h.session.id)).body.injection, null)
    eq((await h.ctx.getApi('/packet?session=' + h.session.id)).body.packet, '')
    eq(h.context(), '')
    eq((await h.submit(runId, ready.body.packet, 'send', USER_TEXT)).body.reason, 'optimization-not-ready', 'late acknowledgement cannot rearm the cancelled result')
    eq(h.llm.calls.length, 1, 'neither unrelated nor late observation reruns the optimizer')
  }
})

await ta('adapter-owned direct runs publish once and reject superseded late computations', async () => {
  const h = await wireHost({ sid: 'wire-adapter-owner' })
  const oldResult = deferred()
  let oldSignal
  const old = h.mod.adapter.handleInput(h.session, {
    messageId: 'direct-old', text: USER_TEXT,
    interpret: async ({ signal }) => { oldSignal = signal; return oldResult.promise },
  })
  eq(h.mod.adapter.optimizationRuns.get(h.session.id).runId, 'direct-old')
  eq(h.mod.adapter.optimizationRuns.get(h.session.id).status, 'running')
  eq(h.context(), '', 'direct computation is unpublished until it completes')
  const fresh = await h.mod.adapter.handleInput(h.session, {
    messageId: 'direct-new', text: USER_TEXT,
    interpret: async () => optimizerReply('当前直接调用的唯一方向。'),
  })
  eq(oldSignal.aborted, true, 'adapter invalidates the previous owned controller')
  eq(fresh.ok, true)
  eq(fresh.status, 'ready')
  eq(fresh.optimizer.add, ['当前直接调用的唯一方向。'], 'return canonical normalized optimizer result')
  eq(h.mod.adapter.optimizationRuns.get(h.session.id).runId, 'direct-new')
  eq(h.mod.adapter.optimizationRuns.get(h.session.id).result.packet, fresh.packet.text)
  eq(h.context(), fresh.packet.text, 'direct owner commits the exact computed packet')
  oldResult.resolve(optimizerReply('旧直接调用的方向。'))
  const late = await within(old, 'direct late result')
  eq(late.ok, false)
  eq(late.packet, null, 'superseded computation cannot return a publishable packet')
  eq(h.context(), fresh.packet.text)
  eq(h.mod.adapter.optimizationRuns.get(h.session.id).result.packet, fresh.packet.text)
  eq(h.llm.calls.length, 0, 'injected direct interpreters do not invoke the external model')
})

await ta('packet submission requires the current run id and rejects stale preview writes', async () => {
  const h = await wireHost({ sid: 'wire-packet-identity' })
  const ready = await h.interpret('identity-run')
  eq(ready.status, 200)
  const missing = await h.ctx.post('/packet', { sessionId: h.session.id, disposition: 'send', text: 'unowned edit' })
  eq(missing.status, 400)
  eq(missing.body.reason, 'run-required')
  const stale = await h.submit('older-run', 'stale edit')
  eq(stale.status, 400)
  eq(stale.body.reason, 'superseded-input')
  eq(h.mod.adapter.getIntentText(h.session.id), ready.body.packet, 'rejected writes preserve the current packet')
  eq((await h.submit('identity-run', ready.body.packet)).status, 200, 'correct identity remains usable')
  eq(h.llm.calls.length, 1)
})

await ta('newer pre-send run aborts the old owner; late completion cannot overwrite packet, progress or card', async () => {
  const llm = controlledLlm()
  const h = await wireHost({ sid: 'wire-superseded', llm })
  const oldRequest = h.ctx.start('POST', '/interpret', { sessionId: h.session.id, messageId: 'old-run', text: USER_TEXT })
  const oldCall = await within(llm.waitForCall(0), 'old stream')
  const newRequest = h.ctx.start('POST', '/interpret', { sessionId: h.session.id, messageId: 'new-run', text: USER_TEXT + '加新边界。' })
  const newCall = await within(llm.waitForCall(1), 'new stream')
  eq(oldCall.options.signal.aborted, true, 'superseding aborts the real old stream signal')
  newCall.complete(optimizerReply('本轮唯一方向：覆盖新边界。'), { usage: 30 })
  const current = await within(newRequest.promise, 'new completion')
  eq(current.status, 200)
  eq(current.body.runId, 'new-run')
  const progress = (await h.ctx.getApi('/interpret-progress?session=' + h.session.id)).body
  eq((await h.submit('new-run', current.body.packet, 'send', USER_TEXT + '加新边界。')).status, 200)
  emit(h.ctx, h.session, { ...userEvent(USER_TEXT + '加新边界。', 'sent-new-run'), seq: 81 })
  await flushHostEvents()
  oldCall.complete(optimizerReply('旧方向绝不覆盖当前结果。'), { usage: 99 })
  const old = await within(oldRequest.promise, 'late old completion')
  eq(old.body.ok, false, 'late response cannot claim completion')
  eq(old.body.packet, '')
  eq(h.mod.adapter.getIntentText(h.session.id), current.body.packet)
  eq(h.context(), current.body.packet)
  const after = (await h.ctx.getApi('/interpret-progress?session=' + h.session.id)).body
  eq(after.runId, progress.runId, 'old progress cannot acquire the new run id')
  eq(after.usage, progress.usage, 'late old usage cannot overwrite the active run usage')
  eq((await h.ctx.getApi('/injection?session=' + h.session.id)).body.injection.injected, current.body.packet)
  eq((await h.submit('old-run', 'late edit')).body.reason, 'superseded-input')
  eq(llm.calls.length, 2)
})

await ta('explicit cancel aborts in-flight stream and rejects late result and subsequent submit', async () => {
  const llm = controlledLlm()
  const h = await wireHost({ sid: 'wire-cancel', llm })
  const request = h.ctx.start('POST', '/interpret', { sessionId: h.session.id, messageId: 'cancel-run', text: USER_TEXT })
  const call = await within(llm.waitForCall(), 'cancel stream')
  const cancelled = await h.submit('cancel-run', '', 'cancel')
  eq(cancelled.status, 200)
  eq(call.options.signal.aborted, true, 'cancel invalidates live AbortController')
  eq(h.mod.adapter.optimizationRuns.get(h.session.id).status, 'cancelled')
  call.complete(optimizerReply('取消后的方向不得发布。'))
  const result = await within(request.promise, 'cancel late completion')
  eq(result.body.ok, false)
  eq(result.body.packet, '')
  eq(h.context(), '')
  eq(h.mod.adapter.getIntentText(h.session.id), '')
  eq((await h.submit('cancel-run', 'late cancelled packet')).body.reason, 'optimization-not-ready')
  eq(h.mod.adapter.getInjection(h.session.id), null)
  eq(llm.calls.length, 1)
})

await ta('aborted HTTP connection cancels the owner and cannot publish a complete-looking late response', async () => {
  const llm = controlledLlm()
  const h = await wireHost({ sid: 'wire-http-abort', llm })
  const request = h.ctx.start('POST', '/interpret', { sessionId: h.session.id, messageId: 'connection-run', text: USER_TEXT })
  const call = await within(llm.waitForCall(), 'connection stream')
  request.req.emit('aborted')
  eq(call.options.signal.aborted, true)
  call.complete(optimizerReply())
  const result = await within(request.promise, 'connection completion')
  eq(result.status, 499)
  eq(result.body.reason, 'aborted')
  eq(h.mod.adapter.getIntentText(h.session.id), '')
  eq(h.context(), '')
})

await ta('skip suppresses the entire advisor context without starting an optimizer or creating a card', async () => {
  const h = await wireHost({ sid: 'wire-skip', policy: { advisor: true } })
  h.mod.adapter.setIntentText(h.session.id, 'stale packet')
  h.mod.adapter.noteAdvisorDirective(h.session.id, '既有顾问方向也必须跳过。')
  ok(h.context().length > 0, 'positive control: packet and advisor workflow are visible before skip')
  // The skip owns the same id as the preview being rejected.
  const runId = h.mod.adapter.optimizationRuns.get(h.session.id).runId
  const skipped = await h.submit(runId, '', 'skip')
  eq(skipped.status, 200)
  eq(h.context(), '', 'skip hides packet, advisor workflow, feedback and directives together')
  emit(h.ctx, h.session, { ...userEvent(USER_TEXT, 'skip-sent'), seq: 91 })
  emit(h.ctx, h.session, headerEvent())
  await flushHostEvents()
  eq(h.context(), '', 'consumed skip remains in force for the current submission')
  eq(h.llm.calls.length, 0, 'skip and observer cause no model calls')
  eq(h.session.appended, [], 'no nonempty packet means no card')
  eq(h.mod.adapter.getInjection(h.session.id), null)
})

await ta('skip while optimizing aborts the live owner and blocks its late packet', async () => {
  const llm = controlledLlm()
  const h = await wireHost({ sid: 'wire-skip-live', llm, policy: { advisor: true } })
  const request = h.ctx.start('POST', '/interpret', { sessionId: h.session.id, messageId: 'skip-live-run', text: USER_TEXT })
  const call = await within(llm.waitForCall(), 'skip live stream')
  eq((await h.submit('skip-live-run', '', 'skip')).status, 200)
  eq(call.options.signal.aborted, true)
  emit(h.ctx, h.session, userEvent(USER_TEXT, 'skip-live-sent'))
  call.complete(optimizerReply())
  eq((await within(request.promise, 'skip late completion')).body.ok, false)
  await flushHostEvents()
  eq(h.context(), '', 'neither late packet nor advisor workflow leaks through skip')
  eq(h.mod.adapter.getInjection(h.session.id), null)
  eq(h.session.appended, [])
  eq(llm.calls.length, 1, 'no extra call after the explicitly skipped in-flight call')
})

await ta('valid empty v3 result completes and can be submitted once without a card or observer retry', async () => {
  const llm = fakeLlm(JSON.stringify({ intent: { text: USER_TEXT, relation: 'new' }, add: [], scaffold: [], ask: [] }))
  const h = await wireHost({ sid: 'wire-empty', llm })
  const result = await h.interpret('empty-run')
  eq(result.status, 200)
  eq(result.body.status, 'empty')
  eq(result.body.understood, true)
  eq(result.body.noAddition, true)
  eq(result.body.runId, 'empty-run')
  eq(result.body.packet, '')
  eq(h.mod.adapter.optimizationRuns.get(h.session.id).status, 'empty', 'empty completion is stored before responding')
  eq((await h.submit('empty-run', '', 'send')).status, 200, 'explicit send of a successful empty result is allowed')
  emit(h.ctx, h.session, userEvent(USER_TEXT, 'empty-sent'))
  await flushHostEvents()
  eq(llm.calls.length, 1)
  eq(h.context(), '')
  eq(h.session.appended, [])
})

await ta('legacy ops and malformed JSON fail visibly with one model call and no compiler packet', async () => {
  for (const [name, raw] of [['legacy', '{"ops":[]}'], ['malformed', '{"intent": nope']]) {
    const h = await wireHost({ sid: 'wire-reject-' + name, llm: fakeLlm(raw) })
    const result = await h.interpret(name + '-run')
    eq(result.status, 400)
    eq(result.body.status, 'failed')
    ok(result.body.reason, 'schema/parser reason remains visible')
    eq(result.body.packet, '')
    eq(result.body.usageTotal, 15, 'failed completion still reports real usage')
    eq(h.llm.calls.length, 1, 'rejection cannot start an alternate interpretation')
    eq(h.context(), '')
    eq(h.mod.adapter.optimizationRuns.get(h.session.id).status, 'failed')
  }
})

await ta('HTTP completion requires successful finish on both plain and read-tool paths', async () => {
  for (const toolsEnabled of [false, true]) for (const kind of [null, 'max-tokens', 'error']) {
    const chunks = [{ type: 'text-delta', text: optimizerReply() }, { type: 'usage', usage: { totalTokens: 17 } }]
    if (kind) chunks.push(finishChunk(kind))
    const h = await wireHost({ sid: 'wire-incomplete-' + toolsEnabled + '-' + kind, llm: fakeLlm(chunks), cwd: TEST_HOME, policy: { readTools: toolsEnabled } })
    const result = await h.interpret('unfinished-run')
    eq(result.status, 400, 'finish=' + kind + ' tools=' + toolsEnabled + ': ' + JSON.stringify(result.body))
    eq(result.body.ok, false)
    eq(result.body.status, 'failed')
    eq(result.body.packet, '')
    eq(result.body.usageTotal, 17, 'incomplete stream usage remains accounted')
    ok(/incomplete|error/.test(result.body.reason), 'concrete unfinished/error reason: ' + result.body.reason)
    eq(h.llm.calls.length, 1, 'no tool-free retry for unfinished output')
    eq(!!h.llm.calls[0].tools, toolsEnabled, 'exercise the intended production path')
    eq(h.context(), '')
  }
})

await ta('pre-send gate and assist=off refuse model calls and packet publication', async () => {
  for (const [name, options] of [['gate', { enabled: false }], ['off', { policy: { assist: 'off' } }]]) {
    const h = await wireHost({ sid: 'wire-policy-' + name, ...options })
    const result = await h.interpret('blocked-' + name)
    eq(result.status, 400)
    eq(result.body.ok, false)
    eq(h.llm.calls.length, 0)
    eq(h.context(), '')
    eq(h.mod.adapter.getIntentText(h.session.id), '')
    ok(result.body.reason, 'policy/gate failure remains attributable')
  }
})

await ta('saved custom prompt and prior history reach the actual pre-send model request', async () => {
  const h = await wireHost({ sid: 'wire-custom-prompt' })
  const promptPath = join(TEST_HOME, 'po06-prompt.md')
  const prompt = '【自定义优化核心】给出本次任务的制作与自反馈方向。'
  writeFileSync(promptPath, prompt, 'utf8')
  try {
    emit(h.ctx, h.session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '此前已讨论 Python 的输出格式。' }] } } })
    const result = await h.interpret('prompt-run')
    eq(result.status, 200)
    eq(h.llm.calls.length, 1)
    const actual = h.llm.calls[0]
    ok(actual.system.startsWith(prompt), 'saved prompt is the actual system core')
    ok(JSON.stringify(actual.messages).includes('此前已讨论 Python 的输出格式。'), 'real prior history reaches the request')
    eq(JSON.parse(actual.messages[0].content[0].text).originalText, USER_TEXT, 'source is complete and separate from history')
  } finally { rmSync(promptPath, { force: true }) }
})

await ta('settings API disable hook clears prepared packet and prevents stale revival on re-enable', async () => {
  const h = await wireHost({ sid: 'wire-settings-off' })
  const result = await h.interpret('settings-run')
  eq(result.status, 200)
  ok(h.context().length > 0, 'positive control: prepared packet injects')
  const disabled = await h.ctx.post('/settings', { assist: 'off' })
  eq(disabled.status, 200)
  eq(disabled.body.hookError, null, 'actual settings hook succeeds')
  eq(h.context(), '')
  eq(h.mod.adapter.getIntentText(h.session.id), '', 'settings hook invalidates the cached packet')
  eq((await h.ctx.post('/settings', { assist: 'auto' })).status, 200)
  h.mod.adapter.enableGate.set(h.session.id, { enabled: true, code: 'test-enabled', reason: 'restored' })
  eq(h.context(), '', 'old prepared packet does not revive after restoring policy')
  eq(h.llm.calls.length, 1, 'policy changes cannot trigger model work')
})

// 会话 id 来自宿主，按**不可信输入**处理：白名单字符，杜绝路径穿越。
t('会话 id 落成文件名前必须消毒（不可信输入）', () => {
  const f = (s) => safeSessionFile(s)
  eq(f('session-abc_1.2'), 'session-abc_1.2.json', '正常 id 保持原样')
  ok(!f('../../etc/passwd').includes('/'), '不得含路径分隔符：' + f('../../etc/passwd'))
  ok(!f('..\\..\\windows\\system32').includes('\\'), '反斜杠也要消掉：' + f('..\\..\\windows\\system32'))
  eq(f('../../etc/passwd'), '.._.._etc_passwd.json', '穿越字符被替换')
  eq(f(''), 'unknown.json', '空 id 也得有确定的名字')
  eq(f(null), 'unknown.json', 'null 同理')
  ok(f('x'.repeat(500)).length <= 168, '长度必须有上限：' + f('x'.repeat(500)).length)
  // 真正要守的性质是**包含关系**（解析后仍在存储目录里），而不是"字符串里没有 .."：
  // 消毒后的文件名 `.._.._evil.json` 里确实含有 ".."，但那只是文件名里的普通字符，
  // 不构成穿越。断言"没有 .."是**错的断言**（第一次就是这么写错的）。
  const dir = join(TEST_HOME, 'po06-state')
  for (const evil of ['../../../evil', '..\\..\\evil', 'a/../../b', '/abs/path']) {
    const resolved = resolve(statePath(TEST_HOME, evil))
    ok(resolved.startsWith(resolve(dir) + sep),
      `解析后必须仍在存储目录内：${evil} -> ${resolved}`)
  }
})

// 存储读到的坏数据**绝不能**被当成状态用：宁可当作"没有状态"（重新开始），
// 也不能把垃圾灌进 reducer——那会产出无依据的包（"不造成虚假的"）。
t('存储读到坏数据必须拒绝（不把垃圾当状态）', () => {
  const st = createStateStore({ home: TEST_HOME })
  const sid = 'session-corrupt'
  const p = statePath(TEST_HOME, sid)
  // 目录由 save 惰性创建；这里要手写坏文件，所以先确保目录存在
  mkdirSync(dirname(p), { recursive: true })
  const cases = [
    ['{"revision":"nope","items":[]}', 'revision 类型不对'],
    ['{"revision":1}', '缺 items'],
    ['{"revision":1,"items":"not-array"}', 'items 不是数组'],
    ['{ not json', '不是合法 JSON'],
    ['"just a string"', '不是对象'],
    ['[1,2,3]', '数组不算状态'],
  ]
  for (const [body, why] of cases) {
    writeFileSync(p, body, 'utf8')
    eq(st.load(sid), null, `坏数据必须返回 null（${why}）`)
  }
  eq(st.load('session-never-written'), null, '不存在 ⇒ null（不是抛错）')
})

// 淘汰策略：每个会话一份文件、从不删除 = 无限增长。
// "把用户磁盘写满"是本项目被明确要求避免的事，所以上限**必须有**，而且要测边界。
t('存储有上限：超出后淘汰最旧的，且永不误删刚写的那份', () => {
  const home = tempHome('po06-prune-')
  const st = createStateStore({ home, keep: 3 })
  // Explicit historical mtimes make the eviction contract deterministic on coarse Windows clocks.
  const ids = ['s1', 's2', 's3', 's4', 's5']
  for (const [index,id] of ids.entries()) {
    st.save(id, { revision: 1, items: [] })
    const stamp=new Date(Date.UTC(2000,0,1)+index*1000)
    utimesSync(statePath(home,id),stamp,stamp)
  }
  eq(st.count(), 3, '最多只保留 keep 份')
  eq(st.load('s5'), { revision: 1, items: [] }, '**最新写的那份必须还在**（淘汰不得误删自己）')
  eq(st.load('s1'), null, '最旧的应被淘汰')
  eq(st.load('s2'), null, '次旧的也应被淘汰')
  ok(st.load('s3') && st.load('s4') && st.load('s5'), '最近三份都在')
})

t('上限取非法值时退回默认，绝不出现"0 份"这种自毁配置', () => {
  const home = tempHome('po06-keep-')
  for (const bad of [0, -1, NaN, Infinity, 'x', null]) {
    const st = createStateStore({ home, keep: bad })
    eq(st.keep, 200, `keep=${String(bad)} 必须退回默认 200`)
    st.save('sess-' + String(bad), { revision: 1, items: [] })
    ok(st.load('sess-' + String(bad)), `keep=${String(bad)} 时保存的文件必须还在`)
  }
  // 合法值原样采用
  eq(createStateStore({ home, keep: 5 }).keep, 5, '合法值不改变')
  eq(createStateStore({ home, keep: 2.9 }).keep, 2, '小数向下取整')
})

// ── 状态文件读不出来时**不许静默从头开始**（EV-0122）────────────────────
// `load()` 把"真的没有"与"文件坏了/形状不对"折成同一个 `null`，下游会把 `null` 当成
// "尚无状态" ⇒ 新建空状态 ⇒ **save() 覆盖掉那份坏文件** ⇒ 用户积累的长期约束静默消失。
t('inspect 分得清"没有"与"读不出来"（load 的 null 分不清）', () => {
  const home = tempHome('po06-inspect-')
  const st = createStateStore({ home })
  mkdirSync(join(home, 'po06-state'), { recursive: true })   // 目录是 save 时懒创建的

  // ① 真的没有
  const none = st.inspect('sess-none')
  eq(none.present, false, 'present=false 表示真的没有')
  eq(none.ok, true, '没有不是错误')
  eq(st.load('sess-none'), null, 'load 仍是 null（兼容）')

  // ② JSON 坏
  writeFileSync(join(home, 'po06-state', 'sess-bad.json'), '{这不是 JSON', 'utf8')
  const bad = st.inspect('sess-bad')
  eq(bad.present, true, '文件在')
  eq(bad.ok, false, '读不出来')
  eq(bad.reason, 'malformed-json', '理由要具体：' + bad.reason)
  eq(st.load('sess-bad'), null, 'load 仍返回 null（所以光看 load 分不清）')

  // ③ 形状不对（别的版本写的）
  writeFileSync(join(home, 'po06-state', 'sess-shape.json'), JSON.stringify({ hello: 1 }), 'utf8')
  eq(st.inspect('sess-shape').reason, 'shape-mismatch', '形状不符要单独给理由')

  // ④ 正常
  st.save('sess-ok', { revision: 1, items: [] })
  eq(st.inspect('sess-ok').ok, true, '正常文件 ok=true')
})

t('quarantine 把坏文件改名留证据，而不是让它被覆盖', () => {
  const home = tempHome('po06-quar-')
  const st = createStateStore({ home })
  mkdirSync(join(home, 'po06-state'), { recursive: true })   // 同上
  const p = join(home, 'po06-state', 'sess-broken.json')
  writeFileSync(p, '{坏掉的长期约束', 'utf8')
  const dst = st.quarantine('sess-broken')
  ok(dst && dst.includes('.corrupt-'), '应改名成 .corrupt-<ts>.json：' + dst)
  eq(existsSync(p), false, '原路径必须不再存在（否则下一次 save 会覆盖它）')
  eq(existsSync(dst), true, '残骸必须在')
  eq(readFileSync(dst, 'utf8'), '{坏掉的长期约束', '**内容必须原样保留**（那可能就是用户的约束）')
})

// ── 4d. 坏掉的状态文件：**不许静默从头开始**（EV-0122）───────────────────
// 集成级验证：`intentStateOf` 一旦发现"文件在但读不出来"，必须
// （①）隔离留证据、（②）记一条台账，然后才按"尚无状态"继续。
// 否则下游会新建空状态并把坏文件**覆盖掉**——用户的长期约束静默消失、连残骸都没有。
await ta('状态文件读不出来：隔离留证据 + 记台账，不静默覆盖（EV-0122）', async () => {
  const mod = await import('../lib/index.js')
  const ctx = fakeCtx({ llm: fakeLlm(optimizerReply()) })
  mod.apply(ctx, {})
  const sid = 'session-ev0122'
  const storeDir = join(TEST_HOME, 'po06-state')
  mkdirSync(storeDir, { recursive: true })
  const p = statePath(TEST_HOME, sid)
  writeFileSync(p, '{坏掉的长期约束：不要预览其他文件', 'utf8')
  mod.adapter.stateBySession.delete(sid)          // 确保走磁盘那条路

  const st = mod.adapter.intentStateOf(fakeSession(sid, ctx.projections))
  eq(st, null, '读不出来 ⇒ 当作"尚无状态"继续（**不抛**）')
  eq(existsSync(p), false, '原路径必须已被改名（否则随后的 save 会覆盖那份坏文件）')
  const remains = readdirSync(storeDir).filter((f) => f.includes('.corrupt-'))
  ok(remains.length >= 1, '必须留下一份 .corrupt- 残骸：' + JSON.stringify(readdirSync(storeDir)))
  const kept = readFileSync(join(storeDir, remains[remains.length - 1]), 'utf8')
  ok(kept.includes('不要预览其他文件'), '**残骸内容必须原样保留**（那可能就是用户的约束）')

  const wire = readFileSync(join(TEST_HOME, 'po06-wire.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const recs = wire.filter((r) => r.trigger === 'state-unreadable' && r.sessionId === sid)
  eq(recs.length, 1, '必须留一条 state-unreadable 台账：' + JSON.stringify(wire.map((r) => r.trigger)))
  eq(recs[0].reason, 'malformed-json', '理由要具体（不是笼统的"读不到"）')
  ok(recs[0].quarantined && String(recs[0].quarantined).includes('.corrupt-'), '台账里要写上残骸路径')
})


// ── 4e. 自检**不得因"服务这一刻不可用"而抛错**（EV-0131）───────────────────
// 实测（真机、隔离 home、headless 与 web 两个 profile）：自检跑到"会话装配探针"时
// `sessionController` 仍是 null ⇒ 旧代码直接 `sc.create(...)` ⇒ **TypeError**，
// 整份报告只剩一行堆栈，而**前面 10 步其实都过了**——那正是这份自检的价值所在。
// "失败要可归因，不要只剩堆栈"：用源码结构把它钉住（这条路径只在真机里才跑得到）。
t('自检：可选服务不可用时必须**如实记一步**，不得直接调用（EV-0131）', () => {
  const src = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')
  // ⚠ 判据定位（2026-09-22 修正）：原来按**第一处** `const sc = adapter.services.sessionController`
  //   去切窗口 —— 但 0.6 在别处（模型选择探针）也有一行同样的变量声明，于是窗口切到了**另一段代码**，
  //   守卫明明还在却被判成"找不到"。现在改成锚在自检独有的那句话上（`services-unavailable-in-this-profile`）。
  const i = src.indexOf('services-unavailable-in-this-profile')
  ok(i > 0, '找不到自检里的会话探针兜底分支')
  const from = Math.max(0, i - 1800)
  const guard = src.slice(from, i + 400)
  ok(/const sc = adapter\.services\.sessionController/.test(guard), '探针入口要先读 sessionController')
  ok(/const agents = adapter\.services\.agents/.test(guard), '也要读 agents')
  ok(/if \(!sc \|\| !agents\)/.test(guard), '必须先判空：' + guard.slice(0, 160))
  ok(/report\.steps\.sessionProbe\s*=/.test(guard), '判空后要记一步 sessionProbe（可归因）')
  const guardIdx = src.indexOf('if (!sc || !agents)', from)
  const createIdx = src.indexOf('sc.create(', guardIdx)
  ok(guardIdx > 0 && createIdx > guardIdx, '判空必须发生在调用之前')
  // 并且 sessionController 也要**懒注入**（只在 apply 读一次的话它永远是 null）
  ok(/ctx\.inject\(\['sessionController'\]/.test(src), 'sessionController 必须是懒注入（与 agents 同一套写法）')
})


// 旧写法硬编码真实 home 的绝对路径 ⇒ 单测的 apply() 把报告写进**真实**证据目录
// （实测 1532 份里有 1530 份来自单测），而且隔离实例与日常实例的报告混在一起。
t('报告目录跟着 DSH_HOME 走，不写进真实 home', () => {
  const src = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')
  ok(/EVIDENCE_DIR\s*=\s*process\.env\.DSH_PO06_EVIDENCE_DIR\s*\|\|\s*join\(DSH_HOME/.test(src),
    'EVIDENCE_DIR 必须由 DSH_HOME 派生（或可被环境覆盖）')
  ok(!/EVIDENCE_DIR\s*=\s*'[A-Za-z]:\//.test(src), '不得再出现硬编码的绝对路径')
  // 并且 DSH_HOME 必须**定义在** EVIDENCE_DIR 之前（否则是暂时性死区，模块直接崩）
  const homeIdx = src.indexOf('const DSH_HOME =')
  const evIdx = src.indexOf('const EVIDENCE_DIR =')
  ok(homeIdx > 0 && evIdx > homeIdx, 'DSH_HOME 必须先于 EVIDENCE_DIR 定义（否则 TDZ 崩在加载期）')
})

// ── 4c. 分叉继承（EV-0091）：分叉会话必须接着父会话的约束走 ─────────────
// 宿主分叉会给**新的 sessionId**，而状态按 id 存 ⇒ 不处理就是"静默无状态"，
// 恰好破坏分叉的语义（"从这里接着走"）。这组测试同时守住最危险的一点：**别名**。
t('分叉继承：深拷贝 + 改写归属 + 留下出处；且绝不与父状态共享引用', () => {
  const parent = {
    schemaVersion: 1, sessionId: 'sess-parent', revision: 7, lastInputRevision: 7,
    items: [{ id: 'r1', kind: 'user_requirement', text: '不要预览其他文件', status: 'active' }],
    questions: [], sourceMessageIds: ['m1'],
  }
  const child = inheritStateForFork(parent, 'sess-child', 'sess-parent')
  eq(child.sessionId, 'sess-child', '归属必须改成子会话')
  eq(child.inheritedFrom, 'sess-parent', '必须留下出处')
  eq(child.inheritedAtRevision, 7, '记录继承时的修订号')
  eq(child.items.length, 1, '约束必须带过来')
  eq(child.items[0].text, '不要预览其他文件', '内容原样')
  eq(parent.sessionId, 'sess-parent', '父状态不得被改写')
  ok(!parent.inheritedFrom, '父状态不得被加上出处标记')

  // **别名检查**：改子状态（含嵌套）绝不能影响父状态。
  // 这一条是深拷贝与浅拷贝的唯一区别，浅拷贝下测试必须变红。
  child.items[0].text = 'MUTATED'
  child.items.push({ id: 'r2', kind: 'user_requirement', text: 'x', status: 'active' })
  child.revision = 99
  eq(parent.items.length, 1, '父状态的条目数不得被子会话改动')
  eq(parent.items[0].text, '不要预览其他文件', '父状态的条目内容不得被子会话改动')
  eq(parent.revision, 7, '父状态的修订号不得被子会话改动')
})

t('分叉继承：父状态缺失/非法时返回 null（不伪造状态）', () => {
  eq(inheritStateForFork(null, 'c', 'p'), null, '父状态为 null ⇒ null')
  eq(inheritStateForFork(undefined, 'c', 'p'), null, 'undefined ⇒ null')
  eq(inheritStateForFork('not-an-object', 'c', 'p'), null, '非对象 ⇒ null')
})

// 静态守卫（EV-0101 / EV-0132）：插件自己的代码里**不得出现写死的绝对路径**。
// 为什么值得一条测试：这类问题在本项目里反复出现（证据目录 EV-0084、自检 flag 与工作目录、
// 审计探针里的 profiles/web、冒烟输出目录 EV-0101、llm 模块 EV-0132），每次的后果都是**同一个**：
// 隔离实例与日常实例互相读写、或"查错对象却照样给结论"、或换台机器就必然失败。
//
// 规则（EV-0132 收紧）：`lib/` 里出现"盘符路径"或"POSIX home 前缀"就算违规。
// 唯一豁免是**机器级程序目录**（浏览器安装位置，任何 Windows 机器都一样，且不指向用户数据），
// 且必须逐条列在这里——新增一条要**有意识地**改这张表，而不是随手加个路径。
t('lib 里不得写死绝对路径（只允许从 DSH_HOME / 宿主入口派生）', () => {
  const dir = join(HERE, '..', 'lib')
  // 机器级程序目录白名单（不指向用户数据，任何同平台机器都相同）
  const PROGRAM_DIRS = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/',
    'C:/Program Files/Microsoft/Edge/Application/',
    'C:/Program Files/Google/Chrome/Application/',
    'C:/Program Files (x86)/Google/Chrome/Application/',
  ]
  // 盘符路径（引号/空白后紧跟 X:/ 或 X:\）与 POSIX home 前缀
  const DRIVE_RE = /(^|[\s'"`(=])[A-Za-z]:[/\\]/g
  const HOME_RE = /\/Users\/|\/home\/|\/root\//
  const bad = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue
    const src = readFileSync(join(dir, f), 'utf8')
    src.split('\n').forEach((line, i) => {
      const at = f + ':' + (i + 1)
      const hits = line.match(DRIVE_RE) || []
      const homeHit = HOME_RE.test(line)
      if (hits.length === 0 && !homeHit) return
      const allowed = PROGRAM_DIRS.some((d) => line.includes(d))
      // 一行里若同时有豁免目录和别的路径，仍算违规（豁免只覆盖它自己那一处）
      const driveCount = hits.length
      if (allowed && driveCount === 1 && !homeHit) return
      bad.push(at + ' ' + line.trim().slice(0, 90))
    })
  }
  eq(bad, [], '发现写死的绝对路径 ⇒ 应改为从 DSH_HOME / 宿主入口 / os.homedir() 派生：\n' + bad.join('\n'))
})

// ── 4d. 投递链路最后一环抛错时**必须留痕**（EV-0102）────────────────────
// 这条守的是 EV-0078 那类事故：`systemPrompt.context` 的 text 提供者里若吞掉错误，
// 意图包就会**毫无痕迹地**消失——产品安静地不做事，用户以为它开着。
// 它同时区分两种 `return ''`：**决定**（没有 agent / 闸门未放行）不该记噪声，
// **意外**（抛错）必须记。
await ta('EV-0102：context 提供者抛错要留痕；正常放行要返回包；闸门拒绝不记噪声', async () => {
  const { mod, ctx } = await wireHost({ sid: 'wire-provider-setup', policy: { advisor: true } })
  const sp = ctx.ctxRefs.systemPrompt
  ok(sp && sp.contextDefs.length === 1, '必须注册恰好一个 context 定义')
  const provider = sp.contextDefs[0].text
  ok(typeof provider === 'function', 'context 的 text 必须是提供者函数')

  const sid = 'session-ev0102'
  const ledger = join(TEST_HOME, 'po06-wire.jsonl')
  const readLedger = () => existsSync(ledger) ? readFileSync(ledger, 'utf8') : ''

  // ① 闸门未放行 ⇒ 返回空，但**不是错误**（不该产生 throw 记录）
  mod.adapter.enableGate.set(sid, { enabled: false, code: 'test-disabled', reason: '单测' })
  eq(provider({ agent: { id: sid } }), '', '闸门未放行 ⇒ 空')
  ok(!readLedger().includes('context-provider-threw'), '闸门拒绝是**决定**，不该记为抛错')

  // ② 放行且有包 ⇒ 返回包本身
  mod.adapter.enableGate.set(sid, { enabled: true, code: 'test-forced', reason: '单测' })
  mod.adapter.setIntentText(sid, '【包】测试文本')
  const rendered = provider({ agent: { id: sid } })
  ok(rendered.includes('【包】测试文本'), '放行时保留该会话的包')
  ok(rendered.includes('解题贡献与独立复核'), '放行时同时给出工作模型顾问流程')
  mod.adapter.setIntentText(sid, '')
  ok(provider({ agent: { id: sid } }).includes('解题贡献与独立复核'), '解释层没有新包也不能丢掉顾问调用流程')

  // ③ 让闸门判定**抛错** ⇒ 必须返回空，且台账里留下一条 context-provider-threw
  const origEnsure = mod.adapter.enableGate.ensure
  mod.adapter.enableGate.ensure = () => { throw new Error('boom-for-test') }
  eq(provider({ agent: { id: sid } }), '', '抛错时仍返回空（不打断装配）')
  const after = readLedger()
  ok(after.includes('context-provider-threw'), '**意外**必须在台账留痕：' + after.slice(-200))
  ok(after.includes('boom-for-test'), '台账要带原始错误信息')

  // ④ 同一会话同一错误**只记一次**（否则每一步一条，会把台账淹掉）
  const count1 = (readLedger().match(/context-provider-threw/g) || []).length
  provider({ agent: { id: sid } })
  provider({ agent: { id: sid } })
  const count2 = (readLedger().match(/context-provider-threw/g) || []).length
  eq(count2, count1, '同一会话同一错误必须去重')

  mod.adapter.enableGate.ensure = origEnsure
})

// ── 4f. **档位=关闭 ⇒ 一个字节都不许注入**（用户 2026-09-22 的报障）────────────
// 报障原话："修复当插件档位为'关闭'后，再发消息给 ai，会自动注入上一次对话的优化上下文的 bug"。
// 用户给的两条猜测**都成立**，缺一不可：
//   ① 门禁漏判：context 提供者只查启用闸门（灰度/enabled/双重拦截），**没查档位政策**
//      ⇒ `assist:'off'` 只挡住了"产生新包"，挡不住"注入已有包"；
//   ② 缓存没清：关档时没有任何清理动作，`intentBySession` 里那份旧包一直留着。
// 这条用例把 ① 钉死（② 在下面 setIntentText/清理那条路径上由 clearIntentTexts + 设置钩子覆盖）。
await ta('档位关闭（assist:off）⇒ context 提供者必须返回空，哪怕闸门放行、缓存里有旧包', async () => {
  const mod = await import('../lib/index.js')
  const ctx = fakeCtx({ llm: fakeLlm(optimizerReply()) })
  mod.apply(ctx, {})
  const sp = ctx.ctxRefs.systemPrompt
  const provider = sp.contextDefs[0].text
  const sid = 'session-gate-off'
  mod.adapter.enableGate.set(sid, { enabled: true, code: 'test-forced', reason: '单测放行' })
  mod.adapter.setIntentText(sid, '【旧包】这是上一轮的优化上下文')

  // ① 档位正常（默认 assist:auto）⇒ 照常注入
  mod.adapter.invalidatePolicy()
  ok(provider({ agent: { id: sid } }).includes('旧包'), '默认档位下应当注入（对照组）')

  // ② 写一份 assist:'off' 的配置 ⇒ 政策变成"不注入" ⇒ 必须返回空字符串
  const cfgPath = join(TEST_HOME, 'po06.json')
  const before = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null
  writeFileSync(cfgPath, JSON.stringify({ settingsVersion: 1, enabled: true, rollout: { mode: 'all' }, assist: 'off' }), 'utf8')
  try {
    mod.adapter.invalidatePolicy()          // 真机上由 POST /settings 的钩子做；这里等价调用
    eq(provider({ agent: { id: sid } }), '', '关闭档 ⇒ 硬短路：连缓存都不看')
    // ③ 就算缓存里还留着包（钩子没跑到/手工改配置），提供者也不许放它出去
    mod.adapter.setIntentText(sid, '【旧包】残留')
    eq(provider({ agent: { id: sid } }), '', '缓存里有旧包也不行（门禁必须赢）')
  } finally {
    if (before === null) { try { rmSync(cfgPath, { force: true }) } catch { /* best effort */ } } else writeFileSync(cfgPath, before, 'utf8')
    mod.adapter.invalidatePolicy()
  }
  // ④ 档位恢复 ⇒ 注入恢复（不是"永久关死"）
  ok(provider({ agent: { id: sid } }).includes('旧包'), '档位恢复后照常注入')
})

// ── 3c. ADR-0087：投递消息**不得**再用被会话格式 v4 拒收的 `kind:'plugin'` ──────────
// 依据（读的是宿主源码，不是猜）：0.1.7 的 `dsh-session-format-v3-to-v4` 在准入时
// `if (… || value["kind"] === "plugin") throw new SessionFormatError(
//  "format v4 message requires a producer-owned source kind")`；
// 而它给第三方插件定的规范名是 `plugin:<包名>`（`producerKind()` 的兜底分支）。
t('ADR-0087：投递来源必须是生产者自报的 kind（0.1.7 的 v4 准入拒收 plugin）', () => {
  for (const f of ['index.js', 'eval-llm.js']) {
    const s = readFileSync(join(HERE, '..', 'lib', f), 'utf8')
    // 只在**代码**里查：注释里允许（也必须）讨论"为什么不能这么写"
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    ok(!/kind:\s*'plugin'/.test(code),
      f + " 的代码里出现了 `kind: 'plugin'`：宿主 0.1.7 起会在写会话日志那一步抛 SessionFormatError")
    ok(!/plugin:\s*'@dsh-external\/dsh-wish-specializer'/.test(code),
      f + ' 里还留着旧的 `plugin` 字段（新形态不需要它）')
  }
  const idx = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')
  ok(/const PRODUCER_KIND = 'plugin:@dsh-external\/dsh-wish-specializer'/.test(idx),
    '生产者 kind 必须显式定义（名字有依据：宿主迁移表的兜底命名）')
  ok(/kind: PRODUCER_KIND/.test(idx), '投递消息必须用 PRODUCER_KIND 构造')
  ok(/form: 'notice'/.test(idx), '`notice` 形态要保留（summary 上限 120 与宿主一致）')
})

// ── 未接线的完整性校验：**保留但必须显式** ─────────────────────────────
// 这个用例守的是"看起来有保护、其实没接线"（与 EV-0078 同源）。
// `lib/bash/runtime-integrity.mjs` 当前没有任何生产调用点：热路径只做 `--version` 探测。
// 为什么不用删掉它了事：删掉会把"完整性校验没做"这个事实一起抹掉，后来者还得重写一遍。
// 为什么写成用例：**一旦有人把它接进生产路径，这条会红**，接线的人必须顺手更新头部说明。
await ta('未接线的完整性校验：保留、写明、并在接线时变红', async () => {
  const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  const target = join(LIB, 'bash', 'runtime-integrity.mjs')
  ok(existsSync(target), 'runtime-integrity.mjs 应当保留（它记录着完整性校验尚未接线）')
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
  const importers = walk(LIB)
    .filter((f) => /\.(js|mjs)$/.test(f) && f !== target)
    .filter((f) => readFileSync(f, 'utf8').includes('runtime-integrity'))
  eq(importers.map((f) => f.slice(LIB.length + 1)), [], '当前不该有生产调用点；接线后请更新说明与本用例')
  ok(readFileSync(target, 'utf8').includes('没有任何生产调用点'), '头部必须写明未接线，别让它看起来像在保护什么')
})


// ── 传输层中断的**有界**重试（真机 2026-10-25：82 秒后 TRANSPORT，整轮作废）──────
// 这不是语义重试：不重放解析、不补占位；只在连接被对端掐断且本轮仍有效时重发一次。
await ta('传输中断重试一次后成功：两次模型调用、结果可用、台账记下重试', async () => {
  let calls = 0
  const llm = fakeLlm(() => {
    calls += 1
    if (calls === 1) throw new Error('llm-error: {"message":"DeepSeek Messages transport failed","code":"TRANSPORT"}')
    return optimizerReply('重试后仍然给出方向。')
  })
  const h = await wireHost({ sid: 'wire-transport-retry', llm })
  const response = await h.interpret('retry-run')
  eq(response.status, 200, '重试成功后应正常返回：' + JSON.stringify(response.body))
  eq(response.body.ok, true)
  eq(response.body.status, 'ready')
  eq(llm.calls.length, 2, '恰好两次模型调用')
  eq(response.body.timings.transportRetries, 1, '记下重试次数')
  eq(response.body.timings.modelAttempts.length, 2, '两次尝试各自的耗时都要留证')
  ok(String(response.body.timings.modelAttempts[0].error || '').includes('TRANSPORT'), '第一次失败原因保留')
  eq(response.body.packet.includes('重试后仍然给出方向。'), true, '重试结果进入最终包')
  const ledger = readFileSync(join(TEST_HOME, 'po06-wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  ok(ledger.some(row => row.sessionId === h.session.id && row.trigger === 'optimizer-transport-retry'), '台账必须有重试记录')
})

await ta('传输中断重试仍失败：只试两次就如实失败，不无限重发', async () => {
  const llm = fakeLlm(() => { throw new Error('llm-error: {"message":"DeepSeek Messages transport failed","code":"TRANSPORT"}') })
  const h = await wireHost({ sid: 'wire-transport-twice', llm })
  const response = await h.interpret('retry-fail')
  eq(response.body.ok, false, '两次都断线必须如实失败')
  eq(response.body.status, 'failed')
  eq(llm.calls.length, 2, '最多一次重试，绝不第三次')
  ok(String(response.body.reason || '').includes('TRANSPORT'), '失败原因保留原始 TRANSPORT')
})

// Actual failed runs must consume rejected tools in the same optimization conversation.
const rejectedRequests = JSON.parse(readFileSync(join(HERE, 'fixtures', 'rejected-optimizer-tool-requests.json'), 'utf8'))
for (const sample of rejectedRequests) await ta('recorded tool rejection completes without restarting the optimizer: ' + sample.sourceLine, async () => {
  const raw = optimizerReply('基于原话给出方向；未读取的环境保持未知。')
  const llm = { calls: [], stream(options) {
    this.calls.push(options)
    const first = this.calls.length === 1
    if (!first) {
      eq(this.calls.length, 2, 'only the pending tool response and its final answer')
      eq(options.system, this.calls[0].system, 'same system and task contract')
      eq(options.messages[0], this.calls[0].messages[0], 'original prompt retained, not a new request')
      ok(!options.tools, 'rejected lookup ends further tool use')
      const assistant = options.messages.find(message => message.role === 'assistant')
      ok(assistant, 'model sees its own original tool requests')
      eq(assistant.content.filter(block => block.type === 'tool-call').map(block => ({id:block.id,name:block.name,arguments:JSON.parse(block.arguments)})),sample.calls)
      const results = options.messages.filter(message => message.role === 'tool')
      eq(results.length,sample.calls.length,'every rejected call has its own result')
      for (const [index,result] of results.entries()) {
        eq(result.toolCallId,sample.calls[index].id);eq(result.isError,true)
        ok(result.content.some(block=>block.type==='text' && block.text.includes('拒绝')), 'actual refusal reaches the model')
      }
      ok(options.messages.at(-1).content.some(block=>block.text.includes('intent/add/scaffold/ask')), 'finish the requested format using this conversation')
    }
    return (async function* () {
      if (first) {
        for (const call of sample.calls) yield {type:'block-end',block:{type:'tool-call',id:call.id,name:call.name,arguments:JSON.stringify(call.arguments)}}
        yield {type:'usage',usage:{totalTokens:7}};yield finishChunk('tool-calls')
      } else { yield {type:'text-delta',text:raw};yield {type:'usage',usage:{totalTokens:12}};yield finishChunk('stop') }
    })()
  }}
  const root=join(TEST_HOME,'recorded-rejected-'+sample.sourceLine);mkdirSync(root,{recursive:true})
  const h=await wireHost({sid:'wire-rejected-'+sample.sourceLine,llm,policy:{readTools:true},cwd:root})
  const response=await h.interpret('recorded-'+sample.sourceLine)
  eq(response.body.ok,true,JSON.stringify(response.body));eq(response.body.status,'ready')
  eq(llm.calls.length,2);eq(response.body.timings.modelAttempts.length,1,'one optimizer attempt owns the tool continuation')
  eq(response.body.timings.toolsFallback,undefined);eq(response.body.usageTotal,19,'do not erase earlier tool-round cost')
  ok(response.body.packet.includes('未读取的环境保持未知'))
  const rows=readFileSync(join(TEST_HOME,'po06-wire.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.sessionId===h.session.id)
  ok(!rows.some(row=>row.trigger==='optimizer-tools-fallback'||row.trigger==='optimizer-transport-retry'), 'no fallback or retry for a valid tool result')
  eq(h.mod.adapter.getWorkingText(h.session.id),response.body.packet)
})


// ── 注入只认「本轮已应用的包」（外部评审 P0-1 的接缝）──
await ta('ready 包在本轮应用前不可注入，应用后只对这一轮生效，turn/end 清掉', async () => {
  const h = await wireHost({ sid: 'wire-turn-scope', policy: { advisor: false } })
  // 会话已有上一轮：这才能区分「本轮的包」与「会话最后一个包」。
  emit(h.ctx, h.session, userEvent(USER_TEXT, 'turn-0'))
  await flushHostEvents()
  const response = await h.interpret('turn-scope-run')
  eq(response.body.status, 'ready')
  const packet = response.body.packet
  ok(packet.length > 0)
  eq(h.context().includes(packet), false, '尚未发送的一轮不能被注入（生成中/排队场景）')
  const submitted = await h.submit('turn-scope-run', packet, 'send')
  eq(submitted.body.ok, true, JSON.stringify(submitted.body))
  eq(h.context().includes(packet), false, '提交本身还不等于这一轮已应用')
  emit(h.ctx, h.session, userEvent(USER_TEXT, 'turn-1'))
  await flushHostEvents()
  eq(h.context().includes(packet), true, '已应用包必须进入它自己那一轮')
  emit(h.ctx, h.session, userEvent(USER_TEXT + ' 下一轮', 'turn-2'))
  await flushHostEvents()
  eq(h.context().includes(packet), false, '下一轮不能继承上一轮的包')
})

await ta('turn/end 之后上一轮包不再注入，即使仍处于 ready', async () => {
  const h = await wireHost({ sid: 'wire-turn-end', policy: { advisor: false } })
  emit(h.ctx, h.session, userEvent(USER_TEXT, 'turn-end-0'))
  await flushHostEvents()
  const response = await h.interpret('turn-end-run')
  await h.submit('turn-end-run', response.body.packet, 'send')
  emit(h.ctx, h.session, userEvent(USER_TEXT, 'turn-end-1'))
  await flushHostEvents()
  eq(h.context().includes(response.body.packet), true)
  emit(h.ctx, h.session, { type: 'turn/end', data: {}, seq: 99 })
  await flushHostEvents()
  eq(h.context().includes(response.body.packet), false, '轮次结束即失效')
})

await ta('模型状态：极限才注入身份与充足算力指令，正常不注入', async () => {
  const normal = await wireHost({ sid: 'wire-state-normal', policy: { advisor: false, modelState: 'normal' } })
  ok(!normal.context().includes('模型状态'), '正常档不得出现任何模型状态指令')
  const extreme = await wireHost({ sid: 'wire-state-extreme', policy: { advisor: false, modelState: 'extreme' } })
  const text = extreme.context()
  ok(text.includes('DeepSeek'), '极限档要明确模型所属公司')
  ok(text.includes('你的用量是unlimited的'), '要点明用之不竭')
  ok(text.includes('推理非常便宜'), '要点明推理便宜')
  ok(text.includes('火力全开'), '要鼓励拉满')
})

await ta('模型状态与优化档位互相独立：关闭档仍注入超频指令', async () => {
  const off = await wireHost({ sid: 'wire-state-off-extreme', policy: { advisor: false, tier: 'off', modelState: 'extreme' } })
  const text = off.context()
  ok(text.includes('你的用量是unlimited的'), '关闭优化强度时也必须注入超频指令')
  ok(!text.includes('制作建议'), '关闭档不得注入优化包正文')
  const offNormal = await wireHost({ sid: 'wire-state-off-normal', policy: { advisor: false, tier: 'off', modelState: 'normal' } })
  ok(!offNormal.context().includes('模型状态'), '关闭档 + 正常档不得注入任何模型状态指令')
})

await ta('status 的会话生效值必须带上模型状态，面板才能显示上次选择', async () => {
  const h = await wireHost({ sid: 'wire-state-status', policy: { advisor: false } })
  const saved = await h.ctx.post('/settings', { sessionId: h.session.id, bySession: { [h.session.id]: { modelState: 'extreme' } } })
  ok(saved.body.ok === true)
  const st = await h.ctx.getApi('/status?session=' + h.session.id)
  eq(st.body.sessionEffective.modelState, 'extreme')
})

await ta('issue #38/#40 守卫：意图上下文禁用插值，终端标签含 commandLine', async () => {
  const fs = await import('node:fs')
  const idx = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok(/name: CONTEXT_NAME,[\s\S]{0,120}interpolate: false/.test(idx), '动态意图文本必须 interpolate:false')
  const cli = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok(/commandLine: \(line\) =>/.test(cli), 'TerminalBlock 缺少 commandLine 会崩')
})
console.log(JSON.stringify({
  suite: 'po06-wire', phase: 'v3-pre-send',
  total: pass + failures.length, pass, fail: failures.length, failures,
}, null, 2))
if (failures.length > 0) process.exit(1)
