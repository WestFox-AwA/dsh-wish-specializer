// 宿主 llm 模块定位（`lib/llm-lib.js`）的单测。
//
// 运行：node po06/test/llm-lib.test.mjs
//
// 为什么给它配单测（EV-0132）：这一族缺陷的形态是"**本机专用**"——写死路径在作者机器上
// 永远通过，换台机器必然失败，而且失败点离原因很远（自检只报"投递步骤没通过"）。
// 所以这里测的不是"能跑"，而是**解析规则本身**：候选顺序、失败原因、以及"不猜"。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import {
  LLM_PKG, OVERRIDE_ENV, toImportSpec, llmLibCandidates, resolveLlmLib, loadLlmLib, requireLlmLib,
} from '../lib/llm-lib.js'

let pass = 0
const failures = []
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy') }
function eq(a, b, what) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${what || 'value'}: expected ${y}, got ${x}`) }
function t(name, fn) { try { fn(); pass += 1 } catch (e) { failures.push({ name, error: String(e.message || e) }) } }
async function ta(name, fn) {
  try { await fn(); pass += 1 } catch (e) { failures.push({ name, error: String(e.message || e) }) }
}

const DIRS = []
process.on('exit', () => { for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } } })

/** 造一棵**假的 dsh 安装树**：<root>/lib/bin.js + <root>/node_modules/@deepseek-ai/dsh-llm/lib/index.js */
function fixtureTree({ withLib = true, libSource = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'po06-llmlib-'))
  DIRS.push(root)
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'bin.js'), '// fake dsh entry\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0' }))
  const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-llm')
  if (withLib) {
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: LLM_PKG, version: '0.0.0', type: 'module', exports: { '.': './lib/index.js' },
    }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), libSource
      || 'export function createUserMessage(i) { return { id: "m-fixture", role: "user", ...i } }\n'
      + 'export function createSystemMessage(t) { return { id: "s-fixture", role: "system", text: String(t) } }\n')
  }
  return { root, entry: join(root, 'lib', 'bin.js'), libPath: join(pkgDir, 'lib', 'index.js') }
}

// ── 1. 纯函数：说明符归一与候选清单 ─────────────────────────────────────
t('toImportSpec：URL 原样，本地绝对路径转 file URL，包名原样，空值 null', () => {
  eq(toImportSpec(''), null, '空串 ⇒ null')
  eq(toImportSpec('   '), null, '空白 ⇒ null')
  eq(toImportSpec(null), null, 'null ⇒ null')
  eq(toImportSpec(undefined), null, 'undefined ⇒ null')
  eq(toImportSpec('file:///x/y.js'), 'file:///x/y.js', 'file URL 原样')
  eq(toImportSpec('https://x/y.js'), 'https://x/y.js', '其它 scheme 原样')
  // ⚠ 用**本机原生**绝对路径来验：写死 `C:/…` 只在 Windows 成立，
  //   在 Linux 上它会被当成相对路径拼到 cwd 下，断言必然失败（CI 首跑实测）。
  //   空格仍然要验——那是这条用例真正要守的东西（编码）。
  const spaced = join(process.cwd(), 'a b', 'c.js')
  const p = toImportSpec(spaced)
  ok(p.indexOf(pathToFileURL(spaced).href) === 0, '本地绝对路径要转成 file URL（空格要编码）：' + p)
  eq(toImportSpec(LLM_PKG), LLM_PKG, '包名原样')
})

t('候选顺序：环境覆盖在前、宿主入口在后；两者都没有 ⇒ 空清单', () => {
  eq(llmLibCandidates({}), [], '什么都不给 ⇒ 没有候选')
  const envPath = join(process.cwd(), 'x', 'dsh-llm.js')
  const withEnv = llmLibCandidates({ env: { [OVERRIDE_ENV]: envPath } })
  eq(withEnv.length, 1, '只有环境覆盖时 1 条')
  eq(withEnv[0].source, 'env:' + OVERRIDE_ENV, '来源标记')
  ok(withEnv[0].spec.indexOf('file:///') === 0, '被归一成 file URL')
  const hostEntry = join(process.cwd(), 'dsh', 'lib', 'bin.js')
  const both = llmLibCandidates({ env: { [OVERRIDE_ENV]: envPath }, argv1: hostEntry })
  eq(both.length, 2, '两条候选')
  eq(both[0].source, 'env:' + OVERRIDE_ENV, '环境覆盖必须**排第一**（用户显式指定优先级最高）')
  eq(both[1].source, 'host-entry', '宿主入口第二')
  eq(both[1].base, hostEntry, '基准就是宿主入口本身')
})

t('issue #43：软链入口要按 realpath 再试一次，另补运行时前缀与插件自身两条基准', () => {
  const link = join(process.cwd(), 'global', 'bin', 'dsh')
  const real = join(process.cwd(), 'global', 'lib', 'bin.js')
  const withReal = llmLibCandidates({ argv1: link, argv1Real: real })
  eq(withReal.map((c) => c.source), ['host-entry', 'host-entry-real'], '软链入口后面必须跟上真身')
  eq(withReal[1].base, real, '真身作为基准（npm 全局安装的 `<dsh>/lib/bin.js`）')
  const same = llmLibCandidates({ argv1: real, argv1Real: real })
  eq(same.map((c) => c.source), ['host-entry'], '真身与入口相同就不重复')
  const withRuntime = llmLibCandidates({ execPath: join(process.cwd(), 'node', 'bin', 'node.exe') })
  ok(withRuntime.some((c) => c.source === 'runtime-prefix'), '要补 node 运行时前缀候选（<prefix>/lib/node_modules）')
  const withSelf = llmLibCandidates({ selfUrl: pathToFileURL(join(process.cwd(), 'po06', 'lib', 'llm-lib.js')).href })
  ok(withSelf.some((c) => c.source === 'plugin-self'), '要补插件自身模块树这条基准')
})

t('issue #43：软链形态下真的能解析到包（假安装树 + realpath 注入）', () => {
  const root = mkdtempSync(join(tmpdir(), 'po06-llm43-'))
  try {
    const pkgDir = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'index.js'), 'export const x = 1')
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.0.0', main: 'index.js' }))
    const entry = join(root, 'dsh', 'lib', 'bin.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '')
    const link = join(root, 'global-bin', 'dsh')
    const r = resolveLlmLib({
      argv1: link,
      realpathOf: () => entry,
      resolveSpec: (base, spec) => createRequire(base).resolve(spec),
      execPath: '',
      selfUrl: '',
    })
    ok(r.ok, '必须解析成功：' + JSON.stringify(r.tried))
    eq(r.source, 'host-entry-real', '命中的应是 realpath 那条候选')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

t('相对入口要按 cwd 补全；没有 cwd 就**不给**这个候选（宁缺勿猜）', () => {
  eq(llmLibCandidates({ argv1: 'lib/bin.js' }), [], '相对入口 + 无 cwd ⇒ 不给候选，避免拿错基准解析')
  const withCwd = llmLibCandidates({ argv1: 'lib/bin.js', cwd: 'C:/dsh' })
  eq(withCwd.length, 1, '有 cwd ⇒ 给一条')
  ok(/bin\.js$/.test(withCwd[0].base) && withCwd[0].base.indexOf('dsh') >= 0, '基准已补全：' + withCwd[0].base)
})

// ── 2. 解析：真的用 createRequire 走一遍假的安装树 ───────────────────────
t('宿主入口解析：从假安装树的入口找到它自己的 node_modules 里的包', () => {
  const fx = fixtureTree()
  const r = resolveLlmLib({ env: {}, argv1: fx.entry })
  ok(r.ok, '应解析成功：' + JSON.stringify(r.tried))
  eq(r.source, 'host-entry', '来源应为宿主入口')
  eq(r.path, fx.libPath, '解析出的就是安装树里那个文件')
  eq(r.spec, pathToFileURL(fx.libPath).href, 'spec 是可直接 import 的 URL')
})

t('假安装树里**没有**这个包 ⇒ 如实失败，并带上试过什么', () => {
  const fx = fixtureTree({ withLib: false })
  const r = resolveLlmLib({ env: {}, argv1: fx.entry })
  eq(r.ok, false, '不该成功')
  eq(r.reason, 'llm-lib-unresolved', '原因要能区分"没找到"')
  eq(r.tried.length, 1, '记录一条尝试')
  eq(r.tried[0].source, 'host-entry', '是哪条候选')
  ok(r.tried[0].reason, '必须带机器可读的原因：' + JSON.stringify(r.tried[0]))
})

// ── 3. 显式覆盖：优先、且写错要能一眼看出来 ──────────────────────────────
t('环境覆盖优先于宿主入口；文件不存在时**回落到**宿主入口并留下 not-found', () => {
  const fx = fixtureTree()
  const good = resolveLlmLib({ env: { [OVERRIDE_ENV]: fx.libPath }, argv1: fx.entry })
  ok(good.ok, '覆盖路径存在 ⇒ 成功：' + JSON.stringify(good.tried))
  eq(good.source, 'env:' + OVERRIDE_ENV, '来源是环境变量')
  eq(good.path, fx.libPath, '用的就是覆盖的那个文件')

  const bad = resolveLlmLib({ env: { [OVERRIDE_ENV]: join(fx.root, 'nope', 'index.js') }, argv1: fx.entry })
  ok(bad.ok, '覆盖写错 ⇒ 回落到宿主入口，仍能成功')
  eq(bad.source, 'host-entry', '回落后来源是宿主入口')
  eq(bad.tried.length, 2, '两条都记录')
  eq(bad.tried[0].reason, 'not-found', '写错的那条要写明 not-found（不是静默跳过）')
})

t('覆盖写成**包名**时按宿主基准解析；没有基准则如实报 no-base-to-resolve', () => {
  const fx = fixtureTree()
  const r = resolveLlmLib({ env: { [OVERRIDE_ENV]: LLM_PKG }, argv1: fx.entry })
  ok(r.ok, '包名 + 有宿主基准 ⇒ 成功：' + JSON.stringify(r.tried))
  eq(r.source, 'env:' + OVERRIDE_ENV, '来源是覆盖项')
  const noBase = resolveLlmLib({ env: { [OVERRIDE_ENV]: LLM_PKG } })
  eq(noBase.ok, false, '包名但无基准 ⇒ 失败')
  eq(noBase.tried[0].reason, 'no-base-to-resolve', '原因要说明缺基准')
})

// ── 4. 加载：真的 import 一次；失败原因要分得清"没找到"和"加载炸了" ──────
await ta('loadLlmLib：解析成功则真的 import 到模块（含构造函数）', async () => {
  const fx = fixtureTree()
  const r = await loadLlmLib({ env: {}, argv1: fx.entry })
  ok(r.ok, '应加载成功：' + JSON.stringify(r.tried))
  eq(typeof r.mod.createUserMessage, 'function', '拿到的就是宿主模块（有 createUserMessage）')
  eq(typeof r.mod.createSystemMessage, 'function', '也有 createSystemMessage')
})

await ta('loadLlmLib：解析不到 ⇒ ok:false，且**不**抛（调用方自己决定怎么报告）', async () => {
  const r = await loadLlmLib({ env: {}, argv1: '' })
  eq(r.ok, false, '不该成功')
  eq(r.reason, 'llm-lib-unresolved', '原因')
  eq(r.mod, undefined, '不得返回半个模块')
})

await ta('loadLlmLib：模块存在但加载抛错 ⇒ 原因是 import-failed，而不是"没找到"', async () => {
  const fx = fixtureTree()
  const r = await loadLlmLib({
    env: {}, argv1: fx.entry,
    importMod: async () => { const e = new Error('boom'); e.code = 'ERR_BOOM'; throw e },
  })
  eq(r.ok, false, '加载失败即失败')
  ok(String(r.reason).indexOf('import-failed:') === 0, '原因前缀：' + r.reason)
  ok(String(r.reason).indexOf('ERR_BOOM') >= 0, '要带原始错误码：' + r.reason)
  ok(Array.isArray(r.tried) && r.tried.length >= 1, '仍要保留 tried（便于排查）')
})

await ta('requireLlmLib：拿得到返回模块；拿不到**抛**且错误里带试过的位置', async () => {
  const fx = fixtureTree()
  const empty = fixtureTree({ withLib: false })
  const mod = await requireLlmLib({ env: {}, argv1: fx.entry })
  eq(typeof mod.createUserMessage, 'function', '成功路径返回模块本身')
  // 注意：createRequire 只把 base 当作"从哪开始往上找"的起点，**base 本身不必存在**，
  // 所以"把 base 指向不存在的文件"并不会失败——要用一棵**真的没有这个包**的树才验得出来。
  let threw = null
  try { await requireLlmLib({ env: {}, argv1: empty.entry }) } catch (e) { threw = e }
  ok(threw, '解析不到必须抛')
  ok(/llm-lib-unresolved/.test(String(threw.message)), '错误要说明原因：' + String(threw && threw.message))
  ok(/host-entry/.test(String(threw.message)), '错误要带试过的位置：' + String(threw && threw.message))
})

// ── 5. 静态纪律：本模块自己不得写死绝对路径（与 wire.test 的守卫同一条规则）──
t('llm-lib.js 自身不得出现写死的绝对路径', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'llm-lib.js'), 'utf8')
  // 与 wire.test.mjs 的守卫同一形状：盘符要出现在**行首或分隔符之后**才算（避免把 `file:///` 误判成盘符）
  const DRIVE_RE = /(^|[\s'"`(=])[A-Za-z]:[/\\]/
  const bad = src.split('\n').map((l) => l).filter((l) => DRIVE_RE.test(l) || /\/Users\/|\/home\/|\/root\//.test(l))
  eq(bad.length, 0, '不得写死绝对路径，命中：' + bad.map((l) => l.trim().slice(0, 80)).join(' | '))
})

const total = pass + failures.length
console.log(JSON.stringify({
  suite: 'po06-llm-lib', phase: 'P8', total, pass, fail: failures.length, failures,
  note: '宿主 llm 模块**按安装位置**定位：环境覆盖优先、宿主入口次之、都失败就如实报 tried 列表。不调模型。',
}, null, 2))
process.exit(failures.length === 0 ? 0 : 1)
