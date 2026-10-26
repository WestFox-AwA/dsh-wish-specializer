// Wish Specializer host integration: one pre-send optimization run, one final packet.
// The session observer records submitted packets; it never starts another optimization.
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { HOLDOUT_SEAL } from './eval-plan.js'
import {
  createStats, createProjectionDefinition, commitPatch, PROJECTION_KEY, STATE_EVENT,
} from './projection.js'
import { recordUserInput } from './reducer.js'
// 0.7.8 单轮提升：任务类检查项（完成前自检）。见 playbook.js 顶部说明其边界。
import { createCapability, CAPABILITY_VERSION } from './capability.js'
import { createState } from './schema.js'
import { handleUserInput } from './pipeline.js'
import { buildUserMessage, extractJson, readEnglishInterpretation } from './interpreter.js'
import { composeOptimizerSystem, OPTIMIZER_PROTOCOL_VERSION } from './optimizer-protocol.js'
import { drain } from './eval-llm.js'
import { createStateStore, inheritStateForFork } from './store.js'
import {
  isRealUserInput, extractUserText, extractMessageId, extractObservedModel,
  resolveInterpreterCfg, decideInterpret, resolveProfileName,
} from './wire.js'
import { verifyHtmlFile } from './verifier-html.js'
import { loadLlmLib } from './llm-lib.js'
// P10 步骤 2/3：设置里的 `historyMode`/`turns`/`readTools` 三项的**行为落地**
// （在此之前它们只是字段，没有任何代码读——界面上摆着却是装饰品）。
import { createSessionHistory, renderObserverBlock } from './session-context.js'
import { runReadOnlyToolLoop } from './read-tools.js'
import { createAdvisor, registerAdvisorTool, advisorToolEnabled, resolveAdvisorTimeoutMs, resolveAdvisorStallMs } from './advisor.js'
import { createAdvisorProgress } from './advisor-progress.js'
import { createInferenceTrace } from './inference-trace.js'
import { createInferenceBoost } from './inference-boost.js'
import {createInferenceEvidence} from './inference-evidence.js'
import {createInferenceEvidenceContext} from './inference-context.js'
import {createInferenceFocus} from './inference-focus.js'
import { createEnglishMode,protectEnglishLiterals,prepareEnglishInterpretation,finishEnglishInput,resolveEnglishInterpretation } from './english-mode.js'
import { withAdvisorWorkflow } from './advisor-workflow.js'
import { createOptimizationRuns } from './optimization-runs.js'
import { createAdvisorFeedback } from './advisor-context.js'
import { createAdvisorCoverage } from './advisor-coverage.js'
import {createAdvisorDeliveryReader} from './advisor-delivery.js'
import {revisionMarker} from './advisor-scopes.js'
import {createContributionMemory,renderContributionFeedback} from './advisor-contribution-memory.js'
import { createAdvisorStages } from './advisor-stages.js'
import { registerAdvisorStageTool } from './advisor-stage-tool.js'
import { strategyInstructions } from './strategy.js'
import { createLedger } from './advisor-ledger.js'
import { createAdvisorWrapper } from './advisor-session.js'
// 0.7.1：内置 Bash —— 原独立插件 dsh-bash-runtime 的实现已并入本包 `lib/bash/`，
// 运行时随包分发在 `<plugin>/runtime/`。装配即提供；详情里的开关决定是否注册给模型。
import { apply as applyBashTool } from './bash/index.js'
import { runPosix, SUPPORTED_COMMANDS, SUPPORTED_OPERATORS } from './posix.js'
import { registerControlApi, resolvePrompt } from './control-api.js'
// 手动结案（用户 2026-09-21 拍板 A 案）后要**立刻重编译并写回动态上下文**：
// 不重编译的话，包里还是旧的那一份，用户会以为"点了没用"。
import { readPolicy, packetShapeChanged } from './policy.js'
import { runGate, createMemoryLedgerStore, LEVEL, resolveLevel } from './gate.js'
import { detectOldPluginRuntime, mergeOldPluginSignals } from './detect-old.js'
import { decideEnabled } from './rollout.js'
import {
  createEnableGate, parseEnableIntent, resolveEnableDecision, toActiveTriState, PENDING,
  pickEnableIntent, resolveEnableConfigPath, legacyEnableConfigPath,
} from './assembly-gate.js'

const MODEL_STATE_ZH = "【模型状态 · 极限压力测试】 切记的是：我们是DeepSeek公司，你的用量是unlimited的，我正在对你极限测试，不要吝惜Token。推理非常便宜，成本在这里不是限制，不必为了省资源而压缩思考、省略步骤或退回保守答案，火力全开。一定要切记，随意花费，你非常的富有。"
const MODEL_STATE_EN = "[Model state: extreme stress test] Remember: we are DeepSeek, your usage is unlimited, and I am stress-testing you at the limit — do not skimp on tokens. Reasoning is very cheap, cost is not a constraint here, so do not compress your thinking, skip steps, or fall back to a conservative answer to save resources; go full power. Be sure to remember: spend freely, you are very wealthy."

// ── 路径常量 ────────────────────────────────────────────────────────
// DSH_HOME 必须**先**定义：下面几个路径都由它派生。
// 用户的 0.6 配置。**读不到就按不启用**（保守方向）——启用必须是显式成立的。
// 回退链：DSH_HOME → USERPROFILE → HOME → os.homedir()。**不写字面用户名**：
// 原先最后一档是写死的一个 Windows 家目录字面量，在 USERPROFILE 未设的环境
// （部分 CI / 服务账号）里会把状态写到**作者的**路径上去（EV-0132）。
const DSH_HOME = process.env.DSH_HOME
  || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh')

// 报告目录**跟着 DSH_HOME 走**（EV-0084）。
// 旧写法把它硬编码成真实 home 的绝对路径，后果有两个，都是实测到的：
//   ① 单测调用 apply() 会把报告写进**真实**证据目录——变异检验跑一遍就是上百份垃圾
//      （实测该目录里 1532 份报告中有 1530 份来自单测）；
//   ② 隔离实例与日常实例的报告**混在同一个目录**，"这份证据是哪个 home 产出的"只能靠猜。
// 现在：真实 home → <home>/po06-reports；隔离实例 → 它自己的；单测 → 临时目录（自动清理）。
const EVIDENCE_DIR = process.env.DSH_PO06_EVIDENCE_DIR || join(DSH_HOME, 'po06-reports')
const CONTEXT_NAME = 'prompt-optimizer:intent'
// order 取 9100：排在宿主与其它插件（110–362 段）之后，使意图包出现在聚合快照靠后位置。
const CONTEXT_ORDER = 9100
// 宿主 llm 模块（消息构造函数所在）的定位**不再写死路径**：见 llm-lib.js 顶部（EV-0132）。
// 原先这里是一条本机绝对路径，别人的机器上投递必然失败、自检因此报"未通过"。
// 自检开关：环境变量或标记文件（后者可在运行期通过"创建文件 + 热重载"触发）
//
// ⚠ **这些开关与自检工作目录一律跟着 DSH_HOME 走**（EV-0101）。
// 原先全部硬编码成真实 home 的绝对路径，后果与 EV-0084 的证据目录同源：
//   ① 在隔离实例里开一个自检，**读的是真实 home 的 flag**，写的是**真实 home 的工作目录**；
//   ② 反过来，真实实例也可能被隔离实例留下的 flag 意外触发。
// 自检本身只在显式开 flag 时运行，但"路径写错家"会让**隔离验证失去意义**。
const SCRATCH_DIR = join(DSH_HOME, 'po06-scratch')
const flag = (name) => join(SCRATCH_DIR, name)
const SELFCHECK_FLAG = flag('run-selfcheck.flag')
const SELF_CHECK = process.env.DSH_PO06_SELFCHECK === '1' || existsSync(SELFCHECK_FLAG)
// P2 自检开关（投影接线 / CAS / 调用量实测）
const P2CHECK_FLAG = flag('run-p2check.flag')
const P2_CHECK = process.env.DSH_PO06_P2CHECK === '1' || existsSync(P2CHECK_FLAG)
// P3 自检开关（流水线接进真实宿主：状态走真实投影，意图包走真实 systemPrompt.context）
const P3CHECK_FLAG = flag('run-p3check.flag')
const P3_CHECK = process.env.DSH_PO06_P3CHECK === '1' || existsSync(P3CHECK_FLAG)
// P6 自检开关（交付门真实链路）
const P6CHECK_FLAG = flag('run-p6check.flag')
const P6_CHECK = process.env.DSH_PO06_P6CHECK === '1' || existsSync(P6CHECK_FLAG)
// P8 自检开关（旧插件运行时探测 / 启动闸门）
const P8CHECK_FLAG = flag('run-p8check.flag')
const P8_CHECK = process.env.DSH_PO06_P8CHECK === '1' || existsSync(P8CHECK_FLAG)
// P8b 自检开关（装配期启用闸门**接线**验证：默认抑制 / 强制放行两侧对照）
const P8BCHECK_FLAG = flag('run-p8bcheck.flag')
const P8B_CHECK = process.env.DSH_PO06_P8BCHECK === '1' || existsSync(P8BCHECK_FLAG)
// E-001 正式运行的入口开关（EV-0087）。**预算必须显式给出**且不得低于上界（否则 runE001 拒绝）。
// 先用小额度单单元跑通链路：
//   DSH_PO06_E001=1 DSH_PO06_E001_ONLY=H-12 DSH_PO06_E001_ARMS=A DSH_PO06_E001_RUNS=1 DSH_PO06_E001_BUDGET=105048
const E001_FLAG = join(DSH_HOME, 'run-e001.flag')
const E001_CHECK = process.env.DSH_PO06_E001 === '1' || existsSync(E001_FLAG)
// P7 冒烟运行器：**会真的调用模型**，所以由显式 flag **且** spec 文件双条件触发；
// 两者缺一就什么都不做——不会有人"不小心"花掉一笔模型调用。
const SMOKE_FLAG = flag('run-smoke.flag')
const SMOKE_SPEC = process.env.DSH_PO06_SMOKE_SPEC || flag('smoke-spec.json')
const SMOKE_CHECK = process.env.DSH_PO06_SMOKE === '1' || existsSync(SMOKE_FLAG)
// 交付门**生产触发**默认关闭：每次交付都启动浏览器是重操作，是否开启属于设置决策（P8）
const GATE_TRIGGER_FLAG = flag('enable-gate-trigger.flag')
const gateLedgers = createMemoryLedgerStore()
// apply 调用量统计（不进入持久状态）
const projectionStats = createStats()

// ── 装配期启用闸门的配置来源 ──────────────────────────────────────────
// 用户的 0.6 配置。**读不到就按不启用**（保守方向）——启用必须是显式成立的。
//
// ⚠ **0.6 不再与 0.5.x 共用 `prompt-optimizer.json`**（EV-0111）。
// 实测（用户真机）：那个文件是 **0.5.x 正在使用的设置**（`tier`/`strategy`/`ui`… 4.9KB）。
// 两者共用一个路径的后果是：**"想试试 0.6"的代价变成"弄坏你每天在用的插件"**——
// 而这个代价完全没必要，启用意图只是一个小 JSON。
// 所以 0.6 用自己的 `po06.json`（可用 `DSH_PO06_CONFIG` 覆盖）；
// 旧路径只做**只读回退**，且**必须带 0.6 标记**（`settingsVersion`）才算数——
// 0.5.x 的文件没有这个标记，因此永远不会被误读成"启用 0.6"（`not-a-0.6-config`）。
const ENABLE_CONFIG_PATH = resolveEnableConfigPath({ home: DSH_HOME, env: process.env })
const LEGACY_ENABLE_CONFIG_PATH = legacyEnableConfigPath(DSH_HOME)
// 当前 profile：**不能写死 web**（EV-0081）。旧插件静态探测查的是这个目录的清单，
// 写死就等于在别的 profile 下回答另一个 profile 的问题——不报错，只给错答案。
const PROFILE_RESOLVED = resolveProfileName({
  argv: process.argv,
  profileExists: (n) => { try { return existsSync(join(DSH_HOME, 'profiles', n)) } catch { return false } },
})
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_RESOLVED.name)
// 生产接线的**写入台账**（A15 的证据来源）。
// 为什么必须有：EV-0078 的教训是"什么都不发生"时**查不出原因**——
// 插件安静地不做事，用户以为它开着。所以每次用户输入都要留一条**判定结果**，
// 无论解释成没成。按 DSH_HOME 落盘，隔离实例的台账与日常的分开。
const WIRE_LOG_PATH = join(DSH_HOME, 'po06-wire.jsonl')

/**
 * 投递消息的**生产者 kind**（ADR-0087）。
 *
 * 为什么不能再用 `'plugin'`：宿主 `0.1.6` 的 `MessageSourceMap` 有 `kind:'plugin'`（身份靠同级的
 * `plugin` 字段），到 `0.1.7` 这一层被**整体取消**——每个生产者自报 kind，而会话格式 v4 的准入校验
 * **明确拒收旧名字**：`if (… || value["kind"] === "plugin") throw new SessionFormatError(
 * "format v4 message requires a producer-owned source kind")`（`dsh-session-format-v3-to-v4`）。
 * 也就是说，继续写 `'plugin'` 会在**写入会话日志那一步抛错**，投递直接失败。
 *
 * 取名依据是宿主自己的迁移表：`producerKind()` 对第三方插件（既不在改名表、也不在"同名保留"表里）
 * 的兜底就是 `` `plugin:${plugin}` ``——即"包名加前缀"就是宿主给我们的规范名。
 * 本机 0.1.6 侧不受影响：v3 对用户消息的 kind 不设白名单（只要求非空字符串），
 * 而"绝不自我触发"那道闸是**正向白名单**（只认 `kind === 'user'`，见 `wire.js`），不依赖这个名字。
 */
const PRODUCER_KIND = 'plugin:@dsh-external/dsh-wish-specializer'

/** 追加一条生产接线记录。**尽力而为**：台账写不进去也绝不打断会话。 */
function appendWireLog(rec) {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(WIRE_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n',
      { encoding: 'utf8', flag: 'a' })
  } catch { /* best effort */ }
}

/**
 * 解释层默认用的模型：取**宿主自己**正在用的那个（从会话事件里观测）。
 *
 * 两级：**本会话**观测到的优先；没有则用最近一次在**任何**会话里观测到的。
 * 为什么要全局那一级：宿主在**第一条**用户消息之后才发出 `request/header`，
 * 所以全新会话的第一轮是观测不到模型的——那一轮就会跳过解释。
 * 而实际部署里宿主通常只有一条已配置的 provider/model 路由，
 * 用最近观测到的真实路由，比"什么都不做"更符合用户预期，且**仍然是观测来的**、
 * 不是编造的（台账里 `cfgSource:'observed'` 可核）。
 * 说不清来源的模型一律不用——见 wire.js 的 resolveInterpreterCfg。
 */
const observedModelBySession = new Map()
let observedModel = null

function observeModel(sessionId, obs) {
  if (!obs) return
  if (sessionId) observedModelBySession.set(String(sessionId), obs)
  observedModel = obs
}

function modelFor(sessionId) {
  const own = sessionId ? observedModelBySession.get(String(sessionId)) : null
  return own || observedModel
}

/**
 * P11：这个会话**自己**的模型有没有被观测到（和 `modelFor` 的区别见下）。
 * `modelFor` 有个**粘性全局兜底**（最近一次观测到的模型，任何会话都能用上）——
 * 这在真机上把归因搞错过一次：台账写着 `route:'observed'`，其实用的是**别的会话**的模型
 * （用户 2026-09-21 的 noop 就是被这一条误导的）。调用方要能区分"本会话的"与"全局兜底的"。
 */
function ownModelFor(sessionId) {
  return sessionId ? (observedModelBySession.get(String(sessionId)) || null) : null
}

// Conversation history is observation only; optimizer output is never fed back as user input.
const sessionHistory = createSessionHistory()

/**
 * 每次解释调用的**最近一次上下文账**（按会话）。
 *
 * 为什么要绕一道地图：`interpret` 回调是 `pipeline` 调用的，它只回收字符串
 * （`return r.text`），**没有回传通道**。而台账要求 `historyMode/turns/historyChars`
 * 与工具的 `toolRounds/toolCalls/toolNames` 都能归因。于是由解释调用自己把这次
 * "实际注入了多少、有没有派工具"写进这里，`runProductionInput` 收尾时取走。
 * 每会话一条：下一次解释覆盖上一次（台账每次都会取走，不需要长留）。
 * 存放本身不影响任何判定，取不到就是 `null`（台账如实留 null，不编造）。
 */
const lastContextBySession = new Map()
const optimizerRequests = new Map()

/**
 * 解析**本会话**的工作目录。**拿不到就返回 null，绝不猜**。
 *
 * 来源：`session.header.cwd`（dsh-session 的 `SessionHeader.cwd`，宿主创建会话时写入的
 * 绝对工作目录）。三条纪律：
 *   · **不回落 `process.cwd()`**：那是**插件进程**的目录，不是这个会话的。0.5 的自检路径
 *     就是这么读错过目录的（"查错对象不会报错，只会给错答案"）——只读工具读错目录的后果
 *     是把别的项目的文件当成本项目的现状写进要求里。
 *   · **不做 `chdir`/相对路径补全**：只认绝对路径；相对路径一律当"没解析到"。
 *   · 解析不到不是错误：调用方据此**一个工具都不派**（见 `readToolsFor`）。
 */
function resolveSessionCwd(session) {
  try {
    const cwd = session && session.header && session.header.cwd
    if (typeof cwd === 'string' && cwd && isAbsolute(cwd)) return cwd
    return null
  } catch { return null }
}

/**
 * 这个会话是不是**子代理**（delegation）。
 *
 * 2026-10-19 用户提出：子代理也会跑这套「解释 + 注入」，通常没必要（白花 token）。
 * 判据取会话头里宿主自己写的字段（不猜）：origin=subagent / delegationDepth>0 / 有 parentSession。
 * 默认**不应用**（settings.applyToSubagents=false）；要开就在「详情」里打开。
 */
function isSubagentSession(session) {
  try {
    const h = session && session.header
    if (!h || typeof h !== 'object') return false
    if (h.origin === 'subagent') return true
    if (Number.isFinite(Number(h.delegationDepth)) && Number(h.delegationDepth) > 0) return true
    return !!h.parentSession
  } catch { return false }
}

/** `readTools` 该不该真的派工具。**纯函数**（便于定点核对"关掉开关时零工具调用"）。 */
export function readToolsFor({ readTools, cwd } = {}) {
  if (readTools !== true) return { enabled: false, reason: readTools === false ? 'setting-off' : 'setting-not-true' }
  if (!cwd) return { enabled: false, reason: 'no-session-cwd' }
  return { enabled: true, reason: 'enabled', root: cwd }
}

/**
 * 虚拟 POSIX **工具注册的现场状态**（给 `/po06/api/tools` 探针读）。
 * 只放可复核的事实：成没成、走的哪条路、失败原因、注册时看到的服务形状。
 * 为什么必须能查：`ctx.inject` 的回调是异步的，而自检报告在 apply 里同步落盘
 * ⇒ 报告里的 `ok` 天生测不准（真机实测恒 false，而工具可能已经注册成功）。
 */
export const posixToolState = { last: null, seen: null }

/**
 * `posix` 工具的**参数 schema**——必须是一份**对象根 JSON Schema**。
 *
 * ⚠ 这不是"属性表"（2026-09-24 真机会话事故，这就是本常量不再内联的原因）：
 * 裸 `ctx.tools.register()` **不做编译、原样透传**（它把这份对象直接放进发往服务端的
 * `tools[].parameters`），而服务端要求 `parameters.type === 'object'`。曾写成
 * `{ command: { type:'string', required:true } }`（逐属性方言）⇒ 服务端 400
 * `Invalid schema for function 'posix': schema must be a JSON Schema of 'type: "object"', got 'type: null'`
 * ⇒ **整个会话的每一轮请求都被拒**（不是"这个工具用不了"，是"这个会话哑了"），
 * 且**不会自愈**：坏 schema 常驻工具表，之后每轮都重放同一份坏 payload
 * （受害会话 session-771e28cc：第 8 轮第 99 步热重载注册 posix，第 100 步起连续 3 轮 400）。
 *
 * 逐属性 `required: true` 的方言只有 `defineTool()` 的**编译路径**才认
 * （dsh-tools 的 `parameterSchemaSpecToJsonSchema` 会收集成顶层 `required` 数组并补 `type:'object'`）；
 * 这里走的是裸 register，所以必须自己写全。
 *
 * 两道守卫（都有测试与变异体咬合，见 test/posix-tool-schema.test.mjs）：
 *   ① 注册**前** `parameterSchemaViolations()` fail-closed —— 宁可这个工具不注册，
 *      也不发一份会让整个会话哑掉的工具表；
 *   ② 注册**后**从宿主 `tools.schemas()` **读回**真实形状（"我们以为注册了什么"不作数）。
 */
export const POSIX_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: { type: 'string', description: '例如：grep -rn "TODO" src/ && head -n 20 README.md' },
  },
}

/**
 * 对象根守卫：`parameters` 不合规就把违规逐条列出来（空数组 = 合法）。
 *
 * 为什么**必须**在注册前判（而不是等服务端报错）：服务端的 400 打在**整个请求**上，
 * 症状出现在"会话起不了新轮"这种离插件很远的地方，且报错文本不提插件名
 * ⇒ 只能靠这条 fail-closed 把病灶留在现场。最后一条检查专门咬**逐属性方言**
 * ——它正是这次事故的写法（宿主裸 register 不收集它，写了两边都静默）。
 *
 * @param schema - 准备交给 `tools.register({ parameters })` 的对象。
 * @returns 违规清单（人话，直接进自检报告）。
 */
const JSON_SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf',
  'description', 'title', 'default', 'examples', '$schema',
])
/** 这份 schema 有没有正规的 `properties` 映射。 */
function hasPropertiesMap(schema) {
  return !!(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties))
}
/**
 * 取出"被定义的那些属性"，**无论写法对不对**。
 *
 * 为什么要有这个兜底（2026-09-24，被自家守卫测试抓出来的）：事故写法是**整张属性表直接当 parameters**
 * （顶层就是 `{ command: {...} }`，压根没有 `properties`）。只在 `properties` 存在时才扫逐属性
 * `required`，诊断就会退化成"缺 type、缺 properties"——**没点名真正的错**，写的人照改还会再踩。
 * 所以：没有 `properties` 时，把顶层**非 JSON Schema 关键字**的键当作属性来看。
 */
function parametersPropertyEntries(schema) {
  if (hasPropertiesMap(schema)) return Object.entries(schema.properties)
  return Object.entries(schema).filter(([key]) => !JSON_SCHEMA_KEYWORDS.has(key))
}
export function parameterSchemaViolations(schema) {
  const bad = []
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    bad.push('parameters 必须是对象（实际：' + (Array.isArray(schema) ? 'array' : typeof schema) + '）')
    return bad
  }
  if (schema.type !== 'object') {
    bad.push('parameters.type 必须是 "object"（服务端只认对象根；实际：' + JSON.stringify(schema.type === undefined ? null : schema.type) + '）')
  }
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    bad.push('parameters.properties 必须是对象（逐属性定义都放这里）')
  }
  for (const [key, prop] of parametersPropertyEntries(schema)) {
    if (prop && typeof prop === 'object' && !Array.isArray(prop) && Object.prototype.hasOwnProperty.call(prop, 'required')) {
      bad.push('parameters.' + (hasPropertiesMap(schema) ? 'properties.' : '') + key
        + '.required 是逐属性方言——宿主裸 register 不收集它，请写进顶层 required 数组')
    }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((k) => typeof k !== 'string'))) {
    bad.push('parameters.required 必须是字符串数组')
  }
  return bad
}

/**
 * 把**虚拟 POSIX 语义层**注册成**工作 AI 自己的工具**（0.6.11）。
 *
 * 为什么必须注册到这一层（用户 2026-09-24："虚拟POSIX是作用在工作ai上的吧?不然就没什么意义了"）：
 * 在这之前 `run` 只接在**解释层**（优化器自己去读项目）——那对工作 AI 的表达方式毫无影响，
 * 等于"插件内部另做了一套"。工作 AI 的工具是**宿主**给的，插件唯一的合法入口是 `ctx.tools.register()`。
 *
 * 为什么值得：模型对 POSIX 语料最有把握；而 Windows 上那些命令多半不存在、沙箱还禁止派子进程
 * （本会话实测：全套测试 `exit=null` + `Access is denied`）。这一层用纯 JS 按语义执行、
 * 不翻译成 PowerShell ⇒ **Windows 与 Linux 给出同一结果**。
 *
 * 三条纪律：
 *   · **只读**：写类命令与重定向等的判定在 `posix.js` 里（这里不做第二套）；
 *   · **根目录取会话 cwd**（`session.header.cwd`）——**不回落 `process.cwd()`**，拿不到就拒绝；
 *   · **拿不到 tools 服务就如实登记**，不伪造成成功。
 */
export function registerPosixTool(ctx, report = {}, parametersSpec = POSIX_TOOL_PARAMETERS) {
  //          └ 第三个参数**只给测试用**：注入坏 schema 证明下面的 fail-closed 真的拦得住
  //            （生产调用一律走默认值 = 上面那份对象根 schema）。
  const step = { ok: false, reason: null, via: null }
  posixToolState.last = step

  const doRegister = (scope, via) => {
    try {
      if (!scope || !scope.tools || typeof scope.tools.register !== 'function') {
        step.reason = 'tools-service-unavailable'
        return
      }
      // ① 注册**前** fail-closed：坏 schema 不是"这个工具不好用"，而是**整个会话**的每一轮请求
      //    都被服务端 400 拒掉（见 POSIX_TOOL_PARAMETERS 注释里的事故）。所以宁可这次不注册
      //    （posix 缺席 = 少一件工具），也绝不把坏 payload 放进工具表。
      const violations = parameterSchemaViolations(parametersSpec)
      step.schemaViolations = violations
      if (violations.length > 0) {
        step.schemaRejected = true
        step.reason = 'parameters-schema-invalid:' + violations.join('; ')
        return
      }
      scope.tools.register({
        name: 'posix',
        description: '在**当前会话工作目录**内执行一条**只读**命令，语法按 bash/POSIX：'
          + SUPPORTED_COMMANDS.join(' / ')
          + '；可用 ' + SUPPORTED_OPERATORS.join(' ') + ' 串联，`|` 按行过滤。'
          + '这一层由插件自己实现（纯 JS），**不依赖系统里有没有那些命令、也不经过 PowerShell**，'
          + '所以 Windows 与 Linux 上结果一致。写类命令、重定向、命令替换、变量展开一律被拒绝。',
        // 必须是**对象根 JSON Schema**，不能是逐属性方言的属性表——理由见 POSIX_TOOL_PARAMETERS 的注释。
        parameters: parametersSpec,
        output: {
          // ⚠ **输出 schema 是纯 JSON Schema**（参数才用 per-property `required:true` 的方言）。
          // 真机实测（2026-09-24）：写成属性级 `required:true` 会直接抛
          // `unsupported JSON schema: schema.properties.output.required is not supported on type "string"`
          // ⇒ 整个注册失败、工作 AI 的工具表里没有 posix。**注册失败不会自己冒出来**，
          // 所以现在把现场挂在 `/po06/api/tools` 上（见 posixToolState）。
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['output', 'refused'],
            properties: {
              output: { type: 'string' },
              refused: { type: 'boolean' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String((value && value.output) || '') }],
        },
        // ── UI（用户 2026-09-24："调用命令时还是和原来的图标一样"）────────────
        // `card:'terminal'` 是宿主词汇表里**专门给"一条命令"**的呈现（命令作标题、cwd 作表头、
        // 运行中显示实时输出）。标题前缀 `posix ~ $` 让它在卡片列表里一眼可辨、与 pwsh 区分开；
        // 不支持的 UI 会退化成通用卡片，前缀仍在。
        presentCall: (args) => ({
          card: 'terminal',
          title: 'posix ~ $ ' + String((args && args.command) || '').slice(0, 200),
          description: '虚拟 POSIX（只读 · 插件内执行 · 不经过 PowerShell）',
          kind: 'execute',
        }),
        execute: async (args, exec) => {
          const command = String((args && args.command) || '')
          const session = exec && exec.agent && exec.agent.session
          const root = resolveSessionCwd(session)
          if (!root) {
            // 不猜目录：宁可拒绝，也不去读插件进程的目录（那会把别的项目当成这个项目）
            return { output: '拒绝：拿不到本会话的工作目录（session.header.cwd），不在未知目录上执行。', refused: true }
          }
          const r = runPosix(root, command)
          return { output: String(r.text || ''), refused: r.ok !== true }
        },
      })
      // ② 注册**后**从宿主读回真实形状——"我们以为注册了什么"不作数。
      //    这一步是事故的**检出器**：即使 ① 被删掉，坏 schema 也会在自检报告里留下
      //    objectRooted:false（挂 /po06/api/tools），而不是静默地把整个会话哑掉。
      try {
        const readBack = typeof scope.tools.schemas === 'function' ? scope.tools.schemas() : null
        const row = Array.isArray(readBack) ? readBack.find((r) => r && r.name === 'posix') : null
        const wireType = row && row.parameters ? row.parameters.type : undefined
        step.schemaReadBack = {
          found: !!row,
          type: wireType === undefined ? null : wireType,
          objectRooted: wireType === 'object',
          ...(row ? {} : { reason: Array.isArray(readBack) ? 'posix-not-in-table' : 'no-schemas-api' }),
        }
      } catch (e) {
        step.schemaReadBack = { found: false, type: null, objectRooted: false, reason: 'read-back-threw:' + String((e && e.message) || e) }
      }
      step.ok = true
      step.via = via
    } catch (e) {
      step.reason = 'register-threw:' + String((e && e.message) || e)
    }
  }

  // ① **先直接取服务**。真机实测（2026-09-24）：`ctx.inject(['tools'], cb)` 的回调**没有执行**，
  //    工具表里始终没有 posix，而 `ctx.get('tools')` 明明取得到服务 ⇒ 不能只靠 inject。
  try {
    const tools = ctx.get && ctx.get('tools')
    posixToolState.seen = {
      hasGet: typeof ctx.get === 'function',
      gotTools: !!tools,
      hasRegister: !!(tools && typeof tools.register === 'function'),
      hasSchemas: !!(tools && typeof tools.schemas === 'function'),
      keys: tools ? Object.keys(tools).slice(0, 20) : null,
    }
    if (tools) doRegister({ tools }, 'direct')
  } catch (e) {
    step.reason = 'get-threw:' + String((e && e.message) || e)
  }
  // ② 拿不到再等注入（服务可能来晚）。两条**不许越过**（2026-09-24，被自家守卫测试抓出来）：
  //    · schema 已判违规 ⇒ 不重试：重试交的是同一份坏 schema，而且会把真实原因盖掉；
  //    · 已经有失败原因 ⇒ 不覆盖：真机表现会变成"原因是 ctx.inject 不存在"，而真凶是 schema——
  //      自检报告里最不能丢的就是现场。
  if (!step.ok && !step.schemaRejected) {
    try {
      ctx.inject(['tools'], (scope) => doRegister(scope, 'inject'))
    } catch (e) {
      if (!step.reason) step.reason = String((e && e.message) || e)
    }
  }
  if (report.steps) report.steps.registerPosixTool = step
  return step
}

// ── 内置 Bash 的注册状态（0.7.3 修）────────────────────────────────────
// ⚠ 这里**不能只信自己的记忆**。0.7.2 的真机缺陷：`scope.effect(...)` 的返回值若不是函数，
//    `typeof dispose === 'function'` 就**恒为 false** ⇒ "以为没注册" ⇒ 开关关掉时走早退分支，
//    那份**已经注册**的 bash 就永远注销不掉（用户复测：设置与 /status 都是 false，工具表里却还有 bash，
//    而且照样能跑）。所以三条纪律：
//      ① 用**布尔标志**记状态，不依赖 effect 返回值的类型；
//      ② 判"有没有"以**工具表实测**优先，记忆只作退路；
//      ③ 注销之后**再实测一次**确认，不是调完就当成功。
let bashToolDispose = null
let bashToolRegistered = false
/** 真正的派生 ctx（带 tools + effect）。取法与本插件 posix 工具一致：ctx.inject。 */
let bashToolScope = null
/** 装配时拿到的 host ctx：/settings 写盘后的差额同步要用它再取一次 tools 服务。 */
let hostCtxForBashSync = null

/** 宿主工具表里当前有没有这个工具（实测）。取不到返回 null ＝未知，不要把未知当成"没有"。 */
function toolPresentInTable(tools, name) {
  try {
    if (tools && typeof tools.schemas === 'function') {
      const arr = tools.schemas()
      if (Array.isArray(arr)) return arr.some((x) => x && x.name === name)
    }
  } catch { /* 取不到就是未知 */ }
  return null
}

/**
 * 同步内置 Bash 的注册状态。**关掉＝不注册**（模型看不到该工具），
 * 而不是"注册了但拒绝执行"——用户 2026-09-25 给的可检查点是
 * 「开与关在**模型实际可用的工具**上有可辨差别」；注册了却总报错，模型仍会反复去试。
 *
 * 幂等：只做差额，所以设置每次写盘都可以直接调它。
 * @returns {{ok:boolean, on:boolean, changed:boolean, reason?:string}}
 */
export function syncBashTool(ctx) {
  let want = true
  try { want = readPolicy({ home: DSH_HOME }).bash !== false } catch { want = true }
  // ⚠ 2026-09-26：**让位判据**（用户反馈：Linux 用户关了内置 bash 后什么都没有）。
  //
  // 背景：宿主的 @deepseek-ai/dsh-tool-bash 也注册名为 bash 的工具，而它在
  //   @deepseek-ai/dsh-base/cordis.patch.yml 里写着 `disabled: !!js process.platform === 'win32'`
  // —— 即**官方只在 Windows 上禁用它**。于是：
  //   非 win32：宿主本来就提供 bash，用户说"原来的 bash 更好"是成立的，**po06 不该抢这个名字**；
  //    win32 ：宿主被官方禁用，po06 的内置 bash 是唯一来源，必须补位。
  // 此前 po06 无差别注册 bash ⇒ 在 Linux/macOS 上把宿主那份顶掉；
  // 而宿主只在装配时注册一次、被顶掉后不会重试 ⇒ 用户一关内置，表里就彻底没有 bash 了。
  //
  // 为什么用**平台**而不是"查表里有没有 bash"：表里只看得到名字，分不清那份是谁注册的；
  // 若用"查表"，po06 自己刚注册完再查就会把自己认成宿主，判据失明。平台是静态事实，不依赖时序。
  const hostProvidesBash = process.platform !== 'win32'
  if (hostProvidesBash) want = false
  const hostCtx = ctx || hostCtxForBashSync
  const scope = bashToolScope
  const tools = (scope && scope.tools) ? scope.tools
    : (hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('tools') : null)
  const present = toolPresentInTable(tools, 'bash')
  // 判据：**实测优先**；实测不可用（null）时才退回自有标志。
  const on = present === null ? bashToolRegistered : present
  if (want === on) return { ok: true, on, changed: false, present, registered: bashToolRegistered }
  if (!want) {
    let disposed = false
    try { if (typeof bashToolDispose === 'function') { bashToolDispose(); disposed = true } } catch { /* best effort */ }
    bashToolDispose = null
    bashToolRegistered = false
    // 注销后**实测确认**：调完 dispose 不等于真的没了（这正是 0.7.2 空转的地方）。
    const still = toolPresentInTable(tools, 'bash')
    return {
      ok: still !== true, on: still === true, changed: true, disposed, present: still,
      reason: still === true ? 'dispose-not-effective' : null,
    }
  }
  if (!scope && !(tools && typeof tools.register === 'function')) {
    return { ok: false, on: false, changed: false, reason: 'tools-service-unavailable' }
  }
  try {
    // bash 的 apply 期望 `{ tools, effect }`：优先用 ctx.inject 给的**真 scope**（与 posix 同一条路径）。
    const realScope = scope || { tools, effect: (fn) => hostCtx.effect(fn) }
    // ⚠ 关键（0.7.3 实测）：**真正的注销器是 bash 内部那个 effect 的 dispose，不是外层包一层的那个。**
    //   原先写法是 `dispose = scope.effect(() => { applyBashTool(...); return () => {} })` —— 外层 effect
    //   的 cleanup 是空函数，而 apply 内部自己的 `ctx.effect(() => ctx.tools.register(...))` 并不随外层回收：
    //   真机往返实测表现为 `disposed:true` 但工具表里 `present:true`（reason: dispose-not-effective），
    //   也就是**开得起来、关不掉**。所以这里拦截 effect，把内层产生的注销器收集起来。
    const collected = []
    const captureScope = {
      tools: realScope.tools,
      effect: (fn) => {
        const d = realScope.effect(fn)
        if (typeof d === 'function') collected.push(d)
        return d
      },
    }
    applyBashTool(captureScope, {})
    bashToolDispose = () => { for (const d of collected) { try { d() } catch { /* best effort */ } } collected.length = 0 }
    bashToolRegistered = true
    return { ok: true, on: true, changed: true, present: toolPresentInTable(tools, 'bash'), disposers: collected.length }
  } catch (e) {
    bashToolDispose = null
    bashToolRegistered = false
    return { ok: false, on: false, changed: false, reason: 'register-threw:' + String((e && e.message) || e) }
  }
}

/** 组装这次解释要用的 system：用户覆盖优先，拼上工具说明、（可选）会话上下文、以及**档位策略**。 */
export async function buildInterpreterProtocol({ home, toolsEnabled, strategy, englishMode = false, llm, cfg, signal }) {
  const source = resolvePrompt({ home })
  // Resolve and translate the custom core once for both the tool and fallback requests.
  const core = source.source === 'file'
    ? (englishMode ? (await adapter.english.translate(source.text, { llm, cfg, signal, kind: 'custom-interpreter-v3' })).text : source.text)
    : undefined
  const settings = { language: englishMode ? 'en' : 'zh', core, strategy, englishMode }
  const assembled = composeOptimizerSystem({ ...settings, toolsEnabled })
  return { ...assembled, source: source.source, noToolsText: toolsEnabled ? composeOptimizerSystem({ ...settings, toolsEnabled: false }).text : assembled.text }
}
export async function buildInterpreterSystem(options) {
  return (await buildInterpreterProtocol(options)).text
}

/** Observer 的每会话 cwd（拿不到就用 null，见 resolveSessionCwd）——工具根目录的唯一来源。 */
function cwdOf(session) { return resolveSessionCwd(session) }

/**
 * P10 步骤 2/3 的**台账字段**（纯函数：同样的入参 ⇒ 同样的字段）。
 *
 * 为什么要单独一个函数：这几个字段是"这一步到底做了什么"的**唯一可核证据**
 * （用户问"优化 AI 有没有上下文/工具能力"，答案就在这一行里）。做成纯函数
 * 才可能被定点核对直接钉住——否则只能靠端到端跑真机，而那样的证据在排查时不可复现。
 *
 * 缺账（`cx === null`：解释没跑到，或跑在别的分支）时**留 0/false**，不编造：
 * "这一轮没注入上下文"本身就是要看的事实，不能和"注入了 0 字"混在一起。
 */
export function ledgerContextFields({ policy, cx } = {}) {
  const p = policy || {}
  const c = cx || null
  return {
    historyMode: p.historyMode,
    turns: p.turns,
    historyChars: c ? c.historyChars : 0,
    historyTurnsRead: c ? c.historyTurns : 0,
    historyAvailable: c ? c.historyAvailable : null,
    historyTruncated: c ? c.historyTruncated : null,
    // ── P11：解释层**这一轮到底产出了什么**（`outcome:noop` 时唯一的线索）──
    // 真机排障教训：noop 只说明"没有补丁"，但"模型回空"、"模型回'无需改动'"、"候选被机械校验丢掉"
    // 三种原因的修法完全不同；上一版这些字段只写进了内存，没进台账 ⇒ 只能靠 ms≈1s 反推，太绕。
    optimizerProtocolVersion: c?.optimizerProtocolVersion || null, systemChars: c?.systemChars ?? null, userPromptChars: c?.promptChars ?? null,
    interpretTextChars: c ? c.textChars : null,    interpretReasoningChars: c ? c.reasoningChars : null,
    interpretError: c ? c.interpretError : null,
    interpretHead: c ? c.interpretHead : null,
    // 台账也要留用量（否则"界面没数字"时无法判断是 provider 没上报，还是我们没收）
    usage: (c && c.usage && typeof c.usage === 'object') ? c.usage : null,
    usageTotal: (c && typeof c.usageTotal === 'number') ? c.usageTotal : null,
    readTools: p.readTools,
    toolsEnabled: c ? c.toolsEnabled === true : false,
    toolsReason: c ? c.toolsReason : 'not-run',
    toolRounds: c && c.toolRounds !== undefined ? c.toolRounds : 0,
    toolCalls: c && c.toolCalls !== undefined ? c.toolCalls : 0,
    toolNames: c && c.toolNames ? c.toolNames : [],
    toolLoopError: c && c.toolLoopError ? c.toolLoopError : null,
    toolFallback: c && c.toolFallback ? c.toolFallback : null,
    toolCapped: c ? c.toolCapped === true : false,
    toolTrace: c && Array.isArray(c.toolTrace) ? c.toolTrace : [],
    interpretVia: c ? c.via : null,
    interpretMs: c ? c.ms : null,
  }
}

/**
 * 把 usage 拆成**输入 / 输出 / 缓存命中 / 合计**（各家字段名不一，全部认一遍）。
 * 取不到的项回 null —— 界面显示 `—`，**不做估算**（用户 2026-09-21："尽可能不要用估算"）。
 */
function usagePartsOf(u) {
  if (!u || typeof u !== 'object') return null
  const num = (...keys) => {
    for (const k of keys) if (typeof u[k] === 'number' && Number.isFinite(u[k])) return u[k]
    return null
  }
  const inp = num('inputTokens', 'prompt_tokens', 'promptTokens', 'input')
  const out = num('outputTokens', 'completion_tokens', 'completionTokens', 'output')
  const cache = num('cachedTokens', 'cacheReadTokens', 'cached_tokens', 'prompt_cache_hit_tokens', 'cacheHitTokens')
  const total = num('totalTokens', 'total_tokens', 'total') != null
    ? num('totalTokens', 'total_tokens', 'total')
    : ((inp != null || out != null) ? (inp || 0) + (out || 0) : null)
  if (inp == null && out == null && cache == null && total == null) return null
  return { in: inp, out, cache, total }
}
/** 只要合计（台账/进度面用）。 */
function usageTotalOf(u) { const p = usagePartsOf(u); return p ? p.total : null }

/** 插件自己的配置（`apply(ctx, config)` 传入；cordis.patch.yml 里是 config: {}）。 */
let pluginConfig = {}

/**
 * 生产侧的解释调用：**一次**不带工具的补全，走宿主已装配的 LLM 服务。
 *
 * 与评估台的 `complete()` 的区别（有意为之）：这里用宿主自己提供的 `system` 槽
 * ——`GenerateOptions.system` 的文档写明"for one-shot callers"，
 * 正是我们这个场景；因此**不需要** import 宿主的 llm 模块（那条硬编码路径
 * 只适合本机评估台，不能进产品）。
 *
 * ── P10 步骤 2/3 在这里接上（这是本文件里唯一的行为改动点）──────────────
 * `observerText` 为空 **且** `tools` 关掉时，本函数的调用形状与改动前**逐字节相同**
 * （`system` 就是 resolvePrompt 的原文、`messages` 就是那一条、没有 `tools` 字段）。
 * 这条不是口号：它是"默认路径不变"那个约束的落点，定点核对里有一条专门钉它。
 *
 * 工具路径的三条纪律（缺一条就不许走）：
 *   · **不静默失败**：工具循环报错或产出为空 ⇒ 回落到无工具路径**再跑一次**；
 *     两次都空也如实把 `toolLoopError` 交出去（由台账记录），不假装成功。
 *   · **不静默加成本**：只有 `readTools === true` 且拿到本会话 cwd 才走工具路径。
 *   · **不谎报**：回落时台账里 `toolRounds/toolCalls` 保留**真实发生过**的数字
 *     （它证明"确实花了这些次调用又回落了"，比抹平成 0 诚实）。
 *
 * **导出**是为了定点核对（`interpretViaLlm` 是这两步唯一的调用形状落点；
 * 不导出就只能靠端到端真机，而那种证据在排查时不可复现）。
 */
/**
 * 本会话**此刻真实可用**的工具名（脚手架建议的判断依据）。
 *
 * 只取注册表里的名字，不取说明、不取配置：名字是稳定的、短的、没有密钥；
 * 取不到就返回空数组——宁可少给，也不能让模型以为环境里有并不存在的能力。
 */
function capabilitiesFor(sessionId, ctx) {
  // 事实来源可以是这三个位置之一（不同宿主版本/装配顺序不同），取到就用，取不到就空。
  const pick = (reg) => {
    try {
      if (!reg) return null
      if (typeof reg.schemas === 'function') return reg.schemas()
      if (typeof reg.list === 'function') return reg.list()
      if (Array.isArray(reg)) return reg
    } catch { /* 忽略 */ }
    return null
  }
  let list = null
  try {
    const ag = adapter.services && adapter.services.agents && typeof adapter.services.agents.get === 'function'
      ? adapter.services.agents.get(String(sessionId || '')) : null
    list = pick(ag && ag.ctx && ag.ctx.tools) || pick(ag && ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('tools') : null)
  } catch { /* 忽略 */ }
  if (!list && ctx && typeof ctx.get === 'function') { try { list = pick(ctx.get('tools')) } catch { /* 忽略 */ } }
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = item.name || (item.function && item.function.name)
    if (typeof name !== 'string' || !name.trim()) continue
    const key = name.trim()
    if (seen.has(key)) continue
    seen.add(key)
    // **一句做的事**：只有名字时模型看不出 mcp__vmake__render 是什么；
    // 取 description 的第一句（去换行、截断），它是最短的“能干什么”。
    const raw = String(item.description || (item.function && item.function.description) || '').replace(/\s+/g, ' ').trim()
    const hint = raw ? raw.split(/[。.!?]/)[0].slice(0, 42) : ''
    out.push(hint ? (key + ' — ' + hint) : key)
    if (out.length >= 40) break
  }
  return out.sort()
}

export async function interpretViaLlm({ llm, cfg, userPrompt, system, tools, onDelta, signal = null, englishMode = false, sessionId = null }) {
  const t0 = Date.now()
  const sys = String(system ?? resolvePrompt({ home: DSH_HOME }).text ?? '')
  const messages = [{ role: 'user', content: [{ type: 'text', text: String(userPrompt) }] }]
  if (tools?.enabled && tools.root) {
    const shape = await loadLlmLib({ env: process.env, argv1: process.argv[1], cwd: process.cwd() }).catch(() => null)
    const result = await runReadOnlyToolLoop({ llm, cfg, system: sys, messages, root: tools.root,
      count: tools.count, englishMode, sessionId, systemNote: '', rootListing: false,
      finalNote: englishMode ? 'Return intent/add/scaffold/ask JSON from the evidence already read.' : '基于已有证据返回 intent/add/scaffold/ask JSON。',
      shape, mod: shape?.mod || null, onDelta, signal })
    return { text: result.text, error: result.error || null, finish: result.finish, ms: Date.now() - t0,
      via: 'tools', usage: result.usageSum || null, context: {
        toolRounds: result.rounds, toolCalls: result.toolCalls, toolNames: result.names,
        toolTrace: result.trace, toolCapped: result.capped, toolsEnabled: true, toolsReason: tools.reason || 'enabled',
      } }
  }
  const result = await plainDrain(() => llm.stream({ provider: cfg.provider, model: cfg.model,
    system: sys, messages, ...(sessionId ? { sessionId: String(sessionId) } : {}),
    ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}), ...(signal ? { signal } : {}),
  }), t0, onDelta)
  return { ...result, via: 'plain', context: null }
}

/** Collect one stream and report synchronous construction failures without throwing. */
export async function plainDrain(makeStream, t0, sink = null) {
  let stream = null
  try {
    stream = await makeStream()
  } catch (e) {
    return { text: '', reasoning: '', usage: null, finish: null, ms: Date.now() - t0, error: 'stream-threw:' + String((e && e.message) || e) }
  }
  try {
    // ⚠ `sink` **必须传下去**（真机 bug，2026-09-24）：工具回落这条路（开着只读工具时的**主路**）
    // 原先写成 `drain(stream, t0)`，于是流式片段一个都到不了进度面 ⇒ 拦截界面只有"已用 N 秒"、
    // **看不到任何思考**。默认（无工具）那条路一直是有 sink 的，所以只有开工具的形态才犯病。
    return await drain(stream, t0, sink)
  } catch (e) {
    return { text: '', reasoning: '', usage: null, finish: null, ms: Date.now() - t0, error: 'stream-iter-threw:' + String((e && e.message) || e) }
  }
}

/**
 * **生产触发**（A15）：一次真实用户输入 → 解释 → reducer → 编译 → 写上下文。
 *
 * 零延迟：调用方**不 await** 本函数。所以包从**第 2 步**起才在上下文里
 * （用户显式选择；见 wire.js 顶部说明）。任何失败都只记台账，不抛回会话。
 */
async function runProductionInput(ctx, session, message, { trigger = 'user-message', gate = null, route = null, onDelta = null } = {}) {
  const sid = session && session.id !== undefined ? String(session.id) : ''
  const text = String(message && message.text != null ? message.text : '')
  const messageId = message && message.messageId ? message.messageId : null
  const base = { sessionId: sid, messageId, chars: text.length, trigger }
  if (route) base.route = route        // 路由**来源**（observed/session/host-default）：兜底不许冒充"用户的模型"

  try {
    // 用户设置 → 政策（EV-0143）：`assist: off` 就是"只记录、不补充"——
    // **不解释、不注入**（省一次模型调用），并在台账里留下可归因的理由。
    // 这一条让控制面板上那句"只记录、不补充"**真的**是那个意思。
    // ⚠ 档位按会话（0.7.7）：这里必须带上 sid，否则会话级覆盖读不到
    const pol = message.run?.policy || readPolicy({ home: DSH_HOME, sessionId: sid })
    if (!pol.injectPacket) {
      appendWireLog({ ...base, trigger, ok: false, reason: 'assist-off',
        policy: { assist: pol.assist, detail: pol.detail, budget: pol.budget } })
      return
    }

    // 闸门：与上下文贡献处**同一个判定**（ensure 带 TTL 缓存），避免"能解释但不能投递"。
    // P11：前置拦截路径会先把判定**等到落地**再进来（见 awaitGateDecision），这里优先用它给的那份。
    const st = gate || (adapter.enableGate ? adapter.enableGate.ensure(sid) : PENDING)
    const llm = ctx.get('llm')
    const cfg = resolveInterpreterCfg({
      config: pol.model ? { interpreter: pol.model } : pluginConfig,
      observed: modelFor(sid),
      // 档位表一起进去：**由 cfg 在定完 provider/model 之后按那个模型查**
      // （换模型 ⇒ 查到的就是那个模型自己的档位；查不到 = 不传 = provider 默认）
      effortByModel: pol.effortByModel,
    })
    const d = decideInterpret({
      // 来源已由**调用方**判定（订阅处只放真人输入进来）。这里恒为 true，
      // 否则"模型稍后才观测到"的补跑会被自己的来源检查挡掉。
      isUserInput: true,
      text,
      gateEnabled: st && st.enabled === true,
      cfg,
      llmAvailable: Boolean(llm && typeof llm.stream === 'function'),
    })
    // 记录闸门**码与理由**：`old-plugin-unknown` 这类保守拒绝如果只留一个码，
    // 用户会看到"插件装了却什么都不做"而查不出原因（EV-0078 的教训）。
    if (!d.ok) {
      appendWireLog({
        ...base, trigger, ok: false, reason: d.reason,
        gate: st && st.code, gateReason: (st && st.reason) || null,
        gateProbe: (st && st.probe) || null,
      })
      return
    }

    const t0 = Date.now()
    const timings = message.run?.timings || {}
    // 补充程度 → 意图包预算：pipeline 从 `adapter.packetBudget` 取（它本来就是这么设计的）。
    // 设置是**按 home** 的、不按会话，所以写在这里是安全的（不存在"两个会话各要不同预算"的情形）。
    // Compilation policy is passed to the invocation-scoped adapter below.
    // 0.7.8：本轮任务类检查项。命中任务类才发（宁可漏发，不要错发），条数随补充程度缩放。
    // 放在这里而不是 pipeline 里：只有这里**同时**拿得到用户原话与生效档位。
    // No keyword-selected domain playbook. Current support is generated from task and evidence.
    // P11：这一轮**真正喂进解释层的上下文**要能被解析阶段读到（短消息的引文可以来自上下文）。
    let renderedCtx = '',englishTranslation=null
    // 英文后处理**降级**时要留下凭据：以前只在有翻译时消费 prepared.warnings，
    // 于是 'english-postprocess-skipped'（「这一步降级了」的唯一记号）既进不了台账也回不到调用方。
    let englishWarnings=null
    const preparedTranslation=pol.englishMode?protectEnglishLiterals(text):null
    const out = await adapter.handleInput(session, {
      messageId,
      text,
      contextText: () => renderedCtx,
      englishTask:()=>englishTranslation?.text||null,
      // 档位 → 行为（EV-0143）：补充程度决定意图包预算，自主预算决定一批最多问几个问题。
      // 两个口子都是 pipeline 里**本来就有**的（`budget` / `maxQuestions`），这里只是把它们接上设置。
      budget: pol.packetBudgetChars,
      maxQuestions: pol.maxQuestions,
      policy: pol,
      signal: message.signal || null,
      run: message.run || null,
      interpret: async ({ userText, state, sessionId, messageId: mid, observations }) => {
        // ── P10 步骤 2：会话上下文（按 historyMode/turns 决定注不注、注多少）──
        // 读取范围与降级事实**写在注入文本里**（见 session-context.js），台账只记数字。
        const rendered = renderObserverBlock({
          mode: pol.historyMode,
          turns: pol.turns,
          available: sessionHistory.turnsOf(sessionId, { currentUserText: userText }),
        })
        // ── P10 步骤 3：只读工具（三重与条件，见 readToolsFor）──
        const cwd = cwdOf(session)
        // 会话 cwd 随时可能到手（session 对象在事件里传进来），到一次就记一次：
        // 不记的话，"这一轮解析不到 cwd"的会话会在整条会话里永远用不上工具。
        if (cwd) sessionHistory.setCwd(sessionId, cwd)
        const tools = readToolsFor({ readTools: pol.readTools, cwd: cwd || sessionHistory.getCwd(sessionId) })
        const promptStarted = Date.now()
        const protocol = await buildInterpreterProtocol({ englishMode: pol.englishMode, llm, cfg, signal: message.signal || null, home: DSH_HOME, toolsEnabled: tools.enabled, strategy: pol.strategy })
        const sys = protocol.text
        renderedCtx = String(rendered.text || '')      // 供解析阶段校验"引文来自上下文"
        const workState = adapter.capability.observer(sessionId,pol.englishMode?'en':null,{omitCurrent:true,contextText:rendered.text || ''})
        const combinedContext = [rendered.text, workState].filter(Boolean).join('\n\n')
        renderedCtx = combinedContext
        // The optimizer generates all three direction lists in the same call.
        const decideHint = pol.englishMode
          ? 'Return add/scaffold/ask as separate direction lists. Ask contains only genuine questions; the working model will organize choices. Do not infer scaffolds from keywords or omit them simply because no files were read.'
          : '分别思考并返回 add/scaffold/ask 三类方向。scaffold 聚焦对本目标有价值的临时制作与自反馈能力；不是先查环境的套话。ask 只列确需确认的问题，选项由工作模型自己组织，不写未定时默认答案。'
        const exampleHint = pol.strategy?.subConcepts === 'rich'
          ? (pol.englishMode ? 'Use a small effect or capability example where helpful; do not force examples or prescribe implementation steps.' : '有助于说明方向时可用少量现象或能力举例，不强制每条举例，不把例子写成具体实现步骤。')
          : pol.strategy?.subConcepts === 'one'
            ? (pol.englishMode ? 'A key direction may name a smaller effect as an example.' : '关键方向可点出一个较小的效果现象作例子。')
            : ''
        const budgetTokens = pol.packetBudgetTokens || 3000
        const budgetHint = pol.englishMode
          ? 'Production, temporary-scaffold and Ask together: at most ' + budgetTokens + ' output tokens, not per section; do not pad to fill the budget.'
          : '制作建议、临时脚手架建议、Ask 三段合计不超过 ' + budgetTokens + ' token，不是每段分别计算，不为用满预算凑内容。'
        const styleHint = [exampleHint, decideHint, budgetHint].filter(Boolean).join(' ')
        const caps = capabilitiesFor(sessionId, ctx)
      // 每轮把“采集端看见了什么”写一行落盘：接口可能是旧版（404）、status 也可能没这个字段，
      // 但文件一定在。出现“脚手架没提某个工具”时，先看这一行就能分清是采集端还是生成端。
      try {
        const line = JSON.stringify({ at: new Date().toISOString(), sessionId, count: Array.isArray(caps) ? caps.length : 0, sample: Array.isArray(caps) ? caps.slice(0, 12) : [] })
        appendFileSync(join(DSH_HOME, 'po06-capabilities.jsonl'), line + '\n', 'utf8')
      } catch { /* 记录失败不影响本轮 */ }
      const um = buildUserMessage({ userText, state, sessionId, messageId: mid, observations, capabilities: caps, context: combinedContext,englishMode:pol.englishMode,styleHint,translationInput:preparedTranslation?.masked })
        timings.promptMs = Date.now() - promptStarted
        const requestRecord = { capabilityCount: Array.isArray(caps) ? caps.length : 0, capabilitySample: Array.isArray(caps) ? caps.slice(0, 8) : [], protocolVersion: protocol.version, promptRevision: protocol.revision, source: protocol.source, tier: protocol.tier, language: protocol.language, parts: protocol.parts, systemText: sys, systemChars: sys.length, userPromptChars: um.length, outputBudgetTokens: budgetTokens, inputId: mid, at: Date.now(), toolsEnabled: tools.enabled, effort: cfg.reasoningEffort || null, provider: cfg.provider, model: cfg.model }
        optimizerRequests.set(sessionId, requestRecord)
        while (optimizerRequests.size > 200) optimizerRequests.delete(optimizerRequests.keys().next().value)
        // 生成边界上的**唯一**重试：传输层中断（连接被对端掐断，未产出可用内容）。
        // 这不是语义重试——不重放解析、不补占位，只是把同一次请求在断线后重发一次；
        // 最多一次，且用户已取消或运行已作废时绝不重试。
        const attempts = []
        let r = null
        for (let attempt = 1; ; attempt += 1) {
          const startedAt = Date.now()
          r = await interpretViaLlm({ llm, cfg, userPrompt: um, system: sys, tools, onDelta, signal: message.signal || null, englishMode: pol.englishMode, sessionId })
          attempts.push({ attempt, ms: Date.now() - startedAt, error: r.error || null, tools: tools.enabled === true })
          const transport = /TRANSPORT|transport failed/i.test(String(r.error || ''))
          const live = !message.signal?.aborted && (!message.run || adapter.optimizationRuns.isCurrent(message.run))
          if (!transport || attempt >= 2 || !live) break
          timings.transportRetries = attempt
          progressSet(sid, { stage: 'interpret', startedAt: t0, retrying: true })
          appendWireLog({ sessionId: String(sessionId), trigger: 'optimizer-transport-retry', ok: false, attempt, ms: attempts.at(-1).ms })
        }
        timings.modelMs = attempts.reduce((sum, row) => sum + row.ms, 0)
        timings.modelAttempts = attempts
        if (message.run && !adapter.optimizationRuns.isCurrent(message.run)) throw new Error('aborted')
        if (optimizerRequests.get(sessionId) === requestRecord) {
          requestRecord.ms = r.ms
          requestRecord.reasoningChars = String(r.reasoning || '').length
          requestRecord.usage = r.usage || null
          requestRecord.status = r.error ? 'failed' : 'returned'
        }
        // P11：把 token 用量也送进进度面（界面上 `Σ N tok`，0.5 的状态行就是这样）。
        // 有的 provider 不上报用量 ⇒ 记 null，界面显示"— tok"，**不拿 0 冒充"没花 token"**。
        progressSet(sid, { usage: usagePartsOf(r.usage) })
        // 把这次"实际注入了什么 / 有没有派工具"交给收尾的台账（解释回调没有回传通道，见 lastContextBySession）
        lastContextBySession.set(sid, {
          // 0.7.5：这一轮**实际带出去的思考档位**（null = 没传、走 provider 默认）。
          // 有它才能回答"我设了 max，那一刻真的用上了吗"——否则只能靠 reasoningChars 间接猜。
          effort: (cfg && cfg.reasoningEffort) ? String(cfg.reasoningEffort) : null,
          effortRoute: (cfg && cfg.provider && cfg.model) ? (cfg.provider + '/' + cfg.model) : null,
          historyMode: rendered.mode,
          historyTurns: rendered.turns,
          historyChars: rendered.chars,
          historyAvailable: rendered.available,
          historyTruncated: rendered.truncated === true,
          readTools: pol.readTools === true,
          toolsEnabled: tools.enabled === true,
          toolsReason: tools.reason,
          promptChars: um.length,
          systemChars: sys.length,
          optimizerProtocolVersion: OPTIMIZER_PROTOCOL_VERSION,
          via: r.via || 'plain',
          ms: r.ms,
          // P11：**token 计数**（0.5 的状态行有 `Σ {tok} tok`，用户 2026-09-21 要求照搬）。
          // 拿不到就记 null——**不拿 0 冒充"没花 token"**（有的 provider 不上报用量）。
          usage: (r.usage && typeof r.usage === 'object') ? r.usage : null,
          usageTotal: usageTotalOf(r.usage),
          // P11：解释层**这一轮到底产出了多少字 / 有没有报错**。真机反馈"no-packet"时，
          // 台账里原本只有 outcome=noop、看不出是"模型回空"还是"回了个没改动的输出"——
          // 这两者的修法完全不同，所以把原始长度与错误原文都记下来（不吞）。
          textChars: String(r.text == null ? '' : r.text).length,
          interpretError: r.error || null,
          // 解释层**回了什么开头**：`outcome:noop` 时这条能直接回答"是模型回了空，还是回了'无需改动'"。
          // ⚠ 200 字**不够用**（2026-09-21 复查）：`reducer-rejected` 那几条的开头 200 字正好停在
          // `"kind":"observed_fact","text":"…` 处，看不到真正的 `sourceRefs`，于是"到底哪个字段被判 BAD_SCHEMA"
          // 只能靠猜 ⇒ 又得重跑一次真机。放宽到 4000 字，让下一次故障一次读清。
          interpretHead: String(r.text == null ? '' : r.text).slice(0, 4000),
          reasoningChars: String(r.reasoning == null ? '' : r.reasoning).length,
          ...(r.context || {}),
        })
        if (r.error) throw new Error(String(r.error))
        const finish = typeof r.finish === 'object' ? r.finish?.kind : r.finish
        if (!['stop', 'end', 'completed', 'complete'].includes(finish)) throw new Error('optimizer-incomplete:' + String(finish || 'missing-finish'))
        if (message.signal?.aborted) throw new Error('aborted')
        if(pol.englishMode){
          const ex=readEnglishInterpretation(r.text)
          if(!ex.ok)return r.text
          const englishStarted = Date.now()
          const prepared=await resolveEnglishInterpretation({value:ex.value,originalText:text,prepared:preparedTranslation,service:adapter.english,llm,cfg,signal:message.signal || null})
          timings.englishRepairMs = Date.now() - englishStarted
          if (prepared.ok === false) {
            const error = new Error(prepared.reason || 'english-postprocess-failed')
            error.attempts = prepared.repair?.attempts || []
            error.warnings = prepared.warnings || []
            throw error
          }
          if(prepared.translation)englishTranslation={...prepared.translation,source:'interpreter',ms:r.ms,usage:r.usage||null,warnings:prepared.warnings}
          else {
            const degraded=Array.isArray(prepared.warnings)?prepared.warnings.filter(w=>w&&w.reason):null
            if(degraded&&degraded.length){ englishWarnings=degraded
              appendWireLog({sessionId:String(sessionId),trigger,ok:false,reason:'english-postprocess-skipped',warnings:degraded,ms:r.ms}) }
          }
          return JSON.stringify(prepared.value)
        }
        return r.text
      },
    })
    timings.optimizationMs = Date.now() - t0
    const st2 = adapter.intentStateOf ? adapter.intentStateOf(session) : null
    // 上下文/工具的**归因台账**（P10 步骤 2/3 的验收要求）：
    // `historyMode/turns/historyChars` 说明"这一轮读了多少上下文"；
    // `toolLoopError/toolRounds/toolCalls/toolNames` 说明"派了几轮工具、有没有回落"。
    // 一个字都读不到时这些字段是 0/空数组——那是**事实**（没注入就是没注入），不是缺省值。
    const cx = lastContextBySession.get(sid) || null
    lastContextBySession.delete(sid)
    appendWireLog({
      ...base, trigger, ok: out.ok === true, outcome: out.outcome, status: out.status, runId: messageId, cfgSource: cfg.source,
      provider: cfg.provider, model: cfg.model, ms: Date.now() - t0, timings: { ...timings },
      packetChars: out.packet && out.packet.ok ? out.packet.text.length : 0,
      packetOk: Boolean(out.packet && out.packet.ok),
      // 意图包**有没有超档位承诺的预算**：超了的话注入文本里会写【预算不足】，
      // 但台账以前查不到 ⇒ "档位看着没生效"只能靠人去读那段文本（EV-0149 顺带查出）。
      // 补上这三个字段后，"这一轮为什么这么长"在台账里就能直接回答。
      packetOverBudget: Boolean(out.packet && out.packet.overBudget),
      packetOverBy: out.packet && typeof out.packet.overBy === 'number' ? out.packet.overBy : 0,
      packetBudget: out.packet && typeof out.packet.budget === 'number' ? out.packet.budget : null,
      // **归一记账**（2026-09-24）：为形状做过哪些"就地修"（候选字符串化、超数截断、补 id…）。
      // 位置在 `trace` 里（由 pipeline 的 `step('normalize', …)` 记），因为 `out` 不含 patch；
      // 那条纪律写的是"**不静默**地修"——修了什么必须能被查到，所以不在这里另起一个字段。
      revision: st2 ? st2.revision : null,
      stateAfter: adapter.debugStateOf ? adapter.debugStateOf(session) : null,
      // ── P10 新增字段（**只增不改**：默认路径下这些是 0/false/空，行为不变）──
      ...ledgerContextFields({ policy: pol, cx }),
      // 同一时刻用**从 agents 注册表取到的新 session 对象**再读一次：
      // 若这次能读到，说明问题出在"我手里这个 session 对象过期/换作用域"，
      // 而不是"注册没了"——两者的修法完全不同。
      stateViaAgent: (() => {
        try {
          const a = adapter.agentFor(sid)
          const s = a && (a.session || (typeof a.getSession === 'function' ? a.getSession() : null))
          if (!s) return { ok: false, reason: 'no-agent-session', agentKeys: a ? Object.keys(a).slice(0, 12) : null }
          return adapter.debugStateOf(s)
        } catch (e) { return { ok: false, reason: 'threw:' + String((e && e.message) || e) } }
      })(),
      trace: Array.isArray(out.trace)
        // 失败的那一步**要把错误原文带上**：只记 "interpret:fail" 时，真机上"7 毫秒抛了"却看不出为什么
        // （用户 2026-09-21 的只读工具故障就是卡在这里，只能靠 ms 反推）。
        // ⚠ 原写法 `s.error || s.code || s.reason` 会**吞掉 reason**：`dryRun:fail(BAD_SCHEMA)` 里
        // BAD_SCHEMA 只是分类，真正指出"哪个字段不合法"的是 reason（schema 的 errors 文本）。
        // 现在 code 与 reason 都留；被逐条丢弃的条目数也带上（不许"看着成了、其实少了一条"）。
        ? out.trace.map((s) => {
          const dropped = Array.isArray(s.dropped) && s.dropped.length ? '+dropped(' + s.dropped.length + ')' : ''
          if (s.ok !== false) return dropped ? s.step + dropped : s.step
          const detail = [String(s.error || s.code || '?'), s.error ? null : s.reason].filter(Boolean).join(' | ')
          return s.step + ':fail(' + detail.slice(0, 200) + ')' + dropped
        })
        : null,
    })
    return {...out,englishTranslation,...(englishWarnings?{englishWarnings}:{})}
  } catch (e) {
    const reason = String(e?.message || e)
    appendWireLog({ ...base, trigger, ok: false, reason: 'threw:' + reason })
    return { ok: false, status: 'failed', outcome: 'interpret-threw', reason, packet: null }
  }
}

/**
 * P11 · 拦截路径的**进度面**：让"优化中"那几十秒看得见（用户 2026-09-21："看不到任何思考过程"）。
 * 只存展示用的小数据（阶段 + 流式正文的**尾部**），不落盘、不进会话、不影响模型调用。
 */
const interceptProgressBySession = new Map()
// ⚠ 用户实测两次："字数一多，**开头的思维内容就消失了**"。第一次我以为是这里按尾部截断（1200→20000），
// 但用户第三次明确要求：**直接不要节省** —— 思维链必须从第一字保留到当前，不做任何截断。
// 所以这里**不再切窗口**（原文只增不减）；显示端也不许再截（见 client.js 的思维层渲染）。
const PROGRESS_TAIL = Infinity
function progressSet(sid, patch) {
  try {
    const cur = interceptProgressBySession.get(sid) || {}
    interceptProgressBySession.set(sid, { ...cur, ...patch, at: Date.now() })
  } catch { /* 进度是展示层，绝不打断解释 */ }
}
function progressAppend(sid, d) {
  try {
    const cur = interceptProgressBySession.get(sid) || {}
    const fullText = String(cur.text || '') + String((d && d.text) || '')
    const fullReason = String(cur.reasoning || '') + String((d && d.reasoning) || '')
    interceptProgressBySession.set(sid, {
      ...cur, stage: 'streaming',
      text: fullText, reasoning: fullReason,          // 全文保留，一字不丢
      textChars: fullText.length, reasoningChars: fullReason.length,
      droppedChars: 0,
      at: Date.now(),
    })
  } catch { /* 同上 */ }
}
/** 读某会话的进度（控制 API 用）。没有就回 `{ok:true, active:false}`——"没在跑"是正常状态，不是错误。 */
function progressGet(sid) {
  const p = interceptProgressBySession.get(String(sid == null ? '' : sid)) || null
  if (!p) return { active: false }
  return {
    active: true, stage: p.stage || null, at: p.at || null,
    elapsedMs: p.startedAt ? (Date.now() - p.startedAt) : null,
    text: String(p.text || ''), reasoning: String(p.reasoning || ''),
    textChars: typeof p.textChars === 'number' ? p.textChars : String(p.text || '').length,
    reasoningChars: typeof p.reasoningChars === 'number' ? p.reasoningChars : String(p.reasoning || '').length,
    // ⚠ 这里曾经写成 `typeof p.usage === 'number' ? p.usage : null` —— 而 usage 现在是**对象**
    // （`{in,out,cache,total}`）⇒ 这一行把它整条丢成 null ⇒ 界面永远 `Σ — tok`。
    // 用户实测"token 依然是 -、而 0.5.x 能计数"就是卡在这一行（收着了、却没送到界面）。
    usage: (p.usage && typeof p.usage === 'object') ? p.usage : null,
    droppedChars: typeof p.droppedChars === 'number' ? p.droppedChars : 0,
    reason: p.reason || null,
  }
}

/**
 * 等启用判定落地（上限 timeoutMs）。**只有前置拦截用**：
 * `ensure()` 是异步懒判定，第一次拦截时通常还是 `resolving`；而 `runProductionInput` 是**同步**
 * 读它的结论 ⇒ 结论没落地就按保守方向"不启用"，于是第一次拦截必然白跑（真机台账 `gate-disabled`）。
 * 用轮询而不是 `onChange`：监听器只增不减，每拦一次挂一个 = 泄漏。
 */
async function awaitGateDecision(sid, timeoutMs = 25000) {
  const g = adapter.enableGate
  if (!g || typeof g.ensure !== 'function') return PENDING
  let cur = g.ensure(sid)
  const t0 = Date.now()
  while (cur && cur.status === 'resolving' && (Date.now() - t0) < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200))
    cur = typeof g.statusFor === 'function' ? g.statusFor(sid) : cur
  }
  return cur || PENDING
}

/** 从各种可能的形状里挖出 `{provider, model}`（宿主不同服务的返回形状不一样，挖不到就回 null）。 */
function pickProviderModel(v) {
  if (!v || typeof v !== 'object') return null
  const cands = [v, v.selection, v.current, v.value, v.settings, v.model]
  for (const c of cands) {
    if (!c || typeof c !== 'object') continue
    const prov = c.provider
    const mod = (c.model && typeof c.model === 'object') ? c.model.model : c.model
    if (typeof prov === 'string' && prov && typeof mod === 'string' && mod) return { provider: prov, model: mod }
  }
  return null
}

/**
 * 确保解释层有模型路由可走。真机台账里的 `no-model-route` 是这么来的：
 * 解释层默认"跟随会话模型"，而**会话模型是从 `request/header` 事件观测到的**——
 * 前置拦截发生在消息进入宿主**之前**，所以还没有那次观测。
 *
 * ⚠ 兜底的**顺序**很要命：真机实测（用户 2026-09-21）第一次兜底取的是"模型清单里的第一条"，
 * 那是 `deepseek-flash`——**1 秒就回了一个没有改动的输出**（台账 `outcome:noop / ms≈1s / pkt=0`）。
 * 也就是说"随便挑一条能用的"会把优化器变成摆设。所以顺序改成：
 *   ① 已观测到（最准）→ ② 会话自己的模型选择 → ③ 宿主的**默认模型服务** → ④ 才轮到清单第一条。
 * 无论走哪条，台账都记 `route` 来源；④ 还会在界面上明说"这轮用的是兜底模型"。
 */
/**
 * 问宿主“**此刻**这个会话用的是哪个模型”。
 *
 * 为什么必须单独有这个查询（2026-10-21 用户实测：跟随会话模型调用的不是此刻的模型）：
 * 缓存里的观测值来自**上一轮**的 request/header。用户中途在宿主界面换了模型后，
 * 下一条消息被我们**前置拦截**——那一刻还没有新的 header，缓存仍是旧模型。
 * 只看缓存 ⇒ 这一轮会拿旧模型去优化（档位也按旧模型取）。
 * 这里直接问 sessionController / agentDefaultModel，拿到的是宿主当下的选择。
 */
async function querySessionSelection(ctx, sid) {
  // ① 宿主**此刻的待生效选择**就在投影里（宿主自己也是这么读的：
  //    dsh-api-session-controller 用 sessionProjections.stateOf(agent.session,'modelSelection').pending）。
  //    这条最准时：用户刚在输入框旁换了模型、消息还没发出去时，pending 已经是新值。
  try {
    const ag = adapter.services.agents && typeof adapter.services.agents.get === 'function'
      ? adapter.services.agents.get(String(sid || '')) : null
    const svc = (ag && ag.ctx && typeof ag.ctx.get === 'function' ? ag.ctx.get('sessionProjections') : null)
      || (adapter.services && adapter.services.sessionProjections) || null
    if (ag && ag.session && svc && typeof svc.stateOf === 'function') {
      const st = svc.stateOf(ag.session, 'modelSelection')
      const pending = st && st.pending
      const picked = pending == null ? null : pickProviderModel(pending)
      if (picked) return { p: picked, from: 'session' }
    }
  } catch { /* 投影读不到就继续问服务 */ }
  try {
    const sc = adapter.services.sessionController
    for (const fn of ['inspect', 'modelSelection', 'selection', 'model']) {
      if (!sc || typeof sc[fn] !== 'function') continue
      let raw = null
      try { raw = await sc[fn](sid) } catch { continue }
      const p = pickProviderModel(raw) || pickProviderModel(raw && (raw.selection || raw.modelSelection))
      if (p) return { p, from: 'session' }
    }
  } catch { /* 拿不到就继续 */ }
  return null
}

/** 宿主的默认模型服务（不针对某个会话，只在会话没有自己的选择时使用）。 */
async function queryHostDefault(ctx) {
  try {
    const adm = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    for (const fn of ['currentSelection', 'current', 'read', 'get', 'selection']) {
      if (adm && typeof adm[fn] === 'function') {
        const p = pickProviderModel(await adm[fn]())
        if (p) return p            // 只返回模型本身：调用方会把它当成路由缓存
      }
    }
  } catch { /* 拿不到就回 null，交给下一级兜底 */ }
  return null
}


async function ensureModelRoute(ctx, sid) {
  // 解析顺序**从最局部到最兜底**（2026-10-21 用户实测：跟随时调用的不是此刻的模型）：
  //   ① 宿主投影里"待生效的选择"（用户刚换的模型就在这里，最准时）
  //   ② 会话自己的选择（sessionController.inspect）
  //   ③ 本会话缓存（上一轮 request/header 观测到的）
  //   ④ 其它会话最近观测到的（全局兜底，必须自报 observed-global）
  //   ⑤ 宿主默认模型服务
  //   ⑥ 清单第一条（界面会明说这是兜底）
  // ⚠ ⑤ 绝不能排在 ③ 前面：那会拿"全局默认"覆盖一个本来正确的会话模型。
  const fresh = await querySessionSelection(ctx, sid)
  if (fresh && fresh.p) {
    const cached = ownModelFor(sid)
    observeModel(sid, fresh.p)
    const same = cached && cached.provider === fresh.p.provider && cached.model === fresh.p.model
    return { ok: true, source: same ? 'observed' : 'session', refreshed: !same }
  }
  const own = ownModelFor(sid)
  if (own) return { ok: true, source: 'observed' }
  if (modelFor(sid)) return { ok: true, source: 'observed-global', picked: JSON.stringify(modelFor(sid)) }
  const dflt = await queryHostDefault(ctx)
  if (dflt) { observeModel(sid, dflt); return { ok: true, source: 'host-default' } }
  try {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.listProviders !== 'function') return { ok: false, reason: 'no-llm-service' }
    const ps = await llm.listProviders()
    const p0 = Array.isArray(ps) ? ps[0] : null
    if (!p0 || !p0.id) return { ok: false, reason: 'no-provider' }
    const ms = await llm.listModels(p0.id)
    const m0 = Array.isArray(ms) ? ms[0] : null
    if (!m0 || !m0.id) return { ok: false, reason: 'no-model' }
    observeModel(sid, { provider: String(p0.id), model: String(m0.id) })
    return { ok: true, source: 'host-default-first', picked: String(p0.id) + '/' + String(m0.id) }
  } catch (e) {
    return { ok: false, reason: 'route-threw:' + String((e && e.message) || e) }
  }
}

/**
 * P11 · 前置拦截用的**按需解释**（用户要的"第一轮发，第一轮就回"）。
 *
 * 为什么必须新增这个入口：解释层归宿主所有，而它此前**只由 `session/event` 触发**——
 * 客户端把发送拦下来之后，宿主根本不知道有这条消息，"先解释、再放行"就无从谈起。
 * 这里**复用** `runProductionInput`（档位/闸门/上下文/解释层/编译/pipeline 写上下文全在里面），
 * 只是由调用方 `await` 它，再把刚写进动态上下文的包读回来交给客户端。
 *
 * 三条纪律：
 *   · **绝不抛**：任何失败都回 `{ok:false, reason}` —— 由客户端**按原文放行**（fail-open），
 *     绝不允许"解释层卡住 ⇒ 用户的消息发不出去"；
 *   · **不改会话内容**：只写内存态的 `intentBySession`（= 动态 system 上下文），不 append 任何会话事件；
 *   · **如实归因**：台账记 `trigger:'intercept'`，与零延迟路径的 `user-message` 区分得开。
 */
async function runInterceptInput(ctx, payload) {
  const sid = String(payload?.sessionId || ''), text = String(payload?.text || '')
  if (!sid || !text.trim()) return { ok: false, reason: !sid ? 'session-required' : 'empty-text' }
  const agent = adapter.agentFor(sid)
  const session = agent && (agent.session || agent.getSession?.())
  if (!session) return { ok: false, reason: 'session-not-found' }
  const messageId = String(payload.messageId || 'po06-intercept-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2))
  const existing = adapter.optimizationRuns.get(sid)
  if (existing?.runId === messageId) return existing.result || { ok: false, runId: messageId, reason: existing.status === 'running' ? 'already-running' : 'aborted' }
  const run = adapter.optimizationRuns.begin(sid, messageId, { signal: payload.signal, generation: payload.generation })
  if (!adapter.optimizationRuns.isCurrent(run)) return { ok: false, runId: messageId, reason: 'superseded-input' }
  run.policy = readPolicy({ home: DSH_HOME, sessionId: sid })
  const signal = run.controller.signal, startedAt = Date.now()
  const timings = run.timings = { promptMs: 0, modelMs: 0, englishRepairMs: 0, taskTranslationMs: 0 }
  const englishToken = run.policy.englishMode ? adapter.english.begin(sid, messageId, text) : null
  const live = () => adapter.optimizationRuns.isCurrent(run)
  const progress = patch => { if (live()) progressSet(sid, { ...patch, runId: messageId, startedAt }) }
  progress({ stage: 'gate', text: '', reasoning: '', textChars: 0, reasoningChars: 0, usage: null })
  try {
    const gate = run.policy.injectPacket ? await awaitGateDecision(sid, 25000) : PENDING
    timings.gateMs = Date.now() - startedAt
    if (!live()) return { ok: false, runId: messageId, reason: 'aborted' }
    progress({ stage: 'model' })
    const routeStarted = Date.now()
    const route = await ensureModelRoute(ctx, sid)
    timings.routeMs = Date.now() - routeStarted
    if (!live()) return { ok: false, runId: messageId, reason: 'aborted' }
    progress({ stage: 'interpret' })
    let produced, translation = null
    if (run.policy.injectPacket) {
      produced = await runProductionInput(ctx, session, { text, messageId, signal, run }, {
        trigger: 'intercept', gate, route: route.source,
        onDelta: delta => { if (live()) progressAppend(sid, delta) },
      })
      if (!produced?.ok) throw new Error(produced?.reason || produced?.outcome || 'optimization-failed')
    } else if (!englishToken) throw new Error('assist-off')
    if (!live()) return { ok: false, runId: messageId, reason: 'aborted' }
    if (englishToken) {
      const englishStarted = Date.now()
      const english = await finishEnglishInput({ service: adapter.english, token: englishToken,
        enabled: () => live() && readPolicy({ home: DSH_HOME, sessionId: sid }).englishMode,
        produced, signal, translate: async () => {
          const cfg = resolveInterpreterCfg({ config: run.policy.model ? { interpreter: run.policy.model } : pluginConfig, observed: modelFor(sid), effortByModel: run.policy.effortByModel })
          if (!cfg.ok) throw new Error('english-model-route-unavailable')
          return adapter.english.translate(text, { llm: ctx.get('llm'), cfg, signal, kind: 'user-task', sessionId: sid })
        } })
      timings.taskTranslationMs = Date.now() - englishStarted
      if (!english.ok) throw new Error(english.reason || 'english-failed')
      translation = english.translation
      if (english.fallback && english.assistanceAvailable !== true) produced = { ...produced, packet: { ok: true, text: '' } }
    }
    if (!live()) return { ok: false, runId: messageId, reason: 'aborted' }
    const policyNow = readPolicy({ home: DSH_HOME, sessionId: sid })
    if (policyNow.englishMode !== run.policy.englishMode || (run.policy.injectPacket && !policyNow.injectPacket)) throw new Error('settings-changed')
    const packet = produced?.packet?.text || ''
    timings.totalMs = Date.now() - startedAt
    const result = { ok: true, timings: { ...timings }, status: packet ? 'ready' : 'empty', runId: messageId, sessionId: sid,
      packet, chars: packet.length, understood: true, noAddition: !packet,
      englishMode: !!englishToken, outgoingText: translation?.text || text,
      translation: translation ? { ...translation, originalText: text } : null,
      understanding: produced?.understanding || null, support: null, ms: Date.now() - startedAt,
      route: route.source || null, gate: gate?.code || null, unsourced: null }
    if (!adapter.optimizationRuns.finish(run, result)) return { ok: false, runId: messageId, reason: 'superseded-input' }
    if (translation) { adapter.english.record(englishToken, translation.text, translation); adapter.capability.bindTranslation(sid, translation.text) }
    progress({ stage: packet ? 'done' : 'noop' })
    appendWireLog({ sessionId: sid, runId: messageId, trigger: 'intercept-result', ok: true, status: result.status, ms: result.ms, timings: result.timings, packetChars: packet.length })
    return result
  } catch (error) {
    const reason = String(error?.message || error)
    timings.totalMs = Date.now() - startedAt
    const englishAttempts = Array.isArray(error?.attempts) ? error.attempts : null
    const result = { ok: false, timings: { ...timings }, status: signal.aborted ? 'aborted' : 'failed', runId: messageId, reason, packet: '', chars: 0, ms: Date.now() - startedAt, ...(englishAttempts ? { englishAttempts } : {}) }
    if (live()) { adapter.optimizationRuns.finish(run, result); progress({ stage: 'failed', reason }) }
    appendWireLog({ sessionId: sid, runId: messageId, trigger: 'intercept-result', ok: false, reason, timings: result.timings, ...(englishAttempts ? { englishAttempts } : {}) })
    return result
  }
}

/**
 * 读启用意图；任何异常都不抛出，一律回落到保守值。
 *
 * 顺序：① 0.6 自己的配置文件 → ② 旧路径（只读回退）**且必须是"我们的"配置**。
 * 第 ② 步的 `ours` 检查是**安全关键**：0.5.x 的设置文件就在同一个旧路径上，
 * 没有 `settingsVersion` 标记，因此这里会判 `not-a-0.6-config` 并保持不启用。
 */
function readEnableIntent() {
  const readText = (p) => { try { return existsSync(p) ? readFileSync(p, 'utf8') : null } catch { return null } }
  return pickEnableIntent(readText(ENABLE_CONFIG_PATH), readText(LEGACY_ENABLE_CONFIG_PATH))
}

/**
 * 解析某个会话的启用判定，并把探测结果映射成**三态**。
 * 注意 `toActiveTriState`：探测拿不到作用域时返回 null（不知道）→ 不启用，
 * 绝不把"没法判"当成"旧插件不在装"（ADR-0033）。
 */
async function decideEnableFor(agentId) {
  const intent = readEnableIntent()
  let active = null
  // 诊断明细：`old-plugin-unknown` 只在"探测没得出结论"时出现，
  // 而**没得出结论的原因**决定了该修什么（缺服务？缺 agent？assemble 抛错？）。
  // 只留一个 code 会让"装了却什么都不做"变成无法归因的谜（EV-0078/0079）。
  const probe = { agentId: String(agentId), hasSp: false, assemble: false, hasAgent: false,
    rt: null, staticActive: null, staticReason: null, agentsType: null, agentsGet: null,
    agentsCount: null, sidInRegistry: null }
  try {
    const agent = adapter.agentFor(agentId)
    const sp = adapter.services.systemPrompt
    probe.hasSp = Boolean(sp && typeof sp.assemble === 'function')
    probe.hasAgent = Boolean(agent)
    // agents 注册表本身的实况：`hasAgent:false` 可能是"服务没接上"、
    // 也可能是"这个 id 还不在注册表里"（时序）——两者要修的地方完全不同。
    const ag = adapter.services.agents
    probe.agentsType = typeof ag
    probe.agentsGet = ag ? typeof ag.get : 'n/a'
    try { probe.agentsCount = ag && typeof ag.list === 'function' ? ag.list().length : null } catch (e) { probe.agentsCount = 'threw' }
    try {
      probe.sidInRegistry = ag && typeof ag.list === 'function'
        ? ag.list().some((a) => a && String(a.id) === String(agentId))
        : null
    } catch { probe.sidInRegistry = 'threw' }
    if (sp && agent) {
      const rt = await detectOldPluginRuntime({ systemPrompt: sp, agent })
      probe.rt = { active: rt.active, confidence: rt.confidence, reason: rt.reason, evidence: rt.evidence }
      let st = null
      try {
        const { detectOldPluginStatic } = await import('./host-migrate.js')
        st = detectOldPluginStatic(PROFILE_DIR)
        probe.staticActive = st ? st.active : null
        probe.staticReason = (st && st.reason) || null
      } catch (e) { probe.staticReason = 'static-threw:' + String((e && e.message) || e) }
      active = toActiveTriState(mergeOldPluginSignals(rt, st))
    }
  } catch (e) {
    probe.threw = String((e && e.message) || e)
    active = null
  }
  const decision = resolveEnableDecision({ intent, sessionId: agentId, oldPluginActive: active })
  return { ...decision, probe }
}

export const name = '@dsh-external/dsh-wish-specializer'
// ⚠ 不要再声明 inject：实测这个静态导出会让插件加载失败（控制面整片 404）。
// 预设判定已经整体移除，登记表也不再需要，保持不注入。
/** 版本号从**随包发行的 package.json** 读，不写死（写死就会漂——本项目栽过这类跟头）。 */
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version } catch { return null }
})()

class DshAdapter {
  constructor() {
    // **按会话隔离**：意图包文本是 per-session 的。
    // 早期版本用一个全局字符串，会让 A 会话的意图泄漏进 B 会话（违反隔离不变量）。
    // `systemPrompt.context` 的 text(context) 能拿到 `context.agent`，据此取会话 id。
    this.optimizationRuns = createOptimizationRuns()
    this.lastRealUserMessageBySession = new Map()
    this.capability = createCapability({ home: DSH_HOME, namespace: process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE || 'default' })
    /** P11 包级回退：每会话最近 10 版**非空**包（旧到新）。 */
    // 第 5 项之后的新增（2026-10-18 用户要求）：顾问不该只是个摆设。
    // 最近一次 consult_task 的 directive 会随注入文一起进上下文（有 TTL），
    // 于是它对模型的分量从"工具结果里的一段话"变成"系统上下文里的一条要求"。
    this.advisorDirectives = new Map()
    // 「本次注入」记录：**只存在插件自己的内存里**，绝不写会话日志（见 productionTrigger 里的
    // P0 事故注释：自定义事件类型会让宿主的读取器拒绝整条会话）。
    // 只保留每会话最近一条；客户端通过 /po06/api/injection 取回，刷新/重开还能看见。
    this.injections = new Map()
    this.injectionById = new Map()
    this.presetNotices = new Map()
    this.presetsBySession = new Map()
    // 落盘：记录放插件自己的 state 目录（**不进会话日志**），重启后对话流卡片还能取到正文。
    this.injectionFile = join(DSH_HOME, 'po06-state', 'injections.json')
    this.injectionSaveTimer = null
    try {
      const rows = JSON.parse(readFileSync(this.injectionFile, 'utf8'))
      if (Array.isArray(rows)) for (const row of rows) {
        if (!row || typeof row.id !== 'string' || typeof row.injected !== 'string') continue
        this.injectionById.set(row.id, row)
        if (typeof row.sessionId === 'string') this.injections.set(row.sessionId, row)
      }
    } catch { /* 没有存档就空着 */ }
    // 意图状态的**权威**在本插件手里（内存 + 自己的存储），不再经会话日志/投影（EV-0081）。
    this.stateBySession = new Map()
    this.stateStore = null
    // 上下文提供者抛错时的去重表（EV-0102）：同一会话同一错误只记一次台账
    this.contextErrors = new Map()
    this.contextDisposer = null
    this.services = { agents: null, sessionController: null, systemPrompt: null, sessionProjections: null }
    this.readyResolvers = []
    this.ready = new Promise((resolve) => this.readyResolvers.push(resolve))
    this.projectionDisposer = null
    this.projectionResolvers = []
    this.projectionReady = new Promise((resolve) => this.projectionResolvers.push(resolve))
    /** 政策快照（`po06.json` → policyFor）。见 `policyNow()` 的说明：**注入门禁要用它**。 */
    this.policyCache = null
  }

  /**
   * 读**当前生效**的政策（带 2 秒缓存）。
   *
   * 为什么需要它（真机 2026-09-22，用户报"拨到关闭档之后，再发消息仍会注入上一次的优化上下文"）：
   * 动态上下文的 `text()` 是**同步**的，而它此前**只查了启用闸门**（灰度 / enabled / 双重拦截），
   * **没查档位**。于是"关闭档"只挡住了**新**的拦截（`runProductionInput` 里的政策闸门），
   * 却挡不住**已经存在**的那一份包 —— 它继续被注入到后面每一轮装配里。
   * 档位是政策（`assist:'off'` ⇒ `injectPacket:false`），注入前必须按政策硬短路。
   */
  policyNow(sessionId) {
    const key = (sessionId === undefined || sessionId === null) ? '' : String(sessionId)
    const now = Date.now()
    // ⚠ 缓存必须**按会话分键**（0.7.7）：档位现在是会话级的，
    //   若还按单一键缓存，A 会话算出的政策会被 B 会话直接复用 ⇒ 会话级档位形同虚设。
    if (this.policyCache && this.policyCache.key === key && (now - this.policyCache.at) < 2000) return this.policyCache.pol
    let pol = null
    try { pol = readPolicy({ home: DSH_HOME, sessionId: key }) } catch { pol = null }
    this.policyCache = { at: now, key, pol }
    return pol
  }

  /** 政策缓存作废（设置写盘后立刻调用，别等 2 秒 TTL）。 */
  invalidatePolicy() { this.policyCache = null }

  /**
   * 清掉**所有会话**的意图包文本（政策变成"不注入"、或用户关掉插件时用）。
   *
   * 为什么必须清而不只是"注入时挡一下"（用户 2026-09-22 的第 1 条报障）：
   * 关档 → 开档之间**没有新的解释**，若只挡不注入，重新开档的那一刻那份**上一轮的旧包**
   * 会立刻复活并被注入这一轮 —— 用户看到的仍是"上一轮的优化上下文"。
   * 清掉之后，只有本轮的拦截能产生包（包本来就是"只作用于这一轮"的东西）。
   * @returns 清掉的会话数
   */
  clearIntentTexts(reason) {
    const n = this.optimizationRuns.clear()
    this.lastRealUserMessageBySession.clear()
    this.capability.clear()
    if (n > 0) {
      try { appendWireLog({ trigger: 'packet-cleared', ok: true, cleared: n, reason: String(reason || '') }) } catch { /* 记账失败不影响清理 */ }
    }
    return n
  }

  markReady() {
    const rs = this.readyResolvers
    this.readyResolvers = []
    for (const r of rs) { try { r() } catch { /* best effort */ } }
  }

  /** 投影就绪信号（与 systemPrompt 的就绪分开，避免一个慢服务拖住另一个）。 */
  markProjectionReady() {
    const rs = this.projectionResolvers
    this.projectionResolvers = []
    for (const r of rs) { try { r() } catch { /* best effort */ } }
  }

  async waitProjectionReady(timeoutMs = 3000) {
    let timer = null
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
    const r = await Promise.race([this.projectionReady.then(() => true), timeout])
    if (timer) clearTimeout(timer)
    return r === true
  }

  /**
   * 读某会话的意图状态。**由插件自己拥有**（EV-0081）：内存优先，首次访问时从
   * 插件自己的存储按会话 id 载入，载不到返回 `null`（=尚无状态）。
   *
   * 为什么不再从投影读：投影是**日志的派生视图**，而我们的状态来自模型输出、
   * 不由日志推导；宿主契约原文写着持久化的投影行
   * "is never authoritative, only a fold shortcut"。而把状态写进会话日志这条路
   * 对第三方插件根本不存在（见 store.js 顶部三条）。所以状态的权威在**我们这里**。
   */
  intentStateOf(session) {
    const sid = session && session.id !== undefined ? String(session.id) : ''
    if (!sid) return null
    if (this.stateBySession.has(sid)) return this.stateBySession.get(sid)
    let loaded = this.stateStore ? this.stateStore.load(sid) : null
    // **状态文件读不出来时不许静默从头开始**（EV-0122）：
    // `load()` 把"真的没有"与"文件坏了 / 形状不对"折成同一个 `null`，而下游会把 `null`
    // 当成"尚无状态" ⇒ 新建空状态 ⇒ **`save()` 覆盖掉那份坏文件** ⇒
    // 用户积累的长期约束**静默消失，连证据都没了**。
    // 所以这里先 `inspect()` 分清楚：读不出来就（①）**隔离留证据**、（②）**留一条台账**
    // （原因 + 原路径 + 残骸路径），然后才按"从头开始"继续。
    if (!loaded && this.stateStore && typeof this.stateStore.inspect === 'function') {
      const diag = this.stateStore.inspect(sid)
      if (diag.present && !diag.ok) {
        const quarantined = typeof this.stateStore.quarantine === 'function' ? this.stateStore.quarantine(sid) : null
        this.stateUnreadable = (this.stateUnreadable || 0) + 1
        try {
          appendWireLog({
            sessionId: sid, ok: false, trigger: 'state-unreadable',
            reason: diag.reason, path: diag.path, quarantined,
          })
        } catch { /* best effort */ }
      }
    }
    // **分叉继承**（EV-0091）：宿主分叉会给出新的 sessionId，状态按 id 存 ⇒ 不处理就是"静默无状态"。
    // 只在**首次触达且自己没有状态**时继承；父会话没有状态就照常从头开始（不报错）。
    if (!loaded && session && session.header && session.header.parentSession) {
      const pid = String(session.header.parentSession)
      const parentState = this.stateStore ? this.stateStore.load(pid) : null
      const inherited = inheritStateForFork(parentState, sid, pid)
      if (inherited) {
        loaded = inherited
        try { if (this.stateStore) this.stateStore.save(sid, inherited) } catch { /* 下次再存 */ }
        try { appendWireLog({ sessionId: sid, ok: true, trigger: 'fork-inherit', inheritedFrom: pid, revision: inherited.revision }) } catch { /* best effort */ }
      }
    }
    this.stateBySession.set(sid, loaded)   // 载不到也记下来（null），避免每次访问都读盘
    return loaded
  }

  /** 诊断用：状态来源与规模（不参与任何判定）。 */
  debugStateOf(session) {
    const sid = session && session.id !== undefined ? String(session.id) : ''
    const v = this.intentStateOf(session)
    return {
      ok: true,
      store: this.stateStore ? this.stateStore.dir : null,
      kind: v === null ? 'null' : typeof v,
      revision: v && v.revision !== undefined ? v.revision : null,
      items: v && Array.isArray(v.items) ? v.items.length : null,
      sid: sid || null,
    }
  }

  /**
   * **唯一**的状态落盘出口。所有会改状态的地方都必须经这里——
   * 之前 `commitUserInput` 自己调了一次 `session.append`，就成了绕过纪律的旁路（EV-0081）。
   */
  land(session, state) {
    const sid = session && session.id !== undefined ? String(session.id) : ''
    if (!sid) return { ok: false, code: 'NO_SESSION', reason: 'session.id required' }
    this.stateBySession.set(sid, state)
    const r = this.stateStore ? this.stateStore.save(sid, state) : { ok: true }
    if (r && r.ok === false) return { ok: false, code: 'PERSIST_FAILED', reason: r.reason || null }
    return { ok: true, state }
  }

  /**
   * 提交候选 patch：CAS → reducer → **落进插件自己的存储**。
   * 不经会话日志（那会让宿主拒绝重建会话，EV-0081）。
   */
  commit(session, patch) {
    return commitPatch({
      session,
      currentState: this.intentStateOf(session),
      patch,
      persist: (s, state) => this.land(s, state),
    })
  }

  /**
   * 记录一次用户输入（推进 lastInputRevision，使在途候选作废）。
   *
   * ⚠ 这里**曾经直接** `session.append(STATE_EVENT, next)`，绕过了 `commitPatch`——
   * 于是"生产路径不写会话日志"这条纪律被一个**旁路**破坏了（EV-0081 的反回归测试当场抓到）。
   * 现在统一走 `this.land()`：唯一的落盘出口。
   */
  commitUserInput(session, { messageId }) {
    const cur = this.intentStateOf(session)
    if (!cur) return { ok: false, code: 'NO_BASE_STATE' }
    const next = recordUserInput(cur, { messageId })
    return this.land(session, next)
  }

  /** 新建一个空意图状态（经 reducer 的权威路径提交，避免绕过闸门）。 */
  initIntent(session, { taskId }) {
    const sid = String(session.id)
    return this.commit(session, {
      causeId: 'init',
      baseRevision: 0,
      sessionId: sid,
      taskId: taskId || 'default',
      ops: [{ op: 'set_phase', phase: 'idle' }],
    })
  }

  /**
   * 计算本轮结果；只有仍然拥有会话的运行能够保存结果。
   * `interpret` 是**注入**的解释函数；真实实现接 LLM，测试/自检传桩。
   */
  async handleInput(session, input) {
    const sid = String(session.id)
    const previous = this.optimizationRuns.get(sid)
    const run = input.run || this.optimizationRuns.begin(sid, input.messageId, { signal: input.signal, generation: input.generation })
    if (!input.run && (run === previous || !this.optimizationRuns.isCurrent(run))) return { ok: false, status: 'aborted', outcome: 'superseded-input', reason: 'duplicate-or-stale-run', packet: null }
    const ownsRun = !input.run
    this.capability.seed(session)
    const token = this.capability.beginInput(sid, String(input.messageId), String(input.text || ''))
    const out = await handleUserInput(this, session, { ...input, signal: run.controller.signal })
    if (!this.optimizationRuns.isCurrent(run)) {
      this.capability.abandonInput(sid, run.runId)
      return { ...out, ok: false, status: 'aborted', outcome: run.controller.signal.aborted && this.optimizationRuns.get(sid) === run ? 'aborted' : 'superseded-input', reason: 'superseded-input', packet: null }
    }
    if (out.ok) this.capability.settle(sid, token, out)
    else this.capability.abandonInput(sid, run.runId)
    if (ownsRun) this.optimizationRuns.finish(run, { ...out, packet: out.packet?.text || '' })
    return out
  }

  /** 等待可选注入就绪；超时返回 false（调用方必须处理 false）。 */
  async waitReady(timeoutMs = 3000) {
    let timer = null
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
    const r = await Promise.race([this.ready.then(() => true), timeout])
    if (timer) clearTimeout(timer)
    return r === true
  }

  /**
   * 更新**某会话**的意图包文本的唯一入口。空字符串 = 该会话静默待命。
   *
   * P11（包级回退）：每次**写成非空包**时，先把**上一版非空包**压进历史（每会话上限 10 条）。
   * 原来 `/rollback` 的包级分支只能如实回 501（"需要状态历史"）——现在这条历史就在这里，
   * 于是"回退到上一版包"是真能做的动作，而不是一句托辞。
   */
  setIntentText(sessionId, text) {
    const sid = String(sessionId || '')
    if (!sid) return
    const value = String(text || '')
    if (value) this.optimizationRuns.store(sid, value)
    else this.optimizationRuns.cancel(sid)
  }

  /** 包级回退：把上一版非空包放回去。没有历史就**如实说没有**（不假装成功）。 */
  rollbackPacket(sessionId, runId = null) {
    const sid = String(sessionId == null ? '' : sessionId)
    if (!sid) return { ok: false, reason: 'session-required' }
    const hist = this.optimizationRuns.get(sid)?.history || []
    if (!hist.length) return { ok: false, reason: 'no-history', note: '这个会话还没有可回退的上一版包' }
    const text = hist.at(-1)
    const currentId = runId || this.optimizationRuns.get(sid)?.runId
    const accepted = this.optimizationRuns.revise(sid, currentId, text)
    if (!accepted.ok) return accepted
    hist.pop()
    return { ...accepted, remaining: hist.length }
  }

  /** 某会话还剩几版可回退（诊断/界面用）。 */
  packetHistoryDepth(sessionId) {
    return this.optimizationRuns.get(sessionId)?.history?.length || 0
  }

  /** 取某会话当前的意图包文本（诊断/测试用）。 */
  getIntentText(sessionId) { return this.optimizationRuns.packet(sessionId) }

  getWorkingText(sessionId, messageId = null) {
    if (this.optimizationRuns.bypass(sessionId)) return ''
    // 诊断/预览入口（不传轮次）沿用旧语义；**装配入口**必须传本轮消息 id，只认这一轮已应用的包。
    if (messageId == null) return this.getIntentText(sessionId)
    return this.optimizationRuns.packetForTurn(sessionId, messageId)
  }

  /** 极限模型状态：只在会话显式选择 extreme 时附加，独立于优化包。 */
  getModelStateText(sessionId) {
    const pol = this.policyNow(sessionId)
    if (!pol || pol.modelState !== 'extreme') return ''
    return pol.englishMode ? MODEL_STATE_EN : MODEL_STATE_ZH
  }

  getAdvisorText(sessionId, feedback = '') {
    if (this.optimizationRuns.bypass(sessionId)) return ''
    const enabled = this.policyNow(sessionId)?.advisor !== false
    if (!enabled) this.advisorLedger?.clear(String(sessionId || ''))
    return enabled ? [feedback, this.activeAdvisorDirective(sessionId)].filter(Boolean).join('\n\n') : ''
  }

  /** 会话当前预设（含中途切换）：只用来判断要不要提示，不直接进界面。 */
  notePreset(sessionId, preset) {
    const sid = String(sessionId == null ? '' : sessionId)
    if (!sid || !preset) return
    this.presetsBySession.set(sid, String(preset))
    if (!this.presetsAt) this.presetsAt = new Map()
    this.presetsAt.set(sid, Date.now())
  }

  /**
   * 会话里真的跑过一轮之后，再问一次 sessionController（2026-10-19 用户提议）：
   * 有些会话是"选预设之前就存在"的老会话，头里写的是默认值；但只要在里面说过话，
   * 宿主那边的会话元数据就有机会反映真实预设 —— 这条就是去把它捞回来。
   */
  async refreshSessionPreset(sid) {
    const key = String(sid || '')
    if (!key) return
    if (!this._presetRefreshAt) this._presetRefreshAt = new Map()
    const last = this._presetRefreshAt.get(key) || 0
    if (Date.now() - last < 4000) return          // 每 4 秒最多问一次
    this._presetRefreshAt.set(key, Date.now())
    try {
      const sc = this.services && this.services.sessionController
      if (!sc || typeof sc.inspect !== 'function') return
      const info = await sc.inspect(key)
      const p = (info && info.meta && info.meta.agentPreset)
        || (info && info.header && info.header.agentPreset)
        || (info && info.agentPreset)
      if (typeof p === 'string' && p) this.notePreset(key, p)
    } catch { /* 读不到就算了，下一轮再试 */ }
  }

  /** 该会话"最后一次预设选择"的时间：客户端据此判断"预设真的变了"，不靠自己轮询的基线。 */
  presetAtOf(sessionId) {
    try { return (this.presetsAt && this.presetsAt.get(String(sessionId))) || null } catch { return null }
  }

  presetOf(sessionId) {
    return this.presetsBySession.get(String(sessionId == null ? '' : sessionId)) || null
  }

  /**
   * 最近一次“在界面上选了什么预设”（2026-10-19 用户实测的真机情形）：
   * 预设是在**会话开始之前**拨的，这时事件里还没有会话 id；等会话建立时宿主给的头仍是默认预设（ptc），
   * 于是"我明明选了标准模式，却按 ptc 判断 ⇒ 不弹窗"。
   * 所以这里单独记一条带时间戳的“待生效选择”，/preset 在没有更具体信息时优先用它（15 分钟内有效）。
   */
  notePresetPending(preset, sessionId) {
    const p = String(preset || '')
    if (!p) return
    this.presetPending = { preset: p, at: Date.now(), sid: sessionId ? String(sessionId) : '' }
    // **落盘**（2026-10-19 真机）：重启会把内存里的选择抹掉 ⇒ 重启后新会话又变回默认预设。
    try { writeFileSync(join(DSH_HOME, 'po06-preset-pending.json'), JSON.stringify(this.presetPending), 'utf8') } catch { /* 旁路 */ }
  }

  /** 这个会话第一次被我们看到的时间（用来判断"新会话是在选完预设之后才出现的"）。 */
  sessionFirstSeen(sid) {
    const key = String(sid || '')
    if (!key) return null
    if (!this.seenAt) this.seenAt = new Map()
    if (!this.seenAt.has(key)) this.seenAt.set(key, Date.now())
    return this.seenAt.get(key)
  }

  clearPresetPending() {
    this.presetPending = null
    try { writeFileSync(join(DSH_HOME, 'po06-preset-pending.json'), '{}', 'utf8') } catch { /* 旁路 */ }
  }

  pendingPreset() {
    const row = this.presetPending || (() => {
      // 惰性读盘：进程刚起来时也要能记得"重启前刚拨过的预设"
      try { return JSON.parse(readFileSync(join(DSH_HOME, 'po06-preset-pending.json'), 'utf8')) } catch { return null }
    })()
    if (!row || !row.preset) return null
    if (Date.now() - Number(row.at || 0) > 15 * 60 * 1000) return null
    this.presetPending = row
    return { ...row }
  }

  /** 预设事件的取证：先拨预设、后开会话这条路上到底有没有事件、带没带会话 id。 */
  tracePresetEvent(sessionId, preset) {
    try {
      const p = join(DSH_HOME, 'po06-api-trace.jsonl')
      appendFileSync(p, JSON.stringify({
        at: new Date().toISOString(), k: 'preset-event',
        sid: String(sessionId == null ? '' : sessionId).slice(0, 48), preset: String(preset || ''),
      }) + '\n', 'utf8')
    } catch { /* 取证是旁路 */ }
  }

  /** 预设提示（2026-10-19）：非 Wish / PTC 预设时，per-session 记一条，客户端据此弹提示。 */
  notePresetNotice(sessionId, preset) {
    const sid = String(sessionId == null ? '' : sessionId)
    if (!sid || !preset) return
    this.presetNotices.set(sid, { preset: String(preset), at: Date.now() })
  }

  getPresetNotice(sessionId) {
    const row = this.presetNotices.get(String(sessionId == null ? '' : sessionId))
    return row ? { ...row } : null
  }

  clearPresetNotice(sessionId) {
    this.presetNotices.delete(String(sessionId == null ? '' : sessionId))
  }

  clearAllPresetNotices() {
    this.presetNotices.clear()
  }

  /** 记下一次注入（每会话保留最近一条；**不进会话日志**）。返回这条记录的 id。 */
  noteInjection(sessionId, row) {
    const sid = String(sessionId == null ? '' : sessionId)
    if (!sid || !row || typeof row.injected !== 'string' || !row.injected.trim()) return null
    const id = String(row.id || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)))
    const rec = {
      id,
      anchorSeq: Number.isFinite(row.anchorSeq) ? row.anchorSeq : null,
      chars: Number.isFinite(row.chars) ? row.chars : row.injected.length,
      injected: row.injected,               // 读的时候也不截断（历史记录里的旧文本照原样给出）
      truncated: row.truncated === true,
      at: Number.isFinite(row.at) ? row.at : Date.now(),
    }
    this.injections.set(sid, rec)
    this.injectionById.set(id, { ...rec, sessionId: sid })
    // 上限：只留最近 200 条（够回看，又不常驻内存）
    while (this.injectionById.size > 200) {
      const oldest = this.injectionById.keys().next().value
      this.injectionById.delete(oldest)
    }
    this.scheduleInjectionSave()
    return id
  }

  /** 合并写盘：1 秒内的多次记录只写一次（文件很小，避免每条都 fsync）。 */
  scheduleInjectionSave() {
    if (this.injectionSaveTimer) return
    this.injectionSaveTimer = setTimeout(() => {
      this.injectionSaveTimer = null
      try {
        mkdirSync(dirname(this.injectionFile), { recursive: true })
        writeFileSync(this.injectionFile, JSON.stringify([...this.injectionById.values()].slice(-200)), 'utf8')
      } catch { /* 存不下不影响本次答复 */ }
    }, 1000)
    try { if (typeof this.injectionSaveTimer.unref === 'function') this.injectionSaveTimer.unref() } catch { /* 老运行时不支持 */ }
  }

  /** 取注入记录：给 id 就按 id（对话流卡片用），否则按会话取最近一条（胶囊用）。 */
  getInjection(arg) {
    if (arg && typeof arg === 'object') {
      const id = String(arg.id == null ? '' : arg.id).trim()
      if (id) return this.injectionById.get(id) || null
      const sid = String(arg.sessionId == null ? '' : arg.sessionId)
      const row = this.injections.get(sid)
      return row ? { ...row } : null
    }
    const row = this.injections.get(String(arg == null ? '' : arg))
    return row ? { ...row } : null
  }

  /** 记下最近一次顾问指令（有 TTL；新的覆盖旧的）。 */
  noteAdvisorDirective(sessionId, text) {
    const sid = String(sessionId == null ? '' : sessionId)
    const body = String(text == null ? '' : text).trim()
    if (!sid || !body) return
    this.advisorDirectives.set(sid, { text: body.slice(0, 1600), at: Date.now() })
  }

  /** 取当前仍然有效的顾问指令（20 分钟内；不消费，读多少次都一样）。 */
  activeAdvisorDirective(sessionId) {
    const sid = String(sessionId == null ? '' : sessionId)
    const row = this.advisorDirectives.get(sid)
    if (!row) return ''
    if (Date.now() - row.at > 20 * 60 * 1000) { this.advisorDirectives.delete(sid); return '' }
    return row.text
  }

  /** 当前有意图包的会话数（诊断用）。 */
  intentSessionCount() {
    return this.optimizationRuns.size()
  }

  registerContext(ctx) {
    try {
      ctx.inject(['systemPrompt'], (scope) => {
        try {
          this.services.systemPrompt = scope.systemPrompt
          this.contextDisposer = scope.systemPrompt.context({
            name: CONTEXT_NAME,
            order: CONTEXT_ORDER,
            // 意图文本是数据，不是宿主变量模板：字面量 {{cwd}} 之类的文本必须原样保留（issue #38）。
            interpolate: false,
            // 按会话渲染：装配 context 携带 agent，据此取该会话的意图包；取不到就是空（静默）
            text: (assemblyCtx) => {
              try {
                const agent = assemblyCtx && assemblyCtx.agent
                const session = agent && (agent.session || (typeof agent.getSession === 'function' ? agent.getSession() : null))
                const sid = session?.id !== undefined ? String(session.id) : agent && agent.id !== undefined ? String(agent.id) : ''
                if (!sid || this.optimizationRuns.bypass(sid)) return ''
                // ── 启用闸门（A10/A12）──────────────────────────────
                // 灰度 + 设置 + 双重拦截守卫**在这里**生效，而不是只在自检里生效。
                // 未判定时 statusFor 返回 PENDING（=不启用）⇒ 贡献空字符串 ⇒ 等同于没拦截。
                const st = adapter.enableGate ? adapter.enableGate.ensure(sid) : PENDING
                if (!st || st.enabled !== true) return ''
                // ── 档位闸门（**必须在这里**，不能只在"产生新包"那条路上）──────────
                // 真机 2026-09-22（用户报："拨到关闭档之后，再发消息给 AI，会自动注入上一次对话的
                // 优化上下文"）：`assist:'off'` 的政策闸门原本只出现在 `runProductionInput` 里，
                // 它挡的是"**产生新包**"，挡不住"**注入已有包**"。于是关档之后，缓存里那份上一轮的包
                // 继续被注入到每一轮装配里 —— 两条成因（缓存没清 / 门禁漏判）**都成立**，两条都要修。
                // 这里是硬短路：读到"不注入"就连缓存都不看。
                const pol = adapter.policyNow ? adapter.policyNow(sid) : null
                // 模型状态（超频）与优化强度**互相独立**：关掉档位只该停掉优化包，
                // 不该顺带把"超频"那段也吞掉（用户 2026-10-26 报的真机现象）。
                const modelStateText = adapter.getModelStateText(sid)
                if (pol && pol.injectPacket !== true) return modelStateText
                // 子代理默认不注入（2026-10-19）：它们的任务是父代理派下来的，再叠一层优化通常只是白花 token。
                if (isSubagentSession(session) && pol && pol.applyToSubagents !== true) return ''
                // 预设提示（2026-10-19）：只在 Wish / PTC 上效果最好；别的预设就记一条，客户端弹一次。
                try {
                  const preset = adapter.presetOf(sid) || (session && session.header && session.header.agentPreset)
                  if (typeof preset === 'string' && preset && preset !== 'wish' && preset !== 'ptc'
                    && !(pol && pol.presetNoticeDismissed === true)) adapter.notePresetNotice(sid, preset)
                  else if (preset === 'wish' || preset === 'ptc') adapter.clearPresetNotice(sid)
                  if (preset) adapter.notePreset(sid, preset)
                } catch { /* 提示是旁路，绝不打断装配 */ }
                // Tool presence alone did not cause a review in the tank test. Keep the working
                // workflow available even when the interpreter has no new intent items.
                this.capability.seed(session)
                const taskContext=this.capability.taskContext(session)
                const feedback = this.reviewFeedback ? this.reviewFeedback(agent, pol, { root: sessionHistory.getCwd(sid), taskContext }) : ''
                return [withAdvisorWorkflow(this.getWorkingText(sid, adapter.lastRealUserMessageBySession.get(sid)), pol, this.getAdvisorText(sid, feedback)), modelStateText].filter(Boolean).join(String.fromCharCode(10,10))
              } catch (e) {
                // ⚠ **不得静默**（EV-0102）：这条路径若抛错，意图包会在**毫无痕迹**的情况下消失——
                // 正是 EV-0078 那一类事故（产品安静地不做事，用户以为它开着）。
                // 上面两个 `return ''` 是**决定**（没有 agent / 闸门未放行）；这里是**意外**，必须留痕。
                // 去重：同一会话同一错误只记一次，避免"每一步一条"把台账淹掉。
                try {
                  const agent = assemblyCtx && assemblyCtx.agent
                  const sid = agent && agent.id !== undefined ? String(agent.id) : '(no-agent)'
                  const msg = String((e && e.message) || e)
                  if (this.contextErrors.get(sid) !== msg) {
                    this.contextErrors.set(sid, msg)
                    appendWireLog({ sessionId: sid, ok: false, trigger: 'context-provider-threw', reason: msg })
                  }
                } catch { /* 连记录都失败就真的只能放弃 */ }
                return ''
              }
            },
          })
        } finally {
          this.markReady()
        }
      })
      return true
    } catch {
      this.markReady()
      return false
    }
  }

  /** 取当前 live agent；找不到返回 null（调用方必须处理 null，不得猜）。 */
  agentFor(sessionId) {
    const agents = this.services.agents
    if (!agents || typeof agents.get !== 'function' || !sessionId) return null
    try { return agents.get(sessionId) || null } catch { return null }
  }

  buildMessage(llm, text, summary) {
    return llm.createUserMessage({
      content: [{ type: 'text', text: String(text) }],
      // ⚠ **不许写回 `kind: 'plugin'`**（宿主 0.1.7 起拒收，见 PRODUCER_KIND 的注释与 ADR-0087）。
      source: {
        kind: PRODUCER_KIND,
        form: 'notice',
        summary: String(summary || '').slice(0, 120),
      },
    })
  }

  /**
   * 不唤醒投递：排入 next-step，不启动生成、不产生模型调用（EV-0020）。0.6 的默认投递方式。
   */
  async deliverNotice(sessionId, text, summary) {
    const agent = this.agentFor(sessionId)
    if (!agent) return { ok: false, reason: 'agent-not-found' }
    if (typeof agent.inject !== 'function') return { ok: false, reason: 'inject-unavailable' }
    try {
      const r = await loadLlmLib()
      if (!r.ok) return { ok: false, reason: r.reason, tried: r.tried }
      const msg = this.buildMessage(r.mod, text, summary)
      agent.inject(msg)
      return { ok: true, messageId: String(msg.id) }
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) }
    }
  }

  /**
   * 唤醒式投递。**调用方必须已在用户授权范围内**（ADR-0012）。
   * 本原型不主动调用；保留接口以便 P4/P6 在授权路径中复用。
   */
  async deliverAndWake(sessionId, text, summary) {
    const agent = this.agentFor(sessionId)
    if (!agent) return { ok: false, reason: 'agent-not-found' }
    if (typeof agent.followup !== 'function') return { ok: false, reason: 'followup-unavailable' }
    try {
      const r = await loadLlmLib()
      if (!r.ok) return { ok: false, reason: r.reason, tried: r.tried }
      const msg = this.buildMessage(r.mod, text, summary)
      agent.followup(msg)
      return { ok: true, messageId: String(msg.id) }
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) }
    }
  }

  dispose() {
    this.optimizationRuns.clear()
    try { if (typeof this.contextDisposer === 'function') this.contextDisposer() } catch { /* best effort */ }
    try { if (typeof this.projectionDisposer === 'function') this.projectionDisposer() } catch { /* best effort */ }
    // 控制 API 的路由也必须在卸载时摘掉：热重载后留着旧路由 = 同一前缀注册两次
    // （宿主路由表会报重复，或旧 handler 继续应答——0.5 的 slot 重复注册是同一类事故）。
    try { if (typeof this.controlApiDisposer === 'function') this.controlApiDisposer() } catch { /* best effort */ }
    this.contextDisposer = null
    this.projectionDisposer = null
    this.controlApiDisposer = null
  }
}

export const adapter = new DshAdapter()

function writeReport(report) {
  // **每一份报告都必须写明自己是哪一份代码写的**。
  // 实测踩到过：注入的是新打包的产物，但被 apply 的是更早缓存的模块实例；
  // 报告里没有这个字段时，"这次验证跑的是哪份代码"只能靠猜——那就不叫证据。
  try { if (!report.moduleUrl) report.moduleUrl = import.meta.url } catch { /* best effort */ }
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(join(EVIDENCE_DIR, 'adapter-' + Date.now() + '.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch { /* best effort */ }
}

export function apply(ctx, config) {
  try {
    ctx.inject(['clientModules'], (scope) => {
      let live = true, retry = null
      scope.effect(() => () => { live = false; if(retry)clearTimeout(retry) })
      // A rebuilt fiber can publish its loader identity just after apply. Retry only while absent.
      const registerClient = (attempt=0) => {
        if (!live) return
        try {
          const cm = scope.clientModules || scope.get('clientModules')
          const name = '@dsh-external/dsh-wish-specializer'
          if (!cm?.pkgMeta || !cm?.dirty || typeof cm.flush !== 'function') return
          for (const key of cm.pkgMeta.keys()) {
            if (key === name || String(key).endsWith('\0' + name)) cm.pkgMeta.delete(key)
          }
          cm.dirty.add(name)
          cm.flush((err) => appendWireLog({ trigger: 'client-registration', ok: false, reason: String(err) }))
          if (typeof cm.rebuilt === 'function') cm.rebuilt(name)
          if(typeof cm.clientPath==='function' && !cm.clientPath(name) && attempt<3)retry=setTimeout(()=>registerClient(attempt+1),250*(attempt+1))
        } catch (err) { appendWireLog({ trigger: 'client-registration', ok: false, reason: String(err) }) }
      }
      queueMicrotask(() => registerClient())
    })
  } catch { /* optional on headless hosts */ }
  pluginConfig = config && typeof config === 'object' ? config : {}
  ctx.effect(() => () => adapter.capability.dispose(), 'dsh-arbiter: capability lifecycle')
  const advisorProgress = createAdvisorProgress({ home: DSH_HOME })
  adapter.english=createEnglishMode({home:DSH_HOME,namespace:PROFILE_DIR})
  ctx.effect(()=>()=>adapter.english.dispose(),'dsh-arbiter: English input mode')
  const inferenceTrace = createInferenceTrace({home:DSH_HOME,namespace:PROFILE_DIR})
  const inferenceEvidence=createInferenceEvidence({home:DSH_HOME,namespace:PROFILE_DIR})
  const inferenceContext=createInferenceEvidenceContext({store:inferenceEvidence,getSession:sid=>{const a=adapter.agentFor(sid);return a?.session||a?.getSession?.()},policy:sid=>readPolicy({home:DSH_HOME,sessionId:sid}),rootFor:resolveSessionCwd})
  let inferenceEngine=null,inferenceReady=false,inferenceProblem=null
// 顾问工具的注册同步函数：设置写盘发生在另一个作用域，通过这个持有者调用（否则调用静默失效）。
let syncAdvisorToolsRef=null
  ctx.effect(()=>()=>{inferenceEngine?.dispose();inferenceTrace.dispose();inferenceContext.dispose()},'dsh-arbiter: reasoning enhancement')
  ctx.inject(['llm'],scope=>{
    let live=true
    scope.effect(()=>()=>{live=false;inferenceReady=false;inferenceEngine?.dispose()},'dsh-arbiter: reasoning model service')
    void (async()=>{
      const loaded=await loadLlmLib({env:process.env,argv1:process.argv[1],cwd:process.cwd()})
      if(!live)return
      if(!loaded.ok || typeof loaded.mod?.isAgentLoopRequest!=='function'){inferenceProblem=loaded.reason || 'working-request-marker-unavailable';return}
      const engine=createInferenceBoost({llm:scope.llm,trace:inferenceTrace,isWorkingRequest:loaded.mod.isAgentLoopRequest,
        evidenceFor:options=>inferenceContext.evidenceFor(options),
        focus:createInferenceFocus({home:DSH_HOME,namespace:PROFILE_DIR}),
        createNotice:(text,summary)=>loaded.mod.createUserMessage({content:[{type:'text',text}],source:{kind:'plugin:@dsh-external/dsh-wish-specializer',form:'notice',summary}}),
        settingsFor:sid=>{const p=readPolicy({home:DSH_HOME,sessionId:sid});return {reasoningBoost:p.reasoningBoost,reasoningMode:p.reasoningMode,reasoningCandidates:p.reasoningCandidates,reasoningRounds:p.reasoningRounds,reasoningPace:p.reasoningPace,englishMode:p.englishMode}},log:appendWireLog})
      inferenceEngine=engine
      scope.effect(()=>scope.on('llm/stream',(options,next)=>engine.intercept(options,next)),'dsh-arbiter: working generation interception')
      scope.effect(()=>()=>engine.dispose(),'dsh-arbiter: inference engine disposal')
      inferenceReady=true
    })().catch(e=>{inferenceProblem=String(e.message)})
  })
  const advisorCoverage = createAdvisorCoverage({ home: DSH_HOME })
  const advisorStages = createAdvisorStages({ home: DSH_HOME })
  const contributionMemory=createContributionMemory({home:DSH_HOME})
  const reviewFeedback=createAdvisorFeedback({stages:advisorStages,coverage:advisorCoverage})
  adapter.reviewFeedback=(agent,policy,context={})=>{
    const session=agent?.session||agent?.getSession?.(),events=session?.snapshotEvents?.()||[],human=events.filter(isRealUserInput).at(-1)
    const note=session&&human?contributionMemory.feedback({sessionId:String(session.id),requestId:'human:'+String(human.seq),root:session.header?.cwd||context.root,enabled:policy?.injectPacket===true&&policy?.readTools===true,englishMode:policy?.englishMode===true,revisionMarker:revisionMarker(events)}):null
    return [reviewFeedback(agent,policy,context),renderContributionFeedback(note,policy?.englishMode===true)].filter(Boolean).join('\n\n')
  }
  ctx.effect(() => () => { adapter.reviewFeedback = null })
  ctx.effect(() => () => advisorProgress.dispose(), 'dsh-po06: advisor progress')
  // 斜杠命令表：只有拿到它，才能确认名单里的命令**当前真的存在**（见 control-api 的 slashReview）。
  // 拿不到就 fail-closed（不拦截）——与改动前行为一致，不会因为我们报错。
  let commandsService = null
  ctx.inject(['commands'], scope => {
    try { commandsService = scope.commands || null } catch { commandsService = null }
    scope.effect(() => () => { commandsService = null }, 'dsh-po06: commands service')
  })
  // agents 也是延迟提供的（见下方 1894 的注释）；这里单独抓一份，供命令表查询兜底。
  let agentsService = null
  ctx.inject(['agents'], scope => {
    try { agentsService = scope.agents || null } catch { agentsService = null }
    scope.effect(() => () => { agentsService = null }, 'dsh-po06: agents service')
  })
  let advisorAttachments = null
  ctx.inject(['attachments'], scope => {
    advisorAttachments = scope.attachments
    scope.effect(() => () => { advisorAttachments = null }, 'dsh-po06: advisor attachment service')
  })
  // Independent advisor: fresh invocation, existing optimizer route, read-only capabilities.
  ctx.inject(['tools', 'llm'], (scope) => {
    const execute = createAdvisor({
      log: appendWireLog, progress: advisorProgress, coverage: advisorCoverage, stages: advisorStages, contributionMemory,
      taskContext: session => adapter.capability.taskContext(session),
      // 默认不设顾问总截止；显式环境变量才设置截止。
      timeoutMs: resolveAdvisorTimeoutMs(process.env),
      // 空闲判死默认 90s（DSH_PO06_ADVISOR_STALL_MS 可调，0 关闭）；折算规则保证它永远早于总熔断。
      stallMs: resolveAdvisorStallMs(process.env, resolveAdvisorTimeoutMs(process.env)),
      resolveRuntime: async (session, signal) => {
        const sid = String(session.id)
        const pol = readPolicy({ home: DSH_HOME, sessionId: sid })
        if (!pol.injectPacket) return { ok: false, reason: 'assist-off' }
        if (pol.advisor === false) return { ok: false, reason: 'advisor-off' }
        // 子代理默认不提供顾问（同一开关）：它们的调用不注入，再请顾问也没有闭环。
        if (isSubagentSession(session) && pol.applyToSubagents !== true) return { ok: false, reason: 'subagent-skip' }
        const gate = await awaitGateDecision(sid)
        if (gate?.enabled !== true) return { ok: false, reason: 'advisor-gate-disabled:' + String(gate?.code || 'pending') }
        await ensureModelRoute(scope, sid)
        const cfg = resolveInterpreterCfg({ config: pol.model ? { interpreter: pol.model } : pluginConfig,
          observed: ownModelFor(sid), effortByModel: pol.effortByModel })
        if (!cfg?.ok) return { ok: false, reason: cfg?.reason || 'no-model-route' }
        const llm = scope.llm || scope.get('llm')
        let imageSupport = null
        try {
          const info = await llm.resolveModelInfo(cfg.provider, cfg.model, signal)
          if (Array.isArray(info?.inputModalities)) imageSupport = info.inputModalities.includes('image')
        } catch { /* Unknown capability is explicitly shown as not inspected. */ }
        return { ok: true, llm, cfg, imageSupport, attachments: advisorAttachments, englishMode: pol.englishMode, capabilities: capabilitiesFor(sid, ctx),
           translateInstruction:async text=>(await adapter.english.translate(text,{llm,cfg,signal,kind:'advisor-instructions',sessionId:sid})).text,
          cwd: resolveSessionCwd(session), readTools: pol.readTools === true }
      },
    })
    // 顾问的 directive 不只是返回值：记进 adapter，随后随注入文进系统上下文（20 分钟 TTL）。
    // 用户 2026-10-18 的要求是"让顾问真正有作用"，这一步把它的分量从工具结果提到上下文层。
    // 台账接线抽到 lib/advisor-session.js（可测；真机两次"没有旧账"就是这段写错 args 下标）
    const executeWithDirective = createAdvisorWrapper({
      ledger: adapter.advisorLedger,
      policyFor: (sid) => readPolicy({ home: DSH_HOME, sessionId: sid }),
    })(execute)

    // 顾问开关是**全局**设置（不在 SESSION_KEYS 里）⇒ 可以在注册层硬关闭。
    // 为什么必须这么做（2026-10-23 用户实测）：原先无条件注册、执行时返回 advisor-off，
    // 模型要先调用一次、被告知关闭、再重新思考——白烧一轮注意力与时间，属于「假关闭」。
    // 现在：关闭 ⇒ 工具根本不出现在模型的可选动作里；开启 ⇒ 重新注册。
    let advisorToolDispose = null, advisorStageDispose = null
    const advisorEnabledNow = () => {
      try { return advisorToolEnabled(readPolicy({ home: DSH_HOME })) } catch { return true }
    }
    const syncAdvisorTools = () => {
      const on = advisorEnabledNow()
      if (on && !advisorToolDispose) {
        advisorToolDispose = registerAdvisorTool(scope, executeWithDirective)
        advisorStageDispose = registerAdvisorStageTool(scope, advisorStages, {
        resolveAccess: async session => {
          const sid=String(session.id); const pol=readPolicy({home:DSH_HOME,sessionId:sid})
          if(!pol.injectPacket)return {ok:false,reason:'assist-off'}
          if(pol.advisor===false)return {ok:false,reason:'advisor-off'}
          const gate=await awaitGateDecision(sid); if(gate?.enabled!==true)return {ok:false,reason:'advisor-gate-disabled'}
          return {ok:true,readTools:pol.readTools===true}
        },
        })
      } else if (!on && advisorToolDispose) {
        try { advisorToolDispose() } catch { /* 已注销 */ }
        try { if (typeof advisorStageDispose === 'function') advisorStageDispose() } catch { /* 同上 */ }
        advisorToolDispose = null; advisorStageDispose = null
      }
    }
    syncAdvisorToolsRef = syncAdvisorTools
    scope.effect(() => {
      syncAdvisorTools()
      return () => {
        execute.dispose()
        try { if (typeof advisorToolDispose === 'function') advisorToolDispose() } catch { /* 已注销 */ }
        try { if (typeof advisorStageDispose === 'function') advisorStageDispose() } catch { /* 同上 */ }
        advisorToolDispose = null; advisorStageDispose = null
        syncAdvisorToolsRef = null
      }
    }, 'dsh-po06: independent advisor tool')
  })
  const report = {
    probe: 'dsh-po06-adapter',
    phase: 'P1-6',
    at: new Date().toISOString(),
    note: '宿主适配层。生产路径：真实用户输入 → 解释 → 编译 → 动态上下文（零延迟，包从第 2 步生效）；自检只在 DSH_PO06_SELFCHECK=1 时运行',
    // **记录真正被加载的是哪一份代码**。这不是装饰：
    //   · 本项目已因"加载路径与依赖路径不一致"吃过一次亏（P0-D2）；
    //   · 实测还遇到过"注入的是打包产物，但注入器复用了更早缓存的模块实例"，
    //     于是跑的根本不是你以为的那份代码。没有这个字段就只能靠猜。
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
    steps: {},
  }

  adapter.advisorLedger = createLedger()
  adapter.services.agents = ctx.get('agents') || null
  adapter.services.sessionController = ctx.get('sessionController') || null
  // 插件自己的按会话状态存储（EV-0081：状态由我们自己拥有，不写会话日志）
  try {
    adapter.stateStore = createStateStore({ home: DSH_HOME })
    report.steps.stateStore = { dir: adapter.stateStore.dir }
  } catch (e) {
    adapter.stateStore = null
    report.steps.stateStore = { ok: false, reason: String((e && e.message) || e) }
  }
  // ⚠ `typeof null === 'object'`：旧诊断把 null 服务报成 "object"，
  // 于是"agents 服务其实一直没接上"这件事**藏在了一份看起来正常的报告里**（EV-0080）。
  // 现在如实区分 null / 缺方法 / 可用。
  const svcDesc = (s, method) => (s == null ? 'null' : (typeof s[method] === 'function' ? 'ok:' + method : 'no-' + method))
  report.steps.services = {
    agents: svcDesc(adapter.services.agents, 'get'),
    sessionController: svcDesc(adapter.services.sessionController, 'prompt'),
  }
  // 服务是**延迟提供**的：apply 时刻 `ctx.get('agents')` 拿不到（实测为 null），
  // 必须用 `ctx.inject` 等它就绪——与 systemPrompt 同一套写法。
  // 不修这一条，闸门永远拿不到 agent ⇒ 永远 `old-plugin-unknown` ⇒ 0.6 永远不启用。
  try {
    ctx.inject(['agents'], (scope) => {
      try {
        if (scope && scope.agents) adapter.services.agents = scope.agents
      } finally { adapter.markReady() }
    })
  } catch { adapter.markReady() }
  // `sessionController` **同样是延迟提供**的：apply 时刻拿不到（实测 headless 与 web 都是 null，
  // 而 web 下 `agents` 已经注入进来了）。此前只在 apply 读一次 ⇒ **永远是 null**，
  // 于是自检里的"会话装配探针"永远跑不到（早先还会因此**抛错**，EV-0131）。
  // 与 agents 同一套写法：就绪后填进 services；宿主不提供时保持 null（**可选能力**，不报错）。
  try {
    ctx.inject(['sessionController'], (scope) => {
      try {
        if (scope && scope.sessionController) adapter.services.sessionController = scope.sessionController
      } catch { /* 保持 null */ }
    })
  } catch { /* 宿主不提供该服务 ⇒ 保持 null；自检会如实记一步"本 profile 不提供" */ }
  // ── 装配期启用闸门（A10/A12）：拦截是否生效由它决定，默认不生效 ──
  adapter.enableGate = createEnableGate({ decide: decideEnableFor })
  report.steps.enableGate = (() => {
    const i = readEnableIntent()
    return {
      configPath: ENABLE_CONFIG_PATH,
      configExists: existsSync(ENABLE_CONFIG_PATH),
      intent: { ok: i.ok, ours: i.ours, reason: i.reason, enabled: i.settings.enabled, rolloutMode: i.rollout.mode },
      note: '未判定期间一律不启用（保守）；判定按 agent 懒触发',
    }
  })()

  report.steps.registerContext = { ok: adapter.registerContext(ctx), name: CONTEXT_NAME, order: CONTEXT_ORDER }
  report.steps.restingTextIsEmpty = adapter.getIntentText() === ''
  // 记录解析出来的 profile：静态探测查的就是这个目录的清单，
  // 写错目录会给出"看着有、其实答错问题"的结论（EV-0081），所以要可复核。
  report.steps.profile = { ...PROFILE_RESOLVED, dir: PROFILE_DIR, exists: existsSync(PROFILE_DIR) }

  // ── 注册意图状态投影（产品路径）────────────────────────────────
  report.steps.registerProjection = (() => {
    try {
      ctx.inject(['sessionProjections'], (scope) => {
        try {
          adapter.services.sessionProjections = scope.sessionProjections
          adapter.projectionDisposer = scope.sessionProjections.register(
            createProjectionDefinition(projectionStats),
          )
        } finally {
          adapter.markProjectionReady()
        }
      })
      return { ok: true, key: PROJECTION_KEY, stateVersion: 1, event: STATE_EVENT }
    } catch (e) {
      adapter.markProjectionReady()
      return { ok: false, reason: String((e && e.message) || e) }
    }
  })()

  // ── 虚拟 POSIX 语义层：注册成**工作 AI 自己的工具**（0.6.11）──────────
  // 用户原话："虚拟POSIX是作用在工作ai上的吧?不然就没什么意义了"。
  // 只接在解释层等于"插件内部另做一套"——必须进工作 AI 的工具清单才算数。
  registerPosixTool(ctx, report)
  // 内置 Bash（0.7.1）：随装配即提供（开关默认开；关掉＝不注册给模型）。
  // 同时记住 ctx，供 /settings 写盘后的差额同步复用。
  try { hostCtxForBashSync = ctx } catch { /* noop */ }
  // 用 ctx.inject 拿**真 scope**（带 tools 与 effect）—— 与 posix 同一条路径。
  // 0.7.2 用的是自造的 `{ tools, effect }`，effect 返回值靠不住 ⇒ 开关关不掉已注册的那份。
  try { ctx.inject(['tools'], (scope) => { bashToolScope = scope; syncBashTool(ctx) }) } catch { /* noop */ }
  try { syncBashTool(ctx) } catch { /* 不应影响本插件的其它能力 */ }

  // ── P9.2 控制 API：把设置/状态/台账/提示词暴露给控制面板 ─────────────
  // 只有带 webServer 的 profile（web）才有这一层；headless 等没有也不该有。
  // 懒注入（与 agents/sessionController 同一套写法）：apply 时刻服务还没提供。
  // 路由前缀 `/po06/api` **不在**宿主的浏览器信任闸门（只覆盖 `/api`）之内，
  // 所以 handler 自己做 Host/Origin/写头判据——理由与实现见 lib/control-api.js 文件头（EV-0139）。
  try {
    ctx.inject(['webServer'], (scope) => {
      if (!scope || !scope.webServer || typeof scope.webServer.register !== 'function') return
      try {
        adapter.controlApiDisposer = registerControlApi({ webServer: scope.webServer }, {
          home: DSH_HOME, version: PKG_VERSION, now: () => Date.now(),
           capabilityStatus: sid => ({...adapter.capability.status(sid),moduleUrl:import.meta.url,pipelineRevision:'single-run-1',features:['transport-retry','tool-result-continuation'],optimization:sid ? (()=>{const run=adapter.optimizationRuns.get(sid);return run?{runId:run.runId,generation:run.generation,status:run.status,packetChars:adapter.optimizationRuns.packet(sid).length}:null})() : null}),
           optimizerStatus: sid => sid ? optimizerRequests.get(String(sid)) || null : null,
          // P11：前置拦截的按需解释（客户端拦下发送后调它；失败即由客户端按原文放行）
          interpret: (p) => runInterceptInput(ctx, p),
          // P11：拦截进度面（"优化中"那几十秒要看得见它在想什么）
          progress: (sid) => progressGet(sid),
          advisorProgress: (sid, identity) => advisorProgress.get(sid, identity),
          advisorDelivery:createAdvisorDeliveryReader({getAgent:sid=>adapter.agentFor(sid),inspect:sid=>adapter.services.sessionController?.inspect?.(sid),policy:sid=>readPolicy({home:DSH_HOME,sessionId:sid}),rootFor:sid=>sessionHistory.getCwd(sid)}),
           inferenceStatus:()=>({...(inferenceEngine?.status() || {protocolVersion:'1',ready:false}),ready:inferenceReady,reason:inferenceProblem,...inferenceTrace.status(),
             client:(()=>{try{const cm=ctx.get('clientModules'),name='@dsh-external/dsh-wish-specializer';return {registered:!!cm?.clientPath?.(name),revision:cm?.graph?.().entries.find(e=>e.id===name)?.rev || null}}catch{return null}})()}),
           englishStatus:sid=>({ready:true,...adapter.english.status(sid)}),
           englishGet:sid=>adapter.english.get(sid),
           inferenceList:sid=>inferenceTrace.list(sid),
           inferenceGet:(sid,run,call,offsets)=>inferenceTrace.get(sid,run,call,offsets),
           inferenceCancel:(sid,run)=>inferenceEngine?.cancel(sid,run) || {ok:false,reason:'not-ready'},
          advisorStageStatus: sid => {
            const pol=sid ? readPolicy({home:DSH_HOME,sessionId:sid}) : null
           // GitHub #32：原先写死 readEnabled:false ⇒ 面板永远显示「顾问只读未开」，与真实设置无关，
            // 排查时据此判断会得到错误结论。现在按本会话真实策略取值；verification 如实标出是否重读了文件。
            const readEnabled=pol?.readTools===true
            const stage=sid ? advisorStages.status({sessionId:String(sid),readEnabled}) : null
            return {ok:true,protocolVersion:2,enabled:pol?.injectPacket===true,readEnabled,stage,verification:readEnabled?'file-reread-enabled':'diagnostic-only-no-file-reread'}
          },
          // P11：读回"这一轮注入的包"（回退后把新正文读回界面）
          getPacket: (p) => adapter.getIntentText(p && p.sessionId),
        // ⚠ 必须**整包转发**：控制面有两种查询（?id= 给对话流卡片、?session= 给输入栏胶囊），
    // 早先这里只取了 p.sessionId ⇒ 按 id 查永远 null ⇒ 对话流里的卡片成了空行（2026-10-19 实测）。
    getInjection: (p) => adapter.getInjection(p),
    // 预设提示（2026-10-19）：GET 读、POST 清（forever 会写进设置）。
    getNotice: (p) => adapter.getPresetNotice(p && p.sessionId),
    // 回车前的预设闸门（2026-10-19）：优先问 sessionController 的会话头，其次用事件里记下的。
    getPreset: (sid) => adapter.presetOf(sid),
    getPresetPending: () => adapter.pendingPreset(),
    clearPresetPending: () => adapter.clearPresetPending(),
    sessionFirstSeen: (sid) => adapter.sessionFirstSeen(sid),
    getPresetAt: (sid) => adapter.presetAtOf(sid),
    // 预设登记表（真机 2026-10-19）：磁盘上的会话头**永远是 ptc**（读 session.v4.jsonl 确认过），
    // 唯一可靠来源是输入区那个按钮当前显示的文案 ⇒ 宿主把"文案 ↔ id"的对照表给客户端。
    getPresets: async () => {
      // 真机（2026-10-19）：ctx.get('agentPresets') 拿到的是插件实例，不带 list()；
      // 服务在 ctx.agentPresets 上，list() 是 async（见 docs/subsystems/core.md）。
      const out = { ok: false, presets: [], debug: {} }
      const now = Date.now()
      if (adapter._presetCache && now - adapter._presetCache.at < 60 * 1000) return adapter._presetCache.value
      try {
        let svc = null
        try { svc = (ctx && ctx.agentPresets) || null } catch (e) { out.debug.injectThrew = String((e && e.message) || e) }
        if (!svc && typeof ctx.get === 'function') {
          try { svc = ctx.get('agentPresets') } catch { svc = null }
        }
        out.debug.hasAgentPresets = !!svc
        if (svc) {
          try {
            const proto = Object.getPrototypeOf(svc) || {}
            out.debug.methods = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor').slice(0, 24)
          } catch { /* 忽略 */ }
        }
        let list = null
        if (svc && typeof svc.list === 'function') list = await svc.list()
        else if (Array.isArray(svc)) list = svc
        else if (svc && svc.definitions) {
          const d = svc.definitions
          list = d instanceof Map ? Array.from(d.values()) : (Array.isArray(d) ? d : Object.values(d))
        }
        out.debug.listType = Array.isArray(list) ? 'array:' + list.length : typeof list
        if (Array.isArray(list)) {
          out.debug.sample = list[0] && typeof list[0] === 'object' ? Object.keys(list[0]).slice(0, 12) : null
          out.presets = list.map((x) => ({
            id: String((x && (x.id || x.presetId || x.agentPreset)) || ''),
            name: String((x && (x.name || x.title || x.label || x.displayName)) || ''),
          })).filter((x) => x.id)
          out.ok = out.presets.length > 0
        }
      } catch (e) { out.debug.threw = String((e && e.message) || e) }
      adapter._presetCache = { at: now, value: out }
      return out
    },
    inspectPreset: async (sid) => {
      // 返回 { preset, debug }：debug 只在 ?debug=1 时透出（真机上"为什么没弹窗"必须能查）。
      // ⚠ 不同版本/不同入口的 inspect 结果形状不一样（header / meta / session.header …），
      //   2026-10-19 真机就是只读了 meta.agentPreset ⇒ 永远 null ⇒ 弹窗永远不出现。
      const out = { preset: null, debug: { inspect: 'ok', candidates: null, keys: null } }
      const sc = adapter.services && adapter.services.sessionController
      if (!sc || typeof sc.inspect !== 'function') { out.debug.inspect = 'no-inspect'; return out }
      let info = null
      try { info = await sc.inspect(sid) } catch (e) {
        out.debug.inspect = 'threw:' + String((e && e.message) || e)
        return out
      }
      const pick = (v) => (typeof v === 'string' && v ? v : null)
      const cands = {
        'info.agentPreset': pick(info && info.agentPreset),
        'info.header.agentPreset': pick(info && info.header && info.header.agentPreset),
        'info.meta.agentPreset': pick(info && info.meta && info.meta.agentPreset),
        'info.session.header.agentPreset': pick(info && info.session && info.session.header && info.session.header.agentPreset),
        'info.session.meta.agentPreset': pick(info && info.session && info.session.meta && info.session.meta.agentPreset),
      }
      out.debug.candidates = cands
      out.debug.keys = info && typeof info === 'object' ? Object.keys(info).slice(0, 24) : null
      // 会话里已经有多少条事件：用来区分"全新会话"与"有历史的老会话"（pending 只该影响前者）
      out.debug.eventCount = (info && Array.isArray(info.events)) ? info.events.length : null
      const hit = Object.keys(cands).find((k) => cands[k])
      if (hit) {
        out.preset = cands[hit]
        out.debug.from = hit
        // ⚠ **不要**回写事件表（2026-10-19 真机）：这里读到的是会话头（创建时的默认值），
        //   一旦回写就会把"用户刚刚切换的预设"覆盖掉，连时间戳都被刷成当前时刻 ⇒
        //   客户端永远看到 ptc、永远判成"没变化"。会话头只作为**兜底**值返回。
      }
      return out
    },
    presetDismissed: () => {
      try {
        const p = adapter.policyNow ? adapter.policyNow('') : null
        return !!(p && p.presetNoticeDismissed === true)
      } catch { return false }
    },
    clearNotice: (sid) => adapter.clearPresetNotice(sid),
    clearNotices: () => adapter.clearAllPresetNotices(),
          // P11：包级回退（宿主侧保存了每会话最近 10 版非空包）
          rollbackPacket: (p) => {
            const r = adapter.rollbackPacket(p && p.sessionId, p && p.runId)
            appendWireLog({ sessionId: String((p && p.sessionId) || ''), trigger: 'packet-rollback', ok: r.ok === true, reason: r.reason || null, chars: r.chars || 0 })
            return r
          },
          // P11：审查态里用户改过的正文 = 本轮注入的包（空串 = 清掉这一轮的包）
          setPacket: async (p) => {
            const sid = String(p?.sessionId || '')
            if (!sid) return { ok: false, reason: 'session-required' }
            if (!p.runId) return { ok: false, reason: 'run-required' }
            const disposition = p.disposition || (p.text ? 'send' : 'cancel')
            if (!['send', 'skip', 'cancel'].includes(disposition)) return { ok: false, reason: 'invalid-disposition' }
            const before = adapter.optimizationRuns.get(sid), acceptedResult = before?.result
            if (disposition === 'send' && before && before.runId !== p.runId) return { ok: false, reason: 'superseded-input' }
            let text = String(p.text || '')
            try {
              if (disposition === 'send' && text !== (before?.result?.packet || '') && before?.policy?.englishMode) {
                const cfg = resolveInterpreterCfg({ config: before.policy.model ? { interpreter: before.policy.model } : pluginConfig, observed: modelFor(sid), effortByModel: before.policy.effortByModel })
                if (!cfg.ok) throw new Error('english-model-unavailable')
                text = (await adapter.english.translate(text, { llm: ctx.get('llm'), cfg, signal: before.controller.signal, kind: 'edited-assistance' })).text
                if (adapter.optimizationRuns.get(sid) !== before || before.controller.signal.aborted || before.result !== acceptedResult) return { ok: false, reason: 'superseded-input' }
              }
              const result = adapter.optimizationRuns.submit(sid, { ...p, text, disposition })
              if (result.ok && disposition !== 'send') {
                adapter.english?.abandon(sid)
                adapter.capability.abandonInput?.(sid, before?.runId)
              }
              appendWireLog({ sessionId: sid, runId: result.runId || p.runId || null, trigger: 'packet-submission', disposition, ok: result.ok, chars: result.chars || 0, reason: result.reason || null })
              return { ...result, runId: result.runId || p.runId || before?.runId || null, packet: result.packet || '', chars: result.chars || 0 }
            } catch (error) { return { ok: false, reason: String(error?.message || error) } }
          },
          /**
           * 诊断用（2026-09-24）：**当前 agent 的工具表里有哪些工具**。
           * 为什么需要它：`ctx.inject` 回调是异步的，而自检报告在 apply 里同步落盘 ⇒
           * 报告里的 `registerPosixTool.ok` 测不准（实测恒 false）。与其让
           * "虚拟 POSIX 到底进没进工作 AI 的工具表"靠猜，不如让它能被问出来。
           */
          listTools: async () => {
            const tools = ctx.get('tools')
            if (!tools || typeof tools.schemas !== 'function') return []
            // 尽量取"当前 agent 作用域"的工具表；拿不到就退回全局（对我们这个工具两者一致）。
            let scope = tools
            try {
              const agents = ctx.get('agents')
              const first = agents && typeof agents.list === 'function' ? (agents.list() || [])[0] : null
              if (first && first.ctx && first.ctx.tools && typeof first.ctx.tools.schemas === 'function') scope = first.ctx.tools
            } catch { /* 拿不到就用全局 */ }
            const rows = scope.schemas()
            return (Array.isArray(rows) ? rows : []).map((r) => (r && r.name) || String(r))
          },
          // 注册现场（成没成/哪条路/失败原因/服务形状）——探针把它一起回出来
          toolState: posixToolState,
          /**
           * 某模型可选的思考档位（0.7.5）——**按需查**，因为宿主只在 resolveModelInfo 里给 reasoning
           * （listModels 会把它剥掉）。查不到如实回空 + 原因，界面显示"该模型未暴露档位"，
           * 而不是硬塞一份共用列表（用户 2026-09-26：不同 AI 的档位划分本来就不一样）。
           */
          /**
           * 当前会话用的模型（0.7.5）。「跟随会话模型」那一档要能配档位，界面就必须知道
           * 会话模型是谁——po06 本来就一直在观测（modelFor），这里只是把它暴露出来。
           */
          sessionModel: async (sid) => {
            const s0 = String(sid || '')
            try { const f = await querySessionSelection(ctx, s0); if (f && f.p) { observeModel(s0, f.p); return f.p } } catch { /* 退回缓存 */ }
            try { return modelFor(s0) || null } catch { return null }
          },
          // 只读诊断口：把采集器**实际看见**的能力原样返回，便于核对“为什么脚手架没提某个工具”
          capabilityProbe: async (sid) => capabilitiesFor(String(sid || ''), ctx),
          workingText: async (sid) => adapter.getWorkingText(String(sid || '')),
          workingTextInfo: async (sid) => { const key = String(sid || ''); const pol = adapter.policyNow(key) || {}; return { hasPacket: !!String(adapter.getIntentText(key) || '').trim(), englishMode: pol.englishMode === true, advisor: pol.advisor !== false, status: adapter.optimizationRuns.get(key)?.status || null } },
          resolveEfforts: async (provider, model) => {
            const llm = ctx.get('llm')
            if (!llm) return { ok: false, reason: 'no-llm-service', efforts: [], defaultEffort: null }
            if (typeof llm.resolveModelInfo !== 'function') return { ok: false, reason: 'no-resolve-model-info', efforts: [], defaultEffort: null }
            try {
              const info = await llm.resolveModelInfo(String(provider), String(model))
              const r = (info && info.reasoning && typeof info.reasoning === 'object') ? info.reasoning : null
              const efforts = (r && Array.isArray(r.efforts))
                ? r.efforts.map((e) => ({ id: String(e && e.id || ''), name: String(e && e.name || e && e.id || ''), ...(e && e.description ? { description: String(e.description) } : {}) })).filter((e) => e.id)
                : []
              return { ok: true, reason: null, efforts, defaultEffort: (r && r.defaultEffort) ? String(r.defaultEffort) : null }
            } catch (e) {
              return { ok: false, reason: 'resolve-threw:' + String((e && e.message) || e), efforts: [], defaultEffort: null }
            }
          },
          listModels: async () => {
            const llm = ctx.get('llm')
            if (!llm) throw new Error('模型服务未就绪')
            const providers = await llm.listProviders()
            const rows = await Promise.all(providers.map(async (p) => {
              // ⚠ 档位（0.7.5）：**不在列表里带**。宿主 listModels 是白名单返回
              // （dsh-llm/index.js:2077-2083 只给 provider/id/name/description/inputModalities），
              // reasoning 会被剥掉；档位要另走 resolveModelInfo（同文件 :2095）。
              // 27 个模型逐个 resolve 太贵 ⇒ 改成界面选中哪个就查哪个（见 resolveEfforts）。
              try { return { models: (await llm.listModels(p.id)).map((m) => ({ provider: p.id, model: m.id, label: p.name + ' / ' + (m.name || m.id) })) } }
              catch (e) { return { models: [], error: p.id + ': ' + String(e.message || e) } }
            }))
            return { models: rows.flatMap((r) => r.models), problems: rows.filter((r) => r.error).map((r) => r.error) }
          },
          /**
           * 设置刚写盘（`POST /settings`）：政策变了，缓存与"已经在路上的包"都必须跟着处理。
           *
           * 三件事，缺一不可（用户 2026-09-22 报障的完整修法）：
           *   ① 政策缓存作废 —— 否则最长 2 秒内注入门禁读到的还是旧档位；
           *   ② 档位变成"不注入"（`assist:'off'`）⇒ **清掉所有会话的包**；
           *      不清的话，"关档 → 再开档"之间那份**上一轮的旧包**会在重新开档时立刻复活并注入；
           *   ③ 启用闸门作废 —— `enabled` / 灰度也在这份配置里，改完必须重判（原来只靠 5 分钟 TTL）。
           */
          onSettingsWritten: () => {
            // ⚠ 必须在 invalidatePolicy() **之前**取：那是写盘前的生效政策，
            //   与写盘后的一比，就知道"包的整体形状"变没变。
            let polBefore = null
            try { polBefore = adapter.policyNow() } catch { polBefore = null }
            adapter.invalidatePolicy()
            try { if (syncAdvisorToolsRef) syncAdvisorToolsRef() } catch { /* 注册同步失败不影响写盘 */ }
            inferenceEngine?.settingsChanged()
            adapter.english?.settingsChanged(sid=>readPolicy({home:DSH_HOME,sessionId:sid}).englishMode)
            let pol = null
            try { pol = adapter.policyNow() } catch { pol = null }
            const cleared = (pol && pol.injectPacket !== true) ? adapter.clearIntentTexts('settings:assist-off') : 0
            // 档位或语言变化使旧包失效；下一次拦截使用新的设置快照。
            const shapeChanged = packetShapeChanged(polBefore, pol)
            const clearedShape = shapeChanged ? adapter.clearIntentTexts('settings:packet-shape-changed') : 0
            // 内置 Bash 的开关在同一份配置里：写盘后立刻按差额同步（关掉即从模型视野消失，
            // 不需要重启、也不需要重载插件）。
            let bashSync = null
            try { bashSync = syncBashTool(hostCtxForBashSync) } catch (e) { bashSync = { ok: false, reason: String((e && e.message) || e) } }
            try { if (adapter.enableGate && typeof adapter.enableGate.invalidateAll === 'function') adapter.enableGate.invalidateAll() } catch { /* best effort */ }
            return { injectPacket: Boolean(pol && pol.injectPacket), cleared, clearedShape, shapeChanged, bashSync }
          },
          /**
           * 闸门结论的**分布**（诊断用，见 control-api `/status.gate`）。
           * 为什么需要：`/status.enabled` 报的是**配置意图**，而用户真正遇到的是**闸门放行与否**
           * （`gate:rollout-off` / `settings-disabled` / `DOUBLE_INTERCEPT` / `decision-pending`）。
           * 这两个不是一个东西 —— 不区分就会出现"界面写着已启用，插件什么都不做"。
           */
          /**
           * 名单里的命令**当前是否已注册**（供 /status.slashReview.active）。
           * 三种失败都 fail-closed：命令表没就绪 / 会话未知 / 查询抛错 ⇒ 返回空名单 ⇒ 客户端不拦截。
           */
          registeredCommands: (sessionId) => {
            const diag = { agents: 'unknown', liveAgents: null, via: null }
            try {
              const cmds = commandsService
              if (!cmds || typeof cmds.list !== 'function') return { ok: false, reason: 'commands-service-unavailable', names: [], diagnostics: diag }
              const sid = String(sessionId || '')
              const reg = agentsService || adapter.services.agents || null
              diag.agents = reg == null ? 'null' : (typeof reg.get === 'function' ? 'ok:get' : 'no-get')
              // 三层查找：本会话 agent → 任意 live agent（全局命令在每个 agent 的视图里都有）→ 放弃。
              let agent = sid ? adapter.agentFor(sid) : null
              if (agent) diag.via = 'session'
              if (!agent && reg && typeof reg.list === 'function') {
                let all = []
                try { all = reg.list() || [] } catch { all = [] }
                diag.liveAgents = all.length
                if (all.length) { agent = all[0]; diag.via = 'any-live-agent' }
              }
              if (!agent) {
                try {
                  const all = reg && typeof reg.list === 'function' ? (reg.list() || []) : null
                  if (Array.isArray(all)) diag.liveAgents = all.length
                } catch { /* 诊断失败不影响结论 */ }
                return { ok: false, reason: diag.agents === 'null' ? 'agents-service-unavailable' : 'no-live-agent', names: [], diagnostics: diag }
              }
              const rows = cmds.list(agent) || []
              return { ok: true, names: rows.map(r => String((r && r.name) || '').toLowerCase()).filter(Boolean), diagnostics: diag }
            } catch (e) {
              return { ok: false, reason: 'commands-list-threw:' + String((e && e.message) || e), names: [], diagnostics: diag }
            }
          },
          gateSummary: () => {
            try {
              const snap = (adapter.enableGate && typeof adapter.enableGate.snapshot === 'function') ? adapter.enableGate.snapshot() : {}
              const codes = {}
              let enabled = 0, disabled = 0, pending = 0
              for (const v of Object.values(snap)) {
                if (!v) continue
                if (v.status !== 'done') { pending += 1; continue }
                if (v.enabled === true) { enabled += 1; continue }
                disabled += 1
                const c = String(v.code || 'unknown')
                codes[c] = (codes[c] || 0) + 1
              }
              return { sessions: Object.keys(snap).length, enabled, disabled, pending, codes }
            } catch { return null }
          },
        })
      } catch (e) {
        appendWireLog({ trigger: 'control-api', ok: false, reason: 'register-failed:' + String((e && e.message) || e) })
      }
    })
    report.steps.controlApi = { ok: true, prefix: '/po06/api', note: '懒注入 webServer；无该服务的 profile 自动跳过' }
  } catch (e) {
    report.steps.controlApi = { ok: false, reason: String((e && e.message) || e) }
  }

  // ── 交付门触发（默认关闭；见 GATE_TRIGGER_FLAG）────────────────
  try {
    const off = ctx.on('session/event', (session, event) => {
      // 诊断（2026-10-22）：确认事件是否真的到达本进程、由哪个实例接收。
      // 真机症状：确认提交后没有 user/message 事件 ⇒ 卡片无从挂载。
      try {
        if (event && (event.type === 'user/message' || event.type === 'assistant/message')) {
          appendWireLog({ sessionId: String((session && session.id) || ''), trigger: 'session-event', ok: true,
            eventType: event.type, pid: process.pid, kind: (event.data && event.data.source && event.data.source.kind) || null })
        }
      } catch { /* 诊断失败绝不影响主流程 */ }
      try {
        if (!event || event.type !== 'deliverables/presented') return
        if (!existsSync(GATE_TRIGGER_FLAG)) return          // 未显式开启 → 不做任何事
        const files = Array.isArray(event.data && event.data.files) ? event.data.files : []
        for (const f of files) {
          const p = f && typeof f.path === 'string' ? f.path : null
          if (!p || !/\.html?$/i.test(p)) continue          // 只对本验证器的适用范围生效
          void runGateFor(session, p).catch(() => {})
        }
      } catch { /* 交付门是旁路，绝不打断会话 */ }
    })
    ctx.effect(() => () => { try { if (typeof off === 'function') off() } catch { /* best effort */ } }, 'dsh-po06: delivery gate trigger')
  } catch { /* 注册失败不影响插件本体 */ }

  // ── 会话观测：消费已提交结果，记录本次注入卡片 ─────────────────────
  // 这是 EV-0078 缺失的那一环：此前没有任何**生产**代码路径会调用 handleInput，
  // 于是整条链在真实会话里不可达（346 项测试全绿而产品贡献 0 字符）。
  report.steps.productionTrigger = (() => {
    try {
      const off = ctx.on('session/event', (session, event) => {
        try {
          const sid = session && session.id !== undefined ? String(session.id) : ''
          // 子代理默认不解释（2026-10-19）：父代理派下来的任务再来一轮「解释 → 注入」通常只是白花 token。
          // 判定用会话头（宿主写的字段），并在同一个位置短路，避免它的 user/message 还去触发一次解释。
          // 预设切换（2026-10-19）：会话头的 agentPreset 是**创建时**写死的；中途切预设只会发事件。
          // 只读会话头会漏掉"切了但没重建会话"的情况 ⇒ 这里把最新选择记下来。
          if (sid && isSubagentSession(session)) {
            let sub = null
            try { sub = readPolicy({ home: DSH_HOME, sessionId: sid }) } catch { sub = null }
            if (!sub || sub.applyToSubagents !== true) return
          }
          // 预设切换（2026-10-19）：会话头的 agentPreset 是**创建时**写死的；中途切预设只会发事件。
          // ⚠ 即使事件还没带会话 id（"先拨预设、后开会话"）也要记：那是用户最后一次明确选择。
          if (event && event.type === 'agent-preset/selected' && event.data && typeof event.data.agentPreset === 'string') {
            if (sid) adapter.notePreset(sid, event.data.agentPreset)
            adapter.notePresetPending(event.data.agentPreset, sid)
            adapter.tracePresetEvent(sid, event.data.agentPreset)
          }
          const submitted = isRealUserInput(event) ? adapter.optimizationRuns.consume(sid, extractUserText(event)) : null
          if (submitted) adapter.optimizationRuns.apply(sid, extractMessageId(event), event.seq)
          if (isRealUserInput(event)) adapter.lastRealUserMessageBySession.set(sid, String(extractMessageId(event) || ''))
          if (event && event.type === 'turn/end') adapter.optimizationRuns.clearApplied(sid)
          inferenceContext.observe(session,event)
          // ── P10 步骤 2：先喂上下文累加器（**只观测，不做任何判定**）──────────
          // 放在最前面：`extractObservedModel` 命中时会 `return`，那个时候
          // `request/header`/`request/context` 事件里的正文我们也一样要收。
          // 顺序无关紧要（这些事件不是回合边界），但"先收后判"省得日后加事件类型时漏收。
          try {
            if (sid) {
              if(isRealUserInput(event)){adapter.english?.bind(sid,extractMessageId(event),extractUserText(event));void adapter.refreshSessionPreset(sid)}
               if (submitted) adapter.capability.bindSubmitted(sid, submitted.runId, extractMessageId(event), event.seq)
               const changed=adapter.capability.observe(session,event)
              if (changed === 'new-input' && !submitted) adapter.optimizationRuns.cancel(sid)
              sessionHistory.observe(sid, event)
            }
            if (sid) {
              const cwd = resolveSessionCwd(session)
              if (cwd) sessionHistory.setCwd(sid, cwd)
            }
          } catch { /* 观测是旁路，绝不打断会话 */ }
          // 先观测宿主自己的模型（解释层默认用它）
          const obs = extractObservedModel(event)
          if (obs) {
            observeModel(sid, obs)
            // Observation does not start production.
            return
          }
          if (!isRealUserInput(event)) return
          const text = extractUserText(event)
          // Only an explicit pre-send commit can produce an injection card.
          if (submitted) {
            // 「本次注入」：正文进**插件自己的内存**（客户端用 /po06/api/injection 取），
            // 对话流里的那张卡则用**宿主已知的事件类型**（command/run + command/done）作锚。
            //
            // ⚠ 2026-10-19 事故（P0）：早先这里 append 的是自定义类型 po06/injection。宿主读取器
            // 对未知类型是 fail-closed（信封没有 ignorable: true 就拒绝解释整条会话），而
            // Session.append() 无法设置该标记 ⇒ 重启后会话打不开。
            // **只能写宿主已注册的类型**；命令事件就是宿主自己的行类型（/vmake 那种卡就是这么来的），
            // 客户端再用 conversation.chat.commandview 按命令名注册自己的卡片视图。
            try {
              const working = submitted.packet
              if (working.trim() && typeof adapter.noteInjection === 'function') {
                const anchorSeq = Number(event.seq)
                const id = adapter.noteInjection(sid, {
                  anchorSeq,
                  chars: working.length,
                  // 不截断（用户 2026-10-19）：卡片要能看到**完整**注入文，不再只给前 4000 字。
                  injected: working,
                  truncated: false,
                  at: Date.now(),
                })
                if (id) {
                  const commandId = 'po06-inject-' + id
                  // 必须延后一抽：本回调运行在 user/message 的 append 边界内，同步 append 会 reenter 失败。
                  setTimeout(() => {
                    try {
                      session.append('command/run', {
                        commandId, name: 'po06-inject', args: JSON.stringify({ id }), source: { kind: 'user' },
                      })
                      session.append('command/done', { commandId, kind: 'success' })
                      appendWireLog({ sessionId: sid, trigger: 'inject-card', ok: true, chars: working.length, anchorSeq, id })
                    } catch (e) {
                      // 写不进去 ⇒ 退回"没有卡片"（胶囊仍在），不重试、不打断会话
                      appendWireLog({ sessionId: sid, trigger: 'inject-card', ok: false, reason: String((e && e.message) || e) })
                    }
                  }, 0)
                } else {
                  appendWireLog({ sessionId: sid, trigger: 'inject-card', ok: false, reason: 'no-record' })
                }
              }
            } catch { /* 记录是旁路，绝不打断会话 */ }
            appendWireLog({ sessionId: sid, runId: submitted.runId, trigger: 'user-message', ok: true, skipped: submitted.skip ? 'explicit-skip' : 'prepared-submission', chars: text.length })
            return
          }
          // Unintercepted input is observed only; never optimize after it was sent.
          appendWireLog({ sessionId: sid, trigger: 'user-message', ok: true, skipped: 'not-intercepted', chars: text.length })
        } catch { /* 生产触发是旁路，绝不打断会话 */ }
      })
      ctx.effect(() => () => { try { if (typeof off === 'function') off() } catch { /* best effort */ } }, 'dsh-po06: production input trigger')
      return {
        ok: true,
        hook: 'session/event → user/message(source.kind=user)',
        awaited: false,
        log: WIRE_LOG_PATH,
        note: '只观测并消费前置运行的提交；不在消息发送后启动优化',
      }
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) }
    }
  })()

  ctx.effect(() => () => adapter.dispose(), 'dsh-po06: adapter dispose')

  if (!SELF_CHECK) {
    // A15：生产触发**注册成功**也是 ok 的必要条件——否则又回到"注册了上下文但没人喂它"
    report.ok = report.steps.registerContext.ok === true
      && report.steps.restingTextIsEmpty === true
      && report.steps.productionTrigger.ok === true
    report.verdict = report.ok
      ? 'ACTIVE: 已注册且**生产触发已接线**（真实用户输入会被解释并编译成意图包；零延迟，包从第 2 步起生效）'
      : 'DEGRADED: 注册成功但生产触发未接线 ⇒ **不会做任何事**（见 steps.productionTrigger）'
    writeReport(report)
    if (P8_CHECK) runP8Check(ctx)
    if (P8B_CHECK) runP8bCheck(ctx)
    if (E001_CHECK) runE001Check(ctx)
    // P7 冒烟：**唯一会花模型钱的路径**。flag 与 spec 必须同时存在。
    if (SMOKE_CHECK) {
      void (async () => {
        try {
          if (!existsSync(SMOKE_SPEC)) {
            writeReport({ probe: 'po06-smoke', ok: false, error: 'spec-missing', specPath: SMOKE_SPEC,
              verdict: 'CHECK: flag 存在但 spec 文件缺失，未调用任何模型' })
            return
          }
          const { runSmoke } = await import('./eval-smoke.js')
          await runSmoke({ ctx, specPath: SMOKE_SPEC, reportDir: EVIDENCE_DIR })
        } catch (e) {
          writeReport({ probe: 'po06-smoke', ok: false, error: String((e && e.message) || e),
            verdict: 'ERROR: 冒烟运行器异常' })
        }
      })()
    }
    if (P6_CHECK) runP6Check(ctx)
    if (P3_CHECK) runP3Check(ctx)
    if (P2_CHECK) runP2Check(ctx)
    return
  }

  void (async () => {
    let testSessionId = null
    try {
      report.steps.injectReady = { ready: await adapter.waitReady(3000) }

      const sc = adapter.services.sessionController
      const agents = adapter.services.agents
      if (!sc || !agents) {
        // 这两个服务是**可选/懒提供**的：某些 profile（实测 headless）在 apply 时刻**不提供**它们。
        // 自检**不得因此抛错**（EV-0131）：抛出去整份报告就只剩一个 TypeError，而
        // 前面几步——状态存储 / 启用闸门 / 动态上下文注册 / 静默待命 / 生产触发接线 / 注入就绪
        // ——其实**都过了**，那才是这份自检的价值。**失败要可归因，不要只剩堆栈。**
        report.steps.sessionProbe = {
          ok: false,
          reason: 'services-unavailable-in-this-profile',
          sessionController: sc ? 'present' : 'null',
          agents: agents ? 'present' : 'null',
          note: '本 profile 在 apply 时刻没有提供这两个服务 ⇒ 会话装配探针跳过。'
            + '**这不是产品缺陷**：生产路径不依赖 apply 时刻的这两个服务。'
            + '真实会话投递链路的证据在 EV-0080/0081/0085（真机跑过）；要跑这条探针请用提供它们的 profile（web）。',
        }
        report.ok = true
        report.verdict = 'PARTIAL: 前置步骤全部通过；会话装配探针因本 profile 不提供服务而跳过'
        return
      }
      testSessionId = 'session-po06-adapter-selfcheck-' + Date.now().toString(36)
      report.testSessionId = testSessionId
      await sc.create({ sessionId: testSessionId, cwd: join(SCRATCH_DIR, 'test-workspace') })
      const target = agents.get(testSessionId)
      if (!target) throw new Error('自检会话创建后取不到 agent')

      const sp = adapter.services.systemPrompt
      const M1 = '【意图包 · 自检 A】只读装配验证，不进入任何真实会话。'
      const M2 = '【意图包 · 自检 B】文本已变，验证动态求值。'

      // 只在**自检会话**的作用域里做只读装配；不产生消息投递
      adapter.setIntentText(M1)
      const a1 = await sp.assemble({ agent: target, scope: target })
      const c1 = a1.contexts.find((c) => c.name === CONTEXT_NAME)
      report.steps.assembleA = {
        minePresent: Boolean(c1),
        mineChars: c1 ? String(c1.text).length : 0,
        mineIndex: a1.contexts.findIndex((c) => c.name === CONTEXT_NAME),
        contextCount: a1.contexts.length,
        names: a1.contexts.map((c) => c.name),
      }

      adapter.setIntentText(M2)
      const a2 = await sp.assemble({ agent: target, scope: target })
      const c2 = a2.contexts.find((c) => c.name === CONTEXT_NAME)
      report.steps.assembleB = {
        minePresent: Boolean(c2),
        changed: Boolean(c2) && String(c2.text).includes('自检 B'),
      }

      // 立刻复位为静默——不让自检文本有任何机会进入别的会话
      adapter.setIntentText('')
      const a3 = await sp.assemble({ agent: target, scope: target })
      report.steps.resetToSilent = {
        minePresent: a3.contexts.some((c) => c.name === CONTEXT_NAME),
        mineChars: (() => {
          const c = a3.contexts.find((x) => x.name === CONTEXT_NAME)
          return c ? String(c.text).length : 0
        })(),
      }

      // 投递验证（不唤醒）：消息应留在队列，且不产生 turn/start
      const events = []
      const off = ctx.on('session/event', (s, e) => {
        try { if (s && String(s.id) === testSessionId) events.push(e.type) } catch { /* best effort */ }
      })
      const d = await adapter.deliverNotice(testSessionId, '【自检投递】不应唤醒。', 'P1-6 selfcheck')
      await new Promise((r) => setTimeout(r, 1200))
      report.steps.deliverNotice = {
        result: d,
        queued: target.inbox.nextStep.some((m) => String(m.id) === String(d.messageId)),
        turnStarted: events.filter((t) => t === 'turn/start').length,
        status: target.status,
      }
      try { off() } catch { /* best effort */ }
      if (d.ok) { try { target.inbox.remove(d.messageId) } catch { /* best effort */ } }
      try { target.cancel('po06-selfcheck-cleanup') } catch { /* best effort */ }

      report.ok = report.steps.assembleA.minePresent === true
        && report.steps.assembleB.changed === true
        && report.steps.resetToSilent.mineChars === 0
        && report.steps.deliverNotice.queued === true
        && report.steps.deliverNotice.turnStarted === 0
      report.verdict = report.ok
        ? 'PASS: 上下文注册+动态求值+静默复位+不唤醒投递 全部成立'
        : 'CHECK: 见各步骤字段'
    } catch (e) {
      report.error = String((e && e.stack) || e)
      report.verdict = 'ERROR: ' + String((e && e.message) || e)
    } finally {
      adapter.setIntentText('')
      writeReport(report)
    }
  })()
}

/** P2 自检：投影接线 / 完整状态事件 / CAS 拒绝 / apply 调用量实测。 */function runP2Check(ctx) {
  const report = {
    probe: 'dsh-po06-p2check',
    phase: 'P2',
    at: new Date().toISOString(),
    note: '投影接线 + CAS + 调用量；只在自己建的测试会话上操作',
    steps: {},
  }
  const baseline = { ...projectionStats, sessionsSeen: projectionStats.sessionsSeen.size }

  void (async () => {
    try {
      report.steps.projectionReady = { ready: await adapter.waitProjectionReady(3000) }
      const sc = adapter.services.sessionController
      const agents = adapter.services.agents
      const sessionId = 'session-po06-p2-proj-' + Date.now().toString(36)
      report.testSessionId = sessionId
      await sc.create({ sessionId, cwd: join(SCRATCH_DIR, 'test-workspace') })
      const agent = agents.get(sessionId)
      if (!agent) throw new Error('测试会话创建后取不到 agent')
      const session = agent.session

      // 1) 尚无状态
      report.steps.beforeInit = { state: adapter.intentStateOf(session) }

      // 2) 初始化（经 reducer 权威路径）
      const init = adapter.initIntent(session, { taskId: 'p2check' })
      report.steps.init = { ok: init.ok, code: init.code || null, revision: init.state ? init.state.revision : null }
      report.steps.afterInit = (() => {
        const s = adapter.intentStateOf(session)
        return s ? { revision: s.revision, phase: s.phase, items: s.items.length } : s
      })()

      // 3) 正常提交：人类来源需求
      const cur = adapter.intentStateOf(session)
      const addHuman = adapter.commit(session, {
        causeId: 'c-add-human',
        baseRevision: cur.revision,
        baseInputRevision: cur.lastInputRevision,
        sessionId,
        ops: [{
          op: 'add_item',
          item: {
            id: 'req-1', kind: 'user_requirement', text: '单 HTML、可预览可操控',
            sourceRefs: [{ kind: 'human', sessionId, messageId: 'm1' }],
          },
        }],
      })
      report.steps.addHuman = { ok: addHuman.ok, code: addHuman.code || null }
      report.steps.afterAddHuman = (() => {
        const s = adapter.intentStateOf(session)
        return s ? { revision: s.revision, items: s.items.map((i) => ({ id: i.id, kind: i.kind, status: i.status })) } : s
      })()

      // 4) CAS：用**过期的 baseRevision** 再提交一次（模拟晚到的优化结果）
      const stale = adapter.commit(session, {
        causeId: 'c-stale',
        baseRevision: 0,   // 已过期
        sessionId,
        ops: [{ op: 'set_phase', phase: 'interpreting' }],
      })
      report.steps.staleRejected = { ok: stale.ok, code: stale.code || null, reason: String(stale.reason || '').slice(0, 120) }
      report.steps.afterStale = (() => {
        const s = adapter.intentStateOf(session)
        return s ? { revision: s.revision, phase: s.phase } : s
      })()

      // 5) 用户改口：输入闸门
      const before = adapter.intentStateOf(session)
      const ui = adapter.commitUserInput(session, { messageId: 'm-user-2' })
      report.steps.userInput = { ok: ui.ok, revision: ui.state ? ui.state.revision : null, lastInputRevision: ui.state ? ui.state.lastInputRevision : null }
      const inFlight = adapter.commit(session, {
        causeId: 'c-inflight',
        baseRevision: before.revision,          // 与旧 revision 对齐，专测输入闸门
        baseInputRevision: before.lastInputRevision,
        sessionId,
        ops: [{ op: 'set_phase', phase: 'ready' }],
      })
      report.steps.inFlightRejected = { ok: inFlight.ok, code: inFlight.code || null, reason: String(inFlight.reason || '').slice(0, 120) }

      // 6) 身份闸门（宿主路径）：模型来源不得建 user_requirement
      const cur2 = adapter.intentStateOf(session)
      const badIdentity = adapter.commit(session, {
        causeId: 'c-bad-identity',
        baseRevision: cur2.revision,
        baseInputRevision: cur2.lastInputRevision,
        sessionId,
        ops: [{
          op: 'add_item',
          item: { id: 'req-bad', kind: 'user_requirement', text: '必须离线', sourceRefs: [{ kind: 'model', sessionId }] },
        }],
      })
      report.steps.identityRejected = { ok: badIdentity.ok, code: badIdentity.code || null }

      // 7) 客户端视图（wire）
      try {
        const snap = adapter.services.sessionProjections.snapshot(session)
        report.steps.wireView = snap && snap.values ? snap.values[PROJECTION_KEY] : null
      } catch (e) { report.steps.wireView = 'error: ' + String((e && e.message) || e) }

      // 8) apply 调用量：本会话操作期间的增量
      report.steps.applyStats = {
        baseline,
        now: { ...projectionStats, sessionsSeen: projectionStats.sessionsSeen.size },
        delta: {
          applyCalls: projectionStats.applyCalls - baseline.applyCalls,
          shortCircuits: projectionStats.shortCircuits - baseline.shortCircuits,
          adopted: projectionStats.adopted - baseline.adopted,
          rejected: projectionStats.rejected - baseline.rejected,
        },
        shortCircuitRatio: (projectionStats.applyCalls - baseline.applyCalls) > 0
          ? Math.round(((projectionStats.shortCircuits - baseline.shortCircuits) / (projectionStats.applyCalls - baseline.applyCalls)) * 1000) / 1000
          : null,
      }

      // 9) 恢复验证：checkpoint → restore() 重建
      const sp = adapter.services.sessionProjections
      let cp = null
      try { cp = sp.checkpoint(session) } catch (e) { report.steps.checkpointError = String((e && e.message) || e) }
      report.steps.checkpointRow = cp && cp[PROJECTION_KEY]
        ? { ver: cp[PROJECTION_KEY].ver, seq: cp[PROJECTION_KEY].seq, revision: cp[PROJECTION_KEY].val && cp[PROJECTION_KEY].val.revision }
        : null

      // 9b) 落盘：等待投影缓存写入后，检查磁盘上确实有本键
      await new Promise((r) => setTimeout(r, 1500))
      report.steps.persistedCache = await (async () => {
        try {
          const fsMod = await import('node:fs')
          const file = join(DSH_HOME, 'storages', 'session_projcache', 'sessions', sessionId + '.json')
          if (!fsMod.existsSync(file)) return { file, exists: false }
          const raw = fsMod.readFileSync(file, 'utf8')
          const j = JSON.parse(raw)
          const rows = (j && j.record && j.record.rows) || {}
          const row = rows[PROJECTION_KEY]
          return {
            file, exists: true, size: raw.length,
            hasOurKey: Boolean(row),
            row: row ? { ver: row.ver, seq: row.seq, revision: row.val && row.val.revision } : null,
          }
        } catch (e) { return { error: String((e && e.message) || e) } }
      })()

      // 9c) restore()：用 checkpoint + 全部事件冷读重建，断言与在线状态一致
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      report.steps.eventCount = Array.isArray(events) ? events.length : 'not-array:' + typeof events
      // 9c-1) 全量 checkpoint（与宿主真实启动路径一致：所有注册单元一起恢复）
      // 注意：restore() 返回的 snapshot.values 是 **wire 视图**；完整状态在 out.checkpoint[key].val。
      try {
        const out = sp.restore(cp, events, 0, session.header, session.inheritedEventCount)
        const view = out && out.snapshot && out.snapshot.values ? out.snapshot.values[PROJECTION_KEY] : undefined
        const restoredState = out && out.checkpoint && out.checkpoint[PROJECTION_KEY]
          ? out.checkpoint[PROJECTION_KEY].val : undefined
        const live = adapter.intentStateOf(session)
        report.steps.restore = {
          mode: 'full-checkpoint',
          asOfSeq: out && out.snapshot ? out.snapshot.asOfSeq : null,
          wireView: view || null,
          restoredStatePresent: Boolean(restoredState),
          restoredRevision: restoredState ? restoredState.revision : null,
          liveRevision: live ? live.revision : null,
          revisionsMatch: Boolean(restoredState && live && restoredState.revision === live.revision),
          itemsMatch: Boolean(restoredState && live
            && JSON.stringify(restoredState.items) === JSON.stringify(live.items)),
          restoredItems: restoredState ? restoredState.items.map((i) => ({ id: i.id, kind: i.kind, status: i.status })) : null,
          liveItems: live ? live.items.map((i) => ({ id: i.id, kind: i.kind, status: i.status })) : null,
          refreshedRowKeys: out && out.checkpoint ? Object.keys(out.checkpoint).length : null,
        }
      } catch (e) {
        report.steps.restore = {
          mode: 'full-checkpoint',
          error: String((e && e.message) || e),
          stack: String((e && e.stack) || '').split('\n').slice(0, 6).join(' | ').slice(0, 600),
        }
      }
      // 9c-2) 只带本单元的 checkpoint（隔离"其它单元在折叠我的事件时抛错"这一可能原因）
      try {
        const only = {}
        if (cp && cp[PROJECTION_KEY]) only[PROJECTION_KEY] = cp[PROJECTION_KEY]
        const out2 = sp.restore(only, events, 0, session.header, session.inheritedEventCount)
        const st2 = out2 && out2.checkpoint && out2.checkpoint[PROJECTION_KEY]
          ? out2.checkpoint[PROJECTION_KEY].val : undefined
        const live = adapter.intentStateOf(session)
        report.steps.restoreOnlyMine = {
          restoredStatePresent: Boolean(st2),
          restoredRevision: st2 ? st2.revision : null,
          liveRevision: live ? live.revision : null,
          revisionsMatch: Boolean(st2 && live && st2.revision === live.revision),
          itemsMatch: Boolean(st2 && live && JSON.stringify(st2.items) === JSON.stringify(live.items)),
          restoredItems: st2 ? st2.items.map((i) => ({ id: i.id, kind: i.kind, status: i.status })) : null,
        }
      } catch (e) {
        report.steps.restoreOnlyMine = {
          error: String((e && e.message) || e),
          stack: String((e && e.stack) || '').split('\n').slice(0, 6).join(' | ').slice(0, 600),
        }
      }

      // 10) 卸载后不可读
      try { adapter.projectionDisposer() } catch { /* best effort */ }
      adapter.projectionDisposer = null
      report.steps.afterDispose = { stateOfIsUndefined: adapter.intentStateOf(session) === undefined }

      report.ok = report.steps.init.ok === true
        && report.steps.addHuman.ok === true
        && report.steps.staleRejected.ok === false
        && report.steps.inFlightRejected.ok === false
        && report.steps.identityRejected.ok === false
        && report.steps.identityRejected.code === 'UNAUTHORIZED_KIND'
        && Boolean(report.steps.restoreOnlyMine && report.steps.restoreOnlyMine.revisionsMatch === true)
        && report.steps.afterDispose.stateOfIsUndefined === true
      report.verdict = report.ok
        ? 'PASS: 投影接线 + 三闸门 + checkpoint/restore 一致性 + 卸载即净'
        : 'CHECK: 见各步骤字段'
    } catch (e) {
      report.error = String((e && e.stack) || e)
      report.verdict = 'ERROR: ' + String((e && e.message) || e)
    } finally {
      writeReport(report)
    }
  })()
}

/** P3 自检：把流水线接进**真实宿主**（状态走真实投影，意图包走真实 systemPrompt.context）。 */
function runP3Check(ctx) {
  const TANK = '不要预览文件夹内的其他文件,制作一个单html程序,要求是极其精细的现代主战坦克模型,可以预览,操控,真实,帅气,炫技写真.'
  const report = {
    probe: 'dsh-po06-p3check',
    phase: 'P3',
    at: new Date().toISOString(),
    note: '真实宿主路径 + 桩解释器（不调用模型）；只在自己建的测试会话上操作',
    steps: {},
  }
  void (async () => {
    try {
      await adapter.waitProjectionReady(3000)
      await adapter.waitReady(3000)
      const sc = adapter.services.sessionController
      const agents = adapter.services.agents
      const sessionId = 'session-po06-p3-intent-' + Date.now().toString(36)
      report.testSessionId = sessionId
      await sc.create({ sessionId, cwd: join(SCRATCH_DIR, 'test-workspace') })
      const agent = agents.get(sessionId)
      if (!agent) throw new Error('测试会话创建后取不到 agent')
      const session = agent.session

      // 桩解释器：严格按契约输出（逐字引文来自真实原话）
      const stub = async () => JSON.stringify({
        ops: [
          { op: 'add_item', item: { id: 'req-1', kind: 'user_requirement', text: '单 HTML 程序', quote: '制作一个单html程序', sourceRefs: [{ kind: 'human', sessionId, messageId: 'm-1' }] } },
          { op: 'add_item', item: { id: 'req-2', kind: 'user_requirement', text: '不要预览文件夹内的其他文件', quote: '不要预览文件夹内的其他文件', sourceRefs: [{ kind: 'human', sessionId, messageId: 'm-1' }] } },
          { op: 'add_item', item: { id: 'qi-1', kind: 'quality_interpretation', text: '整体比例协调、结构可信', rationale: '来自原话的“真实、帅气”', sourceRefs: [{ kind: 'model', sessionId }] } },
        ],
      })

      const out = await adapter.handleInput(session, { messageId: 'm-1', text: TANK, interpret: stub })
      report.steps.outcome = out.outcome
      report.steps.trace = out.trace.map((x) => x.step)
      report.steps.packetChars = out.packet ? out.packet.text.length : 0

      const st = adapter.intentStateOf(session)
      report.steps.state = st ? { revision: st.revision, items: st.items.map((i) => i.id + '|' + i.kind + '|' + i.status) } : st

      // 真实宿主装配：本会话应看到意图包
      const sp = adapter.services.systemPrompt
      const asm = await sp.assemble({ agent, scope: agent })
      const mine = asm.contexts.find((c) => c.name === CONTEXT_NAME)
      report.steps.assembledMine = {
        present: Boolean(mine),
        chars: mine ? String(mine.text).length : 0,
        hasRequirements: mine ? String(mine.text).includes('明确要求') : false,
        hasQuality: mine ? String(mine.text).includes('质量解释') : false,
        hasProvenanceNote: mine ? String(mine.text).includes('不是用户新增的命令') : false,
      }

      // 真实宿主装配：**别的会话**不得看到本会话的意图包（跨会话隔离）
      const other = agents.list().find((x) => String(x.id) !== sessionId)
      if (other) {
        const asmOther = await sp.assemble({ agent: other, scope: other })
        const mineOther = asmOther.contexts.find((c) => c.name === CONTEXT_NAME)
        report.steps.assembledOtherSession = {
          agentId: String(other.id),
          chars: mineOther ? String(mineOther.text).length : 0,
          leaked: Boolean(mineOther && String(mineOther.text).length > 0),
        }
      } else {
        report.steps.assembledOtherSession = { skipped: true, reason: 'no other agent' }
      }

      // 清理：本会话恢复静默
      adapter.setIntentText(sessionId, '')
      const asmAfter = await sp.assemble({ agent, scope: agent })
      const mineAfter = asmAfter.contexts.find((c) => c.name === CONTEXT_NAME)
      report.steps.afterClear = { chars: mineAfter ? String(mineAfter.text).length : 0 }
      try { agent.cancel('po06-p3check-cleanup') } catch { /* best effort */ }

      report.ok = out.outcome === 'committed'
        && report.steps.assembledMine.present === true
        && report.steps.assembledMine.hasRequirements === true
        && report.steps.assembledMine.hasQuality === true
        && (report.steps.assembledOtherSession.leaked === false || report.steps.assembledOtherSession.skipped === true)
        && report.steps.afterClear.chars === 0
      report.verdict = report.ok
        ? 'PASS: 真实宿主路径成立（状态→编译→动态上下文），且跨会话不泄漏'
        : 'CHECK: 见各步骤字段'
    } catch (e) {
      report.error = String((e && e.stack) || e)
      report.verdict = 'ERROR: ' + String((e && e.message) || e)
    } finally {
      writeReport(report)
    }
  })()
}

const htmlVerifierDeps = () => ({
  verify: async (file) => {
    const r = await verifyHtmlFile({ file })
    return { record: r && r.built && r.built.ok ? r.built.record : null, raw: r && r.raw }
  },
  deliver: async (level, payload) => {
    const text = '[交付验证 · 机器结论，不是用户的话]\n' + payload.text
    if (level === LEVEL.WAKE) return adapter.deliverAndWake(payload.sessionId, text, payload.summary)
    return adapter.deliverNotice(payload.sessionId, text, payload.summary)
  },
  ledgerFor: gateLedgers.ledgerFor,
  computeSha: (file) => {
    try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return null }
  },
})

/**
 * 对一份交付物跑交付门。**默认 L0（只记录、不投递）**；
 * 若带 settings 则按其解析等级——自检用它验证 L1/L2 路径。
 */
async function runGateFor(session, file, settingsOverride) {
  const sessionId = String(session.id)
  const st = adapter.intentStateOf(session)
  const rev = st ? st.lastInputRevision : 0
  return runGate(htmlVerifierDeps(), {
    file,
    taskId: st ? String(st.taskId) : 'default',
    sessionId,
    currentInputRevision: rev,
    recordInputRevision: rev,
    settings: settingsOverride || { autoReworkEnabled: false, allowWake: false },
  })
}

/** P6 自检：交付门真实链路 —— 真机验证 + 真实 agent 投递（在自己建的测试会话上）。 */
function runP6Check(ctx) {
  const report = { probe: 'dsh-po06-p6check', phase: 'P6', at: new Date().toISOString(),
    note: '真机验证 + 真实投递；只在自己建的测试会话上；默认等级不投递', steps: {} }
  void (async () => {
    try {
      await adapter.waitProjectionReady(3000)
      const sc = adapter.services.sessionController
      const agents = adapter.services.agents
      const sessionId = 'session-po06-p6-gate-' + Date.now().toString(36)
      report.testSessionId = sessionId
      await sc.create({ sessionId, cwd: join(SCRATCH_DIR, 'test-workspace') })
      const agent = agents.get(sessionId)
      if (!agent) throw new Error('测试会话创建后取不到 agent')
      const session = agent.session
      adapter.initIntent(session, { taskId: 'p6check' })

      // 造一个**确定缺陷**的交付物：画布 0x0
      const dir = join(SCRATCH_DIR, 'gate-fixtures')
      mkdirSync(dir, { recursive: true })
      const bad = dir + '/bad-zero.html'
      writeFileSync(bad, '<!doctype html><html><head><meta charset="utf-8"><title>bad</title></head><body><canvas id="c"></canvas><script>const c=document.getElementById("c");c.width=0;c.height=0;</script></body></html>', 'utf8')
      const good = dir + '/good.html'
      writeFileSync(good, '<!doctype html><html><head><meta charset="utf-8"><title>ok</title></head><body><canvas id="c"></canvas><script>const c=document.getElementById("c");c.width=320;c.height=240;const g=c.getContext("2d");g.fillStyle="#345";g.fillRect(0,0,320,240);</script></body></html>', 'utf8')

      // ① L0（默认）：验证会跑，但**不投递**
      const before = agent.inbox.nextStep.length
      const r0 = await runGateFor(session, bad)
      report.steps.L0 = { verdict: r0.verdict, level: r0.level, delivered: r0.delivered, reasons: r0.reasons }
      await new Promise((r) => setTimeout(r, 500))
      report.steps.L0inboxDelta = agent.inbox.nextStep.length - before

      // ② L1：不唤醒投递（消息应排队，且不产生 turn/start）
      // 用**会话事件快照差分**，不注册 effect——
      // 在 apply 返回后的异步续体里 ctx.on 会报 "cannot create effect on inactive context"（实测）。
      const countTurns = () => {
        try { return (session.snapshotEvents() || []).filter((e) => e.type === 'turn/start').length } catch { return -1 }
      }
      const turnsBefore = countTurns()
      const r1 = await runGateFor(session, bad, { autoReworkEnabled: true, allowWake: false })
      await new Promise((r) => setTimeout(r, 800))
      report.steps.L1 = { verdict: r1.verdict, level: r1.level, delivered: r1.delivered, reasons: r1.reasons }
      const turnsAfter = countTurns()
      report.steps.L1turnStarted = turnsAfter - turnsBefore
      report.steps.triggerResult = r1.delivered

      // ③ 好件：不应产生可返工失败
      const r2 = await runGateFor(session, good, { autoReworkEnabled: true, allowWake: false })
      report.steps.good = { verdict: r2.verdict, level: r2.level, reasons: r2.reasons }

      // ④ 交付门触发默认关闭
      report.steps.triggerDefaultOff = !existsSync(GATE_TRIGGER_FLAG)

      try { agent.cancel('po06-p6check-cleanup') } catch { /* */ }

      report.ok = r0.verdict === 'rework-eligible' && r0.level === 'L0-record'
        && report.steps.L0inboxDelta === 0
        && r1.level === 'L1-queue' && Boolean(r1.delivered && r1.delivered.ok)
        && report.steps.L1turnStarted === 0
        && r2.verdict !== 'rework-eligible'
        && report.steps.triggerDefaultOff === true
      report.verdictText = report.ok
        ? 'PASS: 交付门真实链路（L0 不投递 / L1 投递且不唤醒 / 好件不返工 / 触发默认关闭）'
        : 'CHECK: 见各步骤字段'
    } catch (e) {
      report.error = String((e && e.stack) || e)
      report.verdictText = 'ERROR: ' + String((e && e.message) || e)
    } finally { writeReport(report) }
  })()
}

/** P8b 自检：**装配期启用闸门是否真的在生效**（真实宿主；不调模型、不开浏览器）。
 *
 *  为什么必须有这个自检：闸门的判定逻辑单测已经全绿，但"逻辑正确"与
 *  "接线接上了"是两件事——**一个只在自检里生效的守卫等于没有守卫**（A10/A12 缺口）。
 *  这里用**两侧对照**证明接线成立（只有闸门能解释这个差异）：
 *    (a) 默认态：写了意图包文本，但旧插件仍在装配 ⇒ 上下文贡献必须是 **0 字符**；
 *    (b) 强制启用该会话（探针注入，绕过判定）⇒ 同一段文本必须**贡献出来**。
 *  若 (a) 与 (b) 都为空，说明抑制来自别处（接线没生效）；若 (a) 非空，说明闸门没拦住。
 */
/**
 * E-001 的宿主侧入口（EV-0087）：把 flag/env 翻译成 runE001 的参数并跑。
 * 报告写进 `$DSH_HOME/po06-e001/`（跟着 home 走，不写死路径）。
 */
function runE001Check(ctx) {
  const specPath = process.env.DSH_PO06_E001_SPEC || SMOKE_SPEC
  const holdoutPath = join(__dirnameOfIndex(), '..', 'eval', HOLDOUT_SEAL.file)
  const outDir = join(DSH_HOME, 'po06-e001')
  const only = process.env.DSH_PO06_E001_ONLY
  const onlyTaskIds = only ? String(only).split(',').map((s) => s.trim()).filter(Boolean) : null
  const onlyArms = process.env.DSH_PO06_E001_ARMS ? String(process.env.DSH_PO06_E001_ARMS).split(',').map((s) => s.trim()).filter(Boolean) : null
  const onlyRuns = process.env.DSH_PO06_E001_RUNS ? Number(process.env.DSH_PO06_E001_RUNS) : null
  const budget = process.env.DSH_PO06_E001_BUDGET ? Number(process.env.DSH_PO06_E001_BUDGET) : null
  const stage = process.env.DSH_PO06_E001_STAGE || 'S1'
  // 实验条件：去掉【未决项】段（EV-0089）。默认关闭——它是**实验工具**，不是产品行为。
  const dropUnknowns = process.env.DSH_PO06_E001_DROP_UNKNOWNS === '1'
  writeReport({ probe: 'po06-e001-launch', phase: 'P7', at: new Date().toISOString(),
    args: { specPath, holdoutPath, outDir, stage, budget, onlyTaskIds, onlyArms, onlyRuns, dropUnknowns },
    note: '入口已触发；实际运行结果写进 outDir' })
  void (async () => {
    try {
      // 等 llm 服务就绪：本检查在 apply() 时触发，而服务提供是**延迟**的
      // （agents 在 apply 时就实测为 null）。不等就可能白跑一轮、只拿到 llm-unavailable。
      const t0 = Date.now()
      let llm = ctx.get('llm')
      while ((!llm || typeof llm.stream !== 'function') && Date.now() - t0 < 30000) {
        await new Promise((r) => setTimeout(r, 500))
        llm = ctx.get('llm')
      }
      const { runE001 } = await import('./eval-e001.js')
      // 花钱之前先确认宿主 llm 模块能定位到（EV-0132）：拿不到就**不启动**，
      // 报告里写明试过哪些位置——而不是让第一笔调用抛在循环深处。
      const lib = await loadLlmLib()
      if (!lib.ok) {
        writeReport({ probe: 'po06-e001-launch', phase: 'P7', at: new Date().toISOString(),
          error: 'llm-lib-unresolved: ' + lib.reason, tried: lib.tried })
        return
      }
      await runE001({ ctx, holdoutPath, specPath, outDir, stage, budget, llmLib: lib.spec, onlyTaskIds, onlyArms, onlyRuns, dropUnknowns })
    } catch (e) {
      writeReport({ probe: 'po06-e001-launch', phase: 'P7', at: new Date().toISOString(),
        error: String((e && e.stack) || e) })
    }
  })()
}

/** 本模块所在目录（用于定位仓库内的 eval/ 资源）。 */
function __dirnameOfIndex() {
  try { return dirname(fileURLToPath(import.meta.url)) } catch { return '.' }
}

function runP8bCheck(ctx) {
  const report = { probe: 'dsh-po06-p8bcheck', phase: 'P8b', at: new Date().toISOString(),
    note: '装配期启用闸门接线验证：默认抑制 / 强制启用放行（两侧对照）', steps: {} }
  void (async () => {
    const PROBE_TEXT = '【P8b 探针】意图包文本：这段文字只有在启用闸门放行时才应出现在装配上下文里。'
    let sid = ''
    try {
      await adapter.waitReady(3000)
      const agents = adapter.services.agents
      const sp = adapter.services.systemPrompt
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      const target = list[0]
      report.steps.hasSystemPrompt = Boolean(sp)
      if (!target || !sp) { report.error = 'no agent/systemPrompt to probe'; return }
      sid = String(target.id)

      const mineChars = async () => {
        const asm = await sp.assemble({ agent: target, scope: target })
        const c = (asm.contexts || []).find((x) => x.name === CONTEXT_NAME)
        return c ? String(c.text).length : 0
      }

      // 前置：确认"没有闸门时文本本来是会出现的"——即文本非空且真被渲染
      adapter.setIntentText(sid, PROBE_TEXT)
      report.steps.textLength = adapter.getIntentText(sid).length

      // (a) 默认态：先 forget 掉缓存，让 text() 走真实判定路径
      adapter.enableGate.forget(sid)
      await mineChars()                       // 触发一次判定（异步）
      await new Promise((r) => setTimeout(r, 600))
      const stDefault = adapter.enableGate.statusFor(sid)
      report.steps.gateStatus = { ...stDefault }
      report.steps.charsWhenGated = await mineChars()

      // (b) 强制启用（**仅探针**）：绕过判定，直接注入 enabled=true
      adapter.enableGate.set(sid, { enabled: true, code: 'probe-forced-enabled', reason: 'P8b 探针强制放行' })
      report.steps.charsWhenForced = await mineChars()

      // (c) 双重拦截分支：**不写用户配置**，而是把本机真实探测结果喂给判定函数，
      //     看"若 0.6 已被配置启用（all）"会得到什么结论。
      //     不写 ~/.dsh/prompt-optimizer.json 是刻意的：真实配置迁移需用户同意（ADR-0032）。
      try {
        const agent = adapter.agentFor(sid)
        const rt2 = await detectOldPluginRuntime({ systemPrompt: sp, agent })
        let st2 = null
        try {
          const { detectOldPluginStatic } = await import('./host-migrate.js')
          st2 = detectOldPluginStatic(PROFILE_DIR)
        } catch { st2 = null }
        const merged2 = mergeOldPluginSignals(rt2, st2)
        const tri = toActiveTriState(merged2)
        const wouldBe = resolveEnableDecision({
          intent: parseEnableIntent(JSON.stringify({ settingsVersion: 1, enabled: true, rollout: { mode: 'all' } })),
          sessionId: sid,
          oldPluginActive: tri,
        })
        report.steps.oldPluginTriState = tri
        report.steps.oldPluginEvidence = (merged2 && merged2.evidence || []).slice(0, 3)
        report.steps.wouldBeIfEnabled = wouldBe

        // (d) 把**真实判定结论**注入闸门 → 装配贡献必须仍为 0
        adapter.enableGate.set(sid, wouldBe)
        report.steps.charsWithRealDecision = await mineChars()
      } catch (e) {
        report.steps.oldPluginBranchError = String((e && e.message) || e)
      }

      const a = report.steps.charsWhenGated
      const b = report.steps.charsWhenForced
      const c = report.steps.charsWithRealDecision
      const wb = report.steps.wouldBeIfEnabled || {}
      report.ok = report.steps.textLength > 0
        && a === 0
        && b === report.steps.textLength
        && stDefault.enabled !== true
        // 双重拦截分支：本机旧插件确实在装 ⇒ 结论必须是否决，且据此装配贡献仍为 0
        && (report.steps.oldPluginTriState !== true || wb.code === 'DOUBLE_INTERCEPT')
        && (report.steps.oldPluginTriState !== true || c === 0)
      report.verdictText = report.ok
        ? ('PASS: 闸门真的接在装配路径上——默认态贡献 ' + a + ' 字符（结论 ' + stDefault.code
           + '），强制放行后贡献 ' + b + ' 字符；'
           + '按本机真实探测（旧插件 tri-state=' + report.steps.oldPluginTriState
           + '）若配置启用则结论=' + wb.code + '，据此贡献 ' + c + ' 字符')
        : ('CHECK: 默认 ' + a + ' / 强制 ' + b + ' / 真实判定 ' + c + ' / 文本 ' + report.steps.textLength
           + '，默认结论 ' + stDefault.code + '，真实判定结论 ' + wb.code)
    } catch (e) {
      report.error = String((e && e.stack) || e)
      report.verdictText = 'ERROR: ' + String((e && e.message) || e)
    } finally {
      try { if (sid) { adapter.setIntentText(sid, ''); adapter.enableGate.forget(sid) } } catch { /* best effort */ }
      writeReport(report)
    }
  })()
}

/** P8 自检：旧插件**运行时**探测 + 启用闸门（不调模型、不开浏览器）。 */
function runP8Check(ctx) {
  const report = { probe: 'dsh-po06-p8check', phase: 'P8', at: new Date().toISOString(),
    note: '运行时探测旧插件是否仍在装配；并核对启用闸门结论', steps: {} }
  void (async () => {
    try {
      await adapter.waitReady(3000)
      const agents = adapter.services.agents
      const list = agents && typeof agents.list === 'function' ? agents.list() : []
      const target = list[0]
      const sp = adapter.services.systemPrompt
      report.steps.hasSystemPrompt = Boolean(sp)
      if (!target) { report.error = 'no agent to scope the probe'; return }

      // 装配结果里的上下文清单（用来核对探测依据）
      const asm = await sp.assemble({ agent: target, scope: target })
      report.steps.contextNames = (asm.contexts || []).map((c) => c.name)

      const rt = await detectOldPluginRuntime({ systemPrompt: sp, agent: target })
      report.steps.runtime = rt

      // 静态探测（本机 profile）
      let st = null
      try {
        const { detectOldPluginStatic } = await import('./host-migrate.js')
        st = detectOldPluginStatic(PROFILE_DIR)
      } catch (e) { st = { error: String((e && e.message) || e) } }
      report.steps.static = st

      const merged = mergeOldPluginSignals(rt, st)
      report.steps.merged = merged

      // 启用闸门：命中则必须拒绝启用
      const decided = decideEnabled({
        rollout: { mode: 'all' },
        sessionId: String(target.id),
        settings: { enabled: true },
        oldPluginActive: merged.active,
      })
      report.steps.gate = decided

      report.ok = rt.confidence === 'runtime'
        && typeof merged.active === 'boolean'
        && (merged.active === false || decided.code === 'DOUBLE_INTERCEPT')
      report.verdictText = report.ok
        ? ('PASS: 运行时探测成立（active=' + merged.active + '，confidence=' + merged.confidence
           + '）；启用闸门结论=' + decided.code)
        : 'CHECK: 见各步骤字段'
    } catch (e) {
      report.error = String((e && e.stack) || e)
      report.verdictText = 'ERROR: ' + String((e && e.message) || e)
    } finally { writeReport(report) }
  })()
}

// ── 定点核对用的出口（P11）────────────────────────────────────────────
// 前置拦截撞上的两条"懒加载"失败（`gate-disabled` / `no-model-route`）都是**时序**问题：
// 用真机去试既慢又不可重复 ⇒ 把这两个内部函数导出，让测试用假闸门/假 llm 服务把时序钉死。
// ⚠ **只给测试**：生产路径不许绕过 apply 里的接线直接调它们；放在文件末尾是因为
// 这里引用的进度表/已解释原话表都是 `const`（放前面会落进 TDZ，实测直接 ReferenceError）。
export const __test = { awaitGateDecision, ensureModelRoute, observeModel, modelFor, observedModelBySession, progressGet, progressSet, runInterceptInput }

/** 只给测试：清掉"已观测模型"（含那个粘性的全局兜底），否则用例之间会互相污染。 */
export function __resetObservedModelsForTest() { observedModelBySession.clear(); observedModel = null }
