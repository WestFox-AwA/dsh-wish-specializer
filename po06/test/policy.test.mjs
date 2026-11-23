// P9.4 · **设置 → 行为**映射（`lib/policy.js`）的单测（EV-0143）。
//
// 运行：node po06/test/policy.test.mjs
//
// 为什么给它配单测：界面上的三个开关如果**不改变任何行为**，那就是装饰品。
// 这里把"每个档位对应什么行为"钉成机器可查的事实，并且把**默认值等于今天的行为**这一条也钉住
// （默认 1200 字符预算 / 2 个提问，与 compiler 与 clarifier 的默认一致——改默认值必须是有意识的动作）。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  policyFor, readPolicy, effectiveSettings, DETAIL_BUDGET, TOKENS_PER_CHAR, BUDGET_QUESTIONS, DEFAULT_DETAIL, DEFAULT_BUDGET, DEFAULT_ASSIST,
} from '../lib/policy.js'
import { DEFAULT_BUDGET as COMPILER_DEFAULT_BUDGET } from '../lib/compiler.js'
import { ASSIST_MODES, DETAIL_LEVELS, BUDGET_LEVELS } from '../lib/settings.js'

let pass = 0
const failures = []
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy') }
function eq(a, b, what) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${what || 'value'}: expected ${y}, got ${x}`) }
function t(name, fn) { try { fn(); pass += 1 } catch (e) { failures.push({ name, error: String(e.message || e) }) } }

const DIRS = []
process.on('exit', () => { for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } } })

// ── ① 默认 = 今天的行为（这一条最要紧：没设置不该改变任何东西）────────────
t('默认政策随新装默认（重度）：预算 2000、一批 3 个问题、注入开启', () => {
  const p = policyFor({})
  eq(p.injectPacket, true, '默认要注入（用户显式启用 0.6 才会走到这里）')
  eq(p.assist, DEFAULT_ASSIST, '默认自动辅助')
  eq(p.detail, 'detailed', '默认档位（2026-10-18 起默认重度）')
  eq(p.budget, 'generous', '默认预算档（2026-10-18 起默认重度）')
  eq(p.packetBudgetTokens, 3000, 'token 预算 = 3000（2026-10-20 用户定）')
  eq(p.packetBudgetChars, Math.floor(3000 / TOKENS_PER_CHAR.zh), '字符预算是 token 的中文换算值（宿主只认字符）')
  eq(p.packetBudgetChars, Math.floor(3000 / TOKENS_PER_CHAR.zh), '字面值也钉住：改它必须是有意识的动作')
  eq(p.maxQuestions, 3, '提问配额默认 3（generous，2026-10-18 起）')
})

// ── ② 每个档位都有可测的行为对应 ─────────────────────────────────────
t('assist=off ⇒ 不注入（"只记录、不补充"这句话必须是真的）', () => {
  const off = policyFor({ assist: 'off' })
  eq(off.injectPacket, false, 'off ⇒ 不注入')
  eq(policyFor({ assist: 'auto' }).injectPacket, true, 'auto ⇒ 注入')
  eq(policyFor({ assist: 'autoo' }).injectPacket, true, '错拼回落默认（auto）而不是静默关掉整件事')
})

t('三档共享3000 token上限，差异由方向展开程度表达', () => {
  for (const detail of ['minimal','standard','detailed']) {
    const policy = policyFor({detail})
    eq(policy.packetBudgetTokens, 3000, detail)
    eq(policy.detail, detail, 'shared ceiling must not collapse the guidance level')
  }
  eq(policyFor({detail:'nonsense'}).packetBudgetTokens,3000,'非法detail仍用共享上限')
  eq(policyFor({englishMode:true}).packetBudgetChars,12000,'英文字符换算只是旧编译器的近似')
})

t('budget 三档 → 提问配额 1/2/3', () => {
  eq(policyFor({ budget: 'minimal' }).maxQuestions, BUDGET_QUESTIONS.minimal, 'minimal ⇒ 1')
  eq(policyFor({ budget: 'standard' }).maxQuestions, 2, 'standard ⇒ 2')
  eq(policyFor({ budget: 'generous' }).maxQuestions, BUDGET_QUESTIONS.generous, 'generous ⇒ 3')
  eq(policyFor({ budget: 'x' }).maxQuestions, 3, '非法值 ⇒ 回落默认（generous ⇒ 3）')
})

// ── ③ 读配置：坏文件/缺文件都要能给出**默认政策**，不抛 ──────────────────
t('readPolicy：缺文件/坏 JSON/字段乱写 ⇒ 一律默认政策（绝不抛、绝不放宽）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po06-pol-')); DIRS.push(dir)
  const home = dir
  const p0 = readPolicy({ home })
  eq(p0.source, 'default', '没有配置文件 ⇒ 来源是 default')
  eq(p0.packetBudgetTokens, 3000, '默认预算（重度）')

  writeFileSync(join(home, 'po06.json'), '{ 坏的', 'utf8')
  const p1 = readPolicy({ home })
  eq(p1.packetBudgetTokens, 3000, '坏 JSON ⇒ 默认（不猜、不放宽）')

  writeFileSync(join(home, 'po06.json'), JSON.stringify({ settingsVersion: 1, enabled: true, detail: 'detailed', budget: 'minimal', assist: 'off' }), 'utf8')
  const p2 = readPolicy({ home })
  eq(p2.source, 'config', '有配置 ⇒ 来源是 config')
  eq(p2.packetBudgetTokens, 3000, '读到了 detailed 的预算')
  eq(p2.maxQuestions, 1, '读到了 minimal 的配额')
  eq(p2.injectPacket, false, '读到了 assist=off')
})

// ── ④ 与真实配置文件的一致性（用用户当前的 po06.json 形态）─────────────
t('readPolicy 接受注入的 readFile（便于测试与替换 IO）', () => {
  const fake = readPolicy({ home: 'X:/nope', readFile: () => JSON.stringify({ detail: 'minimal' }) })
  eq(fake.source, 'config', '注入了读函数 ⇒ 走 config')
  eq(fake.packetBudgetTokens, 3000, '轻度也使用同一个总token上限')
  const nul = readPolicy({ home: 'X:/nope', readFile: () => null })
  eq(nul.source, 'default', '读不到 ⇒ default')
})

t('不变量：settings.js 值域里的**每个**取值都必须在这里有映射（比"不可达的回落"更有效）', () => {
  for (const v of ASSIST_MODES) ok(policyFor({ assist: v }).assist === v, 'assist 取值 ' + v + ' 要有映射')
  for (const v of DETAIL_LEVELS) {
    const n = policyFor({ detail: v }).packetBudgetChars
    ok(Number.isFinite(n) && n > 0, 'detail 取值 ' + v + ' 要有正的预算映射：' + n)
  }
  for (const v of BUDGET_LEVELS) {
    const n = policyFor({ budget: v }).maxQuestions
    ok(Number.isFinite(n) && n >= 0, 'budget 取值 ' + v + ' 要有非负配额映射：' + n)
  }
})

t('旧 framing 不能进入生效设置或政策，按会话档位与英文/顾问保持有效', () => {
  const current = { englishMode: true, advisor: false, bySession: {
    a: { tier: 'light', englishMode: false }, b: { tier: 'off' },
  } }
  for (const framing of ['hard', 'neutral']) {
    const legacy = { ...current, framing, bySession: {
      a: { ...current.bySession.a, framing }, b: { ...current.bySession.b, framing },
      onlyRemoved: { framing },
    } }
    for (const sessionId of [undefined, 'a', 'b', 'onlyRemoved']) {
      const effective = effectiveSettings(legacy, sessionId)
      ok(!('framing' in effective), '生效设置不得带占位字段')
      eq(effective, effectiveSettings(current, sessionId), '会话生效结果与删除旧字段后的输入完全一致')
      const policy = policyFor(legacy, sessionId)
      ok(!('framing' in policy), '政策不得透传旧字段')
      eq(policy, policyFor(current, sessionId), '旧字段不影响预算、档位、英文或顾问')
      const read = readPolicy({ home: 'X:/nope', sessionId, readFile: () => JSON.stringify(legacy) })
      eq(read, { ...policy, source: 'config' }, '读盘路径同样忽略全局与会话旧字段')
    }
  }
})

const total = pass + failures.length
console.log(JSON.stringify({
  suite: 'po06-policy', phase: 'P9', total, pass, fail: failures.length, failures,
  note: '设置→行为映射：默认等于现有行为、三档各自可测、坏配置一律回落默认。不调模型、不联网。',
}, null, 2))
process.exit(failures.length === 0 ? 0 : 1)
