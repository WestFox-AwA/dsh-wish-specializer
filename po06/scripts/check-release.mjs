// 0.6 发版前自检：包清单 / 版本一致性 / 全量测试 / 产物哈希清单
//
// 存在理由（来自 P0 实测的两个真实事故）：
//   · 本地版本目录的 lib 曾被批量覆盖，导致"目录名不再代表版本"（P0-D1）；
//   · 运行实例路径与 profile 依赖曾经互相矛盾（P0-D2）。
// 所以发版前必须能把"源码 → 清单 → 产物"三者对上，且**每一步都有哈希**。
//
// 用法：node po06/scripts/check-release.mjs [--json]
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..')          // po06/
const REPO = join(ROOT, '..')                          // 仓库根
const asJson = process.argv.includes('--json')
// --strict：**发版**时用。多要求一项"本机不该缺的东西"（turn305 参考树，issue #36）；
// CI 每次 push 都跑这个脚本，所以严格项必须显式要，否则 CI 会因为"作者本机的夹具"恒红。
const strict = process.argv.includes('--strict')

const problems = []
const notes = []
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const shaFile = (p) => sha(readFileSync(p))

function walk(dir, base = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

// ── 1. package.json 基本字段 ────────────────────────────────────────
const pkgPath = join(ROOT, 'package.json')
if (!existsSync(pkgPath)) { problems.push('缺少 po06/package.json'); report() }
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

if (pkg.name !== '@dsh-external/dsh-wish-specializer') {
  problems.push('包名与预期不符：' + String(pkg.name))
}
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
  problems.push('版本号不是可解析的三段式：' + String(pkg.version))
}
if (pkg.type !== 'module') problems.push('package.json 缺 "type":"module"')

// ── 2. 入口存在 ─────────────────────────────────────────────────────
const main = pkg.main || './lib/index.js'
if (!existsSync(join(ROOT, main))) problems.push('main 指向的文件不存在：' + main)
const exp = pkg.exports && pkg.exports['.'] && (pkg.exports['.'].default || pkg.exports['.'])
const expPath = typeof exp === 'string' ? exp : null
if (expPath && !existsSync(join(ROOT, expPath))) problems.push('exports["."] 指向的文件不存在：' + expPath)

// ── 3. files 清单与实际文件对得上 ───────────────────────────────────
const files = Array.isArray(pkg.files) ? pkg.files : null
if (!files) {
  notes.push('package.json 未声明 files：npm pack 会把不该进包的东西一起打进去（含测试与脚本）')
} else {
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) problems.push('files 里声明的路径不存在：' + f)
  }
}

// ── 4. lib/ 下的每个文件都必须被 files 覆盖（否则打包会漏文件）──────
const libFiles = walk(join(ROOT, 'lib')).map((f) => 'lib/' + f)
if (files) {
  const covered = (rel) => files.some((f) => rel === f || rel.startsWith(f.replace(/\/$/, '') + '/'))
  const missing = libFiles.filter((f) => !covered(f))
  if (missing.length > 0) problems.push('lib/ 下有文件未被 files 覆盖（打包会漏）：' + missing.join(', '))
}

// ── 5. 版本一致性：README / 代码内版本常量 / package.json ──────────
const readmePath = join(ROOT, 'README.md')
if (!existsSync(readmePath)) notes.push('缺 po06/README.md（发布时应说明版本、已验证项、未验证项、回滚方式）')
else {
  const rmd = readFileSync(readmePath, 'utf8')
  if (!rmd.includes(pkg.version)) notes.push('README 里没有出现当前版本号 ' + pkg.version)
}

// ── 6. 模块契约版本常量（不是包版本，但必须存在且可读）─────────────
const contractVersions = {}
for (const [name, rel] of Object.entries({
  interpreter: 'lib/interpreter.js',
  verifierHtml: 'lib/verifier-html.js',
})) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) { problems.push('缺模块：' + rel); continue }
  const src = readFileSync(p, 'utf8')
  const m = src.match(/version:\s*'([^']+)'/) || src.match(/VERSION\s*=\s*'([^']+)'/)
  contractVersions[name] = m ? m[1] : null
  if (!m) notes.push(rel + ' 没有可识别的版本常量（审计时需要知道用的是哪一版契约）')
}

// ── 7. 全量测试 ─────────────────────────────────────────────────────
const testDir = join(ROOT, 'test')
/**
 * 从末尾往前找一个可解析的 JSON 对象（自研 runner 的约定是"最后打印一行 JSON"，
 * 但中间可能夹着别的输出）。找不到返回 null。
 */
function lastJsonObject(text) {
  const t = String(text || '').trim()
  if (!t) return null
  const asObject = (s) => {
    try { const v = JSON.parse(s); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null } catch { return null }
  }
  // ① 整段就是那个 JSON。**必须认多行美化**：自研 runner 打印的是 `JSON.stringify(x, null, 2)`，
  //    只认单行会把原本能过的套件判成"无法解析"（第一版就踩了这个自伤）。
  const whole = asObject(t)
  if (whole) return whole
  // ② 前后夹着别的输出（进度行、警告）⇒ 从后往前的每个 `{` 起试一次，取第一个能解析出对象的。
  for (let i = t.length - 1, tries = 0; i >= 0 && tries < 40; i--) {
    if (t[i] !== '{') continue
    tries += 1
    const v = asObject(t.slice(i))
    if (v) return v
  }
  return null
}
/**
 * 读出一套测试的自述结果（issue #26）。
 *
 * 为什么不能只认 `JSON.parse(stdout)`：仓库里**并存两种套件风格** ——
 *   ① 自研 runner（结束时打印一行 JSON：`{pass,fail,skipped,failures}`）；
 *   ② `node:test`（打印 `ℹ pass 12` / `ℹ fail 0` 这类汇总行）。
 * 发版门原先只认 ①，于是所有 ② 的套件一律被记成"输出无法解析"并入阻断项，
 * 门恒为 FAIL（报告者现场：43 项阻断里 38 项是这个）。
 * 现在两种都认；**都不认**才记 unparsable（并保留 exit 供定位）。
 * @param {string} stdout 子进程 stdout
 * @returns {{pass:number,fail:number,skipped:number,failures?:Array,runner?:string}|null}
 */
function readSuiteSummary(stdout) {
  const text = String(stdout || '')
  const j = lastJsonObject(text)
  if (j && typeof j.pass === 'number' && typeof j.fail === 'number') {
    return { pass: j.pass, fail: j.fail, skipped: j.skipped || 0, failures: j.failures || [], runner: 'custom' }
  }
  // node:test / TAP：`ℹ pass 12`、`# pass 12`（前后可能有空格）
  const num = (label) => {
    const m = text.match(new RegExp('^[\\s#\u2139]*' + label + '\\s+(\\d+)\\s*$', 'm'))
    return m ? Number(m[1]) : null
  }
  const pass = num('pass')
  const fail = num('fail')
  if (pass === null || fail === null) return null
  return { pass, fail, skipped: num('skipped') || 0, runner: 'node:test' }
}

const suites = existsSync(testDir)
  ? readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort()
  : []
const testResults = {}
const testFailures = []
for (const s of suites) {
  const r = spawnSync(process.execPath, [join(testDir, s)], { encoding: 'utf8', cwd: REPO, maxBuffer: 2e7 })
  const sum = readSuiteSummary(r.stdout)
  if (sum === null) {
    testResults[s] = { error: 'unparsable-output', exit: r.status }
    testFailures.push(s + ' → 输出无法解析（exit=' + r.status + '）')
    continue
  }
  testResults[s] = { pass: sum.pass, fail: sum.fail, skipped: sum.skipped, runner: sum.runner }
  if (sum.fail > 0) {
    testFailures.push(s + ' → ' + sum.fail + ' 失败'
      + (sum.failures && sum.failures.length ? '：' + sum.failures.map((f) => f.name || f).join('; ') : ''))
  } else if (r.status !== 0) {
    // 自述 fail=0 却非零退出（崩溃/未捕获异常）：不能因为"读得到数字"就放过
    testFailures.push(s + ' → 退出码 ' + r.status + '（自述 fail=0，按失败处理）')
  }
}
if (testFailures.length > 0) problems.push(...testFailures.map((t) => '测试失败：' + t))

// 变异检验单独跑（更慢，但它是"测试会不会咬人"的唯一证据）
const mutPath = join(testDir, 'mutate-check.cjs')
let mutation = null
if (existsSync(mutPath)) {
  const r = spawnSync(process.execPath, [mutPath], { encoding: 'utf8', cwd: REPO, maxBuffer: 2e7 })
  try {
    // 同一读法：runner 的最后一行 JSON（前面可能夹着进度输出，见 readSuiteSummary 的说明）
    const j = lastJsonObject(r.stdout)
    if (!j) throw new Error('unparsable-output')
    if (j.error && !Array.isArray(j.mutants)) {
      mutation = { error: j.error, testFile: j.testFile || null, exit: r.status, detail: j.baseline || j.files || null }
      problems.push('变异检验未能运行：' + j.error + (j.testFile ? ' (' + j.testFile + ')' : '')
        + (mutation.detail ? ' ' + JSON.stringify(mutation.detail).slice(0, 600) : ''))
    } else {
      // Missing anchors never ran; syntax/runner errors are not surviving mutants.
      const missedAll = j.mutants.filter((m) => m.caught !== true && !m.skipped)
      const anchorMissing = missedAll.filter((m) => m.status === 'ANCHOR-MISSING').map((m) => m.name)
      const invalid = missedAll.filter((m) => m.status && m.status !== 'ANCHOR-MISSING').map((m) => ({ name: m.name, status: m.status, detail: m.detail }))
      const escaped = missedAll.filter((m) => !m.status).map((m) => m.name)
      mutation = { total: j.mutants.length, sourceFiles: j.sourceFiles || null, missed: missedAll.map((m) => m.name),
        skipped: (j.skippedByPlatform || []), anchorMissing, invalid, escaped, verdict: j.verdict }
      if (anchorMissing.length > 0) problems.push('变异锚点已失效：' + anchorMissing.join(', '))
      if (invalid.length > 0) problems.push('变异执行错误：' + invalid.map((m) => m.name + ' (' + m.status + ')').join(', '))
      if (escaped.length > 0) problems.push('变异未被执行捕获：' + escaped.join(', '))
      if (r.status !== 0 && missedAll.length === 0) problems.push('变异检验退出异常（exit=' + r.status + '）：' + String(j.verdict || ''))
    }
  } catch {
    mutation = { error: 'unparsable-output', exit: r.status }
    problems.push('变异检验输出无法解析（exit=' + r.status + '）')
  }
}

// ── 7a. turn305 parity 参考树（issue #36）──────────────────────────
// 那套对比依赖作者本机重建的 turn305 快照（.po06-tmp/exact-turn305，**不在仓库里**）。
// 测试在缺它时会整份跳过（干净检出/CI 不再因为加载期抛错而判红），
// 但**发版不能靠跳过的检查过关** ⇒ 发版门在这里要求它存在并给出重建提示。
{
  const refCandidates = [join(REPO, '.po06-tmp', 'exact-turn305'), join(REPO, '..', 'exact-turn305')]
  const refFound = refCandidates.find((p) => existsSync(join(p, 'po06', 'lib', 'optimizer-protocol.js')))
  if (refFound) notes.push('turn305 parity 参考树就位：' + refFound)
  else if (strict) problems.push('缺 turn305 parity 参考树（.po06-tmp/exact-turn305）：发版必须补回（见 docs/ROUND305-RESTORATION.md）')
  else notes.push('turn305 parity 参考树不在本机：该套件跳过（CI 正常；发版用 --strict 要求它存在）')
}

// ── 7b. 打包产物自足性（EV-0110）────────────────────────────────────
// 为什么进发版门：这条演练**红了好几轮却没人知道**——因为没有任何东西会跑它。
// **一个没人跑的检查不是检查。** 它只要约 1 秒（npm pack + tar + 仓库外 import）。
let packaging = null
const drillPath = join(ROOT, 'scripts', 'install-drill.mjs')
if (existsSync(drillPath)) {
  const r = spawnSync(process.execPath, [drillPath], { encoding: 'utf8', cwd: REPO, maxBuffer: 2e7 })
  try {
    const j = lastJsonObject(r.stdout)
    if (!j) throw new Error('unparsable-output')
    packaging = { ok: j.ok === true, exit: r.status, verdict: j.verdict }
    if (!packaging.ok) {
      problems.push('打包产物自足性演练未通过：' + String(j.verdict || '').slice(0, 160))
    }
  } catch {
    packaging = { error: 'unparsable-output', exit: r.status }
    problems.push('打包演练输出无法解析（exit=' + r.status + '）')
  }
}

// ── 0) 清扫陈旧临时目录（EV-0129）────────────────────────────────────
// 单测 fixture 靠 `process.on('exit')` 清理，而**进程被强杀时它不会跑**——
// "强杀"在本项目里是**我自己反复犯的操作习惯**（把测试输出管道给会提前关闭管道的消费者）。
// 归因清楚了就用机制兜：开跑前清掉 tmpdir 里够旧的、我们自己的前缀（10 分钟以上，
// 绝不碰正在跑的测试）。清扫失败**不算阻断**（它只是磁盘卫生）。
let tempSweep = null
try {
  const { sweepStaleTemp } = await import('../lib/temp-sweep.js')
  tempSweep = sweepStaleTemp()
  if (tempSweep.removed.length > 0) {
    console.log('清扫陈旧临时目录：' + tempSweep.removed.length + ' 个（' + tempSweep.removed.slice(0, 5).join(', ')
      + (tempSweep.removed.length > 5 ? ', …' : '') + '）')
  }
  if (tempSweep.errors.length > 0) notes.push('临时目录清扫有 ' + tempSweep.errors.length + ' 处失败（不影响判定）')
} catch (e) {
  notes.push('临时目录清扫跳过：' + String((e && e.message) || e).slice(0, 120))
}

// 文档漂移（EV-0103）：状态类文档里的数字必须与产物一致。
// 为什么放进发版门：本项目**反复**出现"文档写了过期数字"（测试数、变异数、预算都出过），
// 而每次都是靠人偶然看到才修——那等于没有保障。
// 只查 README / 发布检查表 / S1 报告；**EVIDENCE 与 CHECKPOINT 是逐轮日志**，
// 里面的旧数字是**正确的历史记录**，不属漂移（口径见 check-docs.mjs 头部）。
let docs = null
const docPath = join(ROOT, 'scripts', 'check-docs.mjs')
if (existsSync(docPath)) {
  // 把**本轮**实测计数传进去：否则 check-docs 比的是 release-check.json 里**上一轮**的值，
  // 本次刚涨上去的计数当轮查不出来（EV-0107，本轮真的撞上：门禁 PASS 而文档已过期）。
  const passTotal = Object.values(testResults).reduce((s, t) => s + (t.pass || 0), 0)
  // lib 模块数也由门**自己数**再传（EV-0132）：这份数字在 README 里漂过（22 → 27）没人发现。
  const libModules = existsSync(join(ROOT, 'lib'))
    ? readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).length
    : 0
  const r = spawnSync(process.execPath, [docPath, '--strict',
    '--suites', String(suites.length),
    '--pass', String(passTotal),
    '--mutants', String((mutation && mutation.total) || 0),
    '--source-files', String((mutation && mutation.sourceFiles) || 0),
    '--lib-modules', String(libModules)], { encoding: 'utf8', cwd: REPO, maxBuffer: 2e7 })
  docs = { ok: r.status === 0, exit: r.status,
    output: String(r.stdout || '').split('\n').filter(Boolean).slice(0, 14) }
  if (r.status !== 0) {
    problems.push('文档数字与产物不一致（跑 `node po06/scripts/check-docs.mjs` 看明细；'
      + '若那处属于**历史叙述**而非现状说明，请改写措辞，而不要关掉这个检查）')
  }
}

// ── 8. 产物哈希清单 ─────────────────────────────────────────────────
const manifest = {
  at: new Date().toISOString(),
  package: { name: pkg.name, version: pkg.version },
  contractVersions,
  files: {},
}
for (const f of libFiles) manifest.files[f] = { sha256: shaFile(join(ROOT, f)), bytes: statSync(join(ROOT, f)).size }
manifest.packageJsonSha256 = shaFile(pkgPath)
manifest.tests = testResults
manifest.mutation = mutation
manifest.packaging = packaging
manifest.docs = docs
manifest.problems = problems
manifest.notes = notes
manifest.ok = problems.length === 0

const outDir = join(ROOT, 'eval')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'release-check.json'), JSON.stringify(manifest, null, 2), 'utf8')

function report() {
  if (asJson) { console.log(JSON.stringify(manifest, null, 2)); process.exit(manifest.ok ? 0 : 1) }
  console.log('=== 0.6 发版前自检 ===')
  console.log('包：' + pkg.name + ' @ ' + pkg.version)
  const totalPass = Object.values(testResults).reduce((s, r) => s + (r.pass || 0), 0)
  const totalFail = Object.values(testResults).reduce((s, r) => s + (r.fail || 0), 0)
  console.log('测试：' + suites.length + ' 套 / pass ' + totalPass + ' / fail ' + totalFail)
  if (mutation && !mutation.error) console.log('变异：' + mutation.total + ' 个 / 漏捕 ' + mutation.missed.length)
  if (packaging) console.log('打包自足：' + (packaging.ok ? 'PASS' : 'FAIL') + (packaging.verdict ? '——' + String(packaging.verdict).slice(0, 90) : ''))
  if (notes.length > 0) { console.log('\n--- 提示 ---'); for (const n of notes) console.log('· ' + n) }
  if (problems.length > 0) {
    console.log('\n--- 阻断项 ---')
    for (const p of problems) console.log('✗ ' + p)
    // 文档门失败时**把明细打出来**：只写"跑一下 check-docs 看明细"等于让下一个人重跑 10 分钟门禁
    // 才知道哪里红了（本轮实测：文档门在门禁里红、单独跑却绿，没有明细就查不下去）。
    if (docs && !docs.ok && Array.isArray(docs.output) && docs.output.length > 0) {
      console.log('\n--- 文档门的原始输出（末尾 ' + docs.output.length + ' 行）---')
      for (const line of docs.output) console.log('  ' + line)
    }
  }
  console.log('\n判定：' + (manifest.ok ? 'PASS（可进入打包）' : 'FAIL（' + problems.length + ' 项阻断）'))
  console.log('清单已写入 po06/eval/release-check.json')
  process.exit(manifest.ok ? 0 : 1)
}
report()
