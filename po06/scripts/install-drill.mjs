// P8 · 打包产物装配演练（release action D3 + A11）
//
//   node po06/scripts/install-drill.mjs [--keep]
//
// 为什么需要它：此前所有验证都跑在**源码树**上（`po06/lib/...`），
// 而真正会发出去的是 `npm pack` 出来的 tgz。两者不是一回事：
//   · `files` 清单若漏了某个被 require 的模块 ⇒ 源码树全绿，装出来直接崩；
//   · 源码树里 test/ eval/ scripts/ 都在，装了之后**不在**——
//     若 lib 里偷偷依赖了它们，源码树永远查不出来。
// 所以本演练只做一件事：**只拿打包产物**，在仓库之外装配一次。
//
// 步骤：pack → 解包到隔离目录 → 内容集合核对 → **从仓库外动态 import** →
//       源树字节未变核对 → 报告。宿主侧注入/卸载由 dev_* 工具在本脚本之外完成。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')            // po06/
const REPO = join(ROOT, '..')            // 仓库根
const KEEP = process.argv.includes('--keep')
const DRILL = join(tmpdir(), 'po06-install-drill')

const report = { probe: 'po06-install-drill', phase: 'P8', at: new Date().toISOString(), steps: {}, ok: false }

function walk(dir, base = dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p, base))
    else out.push(relative(base, p).replace(/\\/g, '/'))
  }
  return out.sort()
}

/** 源树在演练前后的快照（用来证明演练没有偷偷改源码）。 */
function sourceSnapshot() {
  const files = ['lib', 'package.json', 'README.md']
  const snap = {}
  for (const f of files) {
    const p = join(ROOT, f)
    if (!existsSync(p)) continue
    if (statSync(p).isDirectory()) {
      for (const rel of walk(p, ROOT)) {
        if (rel.startsWith(f + '/')) snap[rel] = createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex')
      }
    } else {
      snap[f] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  return snap
}

try {
  const before = sourceSnapshot()

  // ── 1. pack ────────────────────────────────────────────────────────
  rmSync(DRILL, { recursive: true, force: true })
  mkdirSync(DRILL, { recursive: true })
  // 在隔离目录里 pack（把 tgz 放在隔离目录，避免污染仓库）
  // 沙箱/CI 里 npm 默认会往 ~/.npm 与 %LOCALAPPDATA% 写缓存与日志，被拒时不是"包坏了"，
  // 而是"npm 没地方写"；另外离线机器上 npm 可能去问 registry 而挂住。两项都就地兜住。
  const npmEnv = { ...process.env,
    npm_config_cache: join(DRILL, '.npm-cache'),
    npm_config_tmp: DRILL,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false' }
  execFileSync('npm', ['pack', '--pack-destination', DRILL, '--silent'], { cwd: ROOT, stdio: 'pipe', shell: true, env: npmEnv })
  const tgzName = readdirSync(DRILL).find((n) => n.endsWith('.tgz'))
  if (!tgzName) throw new Error('npm pack 没有产出 tgz')
  const tgzPath = join(DRILL, tgzName)
  const tgzSha = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
  report.steps.pack = { tgz: tgzName, bytes: statSync(tgzPath).size, sha256: tgzSha }

  // ── 2. 解包到隔离目录 ──────────────────────────────────────────────
  const ext = join(DRILL, 'extracted')
  mkdirSync(ext, { recursive: true })
  // ⚠ Windows 上不能把 `C:\...` 直接交给 GNU tar：它会把 `C:` 当远端主机
  //   （"tar (child): Cannot connect to C: resolve failed"）。统一换成 / 分隔。
  const posix = (q) => (process.platform === 'win32' ? String(q).split(String.fromCharCode(92)).join('/') : String(q))
  // --force-local：GNU tar 会把 `C:` 当远端主机，即使换成 / 也一样，必须显式关掉
  const tarArgs = (process.platform === 'win32' ? ['--force-local'] : []).concat(['-xzf', posix(tgzPath), '-C', posix(ext)])
  execFileSync('tar', tarArgs, { stdio: 'pipe' })
  const pkgDir = join(ext, 'package')
  const files = walk(pkgDir)
  report.steps.content = { count: files.length, files }

  // ── 3. 内容集合核对：tgz 里只应有 `package.json` + `files` 声明的东西 ──────
  // `cordis.patch.yml` 是 **bundle 层**：没有它，`dsh plugin add` 会打印
  // "declares no dsh.bundle — installed as a plain dependency, **not a profile layer**"
  // ⇒ 装上了却**永远不会被装配**（EV-0066）。所以它必须随包发行，也必须在这里被认下来。
  // ⚠ 允许清单**从 package.json 的 `files` 推导**，不再写死（EV-0109）：
  // 写死的版本已经错过**两次**——加 bundle 层时漏了 `cordis.patch.yml`，
  // 加题集时漏了 `eval/HOLDOUT-*.md`；两次都是"重跑演练时如实报红"才发现。
  // 现在的不变量是：**tgz 只包含 `files` 声明的东西**——声明改了，这里自动跟上。
  const declared = (() => {
    try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files || [] } catch { return [] }
  })()
  const ALLOWED = (f) => f === 'package.json' || declared.some((d) => (
    d.endsWith('/') ? f.startsWith(d)
      : f === d || (!d.includes('.') && f.startsWith(d + '/'))
  ))
  const bad = files.filter((f) => !ALLOWED(f))
  const libCount = files.filter((f) => /^lib\/.*\.js$/.test(f)).length
  report.steps.contentCheck = {
    onlyDeclared: bad.length === 0, unexpected: bad, libCount, declared,
    hasBundleLayer: files.includes('cordis.patch.yml'),
    hasTestDir: files.some((f) => f.startsWith('test/')),
    hasScriptsDir: files.some((f) => f.startsWith('scripts/')),
    hasEvalDir: files.some((f) => f.startsWith('eval/')),
    // ⚠ 这里曾经写的是 `!hasEvalDir`（"不许夹带 eval/"），**意图对、粒度错**：
    // 报告 / 答案 / 计划（`E001-S1-ANSWERS.md`、`plan-E001.json`…）绝不该进包——
    // 但**留出集必须进包**：`runE001` 要在**装出来的**插件里找到它
    // （首轮真机自检就撞到"装出来的插件里找不到题集"）。
    // 于是这条断言从"整个 eval/ 都不许"变成精确不变量：**eval/ 下只允许封存的题集**。
    // 实测后果：留着旧写法时，装了题集的包一律判红——而**没人重跑过演练**，
    // 于是它红了好几轮没人知道（EV-0110）。
    evalFiles: files.filter((f) => f.startsWith('eval/')),
    hasStrayEvalFiles: files.some((f) => f.startsWith('eval/') && !/^eval\/HOLDOUT-v\d+\.md$/.test(f)),
    // 题集必须随包发行：`runE001` 在**装出来的**插件里要能找到它（EV-0066 同类）
    hasHoldout: files.some((f) => /^eval\/HOLDOUT-v\d+\.md$/.test(f)),
  }

  // ── 4. 从**仓库之外**动态 import：证明包是自足的 ────────────────────
  //     cwd 设在隔离目录，且只给解包出来的这一份代码。
  const entry = 'file:///' + join(pkgDir, 'lib', 'index.js').replace(/\\/g, '/')
  let imported = null
  try {
    const mod = await import(entry)
    imported = { ok: true, exports: Object.keys(mod).sort() }
  } catch (e) {
    imported = { ok: false, error: String((e && e.message) || e) }
  }
  report.steps.standaloneImport = imported

  // ── 5. 源树未变 ────────────────────────────────────────────────────
  const after = sourceSnapshot()
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k])
  report.steps.sourceUnchanged = { ok: changed.length === 0, changed }

  // ── 判定 ───────────────────────────────────────────────────────────
  report.ok = report.steps.contentCheck.onlyDeclared
    && !report.steps.contentCheck.hasTestDir
    && !report.steps.contentCheck.hasScriptsDir
    && !report.steps.contentCheck.hasStrayEvalFiles   // eval/ 只允许封存题集（EV-0110）
    && report.steps.contentCheck.hasBundleLayer      // bundle 层必须在包里（EV-0066）
    && report.steps.contentCheck.hasHoldout          // 题集必须在包里（runE001 要用）
    && libCount > 0
    && imported.ok
    && report.steps.sourceUnchanged.ok
  report.verdict = report.ok
    ? `PASS: 打包产物自足——${libCount} 个 lib 模块 + package.json + README + cordis.patch.yml + 封存题集，`
      + '仓库外可直接 import；未夹带 test/、scripts/、题集之外的 eval 文件；源树字节未变'
    : 'CHECK: 见各步骤字段'
  report.packageDir = pkgDir
} catch (e) {
  report.error = String((e && e.stack) || e)
  report.verdict = 'ERROR: ' + String((e && e.message) || e)
} finally {
  writeFileSync(join(ROOT, 'eval', 'install-drill.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
  if (!KEEP) {
    try { rmSync(DRILL, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

console.log(JSON.stringify({
  ok: report.ok, verdict: report.verdict,
  pack: report.steps.pack, contentCheck: report.steps.contentCheck,
  standaloneImport: report.steps.standaloneImport,
  sourceUnchanged: report.steps.sourceUnchanged,
  kept: KEEP, packageDir: KEEP ? report.packageDir : null,
  written: 'po06/eval/install-drill.json',
}, null, 2))
process.exit(report.ok ? 0 : 1)
