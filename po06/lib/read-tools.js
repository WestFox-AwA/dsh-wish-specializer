// P10 步骤 3 · **只读工具循环**（read / glob / grep，给解释层补上"能读项目文件"的能力）。
//
// 为什么单独一个模块：0.6 的解释层是**单次不带工具的补全**（index.js 的 interpretViaLlm），
// 设置里的 `readTools` 字段（settings.js，EV-0148）**没有任何代码读它**。
// 本模块是那个字段的唯一行为落地处：宿主 `GenerateOptions.tools`（dsh-llm 的类型定义
// `ToolSchema`）+ 流里的 `tool-call-delta` / `block-end` 事件 → 执行 → 结果回灌 → 再问一轮。
//
// ── 从 0.5 读懂之后**自己写**的部分（观察点记在这里，免得下次又去翻那份 4094 行）──
//   · 工具调用事件**不是**一个块一次性给的：先 `tool-call-delta`（带 index/id/name/argumentsDelta）
//     增量拼参数，最后 `block-end`（`block.type === 'tool-call'`）给**装配好的** id/name/arguments。
//     只认一边都会出错：只认 delta 会在没有 delta 的适配器上丢调用，只认 block-end 会在
//     分片适配器上拿到半截 JSON。所以两边都收，**block-end 覆盖 delta**（0.5 的做法，验证过）。
//   · 回灌形状：助手消息带 `tool-call` 块（source 是 model）；工具结果消息**随宿主代次变**——
//     0.1.7 起是**一等 `role:'tool'` 消息**（`toolCallId` + 顶层 `source.kind:'tool'` + `content` 直接是内容块），
//     更早才是"user 消息里塞 `tool-result` 块"。**形状错了模型就看不到结果**，
//     而且报错发生在第 2 轮建流时（台账 `UNSUPPORTED_CONTENT`）。形状只在 `llm-lib.js` 的
//     `toolResultShape()` 里决定一处，调用方不再自己拼。
//   · 收敛：模型某轮不再请求工具（或正文已出且已到最后一轮）就停。
//
// ── 与 0.5 的**有意分歧**（都写在这里，免得被当成漏抄）──
//   ① 轮次上限默认 **3**（0.5 正式运行用 5）：每一轮都是一次额外模型调用，成本与时间都要花；
//      要放开就改调用点的 `count`（硬上限 LOOP_HARD_MAX_ROUNDS = 6 是 0.5 的模块常量）。
//   ② 总时限默认 **60 秒**（0.5 是 90 秒）：解释层是**生产路径上的旁路**，
//      它拖住的是一轮真实对话的观感；宁可少读，也不要让用户等一条链路的第二段。
//   ③ **不做** 0.5 的证据账本重写（`renderEvidenceLedger`）：那是把"能引用什么"渲染成一份
//      权威清单交给模型。那是**另一层**语义（依据分类），本步的范围是"把真实文件内容拿给模型看"；
//      只读工具的**拒绝文本本身**已经把"没读到"这件事说清楚了（见下）。
//   ④ 越界拒绝是**第一类返回**：`{ ok:false, rejected:true, text }`，与"读到了但是空的"
//      分得开。0.5 把拒绝和正常结果都塞进同一个字符串里，调用方只能靠前缀猜。
//
// ── 安全：根目录约束 ─────────────────────────────────────────────
// **三重与条件**（P10-0.5-UI-SPEC §5）：`readTools === true` ∧ **能解析到本会话 cwd**。
// 解析不到就**一个工具都不派**——"宁可少读，也不读别的会话的目录"。理由是本项目的
// 一贯教训：查错对象不会报错，只会给错答案（EV-0081 的"查了另一个 profile 的清单"同源）。
// 单条路径走 `resolveInsideRoot`：词法（`..` 越界）+ `realpath`（软链接逃逸）**双校验**；
// 任一步失败一律回明确拒绝文本，不做"尽力而为"的读。
//
// 纯函数为主：只有 `executeReadOnlyTool` 碰文件系统，且它**不抛**（失败一律变成拒绝文本）。

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { toolResultShape, loadLlmLib } from './llm-lib.js'
import { createHash } from 'node:crypto'
import { readBounded } from './advisor-materials.js'
import { runPosix, SUPPORTED_COMMANDS, SUPPORTED_OPERATORS } from './posix.js'

/** 文件大小上限：超过直接拒绝（0.5 的 LOOP_MAX_FILE_BYTES）。 */
export const MAX_FILE_BYTES = 200 * 1024
/** 单次工具结果字符上限（超出截断并写明）。 */
export const MAX_RESULT_CHARS = 4000
/** 遍历的文件数上限（0.5 的 LOOP_MAX_FILES）。 */
export const MAX_FILES = 400
/** glob 命中上限。 */
export const MAX_GLOB_HITS = 50
/** grep 命中上限。 */
export const MAX_GREP_HITS = 40
/** 目录遍历深度上限。 */
export const MAX_DEPTH = 6
/** read 默认返回 200 行。 */
export const DEFAULT_READ_LINES = 200
/** grep 每条内容截断。 */
export const GREP_LINE_CHARS = 200
/** 遍历时跳过的目录（0.5 同一份名单）。 */
export const SKIP_DIRS = Object.freeze(['node_modules', '.git', 'dist', 'build', '.next', 'evidence'])
/** 工具循环轮次：默认 3，硬上限 6（0.5 的 LOOP_MAX_ROUNDS）。 */
export const LOOP_DEFAULT_ROUNDS = 3
export const LOOP_HARD_MAX_ROUNDS = 6
/** 工具循环总时限：默认 60 秒（见文件头分歧 ②）。 */
export const LOOP_BUDGET_MS = 60000

/** 越界与拒绝的**统一话术**：调用方与模型看到的必须是同一句（0.5 的原文）。 */
export const REFUSE_OUTSIDE = '拒绝：路径越出项目范围（只读工具限定在项目根内）'

/**
 * 三个只读工具的 schema（照 0.5 的 LOOP_TOOLS 逐字，含描述——描述就是模型的用法说明）。
 * **导出**是为了让定点核对能直接断言"关掉开关时一个工具都不派"。
 */
export const TOOL_SCHEMAS = Object.freeze([
  {
    name: 'read',
    description: '读取项目内某个文件的指定行范围（只读）。返回带行号的文本。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的路径' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob',
    description: '按通配符列出项目内文件路径（只读，最多 ' + MAX_GLOB_HITS + ' 条）。支持 ** 与 *。',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: '例如 **/*.js' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: '在项目内按正则搜索，返回 "文件:行号: 内容"（只读，最多 ' + MAX_GREP_HITS + ' 条）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: '可选：限定子路径' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run',
    // 2026-09-24：**虚拟 POSIX 层**。模型按 bash 语义表达，我们按语义执行（纯 JS、不依赖系统命令、
    // 不翻译成 PowerShell）⇒ Windows 与 Linux 上同一结果。只读；超出子集**显式失败**。
    description: '按 bash/POSIX 语义执行一条**只读**命令（' + SUPPORTED_COMMANDS.join('/') + '；'
      + '可用 ' + SUPPORTED_OPERATORS.join(' ') + ' 串联，`|` 按行过滤）。'
      + '这是项目根内的虚拟文件查询，不是系统 shell，不能探测已安装程序或 PATH。写入、重定向和其他命令均被拒绝；拒绝会作为工具结果返回。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '例如：grep -rn "TODO" src/ && ls tests' },
      },
      required: ['command'],
    },
  },
])

export const EN_TOOL_SCHEMAS = TOOL_SCHEMAS.map(t=>{
 const descriptions={read:'Read a line range of an authorized project file. Returns numbered source text.',glob:'List matching project files with ** and *; names alone are not evidence of file contents.',grep:'Search authorized project text using a regular expression; returns file:line:content.',run:'Query files within the project root using this virtual POSIX subset: '+SUPPORTED_COMMANDS.join(', ')+'. This is not a system shell and cannot probe installed programs or PATH. Writes, redirection and other commands return a rejected tool result.'}
 const parameters=JSON.parse(JSON.stringify(t.parameters))
 for(const [name,p]of Object.entries(parameters.properties||{}))if(p.description)p.description={path:'Path relative to the supplied project root.',pattern:'Glob or regular-expression pattern, as appropriate for this tool.',command:'Read-only POSIX command using the declared supported subset.'}[name]||''
 return {...t,description:descriptions[t.name],parameters}
})

/** 给解释层补的**工具用法说明**：只在真的派工具时拼进 system（不派就不拼，一个字都不差）。 */
export const TOOLS_SYSTEM_NOTE = '\n\n【只读查证】你可以调用 read/glob/grep 三个结构化只读工具查证项目的实际情况'
  + '（限定在项目根内、不写盘、不执行命令），也可以用 `run` 按 **bash/POSIX 语义**查证'
  + '（' + SUPPORTED_COMMANDS.join('/') + '，只读、由插件自己实现、跨平台结果一致）。'
  + '要写"项目里现在是怎么做的"这类 observed_fact，**必须先真的读到内容**——'
  + '只 glob 列过目录不算知道内容，没读到就不要写事实。'
  + '本轮最多 ' + LOOP_DEFAULT_ROUNDS + ' 轮查证，到上限会要求你立刻用已有证据给结论。'

/**
 * 路径是否在根内。**词法 + realpath 双校验**。
 * realpath 失败时（目标不存在/越界路径）以**词法校验**为准——这与 0.5 一致：
 * 目的是"不许越界"，不是"必须存在"（存在性由各工具自己回答）。
 * @returns 绝对路径 | null（null = 越界，调用方必须回拒绝文本）
 */
export function resolveInsideRoot(root, rel) {
  try {
    const r = String(root == null ? '' : root)
    const raw = String(rel == null ? '' : rel)
    if (!r || !raw) return null
    // 绝对路径一律拒绝：工具约定里 path 是"相对项目根"的
    if (isAbsolute(raw)) return null
    const abs = resolve(r, raw)
    const back = relative(r, abs)
    if (!back || back.startsWith('..') || isAbsolute(back)) return null
    try {
      const realRoot = realpathSync(r)
      const realAbs = realpathSync(abs)
      const realBack = relative(realRoot, realAbs)
      if (!realBack || realBack.startsWith('..') || isAbsolute(realBack)) return null
    } catch { /* 目标尚不存在（含越界）⇒ 以词法校验为准 */ }
    return abs
  } catch { return null }
}

/**
 * 遍历项目文件。**同步、有上限、可预测**：不返回生成器，也不做异步 IO
 * （解释层是旁路，不能在这里挂住事件循环太久；上限 400 个文件把最坏情况钉死）。
 */
export function walkFiles(root, cap = MAX_FILES) {
  const found = []
  const walk = (dir, depth) => {
    if (found.length >= cap || depth > MAX_DEPTH) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (found.length >= cap) return
      // 点文件/点目录一律跳过（含 `.git`），加上名单里的重目录
      if (entry.name.startsWith('.') || SKIP_DIRS.includes(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, depth + 1)
      else if (entry.isFile()) found.push(abs)
    }
  }
  walk(String(root), 1)
  return found
}

/** `.gitignore` 风格的通配符 → 正则。`**\/` 必须匹配**零层或更多层**目录（0.5 踩过的坑）。 */
export function globToRegExp(pattern) {
  const p = String(pattern == null ? '' : pattern)
  return new RegExp('^' + p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')          // 先占位 `**/`（**零层或多层**）
    .replace(/\*\*/g, '\u0002')            // 裸 `**`
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*') + '$')
}

/** 统一的结果形状：`ok`=真的读到/列到；`rejected`=越界或参数不合法（**不是**"没命中"）。 */
const ok = (text) => ({ ok: true, rejected: false, text: String(text) })
const reject = (text) => ({ ok: false, rejected: true, text: String(text) })

/** 截断到结果上限，并把截断事实写在结果末尾。 */
function capText(text) {
  const s = String(text)
  if (s.length <= MAX_RESULT_CHARS) return s
  return s.slice(0, MAX_RESULT_CHARS) + '\n…(截断到 ' + MAX_RESULT_CHARS + ' 字，原 ' + s.length + ' 字)'
}

/** `read`：默认 200 行、>200KB 拒绝、结果 >4000 字截断。 */
export function toolRead(root, args) {
  const a = args || {}
  const abs = resolveInsideRoot(root, a.path)
  if (!abs) return reject(REFUSE_OUTSIDE)
  try {
    if (!existsSync(abs)) return ok('文件不存在：' + String(a.path))
    const info = statSync(abs)
    if (!info.isFile()) return ok('不是文件：' + String(a.path))
    if (info.size > MAX_FILE_BYTES) return ok('拒绝：文件过大（>' + MAX_FILE_BYTES + ' 字节，本次 ' + info.size + ' 字节）')
    const bytes=readBounded(root,String(a.path),MAX_FILE_BYTES).data
    const lines = bytes.toString('utf8').split('\n')
    const startRaw = a.startLine === undefined || a.startLine === null ? 1 : Number(a.startLine)
    const endRaw = a.endLine === undefined || a.endLine === null ? startRaw + DEFAULT_READ_LINES - 1 : Number(a.endLine)
    if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) return reject('拒绝：startLine/endLine 必须是数字')
    const start = Math.max(1, Math.floor(startRaw))
    const end = Math.min(lines.length, Math.floor(endRaw))
    const slice = end >= start ? lines.slice(start - 1, end) : []
    const body = slice.map((line, i) => String(start + i).padStart(5, ' ') + '| ' + line).join('\n')
    const head = '文件 ' + String(a.path) + '（共 ' + lines.length + ' 行，返回 ' + start + '-' + end + '）'
    const full=head+'\n'+body,text=capText(full)
    const ref='read:'+String(a.path).replaceAll(String.fromCharCode(92),'/')
    return {...ok(text),evidence:{ref,path:String(a.path),sha256:createHash('sha256').update(bytes).digest('hex'),kind:'file',status:full===text?'ready':'truncated',selectionComplete:full===text,wholeFileComplete:start===1 && end===lines.length && full===text,startLine:start,endLine:end}}
  } catch (e) {
    return ok('读取失败：' + String((e && e.message) || e))
  }
}

/** `glob`：≤50 命中、≤400 文件、深度 ≤6、跳重目录与点文件。 */
export function toolGlob(root, args) {
  const a = args || {}
  const pattern = String(a.pattern == null ? '' : a.pattern)
  if (!pattern) return reject('拒绝：pattern 不能为空')
  let rx = null
  try { rx = globToRegExp(pattern) } catch (e) { return reject('通配符无效：' + String((e && e.message) || e)) }
  const hits = []
  for (const abs of walkFiles(root)) {
    const rel = relative(String(root), abs).split('\\').join('/')
    if (rx.test(rel)) hits.push(rel)
    if (hits.length >= MAX_GLOB_HITS) break
  }
  if (hits.length === 0) return ok('无匹配（pattern=' + pattern + '）')
  return ok('匹配 ' + hits.length + ' 条：\n' + hits.join('\n'))
}

/** `grep`：≤40 命中，`文件:行号: 内容`，内容截 200 字，跳过二进制与大文件。 */
export function toolGrep(root, args) {
  const a = args || {}
  let rx = null
  try { rx = new RegExp(String(a.pattern == null ? '' : a.pattern)) } catch (e) {
    return reject('正则无效：' + String((e && e.message) || e))
  }
  let scope = String(root)
  if (a.path !== undefined && a.path !== null && String(a.path) !== '') {
    const abs = resolveInsideRoot(root, a.path)
    if (!abs) return reject(REFUSE_OUTSIDE)
    scope = abs
  }
  let files = []
  try {
    files = existsSync(scope) && statSync(scope).isDirectory() ? walkFiles(scope) : [scope]
  } catch { files = [scope] }
  const hits = []
  for (const abs of files) {
    if (hits.length >= MAX_GREP_HITS) break
    let info = null
    try { info = statSync(abs) } catch { continue }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
    let text = ''
    try { text = readFileSync(abs, 'utf8') } catch { continue }
    if (text.indexOf('\u0000') >= 0) continue               // 二进制：跳过（不是错误）
    const rel = relative(String(root), abs).split('\\').join('/')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < MAX_GREP_HITS; i += 1) {
      // 重置 lastIndex：带 /g 的正则与 test 组合会跳行，这里统一用无状态写法
      if (rx.test(lines[i])) hits.push(rel + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, GREP_LINE_CHARS))
    }
  }
  if (hits.length === 0) return ok('无匹配（pattern=' + String(a.pattern) + '）')
  return ok('命中 ' + hits.length + ' 条：\n' + hits.join('\n'))
}

/**
 * 执行一次工具调用。**不抛**：任何异常都变成结果文本（模型看到失败原因比看到"工具崩了"有用）。
 * 未知工具名也回**明确拒绝**，不是静默空结果。
 */
export function executeReadOnlyTool(root, name, args) {
  try {
    const n = String(name == null ? '' : name)
    if (n === 'read') return toolRead(root, args)
    if (n === 'glob') return toolGlob(root, args)
    if (n === 'grep') return toolGrep(root, args)
    // 虚拟 POSIX 层（2026-09-24）：模型写 bash，我们按语义执行（只读、纯 JS、不翻译成 PowerShell）。
    // 参数名是 `command`；缺了就如实拒绝，不要拿空串去跑。
    if (n === 'run') {
      const cmd = args && args.command !== undefined && args.command !== null ? String(args.command) : ''
      if (!cmd.trim()) return reject('拒绝：run 需要 command（例如 `grep -rn "TODO" src/`）')
      return runPosix(root, cmd)
    }
    return reject('拒绝：不存在的工具（本循环只提供 read/glob/grep/run，且只读）：' + n)
  } catch (e) {
    return { ok: false, rejected: false, text: '工具执行异常：' + String((e && e.message) || e) }
  }
}

/** 组装一条"助手请求工具"的消息（形状错了模型就看不到自己的调用）。
 *  宿主有 `createAssistantMessage` 时走工厂：它负责 **id 与冻结**（0.1.7 的 id 是 brand 类型，
 *  手搓字符串等于绕开契约）；没有才退回手搓（更早的宿主）。 */
export function assistantToolCallMessage(calls, provider, model, mod, response=null) {
  // Preserve the exact provider response blocks/signatures when the SDK supplies them. Tool-only
  // reconstruction loses native thinking replay required by current Messages routes.
  const observed=Array.isArray(response?.content)?response.content:null
  const observedCalls=observed?.filter(b=>b.type==='tool-call')||[]
  const complete=observed && observedCalls.length===calls.length && calls.every(c=>observedCalls.some(b=>b.id===c.id&&b.name===c.name&&b.arguments===c.arguments))
  const content = complete ? observed : calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments }))
  const source = { provider: String(provider || ''), model: String(model || ''),...(complete&&response.replayState!==undefined?{replayState:response.replayState}:{}) }
  if (mod && typeof mod.createAssistantMessage === 'function') {
    return mod.createAssistantMessage({ content, source })
  }
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  return { id: 'po06-a-' + stamp, role: 'assistant', content, source: { kind: 'model', ...source } }
}

/** 组装工具结果消息。**形状随宿主代次变**（见 `llm-lib.js` 的 `toolResultShape`）：
 *   · 0.1.7+：`role:'tool'` 一等消息（`createToolResultMessage`）；
 *   · 更早：`role:'user'` + `tool-result` 块。
 *  `shapeOrMod` 三种写法都收：① `{make}`（`toolResultShape()` 的结果）；
 *  ② `{mod}`（`loadLlmLib()` 的返回值）；③ `mod` 本身。传不了就不造消息、返回空数组——
 *  调用方对"没有结果"本来就有降级路径，**形状不明时宁可不发，也不发一个模型读不懂的**。 */
export function toolResultMessages(calls, outputs, shapeOrMod) {
  const shape = resolveShape(shapeOrMod)
  if (!shape || typeof shape.make !== 'function') return []
  return calls.map((c, i) => {
    const out = outputs[i] || { ok: false, text: '' }
    const text = out.text === undefined || out.text === null ? '' : String(out.text)
    return shape.make({ callId: c.id, content: [{ type: 'text', text }], isError: out.ok !== true })
  })
}

function resolveShape(x) {
  if (!x) return null
  if (typeof x.make === 'function') return x                       // ① 已经是 shape
  const mod = x.mod && typeof x.mod === 'object' ? x.mod : x       // ② loadLlmLib 返回 / ③ 模块本身
  return mod && typeof mod === 'object' ? toolResultShape(mod) : null
}

/**
 * 收干**一轮**带工具的流：返回正文/思考/用量/结束原因/**工具调用清单**。
 *
 * eval-llm.js 的无工具收集也复用本函数。保留工具调用块与 provider replay，
 * 供同一对话继续时使用；流错误返回 error，不把工具调用当成最终正文。
 */
export async function drainWithTools(stream, t0, sink) {
  const out = {
    text: '', reasoning: '', usage: null, finish: null, error: null,
    ms: 0, calls: [], chunkTypes: {},
    content: [], replayState: undefined,
  }
  // P11：**思维层要有内容**（用户 2026-09-21："只读工具开启时看不见思维"）。
  // 工具路径此前不接 sink ⇒ 进度面收不到任何流式片段 ⇒ 界面只有一个"已用 N 秒"。
  // sink 只做展示，抛错一律吞掉（界面坏了不能把模型调用带下水）。
  const emit = (dt, dr) => {
    if (typeof sink !== 'function') return
    try { sink({ text: dt, reasoning: dr, textChars: out.text.length, reasoningChars: out.reasoning.length }) } catch { /* 展示层的问题不拖累收集 */ }
  }
  try {
    for await (const chunk of stream) {
      const t = chunk && chunk.type
      if (t) out.chunkTypes[t] = (out.chunkTypes[t] || 0) + 1
      if (t === 'text-delta') { out.text += String(chunk.text || chunk.delta || ''); emit(String(chunk.text || chunk.delta || ''), '') }
      else if (t === 'reasoning-delta') { out.reasoning += String(chunk.text || chunk.delta || ''); emit('', String(chunk.text || chunk.delta || '')) }
      else if (t === 'usage') out.usage = chunk.usage || null
      else if (t === 'tool-call-delta') {
        let call = out.calls.find((c) => c.id === chunk.id)
        if (!call) { call = { id: chunk.id, name: '', arguments: '' }; out.calls.push(call) }
        if (chunk.name) call.name = chunk.name
        call.arguments += String(chunk.argumentsDelta || '')
      } else if (t === 'block-end' && chunk.block) {
        if(['text','reasoning','tool-call'].includes(chunk.block.type))out.content.push({index:Number.isSafeInteger(chunk.index)?chunk.index:out.content.length,block:chunk.block})
        if(chunk.block.type==='tool-call'){
        const b = chunk.block
        const hit = out.calls.find((c) => c.id === b.id)
        // block-end 给的是**装配好的**参数 ⇒ 覆盖 delta 拼出来的那份（文件头观察点）
        if (hit) { hit.name = b.name || hit.name; hit.arguments = b.arguments || hit.arguments }
        else out.calls.push({ id: b.id, name: b.name, arguments: b.arguments })
        }
      } else if (t === 'finish') {
        if(chunk.replayState!==undefined)out.replayState=chunk.replayState
        out.finish = chunk.reason || chunk.finish || null
        const kind = out.finish && out.finish.kind
        if (kind === 'error' || kind === 'aborted') {
          out.error = 'llm-' + kind + ': ' + JSON.stringify((out.finish && out.finish.failure) || {})
        }
      }
      // 兜底（同 eval-llm.drain）：usage 可能挂在别的 chunk 上，凡带 usage 的都收 —— 否则界面永远 `Σ — tok`
      if (!out.usage && chunk && chunk.usage && typeof chunk.usage === 'object') out.usage = chunk.usage
      // ⚠ 工具循环是**多次模型调用**：只留最后一次的 usage 会**少算**（用户问"是不是真统计、偏差多大"）。
      // 这里把每一轮的用量按键名累加，得到"本轮解释的真实总量"。
      if (chunk && chunk.usage && typeof chunk.usage === 'object') {
        out.usageSum = out.usageSum || {}
        for (const k of Object.keys(chunk.usage)) {
          const v = chunk.usage[k]
          if (typeof v === 'number' && Number.isFinite(v)) out.usageSum[k] = (out.usageSum[k] || 0) + v
        }
      }
    }
  } catch (e) {
    out.error = String((e && e.message) || e)
  }
  out.content=out.content.sort((a,b)=>a.index-b.index).map(x=>x.block)
  const endedText = out.content.filter(block => block.type === 'text').map(block => String(block.text || '')).join('')
  if (endedText) { const missingDeltas = !out.text; out.text = endedText; if (missingDeltas) emit(endedText, '') }
  out.ms = Date.now() - t0
  return out
}

/**
 * **只读工具循环**：模型自己决定读什么/搜什么，直到给出结论或撞上限。
 *
 * `llm.stream` 必须由调用方注入（本模块不碰 ctx，便于用桩做定点核对）。
 * 工具成功与拒绝都回到同一对话；只有最终模型失败才结束运行，不重新从原话生成。
 *
 * @param opts.llm      宿主 llm 服务（只要有 stream）
 * @param opts.cfg       { provider, model }
 * @param opts.system    解释层系统提示词（本函数**追加**工具用法说明）
 * @param opts.messages  已有消息（解释层的 user message）
 * @param opts.root      项目根（**必须由调用方解析出本会话的 cwd**；本函数不猜）
 * @param opts.rootListing 是否预注入顶层清单（默认 true，省掉"先 glob 一遍"的那一轮）
 * @param opts.count     轮次上限（默认 3，硬上限 6）
 * @param opts.budgetMs  总时限（默认 60s）
 * @param opts.now       注入时钟（定点核对用，默认 Date.now）
 * @returns {{ok, text, error, rounds, toolCalls, names, trace, capped, ms, root, empty}}
 */
export async function runReadOnlyToolLoop(opts) {
  const o = opts || {}
  const llm = o.llm
  const cfg = o.cfg || {}
  const now = typeof o.now === 'function' ? o.now : Date.now
  const t0 = now()
  // ⚠ **取消信号必须在这里取出来**（真机 bug，2026-09-24）：下面建流那一步写的是
  // `...(signal ? { signal } : {})`，而 `signal` 从来没在这个作用域里定义过 ⇒ 建流当场抛
  // `ReferenceError` ⇒ 工具循环**一轮都没跑**（台账 `rounds:0 calls:0 stream-threw:signal is not defined`），
  // 全靠无工具回落兜着。而回落那条路当时又不接思维流的 sink ⇒ 用户看到的是
  // "开着只读工具就没有思考、还老是 no-packet"。**这条路径此前没有任何单测**，所以它安静地活了下来
  // （见 `test/read-tools.test.mjs`：现在有守卫钉住"一轮真的跑过"和"信号真的传下去"）。
  const signal = o.signal || null
  const root = String(o.root == null ? '' : o.root)
  // 硬上限在这里兜住：调用方传 999 也只会跑到 6
  const want = Math.max(1, Math.floor(Number(o.count) || LOOP_DEFAULT_ROUNDS))
  const maxRounds = Math.min(want, LOOP_HARD_MAX_ROUNDS)
  const budgetMs = o.budgetMs === null ? null : Math.max(1000, Number(o.budgetMs) || LOOP_BUDGET_MS)
  const deadline = budgetMs === null ? null : t0 + budgetMs
  const base = { root, maxRounds, budgetMs }
  const fail = (error) => ({
    ...base, ok: false, empty: true, error: String(error), text: '', rounds: 0,
    toolCalls: 0, names: [], trace: [], capped: false, ms: now() - t0,
  })
  if (typeof root !== 'string' || !root) return fail('no-root')
  if (!llm || typeof llm.stream !== 'function') return fail('llm-unavailable')
  // 工具结果的**消息形状**要在回灌之前拿到（0.1.7 起是 `role:'tool'` 一等消息，更早是 user+`tool-result` 块）。
  // 无法回灌工具结果时，在任何付费调用之前明确失败，不能把 tool-calls 当作最终回答。
  // **绝不自己猜一个形状**：猜错的代价是静默失效（台账 `UNSUPPORTED_CONTENT`：循环跑了两轮，
  // 第 2 轮会话说不出那条结果）。`o.shape` 是给测试注入用的。
  // ⚠ `env` 必须显式传：`loadLlmLib` 的默认值是**空表**（为的是让单测完全掌控候选顺序），
  // 不传的话 `DSH_PO06_LLM_LIB` 这类显式覆盖在生产路径上**永远读不到**——
  // 表现是"明明设了环境变量却still 解析不到"（测试夹具也指不过来）。
  const shapeT = o.shape === undefined ? await loadLlmLib({ env: process.env, argv1: process.argv[1], cwd: process.cwd() }) : o.shape
  const resultShape = resolveShape(shapeT)
  if (typeof resultShape?.make !== 'function') {
    // issue #43：只给一个 reason 让人无从下手。把「试过哪些解析基准」一起带出去，
    // 调用方（和用户）才能判断是缺模块、装错位置，还是该设 DSH_PO06_LLM_LIB。
    const tried = shapeT && Array.isArray(shapeT.tried)
      ? shapeT.tried.map((x) => x.source + (x.reason ? '(' + x.reason + ')' : '')).join(' | ')
      : 'shape-injected'
    // error 保持稳定的机器可读码（调用方按它判断），可执行的诊断放在独立字段里。
    const out = fail('tool-result-format-unavailable')
    out.errorDetail = { reason: (shapeT && shapeT.reason) || null, tried }
    return out
  }
  /** 宿主 llm 模块本身（`loadLlmLib` 的返回带 `mod`；直接传模块时就是它）。给工厂用。 */
  const llmMod = shapeT && shapeT.mod && typeof shapeT.mod === 'object' ? shapeT.mod : (shapeT && typeof shapeT.createAssistantMessage === 'function' ? shapeT : null)

  const messages = Array.isArray(o.messages) ? o.messages.slice() : []
  const system = String(o.system || '') + (o.systemNote === undefined ? TOOLS_SYSTEM_NOTE : String(o.systemNote))
  // 顶层清单**预注入**：0.5 实测模型会把整轮预算花在 glob 上、一次都不 read。
  // 清单只声明**存在**，不等于知道内容——这条要写清楚，否则又变成"没读就写事实"。
  if (o.rootListing !== false) {
    try {
      const top = walkFiles(root, 60)
        .map((abs) => relative(root, abs).split('\\').join('/'))
        .filter((p) => p.indexOf('/') < 0)
        .slice(0, 40)
      if (top.length > 0) {
        messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text:o.englishMode?'[Top-level project filenames, existence only, not content evidence]\n'+top.join('\n')+'\nRead actual content before citing file facts.':'【工具根目录顶层清单（只表示存在，不代表知道内容）】\n' + top.join('\n')
              + '\n\n要引用文件里的东西，仍然必须用 read 真正读它。',
          }],
        })
      }
    } catch { /* 清单拿不到就不给：少一样证据，不是错误 */ }
  }

  const notify = (event) => { try { if (typeof o.onEvent === 'function') o.onEvent(event) } catch { /* UI only */ } }
  const usageSum = {}
  let usageKnownCalls=0,usageUnknownCalls=0
  const trace = []
  let rounds = 0
  let capped = false
  let finalize = false
  let error = null
  let text = '', finish = null
  for (let round = 1; round <= maxRounds + 1; round += 1) {
    if (signal?.aborted) { error = 'cancelled'; break }
    const useTools = !finalize && round <= maxRounds && (deadline === null || now() < deadline)
    if (round > 1) {
      // 上一轮的正文是**脚手架**（"我先读一下项目结构…"），到下一轮就作废。
      // 不清掉的话，最终产出会被脚手架污染——这是 0.5 实测踩到的。
      text = ''
    }
    // Finalization stays in this conversation: the original input, assistant calls and
    // every tool result (including rejections) remain visible to the model.
    if (!useTools) {
      capped = true
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: o.finalNote || '【系统】已达本次查证轮次上限，请立即用已获得的证据给出 JSON 产出，不要再请求工具。' }],
      })
    }
    if(typeof o.evidenceNote==='function') {
      const note=o.evidenceNote(trace)
      if(note)messages.push({role:'user',content:[{type:'text',text:String(note)}]})
    }
    const rt = now()
    notify({ kind: 'round', round, final: !useTools })
    let stream = null
    try {
      stream = llm.stream({
        provider: cfg.provider,
        model: cfg.model,
        // 会话标识：网关要求的 x-*-session 头由它派生（缺了就是 400）
        ...(o.sessionId ? { sessionId: String(o.sessionId) } : {}),
        system,
        messages: messages.slice(),
        // 0.7.5：思考档位也走这条路径（开"只读工具"时模型调用在这里发起）。
        // 按 cfg 选定的那个模型查表；没配就不传，由 provider 用默认档。
        ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
        ...(useTools ? { tools: o.englishMode?EN_TOOL_SCHEMAS:TOOL_SCHEMAS } : {}),
        // 用户按「跳过并发送 / 取消」⇒ 取消信号一路传到这里，工具循环的模型调用当场停
        ...(signal ? { signal } : {}),
      })
    } catch (e) {
      usageUnknownCalls++;error='stream-threw:'+String((e&&e.message)||e);break
    }
    const r = await drainWithTools(stream, rt, typeof opts.onDelta === 'function' ? opts.onDelta : null)
    rounds = round
    finish = r.finish
    if(r.usage&&Object.values(r.usage).some(x=>typeof x==='number'&&Number.isFinite(x)))usageKnownCalls++;else usageUnknownCalls++
    if (r.usage) for (const [key, value] of Object.entries(r.usage)) {
      if (typeof value === 'number' && Number.isFinite(value)) usageSum[key] = (usageSum[key] || 0) + value
    }
    if (signal?.aborted) { error = 'cancelled'; break }
    if (r.text) text = r.text
    if (r.error) { error = r.error; break }
    const calls = Array.isArray(r.calls) ? r.calls.filter((c) => c && c.id && c.name) : []
    if (!useTools && calls.length) { error = 'tool-calls-after-finalization'; break }
    if (!useTools || calls.length === 0) {
      const kind = typeof r.finish === 'object' ? r.finish?.kind : r.finish
      if (!['stop', 'end', 'complete', 'completed'].includes(kind)) error = 'optimizer-incomplete:' + String(kind || 'missing-finish')
      break
    }
    messages.push(assistantToolCallMessage(calls, cfg.provider, cfg.model, llmMod, r))
    const outputs = []
    for (const call of calls) {
      let args = {}
      try { args = JSON.parse(call.arguments || '{}') } catch { args = {} }
      const st = now()
      if (signal?.aborted) { error = 'cancelled'; break }
      const res = executeReadOnlyTool(root, call.name, args)
      trace.push({
        round, tool: String(call.name), args, ok: res.ok === true && res.rejected !== true,
        rejected: res.rejected === true,
        ms: now() - st,
        resultLines: String(res.text).split('\n').length,
        resultAvailable: call.name === 'read' && res.ok && String(res.text).startsWith('文件 '),
        evidence:res.evidence || null,
      })
      notify({ kind: 'tool', round, tool: call.name, target: args.path || args.pattern || args.command || '',
        ok: res.ok === true && res.rejected !== true, ms: now() - st })
      outputs.push(res)
    }
    if (signal?.aborted) { error = 'cancelled'; break }
    messages.push(...toolResultMessages(calls, outputs, resultShape))
    // A rejected read is a tool result, not a failed model completion. Close further
    // lookup, then let the model finish from this same conversation once.
    if (outputs.some(output => output.rejected === true)) finalize = true
  }
  const outText = String(text || '')
  return {
    ...base, ok: !error, error, finish, text: outText, rounds, toolCalls: trace.length,
    usageSum: Object.keys(usageSum).length ? usageSum : null,usageComplete:usageUnknownCalls===0,usageKnownCalls,usageUnknownCalls,
    names: namesOf(trace), trace, capped, ms: now() - t0, empty: outText.trim().length === 0,
  }
}

/** trace → 去重后的工具名清单（台账字段 `toolNames`）。 */
function namesOf(trace) {
  const seen = []
  for (const t of Array.isArray(trace) ? trace : []) {
    const n = String((t && t.tool) || '')
    if (n && !seen.includes(n)) seen.push(n)
  }
  return seen
}
