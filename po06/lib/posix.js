// dsh-prompt-optimizer 0.6.11 · **虚拟 POSIX 语义层**（模型写 bash，插件按语义执行）
//
// 为什么要有这一层（用户 2026-09-24）：
//   "模型表现在 wsl 往往远大于 pwsh，即 linux 环境远比 windows 环境更适合 ai"。
//   机制上有四条通路，其中两条是结构性的：① 模型最有把握的工具语料是 POSIX
//   （`grep`/`sed`/`awk`/`find`），而 Windows 上这些多半不存在；② 沙箱在新宿主上**不允许派生任何子进程**
//   （本会话实测：46 个套件全部 `exit=null` + `Access is denied`）。
//   ⇒ 与其让模型猜 PowerShell 方言（每次都撞墙、每次都要来回 2–3 轮才能定性），
//   不如**让模型继续按它最强的那套语料表达**，由我们用**纯 JS**按语义执行，各平台给同一结果。
//
// ── 三条边界（写在这里，免得被当成"半个 shell"）─────────────────────────
//   ① **只读**：写类命令与重定向**一律显式拒绝**。需要写就走宿主自己的工具，不走这里。
//   ② **不翻译**：**不**把命令翻译成 PowerShell/cmd（那条路既不可靠、又把语义交给方言）。
//   ③ **超出子集就明说失败**，并回一份支持清单——绝不静默退化（本项目纪律）。
//
// 纯函数为主：解析（`parsePosix`）不碰 IO，执行（`runPosix`）只经 `fs` 只读调用。

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 支持的词汇表（会让模型知道能用什么，也是拒绝信息里的清单）。 */
export const SUPPORTED_COMMANDS = Object.freeze([
  'ls', 'cat', 'grep', 'find', 'head', 'tail', 'wc', 'pwd', 'echo',
])
/** 支持的联结符：`&&` `||` `;` 与管道 `|`（管道按**行**过滤）。 */
export const SUPPORTED_OPERATORS = Object.freeze(['&&', '||', ';', '|'])
/** 明确拒绝的写/危险类命令（拒绝信息里点名，避免模型反复试）。 */
export const REFUSED_COMMANDS = Object.freeze([
  'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'dd', 'tee', 'truncate',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'git', 'npm', 'pnpm', 'yarn', 'node', 'python', 'python3',
  'sh', 'bash', 'pwsh', 'powershell', 'cmd', 'sudo', 'apt', 'brew', 'pip', 'make', 'docker', 'kubectl',
])
/** 输出上限（与 read-tools 的其它工具同一个量级，避免一次刷爆上下文）。 */
export const POSIX_MAX_LINES = 120
export const POSIX_MAX_CHARS = 6000
/** 单次运行最多几条命令（防"把 shell 当脚本宿主"）。 */
export const POSIX_MAX_COMMANDS = 8

const REFUSE_PREFIX = '拒绝：'

/** 统一结果形状（与 read-tools 的 ok/reject 对齐）。 */
function ok(text) { return { ok: true, rejected: false, text: String(text) } }
function reject(text) { return { ok: false, rejected: true, text: REFUSE_PREFIX + String(text) } }

/**
 * 把命令串切成 **词**（处理单引号、双引号与反斜杠转义）。
 * 不做变量展开、不做命令替换——那些超出了"只读子集"，遇到就让调用方拒绝。
 */
export function tokenize(input) {
  const s = String(input == null ? '' : input)
  const out = []
  let cur = ''
  let quote = null
  let started = false
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) { quote = null; continue }
      if (quote === '"' && ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 1; continue }
      cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue }
    if (ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 1; started = true; continue }
    if (ch === ' ' || ch === '\t') { if (started) { out.push(cur); cur = ''; started = false } continue }
    cur += ch
    started = true
  }
  if (quote) return { ok: false, reason: '引号没有闭合' }
  if (started) out.push(cur)
  return { ok: true, tokens: out }
}

/** 把命令串切成**条**与它们之间的联结符（保留管道）。`op` 表示"**这条前面**的联结符"。 */
function splitCommands(input) {
  const s = String(input == null ? '' : input)
  const parts = []
  let cur = ''
  let quote = null
  let pendingOp = null
  const push = () => {
    const text = cur.trim()
    if (text) parts.push({ text, op: pendingOp })
    cur = ''
    pendingOp = null
  }
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (quote) {
      cur += ch
      if (ch === quote && s[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue }
    if (ch === '\n') { push(); continue }
    const two = s.slice(i, i + 2)
    if (two === '&&' || two === '||') { push(); pendingOp = two; i += 1; continue }
    if (ch === ';') { push(); pendingOp = ';'; continue }
    cur += ch
  }
  push()
  return parts
}

/** 认识但**明确不解析**的 shell 语法（重定向、变量、命令替换、后台、通配扩展）。 */
function findUnsupportedSyntax(text) {
  const s = String(text)
  if (/>|>>|<</.test(s)) return '重定向（> / >> / <<）不在只读子集里'
  if (/\$\(|`/.test(s)) return '命令替换（$(…) 或 反引号）不在只读子集里'
  if (/\$\{?[A-Za-z_]/.test(s)) return '变量展开（$VAR）不在只读子集里'
  if (/(^|\s)&\s*$/.test(s)) return '后台执行（&）不在只读子集里'
  return null
}

/**
 * 解析一条命令串 → `{ ok, pipeline: [ { name, args, flags } … ], op }` 列表。
 * **纯函数**（不碰文件系统），便于单测把"支持/拒绝的边界"钉死。
 * @returns {{ok:boolean, reason?:string, steps?:Array<{op:string|null, pipeline:Array<{name:string,args:string[],flags:object}>}>}}
 */
export function parsePosix(input) {
  const bad = findUnsupportedSyntax(input)
  if (bad) return { ok: false, reason: bad }
  const parts = splitCommands(input)
  if (parts.length > POSIX_MAX_COMMANDS) {
    return { ok: false, reason: '一次最多 ' + POSIX_MAX_COMMANDS + ' 条命令（这次 ' + parts.length + ' 条）' }
  }
  const steps = []
  for (const p of parts) {
    if (!p.text) continue
    const pipeline = []
    for (const seg of p.text.split('|')) {
      const t = tokenize(seg)
      if (!t.ok) return { ok: false, reason: t.reason }
      const words = t.tokens
      if (words.length === 0) continue
      const name = words[0]
      if (!SUPPORTED_COMMANDS.includes(name)) {
        const why = REFUSED_COMMANDS.includes(name)
          ? '「' + name + '」不在只读子集里（这一层只做查证，不做改动）'
          : '不支持的命令「' + name + '」'
        return { ok: false, reason: why + '。支持：' + SUPPORTED_COMMANDS.join(' / ') }
      }
      const args = []
      const flags = {}
      const rest = words.slice(1)
      for (let wi = 0; wi < rest.length; wi += 1) {
        const w = rest[wi]
        // `-n12`（紧贴）与 `-n 12`（分开）两种写法都要认——实测模型两种都会写。
        const inline = /^-n(\d+)$/.exec(w)
        if (inline) { flags.n = true; flags.nValue = Number(inline[1]); continue }
        if (w === '-n') {
          flags.n = true
          const next = rest[wi + 1]
          if (next !== undefined && /^\d+$/.test(next)) { flags.nValue = Number(next); wi += 1 }
          continue
        }
        if (w.startsWith('-') && w.length > 1) { for (const c of w.slice(1)) flags[c] = true; continue }
        args.push(w)
      }
      pipeline.push({ name, args, flags })
    }
    if (pipeline.length > 0) steps.push({ op: p.op, pipeline })
  }
  if (steps.length === 0) return { ok: false, reason: '空命令' }
  return { ok: true, steps }
}

// ── 执行（只读）─────────────────────────────────────────────────────────

function inside(root, p) {
  const raw = p === undefined || p === null || p === '' ? '.' : String(p)
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(String(root), raw)
  const base = resolve(String(root))
  if (abs !== base && !abs.startsWith(base + sep)) return null
  // ⚠ **realpath 复核**：只有词法比较时，工作区里的 junction / symlink 能把读取带到工作区外
  //   （2026-10-06 实测复现：工作区内的 junction 指向系统目录后，posix 的 head 直接读出了 workspace 外的文件）。
  //   read-tools.js 早就是「词法 + realpath 双校验」，这里补齐，两条路径才能同等严格。
  //   realpath 失败（目标不存在等）时以词法结论为准，与 read-tools 的既有纪律一致。
  try {
    const realBase = realpathSync(base)
    const realAbs = realpathSync(abs)
    if (realAbs !== realBase && !realAbs.startsWith(realBase + sep)) return null
  } catch { /* 目标不可解析 ⇒ 以词法校验为准 */ }
  return abs
}

function relPosix(root, abs) { return relative(String(root), abs).split('\\').join('/') }

/** 递归列文件（与 read-tools 的遍历同源：跳过 node_modules/.git 等噪声目录）。 */
function walk(root) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'evidence'])
  const out = []
  const visit = (dir, depth) => {
    if (depth > 6 || out.length > 4000) return
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) visit(abs, depth + 1) } else if (e.isFile()) out.push(abs)
    }
  }
  visit(String(root), 0)
  return out
}

function simpleGlobToRegExp(pat) {
  const esc = String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + esc.split('*').join('[^/]*').split('?').join('.') + '$')
}

/** 内容读取的上限（超过就不读——只读子集不为大文件服务）。 */
export const READ_LIMIT_BYTES = 200 * 1024

/**
 * 读一个小文本文件 → `{ lines }` 或 `{ error }`。**失败必须能被分辨**（2026-09-24 真机事故）。
 *
 * 事故：模型按 WSL 习惯写了 `wc -c mbt-m1a2.html`（871KB），撞上内容读取上限，回话只有一句
 * 「wc 读不到：mbt-m1a2.html」。**模型分不清"文件不存在"和"文件太大"**，只能把这次失败归因到
 * "这工具不好使"——然后继续用 pwsh。含糊的失败 = 把工具从模型的选择里删掉。
 * 所以这里把四类分开：不存在 / 不是普通文件 / 不是文本 / **过大（带实际字节数与上限）**。
 * 另外：元数据类查询（`wc -c`）**根本不该走这条路径**，见 wc 分支。
 *
 * @param abs   绝对路径
 * @param cmd   命令名（用于前缀，让模型知道是哪条命令失败）
 * @param shown 展示用文件名（相对路径原样回给模型）
 */
function readText(abs, cmd, shown) {
  let info
  try { info = statSync(abs) } catch { return { error: cmd + ' 不存在：' + shown } }
  if (!info.isFile()) return { error: cmd + ' 不是普通文件（目录？）：' + shown }
  if (info.size > READ_LIMIT_BYTES) {
    return { error: cmd + ' 文件过大：' + info.size + ' 字节 > 只读子集上限 ' + READ_LIMIT_BYTES + ' 字节（' + shown
      + '）——只读子集只读小文件；要看大小请用 `wc -c`，要处理大文件请改用 bash（需要 PowerShell 对象语义时才用 pwsh）' }
  }
  let text
  try { text = readFileSync(abs, 'utf8') } catch (e) { return { error: cmd + ' 读取失败：' + String((e && e.message) || e) } }
  if (text.indexOf('\u0000') >= 0) return { error: cmd + ' 不是文本文件（含 NUL 字节）：' + shown }
  return { lines: normalizeLines(text.split('\n')) }
}

/**
 * 行数组规范化：**去掉结尾换行造成的那一个空元素**。
 * 为什么必须做（实测）：文件几乎都以 `\n` 结尾，`'a\nb\n'.split('\n')` = `['a','b','']`，
 * 于是 `tail -1` 会返回**空行**、`wc -l` 会多算一行——两者都不符合 POSIX 语义。
 * 注意不能因此丢掉"最后一行确实是空行"的情形：那种文件是 `a\nb\n\n`，末元素仍会被保留一个。
 */
function normalizeLines(lines) {
  const out = Array.isArray(lines) ? lines.slice() : []
  if (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}

/** 执行一条命令（`paths` 为上游管道的文件清单；`lines` 为上游的行清单）。 */
function execOne(root, cmd, input) {
  const { name, args, flags } = cmd
  const first = args[0]
  if (name === 'pwd') return ok(String(root))
  if (name === 'echo') {
    const text = args.join(' ')
    if (input && input.lines) return ok(input.lines.filter((l) => text === '' || l.includes(text)).join('\n'))
    return ok(text)
  }
  if (name === 'ls') {
    const abs = inside(root, first)
    if (!abs) return reject('路径越出项目范围')
    let ents = []
    try {
      ents = readdirSync(abs, { withFileTypes: true })
        .filter((e) => flags.a || !e.name.startsWith('.'))
        .map((e) => e.name + (e.isDirectory() ? '/' : ''))
        .sort()
    } catch (e) { return ok('ls 失败：' + String((e && e.message) || e)) }
    return ok(ents.join('\n') || '(空目录)')
  }
  if (name === 'cat') {
    if (!first) return reject('cat 需要文件名')
    const abs = inside(root, first)
    if (!abs) return reject('路径越出项目范围')
    const rd = readText(abs, 'cat', first)
    if (rd.error) return ok(rd.error)
    const lines = rd.lines
    const body = flags.n ? lines.map((l, i) => String(i + 1).padStart(6) + '\t' + l).join('\n') : lines.join('\n')
    let out = body
    if (input && input.lines) out = out.split('\n').filter((l) => input.lines.some((k) => l.includes(k))).join('\n')
    return ok(out)
  }
  if (name === 'head' || name === 'tail') {
    // 计数优先级：`-n N`（含 `-nN`）> 位置参数里的纯数字 > 默认 10。
    // ⚠ 不能把 `-n2` 这种当文件名——那会让 head/tail 去读一个叫 `-n2` 的文件（首版就错在这）。
    const n = Number(flags.nValue) || Number(args.filter((a) => /^\d+$/.test(a))[0]) || 10
    const file = args.filter((a) => !/^\d+$/.test(a))[0]
    if (!file) {
      // `… | head -n 50` 是最常见的写法：没有文件名时按**管道输入**取前/后 N 行。
      // 以前这里直接拒绝（"head 需要文件名"），而一次拒绝会终止整轮查证——
      // 模型（尤其 ollama 的 ds41f）习惯带 `| head`，于是顾问看起来"读不到东西"。
      if (!input || !Array.isArray(input.lines)) return reject(name + ' 需要文件名（或从管道接收内容，例如 `… | head -n 50`）')
      const piped = input.lines
      const cut = name === 'head' ? piped.slice(0, n) : piped.slice(Math.max(0, piped.length - n))
      return ok(cut.join(String.fromCharCode(10)))
    }
    const abs = inside(root, file)
    if (!abs) return reject('路径越出项目范围')
    const rd = readText(abs, name, file)
    if (rd.error) return ok(rd.error)
    const lines = rd.lines
    const slice = name === 'head' ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n))
    return ok(slice.join('\n'))
  }
  if (name === 'wc') {
    if (!first) return reject('wc 需要文件名')
    const abs = inside(root, first)
    if (!abs) return reject('路径越出项目范围')
    // ⚠ `wc -c` 是**元数据查询**：只要文件大小，`statSync` 就够，**绝不能走内容读取**。
    //   2026-09-24 真机事故：871KB 的 HTML 撞上 200KB 内容上限，`wc -c` 回"读不到"——
    //   而它要的字节数明明拿得到（模型因此把整层判成"不好使"）。顺带修语义：
    //   过去 `-c` 被忽略、返回的是**行数**（模型问大小、拿到行数，静默错答案）。
    if (flags.c) {
      let info
      try { info = statSync(abs) } catch { return ok('wc 不存在：' + first) }
      if (!info.isFile()) return ok('wc 不是普通文件（目录？）：' + first)
      return ok(String(info.size) + ' ' + first)
    }
    const rd = readText(abs, 'wc', first)
    if (rd.error) return ok(rd.error)
    // `wc -w` 数词；默认与 `wc -l` 都数行（保持旧行为，别让默认路径变样）。
    if (flags.w) return ok(String(rd.lines.join(' ').split(/\s+/).filter(Boolean).length) + ' ' + first)
    return ok(String(rd.lines.length) + ' ' + first)
  }
  if (name === 'find') {
    const dirArg = first && !first.startsWith('-') ? first : '.'
    const abs = inside(root, dirArg)
    if (!abs) return reject('路径越出项目范围')
    const nameIdx = args.findIndex((a) => a === '-name' || a === '-iname')
    const pat = nameIdx >= 0 ? args[nameIdx + 1] : null
    if (nameIdx >= 0 && !pat) return reject('find -name 需要模式')
    const rx = pat ? simpleGlobToRegExp(pat) : null
    const files = walk(abs)
    const hits = files
      .map((f) => relPosix(root, f))
      .filter((r) => (rx ? rx.test(r.split('/').pop()) : true))
    if (hits.length === 0) return ok('（无匹配）')
    return ok(hits.slice(0, POSIX_MAX_LINES).join('\n') + (hits.length > POSIX_MAX_LINES ? '\n…（共 ' + hits.length + ' 条，已截断）' : ''))
  }
  if (name === 'grep') {
    const patArg = args.find((a) => !a.startsWith('-'))
    if (!patArg) return reject('grep 需要模式')
    let rx = null
    try { rx = new RegExp(patArg, flags.i ? 'i' : '') } catch (e) { return reject('正则无效：' + String((e && e.message) || e)) }
    const scopeArg = args.filter((a) => !a.startsWith('-'))[1]
    const scopeAbs = inside(root, scopeArg)
    if (!scopeAbs) return reject('路径越出项目范围')
    let files = []
    try { files = existsSync(scopeAbs) && statSync(scopeAbs).isDirectory() ? walk(scopeAbs) : [scopeAbs] } catch { files = [scopeAbs] }
    const hits = []
    // 读不了的文件不许**静默**跳过：至少要能说出为什么（过大/不存在/非文本）。
    const skipped = []
    const showFile = flags.l || files.length > 1 || flags.r
    const showLine = flags.n || flags.l || flags.r
    for (const f of files) {
      if (hits.length >= POSIX_MAX_LINES) break
      const rd = readText(f, 'grep', relPosix(root, f))
      if (rd.error) { skipped.push(rd.error); continue }
      const lines = rd.lines
      const rel = relPosix(root, f)
      for (let i = 0; i < lines.length && hits.length < POSIX_MAX_LINES; i += 1) {
        if (!rx.test(lines[i])) continue
        // 文件:行号:内容 —— 单文件且没要求 `-n`/`-l` 时，照 POSIX 只给内容（别多打印）。
        hits.push((showFile ? rel + ':' : '') + (showLine ? (i + 1) + ':' : '') + lines[i].slice(0, 200))
      }
    }
    if (hits.length === 0) {
      if (skipped.length === 0) return ok('（无匹配）')
      return ok('（无匹配；' + skipped.length + ' 个文件读不了）\n' + skipped.slice(0, 3).join('\n'))
    }
    return ok(hits.join('\n'))
  }
  return reject('内部错误：命令 ' + name + ' 没有执行分支')
}

/**
 * 执行一条 POSIX 命令串（只读）。
 * @param root  项目根（越界一律拒绝）
 * @param input 命令串（可含 `&&` `||` `;` `|`）
 * @returns {{ok:boolean, rejected:boolean, text:string, steps?:number, refusedAt?:string}}
 */
export function runPosix(root, input) {
  const parsed = parsePosix(input)
  if (!parsed.ok) return { ...reject(parsed.reason), refusedAt: 'parse' }
  let failedPrev = false
  const outputs = []
  let steps = 0
  for (const step of parsed.steps) {
    if (step.op === '&&' && failedPrev) continue
    if (step.op === '||' && !failedPrev) continue
    steps += 1
    let carry = null
    let last = null
    for (const cmd of step.pipeline) {
      last = execOne(root, cmd, carry)
      if (!last.ok) return { ...last, steps, refusedAt: cmd.name }
      carry = { lines: String(last.text).split('\n') }
    }
    failedPrev = false
    outputs.push(String(last ? last.text : ''))
  }
  let text = outputs.join('\n')
  const lines = text.split('\n')
  if (lines.length > POSIX_MAX_LINES) text = lines.slice(0, POSIX_MAX_LINES).join('\n') + '\n…（共 ' + lines.length + ' 行，已截断）'
  if (text.length > POSIX_MAX_CHARS) text = text.slice(0, POSIX_MAX_CHARS) + '\n…（已截断）'
  return { ok: true, rejected: false, text, steps }
}

/** 给系统提示词用的说明（模型据此知道"可以用 bash 语法查证"）。 */
export const POSIX_SYSTEM_NOTE = '\n\n【查证（POSIX 语义）】你可以用 `run` 工具，按 **bash/POSIX 语法**查证项目：'
  + '`ls` / `cat` / `grep` / `find` / `head` / `tail` / `wc -l|-c|-w` / `pwd` / `echo`，'
  + '可用 `&&` `||` `;` 串联、用 `|` 按行过滤。'
  + '这一层**只读**（写类命令与重定向一律拒绝），由插件自己实现、**不依赖系统里有没有那些命令**，'
  + '所以在 Windows 和 Linux 上结果一致。'
