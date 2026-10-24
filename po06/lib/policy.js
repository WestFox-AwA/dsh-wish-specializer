// P9.4 · **设置 → 行为**的映射（EV-0143）。
//
// 为什么必须有这一层：界面上摆了"辅助 / 补充程度 / 自主预算"三个开关，如果它们**不改变任何行为**，
// 那就是装饰品——本项目最忌的"看起来生效"（用户点开 0.6 却不生效、也没有任何提示）。
// 所以每一个开关都要有一条**可测的**行为对应，并且这条对应要写在代码里、被测试钉住：
//
//   assist=off      ⇒ **不解释、不注入**（只记一条台账 reason:'assist-off'）。省一次模型调用，
//                     也保证"只记录、不补充"这句界面文案是真的。
//   detail=minimal  ⇒ 意图包预算收紧（只保必要的节）      standard=默认   detailed=放宽
//   budget=minimal  ⇒ 一批最多问 1 个问题                standard=2      generous=3
//
// ⚠ 边界说明（不要读成更多）：`budget` 目前**只**映射到"澄清提问配额"，
// 返工门（P6）的生产触发本来就是默认关闭的，不因为档位而打开——档位不该悄悄放大自主权。
import { normalizeSettings, tierOf, TIER_PRESETS } from './settings.js'
import { strategyForTier } from './strategy.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 意图包字符预算：默认与 `compiler.DEFAULT_BUDGET` 一致（1200），避免"没设置就变行为"。 */
export const DETAIL_BUDGET = Object.freeze({ minimal: 700, standard: 1200, detailed: 2000 })
/** 一批最多问几个问题：默认与 `clarifier` 的默认一致（2）。 */
export const BUDGET_QUESTIONS = Object.freeze({ minimal: 1, standard: 2, generous: 3 })
/** 未指定（字段缺失）时用的档位，与 settings 的默认一致。 */
export const DEFAULT_DETAIL = 'standard'
export const DEFAULT_BUDGET = 'standard'
export const DEFAULT_ASSIST = 'auto'

/**
 * 纯函数：设置 → 政策。
 *
 * ⚠ 这里**故意没有第二层回落**：档位合法性由 `normalizeSettings`（settings.js）统一保证——
 * 它已经把非法值换成默认并如实上报。原先我在本函数里又写了一遍"取不到就回落默认"的三元，
 * 结果那行**永远不可达**：变异体"非法档位不回落"死活抓不住（测试无法区分两种实现）。
 * 不可达的防御代码是一种**谎报**——它看起来在保证什么，其实什么都没保证。
 * 真正要守的不变量交给测试：**settings.js 的每个值域里的每个取值都必须在这里有映射**（见 policy.test.mjs）。
 */
/**
 * 合并全局默认与某会话的档位覆盖（0.7.7）。
 *
 * 为什么要有这一层：档位此前是**全局单一值**——一个会话设成重度，所有会话一起变。
 * 而用户的直觉是「会话模型都能独立，档位也该独立」（2026-09-26 提出）。
 * 合并规则：**会话覆盖优先**，没被覆盖的项回落全局 —— 所以旧配置（无 bySession）行为完全不变。
 * 越界的会话键已在 normalizeSettings 里被丢弃，这里不再重复校验。
 */
export function effectiveSettings(settings, sessionId) {
  const s = normalizeSettings(settings).settings
  const sid = (sessionId === undefined || sessionId === null) ? '' : String(sessionId)
  const ov = (sid && s.bySession && typeof s.bySession === 'object') ? s.bySession[sid] : null
  if (!ov) return s
  // 档位别名在**读取时**展开（存储里只留意图，见 settings.js 的说明）：
  // 预设当基底、显式项优先。这样连续点档位不会带上上一次的展开残留——那正是"点了不生效"的根因。
  let eff = ov
  if (typeof ov.tier === 'string' && TIER_PRESETS[ov.tier]) {
    const explicit = { ...ov }
    delete explicit.tier
    eff = { ...TIER_PRESETS[ov.tier], ...explicit, tier: ov.tier }
  }
  return { ...s, ...eff, bySession: s.bySession }
}

export function policyFor(settings, sessionId) {
  const s = effectiveSettings(settings, sessionId)
  return {
    assist: s.assist,
    model: s.model,
    detail: s.detail,
    budget: s.budget,
    // 0.7.8 协作基调：`neutral` 不注入任何东西，`hard` 由编译器加一段语域匹配的短块。
    framing: s.framing, englishMode:s.englishMode,
    reasoningBoost: s.reasoningBoost, reasoningMode: s.reasoningMode,
    reasoningCandidates: s.reasoningCandidates, reasoningRounds: s.reasoningRounds, reasoningPace:s.reasoningPace,
    injectPacket: s.assist !== 'off',
    packetBudgetChars: DETAIL_BUDGET[s.detail],
    maxQuestions: BUDGET_QUESTIONS[s.budget],
    // ⚠ P10 补接（真机台账照出来的洞，别删这几行）：
    // 引擎侧（`renderObserverBlock` / `readToolsFor`）读的是 `pol.historyMode` / `pol.turns` / `pol.readTools`，
    // 而政策里**原本没有这三个字段** ⇒ 全是 `undefined` ⇒ 上下文永远走 `turns-0`、工具永远 `setting-not-true`，
    // 于是界面上的"上下文/回合数/读项目文件"三个开关**全是死开关**——引擎模块单测全过、生产里一动不动。
    // 教训：模块级核对必须**经过 policy**，否则照不出"接线漏了一段"。
    permission: s.permission,
    historyMode: s.historyMode,
    turns: s.turns,
    readTools: s.readTools,
    // 0.7.1：内置 Bash 的开关（host 侧据此决定是否把 bash 工具注册给模型）。
    bash: s.bash,
    // 0.7.5：**按模型的思考档位表**（{ "provider/model": "effortId" }）。
    // ⚠ 必须出现在这里——引擎读的是 pol.*，政策里没有的字段会静默变 undefined，
    // 于是"档位设置"就成了又一个死开关（P10 那三个死开关的教训，见上面那段注释）。
    effortByModel: s.effortByModel,
    // ⚠ P11 补接（用户 2026-09-24 实测："重度并没有明显比轻度高"）：
    // 旧的四档只映射 assist/detail/budget，**标准与重度的 detail 是同一个值** ⇒
    // 「重度」= 「标准 + 多 1 个提问」。现在档位另外带一份**策略**（怎么想），
    // 由 strategy.js 唯一决定；下游（解释层提示词、编译器、只读工具）读 `pol.strategy`。
    tier: tierOf(effectiveSettings(settings, sessionId)),
    strategy: strategyForTier(tierOf(effectiveSettings(settings, sessionId))),
    // 提示开关必须经过政策层才能到达宿主与消费者；漏接会让「以后不再显示」失效。
    presetNoticeDismissed: s.presetNoticeDismissed,
    skipHintDismissed: s.skipHintDismissed,
  }
}

/**
 * 读**生效**的政策：`<home>/po06.json` 里的设置 → 归一化 → 政策。
 * 任何读/解析异常都回落到默认政策（保守：默认档位就是今天的行为）。
 */
/**
 * 包的"形状"——决定编译结果的那几个生效字段。
 *
 * 为什么单独拎出来：包文本是**按当时政策编译好的一整段字符串**（存在 intentBySession 里）。
 * 政策一变，那份字符串就过期了；若不作废，它会在后续回合继续被注入 ——
 * 用户实测 2026-09-29：切回普通档（framing=neutral）后，注入文里**仍然带着硬邦邦那段**。
 */
export function packetShapeOf(pol) {
  if (!pol) return ''
  return [pol.assist, pol.detail, pol.budget, pol.framing,pol.englishMode?'en':'original'].join('|')
}

/** 写盘前后形状不同 ⇒ 已存的包文本必须作废（下一次拦截会重编译）。两侧都取不到时不作废。 */
export function packetShapeChanged(before, after) {
  const a = packetShapeOf(before)
  const b = packetShapeOf(after)
  return a !== '' && b !== '' && a !== b
}

export function readPolicy({ home, readFile, sessionId } = {}) {
  const read = readFile || ((p) => { try { return existsSync(p) ? readFileSync(p, 'utf8') : null } catch { return null } })
  let raw = null
  try { const t = read(join(String(home), 'po06.json')); raw = t ? JSON.parse(t) : null } catch { raw = null }
  const p = policyFor(raw || {}, sessionId)
  return { ...p, source: raw ? 'config' : 'default' }
}
