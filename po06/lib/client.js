// P10 · **控件栏**（客户端）。由 `dsh-client-modules` 自动服务并注入页面。
//
// 三个界面，对应主计划 §14.1「面向用户的最小界面」：
//   ① `conversation.input.left` —— 输入区左侧的**一排控件**（P10 换的挂载点：原来是
//      `conversation.input.dock` 上那颗小胶囊）：档位 / 优化权限 / 上下文 / 读项目文件 / 模型。
//      换的理由是用户实测反馈「不适应 0.6 的操控形态」——胶囊只回答"它在不在"，
//      而人要的是**随手拨**（0.5 的形态）。
//   ② `shell.overlay`           —— 详情浮层槽（本轮**未动**：仍是占位注册；详情面板本体
//      由 ① 末尾那颗「详情」按钮打开——和换挂载点之前是同一个组件里的同一块面板）
//   ③ `settings.plugins.tab`    —— 设置页里的一页（同一套控制表单，便于从设置进入）
//
// 三条从 0.5 的真实事故里学来的纪律（照抄，不重犯）：
//   · **单例闸门**：HMR 会重新求值本文件，旧实例的监听若没回收就会"替新实例干活"
//     ⇒ 后台在跑、界面不显示。所以每个实例在 apply 时抢注 token，只有持有者才注册 UI。
//   · **slot 按 id 去重**：同 id 重复注册会抛 `list slot "…" already has an entry with id "…"`，
//     改 order 绕不开 ⇒ 重挂前必须先释放上一次的注册。
//   · **卸载即净**：所有注册与定时器都进 own()，apply 返回一个统一释放函数。
//
// 与宿主控制 API 的约定（见 lib/control-api.js）：**写操作必须带 `x-po06: 1`**
// —— 自定义头会触发 CORS 预检，而服务端从不回 CORS 头 ⇒ 跨站写在预检阶段就被浏览器拦掉。
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-wish-specializer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-po06'
    const API = '/po06/api'
    // ── 拦截态的**跨挂载小仓库**（issue #19）───────────────────────────────
    // 控件栏是 per-session 挂载的：切到别的会话再回来会**重挂**，组件内的 hold 归零。
    // 原先的做法是把 hold 顺手写一份到 `window.__PO06_HOLD__[sessionId]`，但那只在**挂载时**读一次；
    // 于是"切走 → 解释在后台跑完 → 切回"这条路径上，完成结果是写进了桥、却没有任何东西再读它 ——
    // 用户看到的就是"这一轮没有继续，也没有产出"。
    // 现在把桥收敛成三个函数：写入即广播，订阅者按 sessionId 认领。
    // 它**只按会话隔离**（绝不把 A 会话的拦截态显示到 B 会话），且桥不可用时静默降级（不影响本轮）。
    const HOLD_BRIDGE_EVENT = NS + ':hold'
    // 谁是"当前面板上的会话"：由 ControlBar 每次渲染更新。切会话时旧实例可能还活着，
// 但它的 sessionId 已经不等于这个值 ⇒ 它不再往桥上写、也不在这里提交（2026-10-19 真机）。
let LAST_MOUNTED_SID = ''

function holdBridgeRead(sessionId) {
      try { return (window.__PO06_HOLD__ || {})[sessionId] || null } catch { return null }
    }
    function holdBridgeWrite(sessionId, value) {
      if (!sessionId) return
      try {
        const b = window.__PO06_HOLD__ || (window.__PO06_HOLD__ = {})
        if (value) b[sessionId] = value
        else delete b[sessionId]
      } catch { return }        // 桥写不进去就不广播（否则订阅者会读到旧值）
      try { window.dispatchEvent(new CustomEvent(HOLD_BRIDGE_EVENT, { detail: { sessionId } })) } catch { /* 老环境没有 CustomEvent：本组件自己的状态仍然可用 */ }
    }
    /** 订阅某会话的拦截态变化；返回退订函数（挂载期用，卸载必须退订）。 */
    function holdBridgeOn(sessionId, cb) {
      const on = (e) => { if (e && e.detail && e.detail.sessionId === sessionId) cb(holdBridgeRead(sessionId)) }
      try { window.addEventListener(HOLD_BRIDGE_EVENT, on) } catch { return () => {} }
      return () => { try { window.removeEventListener(HOLD_BRIDGE_EVENT, on) } catch { /* 退不掉也不影响本轮 */ } }
    }

    const WRITE_HEADERS = { 'content-type': 'application/json', 'x-po06': '1' }
    const INSTANCE_TOKEN = NS + '#' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)

    /** 只有抢到 token 的实例才注册 UI（见文件头"单例闸门"）。 */
    const isActiveInstance = () => {
      try { return window.__PO06_ACTIVE__ === INSTANCE_TOKEN } catch (e) { return true }
    }

    // ── 语言：最小的 L(zh, en) ────────────────────────────────────────
    // 中文是默认（`ctx.locale` 拿不到就用中文）。**英文逐条给，不做字典**：
    // 字典漏一个键，界面上就会中英混排而没人发现；两参写法漏了英文是肉眼可见的。
    // ⚠ `L` 在**渲染时**求值（LOCALE 在 apply 里才被赋值），所以只能在函数体里调用它。
    let LOCALE = 'zh'
    const L = (zh, en) => (LOCALE === 'en' && en ? en : zh)
    // P11：发送按钮的本地化标签要从宿主的字典取（0.5:503 `localeService.bind("conversation")`）；
    // 拿不到就只有结构兜底（卡片内最后一个按钮），**不会因此不拦**。
    let LOCALE_BIND = null
    // 从 DSH 的 locale 服务里读出**当前语言**。
    // ⚠ 真机契约（照抄自宿主源码，别猜形状）：DSH 客户端 `dsh-client-locale/lib/client.js:1374`
    //   `ctx.provide("locale", locale)`，提供的是 **LocaleFace 实例**（不是字符串！）：
    //   `getSnapshot()/getLocale()` → `{ active: 'zh' | 'en' | …, locales, revision }`、
    //   `subscribe(fn)` → 返回退订函数、`bind(ns)` → 字典。
    //   **旧写法按 `v.locale/v.name/v.id/v.language` 猜属性 ⇒ 在真机上永远拿不到 ⇒ 恒中文**（已修）。
    let LOCALE_SVC = null
    const localeOf = (svc) => {
      try {
        if (!svc) return null
        if (typeof svc === 'string') return svc
        if (typeof svc.getSnapshot === 'function') {
          const s = svc.getSnapshot()
          if (s && typeof s.active === 'string' && s.active) return s.active
        }
        if (typeof svc.getLocale === 'function') {
          const s = svc.getLocale()
          if (s && typeof s.active === 'string' && s.active) return s.active
        }
        if (svc.snapshot && typeof svc.snapshot.active === 'string' && svc.snapshot.active) return svc.snapshot.active
        if (typeof svc.active === 'string' && svc.active) return svc.active
        if (typeof svc.locale === 'string' && svc.locale) return svc.locale
      } catch (e) { /* 服务不可用 ⇒ 走中文兜底 */ }
      return null
    }
    const detectLocale = (ctx) => {
      let svc = null
      // ⚠ 这一句必须包住：cordis 对**未 inject** 的服务 getter 是**抛错**、不是返回 undefined
      //   （2026-09-22 真机：读 `ctx.locale` 而没在 `exports.inject` 里声明 ⇒ 整页 "Failed to load plugins"）。
      try { svc = ctx && ctx.locale } catch (e) { svc = null }
      const v = localeOf(svc)
      if (!v) return 'zh'          // 拿不到 ⇒ 中文（宁可中文，也不要空白文案）
      return /^zh/i.test(v) ? 'zh' : 'en'   // 只要明确说了非中文，就给英文
    }

    // 语言是**活的**：用户在 DSH 设置里切语言 ⇒ 立刻重渲染本插件的界面（不用刷新页面）。
    // 用法：在根组件里调用一次 `useLocaleLive()`；`L()` 在渲染时求值，所以重渲染即可换语言。
    function useLocaleLive() {
      const [, setN] = React.useState(0)
      React.useEffect(() => {
        const svc = LOCALE_SVC
        if (!svc || typeof svc.subscribe !== 'function') return undefined
        let off = null
        try {
          off = svc.subscribe(() => {
            LOCALE = detectLocale({ locale: svc })
            setN((n) => n + 1)
          })
        } catch (e) { off = null }
        return () => { try { if (typeof off === 'function') off() } catch (e) { /* noop */ } }
      }, [])
      return null
    }

    // ── 值域的**本地兜底镜像**（唯一真相仍是 lib/settings.js）────────────
    // 正常情况下档位直接用宿主推导好的 `/status.described.tier`；
    // 只有当 `described` 缺失（老宿主 / 接口改过）时才用下面这张表自己推。
    // ⚠ 改 settings.js 的 TIER_PRESETS / TURNS_MIN / TURNS_MAX 必须同步改这里。
    // 构建标记（2026-10-19）：插件改动必须重启才生效，真机上"改了没反应"有一半是构建没换。
    // 这个常量显示在「优化选项」标题右侧，改客户端时**手动更新**（就是这一行的日期时间）。
    const CLIENT_BUILD = '10-19 21:56'
    // 每个会话已经为哪个预设弹过提示（模块级：组件重挂载不会忘）
    // 一次 DSH 运行进程里**最多提示一次**（用户 2026-10-19 口径）。重启后才会再次提示。
    let PRESET_NOTICE_SHOWN = false
    // 预设登记表（id ↔ 显示名）：由宿主从 agentPresets 服务转出来。
    // 磁盘上会话头永远是 ptc，所以"用户眼前这个会话选了什么"只能看输入区按钮的文案。
    const TIER_KEYS = ['off', 'light', 'standard', 'heavy']
    // ⚠ 必须与 settings.js 的 TIER_PRESETS **逐项一致**：这里是拿三项反推档位（tierOfSettings）。
    // 2026-10-19 修：此前这一份和宿主侧不一致（light/standard 的 detail、budget 错位），
    // 于是选「标准」会被反推成「轻度」、选「轻度」会变成「自定义」——真机上看起来就是"点了跳回去"。
    const TIER_PRESETS_LOCAL = Object.freeze({
      off: { assist: 'off', detail: 'standard', budget: 'standard' },
      light: { assist: 'auto', detail: 'minimal', budget: 'minimal' },
      standard: { assist: 'auto', detail: 'standard', budget: 'standard' },
      heavy: { assist: 'auto', detail: 'detailed', budget: 'generous' },
    })
    const TURNS_MIN = 0
    const TURNS_MAX = 10
    const DEFAULT_TURNS = 6
    const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k)
    const tierOfSettings = (s) => {
      const x = s || {}
      for (const t of TIER_KEYS) {
        const p = TIER_PRESETS_LOCAL[t]
        if (x.assist === p.assist && x.detail === p.detail && x.budget === p.budget) return t
      }
      return 'custom'
    }
    const tierLabel = (t) => ({
      off: L('关闭', 'Off'), light: L('轻度', 'Low'), standard: L('标准', 'High'),
      heavy: L('重度', 'Ultra'), custom: L('自定义', 'Custom'),
    }[t] || t)

    // P11：**档位色照抄 0.5**（0.5:293 `TIER_TONES` = off/basic/advanced/extreme 四色）。
    // 0.6 的档位是 off/light/standard/heavy（见 settings.js TIER_PRESETS），语义逐档对应
    // （关 / 轻 / 标 / 重）⇒ **色值一字不改**地搬过来，于是悬浮球与档位徽标和 0.5 是同一套颜色。
    // 自定义档（几项值凑不出预设）没有对应色 ⇒ 落回主题主色（下面 OVS.acc）。
    const TIER_TONES = { off: '#8b8f98', light: '#4a9eff', standard: '#a970ff', heavy: '#ff8a3d' }

    // ── 主题调色板（**浅色/深色各一份显式取值**）──────────────────────────────
    //
    // 为什么必须自己写两份（用户 2026-09-22 附浅色模式截图："根本看不清"）：
    //   0.6 的样式**全部是内联样式**，而内联里的颜色此前是"深色兜底 + 指望 DSH 变量正确"：
    //     · 思维层底色写死 `rgba(20,20,20,.6)` ⇒ 浅色模式下**一块黑底**，而文字取
    //       `--dsw-alias-label-secondary`（浅色模式下是**深灰**）⇒ 深字压黑底，读不出来；
    //     · 面板里的标签用 `opacity:.6/.65/.7` 压暗 ⇒ 在浅色底上变成浅灰细字，同样读不出来；
    //     · 下拉框 `background: var(--dsw-alias-bg-l1, #141414)`：这个变量在本机**取不到**，
    //       于是用了深色兜底，而文字取到了浅色模式的深色 ⇒ **深字压深底**（截图里那个黑框）。
    //   所以判据不是"抄一条浅色覆盖"，而是**让颜色由主题驱动**：一份 token 表，两套取值。
    //
    // 主题信号：DSH 用 `[data-ds-dark-theme]`（深色时在 html/body 上挂这个属性；浅色时不挂）。
    //   token 通过注入的样式表落在 `[data-po06]` 上（两种主题各一段），内联样式只引用 `var(--po06-*)`。
    //   这样"浅色看不清"这类问题在结构上不会再出现：底色与文字**永远来自同一套取值**。
    const THEME_TOKENS = {
      // 浅色：白底 + 近黑字（DSH 浅色模式的实际观感）
      light: {
        fg: '#17171a', fg2: '#33333a', fg3: '#55555e', cap: '#6a6a73',
        surface: '#ffffff', surface2: '#f5f5f7', inset: '#f1f1f4', chip: 'rgba(0,0,0,.05)',
        line: 'rgba(0,0,0,.20)', line2: 'rgba(0,0,0,.12)',
        hover: 'rgba(0,0,0,.06)', shadow: '0 10px 30px rgba(0,0,0,.16)',
        acc: 'var(--dsw-alias-state-business-primary, #2f6fed)', accFg: '#ffffff',
        danger: '#c0342b', dangerFg: '#a82a22', dangerBg: 'rgba(192,52,43,.08)', dangerLine: 'rgba(192,52,43,.28)',
        ok: '#1f8f57', warn: '#8a5a00', err: '#a82a22',
      },
      // 深色：沿用 0.6 原来的观感
      dark: {
        fg: '#ececf1', fg2: '#c9c9d1', fg3: '#9a9aa5', cap: '#8a8a93',
        surface: '#1b1b1d', surface2: '#141416', inset: 'rgba(16,16,18,.72)', chip: 'rgba(255,255,255,.07)',
        line: 'rgba(255,255,255,.20)', line2: 'rgba(255,255,255,.11)',
        hover: 'rgba(255,255,255,.08)', shadow: '0 10px 30px rgba(0,0,0,.45)',
        acc: 'var(--dsw-alias-state-business-primary, #4a9eff)', accFg: '#ffffff',
        danger: '#d9534f', dangerFg: '#f2777a', dangerBg: 'rgba(242,119,122,.10)', dangerLine: 'rgba(242,119,122,.28)',
        ok: '#3ecf8e', warn: '#e0a83a', err: '#f2777a',
      },
    }
    /** token 名 → CSS 变量名（内联样式只认 `var(--po06-*)`）。 */
    const TOKEN_VARS = {
      fg: '--po06-fg', fg2: '--po06-fg2', fg3: '--po06-fg3', cap: '--po06-cap',
      surface: '--po06-surface', surface2: '--po06-surface2', inset: '--po06-inset', chip: '--po06-chip',
      line: '--po06-line', line2: '--po06-line2', hover: '--po06-hover', shadow: '--po06-shadow',
      acc: '--po06-acc', accFg: '--po06-acc-fg',
      danger: '--po06-danger', dangerFg: '--po06-danger-fg', dangerBg: '--po06-danger-bg', dangerLine: '--po06-danger-line',
      ok: '--po06-ok', warn: '--po06-warn', err: '--po06-err',
    }
    /** 取 token 的 CSS 值（内联样式用；名字写错会立刻炸，而不是静默变透明）。 */
    const T = (name) => {
      const v = TOKEN_VARS[name]
      if (!v) throw new Error('unknown theme token: ' + name)
      return 'var(' + v + ')'
    }
    /** 生成 token 定义：浅色为默认，深色有**三个**来源（缺一个就会出现"半深半浅"）。 */
    const themeTokensCss = () => {
      const block = (sel, t) => sel + '{' + Object.keys(TOKEN_VARS).map((k) => TOKEN_VARS[k] + ':' + t[k]).join(';') + '}'
      // ⚠ 选择器要覆盖**三种命中方式**（2026-09-22 真机教训：浅色模式下整个面板仍是深色）：
      //   `[data-po06]` 这个选择器匹配**每一个**带该属性的元素——插件里思维层、折叠体、面板、弹层
      //   **各自**都带 `data-po06`，所以它们会**各自重新声明**浅色 token，把祖先上的深色覆盖掉/被覆盖掉。
      //   实测症状：面板（根元素，命中 `[data-po06][data-po06-theme=dark]`）是深色，
      //   而思维层正文（后代，只命中 `[data-po06]` 的浅色）是浅色 ⇒ **一块深面板里嵌一块浅底**。
      //   所以深色必须同时提供"自身命中"与"祖先命中"两条规则，谁的优先级高都要能覆盖浅色默认。
      return block('[data-po06]', THEME_TOKENS.light)
        + block('[data-po06][data-po06-theme="dark"]', THEME_TOKENS.dark)   // 标记在自己身上
        + block('[data-po06-theme="dark"] [data-po06]', THEME_TOKENS.dark)  // 标记在祖先上（后代元素）
        + block('[data-ds-dark-theme] [data-po06]', THEME_TOKENS.dark)      // DSH 自己的深色属性
        // ⚠ 浅色必须**显式**写、而且放在最后（2026-09-30 用户：「只有黑色模式」）：
        //   上面那条「祖先深色 ⇒ 后代深色」与它是**同权重**，只能靠先后顺序决胜；
        //   少了这两条，一个声明了 light 的卡片落在深色祖先里就再也翻不回浅色。
        + block('[data-po06][data-po06-theme="light"]', THEME_TOKENS.light)
        + block('[data-po06-theme="light"] [data-po06]', THEME_TOKENS.light)
    }

    // P11 浮层的配色 token：**逐条取自 0.5 的那张 CSS**（0.5:3259-3272 的自定义属性 + 各处的
    // `var(--dsw-…)` 兜底值）。0.5 把变量定义在 `.dpo-overlay` 上、用 `color-mix` 派生透明变体；
    // 0.6 只用内联样式 ⇒ 这里把**用得到的那几个**写成常量，透明变体直接写 rgba（色值同源）。
    // ⚠ 2026-09-22：颜色值不再写死，一律走上面的主题 token（浅色/深色各一套取值）。
    const OVS = {
      acc: T('acc'),
      acc12: 'color-mix(in srgb, ' + T('acc') + ' 14%, transparent)',
      acc22: 'color-mix(in srgb, ' + T('acc') + ' 26%, transparent)',
      surface: T('surface'),
      line: T('line'),
      lineSoft: T('line2'),
      fg: T('fg'),
      fg2: T('fg2'),
      fg3: T('fg3'),
      cap: T('cap'),
      bg1: T('surface2'),
      danger: T('danger'),
      dangerFg: T('dangerFg'),
      dangerBg: T('dangerBg'),
      dangerLine: T('dangerLine'),
      ok: T('ok'),
    }

    /** token 数字：过千用 k（用户 2026-09-21："过大的 token 数可以用多少多少 k 来显示"）。 */
    const fmtTok = (n) => {
      if (n == null) return '—'
      const v = Number(n)
      if (!Number.isFinite(v)) return '—'
      if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M'
      if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
      return String(v)
    }
    /**
     * 用量归一化（**容错**）：既认归一化后的 `{in,out,cache,total}`，也认 provider 原始字段。
     *
     * 为什么必须容错（2026-10-01 真机 bug）：同一个页脚会从两条路拿到用量——
     *   · `presentationMeta.usage`：宿主侧已用 advisor.js 的 usageParts() 归一化过；
     *   · `run.result.usage`（进度记录）：那是 **provider 原始字段**
     *     `{inputTokens,outputTokens,cacheReadTokens,totalTokens}`。
     * 卡片原先优先取后者 ⇒ usageText 认的四个键全 undefined ⇒ 页脚恒显 `Σ — tok`。
     * 修在格式化的入口（而不是各调用点）：这样**已经落盘的旧记录**也一并修好，不必重跑咨询。
     * 只做字段改名，**不折算、不估算**：拿不到的项仍然是 null → 显示 `—`。
     */
    const normalizeUsage = (u) => {
      if (!u || typeof u !== 'object') return null
      const num = (...keys) => {
        for (const k of keys) if (typeof u[k] === 'number' && Number.isFinite(u[k])) return u[k]
        return null
      }
      const inp = num('in', 'inputTokens', 'prompt_tokens', 'promptTokens', 'uncachedInputTokens')
      const out = num('out', 'outputTokens', 'completion_tokens', 'completionTokens')
      const cache = num('cache', 'cacheReadTokens', 'cachedTokens', 'cached_tokens', 'prompt_cache_hit_tokens')
      const t0 = num('total', 'totalTokens', 'total_tokens')
      // 合计**只认 provider 给的**；没给就不替它算（保持“不估算”口径，宁可显示 —）。
      const total = t0
      if (inp == null && out == null && cache == null && total == null) return null
      return { in: inp, out, cache, total }
    }
    /**
     * 用量文案：**只显示 provider 真给的字段，不折算、不估算**（拿不到的项显示 `—`）。
     * 解释层的拦截浮层与顾问卡片页脚共用同一套口径（2026-09-30 抽出，原先只有浮层里那份内联实现）。
     */
    const usageText = (rawUsage, withTotal) => {
      const u = normalizeUsage(rawUsage)
      if (!u) return 'Σ — tok'
      return (withTotal && u.total != null ? 'Σ ' + fmtTok(u.total) + ' tok | ' : 'Σ ') + L('入', 'in') + ' ' + fmtTok(u.in)
        + ' · ' + L('出', 'out') + ' ' + fmtTok(u.out)
        + ' · ' + L('缓存', 'cache') + ' ' + fmtTok(u.cache)
        + ' tok'
    }

    // ── 与宿主 API 的薄封装 ───────────────────────────────────────────
    // 两条都不许把 raw 异常抛到调用方：网络层失败也要变成**可读原因**
    // （`SyntaxError: Unexpected end of JSON input` 这种原样冒到界面上，用户只会以为插件坏了）。
    async function apiGet(path, opts) {
      let r
      try { r = await fetch(API + path, { headers: { accept: 'application/json' }, signal: opts && opts.signal, cache: opts && opts.cache }) }
      catch (e) { throw new Error('unreachable') }
      const j = await r.json().catch(() => null)
      if (!r.ok || !j || j.ok !== true) throw new Error((j && j.reason) || ('http-' + r.status))
      return j
    }
    async function apiPost(path, body, opts) {
      let r
      try { r = await fetch(API + path, { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify(body || {}), signal: opts && opts.signal }) }
      catch (e) { return { ok: false, reason: (e && e.name === 'AbortError') ? 'aborted' : 'unreachable' } }
      const j = await r.json().catch(() => null)
      if (!j || typeof j !== 'object') return { ok: false, reason: 'bad-json-response' }
      return (j.ok === true || j.reason) ? j : { ...j, ok: false, reason: 'http-' + r.status }
    }

    // ── 把任何失败都变成"人话" ────────────────────────────────────────
    // 已知原因给固定说法，未知原因截断到一行——**绝不允许 raw 异常冒到界面**。
    const briefly = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 120)
    /**
     * 宿主尚未加载该项时的**可执行**提示（2026-09-27）。
     *
     * 现象：设置其实写成功了（ok:true），但 problems 里有 not-session-scoped / unknown-field，
     * 界面按默认回退 —— 用户看到的是「已保存，但…按默认处理」，然后值自己弹回去，像坏了一样。
     * 真因几乎总是**宿主仍跑旧模块**（热重载只清 1 个模块，依赖仍走缓存）。
     * 与其让用户面对一个静默回退，不如直接说清该怎么办。
     */
    function staleSchemaHint(problems) {
      const hit = (problems || []).some((x) => /not-session-scoped|unknown-field/.test(String((x && x.kind) || ''))
        || /^bySession\[/.test(String((x && x.key) || '')))
      return hit
        ? L('（当前宿主还没加载这一项：重启 DSH 后生效）', ' (the host has not loaded this setting yet — restart DSH)')
        : ''
    }
    function reasonText(reason) {
      const raw = briefly(reason)
      const http = /^http-(\d+)$/.exec(raw)
      if (http) return L('服务返回 HTTP ' + http[1], 'Server returned HTTP ' + http[1])
      if(raw==='english-mode-disabled')return L('英文模式已关闭，请重新发送或按原文发送','English mode is off; retry or send the original')
      if(raw==='english-input-superseded')return L('输入已更新，这次译文没有发送','Input changed; this translation was not sent')
      if(raw==='english-translation-empty')return L('翻译没有返回完整文本，可以重试或按原文发送','Translation returned no complete text; retry or send the original')
      if(raw==='english-translation-incomplete')return L('翻译调用未完成，可以重试或按原文发送','Translation did not finish; retry or send the original')
      if (raw === 'unreachable') return L('连不上宿主服务（它可能刚重启）', 'Cannot reach the host service (it may have just restarted)')
      if (raw === 'bad-json-response') return L('服务返回的内容读不出来', 'The server response could not be parsed')
      if (raw === 'backup-unusable') return L('旧配置的备份不可用，这次没有写入', 'Backup of the old config was unusable, so nothing was written')
      if (raw === 'readback-unparsable') return L('写进去的设置读不回来，已中止', 'Written settings could not be read back; aborted')
      if (/^readback-mismatch:/.test(raw)) return L('写回校验不一致：' + briefly(raw.slice(17)), 'Read-back mismatch: ' + briefly(raw.slice(17)))
      if (/^write-failed:/.test(raw)) return L('写文件失败：' + briefly(raw.slice(13)), 'Write failed: ' + briefly(raw.slice(13)))
      return raw || L('未知原因', 'unknown reason')
    }
    const errorText = (e) => reasonText((e && e.message) || e)

    // ── 小状态钩子（轮询，不引入任何依赖）────────────────────────────
    function usePoll(fn, ms) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const tick = React.useCallback(() => {
        let alive = true
        fn().then(
          (data) => { if (alive) setState({ loading: false, data, error: null }) },
          (e) => { if (alive) setState((s) => ({ loading: false, data: s.data, error: String((e && e.message) || e) })) },
        )
        return () => { alive = false }
      }, [fn])
      React.useEffect(() => {
        let cancel = tick()
        const t = window.setInterval(() => { cancel = tick() }, ms)
        return () => { window.clearInterval(t); if (typeof cancel === 'function') cancel() }
      }, [tick, ms])
      return [state, tick]
    }

    // ⚠ 0.7.7：带上 session —— 档位改成会话级后，界面必须读【本会话生效的档位】，
//   而不是全局那个（否则 A 会话设成关闭、B 会话的界面也跟着显示关闭）。
const useStatus = (sessionId) => usePoll(React.useCallback(
  () => apiGet('/status?build=' + encodeURIComponent(CLIENT_BUILD)
    + (sessionId ? ('&session=' + encodeURIComponent(sessionId)) : '')),
  [sessionId]), 15000)
    const useTurns = (n) => usePoll(React.useCallback(() => apiGet('/turns?limit=' + n), [n]), 15000)
    const useState_ = (sid) => usePoll(
      React.useCallback(() => (sid ? apiGet('/state?session=' + encodeURIComponent(sid)) : Promise.resolve(null)), [sid]),
      10000,
    )

    /**
     * 「拉一次 + 可以重试」的小钩子（`/models` 用它）。
     * 失败时 state.error 是 Error 对象，**由调用方翻译成人话**（见 reasonText）；
     * 卸载后回来的响应一律丢弃（否则会给已卸载的组件 setState）。
     */
    function useOnce(fn) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const live = React.useRef(true)
      const run = React.useCallback(() => {
        setState((x) => ({ loading: true, data: x.data, error: null }))
        fn().then(
          (data) => { if (live.current) setState({ loading: false, data, error: null }) },
          (e) => { if (live.current) setState({ loading: false, data: null, error: e }) },
        )
      }, [fn])
      React.useEffect(() => { live.current = true; run(); return () => { live.current = false } }, [run])
      return [state, run]
    }

    // ── 浮层层级：**唯一来源**（issue #18）─────────────────────────────────
    // 背景（报告者给的实测数值）：第三方右侧边栏把统一面板宿主挂在 `document.body`、`z-index: 25`，
    // 它自己的浮窗是 `z-index: 90`；app 的 overlay stack 在 100+。
    // 本插件原先的浮层是 60/70/80/88 —— **即使不被裁进层叠上下文，也压不过 90/100+**。
    // 所以统一抬到 1000 段，并保持原有的相对次序（选项弹层 < 帮助 < 拦截浮层 < 悬浮球）。
    // ⚠ `position: fixed` 若落在有 transform/filter 的祖先里仍会被关在那层上下文内；
    //   真正的治本做法是 portal 到 document.body（需要 react-dom，未在本机浏览器实测）——留在 issue 里跟进。
    const OV_Z = { pop: 1000, help: 1010, panel: 1020, ov: 1030, ball: 1040 }
    // ── 共用的样式与小部件 ───────────────────────────────────────────
    const S = {
      chip: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 8px', borderRadius: '10px',
        border: '1px solid ' + OVS.line, fontSize: '12px', lineHeight: '18px', cursor: 'pointer',
        background: 'transparent', color: 'inherit' },
      dot: (on) => ({ width: '7px', height: '7px', borderRadius: '50%', background: on ? OVS.ok : OVS.cap }),
      panel: { position: 'fixed', right: '16px', bottom: '84px', width: '420px', maxHeight: '70vh', overflow: 'auto',
        background: OVS.surface, color: OVS.fg,
        border: '1px solid ' + OVS.line, borderRadius: '12px', padding: '14px', zIndex: OV_Z.panel,
        boxShadow: T('shadow'), fontSize: '13px' },
      row: { display: 'flex', gap: '10px', alignItems: 'center', margin: '10px 0' },
      label: { minWidth: '92px', color: OVS.fg2 },
      select: { flex: 1, padding: '4px 6px', borderRadius: '6px', border: '1px solid ' + OVS.line,
        background: 'transparent', color: 'inherit' },
      btn: { padding: '4px 10px', borderRadius: '6px', border: '1px solid ' + OVS.line,
        background: 'transparent', color: 'inherit', cursor: 'pointer' },
      // ── 「优化选项」入口与弹出面板（极简：一个按钮 + 一块克制的卡片）──────────
      optBtn: { display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '4px 11px 4px 9px',
        borderRadius: '10px', border: '1px solid ' + OVS.line, background: T('chip'),
        color: 'inherit', cursor: 'pointer', fontSize: '12px', lineHeight: '18px' },
      optBtnOn: { background: T('hover'), borderColor: OVS.acc, boxShadow: '0 0 0 2px ' + OVS.acc12 },
      optBtnText: { fontWeight: 600, letterSpacing: '.2px' },
      // 对话流里的「本次注入」卡片（宿主 chat row）：一条克制的横条，点开才是三段
      injRow: { border: '1px solid transparent', borderLeft: '2px solid ' + OVS.acc,
        borderRadius: '12px', background: T('inset'), overflow: 'hidden' },
      injHead: { display: 'flex', alignItems: 'center', gap: '7px', width: '100%', boxSizing: 'border-box',
        padding: '6px 11px', border: 'none', background: 'transparent', color: 'inherit', font: 'inherit',
        fontSize: '12px', lineHeight: '18px', textAlign: 'left', cursor: 'pointer' },
      injBody: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 10px 10px', borderTop: '1px solid ' + OVS.line2 },
      // ── 预设提示弹窗（2026-10-19）：主题色只点在"信号点 + 主动作"上，其余保持克制 ──
      noticeBackdrop: { position: 'fixed', inset: 0, zIndex: 1050, display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'rgba(8,10,14,.42)', backdropFilter: 'blur(2px)' },
      noticeCard: { width: 'min(420px, 92vw)', boxSizing: 'border-box', padding: '20px 20px 16px', borderRadius: '16px',
        background: OVS.surface, color: OVS.fg, border: '1px solid ' + OVS.acc22, boxShadow: T('shadow'),
        display: 'flex', flexDirection: 'column', gap: '8px' },
      noticeHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      noticeAccent: { flex: '0 0 auto', width: '8px', height: '8px', borderRadius: '50%', background: OVS.acc,
        boxShadow: '0 0 0 3px ' + OVS.acc12 },
      noticeTitle: { fontSize: '14px', fontWeight: 700, letterSpacing: '.2px' },
      noticeBody: { margin: 0, fontSize: '12.5px', lineHeight: '1.65', color: OVS.fg2 },
      noticeHint: { margin: 0, fontSize: '11px', color: OVS.fg3 },
      noticeActions: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '6px' },
      noticeBtn: { padding: '6px 14px', borderRadius: '10px', border: '1px solid ' + OVS.line,
        color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer' },
      noticeBtnPrimary: { padding: '6px 14px', borderRadius: '10px', border: '1px solid transparent',
        background: OVS.acc, color: '#fff', font: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
      // ⚠ 用**颜色**压暗，不用 opacity：浅色底上 `opacity:.65` 会变成看不清的浅灰细字（用户截图）。
      optSummary: { color: OVS.fg3, fontSize: '11px', whiteSpace: 'nowrap' },
      optCaret: { color: OVS.fg3, fontSize: '10px', lineHeight: 1 },
      optPop: { position: 'fixed', zIndex: OV_Z.pop, width: '320px', maxHeight: 'min(64vh, 480px)', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px 18px',
        background: OVS.surface, color: OVS.fg,
        border: '1px solid ' + OVS.lineSoft, borderRadius: '16px',
        boxShadow: T('shadow') },
      optPopHead: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 700,
        color: OVS.fg, letterSpacing: '.2px', paddingBottom: '2px' },
      optRow: { display: 'grid', gridTemplateColumns: '64px 1fr', alignItems: 'center', gap: '10px' },
      optLabel: { color: OVS.fg3, fontSize: '12px', whiteSpace: 'nowrap' },
      // 面板里的按钮（只读工具 / 详情）也**铺满整格**：点击范围与看到的格子一致，不留死区
      // C：整行按钮要有**色域**（色块感），否则和纯文本没区别（2026-10-19 用户截图反馈）
      optWide: { width: '100%', boxSizing: 'border-box', textAlign: 'center',
        padding: '8px 10px', borderRadius: '10px', border: '1px solid transparent',
        background: T('chip'), color: 'inherit', font: 'inherit', fontSize: '12.5px', cursor: 'pointer' },
      // 设置行（2026-10-19 观感）：左侧标签、右侧状态值；整行有底色，状态值用主题色
      optRowBtn: { display: 'flex', width: '100%', boxSizing: 'border-box', alignItems: 'center',
        justifyContent: 'space-between', gap: '10px', padding: '8px 12px',
        borderRadius: '10px', border: '1px solid transparent', background: T('chip'),
        color: 'inherit', font: 'inherit', fontSize: '12.5px', cursor: 'pointer', textAlign: 'left' },
      optVal: (on) => ({ color: on ? OVS.acc : OVS.fg3, fontWeight: 600, letterSpacing: '.2px' }),
      optFoot: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px',
        paddingTop: '4px', marginTop: '0' },
      // 实验性分区：一条实线 + 小字标题，和上面的常规设置明确分开（用户要求写得像"另一块区域"）
      optDivider: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px',
        paddingTop: '10px', borderTop: '2px solid ' + OVS.line, color: OVS.fg3,
        fontSize: '11px', fontWeight: 600, letterSpacing: '.4px' },
      ta: { width: '100%', minHeight: '120px', borderRadius: '6px', border: '1px solid ' + OVS.line,
        background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: '12px', padding: '6px' },
      muted: { color: OVS.fg3, fontSize: '12px' },
      h: { margin: '16px 0 8px', fontSize: '13.5px', fontWeight: 700, letterSpacing: '.2px' },
      prov: (p) => ({ fontSize: '11px', padding: '0 5px', borderRadius: '8px', marginLeft: '6px',
        background: p === 'user' ? 'rgba(57,192,122,.18)' : (p === 'machine' ? 'rgba(120,150,255,.18)' : 'rgba(230,90,90,.22)') }),
      // P10 控件栏专用（要能在输入区那一行里挤下，所以比浮层里的控件小一号）
      bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', fontSize: '12px',
        lineHeight: '18px', color: 'inherit' },
      // 控件栏分两层：每层各自横排、可换行（行内间距沿用原来的 6px）
      barRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      grp: { display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' },
      // 分段控件：**铺满整格**（用户 2026-09-22："这几个按钮都没有布满区域,而且实际点击区域和反应区域还不一样"）。
      // 判据两条：① 容器 `width:100%` + 每项 `flex:1 1 0` ⇒ 视觉上填满；② 命中判定本来就按**容器矩形**等分
      // （见 Segmented.indexAt）⇒ 只要容器填满，点击范围就与看到的格子重合。
      seg: { display: 'flex', width: '100%', boxSizing: 'border-box', alignItems: 'stretch',
        border: '1px solid ' + OVS.lineSoft, borderRadius: '12px', overflow: 'hidden',
        background: T('chip'),
        fontSize: '12px', lineHeight: '18px', userSelect: 'none', touchAction: 'none' },
      segItem: { flex: '1 1 0', textAlign: 'center', padding: '5px 7px', whiteSpace: 'nowrap',
        color: OVS.fg2, cursor: 'inherit',
        // 分段项是 div（不在全局 button 过渡里），单独给一条，切换档位时颜色才"滑"得过去
        transition: 'background-color .16s ease, color .16s ease, box-shadow .16s ease' },
      // 选中态：用 **DSH 的主题副色**（原版就是蓝）——只染底色与文字，克制、不加粗边框
      segOn: { background: OVS.acc, color: '#fff', fontWeight: 600 },
      small: { padding: '1px 8px', borderRadius: '8px', border: '1px solid ' + OVS.line,
        background: 'transparent', color: 'inherit', fontSize: '12px', lineHeight: '18px', cursor: 'pointer' },
      // 弹出面板里的下拉：**底色/文字必须成对取自同一套 token**（见 THEME_TOKENS）。
      // 旧写法用 `var(--dsw-alias-bg-l1, #141414)`：本机取不到该变量 ⇒ 深色兜底 + 浅色模式的深色文字
      // = **深字压深底**（用户浅色截图里那个黑框）。现在两个都来自 `--po06-*`，不可能再错配。
      optSelect: { width: '100%', boxSizing: 'border-box', padding: '3px 6px', borderRadius: '8px',
        border: '1px solid ' + OVS.line, background: OVS.bg1,
        color: OVS.fg, font: 'inherit', fontSize: '12px', cursor: 'pointer' },
      dis: { opacity: .45, filter: 'grayscale(1)', cursor: 'not-allowed' },
      // 「?」帮助弹层（要求②）：正文由宿主从包里的 HELP-0.6.md 取，这里只做最轻的排印
      helpPop: { position: 'fixed', right: '16px', bottom: '84px', width: 'min(600px, 92vw)', maxHeight: '74vh',
        overflow: 'auto', background: OVS.surface,
        color: OVS.fg, border: '1px solid ' + OVS.line,
        borderRadius: '12px', padding: '14px', zIndex: OV_Z.help, boxShadow: T('shadow'),
        fontSize: '12.5px', lineHeight: '19px' },
      helpTitle: { fontWeight: 700, fontSize: '14px', margin: '2px 0 6px' },
      helpH: { fontWeight: 600, margin: '10px 0 4px' },
      helpP: { margin: '2px 0' },
      helpQuote: { color: OVS.fg3, borderLeft: '3px solid ' + OVS.line, paddingLeft: '8px', margin: '4px 0' },
      // 表格行：细横线分隔；首列压暗，像真正的表
      helpTr: { display: 'flex', gap: '8px', padding: '4px 0', borderBottom: '1px solid ' + OVS.line2 },
      helpTd: { flex: '1 1 0', minWidth: 0 },
      helpTdKey: { flex: '0 0 34%', minWidth: 0, color: OVS.fg3 },
      // ── P11 拦截浮层（**照 0.5 的观感复刻**；0.6 只用内联样式对象，不注入 <style>）─────────
      // 0.5 用一张 CSS 字符串（`.dpo-*`）注入页面；0.6 的纪律是内联样式 ⇒ 这里把 0.5 里
      // **决定观感的那几条**逐条翻过来：尺寸/间距/圆角/配色/层级/滚动归属（底栏在滚动区之外）。
      // ❗**有意不搬**的部分（写在前面免得被当成漏搬）：`:hover` / `:active` / `@keyframes` /
      //   毛玻璃 / 渐变。内联样式表达不了伪类与关键帧 ⇒ 由**下面注入的一小段样式表**承担
      //   （`NS + '-ui'`，卸载即摘）。布局与配色仍然全在内联样式里，可预测、好测。
      ov: { position: 'fixed', left: 0, top: 0, zIndex: OV_Z.ov, display: 'flex', flexDirection: 'column',
        width: '460px', minWidth: '360px', minHeight: '240px', maxHeight: 'min(78vh, 660px)',
        background: OVS.surface, border: '1px solid ' + OVS.line, borderRadius: '14px',
        boxShadow: T('shadow'), color: OVS.fg, fontSize: '12px',
        overflow: 'hidden', pointerEvents: 'auto', willChange: 'transform', touchAction: 'none' },
      ovHead: { display: 'flex', alignItems: 'center', gap: '0', flex: '0 0 auto', padding: '12px 16px',
        borderBottom: '1px solid ' + OVS.lineSoft, background: OVS.surface, cursor: 'grab', userSelect: 'none' },
      ovScroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column' },
      ovRun: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px 16px' },
      ovRunStatus: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0', fontSize: '11px',
        letterSpacing: '.2px', color: OVS.fg3 },
      ovChip: { marginLeft: 'auto', fontSize: '10.5px', fontWeight: 600, letterSpacing: '.2px',
        padding: '1px 7px', borderRadius: '5px', background: OVS.acc12, color: OVS.acc,
        border: '1px solid ' + OVS.acc22, whiteSpace: 'nowrap' },
      ovChipMuted: { marginLeft: 'auto', fontSize: '10.5px', padding: '1px 7px', borderRadius: '5px',
        background: T('chip'), color: OVS.fg3, border: '1px solid transparent', whiteSpace: 'nowrap' },
      ovPane: { border: '1px solid ' + OVS.lineSoft, borderRadius: '8px', padding: '8px 10px',
        maxHeight: '132px', overflow: 'auto', background: 'transparent' },
      ovPaneTitle: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11.5px',
        letterSpacing: '.4px', color: OVS.fg3, marginBottom: '7px' },
      ovPaneBody: { whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: '1.68', color: OVS.fg2,
        wordBreak: 'break-word' },
      ovReview: { display: 'flex', flexDirection: 'column', gap: '8px' },
      ovReviewText: { width: '100%', boxSizing: 'border-box', minHeight: '150px', maxHeight: '300px',
        overflowY: 'auto', resize: 'vertical', whiteSpace: 'pre-wrap', background: OVS.bg1,
        color: OVS.fg, border: '1px solid ' + OVS.line, borderRadius: '8px', padding: '9px 11px',
        fontSize: '13px', lineHeight: '1.72', fontFamily: 'inherit' },
      ovHintQuiet: { fontSize: '10.5px', color: OVS.cap, lineHeight: '1.5' },
      ovError: { display: 'flex', alignItems: 'center', gap: '8px', borderRadius: '10px',
        padding: '7px 9px', background: OVS.dangerBg, border: '1px solid ' + OVS.dangerLine,
        color: OVS.dangerFg, fontSize: '11.5px', lineHeight: '1.6', wordBreak: 'break-all' },
      // 折叠（0.5:1487-1501 disclosure / 3449-3460 的 .dpo-fold*）——原文与产出共用同一形态
      ovFold: { borderTop: '1px solid ' + OVS.line2 },
      ovFoldHead: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 16px',
        border: 'none', background: 'transparent', color: OVS.fg3, fontSize: '11.5px', textAlign: 'left',
        cursor: 'pointer', fontFamily: 'inherit' },
      ovFoldCaret: { flex: '0 0 auto', fontSize: '12px', color: OVS.cap, transition: 'transform .24s' },
      ovFoldTitle: { flex: '0 0 auto', letterSpacing: '.4px' },
      ovFoldSum: { flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', color: OVS.fg3, fontSize: '11px' },
      // ⚠ 思维层的底色**不能写死深色**（用户 2026-09-22 浅色截图：这里是一块黑底，
      //   而文字取的是浅色主题的深灰 ⇒ 深字压黑底，读不出来）。现在底色与文字都来自同一套 token。
      ovFoldText: { margin: '0 12px 10px', padding: '9px 11px', borderRadius: '12px',
        background: T('inset'), color: OVS.fg2, fontSize: '12.5px', lineHeight: '1.65',
        // 用户 2026-09-21：思维层要**固定显示范围 + 自己滚动**（不是无限撑高，也不是两根滚动条）。
        // 落点：折叠体是**唯一**的滚动容器（固定高度 220px / 最多 34vh），浮层滚动区不再自己滚
        // （见 `ovScrollY`），于是"一处滚动、固定范围、可回看全文"三件事同时成立。
        // 用户 2026-09-21（两次反馈的合并落点）：
        //   ① "去掉右侧那根滚轮（滚动条）"  ⇒ **不显示**滚动条；
        //   ② "现在思维层的内容无法滚动了"  ⇒ **不许**把滚动能力一起拿掉。
        // 所以这里是"固定高度的窗口 + 可滚动但隐藏滚动条"（观感无条、内容能往回滚着看），
        // 滚动条外观由注入的一条 `::-webkit-scrollbar{width:0}` 规则隐藏（见 ensureHideScrollbar）。
        whiteSpace: 'pre-wrap', maxHeight: 'min(220px,34vh)',
        overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', msOverflowStyle: 'none' },
      /** 浮层滚动区在"思维层展开"时**不滚动**，避免和上面那处叠成两根滚动条。 */
      // 全局滚动区（**0.5 的那根滑块**）。用户 2026-09-22："自适应大小防止功能性区域被遮住，
      // 或者增加一个类似 0.5.x 的全局滑块"。这里两条一起做：
      //   · 面板本身有 `maxHeight: min(78vh,660px)`，窗口变化时还会重新夹紧（自适应）；
      //   · 内容装不下时**由这一处滚动**（细滚动条，见下面注入的样式），按钮行/产出层不会再被裁掉。
      // 思维层仍是**它自己那个固定窗口**（内部滚动条隐藏），所以"两根可见滑块"的旧毛病不会回来。
      ovScrollY: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        overscrollBehavior: 'contain' },
      // 常驻底栏：**在滚动区之外**（0.5:3542-3545）——面板再小、内容再长，关键按钮都不被滚走
      ovFoot: { flex: '0 0 auto', position: 'relative', zIndex: 3, borderTop: '1px solid ' + OVS.line2 },
      ovFootInner: { display: 'flex', flexDirection: 'column' },
      ovActions: { display: 'flex', gap: '10px', padding: '12px 16px', alignItems: 'center' },
      ovBtn: { flex: '1 1 0', minWidth: 0, height: '30px', borderRadius: '10px', border: '1px solid ' + OVS.line,
        background: 'transparent', color: OVS.fg2, fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'inherit', fontWeight: 500, letterSpacing: '.2px' },
      ovBtnPrimary: { borderColor: 'transparent', background: OVS.acc, color: '#fff' },
      ovBtnDanger: { borderColor: 'transparent', background: OVS.danger, color: '#fff' },
      ovBtnGhost: { flex: '0 0 auto', padding: '0 12px', borderColor: 'transparent', background: 'transparent',
        color: OVS.fg3 },
      ovSentTag: { flex: '1 1 auto', fontSize: '11.5px', color: OVS.cap, letterSpacing: '.3px' },
      // 右下角改尺寸把手（0.5:3225 / 3376-3377：斜纹 + 悬停变主色；悬停色内联表达不了，只搬斜纹）
      ovGrip: { position: 'absolute', right: '3px', bottom: '3px', width: '16px', height: '16px', zIndex: 6,
        cursor: 'nwse-resize', opacity: .7, borderRadius: '5px',
        background: 'linear-gradient(135deg,transparent 42%,#888 42%,#888 52%,transparent 52%,transparent 62%,#888 62%,#888 72%,transparent 72%)' },
      ovX: { flex: '0 0 auto', height: '22px', padding: '0 9px', marginLeft: '6px', borderRadius: '999px',
        border: '1px solid transparent', background: 'transparent', color: OVS.fg2, fontSize: '11px',
        cursor: 'pointer', fontFamily: 'inherit' },
      ovHeadTitle: { flex: '0 0 auto', fontSize: '12px', letterSpacing: '.4px', color: OVS.fg2 },
      ovHeadTier: { flex: '0 0 auto', fontSize: '11px', fontWeight: 600, letterSpacing: '.3px', padding: '1px 8px',
        marginLeft: '8px', borderRadius: '5px', background: OVS.acc12, color: OVS.acc, border: '1px solid ' + OVS.acc22 },
      ovHeadCount: { flex: '0 0 auto', fontSize: '10px', padding: '1px 6px', marginLeft: '6px',
        borderRadius: '5px', background: T('chip'), color: OVS.fg3 },
      ovHeadHint: { marginLeft: 'auto', fontSize: '10px', padding: '1px 7px', borderRadius: '5px',
        background: T('chip'), color: OVS.fg3, whiteSpace: 'nowrap' },
      // 头的状态灯：0.5 用 `.dpo-overlay-head::before` + `[data-state]` 换色（0.5:3337-3340）
      // 0.5 的三态：running=主色 / done=绿 / error=红（其余灰）—— 0.6 的阶段按同一语义落色。
      ovDot: (phase) => ({ flex: '0 0 auto', width: '7px', height: '7px', marginRight: '8px', borderRadius: '50%',
        background: phase === 'optimizing' ? OVS.acc
          : ((phase === 'review' || phase === 'sent' || phase === 'skipped') ? OVS.ok
            : ((phase === 'error' || phase === 'failed') ? OVS.dangerFg : OVS.cap)) }),
      // 46px 悬浮球（0.5:3533-3539 / 3636-3637）
      ball: (tone, sent) => ({ position: 'fixed', left: 0, top: 0, zIndex: OV_Z.ball, display: 'flex',
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1px',
        width: '46px', height: '46px', borderRadius: '50%', cursor: 'grab', touchAction: 'none',
        color: '#fff', background: tone, boxShadow: '0 4px 14px rgba(0,0,0,.28)',
        opacity: sent ? .82 : 1, userSelect: 'none' }),
      ballIcon: { fontSize: '15px', lineHeight: 1, opacity: .95 },
      ballLabel: { fontSize: '9px', letterSpacing: '.5px', opacity: .9 },
    }

    // ────────────────────────────────────────────────────────────────
    // 视觉基线 v2（2026-10-19 第二轮）：**紧凑、清晰、安静**。
    // 目标是"层级一眼可读 + 操作不费劲"，不是把东西做大；任何一屏都按
    // 标题(10-12.5) / 主值(12, 600) / 次值(11, fg3) / 操作(28px 高) 四层排。
    // 圆角 8/10/12；间距 4/6/8/10/12/14；浮层只靠阴影与底色分层，描边极淡。
    // ────────────────────────────────────────────────────────────────
    const SHADOW = {
      card: '0 1px 2px rgba(0,0,0,.05)',
      float: '0 18px 44px -20px rgba(0,0,0,.50), 0 1px 4px rgba(0,0,0,.10)',
    }
    const TYPE = {
      label: { color: OVS.fg3, fontSize: '10px', fontWeight: 600, letterSpacing: '.08em' },
      title: { color: OVS.fg, fontSize: '12.5px', fontWeight: 700, letterSpacing: '.15px' },
      value: { color: OVS.fg, fontSize: '12px', fontWeight: 650 },
      body: { color: OVS.fg2, fontSize: '12px', lineHeight: '1.55' },
    }
    Object.assign(S, {
      // ① 控件栏：一行放得下，不撑高输入区
      bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', fontSize: '12px',
        lineHeight: '18px', color: 'inherit' },
      barRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
      optBtn: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '3px 10px 3px 8px',
        borderRadius: '8px', border: '1px solid ' + OVS.lineSoft, background: T('chip'),
        color: 'inherit', cursor: 'pointer', fontSize: '12px', lineHeight: '18px' },
      optBtnOn: { background: T('hover'), borderColor: OVS.acc, boxShadow: '0 0 0 3px ' + OVS.acc12 },
      optBtnText: { fontWeight: 600, letterSpacing: '.2px' },
      // ② 弹出面板：288 宽、12/14 内距，紧凑但不挤
      optPop: { position: 'fixed', zIndex: OV_Z.pop, width: '320px', maxHeight: 'min(76vh, 620px)', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: '7px', padding: '12px 14px 8px',
        background: OVS.surface, color: OVS.fg,
        border: '1px solid ' + OVS.lineSoft, borderRadius: '12px', boxShadow: SHADOW.float },
      optPopHead: { display: 'flex', alignItems: 'center', gap: '7px', ...TYPE.title, paddingBottom: '0' },
      optRow: { display: 'grid', gridTemplateColumns: '58px 1fr', alignItems: 'center', gap: '10px', minHeight: '28px' },
      // 行标签要看得清：用 fg2 而不是 fg3（用户 2026-10-19：小标题太淡）
      optLabel: { color: OVS.fg2, fontSize: '12px', fontWeight: 500, whiteSpace: 'nowrap' },
      // 设置行：左标签 + 右状态值，整行是有底色的可点区域（紧凑版）
      optRowBtn: { display: 'flex', width: '100%', boxSizing: 'border-box', alignItems: 'center',
        justifyContent: 'space-between', gap: '8px', padding: '6px 11px',
        borderRadius: '10px', border: '1px solid transparent', background: T('chip'),
        color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer', textAlign: 'left' },
      // 右侧状态：开 = 主题色药丸；关 = 空心淡字（不用"开关控件"，保持一眼可读）
      optVal: (on) => ({ color: on ? OVS.acc : OVS.fg3, fontSize: '11.5px', fontWeight: 650, letterSpacing: '.2px',
        padding: '1px 8px', borderRadius: '999px',
        background: on ? OVS.acc12 : 'transparent',
        border: '1px solid ' + (on ? OVS.acc22 : 'transparent') }),
      // 分组细线：替代小标题，只做节奏分隔
      divider: { height: '1px', background: OVS.line2, margin: '2px 0' },
      optWide: { width: '100%', boxSizing: 'border-box', textAlign: 'center',
        padding: '6px 10px', borderRadius: '8px', border: '1px solid transparent',
        background: T('chip'), color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer' },
      optFoot: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', paddingTop: '2px' },
      optSummary: { color: OVS.fg3, fontSize: '11px', whiteSpace: 'nowrap' },
      optCaret: { color: OVS.fg3, fontSize: '9px', lineHeight: 1 },
      optSelect: { width: '100%', boxSizing: 'border-box', padding: '3px 6px', borderRadius: '8px',
        border: '1px solid ' + OVS.lineSoft, background: OVS.bg1, color: OVS.fg,
        font: 'inherit', fontSize: '12px', cursor: 'pointer' },
      // ③b 下拉选择（自绘，替掉原生 select）：触发器 + 浮层菜单
      picker: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', width: '100%',
        boxSizing: 'border-box', padding: '5px 10px', borderRadius: '8px', border: '1px solid ' + OVS.lineSoft,
        background: OVS.bg1, color: OVS.fg, font: 'inherit', fontSize: '12px', cursor: 'pointer',
        textAlign: 'left', minHeight: '28px' },
      pickerOpen: { borderColor: OVS.acc, boxShadow: '0 0 0 3px ' + OVS.acc12 },
      pickerText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pickerCaret: { flex: '0 0 auto', color: OVS.fg3, fontSize: '9px' },
      // 内联展开（2026-10-19）：菜单跟在触发器下面，不依赖定位/测量，不会被裁掉也不会错位
      pickerMenu: { maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px',
        padding: '4px', background: OVS.bg1, border: '1px solid ' + OVS.lineSoft, borderRadius: '10px' },
      pickerItem: { display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'left', padding: '6px 8px',
        borderRadius: '6px', border: '1px solid transparent', background: 'transparent', color: OVS.fg2,
        font: 'inherit', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      pickerItemOn: { background: OVS.acc12, color: OVS.acc, fontWeight: 600 },
      pickerItemActive: { background: T('hover') },
      // ③ 分段控件：选中 = 实心主题色；其余安静
      // 分段控件（2026-10-19 重设计）：整条是一条**内嵌轨道**，选中项是轨道里的一颗实心药丸。
      seg: { display: 'flex', width: '100%', boxSizing: 'border-box', alignItems: 'stretch',
        border: '1px solid ' + OVS.lineSoft, borderRadius: '10px', overflow: 'hidden',
        background: OVS.bg1, padding: '2px', gap: '2px',
        fontSize: '12px', lineHeight: '18px', userSelect: 'none', touchAction: 'none' },
      segItem: { flex: '1 1 0', display: 'flex', alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', padding: '3px 8px', borderRadius: '7px', whiteSpace: 'nowrap',
        color: OVS.fg3, cursor: 'inherit',
        transition: 'background-color .16s ease, color .16s ease, box-shadow .16s ease' },
      segOn: { background: OVS.acc, color: '#fff', fontWeight: 600, boxShadow: '0 1px 2px rgba(0,0,0,.22)' },
      // ④ 注入卡片：紧凑一行头 + 展开正文
      injRow: { border: '1px solid transparent', borderLeft: '2px solid ' + OVS.acc,
        borderRadius: '10px', background: OVS.bg1, overflow: 'hidden' },
      injHead: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%', boxSizing: 'border-box',
        padding: '5px 10px', border: 'none', background: 'transparent', color: 'inherit', font: 'inherit',
        fontSize: '12px', lineHeight: '18px', textAlign: 'left', cursor: 'pointer' },
      injBody: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 10px 10px',
        borderTop: '1px solid ' + OVS.line2 },
      // ⑤ 提示弹窗：380 宽、紧凑，主按钮实心主题色
      noticeCard: { width: 'min(380px, 92vw)', boxSizing: 'border-box', padding: '16px 18px 14px', borderRadius: '12px',
        background: OVS.surface, color: OVS.fg, border: '1px solid ' + OVS.acc22, boxShadow: SHADOW.float,
        display: 'flex', flexDirection: 'column', gap: '8px' },
      noticeTitle: { fontSize: '13.5px', fontWeight: 700, letterSpacing: '.2px' },
      noticeBody: { margin: 0, ...TYPE.body, fontSize: '12.5px', lineHeight: '1.6' },
      noticeHint: { margin: 0, color: OVS.fg3, fontSize: '11px' },
      noticeActions: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' },
      noticeBtn: { height: '28px', padding: '0 12px', borderRadius: '8px', border: '1px solid ' + OVS.lineSoft,
        color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer' },
      noticeBtnPrimary: { height: '28px', padding: '0 12px', borderRadius: '8px', border: '1px solid transparent',
        background: OVS.acc, color: '#fff', font: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
      // ⑥ 通用控件
      small: { padding: '2px 8px', borderRadius: '7px', border: '1px solid ' + OVS.lineSoft,
        background: 'transparent', color: 'inherit', fontSize: '11.5px', lineHeight: '17px', cursor: 'pointer' },
      btn: { padding: '5px 10px', borderRadius: '8px', border: '1px solid ' + OVS.lineSoft,
        background: 'transparent', color: 'inherit', fontSize: '12px', cursor: 'pointer' },
      select: { flex: 1, padding: '3px 6px', borderRadius: '8px', border: '1px solid ' + OVS.lineSoft,
        background: 'transparent', color: 'inherit', fontSize: '12px' },
      ta: { width: '100%', minHeight: '110px', borderRadius: '8px', border: '1px solid ' + OVS.lineSoft,
        background: OVS.bg1, color: 'inherit', fontFamily: 'inherit', fontSize: '12px', padding: '6px 8px' },
      h: { margin: '14px 0 6px', fontSize: '13px', fontWeight: 700, letterSpacing: '.2px' },
      muted: { color: OVS.fg3, fontSize: '11.5px', lineHeight: '1.55' },
      prov: (p) => ({ fontSize: '10px', fontWeight: 600, padding: '0 6px', borderRadius: '999px', marginLeft: '6px',
        background: p === 'user' ? 'rgba(57,192,122,.16)' : (p === 'machine' ? 'rgba(120,150,255,.16)' : 'rgba(230,90,90,.18)') }),
      dis: { opacity: .45, filter: 'grayscale(1)', cursor: 'not-allowed' },
      // ⑦ 帮助弹层
      helpPop: { position: 'fixed', right: '16px', bottom: '84px', width: 'min(520px, 92vw)', maxHeight: '70vh',
        borderTop: '2px solid ' + OVS.acc,
        contain: 'content',
        overflow: 'auto', background: OVS.surface, color: OVS.fg, border: '1px solid ' + OVS.lineSoft,
        borderRadius: '12px', padding: '14px 16px', zIndex: OV_Z.help, boxShadow: SHADOW.float,
        fontSize: '12px', lineHeight: '18px' },
      // 主标题：主题色竖条 + 底部细线，像一张卡的头
      helpTitle: { display: 'flex', alignItems: 'center', fontWeight: 700, fontSize: '14px',
        margin: '2px 0 8px', paddingBottom: '8px', borderBottom: '1px solid ' + OVS.lineSoft },
      // 小标题：细竖条 + 字号提升
      helpH: { display: 'flex', alignItems: 'center', fontWeight: 700, fontSize: '12.5px',
        color: OVS.fg, margin: '14px 0 5px' },
      helpBar: { flex: '0 0 auto', width: '3px', height: '15px', borderRadius: '2px',
        background: OVS.acc, marginRight: '8px', boxShadow: '0 0 8px ' + OVS.acc22 },
      helpBarSmall: { flex: '0 0 auto', width: '2px', height: '11px', borderRadius: '2px',
        background: OVS.acc, opacity: .8, marginRight: '7px' },
      helpP: { margin: '2px 0', ...TYPE.body },
      // 引用块：主题色左边框 + 一点主题色底
      helpQuote: { color: OVS.fg2, borderLeft: '3px solid ' + OVS.acc, background: OVS.acc12,
        borderRadius: '0 8px 8px 0', padding: '7px 10px', margin: '8px 0' },
      // ⑧ 拦截浮层：440 宽，紧凑排版，主按钮实心
      ov: { position: 'fixed', left: 0, top: 0, zIndex: OV_Z.ov, display: 'flex', flexDirection: 'column',
        width: '440px', minWidth: '340px', minHeight: '220px', maxHeight: 'min(76vh, 620px)',
        background: OVS.surface, border: '1px solid ' + OVS.lineSoft, borderRadius: '14px',
        boxShadow: SHADOW.float, color: OVS.fg, fontSize: '12px',
        overflow: 'hidden', pointerEvents: 'auto', willChange: 'transform', touchAction: 'none' },
      ovHead: { display: 'flex', alignItems: 'center', gap: '0', flex: '0 0 auto', padding: '9px 14px',
        borderBottom: '1px solid ' + OVS.lineSoft, background: OVS.surface, cursor: 'grab', userSelect: 'none' },
      ovHeadTitle: { flex: '0 0 auto', fontSize: '12.5px', fontWeight: 700, letterSpacing: '.2px', color: OVS.fg },
      ovHeadTier: { flex: '0 0 auto', fontSize: '10px', fontWeight: 700, letterSpacing: '.4px', padding: '1px 6px',
        marginLeft: '8px', borderRadius: '5px', background: OVS.acc12, color: OVS.acc, border: '1px solid ' + OVS.acc22 },
      ovRun: { display: 'flex', flexDirection: 'column', gap: '9px', padding: '10px 14px' },
      ovRunStatus: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0', fontSize: '10.5px',
        letterSpacing: '.2px', color: OVS.fg3 },
      ovPane: { border: '1px solid ' + OVS.lineSoft, borderRadius: '8px', padding: '8px 10px',
        maxHeight: '120px', overflow: 'auto', background: 'transparent' },
      ovPaneBody: { whiteSpace: 'pre-wrap', fontSize: '12.5px', lineHeight: '1.65', color: OVS.fg2, wordBreak: 'break-word' },
      ovReviewText: { width: '100%', boxSizing: 'border-box', minHeight: '130px', maxHeight: '280px',
        overflowY: 'auto', resize: 'vertical', whiteSpace: 'pre-wrap', background: OVS.bg1,
        color: OVS.fg, border: '1px solid ' + OVS.lineSoft, borderRadius: '8px', padding: '8px 10px',
        fontSize: '12.5px', lineHeight: '1.65', fontFamily: 'inherit' },
      ovActions: { display: 'flex', gap: '8px', padding: '10px 14px', alignItems: 'center' },
      ovBtn: { flex: '1 1 0', minWidth: 0, height: '28px', borderRadius: '8px', border: '1px solid ' + OVS.lineSoft,
        background: 'transparent', color: OVS.fg2, fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'inherit', fontWeight: 500, letterSpacing: '.2px' },
      ovBtnPrimary: { borderColor: 'transparent', background: OVS.acc, color: '#fff', fontWeight: 600 },
      ovFoldHead: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 14px',
        border: 'none', background: 'transparent', color: OVS.fg3, fontSize: '11px', textAlign: 'left',
        cursor: 'pointer', fontFamily: 'inherit' },
      ovFoldText: { margin: '0 10px 8px', padding: '8px 10px', borderRadius: '10px',
        background: OVS.bg1, color: OVS.fg2, fontSize: '12px', lineHeight: '1.6',
        whiteSpace: 'pre-wrap', maxHeight: 'min(220px,34vh)', overflowY: 'auto', overflowX: 'hidden',
        scrollbarWidth: 'none', msOverflowStyle: 'none' },
    })

    /**
     * 退场动效（2026-10-19 用户：很多 UI 直接消失，太硬）。
     * 组件在 show=false 时**先留在树上**打 closing 标记，过了动画时长再卸载；
     * CSS 用 [data-po06-closing="1"] 播放 po06-out。
     */
    function useExit(show, ms) {
      const [mounted, setMounted] = React.useState(!!show)
      const [closing, setClosing] = React.useState(false)
      const alive = React.useRef(!!show)
      React.useEffect(() => { alive.current = mounted }, [mounted])
      React.useEffect(() => {
        if (show) { setMounted(true); setClosing(false); return undefined }
        if (!alive.current) return undefined
        setClosing(true)
        const t = setTimeout(() => { setMounted(false); setClosing(false) }, ms)
        return () => clearTimeout(t)
      }, [show, ms])
      return { mounted, closing }
    }
    // 退场期间内容仍需可读：记住最后一次非空的值
    function useLast(value) {
      const ref = React.useRef(value)
      if (value != null) ref.current = value
      return ref.current
    }

    const PROV_TEXT = { user: L('你说过','you said'), machine: L('机器补充','machine-added'), unsourced: L('无出处','unsourced') }

    /**
     * 下拉选择（2026-10-19 重做）：原生 <select> 的展开面板由系统绘制，跟插件的设计语言完全不搭
     * （截图：黑底 + 系统蓝高亮）。这里换成自己的触发器 + 面板，键鼠都能用。
     */
    function Options({ value, onChange, options, labels, disabled, anchor }) {
      const [open, setOpen] = React.useState(false)
      const btnRef = React.useRef(null)
      const layerRef = React.useRef(null)
      const idx = Math.max(0, options.indexOf(value))
      const label = (k) => (labels && labels[k]) || k

      /**
       * 菜单用**独立浮层**画在 document.body 上（2026-10-19 真机修复）：
       * 之前把菜单渲进选项面板内部，面板是滚动容器 + fixed 定位，菜单要么被裁、要么和别的行叠在一起。
       * 这里用原生 DOM 直接建一个 fixed 浮层：不参与面板布局，也不会被任何祖先的 overflow/transform 裁掉。
       */
      React.useEffect(() => {
        if (!open) return undefined
        const btn = btnRef.current
        if (!btn || typeof document === 'undefined') { setOpen(false); return undefined }
        const r = btn.getBoundingClientRect()
        const w = Math.max(180, Math.round(r.width))
        const layer = document.createElement('div')
        layer.setAttribute('data-po06', 'picker-layer')
        layer.style.cssText = [
          'position:fixed', 'z-index:2147483000', 'box-sizing:border-box',
          'display:flex', 'flex-direction:column', 'gap:2px', 'padding:4px',
          'max-height:260px', 'overflow-y:auto', 'border-radius:10px',
          'background:' + OVS.surface, 'border:1px solid ' + OVS.lineSoft,
          'box-shadow:0 14px 34px rgba(0,0,0,.45)', 'font-size:12px', 'line-height:18px',
          'left:' + Math.round(r.left) + 'px', 'width:' + w + 'px',
        ].join(';')
        const below = ((typeof window !== 'undefined' ? window.innerHeight : 600) - r.bottom) > 240
        if (below) layer.style.top = Math.round(r.bottom + 4) + 'px'
        else layer.style.bottom = Math.round(((typeof window !== 'undefined' ? window.innerHeight : 600) - r.top) + 4) + 'px'

        const rows = options.map((k) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.setAttribute('data-po06', 'picker-item')
          b.setAttribute('data-on', k === value ? '1' : '0')
          b.textContent = label(k)
          const on = k === value
          b.style.cssText = [
            'display:block', 'width:100%', 'box-sizing:border-box', 'text-align:left',
            'padding:6px 8px', 'border:1px solid transparent', 'border-radius:6px',
            'background:' + (on ? OVS.acc12 : 'transparent'),
            'color:' + (on ? OVS.acc : OVS.fg2),
            'font:inherit', 'font-size:12px', 'line-height:18px',
            'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis', 'cursor:pointer',
          ].join(';')
          b.onmouseenter = () => { b.style.background = on ? OVS.acc12 : T('hover') }
          b.onmouseleave = () => { b.style.background = on ? OVS.acc12 : 'transparent' }
          b.onclick = () => { setOpen(false); if (k !== value) onChange(k) }
          layer.appendChild(b)
          return b
        })

        document.body.appendChild(layer)
        layerRef.current = layer
        // 面板/页面滚动时跟着收起（浮层不跟随滚动，留着就会错位）
        const close = () => setOpen(false)
        const onDoc = (e) => { if (!layer.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close() }
        const onKey = (e) => { if (e && e.key === 'Escape') close() }
        document.addEventListener('pointerdown', onDoc, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        return () => {
          document.removeEventListener('pointerdown', onDoc, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('scroll', close, true)
          window.removeEventListener('resize', close)
          // 退场：先淡出 + 轻微下移，再移除（直接 remove 太硬）
          try {
            layer.style.transition = 'opacity .12s ease, transform .12s ease'
            layer.style.opacity = '0'
            layer.style.transform = 'translateY(3px)'
            setTimeout(() => { try { layer.remove() } catch { /* 忽略 */ } }, 130)
          } catch { try { layer.remove() } catch { /* 忽略 */ } }
          layerRef.current = null
        }
      }, [open])

      const onKeyDown = (e) => {
        if (disabled) return
        if (!open) {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          }
          return
        }
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
      }
      return h('div', { 'data-po06': 'picker', 'data-open': open ? '1' : '0',
        style: { flex: 1, minWidth: 0, display: 'flex' } },
        h('button', {
          ref: btnRef, type: 'button', 'data-po06': anchor || 'picker-btn',
          'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false',
          disabled: disabled === true,
          style: { ...S.picker, ...(open ? S.pickerOpen : null), ...(disabled ? S.dis : null) },
          onClick: () => { if (!disabled) setOpen((v) => !v) },
          onKeyDown,
        },
          h('span', { style: S.pickerText }, label(value)),
          h('span', { 'aria-hidden': 'true', style: S.pickerCaret }, open ? '▴' : '▾')))
    }

    /**
     * 分段控件：**可点 / 可拖 / ←→ 方向键 / Home / End**（档位四格与优化权限两格共用）。
     *
     * 两个容易踩的点，都写在这里免得下次重犯：
     *   · 拖动时"跨到另一格才发请求"（`pick` 里比对 value/last）——否则一次拖动会把同一档位
     *     反复写好几遍，而每次写盘都是"备份 + 临时文件 + rename + 读回校验"（宿主 settings.js）。
     *   · 键盘触发的 click（Enter/Space）`detail === 0` 且没有 clientX，照 clientX 算会**一律落到第 0 格**
     *     （对档位就是"关闭"）——那是危险的误操作，所以这种 click 一律不处理，交给 onKeyDown。
     */
    /**
     * 分段控件（2026-10-19 重做动效）：
     *   · 选中指示器是**一颗会滑动的药丸**（量真实格子位置，left/width 过渡），不是给格子换底色；
     *   · 档位这一条额外带**主题特效**：轻度绿 / 标准蓝 / 重度紫，粒子湍流随档位变强，重度还会轻微颤。
     *   · 拖动、方向键、点击三条交互不变（命中判定仍按整条轨道等分）。
     */
    const TIER_FX = {
      // 2026-10-19 用户改口径：轻度只要底色；标准是"无序随机线性飘动"；重度是白色流星从右往左冲
      light:    { color: '#3fbf7f', dots: 0,  motion: 'none' },
      standard: { color: '#4a8bff', dots: 9,  motion: 'drift' },
      heavy:    { color: '#a06bff', dots: 14, motion: 'meteor', dotColor: '#fff' },
    }
    function Segmented({ name, value, options, label, disabled, title, onPick, failTick }) {
      const box = React.useRef(null)
      const last = React.useRef(null)
      const itemRefs = React.useRef({})
      const [ind, setInd] = React.useState(null)
      const [trackW, setTrackW] = React.useState(0)
      const [dragging, setDragging] = React.useState(false)
      // 拖动只是**预览**：按住移动只改这个本地值，松手才真正 onPick（避免每跨一格就打一次接口）
      const [dragValue, setDragValue] = React.useState(null)
      const shown = dragValue != null ? dragValue : value
      React.useEffect(() => { last.current = null }, [value, failTick])
      // 真值已经跟上 ⇒ 撤掉乐观预览（否则下次重渲染会被旧预览盖住）
      React.useEffect(() => { if (dragValue != null && dragValue === value) setDragValue(null) }, [value, dragValue])
      const measure = () => {
        const el = itemRefs.current[shown]
        const track = box.current
        if (!el || !track || typeof el.offsetLeft !== 'number') return
        setInd({ left: el.offsetLeft, width: el.offsetWidth })
        setTrackW(track.offsetWidth || 0)
      }
      const useIso = React.useLayoutEffect || React.useEffect
      useIso(() => {
        measure()
        let ro = null
        try {
          if (typeof ResizeObserver === 'function' && box.current) {
            ro = new ResizeObserver(() => measure())
            ro.observe(box.current)
          }
        } catch { /* 旧环境没有 RO */ }
        return () => { try { if (ro) ro.disconnect() } catch { /* 忽略 */ } }
      }, [shown, options.length])
      const commit = (k) => {
        if (!k || disabled || k === value || k === last.current) return
        last.current = k
        setDragValue(k)   // 乐观显示：点下去指示器就滑到目标格，不等接口回来
        onPick(k)
      }
      // 拖动时会以 ~120Hz 触发 pointermove：每次都 getBoundingClientRect 会强制同步布局（卡顿的来源之一）。
      // 所以按下时量一次、整个拖动期间复用；松手清空。
      const rectRef = React.useRef(null)
      const startRef = React.useRef(null)   // pointerdown 的起点：区分"单击"与"拖动"
      const indexAt = (clientX) => {
        const el = box.current
        if (!el || typeof el.getBoundingClientRect !== 'function') return -1
        const r = rectRef.current || el.getBoundingClientRect()
        if (!r || !r.width) return -1
        const i = Math.floor(((clientX - r.left) / r.width) * options.length)
        return Math.max(0, Math.min(options.length - 1, i))
      }
      const valueAt = (clientX) => { const i = indexAt(clientX); return i >= 0 ? options[i] : null }
      const onKeyDown = (e) => {
        if (disabled) return
        const cur = Math.max(0, options.indexOf(value))
        let next = null
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = cur - 1
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = cur + 1
        else if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = options.length - 1
        if (next === null) return
        e.preventDefault()
        commit(options[Math.max(0, Math.min(options.length - 1, next))])
      }
      const fx = name === 'tier' && !disabled ? TIER_FX[shown] : null
      const dots = fx && fx.dots ? Array.from({ length: fx.dots }, (_, i) => {
        // 固定伪随机（同一个 i 永远得到同一组参数）：位置/时长/延迟稳定，重渲染不跳
        const a = (i * 37) % 97, b = (i * 61) % 90 + 5, c = (i * 71) % 100
        if (fx.motion === 'meteor') {
          // 流星（2026-10-19 二次调整）：**从右侧轨道外进入**，一路向左，到左边缘前淡出。
          // 行程按整条轨道宽度算（-0.88~-1.16 倍），长度 5~17px、粗细 1~2.5px、速度 0.9~2.4s 全随机。
          const len = 5 + (i * 7) % 13
          const thick = 1 + ((i * 13) % 3) * 0.6
          const dur = 0.9 + ((i * 37) % 100) / 100 * 1.5      // 0.9s ~ 2.4s
          const gap = 0.88 + ((i * 23) % 28) / 100            // 行程 0.88~1.16 倍轨道宽
          if (!trackW) return null                            // 还没量到宽度：先不画，避免行程为 0
          return h('span', {
            key: i, 'data-po06': 'tier-dot', 'data-po06-motion': 'meteor', 'aria-hidden': 'true',
            style: {
              position: 'absolute', left: '100%', top: b + '%',
              width: len + 'px', height: thick.toFixed(1) + 'px', borderRadius: '999px',
              background: 'linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.95))',
              '--dist': '-' + Math.round(trackW * gap) + 'px',
              animation: 'po06-meteor ' + dur.toFixed(2) + 's linear infinite',
              // 负延迟：动画从"已经跑了这么久"的位置开始 ⇒ 一出现就在动，不会先停一会儿
              animationDelay: '-' + (c / 100 * dur).toFixed(2) + 's',
            },
          })
        }
        // 飘动：每个粒子一个自己的方向向量与时长，来回漂（alternate），整体是无序的
        const dx = ((i * 43) % 26) - 13
        const dy = ((i * 67) % 18) - 9
        const dur = 2.6 + ((i * 31) % 100) / 40   // 2.6s ~ 5.1s
        return h('span', {
          key: i, 'data-po06': 'tier-dot', 'data-po06-motion': 'drift', 'aria-hidden': 'true',
          style: {
            position: 'absolute', left: a + '%', top: b + '%', width: '2.5px', height: '2.5px',
            borderRadius: '50%', background: fx.color, opacity: .7,
            animation: 'po06-drift ' + dur.toFixed(2) + 's linear infinite alternate',
            animationDelay: '-' + (c / 100 * 0.8).toFixed(2) + 's',
            '--dx': dx + 'px', '--dy': dy + 'px',
          },
        })
      }) : null
      return h('div', {
        ref: box, role: 'slider', tabIndex: disabled ? -1 : 0,
        'aria-label': name, 'aria-disabled': disabled ? 'true' : 'false',
        'data-po06': name, 'data-po06-value': shown || 'none',
        'data-po06-disabled': disabled ? '1' : '0',
        'data-po06-fx': fx ? shown : 'none',
        title, style: { ...S.seg, ...(disabled ? S.dis : null), cursor: disabled ? 'not-allowed' : 'pointer',
          position: 'relative', overflow: 'hidden',
          ...(fx ? { background: 'color-mix(in srgb, ' + fx.color + ' 16%, ' + OVS.bg1 + ')',
            borderColor: 'color-mix(in srgb, ' + fx.color + ' 34%, transparent)',
            ...(shown === 'heavy' ? { animation: 'po06-shake 1.1s ease-in-out infinite', willChange: 'transform' } : null) } : null) },
        // 点击（键盘/触屏的 click）照旧立即生效；拖动走 pointer 预览、松手才提交
        onClick: (e) => {
          if (disabled) return
          if (!e || e.detail === 0 || typeof e.clientX !== 'number') return
          const k = valueAt(e.clientX)
          if (k) commit(k)
        },
        onPointerDown: (e) => {
          if (disabled) return
          startRef.current = { x: e.clientX }
          try { rectRef.current = box.current.getBoundingClientRect() } catch { rectRef.current = null }
          try { if (e.currentTarget && e.currentTarget.setPointerCapture && e.pointerId != null) e.currentTarget.setPointerCapture(e.pointerId) } catch (err) { /* 环境不支持就算了 */ }
        },
        onPointerMove: (e) => {
          if (disabled || !startRef.current) return
          // 只有真的拖出 3px 才算拖动：单击不该先跳到别处再落回来（用户看到的"来回跳动"）
          if (!dragging && Math.abs(e.clientX - startRef.current.x) <= 3) return
          if (!dragging) setDragging(true)
          const k = valueAt(e.clientX)
          if (k && k !== dragValue) setDragValue(k)
        },
        onPointerUp: (e) => {
          const k = dragging ? dragValue : (startRef.current ? valueAt(e.clientX) : null)
          startRef.current = null
          rectRef.current = null
          setDragging(false)
          setDragValue(null)
          if (k) commit(k)
        },
        onPointerCancel: () => { startRef.current = null; rectRef.current = null; setDragging(false); setDragValue(null) },
        onPointerLeave: () => {
          if (!dragging) return
          const k = dragValue
          setDragging(false)
          setDragValue(null)
          if (k) commit(k)
        },
        onKeyDown,
      },
        // 粒度层：档位才有的扰动粒子（在指示器下面，文字上面留出对比）
        fx ? h('span', { 'data-po06': 'tier-fx', 'aria-hidden': 'true',
          style: { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' } }, dots) : null,
        // 滑动指示器：位置由真实格子量出来，切换/拖动时滑过去
        h('span', { 'data-po06': 'seg-ind', 'aria-hidden': 'true',
          style: {
            position: 'absolute', top: '2px', bottom: '2px',
            left: (ind ? ind.left : 2) + 'px', width: (ind ? ind.width : 0) + 'px',
            borderRadius: '7px', pointerEvents: 'none',
            background: fx ? fx.color : OVS.acc,
            boxShadow: '0 1px 3px rgba(0,0,0,.25)',
            transition: 'left .26s cubic-bezier(.22,.8,.24,1), width .26s cubic-bezier(.22,.8,.24,1), background-color .22s ease',
          } }),
        options.map((k) => h('span', {
          key: k, 'data-po06': name + '-' + k, 'data-po06-on': (k === shown ? '1' : '0'),
          ref: (el) => { if (el) itemRefs.current[k] = el },
          style: { ...S.segItem, position: 'relative', zIndex: 1,
            ...(k === shown ? { color: '#fff', fontWeight: 600 } : null) },
        }, label ? label(k) : k)),
        // 重度：流星撞在右边界激起的白色浪（2026-10-19）。
        // ⚠ 必须画在**最上层**：选中药丸是不透明的，画在下面时浪的亮部正好被"重度"那格盖住，
        //   真机上看到的就是"没有效果"。这里用 screen 混合压在文字上，只提亮不遮挡。
        shown === 'heavy' ? h('span', { 'data-po06': 'tier-shock', 'aria-hidden': 'true',
          style: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '62%', pointerEvents: 'none', zIndex: 2,
            background: 'linear-gradient(270deg, rgba(255,255,255,.85), rgba(255,255,255,.34) 38%, rgba(255,255,255,0))',
            filter: 'blur(6px)', mixBlendMode: 'screen',
            animation: 'po06-shock 1.5s ease-in-out infinite' } }) : null,
        // 边缘亮线：让"冲击点"在最右缘有一条明确的亮边
        shown === 'heavy' ? h('span', { 'data-po06': 'tier-shock-rim', 'aria-hidden': 'true',
          style: { position: 'absolute', right: '1px', top: '3px', bottom: '3px', width: '2px', pointerEvents: 'none', zIndex: 2,
            borderRadius: '2px', background: 'rgba(255,255,255,.85)', filter: 'blur(1px)',
            animation: 'po06-shock-rim 1.5s ease-in-out infinite' } }) : null)
    }

    /**
     * 上下文回合数（0–10，契约见 settings.js 的 TURNS_MIN/TURNS_MAX）。
     *
     * **不**在每次 onChange 都写盘：原生 range 拖动时会连发几十次 input 事件，而每次写盘都是
     * "备份 + 临时文件 + rename + 读回校验"——那会留下几十个备份文件和一串无谓 IO。
     * 做法：本地先跟手（乐观显示），松手/失焦/停 400ms 才提交；**保存失败就退回真值**
     * （`failTick` 变化 ⇒ 丢掉草稿），不许让界面继续显示一个没写进去的数字。
     */
    /**
     * 上下文「回合数」滑杆（2026-10-19 重做）：原生 input[type=range] 的轨道/滑块由系统绘制，
     * 和自绘的分段控件完全不是一套语言。这里做成：
     *   · 4px 轨道 + 主题色已选段 + 14px 圆形滑块（带一圈 surface 描边，压在轨道上才不糊）；
     *   · 拖动只改本地预览，**松手才提交**（和分段控件同一条性能纪律）；
     *   · 拖动期间缓存轨道矩形，不在 pointermove 里反复 getBoundingClientRect。
     */
    function TurnsRange({ value, disabled, disabledTip, title, onCommit, failTick }) {
      const trackRef = React.useRef(null)
      const rectRef = React.useRef(null)
      const [draft, setDraft] = React.useState(null)
      const [dragging, setDragging] = React.useState(false)
      const shown = draft == null ? value : draft
      const pct = Math.max(0, Math.min(1, (shown - TURNS_MIN) / (TURNS_MAX - TURNS_MIN)))
      React.useEffect(() => { if (draft != null && draft === value) setDraft(null) }, [value, draft])
      React.useEffect(() => { setDraft(null) }, [failTick])
      const commit = (n) => {
        if (disabled) return
        const v = Math.max(TURNS_MIN, Math.min(TURNS_MAX, Math.round(Number(n))))
        if (Number.isFinite(v) && v !== value) onCommit(v)
      }
      const valueAt = (clientX) => {
        const r = rectRef.current || (trackRef.current && trackRef.current.getBoundingClientRect && trackRef.current.getBoundingClientRect())
        if (!r || !r.width) return shown
        const t = (clientX - r.left) / r.width
        return Math.round(TURNS_MIN + Math.max(0, Math.min(1, t)) * (TURNS_MAX - TURNS_MIN))
      }
      const onKeyDown = (e) => {
        if (disabled) return
        let next = null
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = shown - 1
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = shown + 1
        else if (e.key === 'Home') next = TURNS_MIN
        else if (e.key === 'End') next = TURNS_MAX
        if (next === null) return
        e.preventDefault()
        const v = Math.max(TURNS_MIN, Math.min(TURNS_MAX, next))
        setDraft(v)
        commit(v)
      }
      return h('div', {
        ref: trackRef, role: 'slider', tabIndex: disabled ? -1 : 0,
        'data-po06': 'ctx', 'data-po06-value': String(shown), 'data-po06-mode': 'turns',
        'aria-label': 'context-turns', 'aria-valuemin': TURNS_MIN, 'aria-valuemax': TURNS_MAX, 'aria-valuenow': shown,
        'aria-disabled': disabled ? 'true' : 'false',
        title: disabled ? disabledTip : title,
        style: { position: 'relative', flex: '1 1 auto', minWidth: '70px', height: '18px', display: 'flex',
          alignItems: 'center', cursor: disabled ? 'not-allowed' : 'pointer', outline: 'none',
          ...(disabled ? { opacity: .5 } : null) },
        onKeyDown,
        onPointerDown: (e) => {
          if (disabled) return
          try { rectRef.current = trackRef.current.getBoundingClientRect() } catch { rectRef.current = null }
          setDragging(true)
          setDraft(valueAt(e.clientX))
          try { if (e.currentTarget.setPointerCapture && e.pointerId != null) e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
        },
        onPointerMove: (e) => { if (!disabled && dragging) setDraft(valueAt(e.clientX)) },
        onPointerUp: () => {
          const v = draft
          rectRef.current = null
          setDragging(false)
          // 保留 draft：滑块**立刻**停在松手位置，等真值回来再由 effect 清掉（否则会先弹回旧值再跳过去）
          if (v != null) { setDraft(v); commit(v) }
        },
        onPointerCancel: () => { rectRef.current = null; setDragging(false); setDraft(null) },
      },
        // 轨道：6px 凹槽（内阴影压出"嵌入"感），刻度点在 0 / 5 / 10
        h('span', { 'aria-hidden': 'true', style: { position: 'absolute', left: 0, right: 0, height: '6px',
          borderRadius: '999px', background: OVS.line2, boxShadow: 'inset 0 1px 2px rgba(0,0,0,.28)' } }),
        h('span', { 'aria-hidden': 'true', 'data-po06': 'ctx-fill', style: { position: 'absolute', left: 0,
          width: (pct * 100) + '%', height: '6px', borderRadius: '999px',
          background: disabled ? OVS.fg3 : 'linear-gradient(90deg, ' + OVS.acc22 + ', ' + OVS.acc + ')',
          boxShadow: dragging ? '0 0 10px ' + OVS.acc22 : 'none',
          transition: dragging ? 'none' : 'width .26s cubic-bezier(.22,.8,.24,1)' } }),
        ...[0, 0.5, 1].map((t) => h('span', { key: 'tick' + t, 'aria-hidden': 'true',
          style: { position: 'absolute', left: 'calc(' + (t * 100) + '% - 1px)', top: '50%', marginTop: '-1px',
            width: '2px', height: '2px', borderRadius: '50%', background: OVS.fg3, opacity: .55 } })),
        // 滑块：16px，主题色实心 + surface 描边（压在轨道上边缘才清楚），拖动时放大一点
        h('span', { 'aria-hidden': 'true', 'data-po06': 'ctx-thumb', style: { position: 'absolute',
          left: 'calc(' + (pct * 100) + '% - 8px)', width: '16px', height: '16px', borderRadius: '50%',
          background: disabled ? OVS.fg3 : OVS.acc, border: '2px solid ' + OVS.surface,
          boxShadow: '0 2px 6px rgba(0,0,0,.35)',
          transform: dragging ? 'scale(1.12)' : 'scale(1)',
          transition: dragging ? 'transform .12s ease' : 'left .26s cubic-bezier(.22,.8,.24,1), transform .12s ease' } }))
    }

    // ── 控制表单（浮层与设置页共用）──────────────────────────────────
    const DETAIL_LABELS = { minimal: L('最少补充','Minimal'), standard: L('标准补充','Standard'), detailed: L('尽量补全','Thorough') }
    const BUDGET_LABELS = { minimal: L('只做必要的','Essential only'), standard: L('标准','Standard'), generous: L('允许更多自主处理','More autonomy') }
    const ASSIST_LABELS = { off: L('只记录、不补充','Record only'), auto: L('自动辅助','Assist automatically') }

    /**
     * 主题是深还是浅：**先看 DSH 自己的主题信号**，再看主文字色的亮度（不另立真相来源）。
     *
     * 判据一（首选）：DSH 用 `[data-ds-dark-theme]` 表达深色（挂在 html/body 上；浅色时不挂）。
     *   —— 这条是从宿主的样式表里读出来的：它的主题选择器就是 `[data-ds-dark-theme]`。
     * 判据二（兜底）：`--dsw-alias-label-primary` 亮不亮（宿主变量拿不到时仍能判断）。
     * 用途：① 原生 `<select>` 的下拉面板配色（`color-scheme`）；
     *      ② **给插件根元素标出当前主题**（`data-po06-light`），token 表按它选浅色/深色那一套。
     */
    function themeIsDark() {
      try {
        const html = document.documentElement
        const body = document.body
        // ① DSH 的深色属性。**宿主挂在 `body` 上**（`dsh-client-ui-layout` 的 ThemePresenter：
        //    `DARK_ATTRIBUTE = "data-ds-dark-theme"` —— "Body attribute selecting the dark base palette"）。
        //    ⚠ 旧实现只看 html 就会漏判；这里 body/html/最近祖先都认。
        if (body && typeof body.hasAttribute === 'function' && body.hasAttribute('data-ds-dark-theme')) return true
        if (html && typeof html.hasAttribute === 'function' && html.hasAttribute('data-ds-dark-theme')) return true
        if (body && typeof body.closest === 'function' && body.closest('[data-ds-dark-theme]')) return true
      } catch { /* 继续往下判 */ }
      try {
        // ② 根上的 `color-scheme`：同一个 ThemePresenter 会写它（"set root color-scheme"）。
        const cs = String((getComputedStyle(document.documentElement).colorScheme || '')).toLowerCase()
        if (cs.includes('dark')) return true
        if (cs.includes('light')) return false
      } catch { /* 继续往下判 */ }
      try {
        // ③ 文字色亮度。⚠ **从 body 读**：宿主把 token 变量定义在 `body{--dsw-static-…}` 上，
        //    从 `documentElement` 读会读到空 ⇒ 旧实现于是恒判"深色"⇒ 浅色模式下整套深色 token
        //    （用户看到的就是"浅色模式跟深色没区别"）。
        const el = document.body || document.documentElement
        const v = String(getComputedStyle(el).getPropertyValue('--dsw-alias-label-primary') || '').trim()
        let r = null, g = null, b = null
        const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
        if (hex) {
          const s = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
          const n = parseInt(s, 16); r = n >> 16 & 255; g = n >> 8 & 255; b = n & 255
        } else {
          const nums = v.match(/\d+(\.\d+)?/g)
          if (nums && nums.length >= 3) { r = +nums[0]; g = +nums[1]; b = +nums[2] }
        }
        if (r === null) return false                              // ④ 都读不到 ⇒ **按浅色**（宿主 boot 默认浅色）
        return (r * 0.299 + g * 0.587 + b * 0.114) / 255 > 0.6    // 文字色很亮 ⇒ 主题是深色
      } catch { return false }
    }

    /**
     * 主题是**活的**：在 DSH 里切深色/浅色 ⇒ 立刻重渲染本插件的界面（不用刷新页面）。
     * 挂在两个地方：① `html`/`body` 的属性变化（DSH 用 `data-ds-dark-theme` 表达深色）；
     * ② 系统偏好变化（`prefers-color-scheme`，宿主跟随系统时用得上）。
     * 用法与 `useLocaleLive()` 一样：在根组件里调用一次。
     */
    function useThemeLive() {
      const [, setN] = React.useState(0)
      React.useEffect(() => {
        const bump = () => setN((n) => n + 1)
        const obs = []
        try {
          if (typeof MutationObserver === 'function') {
            for (const el of [document.documentElement, document.body]) {
              if (!el) continue
              const o = new MutationObserver(bump)
              o.observe(el, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style', 'data-theme'] })
              obs.push(o)
            }
          }
        } catch { /* 观察不到就只在重渲染时更新 */ }
        let mq = null
        try {
          mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)')
          if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', bump)
        } catch { mq = null }
        return () => {
          for (const o of obs) { try { o.disconnect() } catch { /* noop */ } }
          try { if (mq && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', bump) } catch { /* noop */ }
        }
      }, [])
      return null
    }

    /** 根元素上的主题标记（token 表按它选取值；两处来源都写上，见 themeTokensCss）。 */
    const themeAttrs = () => ({ 'data-po06-theme': themeIsDark() ? 'dark' : 'light' })

    /** 「优化选项」的图标：一条极简的"滑杆"线稿，用 `currentColor` ⇒ 深浅色主题都跟着走。 */
    function OptIcon() {
      return h('svg', {
        width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': 'true',
        style: { flex: '0 0 auto', display: 'block' },
      },
      h('path', {
        d: 'M2 4h7M12.5 4H14M2 8h3M7.5 8H14M2 12h5M10.5 12H14',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', fill: 'none', opacity: .85,
      }),
      h('circle', { cx: 10.5, cy: 4, r: 1.5, fill: 'currentColor' }),
      h('circle', { cx: 5.5, cy: 8, r: 1.5, fill: 'currentColor' }),
      h('circle', { cx: 8.5, cy: 12, r: 1.5, fill: 'currentColor' }))
    }

    const inferenceStageLabel=code=>({directions:L('生成思考方向','Direction sketches'),working:L('原模型取舍并执行','Working model'),candidates:L('并行候选（历史）','Candidates (legacy)'),selecting:L('比较修订（历史）','Compare revisions (legacy)'),feedback:L('反馈（历史）','Feedback (legacy)'),refining:L('循环改进（历史）','Refining (legacy)'),submitting:L('提交采用结果','Submitting'),done:L('完成','Done'),failed:L('失败','Failed'),cancelled:L('取消','Cancelled'),interrupted:L('已中断','Interrupted'),running:L('调用中','Running')}[code]||code)
    const inferencePaceLabel=p=>({fast:L('快速','Fast'),balanced:L('均衡（历史配置）','Balanced (legacy setting)'),inherit:L('完整轮数 / 工作档位（历史配置）','Full rounds / working effort (legacy setting)')}[p]||p||L('未记录','Not recorded'))
    function InferenceRecordedPlan({run={}}){
      const plan=run.iterationPlan,effort=run.effortPlan,directional=run.workflow==='directions-to-worker'
      const mode=run.settings?.reasoningMode??plan?.mode??run.mode
      const pace=run.settings?.reasoningPace??plan?.pace??effort?.pace
      const value=v=>v===undefined?L('未记录','Not recorded'):v===null?L('服务商默认','Provider default'):String(v)
      return h(React.Fragment,null,
        h('p',{'data-po06':'inference-effort-plan',style:S.muted},L('记录模式：','Recorded mode: ')+value(mode)+' · '+L('记录节奏：','Recorded pace: ')+value(pace)+(pace?' ('+inferencePaceLabel(pace)+')':'')+' · '+(effort?(directional?L('方向 ','Directions '):L('候选/修订 ','Candidates/revisions '))+value(directional?effort.direction:effort.candidate)+' · '+(directional?L('原模型 ','Working model '):L('择优/反馈 ','Selection/feedback '))+value(directional?effort.working:effort.review):L('旧版本未记录档位计划','No effort plan in the legacy record'))),
        plan?h('p',{'data-po06':'inference-call-plan',style:S.muted},plan.profile==='fast-3x3'
          ?L('固定 3+3 快速准备：','Fixed 3+3 fast preparation: ')+value(plan.effectiveCandidates)+L(' 条并行方向，无同一步串行精修；额外调用 ',' concurrent directions, no same-step serial refinements; extra calls ')+value(plan.extraCallsUsed??0)+'/'+value(plan.maxExtraCalls)+L('，原模型生成 ','; working generation ')+value(plan.workingCallsUsed??0)+L(' 次',' call')
          :directional?L('记录的方向计划：','Recorded direction plan: ')+value(plan.effectiveCandidates)+L(' 份，最多 ',' sketches, up to ')+value(plan.effectiveRounds)+L(' 轮方向改进；额外调用 ',' direction refinement rounds; extra calls ')+value(plan.extraCallsUsed??0)+'/'+value(plan.maxExtraCalls)+L('，原模型生成 ','; working generation ')+value(plan.workingCallsUsed??0)+L(' 次',' call')
          :L('记录的调用计划：','Recorded call plan: ')+value(plan.effectiveCandidates)+L(' 个候选，最多 ',' candidates, up to ')+value(plan.effectiveRounds)+L(' 轮修订；已用 ',' revision rounds; used ')+value(run.calls?.length??0)+'/'+value(plan.maxCalls)):null)
    }
    const inferenceCallTime=c=>Math.max(0,((c.finishedAt||Date.now())-c.startedAt)/1000).toFixed(1)+'s'
    function outgoingUserText(hold){return hold?.englishMode&&typeof hold.outgoingText==='string'&&hold.outgoingText.trim()?hold.outgoingText:String(hold?.text||'')}
    function AdvisorControls({settings={},save,ready,busy=false,failTick}){
      const known=typeof settings.advisor==='boolean',on=settings.advisor===true
      // 2026-10-18 用户指定：顾问开关，放在英文模式上方，两档，默认开。
      return h('div',{style:S.optRow},h('span',{style:S.optLabel},L('顾问','Advisor')),
        h(Segmented,{ name:'advisor', value:on?'on':'off', options:['off','on'], failTick,
          disabled:busy||!known||ready===false,
          label:k=>k==='on'?L('开启','On'):L('关闭','Off'),
          title:!known?L('顾问：还没读到当前设置，这次不会发送这个字段','Advisor: current setting not read yet')
            :L('顾问：开启后可调用 consult_task / advisor_stage 做独立解题与复核；关闭后这两个工具直接拒绝，不发起任何模型调用。','Advisor: consult_task and advisor_stage are available when on; when off they refuse without any model call.'),
          onPick:v=>save({advisor:v==='on'}) }))
    }
    function EnglishControls({settings={},save,ready,busy=false,failTick}){
      const known=typeof settings.englishMode==='boolean',on=settings.englishMode===true
      // 与「权限」同款两档滑档；默认关闭。读不到设置时禁用并说明，绝不猜测当前值。
      return h('div',{style:S.optRow},h('span',{style:S.optLabel},L('英文模式','English mode')),
        h(Segmented,{
          name:'english-mode', value:on?'on':'off', options:['off','on'], failTick,
          disabled:busy||!known||ready===false,
          label:k=>k==='on'?L('开启','On'):L('关闭','Off'),
          title:!known?L('英文模式：还没读到当前设置，这次不会发送这个字段','English mode: current setting not read yet; this field will not be sent')
            :L('英文模式：把用户任务、优化策略与辅助文转成英文再送给模型（界面仍是中文）。不添加答复语言要求，原话里的语言要求照常保留。',
              'English mode: send the task, optimizer instructions and assistance as English (the UI stays Chinese). No response-language policy is added; explicit language requests are preserved.'),
          onPick:v=>save({englishMode:v==='on'}),
        }))
    }
    function InferenceControls({settings={},save,ready,busy=false}){
      const enabled=settings.reasoningBoost===true,known=typeof settings.reasoningBoost==='boolean'
      return h('div',{'data-po06':'inference-controls',style:{borderTop:'1px solid '+T('line2'),paddingTop:'8px',marginTop:'8px'}},
        h('div',{style:{...S.optRow,gap:'8px'}},h('span',{style:S.optLabel},L('快速增强','Quick enhancement')),
          h('button',{'data-po06':'reasoning-boost',type:'button',style:{...S.small,color:enabled?T('acc'):T('fg2')},disabled:busy||!known||ready===false&&!enabled,'aria-pressed':enabled,onClick:()=>save({reasoningBoost:!enabled})},enabled?L('开启','On'):L('关闭','Off'))),
        h('div',{'data-po06':'inference-profile',style:{...S.muted,lineHeight:1.5}},
          L('固定 3+3 快速配置：先并发生成三条简短、公开的思考方向，再交给原工作模型正常执行。不做同一步串行精修，不调用择优裁判，也不先写几份实现；3+3 不表示实际执行了三轮修正。',
            'Fixed 3+3 fast profile: three concurrent brief public directions, followed by normal execution by the original working model. No same-step serial refinements, separate judge or multiple implementations; 3+3 does not mean three correction loops ran.')),
        h('div',{style:{...S.muted,lineHeight:1.5}},
          L('方向独立选可用轻档，原模型档位、工具与输出上限不变。工具观测与既往调用事件分别记录，不把历史失败自动当成本次失败。',
            'Directions independently use supported light effort; working effort, tools and output ceiling stay unchanged. Actual observations and prior-invocation incidents are recorded separately; past failures are not automatically current failures.')),
        h('div',{'data-po06':'experimental-warning',style:{...S.muted,lineHeight:1.5,color:T('warn')}},
          L('目前无法确定它能否稳定提升模型能力；三条方向准备仍会增加调用与等待时间，请用同一任务对照。',
            'Universal quality improvement is unproven. Preparing three directions still adds calls and latency; compare the same task.')),
        !known||ready===false?h('div',{style:S.muted},L('尚未读到当前设置或宿主未就绪；不会自动修改配置。','Current settings are not loaded or the host is not ready; no automatic settings changes.')):null,
        h('div',{style:S.muted},L('与提示词辅助档位、英文模式独立；默认关闭，关闭后后续生成恢复普通路径。方向建议不等于验证结果。','Independent of prompt assistance and English mode; off by default. Turning off restores later generations to the normal path. Direction suggestions are not verification.')))
    }
    function InferenceEvidenceDetails({run={}}){
      const plan=run.iterationPlan||{},state=run.evidenceState,reasons={}
      const rows=value=>Array.isArray(value)?value:[]
      const count=(value,fallback)=>Number.isSafeInteger(value)&&value>=0?value:Array.isArray(value)?value.length:Number.isSafeInteger(fallback)&&fallback>=0?fallback:0
      const hasActive=state&&Object.prototype.hasOwnProperty.call(state,'activeIssues')
      const active=rows(state?.activeIssues),retained=rows(state?.retainedIncidents),recent=rows(state?.recentEvidence)
      const legacy=hasActive?[]:rows(state?.openIssues)
      const activeCount=count(state?.activeIssues,state?.focusPolicy?.activeCount)
      const retainedCount=count(state?.retainedIncidents,state?.focusPolicy?.retainedInvocationCount)
      const focus=state?.mode||run.directionObjective
      for(const d of run.decisions||[])if(d.kind==='direction-unavailable')reasons[d.reason]=(reasons[d.reason]||0)+1
      const reasonLabel=reason=>({'direction-call-timeout':L('单次方向等待超时','Direction call timed out'),'direction-preparation-timeout':L('方向准备时间用尽','Direction preparation limit reached'),'direction-tool-protocol':L('伪工具协议','Simulated tool protocol'),'direction-structured-call':L('结构化工具调用','Structured tool call'),'direction-program':L('完整程序或实现','Program or implementation'),'direction-final-report':L('交付报告','Delivery report'),'direction-incomplete':L('输出中止','Incomplete output'),'direction-too-long':L('方向过长','Direction too long'),'direction-empty':L('没有正文','No public text'),'direction-fenced-code':L('代码围栏','Fenced code'),'direction-tool-call':L('工具提议','Tool proposal'),'generation-not-complete':L('生成未完成','Generation incomplete')})[reason]||reason
      const statusLabel=value=>({'open':L('已报告，待核对','Reported, unclosed'),'changed-pending':L('对象已改变，待复测','Object changed; retest needed'),'recheck-pending':L('证据待核对','Evidence needs recheck')})[value]||value||L('仅为记录','Recorded only')
      const observations=(values,prefix)=>values.slice(0,20).map((issue,index)=>h('div',{key:prefix+'-'+index,style:{borderTop:'1px solid '+T('line2'),padding:'6px 0'}},
        h('strong',null,(issue.source?.id||issue.id||L('省略记录','Omitted records'))+' · '+(issue.criterion||issue.label||issue.checkId||issue.kind||'')+' · '+statusLabel(issue.status||issue.outcome)),
        h('div',{style:S.muted},(issue.path||issue.binding?.path||L('对象未确定','Object unbound'))+' · '+(issue.version||issue.binding?.sha256||L('版本未确认','Version unconfirmed'))),
        h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',margin:'4px 0',fontFamily:'inherit'}},String(issue.excerpt||issue.reason||issue.summary||'').slice(0,1200))))
      const section=(id,title,values,total,note)=>h('section',{'data-po06':id},h('strong',null,title+' · '+total),note?h('p',{style:S.muted},note):null,observations(values,id),total>values.slice(0,20).length?h('p',{style:S.muted},L('其余明细请查看导出记录。','See the exported trace for remaining details.')):null)
      return h('div',{'data-po06':'inference-effective-directions'},
        run.workflow==='directions-to-worker'?h('p',{style:S.muted},L('实际有效方向 ','Usable directions ')+String(plan.validDirections??run.directionCallIds?.length??0)+' · '+L('拒绝 ','Rejected ')+String(plan.rejectedDirections??0)+' · '+L('重复 ','Duplicates ')+String(plan.duplicateDirections??0)+(run.directionMaxTokens?' · '+L('方向输出预算 ','Direction output budget ')+run.directionMaxTokens:'')):null,
        Object.keys(reasons).length?h('div',{'data-po06':'inference-direction-rejections',style:{...S.muted,color:T('warn')}},Object.entries(reasons).map(([reason,total])=>reasonLabel(reason)+' × '+total).join(' · ')):null,
        run.timingPolicy?h('p',{style:S.muted},L('方向准备上限 ','Direction preparation limit ')+run.timingPolicy.preparationTimeoutMs/1000+L(' 秒；单次 ',' s; per call ')+run.timingPolicy.directionTimeoutMs/1000+L(' 秒。保留有效方向继续主任务；主生成不受此限制。',' s. Keep valid directions and continue the task; working generation has no such limit.')):null,
        state?h('details',{'data-po06':'inference-evidence',open:activeCount>0||legacy.length>0},
          h('summary',null,L('工具观测记录','Tool observation records')+' · '+(focus==='diagnose'?L('诊断 / 反证方向','Diagnose / falsification focus'):focus==='explore'?L('探索方向','Explore focus'):L('记录的方向','Recorded focus'))),
          h('p',{style:S.muted},L('仅记录真实工具报告的现象，不自动判断整个作品失败或验收通过。新一条无关 PASS 不会清掉旧失败。','These are actual tool-reported observations, not whole-product failure or acceptance. An unrelated PASS does not clear a reported failure.')),
          state.completionClaimAllowed===false?h('p',{'data-po06':'inference-completion-boundary',style:S.muted},L('这份证据快照不授权宣称完成；方向建议也不等于验收结果。','This evidence snapshot does not authorize a completion claim; direction suggestions are not acceptance.')):null,
          state.recentEvidence!==undefined?section('inference-recent-evidence',L('近期实际结果（新到旧）','Recent actual results (newest first)'),recent,count(state.recentEvidence),null):null,
          hasActive?section('inference-active-issues',L('本次相关问题','Issues active for this invocation'),active,activeCount,L('依据本次焦点快照列出，不等于整个作品失败。','Listed by this invocation’s focus snapshot, not a whole-product failure verdict.')):null,
          state.retainedIncidents!==undefined?section('inference-retained-incidents',L('既往调用留存事件','Retained prior-invocation incidents'),retained,retainedCount,L('保留用于追溯，不代表当前仍失败，也不表示已经修复。','Retained for audit: neither a current-failure claim nor a claim that the incident was fixed.')):null,
          legacy.length?section('inference-recorded-issues',L('旧记录中的未闭合观测','Unclosed observations in the legacy record'),legacy,legacy.length,L('旧快照没有本次/既往分类；以下仅按当时记录展示。','The old snapshot has no active/prior classification; these entries are shown as recorded.')):null,
          state.omitted?.openIssues?h('p',{style:{color:T('warn')}},L('内存上限省略的失败明细：','Failure details omitted by the memory limit: ')+state.omitted.openIssues):null,
          state.limitations?.length?h('div',{style:S.muted},state.limitations.map(String).join(' · ')):null):null)
    }
    function InferenceMonitor({sessionId}){
      useLocaleLive();useThemeLive()
      const [open,setOpen]=React.useState(false),[runs,setRuns]=React.useState([]),[error,setError]=React.useState(null)
      const [runId,setRunId]=React.useState(''),[callId,setCallId]=React.useState(''),[body,setBody]=React.useState(null),[view,setView]=React.useState('text')
      const [input,setInput]=React.useState(null),[downloadBusy,setDownloadBusy]=React.useState(false),[region,setRegion]=React.useState(null)
      const anchor=React.useRef(null),buffer=React.useRef({key:'',text:'',reasoning:''})
      React.useEffect(()=>{setRunId('');setCallId('');setRuns([]);setBody(null);setInput(null);buffer.current={key:'',text:'',reasoning:''}},[sessionId])
      React.useEffect(()=>{
        if(!sessionId)return undefined
        let live=true,timer=null
        const poll=async()=>{try{const data=await apiGet('/inference-runs?session='+encodeURIComponent(sessionId));if(!live)return;setRuns(data.runs||[]);setError(null)}catch(e){if(live)setError(errorText(e))}if(live)timer=window.setTimeout(poll,open?350:1500)}
        poll();return()=>{live=false;if(timer)window.clearTimeout(timer)}
      },[sessionId,open])
      const run=runs.find(r=>r.runId===runId)||runs[0]||null
      const call=run?.calls.find(c=>c.callId===callId)||run?.calls.filter(c=>c.stage==='running').at(-1)||run?.calls.at(-1)||null
      const active=run&&!['done','failed','cancelled','interrupted'].includes(run.stage)
      React.useEffect(()=>{
        if(!open)return undefined
        const reflow=()=>setRegion(composerRegion(anchor.current))
        reflow();return ovReflowWatch(reflow,anchor.current)
      },[open])
      React.useEffect(()=>{
        if(!open||!run||!call)return undefined
        let live=true,timer=null
        const key=run.runId+':'+call.callId
        if(buffer.current.key!==key){buffer.current={key,text:'',reasoning:''};setBody(null);setInput(null)}
        const poll=async()=>{
          const current=buffer.current
          try{const data=await apiGet('/inference-run?session='+encodeURIComponent(sessionId)+'&run='+encodeURIComponent(run.runId)+'&call='+encodeURIComponent(call.callId)+'&text='+current.text.length+'&reasoning='+current.reasoning.length)
            if(!live||buffer.current.key!==key)return
            const v=data.value;const text=(v.textReset?'':current.text)+String(v.textDelta||''),reasoning=(v.reasoningReset?'':current.reasoning)+String(v.reasoningDelta||'')
            buffer.current={key,text,reasoning};setBody({...v,text,reasoning})
            if(v.stage==='running')timer=window.setTimeout(poll,200)
          }catch(e){if(live){setError(errorText(e));timer=window.setTimeout(poll,1000)}}
        }
        poll();return()=>{live=false;if(timer)window.clearTimeout(timer)}
      },[open,sessionId,run?.runId,call?.callId,call?.stage])
      const inputLoad=async()=>{if(!run||!call)return;try{const data=await apiGet('/inference-run?session='+encodeURIComponent(sessionId)+'&run='+encodeURIComponent(run.runId)+'&call='+encodeURIComponent(call.callId)+'&input=1');setInput(data.value.input)}catch(e){setError(errorText(e))}}
      const download=async()=>{
        if(!run)return;setDownloadBusy(true)
        try{const calls=await Promise.all(run.calls.map(async c=>{const data=await apiGet('/inference-run?session='+encodeURIComponent(sessionId)+'&run='+encodeURIComponent(run.runId)+'&call='+encodeURIComponent(c.callId)+'&input=1');return data.value}));const blob=new Blob([JSON.stringify({...run,calls},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='reasoning-'+run.runId+'.json';a.click();URL.revokeObjectURL(url)}catch(e){setError(errorText(e))}finally{setDownloadBusy(false)}
      }
      const route=run?.route,caption=run?inferenceStageLabel(run.stage)+' · '+run.calls.length+L(' 次调用',' calls'):L('尚无增强调用','No enhanced generation yet')
      const selected=run?.calls.find(c=>c.callId===run.selectedCallId)
      const pane={whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontFamily:'inherit',fontSize:'12px',lineHeight:1.6,margin:0,maxHeight:'38vh',overflowY:'auto',padding:'10px',background:T('inset'),color:T('fg2'),borderRadius:'8px'}
      return h('div',{...themeAttrs(),'data-po06':'inference-monitor',style:{fontSize:'12px'}},
        h('button',{ref:anchor,type:'button',style:S.small,'data-po06':'inference-open','aria-expanded':open,onClick:()=>setOpen(v=>!v)},L('推理过程','Reasoning trace')+' · '+caption),
        open?h('div',{'data-po06':'inference-panel',style:{...S.helpPop,right:region?Math.max(8,window.innerWidth-region.right+8)+'px':'16px',width:region?Math.max(180,Math.min(720,region.w-24))+'px':'min(720px,92vw)',maxHeight:'76vh',overflow:'auto'}},
          h('div',{style:{display:'flex',alignItems:'center',gap:'8px'}},h('strong',null,L('工作模型 · 推理增强过程','Working model · Reasoning trace')+(run?.protocolVersion?' · v'+run.protocolVersion:'')),h('button',{style:{...S.small,marginLeft:'auto'},onClick:()=>setOpen(false)},L('关闭','Close'))),
          error?h('p',{style:{color:T('err')}},error):null,
          h('select',{'data-po06':'inference-run-choice',style:{...S.optSelect,marginTop:'10px'},value:runId,onChange:e=>{setRunId(e.target.value);setCallId('')}},h('option',{value:''},L('跟随最新生成','Follow latest generation')),runs.map(r=>h('option',{key:r.runId,value:r.runId},new Date(r.startedAt).toLocaleTimeString()+' · '+inferenceStageLabel(r.stage)+' · '+r.calls.length+L(' 次调用',' calls')))),
          !run?h('p',{style:S.muted},L('在优化选项里开启“推理增强”，再发送任务。短方向、交接和原模型实际输出分别留在这里；旧记录保持原来的候选/反馈信息。','Enable Reasoning boost in Options and send a task. Direction sketches, handoff and actual working output appear separately; older records keep their candidate/feedback details.')):h(React.Fragment,null,
            h('p',{style:S.muted},(route.provider+' / '+route.model)+' · '+(route.reasoningEffort||L('服务商默认档位','Provider default'))+' · '+L('输出上限','Output ceiling')+' '+(route.maxTokens??L('模型默认','Model default'))),
            h(InferenceRecordedPlan,{run}),
            run.effortPlan?.note?h('div',{style:S.muted},L(run.effortPlan.note,run.effortPlan.noteEn||run.effortPlan.note)):null,

            h(InferenceEvidenceDetails,{run}),
            h('p',{'data-po06':'inference-total-usage',style:S.muted},L('全部调用累计（服务商报告）：','All calls (provider-reported): ')+run.calls.reduce((n,c)=>n+Number(c.usage?.totalTokens||0),0).toLocaleString()+' token'),
            h('div',{'data-po06':'inference-summary',style:{padding:'8px 0',whiteSpace:'pre-wrap'}},run.summary||L('等待选择与总结…','Waiting for selection and summary…')),
            run.reason?h('p',{style:{color:T('warn')}},L('回退/中止原因：','Fallback/stop reason: ')+run.reason):null,
            selected?h('button',{'data-po06':'inference-adopted',type:'button',style:{...S.small,color:T('ok')},onClick:()=>{setCallId(selected.callId);setView('text')}},(run.workflow==='directions-to-worker'?L('实际执行输出：','Working output: '):L('最终采用：','Adopted: '))+selected.label):null,
            h('details',{'data-po06':'inference-decisions',open:true},h('summary',null,(run.workflow==='directions-to-worker'?L('方向交接记录','Direction handoff'):L('择优与多轮反馈','Selection and round feedback'))),run.decisions.length?run.decisions.map((d,i)=>h('div',{key:i,style:{borderTop:'1px solid '+T('line2'),padding:'7px 0',whiteSpace:'pre-wrap'}},h('strong',null,(d.round??0)+' · '+(d.kind==='direction-handoff'?L('交回原模型取舍','Handed to the working model'):d.kind.startsWith('direction-')?L('方向准备','Direction preparation'):d.kind==='feedback'?L('反馈','Feedback'):L('选择/回退','Selection/fallback'))),h('div',null,d.reason||d.summary||''),d.summary&&d.reason!==d.summary?h('div',{style:S.muted},d.summary):null,d.selected?h('div',{style:S.muted},L('保留/采用：','Kept/adopted: ')+(run.calls.find(c=>c.callId===d.selected)?.label||d.selected)):null,d.skipped?h('span',{style:{color:T('fg3')}},L('已跳过重复调用/提前结束','Skipped repeated calls / stopped early')):null,d.fallback?h('span',{style:{color:T('warn')}},L('按记录的回退路径继续','Continued via fallback')):null)):h('p',{style:S.muted},L('正在生成候选','Generating candidates'))),
            h('div',{style:{display:'flex',flexWrap:'wrap',gap:'5px',margin:'12px 0'}},run.calls.map(c=>h('button',{'data-po06-inference-call':c.callId,key:c.callId,style:{...S.small,borderColor:c.callId===call?.callId?T('acc'):T('line2')},onClick:()=>{setCallId(c.callId);setView('text')}},c.label+' · '+(c.route?.reasoningEffort||L('默认','default'))+' · '+inferenceCallTime(c)+' · '+inferenceStageLabel(c.stage)))),
            call?h('div',{'data-po06':'inference-call-detail'},h('div',{style:S.muted},call.label+' · '+(call.route?.provider||'')+' / '+(call.route?.model||'')+' · '+(call.route?.reasoningEffort||L('默认档位','default effort'))+' · '+inferenceCallTime(body||call)+' · '+inferenceStageLabel(body?.stage||call.stage)+' · '+usageText(body?.usage||call.usage)),call.error?h('div',{style:{color:T('err')}},call.error):null,
              h('div',{style:{display:'flex',flexWrap:'wrap',gap:'6px',margin:'8px 0'}},['text','reasoning','tools','input'].map(k=>h('button',{key:k,style:S.small,onClick:()=>{setView(k);if(k==='input')inputLoad()}},({text:L('输出','Output'),reasoning:L('返回的思考','Returned reasoning'),tools:L('工具提议','Tool proposals'),input:L('调用输入','Call input')})[k]))),
              h('pre',{'data-po06':'inference-call-content',style:pane},view==='text'?(body?.text||L('等待输出…','Waiting for output…')):view==='reasoning'?(body?.reasoning||L('服务商尚未返回可见思考；这里不推测内部过程。','No visible reasoning returned by the provider; internal reasoning is not inferred.')):view==='tools'?(JSON.stringify(body?.tools||[],null,2)+'\n'+(run.workflow==='directions-to-worker'?L('方向没有工具执行权；只有原工作模型实际输出的工具调用提交给宿主。','Directions have no tool execution. Only actual tool calls from the working model are submitted.'):L('这些是生成阶段的提议；只有最终采用候选的工具流提交给宿主。','These are generation proposals. Only the adopted tool stream is submitted to the host.'))):input?JSON.stringify(input,null,2):L('读取调用输入…','Reading call input…'))):null,
            h('div',{style:{display:'flex',gap:'8px',marginTop:'12px'}},h('button',{style:S.small,disabled:downloadBusy,onClick:download},L('导出这一轮完整记录','Export full generation trace')),active&&run.stage!=='working'?h('button',{style:S.small,onClick:async()=>{const r=await apiPost('/inference-cancel',{sessionId,runId:run.runId});if(!r.ok)setError(reasonText(r.reason))}},L('停止额外思考','Stop extra inference')):null))):null)
    }

    function ControlForm({ status, refresh, sessionId }) {
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const s = (status && status.settings) || {}
      // 会话级档位（0.7.8）：这三个控件显示【本会话生效值】，写入写进【本会话的覆盖】。
      // 必须在本组件内定义：ControlForm 与 ControlBar 是两个独立作用域，
      // 早先误把 ControlBar 的 eff/withSession 用到这里 ⇒ 渲染期未定义 ⇒ 面板调不动。
      const eff = (status && status.sessionEffective) || s
      const [catalog, setCatalog] = React.useState({ models: [], problems: [] })
      React.useEffect(() => {
        let live = true
        apiGet('/models').then((r) => { if (live) setCatalog(r) }, (e) => { if (live) setCatalog({ models: [], problems: [errorText(e)] }) })
        return () => { live = false }
      }, [])
      const routes = (catalog.models || []).slice()
      if (s.model && !routes.some((r) => r.provider === s.model.provider && r.model === s.model.model)) routes.push({ ...s.model, label: s.model.provider + ' / ' + s.model.model })
      const modelKey = (r) => JSON.stringify([r.provider, r.model])
      const modelLabels = { inherit: L('跟随会话模型','Follow session model') }
      routes.forEach((r) => { modelLabels[modelKey(r)] = r.label })
      const save = async (patch) => {
        setBusy(true); setMsg(null)
        const r = await apiPost('/settings', patch)
        setBusy(false)
        if (!r.ok) { setMsg({ kind: 'err', text: L('保存失败：','Save failed: ') + reasonText(r.reason || L('未知原因','unknown')) }); return }
        const probs = (r.problems || []).filter((x) => x.kind !== 'unknown-field')
        setMsg({ kind: probs.length ? 'warn' : 'ok',
          text: probs.length
            ? L('已保存，但有 ','Saved, but ') + probs.length + L(' 项被按默认处理',' value(s) were handled by default') + staleSchemaHint(r.problems) + L('：',': ') + probs.map((x) => x.key + '=' + JSON.stringify(x.got)).join('、')
            : L('已保存','Saved') + (r.backup ? L('（旧配置已备份）',' (old config backed up)') : '') })
        if (refresh) refresh()
      }
      // 没有会话（例如未打开会话的设置页）就退回全局写入，保持老行为可用。
      const saveTier = (patch) => {
        const sid = (sessionId === undefined || sessionId === null) ? '' : String(sessionId)
        if (!sid) return save(patch)
        const all = (s.bySession && typeof s.bySession === 'object') ? s.bySession : {}
        return save({ bySession: { ...all, [sid]: { ...(all[sid] || {}), ...patch } } })
      }
      return h('div', { 'data-po06': 'controls' },
        h('div', { style: S.row },
          h('span', { style: S.label }, L('辅助','Assist')),
          h(Options, { value: eff.assist, options: ['off', 'auto'], labels: ASSIST_LABELS, onChange: (v) => saveTier({ assist: v }) }),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, L('补充程度','Detail')),
          h(Options, { value: eff.detail, options: ['minimal', 'standard', 'detailed'], labels: DETAIL_LABELS, onChange: (v) => saveTier({ detail: v }) }),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, L('自主预算','Autonomy')),
          h(Options, { value: eff.budget, options: ['minimal', 'standard', 'generous'], labels: BUDGET_LABELS, onChange: (v) => saveTier({ budget: v }) }),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, L('解释层模型','Explainer model')),
          h(Options, {
            value: s.model ? modelKey(s.model) : 'inherit',
            options: ['inherit', ...routes.map(modelKey)], labels: modelLabels,
            onChange: (v) => { const r = routes.find((x) => modelKey(x) === v); save({ model: r ? { provider: r.provider, model: r.model } : null }) },
          }),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, L('子代理','Subagents')),
          h(Options, {
            value: eff.applyToSubagents === true ? 'on' : 'off', options: ['off', 'on'],
            labels: { off: L('不解释、不注入','skip'), on: L('同样应用','apply') },
            onChange: (v) => saveTier({ applyToSubagents: v === 'on' }),
          }),
        ),
        // ⚠ 2026-10-19 修：顾问的就绪状态**不能**借用 english.ready；而且 advisor 不是会话级键，
        //    写 bySession 会被归一化丢掉（点了没反应/来回跳）⇒ 这里一律写全局。
        // ⚠ advisor 是**全局键**，而 sessionEffective 只带会话级键 ⇒ 必须并上全局的 s.advisor，
        //   否则界面永远读不到布尔值、开关是灰的（2026-10-19 真机）。
        h(AdvisorControls,{settings:{...eff,advisor:s.advisor},save:save,ready:true,busy}),
        h(EnglishControls,{settings:eff,save:saveTier,ready:status?.english?.ready===true,busy}),
        // 2026-10-19 用户要求：**详情面板里的「快速增强」也隐藏**（与设置页一致，默认关闭、不再给入口）。
        // 组件与后端代码都保留；要恢复只把下面这一行放回来。
        // h(InferenceControls,{settings:eff,save:saveTier,ready:status?.inference?.ready===true,busy}),
        (catalog.problems || []).length ? h('div', { style: S.muted }, L('部分模型不可用：','Some models unavailable: ') + catalog.problems.join('；')) : null,
        busy ? h('div', { style: S.muted }, L('保存中…','Saving…')) : null,
        msg ? h('div', { 'data-po06': 'msg', style: { ...S.muted, color: msg.kind === 'err' ? T('err') : (msg.kind === 'warn' ? T('warn') : T('ok')) } }, msg.text) : null,
        h('div', { style: S.muted }, L('改动下一轮生效；改提示词会让意图包缓存自动失效重算。','Changes take effect next round; editing the prompt invalidates the cached packet.')),
      )
    }

    function PromptEditor({ prompt, refresh }) {
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      React.useEffect(() => { if (prompt && typeof prompt.text === 'string') setText(prompt.text) }, [prompt && prompt.text])
      const save = async () => {
        setBusy(true); setMsg(null)
        const r = await apiPost('/prompt', { text })
        setBusy(false)
        setMsg(r.ok ? { kind: 'ok', text: L('提示词已保存（下一轮生效）','Prompt saved (takes effect next round)') } : { kind: 'err', text: L('保存失败：','Save failed: ') + reasonText(r.reason) })
        if (r.ok && refresh) refresh()
      }
      const reset = async () => {
        setBusy(true); setMsg(null)
        const r = await apiPost('/prompt', { reset: true })
        setBusy(false)
        setMsg(r.ok ? { kind: 'ok', text: L('已恢复内置提示词','Built-in prompt restored') } : { kind: 'err', text: L('恢复失败：','Restore failed: ') + reasonText(r.reason) })
        if (r.ok && refresh) refresh()
      }
      const undo = async () => {
        setBusy(true); setMsg(null)
        const r = await apiPost('/prompt', { undo: true })
        setBusy(false)
        setMsg(r.ok ? { kind: 'ok', text: L('已撤销上次提示词修改','Last prompt edit undone') } : { kind: 'err', text: L('撤销失败：','Undo failed: ') + reasonText(r.reason) })
        if (r.ok && refresh) refresh()
      }
      const source = prompt ? (prompt.source === 'file' ? L('自定义（文件覆盖）','Custom (file override)') : L('内置默认','Built-in default')) : L('（读不到）','(unavailable)')
      return h('div', { 'data-po06': 'prompt' },
        h('div', { style: S.muted }, L('解释层提示词来源：','Explainer prompt source: ') + source + L('（共 ',' (') + ((prompt && prompt.chars) || 0) + L(' 字）',' chars)')),
        prompt?.protocolVersion ? h('div', { 'data-po06': 'prompt-protocol', style: S.muted },
          L('短协议 v', 'Compact protocol v') + prompt.protocolVersion + (prompt.effective?.chars != null ? L(' · 按当前设置约 ', ' · Current-settings preview: ') + prompt.effective.chars + L(' 字符', ' chars') : '')) : null,
        prompt?.effective?.text ? h('details', { 'data-po06': 'prompt-effective', style: S.muted },
          h('summary', {}, L('查看当前设置预览（实际请求以最后一次发送为准）', 'Current-settings preview (last actual request shown separately)')),
          h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, prompt.effective.text)) : null,
        prompt?.lastRequest?.systemText ? h('details', { 'data-po06': 'prompt-last-request', style: S.muted },
          h('summary', {}, L('最后实际发送：', 'Last actual request: ') + prompt.lastRequest.systemChars + L(' 字符 · 思考档位 ', ' chars · effort ') + (prompt.lastRequest.effort || L('模型默认', 'model default'))),
          h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, prompt.lastRequest.systemText)) : null,
        prompt?.migration ? h('div', { style: S.muted }, L('旧默认协议已由短协议替代，原文件保留可恢复。', 'The old default was replaced by the compact protocol; its original file is retained.')) : null,
        h('textarea', { 'data-po06': 'prompt-text', style: S.ta, value: text, onChange: (e) => setText(e.target.value) }),
        h('div', { style: S.row },
          h('button', { style: S.btn, disabled: busy, onClick: save }, L('保存提示词','Save prompt')),
          h('button', { style: S.btn, disabled: busy, onClick: reset }, L('恢复内置','Restore built-in')),
          h('button', { style: S.btn, disabled: busy, onClick: undo }, L('撤销上次修改','Undo last edit')),
          msg ? h('span', { style: { ...S.muted, color: msg.kind === 'err' ? T('err') : T('ok') } }, msg.text) : null,
        ),
      )
    }

    // 注：原来这里有一块「它在替我做什么」（ItemsList，逐条列意图与出处）。
    // 用户 2026-09-21 明确要求删掉它（"拦截界面已经让人看见模型替我们做了什么"）——
    // **但"无出处条目"这条诚实信号不能跟着消失**：它挪进了拦截审查面板（见 intercept-unsourced 那一行），
    // 因为"机器自己编出来的要求"是最该被人看见的东西。宿主侧 `GET /state` 仍保留，脚本/测试照旧可用。
    function TurnsList({ turns }) {
      const list = (turns && turns.turns) || []
      if (list.length === 0) return h('div', { style: S.muted }, L('还没有处理过任何一轮。','No rounds processed yet.'))
      // 每一轮补齐"它在替我做什么"的事实（P10）：上下文读了多少、有没有派工具、包超没超预算。
      // ⚠ 缺值显示"未记录"，**不许拿 0 冒充"没发生"**——"这轮没读上下文"与"台账没这个字段"是两件事。
      const none = L('未记录', 'n/a')
      const bits = (t) => {
        const out = []
        if (t.packetBudget != null) {
          out.push(t.packetOverBudget === true
            ? L('超预算 ', 'over budget ') + (t.packetOverBy || 0) + L(' 字', ' chars')
            : L('预算内', 'within budget'))
        } else if (t.packetChars != null) out.push(none)
        if (t.historyChars != null) {
          out.push(L('上下文 ', 'ctx ') + t.historyChars + L(' 字', ' chars')
            + (t.historyTurnsRead != null ? L('/', '/') + t.historyTurnsRead + L(' 回合', ' turns') : ''))
        }
        if (t.toolsEnabled === true) out.push(L('工具 ', 'tools ') + (t.toolCalls || 0) + L(' 次', ' calls'))
        else if (t.toolsEnabled === false && t.toolsReason) out.push(L('未派工具：', 'no tools: ') + t.toolsReason)
        if (t.toolFallback) out.push(L('已回落', 'fell back'))
        return out
      }
      return h('div', { 'data-po06': 'turns' }, list.map((t, i) => h('div', { key: i, style: { margin: '3px 0' } },
        (t.at ? String(t.at).slice(11, 19) + ' ' : ''),
        t.ok ? '✅ ' : '⚠️ ',
        (t.outcome || '-'),
        t.packetChars != null ? L(' ｜ 包 ',' | packet ') + t.packetChars + L(' 字',' chars') : '',
        t.ms != null ? ' ｜ ' + (t.ms / 1000).toFixed(1) + 's' : '',
        t.model ? ' ｜ ' + t.model : '',
        t.reason ? ' ｜ ' + t.reason : '',
        bits(t).length ? h('div', { 'data-po06': 'turn-facts', style: { ...S.muted, paddingLeft: '14px' } }, bits(t).join(' ｜ ')) : null,
      )))
    }

    // ── 「?」帮助弹层（要求②，2026-09-21）────────────────────────────
    // 用户原话："增加'?'按钮,可以参考之前的'?'按钮中的内容,对0.6制作一个类似的文本"。
    // 两条纪律：
    //   · **正文只有一个真相来源**：包里的 `HELP-0.6.md`，由宿主的 `GET /help` 取出来（实现者注记已在宿主侧剥掉）；
    //     客户端**不内置一份**——内置一份就一定会和文档分叉。
    //   · 读不到就说读不到 + 给出路径（`source:"missing"` 或 `warning`），**不糊一段别的文案顶上**。
    function HelpBody({ text }) {
      const out = []
      String(text || '').split('\n').forEach((raw, i) => {
        const s = raw.replace(/\s+$/, '')
        if (!s.trim()) { out.push(h('div', { key: i, style: { height: '6px' } })); return }
        if (/^\|[\s:|-]+\|$/.test(s.trim())) return                    // 表格分隔行（|---|---|）不显示
        const clean = (x) => String(x).replace(/\*\*/g, '').replace(/`/g, '')
        if (/^##\s/.test(s)) {
          out.push(h('div', { key: i, style: S.helpH },
            h('span', { 'aria-hidden': 'true', style: S.helpBarSmall }), clean(s.replace(/^##\s+/, ''))))
          return
        }
        if (/^#\s/.test(s)) {
          out.push(h('div', { key: i, style: S.helpTitle },
            h('span', { 'aria-hidden': 'true', style: S.helpBar }), clean(s.replace(/^#\s+/, ''))))
          return
        }
        if (/^>\s?/.test(s)) { out.push(h('div', { key: i, style: S.helpQuote }, clean(s.replace(/^>\s?/, '')))); return }
        if (s.trim().startsWith('|')) {
          const cells = s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => clean(c.trim()))
          out.push(h('div', { key: i, style: S.helpTr },
            cells.map((c, j) => h('span', { key: j, style: j === 0 ? S.helpTdKey : S.helpTd }, c))))
          return
        }
        out.push(h('div', { key: i, style: S.helpP }, clean(s)))
      })
      return h('div', { 'data-po06': 'help-body' }, out)
    }

    // ── P11 · 拦截浮层：**照 0.5 的界面复刻**（用户 2026-09-21 原话：「当前拦截 UI 依然与 0.5 差距巨大…
    //    你完全可以直接把 0.5 的相关 UI 拿过来用，完全没必要重新自己制作」）──────────────────────────
    // 逐块来源（行号 = `po05-src/lib/client.js`，只列**真的搬了**的）：
    //   · 面板外壳 1930-1970：可拖的头 / 滚动体 / **底栏在滚动区之外（永不滚走）** / 右下角改尺寸把手
    //   · 头      1940-1945：标题 + 档位徽标 + 「本会话已拦截 N 次」+「W×H / ↘」提示
    //   · 状态行  1516-1522：`优化中…` / `已完成` / `失败` + 徽标（徽标内容见下面的"真相差异"）
    //   · 审查块  1562-1590：`以下内容将原样发给工作 AI（可直接编辑） · N 字` + 可编辑 textarea
    //   · 折叠    1487-1501 + 3449-3460 disclosure：`›` 箭头 + 标题 + 摘要，点了才展开（原文用它）
    //   · 底栏    1622-1687：五个变体 → 0.6 的四个阶段（review / sent / error / idle）
    //   · 错误行  1554-1558：`失败：` + 人话，完整原因挂 title（0.5 就是这么做的）
    //   · 悬浮球  1797-1835 + 3533-3539：46px、按档位着色、拖动移动、单击回看（只读）
    //   · 几何    1146-1185：位置/尺寸夹紧（最小 400×320、不出视口、窗口变化重新夹紧）
    // **与 0.5 的真相差异（逐条写在这里，不许糊弄）**：
    //   ① 0.5 状态行上的 `· 首字 {ms}ms`（首字延迟）、`上下文 N 回合 · M 字`（本轮读入的历史）、
    //      `Σ {tok} tok`（provider 上报用量）这三样，0.6 的 `POST /interpret` **一个都拿不到**
    //      （响应只有 packet/chars/ms/unsourced）⇒ **这三个徽标不显示**，换成真实拥有的：
    //      优化中的「已用 N 秒」、完成后的总耗时、包字数。宁可少显示，也不拿 0/估算顶上。
    //   ② 0.5 的 `‹ 回退`（1189 `rollbackYes`）= 停止优化 + **不发送** + 原文留在输入框；它靠
    //      `run.settled` 挡住还在飞的 SSE 回调（0.5:1694-1702 的注释就是这么写的）。0.6 的 `beginHold`
    //      回调**没有**这个标记 ⇒ 在"优化中"清 hold，在飞的响应回来照样会把消息放行（用户以为取消了、
    //      几十秒后消息却发出去 = 吞消息的反面，同样不可接受）。放行逻辑本轮不许动 ⇒
    //      **优化中不给回退**；审查态的 `‹ 回退` 落成"这一轮不注入优化包、按原文发出"——
    //      这在 0.6 里就是"回到原文"的真实含义（0.6 **从不改写用户的原话**，能回退的只有包）。
    //   ③ 0.5 的 `run/outcome/trace`（「成了/要返工」裁决、查证动作列表）在 0.6 没有对应物
    //      （0.6 没有 runId、也没有工具轨迹）⇒ 不搬；头里那颗**硬编码版本串**同样不搬
    //      （0.6 的版本来自 `/status.version`，显示在「详情」面板里，不做第二份真相）。

    const OV_MIN_W = 400
    const OV_MIN_H = 320
    const ovViewport = () => ({
      w: (typeof window !== 'undefined' && window.innerWidth) || 800,
      h: (typeof window !== 'undefined' && window.innerHeight) || 600,
    })
    /**
     * issue #18（用户澄清）：浮层**必须待在会话窗以内**，不许与右侧栏（图片等预览栏）重合。
     * 判据不是"猜一个侧栏宽度常量"，而是**直接量会话窗本身**：从浮层所在节点向上找到输入卡片，
     * 用它的矩形当会话窗边界 —— 侧栏一开，会话列变窄、卡片跟着变窄，浮层于是被挤进来。
     * 量不到（卡片不在 DOM / 宽度为 0 / 读数不可信）就退回整个视口，行为与改动前一致（绝不因此不显示）。
     * 纵向仍用视口：侧栏只压缩横向。
     */
    /**
     * 右侧栏**如果是固定浮层**（挂在 body、不压缩会话列），量输入卡片是发现不了它的 ——
     * 这时只按卡片算，浮层仍会压在侧栏上（正是报告者看到的现象）。
     * 这里做一条保守探测：body 的直属子节点里，**贴右缘、够高够宽、且是 fixed** 的那个，
     * 它的左缘就是右侧栏的左缘。判据取得严（宁可不认，也不要误把提示条当侧栏）：
     *   · 右缘离视口右边 ≤ 8px；宽度 160 ~ 60% 视口；高度 ≥ 40% 视口。
     * 认不出就回 null（退化为"只按卡片算"，不会比改动前更差）。
     */
    const rightFixedSidebarLeft = (exclude) => {
      const v = ovViewport()
      try {
        const body = (typeof document !== 'undefined' && document) ? document.body : null
        if (!body || !body.children) return null
        const cs = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') ? window.getComputedStyle : null
        if (!cs) return null
        let best = null
        for (const el of Array.from(body.children)) {
          if (!el || !el.getBoundingClientRect) continue
          if (el.getAttribute && el.getAttribute('data-po06') !== null) continue       // 我们自己的浮层不算
          if (exclude && el.contains && el.contains(exclude)) continue
          // ⚠ 顺序有意如此：**先做便宜的几何筛选，再问 computed style**。
          //   反过来会在每次重算里对 body 的每个子节点调 getComputedStyle（流式对话时 body 变动频繁）。
          const r = el.getBoundingClientRect()
          if (!r || !(r.width > 0) || !(r.height > 0)) continue
          if (r.right < v.w - 8) continue
          if (r.width < 160 || r.width > v.w * 0.6) continue
          if (r.height < v.h * 0.4) continue
          if (cs.call(window, el).position !== 'fixed') continue
          if (best === null || r.left < best) best = Math.round(r.left)
        }
        return best
      } catch { return null }
    }
    const composerRegion = (node) => {
      const v = ovViewport()
      const full = { left: 0, top: 0, right: v.w, bottom: v.h, w: v.w, h: v.h, source: 'viewport' }
      try {
        const card = node ? composerCard(node) : null
        const r = card && typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null
        const cardLeft = (r && r.width > 0) ? Math.round(r.left) : null
        const cardRight = (r && r.width > 0) ? Math.round(r.right) : null
        const sideLeft = rightFixedSidebarLeft(node)
        // 两侧取交：会话窗右缘 = min(输入卡片右缘, 固定侧栏左缘)
        let left = Math.max(0, Math.min(cardLeft == null ? 0 : cardLeft, v.w))
        let right = Math.max(0, Math.min(cardRight == null ? v.w : cardRight, v.w))
        if (sideLeft != null) right = Math.min(right, Math.max(0, Math.min(sideLeft, v.w)))
        // 太窄说明读数不可信（卡片被隐藏 / 侧栏算错）⇒ 退回视口，而不是把浮层挤成一条缝
        if (right - left < 160) return full
        const src = (sideLeft != null && sideLeft <= (cardRight == null ? v.w : cardRight)) ? 'composer-card+sidebar' : (cardRight == null ? 'viewport' : 'composer-card')
        return { left, top: 0, right, bottom: v.h, w: right - left, h: v.h, source: src }
      } catch { return full }
    }
    /**
     * 位置夹紧。**判据不是"整块面板都得在视口内"，而是"至少留得住一个能抓的地方"**——
     * 用户 2026-09-22 真机："弹窗还是无法拖动"。真因就在这里：他把面板拉到 **400×748**，
     * 而窗口高度小于 748+16 ⇒ 旧式 `max(8, v.h - h - 8)` 恒等于 **8** ⇒ **y 被钉死在 8**，
     * 拖拽照常算、画面却一动不动（x 同样会在面板宽度接近视口时被钉住）。
     * 现在：横向至少留 `OV_KEEP_X`、纵向至少露出标题栏 `OV_KEEP_Y`，面板因此始终可拖。
     */
    const OV_KEEP_X = 96
    const OV_KEEP_Y = 48
    /**
     * issue #18：会话窗会因三种原因变，浮层必须**当场**跟上，所以观察点也要三条都接：
     *   ① 窗口缩放 —— `window.resize`；
     *   ② 会话列变窄 —— 输入卡片的 `ResizeObserver`；
     *   ③ **右侧栏是固定浮层时卡片尺寸根本不变**，只有 body 子节点增删 —— `MutationObserver`。
     * 任一触发就通知全部订阅者；用 rAF 合并，因为流式对话时 body 的增删非常频繁。
     * 输入卡片可能被宿主**重挂载**（换会话/换布局）⇒ 重新认一次，不盯着脱离文档的旧节点。
     */
    const ovReflowSubs = new Set()
    let ovReflowWired = false, ovReflowPending = false, ovCardObserver = null, ovObservedCard = null
    function ovReflowAll() {
      if (ovReflowPending) return
      ovReflowPending = true
      const run = () => {
        ovReflowPending = false
        // 宿主可能把输入卡片整个换掉（换会话/换布局）⇒ 每次重算都重认一次，别盯着脱离文档的旧节点
        try { ovReflowWatchCard() } catch { /* 认不出来就沿用上一个 */ }
        for (const fn of Array.from(ovReflowSubs)) { try { fn() } catch { /* 单个订阅者抛错不影响其它 */ } }
      }
      try {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
        else window.setTimeout(run, 16)
      } catch { run() }        // 没有计时设施时同步跑一次，宁可多算也不要漏
    }
    /** 重认输入卡片并（必要时）把 ResizeObserver 挪到新节点上。 */
    let ovReflowAnchor = null
    function ovReflowWatchCard() {
      const node = ovReflowAnchor
      if (!node) return
      const card = composerCard(node)
      if (!card || card === ovObservedCard || typeof ResizeObserver !== 'function') return
      if (ovCardObserver) { try { ovCardObserver.disconnect() } catch { /* best effort */ } }
      ovCardObserver = new ResizeObserver(ovReflowAll)
      ovCardObserver.observe(card)
      ovObservedCard = card
    }
    function ovReflowWatch(fn, node) {
      ovReflowSubs.add(fn)
      if (!ovReflowAnchor) ovReflowAnchor = node || null
      if (!ovReflowWired) {
        ovReflowWired = true
        try { window.addEventListener('resize', ovReflowAll) } catch { /* 没有 window 也不致命 */ }
        try {
          const body = (typeof document !== 'undefined' && document) ? document.body : null
          // ⚠ 属性也必须看：右侧栏完全可能是**早就挂在 body 上、靠 class/style/hidden 显隐**的节点。
          //   那种开关既不增删子节点、也不改输入卡片尺寸 ⇒ 只盯 childList 会整条漏掉（复核指出）。
          if (body && typeof MutationObserver === 'function') {
            new MutationObserver(ovReflowAll).observe(body, {
              childList: true, subtree: true, attributes: true,
              attributeFilter: ['class', 'style', 'hidden'],
            })
          }
        } catch { /* 观察不到 body 就只靠尺寸与 resize */ }
      }
      ovReflowWatchCard()
      return () => { ovReflowSubs.delete(fn) }
    }
    const clampOvPos = (x, y, el, region) => {
      const v = ovViewport()
      const rg = region || { left: 0, top: 0, right: v.w, bottom: v.h, w: v.w, h: v.h }
      const w = (el && el.offsetWidth) || 460
      const h = (el && el.offsetHeight) || 320
      // 横向第一约束是「右缘收在会话窗内」——这正是"不许与侧栏重合"。
      // 会话窗比面板还窄时无处可放 ⇒ 先贴左；宽度由 clampOvSize 按同一个 region 收窄，下一帧就能放下。
      // ⚠ 与改动前的一处**有意差异**：旧实现允许把面板拖到只剩 OV_KEEP_X 露在边缘；
      //   现在只要放得下就要求**整块可见**（"浮层整个仍在会话窗区域内"是用户给的判据）。
      //   放不下（面板比会话窗还宽）才退回贴左，并由 clampOvSize 用同一个 region 收窄宽度。
      const roomy = rg.w >= w + 8
      const minX = rg.left
      const maxX = roomy ? rg.right - w : rg.left
      const minY = Math.min(8, v.h - h)      // 面板比视口还高时，上边界也跟着放宽（否则会被钉死、拖不动）
      const maxY = Math.max(8, v.h - OV_KEEP_Y)
      return {
        x: Math.min(Math.max(minX, Math.round(x)), maxX),
        y: Math.min(Math.max(minY, Math.round(y)), maxY),
      }
    }
    /** 尺寸夹紧（0.5:1154-1161）：不小于 400×320，也不超出视口。 */
    const clampOvSize = (w, h, region) => {
      const v = ovViewport()
      const rg = region || { left: 0, top: 0, right: v.w, bottom: v.h, w: v.w, h: v.h }
      const out = {}
      // ⚠ 上限取**会话窗宽度**（不是视口宽度）：侧栏打开后会话窗变窄 ⇒ 面板跟着变窄。
      //   下界仍尽量保 OV_MIN_W，但会话窗本身就比它窄时只能跟着窄——"放不下"优先于"最小尺寸"。
      const maxW = Math.max(240, Math.min(rg.w - 16, v.w - 16))
      const maxH = Math.max(OV_MIN_H, v.h - 16)
      if (w != null) out.w = Math.min(Math.max(Math.min(OV_MIN_W, maxW), Math.round(w)), maxW)
      if (h != null) out.h = Math.min(Math.max(OV_MIN_H, Math.round(h)), maxH)
      return out
    }
    /** 面板默认落点（0.5:1922：贴右侧、离顶 96px）。 */
    const defaultOvPos = (region) => {
      const rg = region || { left: 0, right: ovViewport().w }
      return { x: Math.max(rg.left, rg.right - 480), y: 96 }
    }
    /** 悬浮球默认落点（0.5:1449：右下角内侧）——同样收在会话窗内。 */
    const defaultBallPos = (region) => {
      const v = ovViewport()
      const rg = region || { left: 0, right: v.w }
      return { x: Math.max(rg.left, rg.right - 76), y: Math.max(8, v.h - 160) }
    }

    /**
     * 折叠区块：照 0.5:1487-1501 的 `disclosure`（`›` 箭头 + 标题 + 摘要 + 展开体）。
     * 默认收起；但**思维层**要按 0.5 的时序"运行中展开、完成后收起" ⇒ 支持 `defaultOpen`。
     * ⚠ 只在**首次挂载**时用它；之后一律以用户点击为准（`defaultOpen` 变化不得把用户手动收起的面板再弹开）。
     */
    function OvFold(props) {
      const [open, setOpen] = React.useState(props.defaultOpen === true)
      const openedOnce = React.useRef(false)
      React.useEffect(() => {
        if (openedOnce.current) return
        openedOnce.current = true
        if (props.defaultOpen === true) setOpen(true)
      }, [props.defaultOpen])
      const mark = props.mark
      const fold = useExit(open, 140)
      return h('div', { 'data-po06': 'intercept-fold-' + mark, 'data-open': open ? 'true' : 'false', style: S.ovFold },
        h('button', {
          type: 'button', 'data-po06': 'intercept-fold-head-' + mark, 'aria-expanded': open ? 'true' : 'false',
          style: S.ovFoldHead, onClick: () => setOpen((v) => !v),
        },
          h('span', { 'aria-hidden': 'true', style: { ...S.ovFoldCaret, transform: open ? 'rotate(90deg)' : 'none' } }, '›'),
          h('span', { style: S.ovFoldTitle }, props.title),
          props.summary ? h('span', { style: S.ovFoldSum }, props.summary) : null,
        ),
        fold.mounted ? h('div', { 'data-po06': 'intercept-fold-body-' + mark, style: S.ovFoldText,
          'data-po06-closing': fold.closing ? '1' : '0' }, props.children) : null,
      )
    }

    /**
     * 46px 悬浮球（0.5:1797-1835）：拖动移动、单击回看（只读）。
     * 位置放**本地状态**而不是每次 move 回调父组件——父组件每秒（优化中的计时器）会重渲染，
     * 若位置只存在父级，拖动中会被弹回去。
     */
    function InterceptBall(props) {
      const ball = props.ball
      const tone = TIER_TONES[props.tier] || OVS.acc
      const ref = React.useRef(null)
      const offRef = React.useRef(null)
      const [pos, setPos] = React.useState(ball.pos || defaultBallPos())
      const posRef = React.useRef(pos)
      posRef.current = pos
      React.useEffect(() => () => { if (offRef.current) offRef.current() }, [])
      // issue #18：球是 `position: fixed`，侧栏打开时会落在会话窗外面（看起来"跑到侧栏上"）。
      // 与面板同一套判据：量会话窗，把球收进去；侧栏开关（输入卡片尺寸变化）时立刻重算。
      React.useEffect(() => {
        const reflow = () => {
          const el = ref.current
          const rg = composerRegion(el)
          const v = ovViewport()
          setPos((p) => {
            const n = {
              x: Math.min(Math.max(rg.left, p.x), Math.max(rg.left, rg.right - 56)),
              y: Math.min(Math.max(8, p.y), Math.max(8, v.h - 56)),
            }
            return (n.x === p.x && n.y === p.y) ? p : n
          })
        }
        reflow()
        // 三个观察点（窗口缩放 / 卡片尺寸 / body 子节点增删）由共享观察器一起接（见 ovReflowWatch）
        return ovReflowWatch(reflow, ref.current)
      }, [])
      const working = ball.phase === 'optimizing'
      const label = working ? L('优化中', 'Working') : (ball.sent ? L('已发送', 'Sent') : L('结果', 'Result'))
      const icon = ball.sent ? '✓' : (working ? '◌' : '◍')
      return h('div', {
        ...themeAttrs(), ref, 'data-po06': 'intercept-ball', 'data-po06-sent': ball.sent ? '1' : '0',
        'data-po06-phase': ball.phase || '',
        role: 'button', tabIndex: 0,
        title: ball.sent
          ? L('优化结果已发送 · 点击回看（只读）', 'Result sent · click to review (read-only)')
          : L('优化结果 · 点击回看', 'Result · click to review'),
        style: { ...S.ball(tone, ball.sent), transform: 'translate3d(' + pos.x + 'px,' + pos.y + 'px,0)' },
        onPointerDown: (e) => {
          if (e.button !== 0) return
          const start = { x: e.clientX, y: e.clientY, bx: posRef.current.x, by: posRef.current.y }
          let moved = false
          const el = ref.current
          const move = (ev) => {
            const dx = ev.clientX - start.x; const dy = ev.clientY - start.y
            if (!moved && Math.abs(dx) + Math.abs(dy) > 6) moved = true     // 0.5:1813 的 6px 阈值：小于它算"点击"
            if (!moved) return
            const v = ovViewport()
            const rg = composerRegion(el)
            const next = {
              x: Math.min(Math.max(rg.left, start.bx + dx), Math.max(rg.left, rg.right - 56)),
              y: Math.min(Math.max(8, start.by + dy), Math.max(8, v.h - 56)),
            }
            posRef.current = next
            if (el && el.style) el.style.transform = 'translate3d(' + next.x + 'px,' + next.y + 'px,0)'
          }
          const end = () => {
            window.removeEventListener('pointermove', move, true)
            window.removeEventListener('pointerup', end, true)
            window.removeEventListener('pointercancel', end, true)
            offRef.current = null
            if (!moved) props.onOpen()                                       // 0.5:1823 单击 = 展开回看
            else props.onMove(posRef.current)                                // 拖过 = 只记住位置
          }
          window.addEventListener('pointermove', move, true)
          window.addEventListener('pointerup', end, true)
          window.addEventListener('pointercancel', end, true)
          offRef.current = end
          e.preventDefault(); e.stopPropagation()
        },
      },
        h('span', { 'aria-hidden': 'true', style: S.ballIcon }, icon),
        h('span', { 'data-po06': 'intercept-ball-label', style: S.ballLabel }, label),
      )
    }

    /**
     * 拦截面板（0.5 的浮层本体）。所有**动作**都是外部传进来的既有处理函数
     * （confirmHold / sendOriginal / regenHold / skipHold / beginHold），这里只管画。
     */
    /**
     * 思维层正文：固定窗口 + **无滚动条**，新内容自动跟到底（0.5 思维区的观感）。
     * 为什么不用滚动条：用户明确要求去掉右侧那根滚轮；而这个窗口的用途是"看它此刻在想什么"，
     * 所以让最新几行始终可见才是对的——想回看完整内容，底部还有「原文」与（同一会话内的）台账。
     */
    function ThinkBody({ text }) {
      const ref = React.useRef(null)
      // "粘底"：默认跟着最新一行走（看它在想什么）；但**用户一旦往上滚**就立刻停手，
      // 不再把他拽回底部——否则"能滚动"等于白给（刚滚上去就被新片段顶回来）。
      const stick = React.useRef(true)
      const onScroll = (e) => {
        try {
          const el = e.currentTarget
          stick.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 48
        } catch (err) { /* 量不到就当仍在底部 */ }
      }
      React.useEffect(() => {
        const el = ref.current
        if (!el || !stick.current) return
        try { el.scrollTop = el.scrollHeight } catch { /* 跟不动也不影响阅读 */ }
      }, [text])
      return h('div', { ref, onScroll, 'data-po06': 'intercept-think-body', style: S.ovFoldText }, text)
    }

    // Decode semantic output from both protocols; incomplete escapes stay buffered.
    function interceptDraftOutput(raw) {
      const source=String(raw || ''),stack=[],rows=[]
      for(let i=0;i<source.length;) {
        const ch=source[i],frame=stack[stack.length-1]
        if(ch==='{' || ch==='[') {stack.push({array:ch==='[',label:frame && frame.key,key:null,wantKey:ch==='{'});if(frame)frame.key=null;i++;continue}
        if(ch==='}' || ch===']'){stack.pop();i++;continue}
        if(ch===','){if(frame){frame.key=null;frame.wantKey=!frame.array}i++;continue}
        if(ch===':' || /\s/.test(ch)){i++;continue}
        if(ch!=='"'){while(i<source.length&&!/[\s,}\]]/.test(source[i]))i++;continue}
        const start=++i;let end=i,closed=false
        while(end<source.length) {if(source[end]==='\\'){end+=2;continue}if(source[end]==='"'){closed=true;break}end++}
        const token=source.slice(start,Math.min(end,source.length))
        if(frame && frame.wantKey) {
          if(!closed)break
          try {frame.key=JSON.parse('"'+token+'"')}catch {return rows.join('\n')}
          frame.wantKey=false
        } else if(frame && ((frame.label==='item' && frame.key==='text') || (frame.label==='intent' && frame.key==='text') || (frame.array && ['clarify','add','ask'].includes(frame.label)))) {
          let value=''
          for(let n=0;n<token.length;n++) {
            const c=token[n]
            if(c!=='\\'){value+=c;continue}
            if(n+1>=token.length)break
            const esc=token[++n]
            if(esc==='u') {
              const hex=token.slice(n+1,n+5);if(!/^[0-9a-fA-F]{4}$/.test(hex))break
              value+=String.fromCharCode(parseInt(hex,16));n+=4
            } else {
              const escapes={'"':'"','\\':'\\','/':'/','n':'\n','r':'\r','t':'\t','b':'\b','f':'\f'}
              if(!Object.prototype.hasOwnProperty.call(escapes,esc))break
              value+=escapes[esc]
            }
          }
          if(value && /[\uD800-\uDBFF]$/.test(value))value=value.slice(0,-1)
          if(value) {
            const label={intent:L('理解','Intent'),clarify:L('澄清','Clarification'),add:L('建议','Suggestion'),ask:L('反问','Question')}[frame.label]
            rows.push((label?label+': ':'- ')+value)
          }
        }
        if(!closed)break
        i=end+1
      }
      return rows.join('\n')
    }
    function InterceptDraftBody({text}) {
      const ref=React.useRef(null),follow=React.useRef(true)
      React.useEffect(()=>{const el=ref.current;if(el&&follow.current)el.scrollTop=el.scrollHeight},[text])
      return h('div',{'data-po06':'intercept-output-stream',ref,onScroll:()=>{const el=ref.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<40},style:{...S.ovPane,...S.ovPaneBody,maxHeight:'300px',overflowY:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'},'aria-live':'off'},text)
    }
    function InterceptPanel(props) {
      const prog = props.prog || null      // P11：宿主侧的实时进度（阶段 + 正在写的字）
      const hold = props.hold || {}
      const phase = props.phase
      const outputDraft=phase==='optimizing' ? interceptDraftOutput(prog && prog.text) : ''
      const permission = props.permission
      const rootRef = React.useRef(null)
      const offRef = React.useRef(null)
      const [pos, setPos] = React.useState(() => props.pos || defaultOvPos())
      const [size, setSize] = React.useState(() => props.size || { w: null, h: null })
      const [dragging, setDragging] = React.useState(false)
      const [sizing, setSizing] = React.useState(false)
      const posRef = React.useRef(pos)
      const sizeRef = React.useRef(size)
      posRef.current = pos
      sizeRef.current = size

      // 卸载即净：拖动中卸载也要摘掉 window 上的监听（这是 0.6 的纪律）
      React.useEffect(() => () => { if (offRef.current) offRef.current() }, [])
      // 窗口尺寸变化 ⇒ 重新夹紧位置与尺寸（0.5:1785-1794 的 reflowOverlay）
      React.useEffect(() => {
        // issue #18：**右缘收在会话窗内**，并且侧栏开关时立刻重算。
        // ⚠ 只听 window.resize 会漏掉一半：侧栏开关时**窗口尺寸没变**，变的是会话列宽 ——
        //   所以这里用 ResizeObserver 直接盯着输入卡片本身。
        const reflow = () => {
          const el = rootRef.current
          const rg = composerRegion(el)
          setPos((p) => { const n = clampOvPos(p.x, p.y, el, rg); return (n.x === p.x && n.y === p.y) ? p : n })
          setSize((s) => (s.w ? (() => { const n = { ...s, ...clampOvSize(s.w, s.h, rg) }; return (n.w === s.w && n.h === s.h) ? s : n })() : s))
        }
        reflow()                                    // 挂载即夹一次：默认落点/size 也不能越出会话窗
        // 侧栏可能是**固定浮层**（不压缩会话列）⇒ 只盯卡片会漏，交给共享观察器（含 body 子节点增删）
        return ovReflowWatch(reflow, rootRef.current)
      }, [])

      /** 一次指针拖动：move 只写本地值（父组件的 1 秒 tick 重渲染不会把面板弹回去）。 */
      const beginPointer = (e, onMove, onDone) => {
        if (e.button !== 0) return
        const move = (ev) => onMove(ev)
        const end = () => {
          window.removeEventListener('pointermove', move, true)
          window.removeEventListener('pointerup', end, true)
          window.removeEventListener('pointercancel', end, true)
          offRef.current = null
          if (typeof onDone === 'function') onDone()
        }
        window.addEventListener('pointermove', move, true)
        window.addEventListener('pointerup', end, true)
        window.addEventListener('pointercancel', end, true)
        offRef.current = end
        try {
          const el = rootRef.current
          if (el && el.setPointerCapture && e.pointerId != null) el.setPointerCapture(e.pointerId)
        } catch (err) { /* 合成指针没有捕获 */ }
        e.preventDefault()
      }
      const onDragStart = (e) => {
        // 起点在按钮上就不启动拖动：preventDefault 会抑制兼容 click，导致「✕ / 底栏按钮」点不动（0.5:1850）
        if (e.target && e.target.closest && e.target.closest('button')) return
        const el = rootRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        const d = { dx: e.clientX - r.left, dy: e.clientY - r.top }
        setDragging(true)
        beginPointer(e,
          (ev) => { const n = clampOvPos(ev.clientX - d.dx, ev.clientY - d.dy, el, composerRegion(el)); posRef.current = n; setPos(n) },
          () => { setDragging(false); props.onMove(posRef.current) })
      }
      const onSizeDown = (e) => {
        if (e.button !== 0) return
        const el = rootRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        const st = { x: e.clientX, y: e.clientY, w: r.width, h: r.height }
        setSizing(true)
        beginPointer(e,
          (ev) => { const n = clampOvSize(st.w + (ev.clientX - st.x), st.h + (ev.clientY - st.y), composerRegion(el)); sizeRef.current = n; setSize(n) },
          () => { setSizing(false); props.onResize(sizeRef.current) })
      }

      // ── 内容 ────────────────────────────────────────────────────────
      // 本轮"注入的那份文本"：用户改过就是改后的，没改过就是解释层回的包。
      // ⚠ 这不等于用户的消息——用户的原话永远按原文发出（见审查块的说明）。
      const packet = String(hold.edited == null ? (hold.packet || '') : hold.edited)
      const editable = phase === 'review' && permission === 'review'
      const secs = Math.max(0, Math.round((Date.now() - (hold.t0 || Date.now())) / 1000))
      // 状态行文案（0.5:1509 的 label）：`优化中…` / `已完成` / `失败`
      const statusLabel = phase === 'optimizing' ? L('优化中…', 'Optimizing…')
        : (phase === 'review' || phase === 'sent') ? (hold.noAddition ? L('已理解，无需新增辅助', 'Understood; no additional guidance needed') : L('已完成', 'Done'))
          : phase === 'skipped' ? L('已跳过', 'Skipped')
            : (phase === 'error' || phase === 'failed') ? L('失败', 'Failed') : L('待命', 'Idle')
      // 时间徽标：优化中给**已用秒数**（真实、每秒更新），完成后给**总耗时**（/interpret 回的 ms）。
      // 0.5 这里给的是"首字 ms"（流式才有），0.6 没有流式 ⇒ 不冒充（见上面的真相差异①）。
      const elapsedText = phase === 'optimizing'
        ? L('已用 ' + secs + ' 秒', secs + 's')
        : (hold.ms != null
          ? (hold.ms >= 1000 ? (hold.ms / 1000).toFixed(1) + 's' : hold.ms + 'ms')
          : '')
      const charsText = (hold.chars || packet) ? L('包 ' + (hold.chars || packet.length) + L(' 字',' chars'), 'packet ' + (hold.chars || packet.length) + ' chars') : ''

      // 底栏按钮的样式分层：primary（主操作）/ danger（重新生成）/ ghost（次要）/ 默认。
      // ⚠ 锚点写成**字面量对象**（而不是 `btn('intercept-x', …)` 那样拼字符串）：真机探针与静态
      //    守卫都按字面量 grep `'data-po06': 'intercept-…'`，拼出来的名字在源码里搜不到。
      const btn = (attrs, text, onClick, kind, tip) => h('button', {
        type: 'button', ...attrs, title: tip || undefined,
        style: { ...S.ovBtn, ...(kind === 'primary' ? S.ovBtnPrimary : (kind === 'danger' ? S.ovBtnDanger : (kind === 'ghost' ? S.ovBtnGhost : null))) },
        onClick,
      }, text)
      // ⚠ 子元素用**展开**而不是把数组当唯一子节点传：数组子节点在 React 里会被当成列表，
      //    开发模式下会报 "Each child in a list should have a unique key"（我们不需要 key，展开即可）。
      const footWrap = (name, kids) => h('div', { 'data-po06': 'intercept-foot', 'data-po06-foot': name, style: S.ovFoot },
        h('div', { 'data-po06': 'intercept-foot-inner', style: S.ovFootInner },
          h('div', { 'data-po06': 'intercept-actions', style: S.ovActions }, ...kids)))

      // 底栏变体（0.5:1622-1687 的五个 → 0.6 的四个阶段）。**关键：底栏在滚动区之外**。
      const footer = phase === 'review'
        // foot-review（0.5:1658-1674）：`‹ 回退` / `确认提交` / `重新生成`。
        // 0.6 的 `‹ 回退` = 不注入这一轮的包、按原文发出（= 既有处理函数 sendOriginal，见真相差异②）。
        ? footWrap('review', [
          btn({ 'data-po06': 'intercept-original' }, L('按原文发出', 'Send as-is'), props.onOriginal, 'ghost',
            L('这一轮不注入优化包，按你的原文发出（0.6 从不改写你的原话，能丢的只有包）',
              'Inject nothing this round and send your original text (0.6 never rewrites your words — only the packet can be dropped)')),
          btn({ 'data-po06': 'intercept-cancel' }, L('取消', 'Cancel'), props.onCancel, 'ghost',
            L('中止这一轮优化、什么都不发；草稿留在输入框里等你接着改（这才是 0.5 那颗「回退」干的事）',
              'Abort this round and send nothing; your draft stays in the box (this is what 0.5\u2019s \u2039Back\u203a really did)')),
          btn({ 'data-po06': 'intercept-confirm' }, L('确认提交', 'Confirm & send'), props.onConfirm, 'primary',
            L('把上面这份包作为本轮注入的内容，连同你的原文一起发出', 'Inject the packet above for this round, together with your original message')),
          btn({ 'data-po06': 'intercept-regen' }, L('重新生成', 'Regenerate'), props.onRegen, 'danger',
            L('用同一条原文重跑一次解释层', 'Run the explainer again on the same original text')),
          // 回退（用户 2026-09-21 明确要求："记得增加回退功能，这个在 0.5 里也有"）：
          // 包级回退是**真的**——宿主为每个会话留最近 10 版非空包，点了就把上一版放回来（正文随即刷新）。
          btn({ 'data-po06': 'intercept-rollback' }, L('回退上一版', 'Roll back'), props.onRollback, null,
            L('把上一版注入的包放回来（本会话最多可退 10 版；没有上一版时会如实告诉你）',
              'Restore the previous packet for this session (up to 10 versions; it will say so if there is none)')),
        ])
        // foot-sent（0.5:1650-1657）：放行之后只读回看 —— 关闭 / 重新生成
        : (phase === 'sent' || phase === 'skipped' || phase === 'failed')
          ? footWrap('sent', [
            h('span', { 'data-po06': 'intercept-sent-tag', style: S.ovSentTag },
              phase === 'sent' ? L('已发送 · 仅供查看', 'Sent · read-only')
                : phase === 'skipped' ? L('已跳过 · 按原文发出（仅供查看）', 'Skipped · sent as-is (read-only)')
                  : L('优化失败，已按原文发出 · 仅供查看', 'Optimizer failed; sent as-is (read-only)')),
            btn({ 'data-po06': 'intercept-close' }, L('关闭', 'Close'), props.onCloseSent, null,
              L('关掉浮层与悬浮球（结果不再回看）', 'Close the panel and the ball (no more review)')),
            btn({ 'data-po06': 'intercept-regen' }, L('重新生成', 'Regenerate'), props.onRegen, 'ghost',
              L('用同一条原文重跑一次解释层', 'Run the explainer again on the same original text')),
          ])
          // foot-error（0.5:1675-1681）：`重试` / `按原文发出`
          : phase === 'error'
            ? footWrap('error', [
              btn({ 'data-po06': 'intercept-retry' }, L('重试', 'Retry'), props.onRegen, null,
                L('重新跑一次解释层再放行（这条消息还没发出去）', 'Run the explainer again before releasing (this message was never sent)')),
              btn({ 'data-po06': 'intercept-original' }, L('按原文发出', 'Send as-is'), props.onOriginal, 'primary',
                L('不要这一轮的结果，直接按原文发出', 'Skip this round and send the original text')),
            ])
            // foot-idle（0.5:1683-1686）：优化中始终留一个出口 —— 0.6 就是既有的「跳过并直接发送」
            : footWrap('idle', [
              btn({ 'data-po06': 'intercept-skip' }, L('跳过并直接发送', 'Skip and send as-is'), props.onSkip, 'primary',
                L('不再等解释层，按原文发出', 'Do not wait for the explainer; send as-is')),
              btn({ 'data-po06': 'intercept-cancel' }, L('取消', 'Cancel'), props.onCancel, 'ghost',
                L('中止这一轮优化、什么都不发；草稿留在输入框里（0.5 的「回退」就是这个）',
                  'Abort this round and send nothing; the draft stays in the box (0.5\u2019s \u2039Back\u203a)')),
            ])

      return h('div', {
        ...themeAttrs(), ref: rootRef, 'data-po06': 'intercept', 'data-po06-phase': phase, 'data-po06-view': 'panel',
        'data-po06-closing': props['data-po06-closing'] || '0',
        'data-po06-exit': props.exitKind || 'none',
        'data-po06-drag': dragging ? '1' : '0', 'data-po06-size': sizing ? '1' : '0',
        style: {
          ...S.ov,
          transform: 'translate3d(' + pos.x + 'px,' + pos.y + 'px,0)',
          ...(size.w ? { width: size.w + 'px' } : null),
          height: size.h ? size.h + 'px' : 'auto',
          maxHeight: size.h ? 'none' : 'min(78vh,660px)',
          ...(dragging || sizing ? { userSelect: 'none' } : null),
        },
      },
        // 可拖的头（0.5:1940-1945）
        h('div', {
          'data-po06': 'intercept-head', style: S.ovHead, onPointerDown: onDragStart,
          title: L('按住拖动（右下角可改大小）', 'Drag to move (resize from the bottom-right corner)'),
        },
          h('span', { 'data-po06': 'intercept-state-dot', 'data-po06-value': phase, style: S.ovDot(phase) }),
          h('span', { 'data-po06': 'intercept-title', style: S.ovHeadTitle }, L('提示词优化', 'Prompt optimizer')),
          h('span', { 'data-po06': 'intercept-tier', style: S.ovHeadTier }, tierLabel(props.tier)),
          props.count > 0
            ? h('span', { 'data-po06': 'intercept-count', style: S.ovHeadCount, title: L('本会话累计拦截次数', 'Intercepts this session') },
              L('本会话已拦截 ' + props.count + ' 次', props.count + ' intercepted this session'))
            : null,
          h('span', { 'data-po06': 'intercept-head-hint', style: S.ovHeadHint },
            size.w ? (size.w + '×' + (size.h || L('自动', 'auto'))) : '↘'),
          // 收起为球（0.5 定义了 `.dpo-x` 的样式却在最终版里没接上；0.6 明确要求"关闭 → 收成球"）
          h('button', {
            type: 'button', 'data-po06': 'intercept-collapse', style: S.ovX,
            title: L('收起为悬浮球（结果还在，点球可回看）', 'Collapse into the floating ball (the result stays; click the ball to reopen)'),
            onClick: props.onCollapse,
          }, L('收起', 'Collapse')),
        ),
        // 滚动体（0.5:1946-1961）
        h('div', { 'data-po06': 'intercept-scroll', style: S.ovScrollY },
          h('div', { 'data-po06': 'intercept-run', style: S.ovRun },
            h('div', { 'data-po06': 'intercept-status', style: S.ovRunStatus },
              statusLabel,
              elapsedText ? h('span', { 'data-po06': 'intercept-elapsed', style: S.ovChipMuted }, elapsedText) : null,
              charsText ? h('span', { 'data-po06': 'intercept-chars', style: S.ovChip }, charsText) : null,
              // token 计数（0.5 的状态行有 `Σ {tok} tok`）：拿到就显示，拿不到显示"— tok"（不编 0）
              h('span', { 'data-po06': 'intercept-tokens', style: S.ovChipMuted, title: L('解释层这一轮的 token：输入 / 输出 / 缓存命中（provider 不上报的项显示 —，**不做估算**）', 'Explainer tokens this round: input / output / cache hits (items the provider does not report show —, never estimated)') },
                // 用户 2026-09-21：**不要估算**，要按真实上报区分 输入/输出/缓存命中。
                // 于是这里只显示 provider 真给的字段：`in 1234 · out 567 · cache 890 tok`；
                // 拿不到的项显示 `—`（不折算、不猜）。
                // 用量来源：**结果优先**（拦截结束后仍在），其次才是进行中的进度面。
                usageText((hold && hold.usage) ? hold.usage : ((prog && prog.usage) ? prog.usage : null))),
              // 拦截来路（回车 / 按钮 / 重新生成）：原来那块手写面板上有，真机排障时要看（保留，不新增真相）
              h('span', { 'data-po06': 'intercept-via', style: S.ovChipMuted },
                hold.via === 'key' ? L('回车拦截', 'Enter')
                  : hold.via === 'click' ? L('按钮拦截', 'Click')
                    : L('重新生成', 'Regen')),
            ),
            // P11：如果这一轮走的是**兜底模型**（不是你会话的模型），必须说明——
            // 真机实测：随便挑清单第一条会挑到 flash，1 秒回一个"没有改动"，优化器就成了摆设。
            (hold.route && hold.route !== 'observed')
              ? h('div', { 'data-po06': 'intercept-route-warn', 'data-po06-value': hold.route, style: { ...S.ovHintQuiet, color: OVS.cap } },
                hold.route === 'host-default-first'
                  ? L('⚠ 这一轮用的是**兜底模型**（清单第一条，不是你会话的模型）——结果可能偏薄，建议在控件栏里把解释层模型固定一个',
                    '⚠ This round used a fallback model (first in the list, not your session\u2019s) — expect a thinner packet; consider pinning the explainer model in the bar')
                  : L('这一轮的模型路由来自' + (hold.route === 'session' ? '会话设置' : '宿主默认') + '（还没观测到你会话的模型）',
                    'This round\u2019s route came from ' + (hold.route === 'session' ? 'session settings' : 'host default') + ' (your session model was not observed yet)'))
              : null,
            // 诚实信号：机器自己补出来、且没有用户原话支撑的条目 = 缺陷，必须看得见（这块原来在
            // 已删掉的"它在替我做什么"里，挪到审查面板；测试仍钉着 intercept-unsourced）
            hold.unsourced > 0
              ? h('div', { 'data-po06': 'intercept-unsourced', style: { ...S.ovHintQuiet, color: OVS.dangerFg } },
                L('⚠ 这一轮有 ' + hold.unsourced + ' 条「无出处」条目（机器补的、没有你的原话支撑）——这是缺陷，请改掉或删掉',
                  '⚠ ' + hold.unsourced + ' unsourced item(s) this round (machine-added, not backed by your words) — this is a defect; edit or delete them'))
              : null,
            // ── 「思维层」（0.5 的**思考折叠**：运行中展开、完成后收起）─────────────
            // 0.5 的形状：状态行 → 思考折叠 → 产出 → 原文折叠 → 错误行。
            // ⚠ 用户 2026-09-21："思维层/产出层混乱，直接照搬 0.5"。此前我多塞了一个"等待页"，
            // 于是"阶段信息"和"思考正文"分成两块、外加产出层，三块混在一起。
            // 现在**回到 0.5 的单一思考折叠**：阶段 + 字数 + 流式正文都在这一块里；
            // 默认展开/收起跟随阶段（优化中展开、出结果后收起）——这就是 0.5 的"运行中展开、完成后收起"。
            (prog && (prog.reasoningChars || prog.textChars || prog.stage))
              ? h(OvFold, {
                mark: 'think',
                title: L('思维层', 'Thinking'),
                defaultOpen: phase === 'optimizing',
                summary: (prog.stage
                  ? (prog.stage === 'gate' ? L('判定启用状态', 'checking the enable gate')
                    : prog.stage === 'model' ? L('解析模型路由', 'resolving the model route')
                      : prog.stage === 'interpret' ? L('读上下文、准备解释', 'reading context')
                        : prog.stage === 'streaming' ? L('正在写这一轮的理解', 'writing this round\u2019s reading')
                          : prog.stage === 'done' ? L('已产出（正在编译包）', 'produced (compiling the packet)')
                            : prog.stage === 'noop' ? L('这一轮没有产出', 'nothing produced this round')
                              : prog.stage === 'failed' ? L('解释失败', 'interpretation failed')
                                : String(prog.stage))
                  : '')
                  // 思考优先（2026-09-25 修复）：原实现"正文字数"优先，于是模型不返回思考时
                  // 标题写成"正文 N 字"，而"正文"恰是**原始补丁 JSON** ⇒ 看起来像坏了。
                  + (prog.reasoningChars ? ' ｜ ' + L('思考 ', 'reasoning ') + prog.reasoningChars + L(' 字', ' chars')
                    : prog.textChars ? ' ｜ ' + L('正文 ', 'text ') + prog.textChars + L(' 字', ' chars') : ''),
              }, h(ThinkBody, {
                text: (() => {
                  const r = String(prog.reasoning || '')
                  if (r) return r
                  const t = String(prog.text || '').trim()
                  if (!t) return L('（还没有内容）', '(nothing yet)')
                  // 原始补丁以 { 或 [ 开头（结构化协议数据，给宿主校验用）。两种坏做法都试过了：
                  // 整段渲染 ⇒ 思维层里一大段 JSON（2026-09-25 截图）；只报规模 ⇒ 等于留白
                  // （同日反馈"直接没有思考过程了"）。这里对流式补丁做**容错解析**，
                  // 把已成形条目的 kind + text 转成可读进度，既有内容又不是裸 JSON。
                  if (t.charCodeAt(0) === 123 || t.charCodeAt(0) === 91) {
                    const rows = []
                    const re = /"kind"\s*:\s*"([a-z_]+)"[\s\S]{0,240}?"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g
                    let mm
                    while ((mm = re.exec(t)) !== null && rows.length < 12) {
                      rows.push(mm[1] + '：' + mm[2].replace(/\\n/g, ' ').replace(/\\"/g, '"').slice(0, 72))
                    }
                    const head = L('正在产出结构化补丁（' + t.length + ' 字）', 'producing a structured packet (' + t.length + ' chars)')
                    if (rows.length === 0) return head + '\n' + L('（等待第一条…）', '(waiting for the first item…)')
                    return head + '\n' + rows.map((x) => '· ' + x).join('\n')
                  }
                  return t
                })(),
              }))
              : (phase === 'optimizing'
                // 还没开始产出：也要让人看到"它在做什么"（0.5 此时思考区是空的，但状态行在转）
                ? h(OvFold, {
                  mark: 'think', title: L('思维层', 'Thinking'), defaultOpen: true,
                  summary: L('等待解释层开始产出…', 'waiting for the explainer…'),
                }, L('已经拦下你的消息，正在准备这一轮的解释（不设超时，随时可以跳过或取消）',
                  'Your message is held; preparing this round\u2019s interpretation (no timeout — skip or cancel anytime)'))
                : null),
            hold.englishMode&&hold.outgoingText?h('div',{'data-po06':'english-outgoing',style:S.ovReview},h('div',{style:S.ovPaneTitle},L('实际发送的英文任务','English task to send')),h('pre',{style:{...S.ovPaneBody,maxHeight:'220px',overflow:'auto',whiteSpace:'pre-wrap',margin:0}},hold.outgoingText),h('span',{style:S.muted},hold.translation?.assistanceReason?L('辅助未能生成，本次只发送保真译文。原文仍保留。','Assistance was unavailable; only the faithful translation is sent. Original retained.'):hold.translation?.warnings?.some(w=>w.reason==='untranslated-optional-assistance-omitted')?L('部分辅助未能转为英文，已省略；有效英文任务仍保留。','Some optional assistance could not be rendered in English and was omitted; the valid English task remains.'):L('原文单独保留；代码、路径与逐字文本保持原样。','Original retained separately; code, paths and exact text remain unchanged.'))):null,
            // ── 「产出层」────────────────────────────────────────────────
            phase === 'optimizing'
              ? h('div',{'data-po06':'intercept-review',style:S.ovReview},
                h('div',{'data-po06':'intercept-output-title',style:S.ovPaneTitle},L('产出层','Output')),
                h('div',{'data-po06':'intercept-caption',style:S.ovPaneTitle},L('正在生成 · 尚未校验','Generating · Not yet validated')),
                outputDraft ? h(InterceptDraftBody,{text:outputDraft}) : h('div',{style:S.ovHintQuiet},L('等待产出正文…','Waiting for output…')))
              : (phase === 'review' || packet)
              ? h('div', { 'data-po06': 'intercept-review', style: S.ovReview },
                // 「产出层」标题（用户 2026-09-21："两层要分明，照 0.5"）：
                // 思维层 = 它在想什么（上面那个折叠）；产出层 = 这一轮给出什么（从这行开始）。
                h('div', { 'data-po06': 'intercept-output-title', style: S.ovPaneTitle }, L('产出层', 'Output')),
                // 标题按阶段说**实话**（0.5 只有"将原样发给"一句，因为它的产出就是草稿本身）：
                //   审查 = 还没发（可编辑）；sent = 已经注入了；error = 放行失败，**根本没注入**。
                h('div', { 'data-po06': 'intercept-caption', style: S.ovPaneTitle },
                  phase === 'sent'
                    ? L('本轮注入给工作 AI 的内容 · ' + packet.length + L(' 字',' chars'),
                      'What this round injected for the working AI · ' + packet.length + ' chars')
                    : phase === 'error'
                      ? L('本轮解释层产出的包（放行失败，还没注入） · ' + packet.length + L(' 字',' chars'),
                        'Packet produced this round (release failed, never injected) · ' + packet.length + ' chars')
                      : L('以下内容将在本轮原样注入给工作 AI（可直接编辑） · ' + packet.length + L(' 字',' chars'),
                        'The following will be injected verbatim for the working AI this round (editable) · ' + packet.length + ' chars')),
                h('div', { style: S.ovHintQuiet },
                  hold.englishMode?L('英文任务发送给工作 AI，原话仍保留为依据；这里编辑的是英文辅助文。','English task is sent to the working AI; original source is retained. This edits the English assistance.'):L('你的原话不会被改写——它按原文发出；这里编辑的是「本轮要注入的包」。',
                    'Your own message is never rewritten — it goes out verbatim; what you edit here is the packet injected this round.')),
                editable
                  // 可编辑（0.5:1582-1588 的 textarea）：改完点「确认提交」就是本轮注入的内容
                  ? h('textarea', {
                    'data-po06': 'intercept-text', style: S.ovReviewText, value: packet, spellCheck: false,
                    // tabIndex=-1：不让它进入"顺序焦点"。面板一出现时浏览器/输入法会把焦点甩到
                    // 第一个可聚焦控件上，回车就被这个编辑框吃掉（用户 2026-10-19 真机）。
                    // 想编辑仍然可以**点一下**再输入——不影响功能，只是不再抢焦点。
                    tabIndex: -1,
                    onChange: props.onEdit,
                  })
                  // 只读视图（自动档 / 放行之后 / 优化失败）：0.5 的 `.dpo-pane-body`（pre-wrap）
                  : h('div', { 'data-po06': 'intercept-packet', style: { ...S.ovPane, maxHeight: '300px' } },
                    h('div', { style: S.ovPaneBody }, packet || L('（这一轮没有包）', '(no packet this round)'))),
              )
              : null,
            // 错误行（0.5:1554-1558）：`失败：` + 人话，完整原因挂 title
            hold.reason
              ? h('div', { 'data-po06': 'intercept-reason', style: S.ovError },
                h('span', { title: String(hold.reason) }, L('失败：', 'Failed: ') + reasonText(hold.reason)))
              : null,
          ),
          // 原文折叠（0.5:1957-1959 的 disclosure("original")）：0.6 **从不改写**原话 ⇒ 原文永远可查
          hold.text
            ? h(OvFold, {
              mark: 'original', title: L('原文', 'Original'),
              summary: String(hold.text).length + L(' 字', ' chars'),
            }, hold.text)
            : null,
        ),
        footer,
        // 右下角改尺寸把手（0.5:1966-1969）
        h('div', { 'data-po06': 'intercept-grip', style: S.ovGrip, onPointerDown: onSizeDown,
          title: L('拖动改大小（本次会话内记住）', 'Drag to resize (remembered for this session)') }),
      )
    }

    // ── P11 · 前置拦截（用户要的"第一轮发，第一轮就回"）──────────────────
    // 机制**逐条照抄 0.5**（行号见 `po06/P11-INTERCEPT-PLAN.md`，源 = 0.5.2 线 `lib/client.js`）：
    //   捕获阶段监听 Enter/click（0.5:3095/3121/3152）· 判据读**此刻编辑器里真实的字**（0.5:458-465）
    //   发送按钮 = 本地化 aria-label 白名单 + "卡片内最后一个按钮"兜底（0.5:483-515）
    //   `preventDefault + stopPropagation` 接管、`inputActions` 放行（0.5:1285）· 草稿被清则显式写回（0.5:1203）
    //   同一次发送可能同时命中 Enter 与 click ⇒ 去重（0.5:443-453）· 档位「关闭」⇒ 完全不拦（0.5:2316）
    //   fail-open：拿不到包就**按原文发出**（0.5 的 auto 档语义）
    // **唯一的新轮子**：0.5 的解释层在客户端、我们的在宿主 ⇒ 拦下后要 POST /interpret 让宿主先算。
    const SEND_KEYS = ['input.send', 'input.send.queue', 'input.send.steer']

    /** 从**我们自己渲染的节点**往上找输入卡片（不用产品类名/选择器）；找不到 = 不在会话页 ⇒ 一律放行。 */
    // ⚠ 选择器要**容错**：`contenteditable` 的合法写法不止 "true"（"" 与 "plaintext-only" 同样可编辑）。
    // 原先只认 `[contenteditable="true"]` ⇒ 宿主换个写法就量不到卡片、退回视口、浮层重新压到侧栏上。
    const EDITABLE_SEL = '[contenteditable]:not([contenteditable="false"])'
    function composerCard(node) {
      let el = node
      while (el && el !== document.body) {
        if (el.querySelector && el.querySelector(EDITABLE_SEL)) return el
        el = el.parentElement
      }
      return null
    }
    function composerDraft(card) {
      const ed = card ? card.querySelector(EDITABLE_SEL) : null
      if (!ed) return ''
      const raw = (typeof ed.innerText === 'string' && ed.innerText.length > 0) ? ed.innerText : (ed.textContent || '')
      return String(raw).replace(/\u00a0/g, ' ')
    }
    const composerButtons = (card) => (card ? Array.from(card.querySelectorAll('button')) : [])
    const lastComposerButton = (card) => { const l = composerButtons(card); return l.length ? l[l.length - 1] : null }
    /**
     * 这次按键/点击是不是发生在**输入卡片里**。
     * 判据优先看**事件目标**（`target`）——它才是"这一次击键真正发生在哪"；
     * 只有拿不到 target 时才退回 `document.activeElement`（0.5 只用后者）。
     * 为什么改：真机探针实测（headless 窗口未获得焦点时 `document.activeElement` 恒为 body）
     * 会**永远判为"焦点不在输入区"⇒ 一次都拦不住**；而事件目标是客观事实，不受窗口焦点影响。
     * 副作用是更好的：设置页/重命名框里的 Enter 目标不在卡片里 ⇒ 照样交还官方。
     */
    function focusInComposer(card, target) {
      const a = (card && target && card.contains(target)) ? target : document.activeElement
      if (!card || !a || !card.contains(a)) return false
      if (a.closest && a.closest('button')) return false
      if (a.closest && a.closest('[data-po06="panel"], [data-po06="help-pop"], [data-po06="intercept"]')) return false
      return true
    }

    /**
     * 第 5 项：本轮注入卡片的**数据模型**（纯函数——单测直接调用，不依赖 DOM）。
     *
     * 只认**已经发布出去**的那一轮：没有注入文就返回 null（界面据此不画卡片，
     * 而不是画一张空卡片）。用户 2026-10-18 定稿：**只显示实际注入文**——
     * 原话与"优化后的意图包"都不再展示（注入文本身已经含意图包 + 顾问契约 + 工作流程）。
     */
    function injectionCardModel(h) {
      if (!h || typeof h !== 'object') return null
      if (h.injectCard === false) return null
      const injected = typeof h.packet === 'string' ? h.packet : ''
      if (!injected.trim()) return null
      const chars = (typeof h.chars === 'number' && h.chars > 0) ? h.chars : injected.length
      return { injected, chars }
    }

    /** 「本次注入」那颗小胶囊的图标：一张卡片 + 一支进入的箭头（注入 = 进到上下文里）。 */
    function InjectIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true', focusable: 'false', style: { flex: '0 0 auto' } },
        h('rect', { x: 1, y: 1.6, width: 10, height: 8.8, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.15, opacity: .55 }),
        h('path', { d: 'M6 3.1v5.1M4.1 6.4 6 8.3l1.9-1.9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.15, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }



    /**
     * 对话流里的「本次注入」卡片。
     *
     * 走的是宿主**本来就有的行类型**：命令事件（command/run + command/done）在对话流里
     * 渲染成一张命令卡，宿主再按命令名分发到 conversation.chat.commandview 子槽
     * ——/vmake 那种卡就是同一条路。我们只注册 `po06-inject` 这个名字的视图。
     *
     * ⚠ 为什么不用自定义事件：宿主读取器对未知类型 fail-closed，插件又设置不了 ignorable，
     * 写自定义事件 = 会话重启后打不开（2026-10-19 P0）。命令事件是**已知类型**，安全。
     *
     * 卡片正文取自插件自己的 /po06/api/injection（事件里只放记录 id），默认收起。
     */
    const INJECTION_COMMAND = 'po06-inject'
    function InjectionCommandCard(props) {
      const cmd = (props && props.node) || {}
      const [rec, setRec] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      // ⚠ 必须在**所有早退之前**调用：记录到达前后是两次渲染，钩子数量不一致会被 React 判成
      //   "Rendered more hooks than during the previous render" ⇒ 整张卡直接消失（2026-10-19 真机）。
      const body = useExit(open, 140)
      useLocaleLive()
      useThemeLive()
      const recordId = (() => {
        try { const v = JSON.parse(String(cmd.args || '{}')); return v && typeof v.id === 'string' ? v.id : '' } catch { return '' }
      })()
      React.useEffect(() => {
        if (!recordId) return undefined
        let alive = true
        apiGet('/injection?id=' + encodeURIComponent(recordId)).then((r) => {
          if (!alive || !r || r.ok !== true || !r.injection) return
          setRec(r.injection)
        }, () => { /* 记录没了（插件重启过）就不画，留个空壳比编内容好 */ })
        return () => { alive = false }
      }, [recordId])
      if (!rec || typeof rec.injected !== 'string' || !rec.injected.trim()) return null
      const chars = Number(rec.chars) > 0 ? rec.chars : rec.injected.length
      return h('div', { 'data-po06': 'injection-row', style: S.injRow },
        h('button', {
          type: 'button', 'data-po06': 'injection-row-head', 'data-open': open ? '1' : '0',
          'aria-expanded': open ? 'true' : 'false',
          title: L('看看这一轮到底往上下文里塞了什么（点开）', 'See exactly what this round put into the context (click)'),
          style: S.injHead, onClick: () => setOpen((v) => !v),
        },
          h(InjectIcon),
          h('span', { 'data-po06': 'injection-row-title', style: S.optBtnText }, L('本次注入', 'Injected')),
          h('span', { 'data-po06': 'injection-row-chars', style: S.optSummary }, String(chars) + L(' 字', ' chars')),
          h('span', { 'aria-hidden': 'true', style: S.optCaret }, open ? '▴' : '▾')),
        body.mounted ? h('div', { 'data-po06': 'injection-row-body', style: S.injBody, 'data-po06-closing': body.closing ? '1' : '0' },
          h('pre', { 'data-po06': 'inject-body', style: { ...S.ovPaneBody, margin: 0, maxHeight: 'min(60vh, 520px)', overflow: 'auto', fontFamily: 'inherit' } },
            rec.injected),
          rec.truncated ? h('div', { 'data-po06': 'inject-note', style: S.ovHintQuiet },
            L('这条是旧记录，当时只存了前 4000 字。', 'This is an old record that only kept the first 4000 characters.')) : null,
        ) : null)
    }

    // ── ① 输入区左侧的控件栏（0.5 的操作形态）─────────────────────────
    // 为什么把"小胶囊"换成一排控件（用户实测反馈「不适应 0.6 的操控/检测模式」）：
    // 胶囊只回答"它在不在"，而人要的是**随手拨**——档位、权限、上下文、读不读项目文件、用哪个模型。
    //
    // 四条实现纪律：
    //   · **档位以宿主为准**：`/status.described.tier` 是宿主按 settings.js 的 TIER_PRESETS 推导的，
    //     客户端只在拿不到 described 时才用本地镜像兜底——不制造第二个真相来源。
    //   · **写操作只发改动的那一个字段**，档位发 `{tier}`（档位是糖，由宿主铺 assist/detail/budget）。
    //   · **readTools 三态**：第一次 `/status` 读到它之前**不发这个字段**——
    //     否则会把"文件里没写"变成"显式 false"，那是把"未设置"写成了"用户选过关"。
    //   · **保存后就重新拉 /status**（界面与后端一致），失败就在控件旁给一行短错误，不弹窗、不静默。
    function ControlBar(props) {
      // 宿主按**标准 props** 注入：`sessionId`（会话作用域）与 `inputActions`（放行通道，见 slots.d.ts:201-255）。
      // ⚠ `inputActions` 拿不到 ⇒ **绝不拦截**（拦下却没有放行通道 = 把用户的消息吞掉）。
      const { sessionId, inputActions } = props || {}
      const [status, refreshStatus] = useStatus(sessionId)
      const [open, setOpen] = React.useState(false)
      // 预设提示（2026-10-19）：非 Wish / PTC 预设时弹一次，两个按钮（知道了 / 以后不再显示）。
      const [notice, setNotice] = React.useState(null)
      // 「跳过并发送」时提示双击 Enter 的卡片（2026-10-19 用户要求；开关已开或点过"以后不再显示"就不弹）
      const [skipHint, setSkipHint] = React.useState(null)   // null | { on: boolean }
      // 预设被**在会话开始前**拨过（用户 2026-10-19 的真机情形）：宿主给会话头的是默认预设，
      // 光在回车时判定是看不出来的。所以盯着输入区，预设一变就问一次宿主"现在算哪个预设"，
      // 变了且不是 Wish/PTC 就当场把提示弹出来（不用等下一次发送）。
      // 「优化选项」弹出面板（用户 2026-09-22：档位这些收进一个按钮里）
      const [optOpen, setOptOpen] = React.useState(false)
      const [optPos, setOptPos] = React.useState(null)
      const optBtnRef = React.useRef(null)
      const optRef = React.useRef(null)
      // 密度档：0 正常 / 1 紧凑 / 2 极紧。打开后按"内容高度 vs 可用高度"自动升档，
      // 这是"边界自动挤压"：先缩间距与行高，挤不下才允许内部滚动。
      const [optDensity, setOptDensity] = React.useState(0)
      // issue #18（用户澄清）：弹层/面板**不许与右侧栏重合** —— 它们的右边界要收在会话窗内。
      // 会话窗宽度没有现成的常量可读，所以**量输入卡片**：侧栏一开，会话列变窄、卡片跟着变窄。
      // 观察点用 ResizeObserver 而不是只听 window.resize：侧栏开关时窗口尺寸不变，变的是列宽。
      const [region, setRegion] = React.useState(null)
      // 预设闸门（2026-10-19 用户要求）：**按回车、优化还没开始**的时候就问宿主一次。
      // 不再做后台轮询——不希望在"发出去之后"才弹。一个会话只问一次（问过就放行，避免每次回车都打接口）。
      const presetGateRef = React.useRef('')
      // 取证：这个面板当前绑定的是哪个会话（"我明明进了标准会话"时，先看插件有没有跟着换）
      React.useEffect(() => {
        apiPost('/client-log', { event: 'bar-mount', sid: sessionId }).catch(() => {})
      }, [sessionId])



      // 预设提示：**画到 document.body 上**（2026-10-19 第三次踩同一个坑）。
      // 之前用 React 渲染在输入区里，position:fixed 在带 transform/overflow 的祖先下会被裁掉或错位，
      // 真机上就是"notice 拿到了但屏幕上看不见"。这里改成命令式浮层：进来必有、层级最高、卸载即清。
      React.useEffect(() => {
        if (!notice || typeof document === 'undefined') return undefined
        apiPost('/client-log', { event: 'notice-mount', sid: sessionId, preset: notice.preset }).catch(() => {})
        const el = document.createElement('div')
        el.setAttribute('data-po06', 'preset-notice-backdrop')
        el.style.cssText = 'position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(0,0,0,.42);padding:16px;'
        const card = document.createElement('div')
        card.setAttribute('data-po06', 'preset-notice')
        card.setAttribute('role', 'dialog')
        card.setAttribute('aria-modal', 'true')
        card.style.cssText = 'width:min(430px,92vw);box-sizing:border-box;padding:20px 22px 18px;border-radius:14px;' +
          'background:' + OVS.surface + ';border:1px solid ' + OVS.lineSoft + ';box-shadow:0 22px 54px -22px rgba(0,0,0,.65);' +
          'color:' + OVS.fg + ';font-size:14px;line-height:1.6;'
        const head = document.createElement('div')
        head.style.cssText = 'display:flex;align-items:center;gap:9px;margin-bottom:10px'
        const dot = document.createElement('span')
        dot.setAttribute('data-po06', 'notice-accent')
        dot.style.cssText = 'flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:' + OVS.acc
        const title = document.createElement('strong')
        title.style.cssText = 'font-size:15px;font-weight:700;letter-spacing:.2px'
        title.textContent = L('许愿特化器', 'Wish Specializer')
        head.appendChild(dot); head.appendChild(title)
        const body = document.createElement('p')
        // 用户 2026-10-19：直击要害，别铺太多
        body.style.cssText = 'margin:0 0 8px;color:' + OVS.fg + ';font-size:14px;font-weight:500'
        body.textContent = L('此插件建议使用 PTC 和 Wish 预设，其他预设可能表现不佳。',
          'This plugin works best with the PTC and Wish presets; other presets may underperform.')
        const hint = document.createElement('p')
        hint.style.cssText = 'margin:0 0 12px;color:' + OVS.fg3 + ';font-size:11.5px'
        hint.textContent = L('点「以后不再显示」可永久关闭此提示。', 'Choose "Do not show again" to stop seeing this.')
        const actions = document.createElement('div')
        actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'
        const mk = (label, primary, onClick, attr) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.setAttribute('data-po06', attr)
          b.textContent = label
          b.style.cssText = 'height:28px;padding:0 12px;border-radius:8px;font:inherit;cursor:pointer;' +
            (primary ? 'border:1px solid transparent;background:' + OVS.acc + ';color:#fff;font-weight:600'
              : 'border:1px solid ' + OVS.lineSoft + ';background:transparent;color:' + OVS.fg2)
          b.onclick = onClick
          actions.appendChild(b)
          return b
        }
        mk(L('知道了', 'Got it'), false, () => dismissNotice(false), 'notice-ok')
        mk(L('以后不再显示', 'Do not show again'), true, () => dismissNotice(true), 'notice-never')
        card.appendChild(head); card.appendChild(body); card.appendChild(hint); card.appendChild(actions)
        el.appendChild(card)
        document.body.appendChild(el)
        apiPost('/client-log', { event: 'notice-mounted', sid: sessionId, preset: notice.preset,
          detail: 'connected=' + String(el.isConnected) + ' children=' + String(el.childElementCount) }).catch(() => {})
        // 退场：先淡出 + 轻微下沉，再移除（与其他弹层同一套语言）
        return () => {
          try {
            el.style.transition = 'opacity .12s ease'
            el.style.opacity = '0'
            card.style.transition = 'opacity .1s ease, transform .12s ease'
            card.style.transform = 'translateY(4px) scale(.98)'
            setTimeout(() => { try { el.remove() } catch { /* 忽略 */ } }, 130)
          } catch { try { el.remove() } catch { /* 忽略 */ } }
        }
      }, [notice])

      // 双击 Enter 的提示卡：与预设提示同一套 body 级浮层（不再受输入区裁剪影响）
      React.useEffect(() => {
        if (!skipHint || typeof document === 'undefined') return undefined
        apiPost('/client-log', { event: 'skip-hint-mount', sid: sessionId }).catch(() => {})
        const el = document.createElement('div')
        el.setAttribute('data-po06', 'skip-hint-backdrop')
        el.style.cssText = 'position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;' +
          'background:rgba(0,0,0,.42);padding:16px;'
        const card = document.createElement('div')
        card.setAttribute('data-po06', 'skip-hint')
        card.setAttribute('role', 'dialog')
        card.style.cssText = 'width:min(430px,92vw);box-sizing:border-box;padding:20px 22px 18px;border-radius:14px;' +
          'background:' + OVS.surface + ';border:1px solid ' + OVS.lineSoft + ';box-shadow:0 22px 54px -22px rgba(0,0,0,.65);' +
          'color:' + OVS.fg + ';font-size:14px;line-height:1.6;'
        const head = document.createElement('div')
        head.style.cssText = 'display:flex;align-items:center;gap:9px;margin-bottom:10px'
        const dot = document.createElement('span')
        dot.setAttribute('data-po06', 'skip-hint-accent')
        dot.style.cssText = 'flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:' + OVS.acc
        const title = document.createElement('strong')
        title.style.cssText = 'font-size:13.5px;font-weight:700;letter-spacing:.2px'
        title.textContent = L('双击 Enter 也能跳过', 'Double Enter can skip too')
        head.appendChild(dot); head.appendChild(title)
        const body = document.createElement('p')
        body.style.cssText = 'margin:0 0 6px;color:' + OVS.fg2
        const isOn = !!(skipHint && skipHint.on)
        body.textContent = isOn
          ? L('「双击 Enter 跳过」已开启：在输入框里连按两次 Enter，即可直接跳过本轮优化。',
            '"Double Enter skip" is on: press Enter twice in the composer to skip this round immediately.')
          : L('开启「双击 Enter 跳过」后，即可双击 Enter 来直接跳过优化。',
            'Turn on "Double Enter skip" and you can press Enter twice to skip the optimization.')
        const hint = document.createElement('p')
        hint.style.cssText = 'margin:0 0 10px;color:' + OVS.fg3 + ';font-size:11px'
        hint.textContent = isOn
          ? L('不需要时可在：优化选项 → 双击 Enter 跳过 里关掉', 'Turn it off in: Options → Double Enter skip')
          : L('位置：优化选项 → 双击 Enter 跳过', 'Where: Options → Double Enter skip')
        const actions = document.createElement('div')
        actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'
        const mk = (label, primary, onClick, attr) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.setAttribute('data-po06', attr)
          b.textContent = label
          b.style.cssText = 'height:28px;padding:0 12px;border-radius:8px;font:inherit;cursor:pointer;' +
            (primary ? 'border:1px solid transparent;background:' + OVS.acc + ';color:#fff;font-weight:600'
              : 'border:1px solid ' + OVS.lineSoft + ';background:transparent;color:' + OVS.fg2)
          b.onclick = onClick
          actions.appendChild(b)
        }
        mk(L('知道了', 'Got it'), false, () => setSkipHint(null), 'skip-hint-ok')
        mk(L('以后不再显示', 'Do not show again'), true, () => {
          setSkipHint(null)
          save({ skipHintDismissed: true })
        }, 'skip-hint-never')
        card.appendChild(head); card.appendChild(body); card.appendChild(hint); card.appendChild(actions)
        el.appendChild(card)
        document.body.appendChild(el)
        return () => {
          try {
            el.style.transition = 'opacity .12s ease'
            el.style.opacity = '0'
            setTimeout(() => { try { el.remove() } catch { /* 忽略 */ } }, 130)
          } catch { try { el.remove() } catch { /* 忽略 */ } }
        }
      }, [skipHint])



      const dismissNotice = (forever) => {
        setNotice(null)
        apiPost('/notice', forever ? { forever: true } : { session: sessionId }).catch(() => {})
      }
      React.useEffect(() => {
        const reflow = () => {
          const rg = composerRegion(optBtnRef.current)
          setRegion((r) => ((r && r.left === rg.left && r.right === rg.right && r.source === rg.source) ? r : rg))
        }
        reflow()
        return ovReflowWatch(reflow, optBtnRef.current)
      }, [])
      React.useEffect(() => { if (!optOpen) setOptDensity(0) }, [optOpen])
      // ⚠ 用 useIso（React.useLayoutEffect || React.useEffect）：管线里的 React 可能是精简替身，
      // 直接点 useLayoutEffect 会 `is not a function`（真机 + 套件都撞过）。
      // ⚠ 用 (React.useLayoutEffect || React.useEffect)：管线里的 React 可能是精简替身，
      // 直接点 useLayoutEffect 会 "is not a function"（真机与套件都撞过）。
      ;(React.useLayoutEffect || React.useEffect)(() => {
        if (!optOpen) return
        const el = optRef.current
        if (!el || !optPos) return
        const maxH = optPos.maxH || 600
        // scrollHeight 反映真实内容高度（即使已被 maxHeight 裁剪），所以能判断"挤不挤得下"
        if (el.scrollHeight > maxH + 2 && optDensity < 2) setOptDensity((d) => d + 1)
      }, [optOpen, optPos, optDensity])
      // 点面板外 / 按 Esc 收起（键盘可达；不抢输入框的回车）
      React.useEffect(() => {
        if (!optOpen) return undefined
        const onDown = (e) => {
          const el = rootRef.current
          if (el && e.target && el.contains && el.contains(e.target)) return
          setOptOpen(false)
        }
        const onKey = (e) => { if (e && e.key === 'Escape') setOptOpen(false) }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [optOpen])
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [failTick, setFailTick] = React.useState(0)
      const [helpOpen, setHelpOpen] = React.useState(false)
      // P11 拦截态：{text, via, t0, phase, packet, chars, ms, reason, edited}
      // ⚠ 用户实测（2026-09-21）：**切到别的会话再回来，拦截面板就没了**。
      // 原因：控件栏是 per-session 挂载的，切会话会重挂 ⇒ 组件内的 hold 归零。
      // 而"消息还被我拦着"这件事**必须跨会话切换活下来** ⇒ hold 同时写一份到 window 上，
      // 重挂时按 sessionId 取回（只认同一会话，绝不把 A 会话的拦截态显示到 B 会话）。
      LAST_MOUNTED_SID = String(sessionId || '')
      const [hold, _setHold] = React.useState(() => holdBridgeRead(sessionId))
      const setHold = React.useCallback((v) => {
        _setHold(v)
        // ⚠ 旧实例（会话已切走）不许再往桥上写：它的 clearHoldSoon 会把**别的会话**的拦截态清掉，
        // 用户看到的就是"优化自己消失"（2026-10-19 真机）。跨会话的结果由完成回调直接写回发起会话。
        if (String(sessionId || '') !== LAST_MOUNTED_SID) return
        holdBridgeWrite(sessionId, v)   // 写桥即广播（issue #19）：别的挂载/后台完成的那一份也能被认领
      }, [sessionId])
      const [tick, setTick] = React.useState(0)        // 只用于"已用 N 秒"重新渲染
      useLocaleLive()                                  // 语言是活的：DSH 里切语言 ⇒ 立刻换文案
      useThemeLive()                                   // 主题也是活的：切深浅色 ⇒ 立刻换配色
      const [interceptCount, setInterceptCount] = React.useState(0)   // 本会话拦截次数（0.5 也有这个计数）
      const [prog, setProg] = React.useState(null)                    // P11：解释进度（阶段 + 流式正文尾部）
      // P11 浮层的**呈现状态**（0.5 把这两态放在 store.overlay / store.ball；0.6 不引入全局 store，
      // 用组件状态即可，但语义照抄：面板 = 拦截现场，球 = 放行之后仍可回看的那一份）。
      const [ovOpen, setOvOpen] = React.useState(false)
      // 离场种类（2026-10-19）：完成发送 = 收束、跳过发送 = 放行、取消/收起 = 各自一套。
      // 面板据此换用不同的软体退场曲线（同一种语言，性格不同）。
      const [ovExitKind, setOvExitKind] = React.useState('sent')
      const [ovGeom, setOvGeom] = React.useState({ pos: null, size: { w: null, h: null } })
      const [ovBall, setOvBall] = React.useState(null)  // {visible, pos, sent, phase}
      const [ovLast, setOvLast] = React.useState(null)  // 最近一次**已终结**的拦截（0.5 球里存的那份 run）
      const ovLastRef = React.useRef(null)
      // 2026-10-19：输入栏那颗「本次注入」胶囊**已移除**——对话流里已有命令卡，
      // 两处展示同一份记录是重复噪音。注入记录的读取只保留对话流卡（按 id 查）。

      const rootRef = React.useRef(null)
      const holdRef = React.useRef(null)               // 去重要用 ref（同一个事件循环里 state 还没生效）
      // P11：**在飞请求的世代号**。跳过 / 取消 / 重新生成都会推进它，
      // 于是"已经作废的那次解释"回来时写不进界面（真机缺陷：跳过之后过一会儿又弹出优化结果）。
      const holdSeq = React.useRef(0)
      const abortRef = React.useRef(null)
      const canArmRef = React.useRef(false)
      const [catalog, reloadCatalog] = useOnce(React.useCallback(() => apiGet('/models'), []))
      // 帮助**预取**（2026-10-19）：点开时才发请求 ⇒ 弹层先空后满，视觉上就是"卡一下"。
      // 现在挂载时按当前语言取一次（很小），点开即有内容；换语言时再取一次。
      // **把当前界面语言带上去**（用户 2026-09-22："英文 UI 适配应与 dsh 的语言对应"）：
      // 语言只有一个来源 —— DSH 的「语言」设置（见 detectLocale / ctx.locale），插件里没有自己的语言开关。
      const [help] = useOnce(React.useCallback(
        () => apiGet('/help?lang=' + (LOCALE === 'en' ? 'en' : 'zh')),
        [LOCALE]))

      const data = status.data
      const s = (data && data.settings) || {}
      // 预设提示改版（2026-10-19 用户最终口径）：**不再判断预设**。
      // 只要切换会话（或刚打开 DSH）就提示一次——它的目的只是告诉新用户有这个特性；
      // 觉得烦就点「以后不再显示」，写进设置后永久闭嘴。每个会话在本次运行里只提示一次。
      React.useEffect(() => {
        if (!sessionId || PRESET_NOTICE_SHOWN) return
        // 点过「以后不再显示」⇒ 直接标记，之后连判断都不做
        if (s && s.presetNoticeDismissed === true) { PRESET_NOTICE_SHOWN = true; return }
        if (!data) return // 首帧快照未到：等待真实设置，既不抢先弹也不提前标记为已提示
        PRESET_NOTICE_SHOWN = true
        setNotice({ preset: '', intro: true })
      }, [sessionId, data, s && s.presetNoticeDismissed])
      // 第二个触发（2026-10-19 用户）：**在新会话里把预设切到非 PTC/Wish** 时也要弹。
      // 只认"预设真的变了"（宿主返回的 presetAt 变化），挂载/首帧不弹，避免又变成乱弹。
      React.useEffect(() => {
        if (!sessionId) return undefined
        let stopped = false
        const seen = { armed: false, at: null }
        const tick = () => {
          apiGet('/preset?via=watch&light=1&session=' + encodeURIComponent(sessionId)).then((r) => {
            if (stopped || !r || r.ok !== true) return
            const at = r.presetAt || null
            if (!seen.armed) { seen.armed = true; seen.at = at; return }
            if (!at || at === seen.at) return
            seen.at = at
            if (r.notice && !(s && s.presetNoticeDismissed === true)) setNotice(r.notice)
          }).catch(() => {})
        }
        tick()
        // 用户 2026-10-19：切预设后要快——0.5s 一次（探针很轻：带 light=1，宿主不再做会话 inspect）
        const timer = setInterval(tick, 500)
        return () => { stopped = true; clearInterval(timer) }
      }, [sessionId, s && s.presetNoticeDismissed])
      const d = (data && data.described) || null
      // ⚠ 0.7.7 会话级档位：`sessionEffective/sessionDescribed` 是**本会话生效**的值
      //   （全局 + 该会话覆盖的合并结果）。没有就回退全局，行为与改动前一致。
      const eff = (data && data.sessionEffective) || s
      const effD = (data && data.sessionDescribed) || d
      const tier = (effD && typeof effD.tier === 'string') ? effD.tier : tierOfSettings(eff)
      // 把档位补丁写进【本会话的覆盖】：只动这个会话，全局默认保持原样。
      // 形状与 settings.js 的 bySession 一致；越界键（bash/model 等）会被后端丢弃并记问题，
      // 所以这里只传档位四件套。
      const withSession = (patch) => ({
        ...((s.bySession && typeof s.bySession === 'object') ? s.bySession : {}),
        [sessionId]: { ...(((s.bySession && typeof s.bySession === 'object') ? s.bySession[sessionId] : null) || {}), ...patch },
      })
      // 协作基调（0.7.8）：会话覆盖优先，其次全局，默认 neutral。
      // 与档位**正交**——可以「轻度 + 硬邦邦」，也可以「重度 + 普通」。
      const framing = (eff && (eff.framing === 'hard' || eff.framing === 'neutral')) ? eff.framing : 'neutral'
      // 点档位 = 整份替换该会话覆盖（避免带上陈旧展开值），但**必须保留已选的协作基调**：
      // 基调与档位是两件事，换档位不该把基调一起抹掉。
      const replaceTier = (t) => {
        const all = (s.bySession && typeof s.bySession === 'object') ? s.bySession : {}
        const prev = all[sessionId] || {}
        const keep = (prev.framing === 'hard' || prev.framing === 'neutral') ? { framing: prev.framing } : {}
        for(const key of ['reasoningBoost','reasoningMode','reasoningCandidates','reasoningRounds','reasoningPace','englishMode'])if(prev[key]!==undefined)keep[key]=prev[key]
        return { ...all, [sessionId]: { ...keep, tier: t } }
      }
      const tierOff = tier === 'off',englishOn=eff.englishMode===true,reasoningOn=eff.reasoningBoost===true
      // 关闭档 ⇒ **界面也要清干净**（真机 2026-09-22：拨到关闭档后，上一轮的优化上下文还在被注入）。
      // 宿主侧已按政策硬短路 + 清掉缓存里的包；客户端这边同步撤掉拦截浮层与进度，
      // 否则"关了档，屏幕上还挂着上一轮的包"看起来就像它还在工作（用户看到的正是这个）。
      React.useEffect(() => {
        if (!tierOff||englishOn) return
        setHold(null)
        setProg(null)
        setOvOpen(false)
      }, [tierOff, englishOn,sessionId])
      const permission = s.permission === 'review' ? 'review' : 'auto'
      const historyMode = s.historyMode === 'full' ? 'full' : 'turns'
      const turns = Number.isInteger(s.turns) ? s.turns : DEFAULT_TURNS
      const rtKnown = !!(data && (hasOwn(s, 'readTools') || hasOwn(d, 'readTools')))
      const readTools = rtKnown ? !!(hasOwn(s, 'readTools') ? s.readTools : d.readTools) : false
      // 内置 Bash（0.7.1）：与 readTools 同款三态纪律 —— 第一次 /status 读到它之前不发这个字段，
      // 避免"没读到就当关"把用户的设置误写回去。
      const bashKnown = !!(data && (hasOwn(s, 'bash') || hasOwn(d, 'bash')))
      const bashOn = bashKnown ? !!(hasOwn(s, 'bash') ? s.bash : d.bash) : true
      // 双击 Enter 跳过本轮优化（2026-10-19，**默认开**）。与 bash 同款三态：没读到就是关（不发这个字段），
      // 但**不发**这个字段，免得把"没读到"写成"用户选了关"。
      const desKnown = !!(data && (hasOwn(s, 'doubleEnterSkip') || hasOwn(d, 'doubleEnterSkip')))
      const doubleEnterSkip = desKnown ? !!(hasOwn(s, 'doubleEnterSkip') ? s.doubleEnterSkip : d.doubleEnterSkip) : false
      const desRef = React.useRef(false)
      desRef.current = doubleEnterSkip
      const enterAtRef = React.useRef(0)   // 上一次被拦截的 Enter 时间（双击判定用）

      const save = async (patch) => {
        setBusy(true); setMsg(null)
        const r = await apiPost('/settings', patch)      // apiPost 保证不抛：网络失败也是 {ok:false,reason}
        setBusy(false)
        if (!r || r.ok !== true) {
          setMsg({ kind: 'err', text: L('保存失败：', 'Save failed: ') + reasonText(r && r.reason) })
          setFailTick((t) => t + 1)                     // 让乐观显示的控件退回真值
          refreshStatus()
          return
        }
        const probs = (r.problems || []).filter((x) => x.kind !== 'unknown-field')
        setMsg(probs.length
          ? { kind: 'warn', text: L('已保存，但有 ' + probs.length + ' 项被按默认处理', 'Saved, but ' + probs.length + ' value(s) fell back to defaults') + staleSchemaHint(r.problems) }
          : { kind: 'ok', text: L('已保存', 'Saved') })
        refreshStatus()                                 // 成功后重新拉一次，界面与后端一致
      }

      // ── P11 前置拦截的运行时（放行 / 失败兜底 / 去重）──────────────────
      // 三条不变量：
      //   ① **拦下就一定要放行**（成功、失败、被跳过、用户点"按原文发出"都算）——绝不让消息凭空消失；
      //   ② **拿不到 `inputActions` 就绝不拦截**（`canArm` 为 false 时监听器根本不挂）；
      //   ③ 同一次发送可能同时命中 Enter 与 click（0.5 的 `coalesced`）⇒ 用 ref 去重，不能靠 state。
      const permissionRef = React.useRef(permission)
      permissionRef.current = permission
      // 当前"哪个会话正挂在这个面板上"：切走之后回来的结果不能写进别人的会话
      const liveSidRef = React.useRef(sessionId)
      liveSidRef.current = sessionId
      const englishRef=React.useRef(englishOn)
      englishRef.current=englishOn
      const canArm = !!(inputActions && typeof inputActions.submit === 'function' && sessionId)
      canArmRef.current = canArm
      // 斜杠命令放行（0.8）：名单来自设置，但**只有宿主确认该命令当前已注册**才会出现在 active 里。
      // 拿不到清单、没列、没注册 ⇒ 一律交还宿主（旧行为）——我们不认识这条命令，就绝不接管它。
      const slashActive = (() => {
        const rows = (data && data.slashReview && Array.isArray(data.slashReview.active)) ? data.slashReview.active : []
        return new Set(rows.map((n) => String(n).toLowerCase()))
      })()
      const slashNameOf = (t) => {
        const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(\s|$)/.exec(String(t == null ? '' : t))
        return m ? m[1].toLowerCase() : null
      }
      const slashAllowedDraft = (t) => slashReviewAllowed([...slashActive], t)

      const clearHoldSoon = () => { window.setTimeout(() => { holdRef.current = null; setHold(null) }, 1600) }
      /** 放行：**先把拦下的那条原话写回草稿**，再交给宿主的 submit。
       *  为什么"总是写一遍"（而不是仅在 DOM 与状态不一致时）：拦下的字是从 **DOM** 读的，
       *  而 submit 发的是**宿主状态**里的草稿——两者可能不同步（真机探针实测：headless 下
       *  `execCommand` 不生效、DOM 有字而状态没有）。放行的必须是**用户按下发送时的那一条**，
       *  所以这里无条件对齐一次（草稿本来就一样时，写回是幂等的）。 */
      const releaseHold = (text, h, mark) => {
        try {
          setOvExitKind(mark === 'skipped' ? 'skipped' : 'sent')
          // 名单内命令的守门（0.8）：审查浮层可以改内容，但**不允许把命令本身换掉**。
          // 换掉就不再是原命令了 ⇒ 退回用户按下发送时的那一条原话，交还宿主自行处理。
          let outgoing = text
          const held = h && typeof h.text === 'string' ? h.text : ''
          const heldName = slashNameOf(held)
          if (heldName && slashActive.has(heldName) && slashNameOf(outgoing) !== heldName) outgoing = held
          if (typeof inputActions.setDraft === 'function') inputActions.setDraft(outgoing)
          inputActions.submit()
          setHold({ ...(h || {}), phase: mark || 'sent' })
          clearHoldSoon()
        } catch (e) {
          // 连放行都失败 ⇒ 必须说出来（用户至少知道消息没发出去，可以手动再按一次）
          setHold({ ...(h || {}), phase: 'error', reason: L('放行失败：','Release failed: ') + String((e && e.message) || e) })
        }
      }
      /**
       * 失败时的收场（用户 2026-09-21 报的缺陷："即使处在审查模式，拦截后仍会在几秒后自动把原文发送出去"）。
       *
       * 两条路径必须分开：
       *   · **自动**：fail-open —— 按原文发出（0.5 auto 档的语义），并把原因留在面板上；
       *   · **审查**：**绝不自动发送**。把失败原因摆在面板里，由用户自己点「按原文发出」或「重试」。
       *     消息不会丢：草稿仍在输入框里（我们从头到尾没动它），面板就在旁边。
       */
      const settleFailure = (text, h, why) => {
        if (permissionRef.current === 'review') {
          const failed = { ...h, phase: 'error', reason: why }
          holdRef.current = failed; setHold(failed)          // 面板停在 error 态：重试 / 按原文发出
          return
        }
        // 解释失败后的 fail-open：这一轮没有注入（包没产出来），卡片不该给它作证
        releaseHold(text, { ...h, reason: why, injectCard: false }, 'sent')
      }

      const beginHold = (text, via) => {
        if (holdRef.current) return                        // 去重：同一次发送的第二条事件直接忽略
        // 拦截计数**放在去重之后**：同一次发送可能同时命中 Enter 与 click（0.5 也要处理这件事，
        // 见 0.5:443-453 的 `coalesced`）。放在事件处理函数里会让同一次发送**记两次**，
        // "本会话已拦截 N 次"就变成了一个虚高的数字——界面上的数字不允许这样。
        setInterceptCount((n) => n + 1)
        const my = ++holdSeq.current                        // 这一轮的世代号
        try { if (abortRef.current) abortRef.current.abort() } catch { /* 上一轮先断掉 */ }
        const ac = (typeof AbortController === 'function') ? new AbortController() : null
        abortRef.current = ac
        const startSid = sessionId                       // 这一轮属于哪个会话（切走也要认账）
        const h = { text, via,englishMode:englishOn, t0: Date.now(), phase: 'optimizing', packet: '', chars: 0, ms: null, reason: null }
        holdRef.current = h; setHold(h)
        apiPost('/interpret', { sessionId, text }, ac ? { signal: ac.signal } : undefined).then((r) => {
          if (my !== holdSeq.current) return                // ⚠ 过期世代：这一轮已被跳过/取消/重跑 ⇒ 结果丢弃
          if (!r || r.ok !== true) {
            settleFailure(text, h, reasonText((r && r.reason) || 'unknown'))
            return
          }
          if(englishRef.current!==h.englishMode){settleFailure(text,h,L('英文模式已改变，请重试或按原文发送','English mode changed; retry or send the original'));return}
          // P11 修复（2026-09-26）：token 用量挂在**结果**上。
          // 进度面（prog）在离开 optimizing 那一刻就被清空，用量若只存那里，界面永远读不到。
          // 用户已经切到别的会话：结果写回**发起那一轮**的桥，别写进当前会话；
          // 自动模式下也**不能**在这里提交（会把别的会话的草稿发出去）——回到该会话时再补发。
          if (startSid !== LAST_MOUNTED_SID) {
            holdBridgeWrite(startSid, { ...h, phase: 'review', outgoingText: r.outgoingText || text,
              done: true, pendingAuto: permissionRef.current !== 'review', englishMode: r.englishMode === true })
            return
          }
          const done = { ...h, phase: 'review', englishMode:r.englishMode===true,outgoingText:r.outgoingText||text,translation:r.translation||null,noAddition: r.noAddition === true, understanding: r.understanding || null, support: r.support || null, packet: r.packet || '', chars: r.chars || 0, ms: r.ms || null, unsourced: r.unsourced == null ? null : r.unsourced, route: r.route || null, edited: r.packet || '', usage: r.usage || null, usageTotal: (typeof r.usageTotal === 'number') ? r.usageTotal : null }
          holdRef.current = done; setHold(done)
          // 「自动」= 完成即发；「审查」= 等用户确认（0.5 §5 的权限语义）
          if (permissionRef.current !== 'review') releaseHold(outgoingUserText(done), done, 'sent')
        }, (e) => {
          if (my !== holdSeq.current) return
          settleFailure(text, h, reasonText((e && e.message) || e))
        })
      }

      /**
       * 「取消」（0.5 那颗 `‹ 回退` 真正干的事，用户 2026-09-21 指出我误解了它）：
       * **中止这一轮优化、什么都不发**，草稿留在输入框里等用户接着改。
       * 与「跳过并直接发送」的区别：跳过是"发，但不带包"；取消是"不发"。
       */
      const cancelHold = () => {
        setOvExitKind('cancel')
        holdSeq.current += 1                                  // 让在飞的那次结果作废
        try { if (abortRef.current) abortRef.current.abort() } catch { /* 断不掉也要作废世代 */ }
        abortRef.current = null
        setProg(null)                                         // 立刻收掉"还在跑"的观感（宿主侧同时会被中止）
        holdRef.current = null
        setHold(null)
        // 用户 2026-09-21 更正（我第一次改过头了）：取消**不要清空用户输入的原话**——
        // 他说的"不要留草稿"指的是**拦截态与那个隐藏弹窗的残留**，不是把用户打的字擦掉。
        // 所以这里只清拦截残留（hold / 在飞请求 / window 桥），输入框原样保留。
        try { const b = window.__PO06_HOLD__ || {}; if (sessionId) delete b[sessionId] } catch { /* 桥只是保险 */ }
        setMsg({ kind: 'warn', text: L('已取消这一轮优化：消息没有发出，你输入的原话仍在输入框里', 'Cancelled: nothing was sent; your text is still in the box') })
      }
      /** 回退（用户 2026-09-21 要求）：把上一版注入的包放回来，并把新正文读回界面。
       *  没有历史时**如实说没有**（不假装成功）；回退本身由宿主记账（`trigger:'packet-rollback'`）。 */
      const rollbackHold = async () => {
        const h = holdRef.current || hold
        const r = await apiPost('/rollback', { kind: 'packet', sessionId })
        if (!r || r.ok !== true) {
          setHold({ ...(h || {}), reason: L('回退失败：', 'Rollback failed: ') + reasonText(r && r.reason) })
          return
        }
        let text = ''
        try {
          const g = await apiGet('/packet?session=' + encodeURIComponent(sessionId))
          if (g && typeof g.packet === 'string') text = g.packet
        } catch { /* 读不回来就保持原正文，并在下面说明 */ }
        const next = {
          ...(h || {}), packet: text, edited: text, chars: text.length,
          reason: L('已回退到上一版包（还剩 ' + (r.remaining == null ? '?' : r.remaining) + ' 版可退）',
            'Rolled back to the previous packet (' + (r.remaining == null ? '?' : r.remaining) + ' more available)'),
        }
        holdRef.current = next; setHold(next)
      }

      const skipHold = () => {
        const h = holdRef.current || hold || {}
        if (!h.text) { holdRef.current = null; setHold(null); setProg(null); return }
        holdSeq.current += 1                                 // ⚠ 跳过之后，在飞的那次解释结果必须作废
        try { if (abortRef.current) abortRef.current.abort() } catch { /* 同上 */ }
        abortRef.current = null
        setProg(null)                                        // 立刻收掉"还在跑"的观感（不再等下一次刷新）
        // 跳过 = 这一轮**没有注入**任何包 ⇒ 不留注入快照（否则卡片会替一次空注入作证）
        releaseHold(h.text, { ...h, phase: 'sent', injectCard: false }, 'skipped')
      }
      /** 审查确认：用户改过正文 ⇒ 先把改动写进"本轮注入的包"，再放行。 */
      const confirmHold = async () => {
        const h = holdRef.current || hold
        if (!h) return
        let submitted=h
        if(h.englishMode&&!englishRef.current)submitted={...h,englishMode:false,outgoingText:h.text}
        const edited = String(h.edited == null ? h.packet : h.edited)
        if (edited !== h.packet) {
          const r = await apiPost('/packet', { sessionId, text: edited })
          if (!r || r.ok !== true) {
            setHold({ ...h, phase: 'review', reason: L('改动没写进去：', 'Edit not applied: ') + reasonText(r && r.reason) })
            return
          }
          if(typeof r.packet==='string')submitted={...submitted,packet:r.packet,edited:r.packet,chars:r.chars}
        }
        releaseHold(outgoingUserText(submitted), { ...submitted, phase: 'sent' }, 'sent')
      }
      /** 「按原文发出」：清掉本轮包，再原样放行（用户明确不要这次的结果）。 */
      const sendOriginal = async () => {
        const h = holdRef.current || hold
        if (!h) return
        // ⚠ 清包**必须真的成功**才放行：失败还标 sent 就是「伪成功」——界面说按原文发了，
        //   而上一轮的包继续被注入（本项目最忌的那类失败）。与「确认提交」分支同一条纪律。
        const r = await apiPost('/packet', { sessionId, text: '' })
        if (!r || r.ok !== true) {
          setHold({ ...h, phase: 'review', reason: L('这一轮的包没能清掉：', 'Could not clear this round packet: ') + reasonText(r && r.reason) })
          return
        }
        // 「按原文发出」已经清掉了本轮包 ⇒ 没有注入，不留快照
        releaseHold(h.text, { ...h, phase: 'sent', injectCard: false }, 'sent')
      }
      const regenHold = () => {
        const h = holdRef.current || hold
        if (!h) return
        holdRef.current = null
        beginHold(h.text, 'regen')
      }

      // ── P11 浮层的两条时序（**只读 hold，绝不改拦截状态机**）────────────
      // ① 终结即留档：0.6 的 releaseHold 会在 1.6s 后把 hold 清空（clearHoldSoon），
      //    而 0.5 的结果在放行之后仍能在球里回看（foot-sent 的「已发送 · 仅供查看」）⇒ 自己留一份快照。
      React.useEffect(() => {
        if (!hold) return
        const done = hold.phase === 'sent' || hold.phase === 'skipped' || hold.phase === 'error' || hold.phase === 'failed'
        if (!done) return
        ovLastRef.current = hold
        setOvLast(hold)
      }, [hold])

      // ② 面板可见性 / 收成球，与 0.5 的两条时序一致：
      //    · 拦截开始、或进入需要人决策的阶段（审查 / 放行失败）⇒ 面板必须在
      //      （否则用户的消息被拦着、却没有任何界面可以把它放出去 = 吞消息）
      //    · hold 被清空（= 放行后 1.6s）⇒ 收成 46px 悬浮球（0.5:1287「发送后收成悬浮球」）
      React.useEffect(() => {
        if (hold) {
          setOvOpen(true)
          setOvBall((b) => (b && b.visible ? { ...b, visible: false } : b))
          return
        }
        const h = ovLastRef.current
        if (h && (h.phase === 'sent' || h.phase === 'skipped')) {
          setOvBall((b) => ({ visible: true, pos: (b && b.pos) || defaultBallPos(), sent: h.phase === 'sent', phase: h.phase }))
          setOvOpen(false)
        }
      }, [hold])

      /** 「重新生成」：活的 hold 交给既有 regenHold；已经终结（hold 已被清）的那份用既有 beginHold 重跑。 */
      const doRegen = () => {
        if (hold) { regenHold(); return }
        const h = ovLastRef.current
        if (h && h.text) beginHold(h.text, 'regen')
      }
      /** 收起为球（0.5:1473-1478 collapseToBall）。⚠ 与 0.5 有意不同的一处：0.5 在"没有产出"时
       *  连球都不留；这里只要**还有一次拦截挂着**就留球（优化中收起也有球，标着"优化中"），
       *  否则用户收起后就再也看不见"消息还被拦着"这件事（那是吞消息的隐患）。 */
      const collapseToBall = () => {
        setOvExitKind('collapse')
        const h = hold || ovLastRef.current
        setOvOpen(false)
        if (!h) { setOvBall(null); return }
        setOvBall((b) => ({
          visible: true, pos: (b && b.pos) || defaultBallPos(),
          sent: h.phase === 'sent' || h.phase === 'skipped', phase: h.phase,
        }))
      }
      /** 点球展开（0.5:1461-1472 reopenFromBall）：把那一份放回浮层，已发送态为只读。 */
      const reopenFromBall = () => {
        setOvOpen(true)
        setOvBall((b) => (b ? { ...b, visible: false } : b))
      }
      /** foot-sent 的「关闭」（0.5:1653 close-sent）：浮层与球一起收掉。 */
      const closeSent = () => { setOvOpen(false); setOvBall(null) }

      // 重挂（切会话来回）后把 holdRef 也接回桥上的那一份——否则界面显示了面板，逻辑却以为"没在拦"；
      // 并**订阅**后续变化（issue #19）：切走期间跑完的那一轮，回来要能看见它的结果。
      React.useEffect(() => {
        const saved = holdBridgeRead(sessionId)
        if (saved && !holdRef.current) holdRef.current = saved
        // 切走期间跑完、且是「自动」权限 ⇒ 回到这个会话时把这一轮补发出去（不许悄悄消失）
        if (saved && saved.pendingAuto === true && saved.phase === 'review') {
          const text = outgoingUserText(saved)
          const next = { ...saved, phase: 'sent', pendingAuto: false, sentAt: Date.now() }
          try { inputActions.setDraft(text); inputActions.submit() } catch { /* 发不出去也要留痕 */ }
          holdRef.current = next
          _setHold(next)
          holdBridgeWrite(sessionId, next)
          try { clearHoldSoon() } catch { /* 忽略 */ }
        }
        return holdBridgeOn(sessionId, (value) => {
          holdRef.current = value
          _setHold(value)
        })
      }, [sessionId])

      // 计时器：只在"优化中"时走（用户要看得见已经等了多久，因为**不设超时**）
      React.useEffect(() => {
        if (!hold || hold.phase !== 'optimizing') return undefined
        const t = window.setInterval(() => setTick((n) => n + 1), 1000)
        return () => window.clearInterval(t)
      }, [hold])

      // P11：**思考过程**也看得见（用户 2026-09-21："拦截之后看不到任何思考过程"）。
      // 解释层是宿主的模型调用，它的流式正文落在宿主的进度面里 ⇒ 这里轮询读回来，
      // 显示"阶段 + 正在写的字"。轮询只在优化中跑，结束即停（不打扰、不常驻）。
      React.useEffect(() => {
        // ⚠ 只在"优化中"轮询，但**不因为阶段变了就把快照清空**——否则解释一完成，
        // `Σ N tok` 与最后的思考内容会立刻消失（用户实测"token 还不会统计"的一部分原因就在这里）。
        // ⚠ 轮询要**持续到这一轮真正结束**（而不是"只有优化中"）：token/包字数是在解释**完成时**
        // 才写进进度面的；只在优化中轮询 ⇒ 最后那次写入永远拉不到，界面停在旧值
        // （用户实测"产出后 token 不变"）。现在只要还挂着这一轮就继续拉，面板收起才停。
        if (!hold || !sessionId) { setProg(null); return undefined }
        // ⚠ 用户按下「跳过 / 取消 / 按原文发出」之后**立刻停轮询并清掉进度面**——
        //   真机 2026-09-22："点击跳过并发送之后,优化居然还会持续一点时间才停止"。
        //   两件事同时做：① 宿主侧现在会真的中止（见 pipeline 的 abort 闸门 + control-api 的取消信号）；
        //   ② 界面这一侧**不再装作还在跑**：阶段一旦不是 optimizing，就不再拉、也不留残留进度。
        // P11 修复（2026-09-26）：**这一行曾经与上面的注释相反**，正是用量读不出来的最后一环。
        // 用量是在解释**完成那一刻**才写进进度面的；原先阶段一变成 review 就停止轮询并清空，
        // 于是最后那次写入永远拉不到 ⇒ 界面恒显示占位符。
        // 现在：只要这一轮还挂着（optimizing 或 review）就继续拉；真正结束（发出/放弃）才停。
        if (hold.phase !== 'optimizing' && hold.phase !== 'review') {
          // 收尾时把**最后拿到的用量钉在结果上**——离开进度面之后，界面从这里读数字。
          const u = (prog && prog.usage) ? prog.usage : null
          if (u && holdRef.current && !holdRef.current.usage) {
            const withUsage = { ...holdRef.current, usage: u }
            holdRef.current = withUsage; setHold(withUsage)
          }
          setProg(null); return undefined
        }
        let alive = true
        const pull = () => {
          apiGet('/interpret-progress?session=' + encodeURIComponent(sessionId)).then((p) => {
            if (alive) setProg(p && p.active ? p : null)
          }, () => { /* 进度读不到不影响拦截本身 */ })
        }
        pull()
        // 25ms：用户 2026-09-21 明确要求（"直接变成25ms吧，消耗不了多少性能"）。
        // 本地回环 + 负载很小（尾部 1200 字），换来的是思维链看起来像在连续打字。
        const t = window.setInterval(pull, 25)
        return () => { alive = false; window.clearInterval(t) }
      }, [hold, sessionId])

      // 拦截监听：**捕获阶段挂在 window 上**（早于 React 根容器与编辑器自身处理器；0.5:3095）
      React.useEffect(() => {
        if (!canArm || tierOff&&!englishOn || !data) return undefined       // 关闭档 / 状态未知 / 没有放行通道 ⇒ 完全不拦
        const sendLabels = new Set()
        const stopLabels = new Set()
        // 诊断：**监听器到底挂上没有 / 判定卡在哪一条**，都必须在真机上看得见。
        // 第一版只写了"拦截计数"，于是真机上次秒发现"消息照发、计数还是 0"却无从判断是哪一环——
        // 这里把"看见了几个事件"和"最后一次为什么放行"都暴露成标记（有事件而计数不动 = 判定问题，
        // 连事件都没有 = 监听器没挂上，两者的修法完全不同）。
        let seen = 0
        const markSeen = (why) => {
          seen += 1
          try {
            const el = rootRef.current
            if (el && el.setAttribute) { el.setAttribute('data-po06-seen', String(seen)); el.setAttribute('data-po06-lastpass', why) }
          } catch { /* 诊断不影响主流程 */ }
        }
        const loadLabels = () => {
          try {
            const bind = typeof LOCALE_BIND === 'function' ? LOCALE_BIND('conversation') : null
            if (!bind) return
            for (const k of SEND_KEYS) { const v = bind(k); if (typeof v === 'string' && v && v !== k) sendLabels.add(v) }
            const stop = bind('input.stop'); if (typeof stop === 'string' && stop && stop !== 'input.stop') stopLabels.add(stop)
          } catch { /* 字典不可用 ⇒ 点击路径走结构兜底 */ }
        }
        loadLabels()
        const draftNow = () => composerDraft(composerCard(rootRef.current)).trim()
        const wantKey = (e) => {
          if (!isActiveInstance()) return 'stale-instance'
          if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return 'not-plain-enter'
          if (e.isComposing === true || e.keyCode === 229) return 'composing'
          const card = composerCard(rootRef.current)
          if (!card) return 'no-card'
          if (!focusInComposer(card, e.target)) return 'focus-outside'
          const t = draftNow()
          if (!t) return 'empty-draft'
          // 斜杠命令默认交还官方；**只有名单内且已注册**的命令才继续走拦截（0.8）。
          // 英文模式**不改这条判据**：命令名会被翻译保护当作字面量保留；名单内命令照旧走拦截。
          if (t.startsWith('/') && !slashAllowedDraft(t)) return 'slash-command'
          return null
        }
        const wantClick = (btn) => {
          if (!isActiveInstance()) return 'stale-instance'
          if (!btn) return 'no-button'
          if (btn.closest && btn.closest('[data-po06]')) return 'our-own-button'   // 我们自己的按钮永不吞
          const card = composerCard(rootRef.current)
          if (!card) return 'no-card'
          if (!card.contains(btn)) return 'button-outside-card'
          if (!draftNow()) return 'empty-draft'                                    // 空草稿时主按钮是"停止生成"，绝不能吞
          const label = btn.getAttribute('aria-label')
          if (label && stopLabels.has(label)) return 'stop-button'
          return ((label && sendLabels.has(label)) || lastComposerButton(card) === btn) ? null : 'not-send-button'
        }
        const onKey = (e) => {
          const why = wantKey(e)
          if (why) { markSeen('key:' + why); return }
          e.preventDefault(); e.stopPropagation()
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation()
          markSeen('key:intercepted')
          // 双击 Enter 跳过（2026-10-19）：第一次 Enter 已拦下并开始解释；600ms 内的第二次
          // 表示"这轮别等了" ⇒ 放弃解释、按原文立即发出（与面板「跳过」同一语义，不发包、不出卡片）。
          const now = Date.now()
          const prevAt = enterAtRef.current
          enterAtRef.current = now
          const held = holdRef.current
          // 取证（2026-10-19）：双击这条路到底看到了什么相位 —— 真机上"审查态仍被跳过"必须能查
          try { apiPost('/client-log', { event: 'dbl-enter', sid: sessionId,
            detail: 'phase=' + String(held && held.phase) + ' des=' + String(desRef.current) }).catch(() => {}) } catch { /* 忽略 */ }
          if (desRef.current && prevAt && now - prevAt < 600 && held) {
            // 优化中：双击 = 跳过（按原文立即发）
            if (held.phase === 'optimizing') {
              markSeen('key:double-skip')
              skipHold()
              return
            }
            // **审查完成**：双击 = 确认发送（2026-10-19 用户要求）——不是跳过，
            // 因为它已经优化完了，此刻"跳过"没有意义，确认才是用户想要的下一步。
            if (held.phase === 'review') {
              markSeen('key:double-confirm')
              void confirmHold()
              return
            }
          }
          // 计数在 beginHold 里、去重之后加（同一次发送可能同时命中 Enter 与 click，见那里的注释）
          beginHold(draftNow(), 'key')
        }
        const onClick = (e) => {
          const btn = e.target && e.target.closest ? e.target.closest('button') : null
          const why = wantClick(btn)
          if (why) { markSeen('click:' + why); return }
          e.preventDefault(); e.stopPropagation()
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation()
          markSeen('click:intercepted')
          beginHold(draftNow(), 'click')
        }
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('click', onClick, true)
        return () => {
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('click', onClick, true)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [canArm, tierOff,englishOn, !!data, sessionId])

      // ── ② 模型清单（可能 35+ 项 ⇒ 用 <select>，**不要**平铺成一排按钮）
      const cat = (catalog.data && typeof catalog.data === 'object') ? catalog.data : {}
      const routes = Array.isArray(cat.models) ? cat.models.slice() : []
      const mkey = (r) => JSON.stringify([r.provider, r.model])
      const curKey = (s.model && typeof s.model === 'object') ? mkey(s.model) : 'inherit'
      if (s.model && typeof s.model === 'object' && !routes.some((r) => mkey(r) === curKey)) {
        // 当前值不在清单里也要显示出来，否则 select 会显示成第一项——那是界面在撒谎
        routes.push({ provider: s.model.provider, model: s.model.model, label: s.model.provider + ' / ' + s.model.model })
      }
      const groups = []
      for (const r of routes) {
        let g = groups.find((x) => x.provider === r.provider)
        if (!g) { g = { provider: r.provider, items: [] }; groups.push(g) }
        g.items.push(r)
      }
      // ── 思考档位的数据（0.7.5）──
      // 当前值与可选项都按**真正会被调用的那个模型**取：
      //   选了具体模型 ⇒ 就是它；「跟随会话模型」⇒ 先问 /session-model 拿会话模型再按它取。
      const [effortsForModel, setEffortsForModel] = React.useState([])
      const [effortTarget, setEffortTarget] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const resolve = async () => {
          if (curKey !== 'inherit') {
            const r = routes.find((x) => mkey(x) === curKey)
            if (alive) setEffortTarget(r ? { provider: r.provider, model: r.model } : null)
            return
          }
          if (!sessionId) { if (alive) setEffortTarget(null); return }
          try {
            const p = await apiGet('/session-model?session=' + encodeURIComponent(sessionId))
            if (alive) setEffortTarget((p && p.provider && p.model) ? { provider: p.provider, model: p.model } : null)
          } catch { if (alive) setEffortTarget(null) }
        }
        void resolve()
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [curKey, sessionId])
      // ⚠ 键格式**必须**是 "provider/model"：这是后端 normalizeSettings 的校验口径
      // （settings.js 的 pickEffortMap 要求键含 /），也是 wire.js 查表用的格式。
      // 之前这里写成 JSON.stringify([p, m]) ⇒ 每次保存都被判 not-a-route 丢弃并回默认，
      // 用户看到的就是"一选择就被覆盖"（2026-09-26 实测）。
      const effortKey = (effortTarget && effortTarget.provider && effortTarget.model)
        ? (effortTarget.provider + '/' + effortTarget.model) : null
      React.useEffect(() => {
        if (!effortKey) { setEffortsForModel([]); return undefined }
        let alive = true
        const t = String(effortKey).split('/')
        apiGet('/efforts?provider=' + encodeURIComponent(t[0]) + '&model=' + encodeURIComponent(t.slice(1).join('/')))
          .then((p) => { if (alive) setEffortsForModel((p && Array.isArray(p.efforts)) ? p.efforts : []) })
          .catch(() => { if (alive) setEffortsForModel([]) })
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [effortKey])
      /**
       * 思考档位行（0.7.5）：**只作用于当前选中的那个解释层模型**。
       * 选项取该模型自己那份划分——不同模型的档位名与档数本来就不同，
       * **绝不合并成一份共用列表**（用户 2026-09-26 要求）。
       * ⚠ 档位**不能**从模型列表里拿：宿主 listModels 是白名单返回，会把 reasoning 剥掉；
       * 所以选中模型后**单独查一次**（/po06/api/efforts，内部走宿主 resolveModelInfo）。
       * 「跟随会话模型」时不显示：会话模型是谁由宿主观测决定，此刻并不知道，
       * 与其猜一个档位，不如这一档此刻不由这里管。
       */
      const effortRow = (() => {
        const efforts = Array.isArray(effortsForModel) ? effortsForModel : []
        if (!effortKey) return null
        const map = (s.effortByModel && typeof s.effortByModel === 'object') ? s.effortByModel : {}
        const curEffort = (typeof map[effortKey] === 'string') ? map[effortKey] : ''
        const onPick = (v) => {
          const next = { ...map }
          if (v) next[effortKey] = v
          else delete next[effortKey]
          save({ effortByModel: next })
        }
        const effortLabels = { '': L('默认（不指定）', 'Default (unspecified)') }
        for (const e of efforts) effortLabels[e.id] = e.name || e.id
        const title = efforts.length
          ? L('只作用于这个解释层模型；下列档位就是它自己支持的那一套',
            'Applies only to this explainer model; the levels listed are its own')
          : L('该模型未暴露可选档位，将按服务端默认档运行',
            'This model exposes no selectable effort; the provider default applies')
        // ⚠ 没有可选档位时**不要再渲染一个能点的下拉**（2026-09-27 实测）：
        //   宿主对某些模型（如 top-api/gpt-6-astra）根本没登记 reasoning，resolveModelInfo 里没有
        //   `reasoning.efforts` ⇒ 这里 efforts = []。此前仍渲染出只有「默认（不指定）」的可点下拉，
        //   用户点它当然没反应，观感就是"档位点了不动"。真实原因只是**这个模型没有档位**。
        //   所以：禁用 + 就地写明原因（不能只放在 title 里——没人会去悬停）。
        const noEfforts = efforts.length === 0
        const sel = h(Options, {
          anchor: 'effort',
          value: curEffort,
          options: ['', ...efforts.map((e) => e.id)],
          labels: effortLabels,
          disabled: noEfforts,
          onChange: onPick,
        })
        return h('div', { style: S.optRow }, h('span', { style: S.optLabel }, L('思考档位', 'Thinking effort')),
          noEfforts
            ? h('span', { 'data-po06': 'effort-none', style: S.muted },
              L('该模型没有档位（宿主未登记 reasoning）', 'No levels for this model (host has no reasoning info)'))
            : sel)
      })()
      const modelProblems = Array.isArray(cat.problems) ? cat.problems : []

      // 单例闸门：不是当前实例就什么都不渲染（HMR 后旧实例必须闭嘴）。
      const active = isActiveInstance()
      if (!active) return null

      const on = !!(data && data.enabled && eff.assist !== 'off')
      const last = null
      // P11 浮层要显示的那一份：`ovOpen` 是唯一的开关（0.5 的 `store.overlay.open`）。
      // ⚠ 不能写成 `hold || …`——那样"收起为球"在优化中根本收不起来（hold 还活着，面板又冒出来）。
      // 展开由两条时序负责（见下面的 effect ②）：拦截开始/需要人决策 ⇒ 自动展开；
      // hold 被清掉之后面板还开着 ⇒ 显示最后那份快照（只读回看，0.5 的球展开就是这个语义）。
      const shown = ovOpen ? (hold || ovLast) : null

      // 2026-10-19：产品名与状态标签不再带 "0.6"（那是 0.6 时代的遗留前缀，版本号由 /status 单独显示）。
      const statusLabel = !data ? L('读取中', 'loading')
        : (data.enabled ? (on ? L('自动辅助', 'auto') : L('只记录', 'record')) : L('未启用', 'off'))
      const offTip = L('档位为「关闭」时不生效', 'Has no effect while the tier is Off')

      // 退场动效：面板 / 帮助 / 提示弹窗 / 拦截浮层，关闭时先播 160ms 收起动画再卸载
      const panelExit = useExit(open, 160)   // 「详情」面板：关闭也要有收起动画
      const optExit = useExit(optOpen, 160)
      const helpExit = useExit(helpOpen, 140)
      const noticeExit = useExit(!!notice, 170)
      const noticeShown = useLast(notice)
      const ovExit = useExit(!!shown, 240)   // 与拦截面板的果冻退场（错峰 48ms + 160ms）对齐
      const ovShown = useLast(shown)

      return h(React.Fragment, null,
        // 控件栏分两层：第一行放"设定类"，第二行放"范围类"。
        // 外层靠上对齐（**不要**用 alignSelf:'flex-end'，那会被输入区的发送按钮顶上去、底部留空）。
        h('div', { ...themeAttrs(), 'data-po06': 'bar', ref: rootRef,
          // 拦截能不能武装，取决于宿主有没有给 `inputActions`——把它做成**真机可读的标记**，
          // 免得"以为在拦、其实没拦"（本项目的头号失败形态）。
          'data-po06-actions': canArm ? '1' : '0',
          'data-po06-intercepts': String(interceptCount),
          // 正在拦截 ⇒ 状态灯呼吸（见注入样式里那条 `[data-po06="bar"][data-po06-busy="1"]` 规则）。
          // 灯在**控件栏**里（不在浮层里），所以要在这里给标记，否则那条动效永远不会命中。
          'data-po06-busy': hold ? '1' : '0',
          style: { ...S.bar, flexDirection: 'column', gap: '4px', alignItems: 'flex-start' } },
          // ── 第一行「设定类」：档位 / 优化权限 / 模型 ──────────────────────
          h('div', { 'data-po06': 'bar-row-1', style: S.barRow },
            // ① **唯一入口**：图标 + 「优化选项」+ 状态摘要（用户 2026-09-22：把档位这些收进一个按钮里）
            //    摘要让"不打开也知道现在是什么档"；真正的控件在下面那个弹出面板里（同一个按钮开关）。
            h('button', {
              type: 'button', 'data-po06': 'options-btn', 'data-po06-open': optOpen ? '1' : '0',
              ref: optBtnRef,
              style: { ...S.optBtn, ...(optOpen ? S.optBtnOn : null) },
              title: L('优化选项：档位 / 权限 / 模型 / 上下文 / 只读工具（点开）· build ' + CLIENT_BUILD,
                'Options: tier / permission / model / context / read-only tools (click) · build ' + CLIENT_BUILD),
              'aria-expanded': optOpen ? 'true' : 'false',
              // ⚠ 面板用 **fixed** 定位并按按钮实测坐标摆位：输入卡片可能有 overflow 裁剪，
              //   用 absolute 会被裁掉（`?` 的弹层当年就是因此改成 fixed 的，见 S.helpPop）。
              onClick: () => {
                const r = optBtnRef.current && optBtnRef.current.getBoundingClientRect
                  ? optBtnRef.current.getBoundingClientRect() : null
                if (r) {
                  const vw = (typeof window !== 'undefined' && window.innerWidth) || 800
                  const rg = composerRegion(optBtnRef.current)
                  const popW = Math.min(300, Math.max(200, rg.w - 16))
                  const vh = (typeof window !== 'undefined' && window.innerHeight) || 600
                  // 边界自适应：上下两侧都量，选空间大的那侧，maxH 取该侧可用高度。
                  // 面板再配合密度档（见 optDensity）做"自动挤压"：先挤间距/行高，挤不下才内部滚动。
                  // 两侧各留 64px 呼吸空间（用户 2026-10-19：留多点）：挤压/滚动都以这条边界为准
                  const spaceAbove = Math.round(r.top - 64)
                  const spaceBelow = Math.round(vh - r.bottom - 64)
                  const place = (spaceAbove >= 340 || spaceAbove >= spaceBelow) ? 'above' : 'below'
                  const side = place === 'above' ? spaceAbove : spaceBelow
                  setOptPos({
                    // 右缘收在会话窗内（侧栏打开时弹层跟着会话列一起左移/变窄）
                    left: Math.min(Math.max(rg.left + 8, Math.round(r.left)), Math.max(rg.left + 8, rg.right - popW - 8)),
                    place,
                    ...(place === 'above'
                      ? { bottom: Math.max(8, Math.round(vh - r.top + 6)) }
                      : { top: Math.round(r.bottom + 6) }),
                    width: popW,
                    maxH: Math.max(140, side),
                  })
                }
                setOptOpen((v) => !v)
              },
            },
              h(OptIcon),
              h('span', { style: S.optBtnText }, L('优化选项', 'Options')),
              h('span', { 'data-po06': 'options-summary', style: S.optSummary },
                tierLabel(tier) + ' · ' + (permission === 'review' ? L('审查', 'Review') : L('自动', 'Auto'))
                  + (rtKnown && readTools ? ' · ' + L('工具开', 'tools on') : '')),
              h('span', { 'aria-hidden': 'true', style: S.optCaret }, optOpen ? '▴' : '▾'),
            ),
            // 2026-10-19：输入栏的「本次注入」胶囊已移除（对话流里有卡片，重复）。
            // ② 「?」帮助（0.5 的形态：文字就是一个 ASCII `?`）；正文见 HELP-0.6.md（要求②）
            h('button', {
              type: 'button', 'data-po06': 'help-btn', 'data-po06-open': helpOpen ? '1' : '0',
              style: { ...S.small, ...(helpOpen ? S.segOn : null) },
              title: L('使用帮助（怎么用 / 档位 / 权限 / 推荐组合）', 'Help (how to use / tier / permission / recommended combos)'),
              onClick: () => setHelpOpen((v) => !v),
            }, '?'),
            catalog.error ? h('span', { 'data-po06': 'model-error', style: { ...S.muted, color: T('warn') } },
              L('模型列表读不到：', 'Model list unavailable: ') + errorText(catalog.error)) : null,
            catalog.error ? h('button', {
              type: 'button', 'data-po06': 'model-retry', style: S.small,
              title: L('重新读一次模型列表', 'Read the model list again'),
              onClick: () => reloadCatalog(),
            }, L('重试', 'Retry')) : null,
            !catalog.error && modelProblems.length ? h('span', { 'data-po06': 'model-hint', style: S.muted },
              L(modelProblems.length + ' 个模型不可用', modelProblems.length + ' model(s) unavailable')) : null,
            busy ? h('span', { 'data-po06': 'busy', style: S.muted }, L('保存中…', 'Saving…')) : null,
            msg && msg.kind === 'err' ? h('span', { 'data-po06': 'error', style: { ...S.muted, color: T('err') } }, msg.text) : null,
            msg && msg.kind !== 'err' ? h('span', { 'data-po06': 'saved', style: { ...S.muted, color: msg.kind === 'warn' ? T('warn') : T('ok') } }, msg.text) : null,
          ),
          // 2026-10-19：原来这里还有一块"本次注入"的展开面板；随胶囊一起移除（对话流卡片已覆盖）。
          // ── 第二行 = **弹出面板**（点「优化选项」才展开）：设定类 + 范围类都收在这里 ──────
          //    只有打开时才渲染 ⇒ 关闭时控件栏就是**一行**（用户要的"更简洁"）。
          optExit.mounted ? h('div', { 'data-po06': 'bar-row-2', style: { position: 'relative' } },
            h('div', { ...themeAttrs(), 'data-po06': 'options-pop', 'data-po06-build': CLIENT_BUILD, 'data-po06-closing': optExit.closing ? '1' : '0',
              // ⚠ 坐标**必须真的用上**：`S.optPop` 是 `position: fixed`，而 fixed 元素在没给
              //   `left/top/bottom` 时会退回到"流里的位置"——实测就是**看不见任何弹窗**
              //   （用户 2026-09-22："点击优化选项没有任何弹窗出现"）。
              //   所以这里把按钮实测坐标铺上去，并在量不到时退回 `?` 弹层用的那套固定落点。
              // issue #18：宽度按会话窗收（打开侧栏 ⇒ 会话列变窄 ⇒ 弹层跟着窄），右缘不越界。
              'data-po06-density': String(optDensity),
              ref: optRef,
              style: { ...S.optPop, ...(optPos
                ? { left: optPos.left + 'px',
                    ...(optPos.place === 'below' ? { top: optPos.top + 'px' } : { bottom: optPos.bottom + 'px' }),
                    ...(optPos.width ? { width: optPos.width + 'px' } : null),
                    ...(optPos.maxH ? { maxHeight: optPos.maxH + 'px' } : null) }
                : { left: '16px', bottom: '84px', ...(region ? { width: Math.min(300, Math.max(120, region.w - 16)) + 'px' } : null) }) } },
              h('div', { style: S.optPopHead }, h(OptIcon), h('span', {}, L('优化选项', 'Options'))),
              // ① 档位（从第一行搬来；分段控件本身没变）
              h('div', { style: S.optRow }, h('span', { style: S.optLabel }, L('档位', 'Tier')),
                h(Segmented, {
                  name: 'tier', value: tier, options: TIER_KEYS, label: (k) => tierLabel(k), failTick,
                  title: L('优化档位：关闭 / 轻度 / 标准 / 重度 —— 点击、按住拖动、或按 ←→ 方向键（Home/End 到两端）',
                    'Optimizer tier: Off / Low / High / Ultra — click, drag, or press the ←→ arrow keys (Home/End for the ends)'),
                  // ⚠ 点档位 = **整份替换**该会话的覆盖，不能与旧覆盖合并：
                  //   合并会把上一次的 assist/detail/budget 残留带进来，读取时它们会盖过新预设，
                  //   表现为"点了档位但档位不变"（用户实测 2026-09-27）。
                  onPick: (v) => save({ bySession: replaceTier(v) }),
                })),
              // advisor 是全局键（不在 SESSION_KEYS 里）⇒ 必须写全局，否则补丁被丢弃、界面看起来"点了没反应"
              h(AdvisorControls,{settings:{...eff,advisor:s.advisor},save:patch=>save(patch),ready:true,busy,failTick}),
              h(EnglishControls,{settings:eff,save:patch=>save({bySession:withSession(patch)}),ready:data?.english?.ready===true,busy,failTick}),
              // ①b 协作基调（0.7.8）：与档位正交，按会话存。语域本身就是效果来源（见 framing.js）。
              h('div', { style: S.optRow }, h('span', { style: S.optLabel }, L('协作基调', 'Tone')),
                h(Segmented, {
                  name: 'framing', value: framing, options: ['neutral', 'hard'], failTick,
                  label: (k) => (k === 'hard' ? L('硬邦邦', 'Hard') : L('普通', 'Plain')),
                  title: L('硬邦邦：用更直接、更来劲的语气推动执行（不改你的原话，也不放松「不替你拍板」的边界）',
                    'Hard: a blunter, more driven register (your words stay unchanged and decision boundaries stay intact)'),
                  onPick: (v) => save({ bySession: withSession({ framing: v }) }),
                })),
              // ② 优化权限：档位 off 时禁用
              h('div', { style: S.optRow }, h('span', { style: S.optLabel }, L('权限', 'Permission')),
                h(Segmented, {
                  name: 'perm', value: permission, options: ['review', 'auto'],
                  label: (k) => (k === 'review' ? L('审查', 'Review') : L('自动', 'Auto')),
                  disabled: tierOff&&!englishOn, failTick,
                  title: tierOff&&!englishOn
                    ? L('优化权限：审查 / 自动 —— ' + offTip, 'Permission: Review / Auto — ' + offTip)
                    : L('优化权限：审查 = 先给出处与依据待你确认；自动 = 直接生效',
                      'Permission: Review = show sources and rationale for confirmation first; Auto = apply directly'),
                  onPick: (v) => save({ permission: v }),
                })),
              // ③ 模型：下拉（跟随会话模型 = null）
              h('div', { style: S.optRow }, h('span', { style: S.optLabel }, L('模型', 'Model')),
                // 2026-10-19：原生 select 换成自绘下拉（系统面板和插件设计语言不搭）
                h(Options, {
                  anchor: 'model',
                  value: curKey,
                  options: ['inherit', ...routes.map(mkey)],
                  labels: (() => {
                    const m = { inherit: L('跟随会话模型', 'Follow session model') }
                    routes.forEach((r) => { m[mkey(r)] = r.label || (r.provider + ' / ' + r.model) })
                    return m
                  })(),
                  onChange: (v) => {
                    if (v === 'inherit') { save({ model: null }); return }
                    const r = routes.find((x) => mkey(x) === v)
                    if (r) save({ model: { provider: r.provider, model: r.model } })
                  },
                })),
              effortRow,            // ④⑤⑥ 范围类：上下文 / 只读工具 / 详情 —— 沿用原来的控件，只是现在住在面板里
            // ③ 上下文（2026-10-19 重做）：模式用分段控件；回合数用自绘滑杆
            h('div', { 'data-po06': 'ctx-wrap', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('div', { style: S.optRow },
                h('span', { style: S.optLabel }, L('上下文', 'Context')),
                h(Segmented, {
                  name: 'ctx-mode', value: historyMode, options: ['turns', 'full'], disabled: tierOff,
                  label: (k) => (k === 'full' ? L('全文', 'Full') : L('回合', 'Turns')),
                  title: tierOff
                    ? L('上下文模式：回合 / 全文 —— ' + offTip, 'Context mode: Turns / Full — ' + offTip)
                    : L('上下文模式：回合 = 只读最近几回合；全文 = 与工作 AI 看到的一致',
                      'Context mode: Turns = only the last few turns; Full = the same as the working AI sees'),
                  onPick: (v) => { if (tierOff) return; save({ historyMode: v }) },
                })),
              historyMode === 'full'
                ? h('div', { 'data-po06': 'ctx-hint', style: { ...S.muted, paddingLeft: '2px' } },
                  L('读入我手上保留的全部回合', 'Read every turn still held'))
                : h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', paddingLeft: '2px' } },
                  h(TurnsRange, {
                    value: turns, disabled: tierOff, failTick,
                    disabledTip: L('上下文：' + offTip, 'Context: ' + offTip),
                    title: L('上下文：只读最近几回合（0–10），拖动滑杆或按方向键调整',
                      'Context: read only the last N turns (0–10); drag the slider or use arrow keys'),
                    onCommit: (n) => save({ turns: n }),
                  }),
                  h('span', { 'data-po06': 'ctx-num', style: { flex: '0 0 auto', padding: '1px 8px', borderRadius: '999px',
                    background: OVS.acc12, border: '1px solid ' + OVS.acc22, color: OVS.acc, fontSize: '11.5px', fontWeight: 650,
                    fontVariantNumeric: 'tabular-nums' } },
                    String(turns) + L(' 回合', ' turns')))),
            h('div', { style: S.divider }),
            // ⑤ 读项目文件：**永远可用**（不受档位影响）；三态纪律见上面的注释
            h('button', {
              type: 'button', 'data-po06': 'readtools',
              'data-po06-value': rtKnown ? (readTools ? 'on' : 'off') : 'unknown',
              style: { ...S.optRowBtn, ...(rtKnown ? null : { opacity: .6 }) },
              title: rtKnown
                ? L('读项目文件：每轮先看几个项目文件再写要求（会多花时间与 token）',
                  'Read project files: read a few project files before writing requirements (costs time and tokens)')
                : L('读项目文件：还没读到当前设置，这次不会发送这个字段',
                  'Read project files: the current setting has not been read yet, so this field will not be sent'),
              onClick: () => {
                if (!rtKnown) {
                  setMsg({ kind: 'warn', text: L('还没读到当前设置，这次没有发送', 'Current setting not read yet; nothing was sent') })
                  return
                }
                save({ readTools: !readTools })
              },
            },
              h('span', {}, L('只读工具', 'Read-only tools')),
              h('span', { style: S.optVal(rtKnown && readTools) }, rtKnown ? (readTools ? L('开', 'On') : L('关', 'Off')) : L('…', '…'))),
            // ⑤b 内置 Bash（0.7.1）：它随本插件装配即提供（无需另装插件）。
            // 与"只读工具"的区别：那个决定 po06 自己派不派**只读轮次**，这个决定一台**真正的 shell**
            // 是否交到模型手里 —— 所以关掉时是**不注册该工具**（模型看不到），而不是注册了再拒绝执行。
            h('button', {
              type: 'button', 'data-po06': 'bash',
              'data-po06-value': bashKnown ? (bashOn ? 'on' : 'off') : 'unknown',
              style: { ...S.optRowBtn, ...(bashKnown ? null : { opacity: .6 }) },
              title: bashKnown
                ? (bashOn
                  ? L('内置 Bash：已交给模型 —— 它可以直接跑命令（可随时关掉）',
                    'Built-in Bash: available to the model — it can run commands (turn off anytime)')
                  : L('内置 Bash：已关闭 —— 模型看不到 bash 工具',
                    'Built-in Bash: off — the model cannot see the bash tool'))
                : L('内置 Bash：还没读到当前设置，这次不会发送这个字段',
                  'Built-in Bash: current setting not read yet; this field will not be sent'),
              onClick: () => {
                if (!bashKnown) {
                  setMsg({ kind: 'warn', text: L('还没读到当前设置，这次没有发送', 'Current setting not read yet; nothing was sent') })
                  return
                }
                save({ bash: !bashOn })
              },
            },
              h('span', {}, L('内置 Bash', 'Built-in Bash')),
              h('span', { style: S.optVal(bashKnown && bashOn) }, bashKnown ? (bashOn ? L('开', 'On') : L('关', 'Off')) : L('…', '…'))),
            // ⑤c 双击 Enter 跳过本轮优化（2026-10-19 用户要求，放在 Bash 与详情之间）。
            // 语义与面板上的「跳过」一致：不发包、直接按原文发出；只是省掉一次点击。
            h('button', {
              type: 'button', 'data-po06': 'double-enter',
              'data-po06-value': desKnown ? (doubleEnterSkip ? 'on' : 'off') : 'unknown',
              style: { ...S.optRowBtn, ...(desKnown ? null : { opacity: .6 }) },
              title: desKnown
                ? (doubleEnterSkip
                  ? L('双击 Enter 跳过：开着 —— 600ms 内再按一次回车，本轮不再等优化，按原文立即发出',
                    'Double Enter skip: on — press Enter twice within 600ms to send the original immediately')
                  : L('双击 Enter 跳过：关 —— 每次发送都会先跑优化',
                    'Double Enter skip: off — every send runs the optimizer first'))
                : L('双击 Enter 跳过：还没读到当前设置，这次不会发送这个字段',
                  'Double Enter skip: current setting not read yet; this field will not be sent'),
              onClick: () => {
                if (!desKnown) {
                  setMsg({ kind: 'warn', text: L('还没读到当前设置，这次没有发送', 'Current setting not read yet; nothing was sent') })
                  return
                }
                save({ doubleEnterSkip: !doubleEnterSkip })
              },
            },
              h('span', {}, L('双击 Enter 跳过', 'Double Enter skip')),
              h('span', { style: S.optVal(desKnown && doubleEnterSkip) }, desKnown ? (doubleEnterSkip ? L('开', 'On') : L('关', 'Off')) : L('…', '…'))),
            h('div', { style: S.divider }),
            // 详情入口（用户 2026-09-21 要求：文字直接叫「详情」，**保留灰绿状态灯**；
            // 面板里不再重复"它在替我做什么 / 最近几轮"——拦截界面已经让人看见模型替我们做了什么）
            h('button', {
              type: 'button', 'data-po06': 'detail', 'data-po06-open': open ? '1' : '0',
              // 状态灯的颜色语义不变，只是不再靠按钮文字去承载：title 里说清现在是什么状态
              style: { ...S.optRowBtn },
              title: L('详情：控制 / 解释层提示词（当前状态：' + statusLabel + '）', 'Details: controls / explainer prompt (state: ' + statusLabel + ')'),
              onClick: () => setOpen((v) => !v),
            },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
                h('span', { 'data-po06': 'state-dot', 'data-po06-value': statusLabel, style: S.dot(on) }),
                h('span', {}, L('详情', 'Details'))),
              h('span', { 'aria-hidden': 'true', style: { color: OVS.fg3 } }, open ? '▾' : '›'),
            ),
            // 2026-10-18 用户指定：隐藏实验性功能（「快速增强」= 固定 3+3 循环推理/择优）。
            // 判定不变：它成倍增加调用与等待，且没有可复现的提升证据。代码保留，入口不再渲染。Tick}),
            ),
          ) : null,
        ),
        !data && status.error ? h('span', { 'data-po06': 'status-error', style: { ...S.muted, color: T('err') } },
          L('读状态失败：', 'Status unavailable: ') + errorText(status.error)) : null,
        // 「?」帮助弹层（要求②）：正文来自宿主 GET /help；读不到就如实说，并给出文件路径
        helpExit.mounted ? h('div', { ...themeAttrs(), 'data-po06': 'help-pop', 'data-po06-closing': helpExit.closing ? '1' : '0', style: { ...S.helpPop, ...(region ? { right: Math.max(0, Math.round(((typeof window !== 'undefined' && window.innerWidth) || 800) - region.right) + 16) + 'px', width: Math.min(560, Math.max(120, region.w - 32)) + 'px' } : null) } },
          h('div', { style: { ...S.row, margin: '0 0 6px' } },
            h('strong', {}, L('使用帮助（怎么用 / 档位 / 权限 / 推荐组合）', 'Help (how to use / tier / permission / recommended combos)')),
            h('span', { style: S.muted }, (data && data.version) || ''),
            h('button', {
              type: 'button', 'data-po06': 'help-close', style: { ...S.small, marginLeft: 'auto' },
              title: L('关闭帮助', 'Close help'), onClick: () => setHelpOpen(false),
            }, L('关闭', 'Close')),
          ),
          help.loading ? h('div', { style: S.muted }, L('读取中…', 'Loading…')) : null,
          help.error ? h('div', { 'data-po06': 'help-error', style: { ...S.muted, color: T('err') } },
            L('帮助读不到：', 'Help unavailable: ') + errorText(help.error)) : null,
          !help.loading && !help.error && help.data
            ? (help.data.source === 'file' && help.data.text
              ? h(HelpBody, { text: help.data.text })
              : h('div', { 'data-po06': 'help-missing', style: { ...S.muted, color: T('warn') } },
                help.data.note || L('帮助内容为空', 'Help content is empty')))
            : null,
          !help.loading && !help.error && help.data && help.data.source === 'file' && help.data.text
            ? h('div', { 'data-po06': 'help-source', style: { ...S.muted, marginTop: '10px' } },
              L('正文来自 ', 'Text from ') + help.data.path + L('（' + help.data.chars + L(' 字）',' chars)'), ' (' + help.data.chars + ' chars)'))
            : null,
        ) : null,
        // ② 工作模型推理增强的**过程入口**：与控件栏同一个插槽条目 ⇒ 同一道单例闸门，
        //    不会再出现「旧入口消失、新入口还在」的半截界面。
        // 「推理过程」只在「推理增强」开启时出现 —— 关着的时候它没有任何内容可看，只会占位置。
        reasoningOn?h(InferenceMonitor, { sessionId }):null,
        // ── P11 前置拦截：**0.5 的浮层与悬浮球**（用户 2026-09-21：别再造轮子，直接搬 0.5 的那一套）──
        // 面板本体是 `InterceptPanel`（结构/视觉/底栏变体逐块对照 0.5，行号写在它的注记里）；
        // 这里只做两件事：把**该显示的那一份**挑出来，把**既有处理函数**接上去。
        //   · `hold` 活着 ⇒ 显示它（拦截现场）
        //   · hold 已被 0.6 的 clearHoldSoon 清掉、而面板还开着 ⇒ 显示最后那一份快照（只读回看）
        ovExit.mounted && ovShown ? h(InterceptPanel, {
          'data-po06-closing': ovExit.closing ? '1' : '0',
          hold: ovShown, phase: ovShown.phase, permission, tier, count: interceptCount, exitKind: ovExitKind,
          prog: prog, pos: ovGeom.pos, size: ovGeom.size,
          onMove: (p) => setOvGeom((g) => ({ ...g, pos: p })),
          onResize: (z) => setOvGeom((g) => ({ ...g, size: z })),
          onEdit: (e) => {
            // 审查态里用户改的那份就是**本轮注入的包**（既有逻辑不变，只是搬到新面板里）
            const v = e.target.value
            holdRef.current = { ...(holdRef.current || ovShown), edited: v }
            setHold((x) => ({ ...(x || ovShown), edited: v }))
          },
          onConfirm: confirmHold,      // 确认提交
          onRollback: rollbackHold,    // 回退上一版包（包级历史，宿主侧保留 10 版）
          onOriginal: sendOriginal,    // 按原文发出（审查态里就是 0.5 的「‹ 回退」，见面板注记②）
          onRegen: doRegen,            // 重新生成 / 重试
          // 跳过并直接发送：开双击跳过前先提示一次（点过"以后不再显示"就不再提）
          onSkip: () => {
            // 2026-10-19 用户：开关**开着也要提示**——它默认开着，新用户并不知道有这个玩法。
            if (s.skipHintDismissed !== true) setSkipHint({ on: doubleEnterSkip })
            skipHold()
          },
          onCancel: cancelHold,        // 取消（中止、什么都不发）
          onCollapse: collapseToBall,  // 收起为球
          onCloseSent: closeSent,      // foot-sent 的「关闭」
        }) : null,
        ovBall && ovBall.visible ? h(InterceptBall, {
          ball: ovBall, tier,
          onOpen: reopenFromBall,
          onMove: (p) => setOvBall((b) => (b ? { ...b, pos: p } : b)),
        }) : null,
        panelExit.mounted ? h('div', { ...themeAttrs(), 'data-po06': 'panel', 'data-po06-closing': panelExit.closing ? '1' : '0',
          style: { ...S.panel, ...(region ? { right: Math.max(0, Math.round(((typeof window !== 'undefined' && window.innerWidth) || 800) - region.right) + 16) + 'px', width: Math.min(420, Math.max(120, region.w - 32)) + 'px' } : null) } },
          h('div', { style: S.row },
            h('strong', {}, L('许愿特化器','Wish Specializer')),
            h('span', { style: S.muted }, (data && data.version) || ''),
            h('button', { style: { ...S.btn, marginLeft: 'auto' }, onClick: () => setOpen(false) }, L('关闭','Close')),
          ),
          status.error ? h('div', { style: { ...S.muted, color: T('err') } }, L('读状态失败：','Failed to read status: ') + errorText(status.error)) : null,
          h('div', { style: S.h }, L('控制','Controls')),
          h(ControlForm, { status: data, refresh: refreshStatus, sessionId }),
          h('div', { style: S.h }, L('解释层提示词','Explainer prompt')),
          h(PromptEditor, { prompt: data && data.prompt, refresh: refreshStatus }),
        ) : null,
      )
    }

    // ── ② 设置页里的一页（同一套控件）─────────────────────────────────
    function SettingsTab(props) {
      useLocaleLive()                                  // 语言是活的：DSH 里切语言 ⇒ 立刻换文案
      useThemeLive()                                   // 主题也是活的：切深浅色 ⇒ 立刻换配色
      // ⚠ 宿主按**标准 props** 注入 `sessionId`（与 ControlBar 同一契约，见 slots.d.ts）。
      //   此前这个组件漏了形参，函数体里却引用 `sessionId` ⇒ 渲染期 ReferenceError
      //   ⇒ 设置页整块失效（用户实测：点了没反应、界面不更新）。
      const { sessionId } = props || {}
      const [status, refresh] = useStatus(sessionId)
      const [turns] = useTurns(3)
      const data = status.data
      return h('div', { ...themeAttrs(), 'data-po06': 'settings', style: { fontSize: '13px' } },
        h('div', { style: S.muted }, 'dsh-prompt-optimizer 0.6 ｜ ' + ((data && data.version) || '') + ' ｜ ' + ((data && data.home) || '')),
        !data ? h('div', { style: S.muted }, status.error ? L('读状态失败：','Failed to read status: ') + errorText(status.error) : '读取中…') : null,
        data ? h('div', {}, h('div', { style: S.h }, L('控制','Controls')), h(ControlForm, { status: data, refresh, sessionId })) : null,
        data ? h('div', {}, h('div', { style: S.h }, L('解释层提示词','Explainer prompt')), h(PromptEditor, { prompt: data.prompt, refresh })) : null,
        h('div', { style: S.h }, L('最近几轮','Recent rounds')),
        h(TurnsList, { turns: turns.data }),
        data && data.problems && data.problems.length
          ? h('div', { style: { ...S.muted, color: T('warn') } }, L('配置里有 ','Config has ') + data.problems.length + ' 处不规范（已按默认处理）')
          : null,
      )
    }

    // Advisor views share the keyed tool slot with root and PTC subcalls.
    let AdvisorIcons = {}
    try { AdvisorIcons = require('@deepseek-ai/dsh-client-ui-primitives') } catch { /* text fallback */ }
    const advisorIcon = (name, fallback, style) => AdvisorIcons[name]
      ? h(AdvisorIcons[name], { style: { width: '16px', height: '16px', flexShrink: 0, ...style } })
      : h('span', { 'aria-hidden': true, style }, fallback)
    const advisorTerminal = new Set(['done', 'failed', 'cancelled', 'timeout', 'interrupted'])
    function advisorValueOf(block) {
      const text = (Array.isArray(block && block.content) ? block.content : [])
        .filter((b) => b && b.type === 'text').map((b) => b.text || '').join(String.fromCharCode(10))
      const parseObject = (source) => {
        try {
          const value = JSON.parse(source)
          return value && typeof value === 'object' && !Array.isArray(value) ? value : null
        } catch { return null }
      }
      const value = parseObject(text)
      if (value) return value
      // Legacy banners precede an object on its own line. Never salvage nested JSON.
      if (/^\s*[\[{]/.test(text)) return null
      const boundary = /(?:^|\n)[\t ]*\{/.exec(text)
      return boundary ? parseObject(text.slice(boundary.index)) : null
    }
    function advisorArgsOf(props, partial) {
      const block = props.block || {}
      const raw = props.phase === 'result' ? block.call && block.call.argsRaw : block.argsRaw
      if (raw && typeof raw === 'object') return raw
      try { return JSON.parse(raw || partial || '{}') } catch { return {} }
    }
    const advisorVerdict = (code) => ({
      suggestion: L('改进建议已形成', 'Contribution ready'), keep: L('保留当前版本', 'Keep current result'), pass: L('通过', 'Passed'), gaps: L('有缺口', 'Gaps found'), unverified: L('未完整验证', 'Unverified'),
      need_user: L('需要你决定', 'Needs your decision'), continue: L('继续当前路线', 'Continue'),
      narrow: L('缩小实验', 'Narrow the experiment'), change: L('建议换路线', 'Change approach'),
    }[code] || L('未给出结论', 'No conclusion'))
    const advisorStage = (code) => ({
      prepare: L('准备材料', 'Preparing evidence'), evidence: L('查证中', 'Checking evidence'),
      thinking: L('思考中', 'Thinking'), conclude: L('生成结论', 'Concluding'), validate: L('核对引用', 'Validating citations'),
      done: L('已完成', 'Completed'), failed: L('未通过校验', 'Not accepted'),
      timeout: L('已到时限', 'Time limit reached'), cancelled: L('已取消', 'Cancelled'),
      interrupted: L('运行已中断', 'Interrupted'),
    }[code] || L('等待顾问', 'Waiting for advisor'))
    const advisorReason = (reason) => ({
      'assist-off': L('本会话的提示词辅助已关闭', 'Assistance is off for this session'),
      'advisor-invalid-check': L('验收项没有通过证据校验', 'An acceptance check failed evidence validation'),
      'advisor-invalid-citation': L('报告引用了无法核对的证据', 'The report contains an unverifiable citation'),
      'advisor-invalid-json': L('顾问未返回完整的结构化报告', 'The advisor did not return a complete report'),
      'advisor-invalid-report': L('顾问报告格式不完整', 'The advisor report is incomplete'),
      'advisor-pass-without-evidence': L('缺少通过验收的证据', 'Not enough evidence to pass'),
      'advisor-timeout': L('咨询已到时限', 'Consultation reached its time limit'),
      'advisor-stall-timeout': L('顾问长时间没有任何产出，已提前结束（可换模型或缩小问题后重试）', 'The advisor produced nothing for a long while, so it stopped early — try another model or a narrower question'),
      'advisor-cancelled': L('咨询已取消', 'Consultation was cancelled'),
      'host-restarted': L('宿主重启，中断了这次咨询', 'Host restart interrupted this consultation'),
      'plugin-unloaded': L('插件卸载，中断了这次咨询', 'Plugin unload interrupted this consultation'),
    }[reason] || reasonText(reason))
    // 顾问卡片的轮询节奏。真机反馈「一秒一次刷新」——那是原先写死的 800ms 链式 setTimeout。
    // 改成与拦截那条同一档（25ms，见上面拦截的 pull；用户 2026-09-21 明确要过这个量级）。
    // ⚠ 25ms 全量回会变成每秒上兆：服务端只回增量（advisor-progress.js 的 get），
    //   客户端把增量拼进本地缓冲，因此单次载荷通常只有几十到几百字节。
    const ADVISOR_POLL_MS = 25
    const ADVISOR_POLL_ERROR_MS = 500    // 出错退避：不给服务端添乱，但也不停止（跑完还要看到终态）
    const ADVISOR_POLL_IDLE_MS = 250     // 记录还没建出来／已被淘汰：别按 25ms 空转
    const ADVISOR_POLL_FULL_MS = 200     // 拿不到增量（旧宿主）⇒ 每次都是整段正文，慢一档，别按 25ms 传几十 KB
    const ADVISOR_REQUEST_TIMEOUT_MS = 8000   // 单次请求必须能超时：挂起一次就把整条链停死是更糟的失败
    /**
     * 把一次进度响应合进本地缓冲（**纯函数**，便于单测）。
     * 增量模式拼 append；全量/重同步模式直接替换。
     * `since` 用**累计收到的字数**而不是缓冲长度——缓冲会按服务端窗口裁剪，长度不再等于偏移量。
     */
    function advisorMergeProgress(buffer, run) {
      const next = { reasoning: buffer.reasoning, draft: buffer.draft, since: buffer.since, draftSince: buffer.draftSince,
        round: buffer.round || 0, deltaCapable: buffer.deltaCapable !== false }
      if (!run) return next
      // 旧宿主（不认 since）：响应里根本没有字数统计 ⇒ 永久关掉增量，
      // 否则会按 25ms 拉几十 KB 的全量正文 —— 正是增量要避免的负载。
      if (run.reasoningChars === undefined && run.draftChars === undefined) next.deltaCapable = false
      if (run.delta === true) {
        const r = typeof run.reasoningDelta === 'string' ? run.reasoningDelta : ''
        const d = typeof run.draftDelta === 'string' ? run.draftDelta : ''
        next.reasoning += r; next.draft += d
        next.since += r.length; next.draftSince += d.length
        next.round = Number(run.round) || 0
      } else {
        next.reasoning = String(run.reasoning || ''); next.draft = String(run.draft || '')
        next.since = Number(run.reasoningChars) || 0; next.draftSince = Number(run.draftChars) || 0
        next.round = Number(run.round) || 0
      }
      // 与服务端保留窗口对齐：服务端只留尾部，客户端也按同一长度裁。
      const rl = Number(run.reasoningLen), dl = Number(run.draftLen)
      if (Number.isFinite(rl) && rl >= 0 && next.reasoning.length > rl) next.reasoning = next.reasoning.slice(-rl)
      if (Number.isFinite(dl) && dl >= 0 && next.draft.length > dl) next.draft = next.draft.slice(-dl)
      return next
    }
    /**
     * 这次的进度值不值得重渲染（**纯函数**）。
     * 25ms 轮询意味着"没变化也 setState"会变成每秒 40 次空重渲染；
     * 所以只有 阶段/字数/工具数/活动数 变了，或跑了整数秒，才更新。
     */
    /**
     * 下一次轮询的间隔（**纯函数**，便于单测）：
     *   · 正常：25ms（会话级手感）；
     *   · 出错/超时：退避到 500ms，但不停止；
     *   · 这一次没读到记录（还没建出来、或已被淘汰）：再退到 250ms，别按 25ms 空转。
     */
    function advisorNextDelayMs(sawRun, delay, deltaCapable = true) {
      const base = Number.isFinite(delay) && delay > 0 ? delay : ADVISOR_POLL_MS
      if (!sawRun) return Math.max(base, ADVISOR_POLL_IDLE_MS)
      // 增量拿不到时每次回的都是整段正文 ⇒ 不能还按 25ms 拉（这正是要避免的负载）。
      return deltaCapable ? base : Math.max(base, ADVISOR_POLL_FULL_MS)
    }
    /**
     * 连续"要了增量却没拿到"的次数（**纯函数**）。
     * 为什么需要它：旧宿主不认识 `since`，照样回整段正文；这时必须降级（慢一档 + 不再带参数），
     * 否则会变成 25ms 一次几十 KB 的全量拉取 —— 恰好是增量要避免的负载。
     * 合法的重同步（resync）不算漏；没在要增量时也不计。
     */
    function advisorDeltaMiss(prev, raw, wantsDelta) {
      if (!raw) return prev
      if (raw.delta === true) return 0
      if (raw.resync === true) return prev
      return wantsDelta ? prev + 1 : prev
    }
    function advisorProgressKey(run, clock) {
      if (!run) return 'none'
      const secs = run.startedAt ? Math.floor(((run.finishedAt || clock) - run.startedAt) / 1000) : -1
      // ⚠ 活动**条数会封顶**（服务端 slice(-24)）⇒ 只看 length，第 25 条之后的新活动就不再触发重绘。
      //   所以认"最后一条是谁"，而不是"有几条"。
      const acts = Array.isArray(run.activities) ? run.activities : []
      const last = acts.length ? acts[acts.length - 1] : null
      const actKey = last ? String(last.at || '') + ':' + String(last.tool || '') : '0'
      return [run.stage, run.reasoningChars, run.draftChars, run.toolCalls, run.round, acts.length, actKey, secs].join('|')
    }
    function useAdvisorRun(sessionId, callId, runId, settled) {
      const [state, setState] = React.useState({ run: null, error: null, clock: Date.now() })
      React.useEffect(() => {
        let alive = true, timer = null, controller = null, key = '', deltaMisses = 0
        let buffer = { reasoning: '', draft: '', since: 0, draftSince: 0, round: 0, deltaCapable: true }
        setState({ run: null, error: null, clock: Date.now() })
        if (!sessionId || (!callId && !runId)) return undefined
        const tick = async () => {
          controller = new AbortController()
          let timedOut = false
          const guard = window.setTimeout(() => { timedOut = true; try { controller.abort() } catch { /* 已经结束 */ } }, ADVISOR_REQUEST_TIMEOUT_MS)
          let done = false, sawRun = false, delay = ADVISOR_POLL_MS
          try {
            const identity = runId ? '&run=' + encodeURIComponent(runId) : '&call=' + encodeURIComponent(callId)
            const wantsDelta = buffer.deltaCapable !== false && buffer.since > 0
            const delta = buffer.deltaCapable !== false
              ? '&since=' + buffer.since + '&draftSince=' + buffer.draftSince + '&draftRound=' + (buffer.round || 0) : ''
            const response = await fetch(API + '/advisor-progress?session=' + encodeURIComponent(sessionId) + identity + delta,
              { cache: 'no-store', signal: controller.signal })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const data = await response.json()
            if (!alive) return
            const raw = data.run || null
            sawRun = !!raw
            // ⚠ 真正的降级判据是"**要了增量却没拿到**"，不是"响应里有没有字数统计"：
            //   旧宿主照样回 reasoningChars（它就在记录里），只是不认识 since ⇒ 每次都回整段。
            //   合法的重同步（resync）不算漏，否则刚开跑就被误判成旧宿主。
            deltaMisses = advisorDeltaMiss(deltaMisses, raw, wantsDelta)
            if (deltaMisses >= 3) buffer = { ...buffer, deltaCapable: false }
            buffer = advisorMergeProgress(buffer, raw)
            const run = raw ? { ...raw, reasoning: buffer.reasoning, draft: buffer.draft } : null
            done = !!(run && advisorTerminal.has(run.stage))
            const clock = Date.now()
            const nextKey = advisorProgressKey(run, clock)
            // 内容没变就不 setState：25ms 一次的轮询里，绝大多数 tick 是空的。
            if (nextKey !== key) { key = nextKey; setState({ run, error: null, clock }) }
          } catch (e) {
            // 卸载取消 ⇒ 整条链结束；**超时取消 ⇒ 只是这一次没成**，必须继续排下一次（否则一次挂起就把流停死）。
            if (!alive || (e.name === 'AbortError' && !timedOut)) return
            delay = ADVISOR_POLL_ERROR_MS
            setState((s) => ({ ...s, error: String(e.message || e), clock: Date.now() }))
          } finally { window.clearTimeout(guard) }
          if (alive && !settled && !done) timer = window.setTimeout(tick, advisorNextDelayMs(sawRun, delay, buffer.deltaCapable !== false))
        }
        void tick()
        return () => { alive = false; window.clearTimeout(timer); if (controller) controller.abort() }
      }, [sessionId, callId, runId, settled])
      return state
    }
    // 进度条上限**优先用本轮记录里的限时**（advisor.js 写进来的），这份常量只是记录缺失时的兜底：
    // 两份各写一个常量必然漂移（真发生过：限时放宽后进度条仍按旧值画满）。
    const ADVISOR_MAX_MS = 300000
    // 进度换算：**纯函数**（可单测）。没在跑、或还没有耗时 ⇒ 不画进度条。
    const advisorProgressPct = (elapsedSec, running, maxMs) => (running && elapsedSec != null && Number.isFinite(elapsedSec) && Number(maxMs)>0)
      ? Math.min(0.97, Math.max(0, elapsedSec / (Number(maxMs) / 1000))) : null
    function advisorDraftReply(draft) {
      const match = /"summary"\s*:\s*"((?:\\.|[^"\\])*)/.exec(String(draft || ''))
      if (!match) return ''
      try { return JSON.parse('"' + match[1] + '"') } catch { return '' }
    }
    /**
     * 斜杠命令是否放行（纯函数，便于单测）：
     * `active` 是**宿主确认已注册**的命令名清单——配置里列了但当前没注册的不会出现在这里。
     * 判定要求命令名后紧跟空白或行尾，避免 `/vmakefoo` 被当成 `/vmake`。
     */
    function slashReviewAllowed(active, draft) {
      const set = new Set((Array.isArray(active) ? active : []).map((n) => String(n == null ? '' : n).toLowerCase()).filter(Boolean))
      if (!set.size) return false
      const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(\s|$)/.exec(String(draft == null ? '' : draft))
      return !!(m && set.has(m[1].toLowerCase()))
    }
    function AdvisorStageCard({ stageState, stagePassed }) {
      const state = stageState
      const stage = state && state.stage && state.stage.id ? state.stage : null
      const field = (key, value) => h('div', { 'data-po06-advisor-stage-field': key }, h('strong', null, key + ': '), value == null ? L('未声明', 'Not declared') : String(value))
      return h('div', { 'data-po06-advisor-stage-state': true, style: { marginTop: '12px', fontSize: '12px', overflowWrap: 'anywhere' } },
        field('taskId', state && state.taskId), field('stageId', stage && stage.id), field('action', state && state.action),
        h('p', { 'data-po06-advisor-stage-gate': true, style: { color: stagePassed ? T('ok') : T('warn') } },
          stage ? stagePassed ? L('当前声明阶段可放行（非任务完成）', 'Current declared stage may advance (not task completion)') : L('当前声明阶段未放行', 'Current declared stage cannot advance') : L('缺少当前声明阶段状态', 'Current declared stage state is missing')),
        stage && Array.isArray(stage.checks) ? stage.checks.map((check, i) => h('div', { key: check.id || i, 'data-po06-advisor-stage-check': check.id, style: { padding: '5px 0' } },
          field('id', check.id), field('status', check.status), field('criterion', check.criterion))) : null,
        state && Array.isArray(state.dependencyStages) ? field('dependencyStages', state.dependencyStages.join(' · ')) : null,
        stage && Array.isArray(stage.limitations) ? field('limitations', stage.limitations.join(' · ')) : null)
    }

    function AdvisorMaterials({ materials, openFile }) {
      const evidenceLabel = row => ({ source:L('源码','Source'), 'test-log':L('测试日志','Test log'), 'runtime-log':L('运行日志','Runtime log'), 'runtime-capture':L('运行截图（声明）','Runtime capture (declared)'), 'software-preview':L('替代预览','Software preview'), reference:L('参考图','Reference'), other:L('未指定证据类型','Unspecified evidence type') }[row.evidenceType || 'other'])
      const statusLabel = row => row.status === 'ready' ? (row.kind === 'image' ? L('已附图像', 'Image attached') : L('已附内容', 'Content attached'))
        : row.status === 'truncated' ? L('部分内容', 'Partial content') : row.status === 'not-inspected' ? L('未检查图片', 'Image not inspected')
        : row.status === 'pending' ? L('待准备', 'Pending') : row.status === 'excluded' ? L('本次范围排除', 'Excluded by scope') : L('不可用', 'Unavailable')
      const reasons = { 'scope-material-excluded': L('不属于本次专项，未读取、未附入', 'Outside this review scope; not read or attached'), 'model-text-only': L('当前模型不支持图像输入', 'Model does not accept images'),
        'model-image-capability-unknown': L('宿主未确认当前模型的图像能力', 'Image capability is not declared'),
        'read-tools-disabled-or-no-cwd': L('只读工具未开启或工作目录不可用', 'Read tools are off or workspace is unavailable'),
        'file-not-found': L('文件不存在', 'File not found'), 'outside-workspace': L('路径不在本会话工作目录内', 'Outside workspace'),
        'file-too-large': L('材料超过大小限制', 'Material exceeds size limit'), 'attachment-service-unavailable': L('图片附件服务不可用', 'Image attachment service unavailable') }
      if (!materials.length) return null
      return h('div', { 'data-po06-advisor-materials': true, style: { marginTop: '14px', minWidth: 0 } },
        h('div', { style: { color: T('fg3'), fontSize: '11px', marginBottom: '6px' } }, L('本次提供的材料', 'Materials for this consultation') + ' · ' + materials.length),
        materials.map((row, index) => h('details', { key: row.id || index, 'data-advisor-material': row.id || index,
          style: { borderTop: '1px solid ' + T('line2'), padding: '7px 0', minWidth: 0 } },
          h('summary', { style: { cursor: 'pointer', color: T('fg2'), overflowWrap: 'anywhere', fontSize: '12px' } },
            h('span', { style: { marginRight: '7px', color: T('fg3') } }, row.kind === 'image' ? L('图像', 'Image') : L('文件', 'File')),
            row.previewAvailable && typeof openFile === 'function' ? h('button', { type: 'button', title: L('在侧栏预览当前文件', 'Preview current file in sidebar'),
              onClick: e => { e.preventDefault(); e.stopPropagation(); openFile(row.previewPath || row.path) },
              style: { font: 'inherit', color: T('acc'), background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', overflowWrap: 'anywhere' } }, row.path)
              : h('span', null, row.path),
            h('span', { style: { fontSize: '11px', marginLeft: '10px', color: row.sent ? T('fg3') : T('warn') } }, statusLabel(row))),
          h('div', { style: { padding: '7px 0 2px 18px', fontSize: '12px', color: T('fg2'), minWidth: 0 } },
            h('p', { style: { margin: '0 0 5px', overflowWrap: 'anywhere' } }, row.purpose || L('本次成果', 'Current artifact')),
            row.reason ? h('p', { style: { margin: '4px 0', color: T('warn') } }, reasons[row.reason] || row.reason) : null,
            h('p', { style: { margin:'4px 0',fontSize:'11px',color:T('fg3') } }, evidenceLabel(row), row.selectionScope === 'line-range' ? ' · ' + row.selectedStartLine + '-' + row.selectedEndLine : '', row.wholeFileComplete === false && row.kind !== 'image' ? L(' · 非全文',' · Not whole file') : ''),
            row.sentChars != null ? h('p', { style: { margin: '4px 0', fontSize: '11px', color: T('fg3') } }, L('实际附入 ', 'Attached ') + row.sentChars + ' / ' + (row.selectedChars ?? row.chars) + L(' 字符（所选范围）', ' characters (selected range)')) : null,
            row.image ? h('p', { style: { margin: '4px 0', fontSize: '11px', color: T('fg3') } }, row.image.width + ' × ' + row.image.height + (row.image.resized ? L(' · 经宿主缩放', ' · Normalized by host') : '')) : null,
            row.excerpt ? h('pre', { style: { margin: '7px 0', fontSize: '11px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '160px', overflowY: 'auto' } }, row.excerpt) : null,
            row.sha256 ? h('p', { style: { margin: '5px 0 0', fontSize: '10px', color: T('fg3'), overflowWrap: 'anywhere' } }, 'SHA256 ' + row.sha256.slice(0, 16) + L(' · 侧栏预览当前文件，可能与咨询时版本不同', ' · Sidebar shows the current file, which may differ from the reviewed version')) : null))))
    }
    function AdvisorToolRow(props) {
      useLocaleLive()
      // ⚠ 主题也是活的：少了这一行，切到浅色后卡片不会重渲染，标记停在 dark ⇒ 用户看到的
      //   就是「只有黑色模式」（2026-09-30 实测反馈）。其余面板都调了它，这里此前漏了。
      useThemeLive()
      // 本组件自己的会话标识（宿主按 session scope 注入）。定义在本地，避免与其它组件的同名变量混淆。
      const sessionId = props.sessionId
      const partial = typeof props.useToolCallArgumentsPartial === 'function' ? props.useToolCallArgumentsPartial() : ''
      const args = advisorArgsOf(props, partial)
      const result = props.phase === 'result' ? advisorValueOf(props.block) : null
      const state = useAdvisorRun(sessionId, props.callId, result && result.uiRunId, props.phase === 'result')
      const candidate = state.run
      const run = candidate && candidate.sessionId === String(sessionId)
        && (result && result.uiRunId ? candidate.runId === result.uiRunId : candidate.callId === String(props.callId)) ? candidate : null
      const value = (run && run.result) || result
      const report = value && value.ok === true && value.report ? value.report : null
      const stage = run ? run.stage : (props.phase === 'result' ? (value && value.ok ? 'done' : 'failed') : 'prepare')
      const running = props.phase !== 'result' && !advisorTerminal.has(stage)
      // 运行中默认展开思考：用户要的就是"实时看到思维链"，跑完再收起来才需要多点一次。
      const [processOpen, setProcessOpen] = React.useState(props.phase !== 'result')
      const [checksOpen, setChecksOpen] = React.useState(false)
      const thinkBody = React.useRef(null)
      const followThink = React.useRef(true)
      const reasoning = run && run.reasoning || ''
      React.useEffect(() => {
        const body = thinkBody.current
        if (processOpen && body && followThink.current) body.scrollTop = body.scrollHeight
      }, [reasoning, processOpen])
      const mode = args.mode || (value && value.mode) || (run && run.mode)
      const isContribution = mode === 'develop_approach' || mode === 'improve_result'
      const title = mode === 'improve_result' ? L('顾问 · 产物拔高', 'Advisor · Result improvement') : mode === 'develop_approach' ? L('顾问 · 独立解题', 'Advisor · Independent solution') : mode === 'review_result' ? L('顾问 · 独立验收', 'Advisor · Independent review') : L('顾问 · 失败诊断', 'Advisor · Failure diagnosis')
      const isPartial = !!(value && (value.partial || (value.presentationMeta && value.presentationMeta.partial)))
      const meta = (value && value.presentationMeta) || null
      // ⚠ 两个概念必须分开（GitHub #30(b)）：
      //   isPartial  是**安全闸**（部分结果不许放行阶段），保持只看标志位；
      //   retained   是**有没有真东西**，只用来决定标题怎么写。
      //   原先标题只看标志位，于是"只剩一句固定提示语"也会显示「保留部分内容」——那是假象。
      const retainedReasoning = (value && value.partialReasoning) || (meta && meta.partialReasoning) || null
      const retainedActivities = (value && Array.isArray(value.activities) && value.activities.length ? value.activities : (meta && Array.isArray(meta.activities) ? meta.activities : [])) || []
      const retainedRaw = (value && value.raw) || (meta && meta.raw) || null
      const hasRetained = !!(retainedReasoning || retainedActivities.length || retainedRaw)
      const stageState = value && ((value.presentationMeta && value.presentationMeta.stageState) || value.stageState)
      const staged = !!(stageState || args.taskId || args.stageId || (value && (value.taskId || value.stageId)))
      const declaredStage = stageState && stageState.stage && stageState.stage.id ? stageState.stage : null
      const recordingFailed = !!(value && ((value.stageRecording && value.stageRecording.ok === false) || (value.presentationMeta && value.presentationMeta.stageRecording && value.presentationMeta.stageRecording.ok === false)))
      const stagePassed = !!(declaredStage && stageState && stageState.advanceAllowed === true && stageState.ok === true && !isPartial && !(stageState.dependencyStages && stageState.dependencyStages.length) && !recordingFailed)
      const status = staged && !running ? (stagePassed ? L('当前阶段可放行', 'Current stage may advance') : L('当前阶段未放行', 'Current stage cannot advance')) : running ? advisorStage(stage) : isPartial ? (hasRetained ? L('保留部分内容', 'Partial output') : L('未形成结论', 'No usable output'))
        : report ? advisorVerdict(report.verdict) : advisorStage(stage)
      const tone = (staged ? stagePassed : report && !isPartial && report.verdict === 'pass') ? T('ok') : (running || isContribution && ['suggestion','keep'].includes(report?.verdict) && !isPartial) ? T('acc') : T('warn')
      const elapsed = run ? Math.max(0, ((run.finishedAt || state.clock) - run.startedAt) / 1000)
        : value && typeof value.ms === 'number' ? value.ms / 1000 : null
      // 用一个静止的进度条把"还在跑、跑了多久"画出来，比只有一个秒数直观；上限对齐 advisor.js 的 150s，
      // 且**最多画到 97%**——没结束就不该看起来已经满了。
      const progress = advisorProgressPct(elapsed, running, run && run.timeoutMs)
      // 页脚要用的元信息（四分区重写时漏了声明，2026-09-30 由组件树断言抓出 `model is not defined`）。
      const model = (run && run.model) || (value && value.model) || null
      const effort = (run && run.effort) || (value && value.reasoningEffort) || null
      const toolCalls = (run && run.toolCalls != null) ? run.toolCalls : (value && value.toolCalls != null ? value.toolCalls : null)
      // 这次咨询的 token（结果里的 usage，已由 advisor.js 的 presentationMeta 投影过来）。
      // ⚠ 这是**插件自己的账**：DSH 顶部那个数字只统计宿主自己发起的调用，这里进不去。
      const usage = (run && run.result && run.result.usage) || (value && value.usage) || null
      const question = args.question || (run && run.question) || ''
      const reviewScope = (run && run.reviewScope) || (value && value.reviewScope) || args.scope || 'general'
      const focus = (run && run.focus) || (value && value.focus) || args.focus || ''
      const scopeLabels = { general: L('综合复核', 'General'), geometry: L('几何装配', 'Geometry'), appearance: L('画面表现', 'Appearance'), code: L('代码正确性', 'Code'), interaction: L('交互逻辑', 'Interaction'), performance: L('性能证据', 'Performance'), delivery: L('交付覆盖', 'Delivery coverage'), custom: L('自定义专项', 'Custom') }
      const coverage = (run && run.coverage) || (value && value.coverage) || null
      const supplied = [...(Array.isArray(args.artifacts) ? args.artifacts.map(path => ({ path, kind: 'file' })) : []),
        ...(Array.isArray(args.files) ? args.files.map(x => ({ ...x, kind: 'file' })) : []),
        ...(Array.isArray(args.images) ? args.images.map(x => ({ ...x, kind: 'image' })) : [])].map(x => ({ ...x, status: 'pending' }))
      const materials = (run && run.materials) || (value && value.materials) || supplied
      const draftReply = running && run ? advisorDraftReply(run.draft) : ''
      const textStyle = { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', lineHeight: 1.75 }
      const labelStyle = { fontSize: '12px', color: T('acc'), fontWeight: 600, letterSpacing: '.02em', marginBottom: '7px' }
      // 分区题干：**主题色 + 加粗**（用户 2026-09-30 要求「题干更突出」）。
      // 只在这一处用主题色，其余保持灰阶 ⇒ 卡面仍然克制、灰度下也能分出区块。
      const sectionHead = (icon, text, extra) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '9px', minWidth: 0 } },
        advisorIcon(icon, '', { color: T('acc'), width: '13px', height: '13px' }),
        h('span', { style: { fontSize: '12px', color: T('acc'), fontWeight: 600, letterSpacing: '.02em' } }, text), extra || null)
      const dot = (color, size) => h('span', { 'aria-hidden': true, style: { display: 'inline-block', flexShrink: 0,
        width: (size || 7) + 'px', height: (size || 7) + 'px', borderRadius: '50%', background: color } })
      const sectionStyle = { paddingTop: '16px', minWidth: 0 }
      const disclosureStyle = { cursor: 'pointer', color: T('acc'), fontWeight: 600, fontSize: '12px', letterSpacing: '.02em', padding: '10px 0', outlineOffset: '3px' }
      const refs = values => h('span', { style: { color: T('fg3'), fontSize: '11px', marginLeft: '8px', overflowWrap: 'anywhere' } },
        (Array.isArray(values) ? values : []).join(' · '))
      const checks = report && Array.isArray(report.checks) ? report.checks : []
      const counts = checks.reduce((out, check) => { out[check.status] = (out[check.status] || 0) + 1; return out }, {})
      const checkLabels = { satisfied: L('已满足', 'Satisfied'), failed: L('不满足', 'Failed'), unverified: L('待验证', 'Unverified') }
      const checkSummary = checks.length ? checks.length + L(' 项', ' checks')
        + (counts.failed ? ' · ' + counts.failed + L(' 项不满足', ' failed') : '')
        + (counts.unverified ? ' · ' + counts.unverified + L(' 项待验证', ' unverified') : '') : running ? L('尚未验收', 'Pending') : L('无验收项', 'No checks')
      return h('section', { ...themeAttrs(), 'data-po06': 'advisor-tool', 'data-advisor-call': props.callId,
        style: { width: '100%', boxSizing: 'border-box', minWidth: 0, border: '1px solid ' + T('line2'), borderRadius: '8px',
          background: T('surface'), color: T('fg'), padding: '16px 18px', fontSize: '13px', lineHeight: 1.65, overflowWrap: 'anywhere' } },
        h('header', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px', minHeight: '24px' } },
          advisorIcon('IconSparkleRegular', '*', { color: T('fg2') }),
          h('span', { style: { fontWeight: 600, color: T('acc'), fontSize: '13.5px', letterSpacing: '.01em' } }, title),
          h('span', { role: 'status', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: running ? T('fg2') : tone, fontSize: '12px' } },
            dot(tone), h('span', null, status)),
          h('span', { style: { marginLeft: 'auto', color: T('fg3'), fontVariantNumeric: 'tabular-nums', fontSize: '11px', minWidth: '34px', textAlign: 'right' } }, elapsed == null ? '' : Math.floor(elapsed) + 's'),
          props.inspect ? h('button', { type: 'button', title: L('查看调用详情', 'Inspect call'), 'aria-label': L('查看调用详情', 'Inspect call'), onClick: props.inspect,
            style: { border: 0, background: 'transparent', color: T('fg3'), padding: '4px', cursor: 'pointer', width: '24px', height: '24px' } }, advisorIcon('IconSearchOutlineRegular', '?')) : null),
        progress != null ? h('div', { 'data-po06-advisor-progress': true, 'aria-hidden': true,
          style: { marginTop: '12px', height: '2px', borderRadius: '1px', background: T('line2'), overflow: 'hidden' } },
          h('div', { style: { width: Math.round(progress * 100) + '%', height: '100%', background: tone, transition: 'width .45s ease' } })) : null,
        h('div', { 'data-po06-advisor-scope': true, style: { marginTop: '10px', fontSize: '12px', color: T('fg2'), overflowWrap: 'anywhere' } },
          h('strong', { style: { color: T('acc') } }, scopeLabels[reviewScope] || reviewScope), focus ? ' · ' + focus : ''),
        !isContribution && reviewScope !== 'general' && reviewScope !== 'delivery' ? h('div', { style: { color: T('fg3'), fontSize: '11px', marginTop: '4px' } }, L('结论仅限本次对象，不代表整体通过', 'This conclusion covers only the reviewed focus')) : null,
        coverage ? h('details', { 'data-po06-advisor-coverage': true, style: { marginTop: '12px', fontSize: '12px' } },
          h('summary', { style: { cursor: 'pointer', color: T('acc') } }, L('本轮专项覆盖', 'Coverage for this request') + ' · ' + (coverage.rows || []).length),
          (coverage.missingScopes || []).length ? h('p', { style: { color: T('warn') } }, L('未覆盖：', 'Missing: ') + coverage.missingScopes.map(s=>scopeLabels[s]||s).join(' · ')) : null,
          (coverage.missingReviews || []).map((row,index)=>h('p', { key:'missing-'+index, style:{color:T('warn')} }, L('未覆盖检查点：', 'Missing focus: ') + (scopeLabels[row.scope]||row.scope) + ' · ' + row.focus)),
          (coverage.rows || []).map((row,index)=>h('div', { key: row.id || index, style: { borderTop: '1px solid ' + T('line2'), padding: '7px 0', overflowWrap: 'anywhere' } },
            h('strong', null, (scopeLabels[row.scope]||row.scope) + ' · ' + (row.focus||'')),
            h('span', { style: { marginLeft: '8px', color: row.status === 'current' ? T('fg3') : T('warn') } }, row.status === 'current' ? L('版本指纹一致', 'Version matches') : row.status === 'changed' ? L('材料已变更', 'Materials changed') : row.status === 'missing' ? L('材料已缺失', 'Materials missing') : L('版本或结果未确认', 'Version or result unconfirmed')),
            h('p', { style: { margin: '4px 0', color: T('fg2') } }, row.summary || (row.report && row.report.summary) || ''),
            (row.checks || []).filter(check=>check.status !== 'satisfied').map((check,i)=>h('div', { key:i, style:{color:T('warn'),fontSize:'11px'} }, check.criterion)))),
          (coverage.limitations || []).map((note,index)=>h('p', {key:index,style:{color:T('warn'),fontSize:'11px'}}, String(note).startsWith('revision-marker-changed:') ? L('复核后记录到源码变更，需重审相关项', 'Recorded source changes require another focused review') : String(note).startsWith('required-focus-unspecified:') ? L('缺少该专项的具体检查对象清单', 'Required focus list is missing') : String(note).startsWith('evidence-limited:') ? L('既有复核证据不完整或未通过', 'Previous review is incomplete or has gaps') : note === 'scope-pass-is-focus-only' ? L('局部通过仅适用于已列出的对象', 'A pass applies only to the listed focus') : note === 'required-scopes-unspecified' ? L('尚未列出必要的专项检查点', 'Required reviews have not been specified') : note))) : null,
        h('div', { 'data-po06-advisor-question': true, style: sectionStyle },
          sectionHead('IconSearchOutlineRegular', L('原 AI 询问内容', 'Original AI question')),
          h('p', { style: { ...textStyle, color: T('fg2'), maxHeight: '160px', overflowY: 'auto' } }, question || L('正在接收询问…', 'Receiving question…'))),
        staged ? h(AdvisorStageCard, { stageState, stagePassed }) : null,
        !isContribution && !staged && value && value.reviewPassed !== undefined ? h('div', {'data-po06-advisor-outcome':true,style:{marginTop:'10px',fontSize:'12px',color:T('fg2')}},
          L('咨询调用：','Invocation: ') + (value.invocationSucceeded ? L('成功','Succeeded') : L('未成功','Unavailable')) + ' · ' +
          (value.reviewPassed ? L('当前专项通过（非整体完成）','Reviewed scope passed (not task completion)') : L('验收待补','Verification pending')),
          ((value.reviewState && value.reviewState.openIssues) || value.openIssues || []).map((row,i)=>h('p',{key:row.id||i,style:{margin:'5px 0',color:T('warn'),overflowWrap:'anywhere'}},
            (row.id ? row.id + ' · ' : '') + row.criterion + ' · ' + (row.nextStep || row.action || '')))) : null,
        h(AdvisorMaterials, { materials, openFile: props.openFile }),
        value && value.inspectedMaterials && value.inspectedMaterials.length ? h('details',{'data-po06-advisor-reads':true,style:{marginTop:'8px',fontSize:'11px',color:T('fg3')}},
          h('summary',null,L('顾问补读（不等于全文验收）','Advisor reads (not whole-file acceptance)')),
          value.inspectedMaterials.map((row,i)=>h('p',{key:i,style:{overflowWrap:'anywhere'}},row.path + ' · ' + row.status + (row.offset ? ' · offset=' + row.offset : '') + (row.limit ? ' limit=' + row.limit : '')))) : null,
        h('details', { 'data-po06-advisor-thinking': true, open: processOpen, onToggle: e => setProcessOpen(e.currentTarget.open),
          style: { marginTop: '14px', borderTop: '1px solid ' + T('line2'), borderBottom: '1px solid ' + T('line2') } },
          h('summary', { style: disclosureStyle },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              advisorIcon('IconSparkleRegular', '', { color: T('acc'), width: '13px', height: '13px' }),
              h('span', null, L('顾问思考内容', 'Advisor thinking')),
              running ? dot(tone, 6) : null),
            running ? h('span', { style: { marginLeft: '10px', color: T('fg3'), fontSize: '11px' } }, advisorStage(stage)) : null),
          processOpen ? h('div', { ref: thinkBody, onScroll: e => { const body = e.currentTarget; followThink.current = body.scrollHeight - body.scrollTop - body.clientHeight < 32 },
            style: { maxHeight: '280px', overflowY: 'auto', padding: '0 0 12px', minWidth: 0 } },
            h('pre', { style: { ...textStyle, color: T('fg2') } }, reasoning || (running ? L('等待模型返回思考流…', 'Waiting for model thinking…')
              : run ? L('模型未提供思考流。', 'The model did not provide a thinking stream.') : L('本次没有可回放的思考记录。', 'No thinking transcript was recorded.'))),
            run && run.reasoningTruncated ? h('p', { style: { fontSize: '11px', color: T('fg3'), marginBottom: 0 } }, L('仅保留最近 24,000 字符。', 'Only the latest 24,000 characters are retained.')) : null,
            run && run.activities.length ? h('details', { style: { marginTop: '12px', color: T('fg3'), fontSize: '11px' } },
              h('summary', { style: { cursor: 'pointer' } }, L('查证记录', 'Evidence activity') + ' · ' + run.toolCalls),
              h('ul', { style: { paddingLeft: '18px', margin: '6px 0 0' } }, run.activities.map((item, i) => h('li', { key: i, style: { padding: '2px 0' } },
                (item.ok ? L('已读取', 'Read') : L('未取得', 'Unavailable')) + ' · ' + item.tool + ' · ' + item.target)))) : null) : null),
        h('div', { 'data-po06-advisor-output': true, style: sectionStyle },
          sectionHead('IconCheckOutlineRegular', L('顾问答复内容', 'Advisor reply')),
          h('p', { 'data-po06-advisor-summary': true, style: { ...textStyle, fontSize: '14px', color: T('fg') } }, report ? report.summary : draftReply || (running
            ? L('顾问正在分析，答复将显示在这里。', 'The advisor is analyzing; its reply will appear here.')
            : advisorReason((value && (value.reason || value.cut)) || (run && run.reason) || ''))),
          report && typeof report.contribution==='string' && report.contribution ? h('pre', { 'data-po06-advisor-contribution': true, style: { ...textStyle, marginTop:'12px', color:T('fg2') } }, report.contribution) : null,
          report && Array.isArray(report.assumptions) && report.assumptions.length ? h('div', { 'data-po06-advisor-assumptions':true, style:{marginTop:'10px',color:T('fg3')} }, L('待核对的前提', 'Assumptions to check'), h('ul',{style:{paddingLeft:'18px'}},report.assumptions.map((x,i)=>h('li',{key:i},String(x))))) : null,
          isContribution ? h('p',{style:{marginTop:'10px',fontSize:'11px',color:T('fg3')}},mode === 'improve_result' ? L('这是产物拔高建议；落实后比较新旧成果，无实质增益则保留当前。不是验收结果。','Result improvement advice: compare actual old/new results and keep current without a real gain. Not acceptance.') : L('这是独立解题建议，可采纳、修改或反驳；不是验收结果。','Independent solution advice; evaluate, adapt or challenge it. This is not an acceptance verdict.')) : null,
          draftReply ? h('span', { style: { fontSize: '11px', color: T('fg3') } }, L('答复生成中，尚未完成校验', 'Reply streaming; validation pending')) : null,
          report && report.findings.length ? h('ul', { style: { paddingLeft: '18px', margin: '12px 0' } }, report.findings.map((finding, i) => h('li', { key: i, style: { margin: '7px 0', color: T('fg2') } }, finding.text, refs(finding.evidenceRefs)))) : null,
          report ? h('div', { style: { marginTop: '12px', color: T('fg2') } },
            h('div', null, h('span', { style: { color: T('fg3'), marginRight: '8px', fontSize: '12px' } }, L('下一步', 'Next step')), report.nextStep),
            h('div', { style: { marginTop: '6px' } }, h('span', { style: { color: T('fg3'), marginRight: '8px', fontSize: '12px' } }, L('停止条件', 'Stop condition')), report.stopCondition)) : null,
          isPartial ? h('p', { style: { ...textStyle, color: T('warn'), marginTop: '10px', fontSize: '12px' } }, L('仅保留已生成内容，不作为完整验收通过。', 'Retained output only; not a completed acceptance review.')) : null),
        isContribution ? null : h('details', { 'data-po06-advisor-checks': true, open: checksOpen, onToggle: e => setChecksOpen(e.currentTarget.open),
          style: { marginTop: '16px', borderTop: '1px solid ' + T('line2') } },
          h('summary', { style: disclosureStyle },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              advisorIcon('IconChecklistOutlineRegular', '', { color: T('acc'), width: '13px', height: '13px' }),
              h('span', null, L('验收结果', 'Acceptance results'))),
            h('span', { style: { marginLeft: '10px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              dot(counts.failed ? T('err') : counts.unverified ? T('warn') : counts.satisfied ? T('ok') : T('cap'), 6),
              h('span', { style: { color: T('fg3') } }, checkSummary))),
          checksOpen ? h('div', { style: { paddingBottom: '6px' } },
            checks.length ? checks.map((check, i) => h('div', { key: i, style: { display: 'grid', gridTemplateColumns: '16px minmax(0,1fr)', gap: '8px', padding: '9px 0' } },
              h('span', { style: { paddingTop: '6px' } }, dot(check.status === 'satisfied' ? T('ok') : check.status === 'failed' ? T('err') : T('cap'))),
              h('div', null,
                h('span', { style: { color: T('fg3'), fontSize: '11px', marginRight: '8px' } }, checkLabels[check.status] || check.status),
                check.criterion, refs(check.evidenceRefs)))) : h('p', { style: { ...textStyle, color: T('fg3') } }, running ? L('等待顾问完成核验。', 'Waiting for the advisor review.') : L('本次未形成可采纳的验收项。', 'No accepted checks were produced.')),
            !report && value && value.detail ? h('p', { style: textStyle }, L('未通过的验收项：', 'Rejected check: ') + String(value.detail.criterion || ''), refs(value.detail.refs)) : null,
            null) : null),
        // 到点但有进展：把已经产出的东西**摆在卡面上**，而不是塞进默认收起的验收面板里
        // （GitHub #30(b)：塞进去等于没显示——用户看到的仍然只有标题）。
        !report && hasRetained ? h('div', { 'data-po06-advisor-partial': true, style: { marginTop: '12px', borderTop: '1px solid ' + T('line2'), paddingTop: '10px' } },
          h('div', { style: { color: T('warn'), fontSize: '11px', marginBottom: '6px' } }, L('这次咨询没有完成；以下是已经产出、但未经验证的内容：', 'This consultation did not finish; below is what it did produce, unverified:')),
          retainedReasoning ? h('pre', { style: { ...textStyle, maxHeight: '200px', overflowY: 'auto', color: T('fg2'), fontFamily: 'inherit', fontSize: '12px' } }, retainedReasoning) : null,
          retainedActivities.length ? h('div', { style: { ...textStyle, fontSize: '12px', color: T('fg2') } },
            retainedActivities.map((a, i) => h('div', { key: i }, (a.ok === true ? '✓ ' : '✗ ') + String(a.tool || '') + ' ' + String(a.target || '')))) : null,
          retainedRaw ? h('details', { style: { marginTop: '8px' } },
            h('summary', { style: { cursor: 'pointer', color: T('fg3'), fontSize: '11px' } }, L('未采纳的原始输出', 'Unaccepted raw output')),
            h('pre', { style: { ...textStyle, maxHeight: '180px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px', marginTop: '8px' } }, retainedRaw)) : null) : null,
        // 页脚：一行克制的元信息（模型 / 思考档 / 查证次数 / token 用量）。
        h('div', { 'data-po06-advisor-meta': true, style: { display: 'flex', flexWrap: 'wrap', gap: '10px', color: T('fg3'), fontSize: '11px', marginTop: '10px' } },
          model ? h('span', { style: { overflowWrap: 'anywhere' } }, model) : null,
          effort ? h('span', null, L('思考档 ', 'Effort ') + effort) : null,
          toolCalls != null ? h('span', null, L('查证 ', 'Evidence ') + toolCalls + L(' 次', ' calls')) : null,
          usage ? h('span', { 'data-po06-advisor-usage': true,
            title: L('本次咨询的 token（插件自己的账，不计入 DSH 顶部统计）', 'Tokens for this consultation (plugin-side accounting; not counted in DSH totals)') },
            usageText(usage, true)) : null,
          value && (value.truncated || value.omitted) ? h('span', { style: { color: T('warn') } }, L('材料不完整', 'Incomplete evidence')) : null),
        state.error ? h('p', { style: { color: T('warn'), fontSize: '11px', margin: '6px 0 0' } }, L('实时进度暂不可用：', 'Live progress unavailable: ') + state.error) : null)
    }

    // ── 交付状态旁注：只认当前尾节点，不解释或拦截模型的完成措辞 ──────
    const ADVISOR_DELIVERY_STATUSES = new Set(['known-defects', 'verification-pending', 'reviewed-scope', 'not-reviewed', 'unavailable'])
    const ADVISOR_DELIVERY_TIMEOUT_MS = 8000
    const advisorDeliveryKey = (sessionId, seq) => typeof sessionId === 'string' && sessionId && Number.isSafeInteger(seq) && seq >= 0
      ? JSON.stringify([sessionId, seq]) : null
    // Slot owner props are flattened into the standard Session props by the host.
    // TurnLocation.turn is display metadata only; seq can be the tail event without a closing assistant.
    function advisorDeliveryBinding(props) {
      if (!props || typeof props !== 'object' || Array.isArray(props)) return null
      const turn = props.turn
      if (!turn || typeof turn !== 'object' || Array.isArray(turn) || !Number.isSafeInteger(turn.turn) || turn.turn < 0
        || !advisorDeliveryKey(props.sessionId, props.seq)) return null
      return { sessionId: props.sessionId, seq: props.seq, turnNumber: turn.turn }
    }
    const deliveryText = (v) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 360) : ''
    function advisorDeliveryValue(value, sessionId, seq) {
      // 不接收会话最新态／旧回复的响应，也不把未知协议当作完成。
      if (!advisorDeliveryKey(sessionId, seq) || !value || value.ok !== true || value.sessionId !== sessionId || value.seq !== seq
        || value.completionClaimAllowed !== false || value.scopeOnly !== true || !ADVISOR_DELIVERY_STATUSES.has(value.status)) return null
      const checkStates = new Set(['failed', 'unverified', 'stale', 'satisfied'])
      const checks = (Array.isArray(value.checks) ? value.checks : []).filter(c => c && typeof c.criterion === 'string').slice(0, 8)
        .map(c => ({ criterion: deliveryText(c.criterion), status: checkStates.has(c.status) ? c.status : 'unverified', action: deliveryText(c.action) }))
      const counts = {}
      for (const key of ['failed', 'unverified', 'stale', 'satisfied']) counts[key] = Number.isSafeInteger(value.counts && value.counts[key]) && value.counts[key] >= 0 ? value.counts[key] : 0
      // The endpoint owns the current-file/staleness verdict. Counts and retained checks
      // are facts, not a second client-side status source or permission to claim completion.
      const status = value.status
      const contribution = value.contribution && ['available', 'result-changed', 'comparison-pending', 'keep'].includes(value.contribution.status)
        ? { status: value.contribution.status, summary: deliveryText(value.contribution.summary) } : null
      return { status, requestId: deliveryText(value.requestId), checks, counts, contribution,
        limitations: (Array.isArray(value.limitations) ? value.limitations : []).map(deliveryText).filter(Boolean).slice(0, 4) }
    }
    function useAdvisorDelivery(sessionId, seq) {
      const key = advisorDeliveryKey(sessionId, seq)
      const [revision, setRevision] = React.useState(0)
      const [state, setState] = React.useState({ key: null, revision: -1, data: null, loading: false, error: null })
      React.useEffect(() => {
        if (!key) return undefined
        let alive = true, timedOut = false
        // No abort support means no request: keep this annotation neutral, never fail the turn.
        if (typeof AbortController !== 'function') {
          setState({ key, revision, data: null, loading: false, error: 'unavailable' })
          return undefined
        }
        const controller = new AbortController()
        const publish = (data, error) => { if (alive) setState({ key, revision, data, loading: false, error }) }
        setState({ key, revision, data: null, loading: true, error: null })
        const guard = window.setTimeout(() => {
          timedOut = true
          controller.abort()
          publish(null, 'timeout')
        }, ADVISOR_DELIVERY_TIMEOUT_MS)
        void (async () => {
          try {
            const raw = await apiGet('/advisor-delivery?session=' + encodeURIComponent(sessionId) + '&seq=' + seq,
              { signal: controller.signal, cache: 'no-store' })
            if (!alive || timedOut) return
            const data = advisorDeliveryValue(raw, sessionId, seq)
            publish(data, data ? null : 'unsupported-response')
          } catch (e) {
            if (alive && !timedOut) publish(null, 'unavailable')
          } finally { window.clearTimeout(guard) }
        })()
        return () => { alive = false; window.clearTimeout(guard); controller.abort() }
      }, [key, revision])
      // 在 effect cleanup/setup 之前也不能闪现上一个 sid/seq／刷新前的状态。
      const current = state.key === key && state.revision === revision ? state : { data: null, loading: !!key, error: null }
      return { ...current, refresh: () => setRevision(n => n + 1) }
    }
    function advisorDeliveryLabel(status) {
      return ({
        'known-defects': L('存在已知缺陷', 'Known defects'),
        'verification-pending': L('验证待补', 'Verification pending'),
        'reviewed-scope': L('已复核（仅限所列范围）', 'Reviewed scope only'),
        'not-reviewed': L('尚未复核', 'Not reviewed'),
        unavailable: L('复核状态暂不可用', 'Review status unavailable'),
      })[status] || L('复核状态暂不可用', 'Review status unavailable')
    }
    function AdvisorDeliveryTail(props) {
      useLocaleLive(); useThemeLive()
      const binding = advisorDeliveryBinding(props)
      const sessionId = binding && binding.sessionId, seq = binding && binding.seq
      const state = useAdvisorDelivery(sessionId, seq)
      if (!binding) return null
      const data = state.data, status = data ? data.status : 'unavailable'
      const tone = status === 'known-defects' ? T('err') : status === 'verification-pending' ? T('warn') : T('fg3')
      const contributionLabels = {
        available: L('已有解题贡献；效果尚未核对', 'Contribution available; effect not verified'),
        'result-changed': L('产物已变化；新旧对照待核对', 'Result changed; baseline comparison pending'),
        'comparison-pending': L('新旧产物对照待核对', 'Baseline comparison pending'),
        keep: L('建议保留当前版本；不代表验收通过', 'Keep current version suggested; not acceptance'),
      }
      const checkLabels = { failed: L('失败', 'Failed'), unverified: L('未验证', 'Unverified'), stale: L('证据已过期', 'Stale evidence'), satisfied: L('本项已有证据', 'Evidence for this check') }
      return h('section', { ...themeAttrs(), 'data-po06': 'advisor-delivery', 'data-po06-delivery-status': state.loading ? 'loading' : status,
        'data-po06-delivery-session': sessionId, 'data-po06-delivery-seq': seq, 'data-po06-delivery-request': data && data.requestId || undefined,
        style: { borderLeft: '2px solid ' + tone, padding: '3px 0 3px 10px', color: T('fg2'), fontSize: '12px', lineHeight: 1.6, overflowWrap: 'anywhere', minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' } },
          h('strong', { role: 'status', style: { color: tone, fontWeight: 500 } }, state.loading ? L('交付复核状态读取中…', 'Reading delivery review status…') : advisorDeliveryLabel(status)),
          h('span', { style: { color: T('fg3'), fontSize: '11px' } }, L('第 ' + binding.turnNumber + ' 轮', 'Turn ' + binding.turnNumber)),
          h('button', { type: 'button', disabled: state.loading, onClick: state.refresh, style: { ...S.small, fontSize: '11px' },
            title: L('重新核对已记录证据与当前文件；不调用模型', 'Recheck recorded evidence against current files; no model call') }, L('刷新', 'Refresh'))),
        h('div', { style: { color: T('fg3'), fontSize: '11px' } }, L('这是本条回复的复核旁注，不代表任务完成；正文与文件分享不受拦截。', 'Review annotation for this reply, not task completion; reply text and file sharing are not intercepted.')),
        data && data.checks.length ? h('ul', { style: { paddingLeft: '18px', margin: '4px 0' } }, data.checks.map((c, i) => h('li', { key: i, 'data-po06-delivery-check': c.status },
          checkLabels[c.status] + ' · ' + c.criterion, c.action ? h('span', null, ' — ' + c.action) : null))) : null,
        data && data.contribution ? h('div', { 'data-po06-delivery-contribution': data.contribution.status, style: { marginTop: '4px' } },
          contributionLabels[data.contribution.status], data.contribution.summary ? ' · ' + data.contribution.summary : null) : null,
        data && data.limitations.length ? h('div', { style: { color: T('fg3'), fontSize: '11px', marginTop: '4px' } }, data.limitations.join(' · ')) : null,
        !state.loading ? h('div', { style: { color: T('fg3'), fontSize: '11px' } }, state.error
          ? L('宿主接口尚不可用或响应不匹配；不能确认复核状态。', 'Host endpoint unavailable or response mismatch; review status cannot be established.')
          : L('状态仅反映本次读取；文件变化后请刷新。', 'Status reflects this read only; refresh after file changes.')) : null)
    }

    // ── 注册（含单例闸门与自愈重挂）──────────────────────────────────
    // `locale` 必须声明：apply 里读 `ctx.locale`（detectLocale / LOCALE_SVC），
    // 而 cordis 对未 inject 的服务 getter 直接抛 `cannot get property "locale" without inject`
    // ⇒ 客户端 entry 进 FAILED，页面停在 "Failed to load plugins"（2026-09-22 真机崩溃，用户看到白屏）。
    exports.inject = ['slots', 'locale']
    // 读服务的**唯一入口**：任何时候都包住。
    // 两层保险缺一不可 —— ① `inject` 声明（cordis 才允许读、并把启动顺序排在服务就绪之后）；
    // ② 这里的 try/catch（万一某个 profile 没有 locale 服务，最坏是"用中文兜底"，**绝不是整页崩**）。
    const readSvc = (ctx, name) => { try { return (ctx && ctx[name]) || null } catch (e) { return null } }
    exports.apply = function apply(ctx) {
      // 抢注单例 token：**最新实例获胜**（HMR 重新求值后，旧实例必须让位）。
      // ⚠ 抢注之后要**每次挂载前复核**（isLive）——只在 apply 时刻判一次等于没判，
      // 因为那一刻 token 一定是自己刚写进去的（第一版就是这么写的，见 EV-0142）。
      let previousActiveToken=null
      try { previousActiveToken=window.__PO06_ACTIVE__; window.__PO06_ACTIVE__=INSTANCE_TOKEN } catch (e) { /* noop */ }
      const rollbackActiveToken=()=>{try{if(window.__PO06_ACTIVE__===INSTANCE_TOKEN)window.__PO06_ACTIVE__=previousActiveToken}catch{}}
      const isLive = () => {
        try { return window.__PO06_ACTIVE__ === INSTANCE_TOKEN } catch (e) { return true }
      }
      LOCALE_SVC = readSvc(ctx, 'locale')        // 语言服务的实例（LocaleFace），订阅它才能"切了就换"
      LOCALE = detectLocale(ctx)                 // 文案语言：读不到 ⇒ 中文
      // P11：发送按钮的本地化标签（0.5 走 `localeService.bind("conversation")`）。
      // 拿不到字典也不影响拦截——点击路径还有"卡片内最后一个按钮"的结构兜底。
      LOCALE_BIND = (ns) => {
        try {
          const svc = readSvc(ctx, 'locale')
          if (!svc) return null
          if (typeof svc.bind === 'function') return svc.bind(ns)
          if (typeof svc.t === 'function') return (k) => svc.t(ns ? ns + '.' + k : k)
        } catch { /* 字典不可用 */ }
        return null
      }
      const disposers = []
      const own = (fn) => { if (typeof fn === 'function') disposers.push(fn); return fn }

      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return () => {}

      // 注入一小段样式表：**只有内联样式表达不了的东西**——伪类（hover/active/focus-visible）、
      // 滚动条外观、关键帧动效。已注入过就跳过；卸载即摘（本文件的"卸载即净"纪律）。
      // 失败也不影响功能：最坏情况是"没有悬停反馈、看得见一根默认滚动条"，而不是点不动/滚不动。
      const uiCssId = NS + '-ui'
      // ⚠ 这张表**同时承载整张主题 token 表**（见下面 ⑥ 那一段的 `themeTokensCss()`）：
      //   它一旦不在场，所有 `var(--po06-*)` 都取不到值 ⇒ **每块面板的底色一起变透明**
      //   （真机现象：文字直接压在会话内容上，看着像"背景突然消失"）。
      //   所以它的生命周期**不能**按"谁建的谁摘"来管：宿主重载客户端模块时，新实例的 apply 可能
      //   跑在旧实例卸载之前 —— 新实例看到"已存在"就跳过注入、又没有接管属主，接着旧实例按
      //   "卸载即净"把它摘掉 ⇒ 活着的实例手上没有表，底色集体消失。
      const uiCssOwner = INSTANCE_TOKEN
      const buildUiCss = () => [
            // ① 思维层：隐藏滚动条外观，**保留滚动能力**
            '[data-po06="intercept-think-body"]{scrollbar-width:none;-ms-overflow-style:none}',
            '[data-po06="intercept-think-body"]::-webkit-scrollbar{width:0;height:0;display:none}',
            // ② 全局滑块（0.5 形态）：细、低调，悬停才明显
            '[data-po06="intercept-scroll"]{scrollbar-width:thin;scrollbar-color:rgba(127,127,127,.35) transparent}',
            '[data-po06="intercept-scroll"]::-webkit-scrollbar{width:10px;height:10px}',
            '[data-po06="intercept-scroll"]::-webkit-scrollbar-track{background:transparent}',
            '[data-po06="intercept-scroll"]::-webkit-scrollbar-thumb{background-color:rgba(127,127,127,.30);border:3px solid transparent;border-radius:8px;background-clip:content-box}',
            '[data-po06="intercept-scroll"]::-webkit-scrollbar-thumb:hover{background-color:rgba(127,127,127,.55);background-clip:content-box}',
            // ③ 交互反馈：所有插件按钮统一 130ms 过渡；悬停一层极淡底色；按下轻微下沉；键盘焦点有描边；禁用降透明
            '[data-po06] button{transition:background-color .13s ease,border-color .13s ease,color .13s ease,transform .12s ease,opacity .13s ease}',
            '[data-po06] button:hover{background-color:var(--po06-hover)}',
            '[data-po06] button:active{transform:translateY(.5px)}',
            '[data-po06] button:focus-visible{outline:2px solid ' + OVS.acc + ';outline-offset:2px}',
            // 数值类徽标（字数 / token / 用时）用等宽数字，跳动时不抖
            '[data-po06] [data-po06="inject-card-chars"],[data-po06] [data-po06="injection-row-chars"]{font-variant-numeric:tabular-nums}',
            '[data-po06] button:disabled{opacity:.45;cursor:not-allowed;transform:none}',
            '[data-po06="bar"] button{background-color:transparent}',
            '[data-po06="bar"] button:hover{background-color:var(--po06-hover)!important}',
            // ④ 极简动效：面板入场只做**透明度** · 跑起来时状态灯呼吸 · 思维层新内容淡入
            // ⚠⚠ **绝对不要给 `[data-po06="intercept"]` 加带 transform 的动画**：它的位置就是内联的
            //   `transform: translate3d(...)`（拖拽写进去的那一条），而 **CSS 动画的填充会盖过内联样式**
            //   ⇒ 动画一旦带 transform，面板就**拖不动了**。（2026-09-22 真机回归：`po06-rise` 的
            //   `to{transform:none}` + `both` 把面板钉死，拖拽只改状态、画面不动。）
            //   位移类动效要放就放到**内层**元素上（内层没有 transform 通道）。
            '@keyframes po06-fade-in{from{opacity:0}to{opacity:1}}',
            '@keyframes po06-breathe{0%,100%{opacity:1}50%{opacity:.42}}',
            '@keyframes po06-fade{from{opacity:.4}to{opacity:1}}',
            // 2026-10-19 观感收口：弹出层/提示卡入场做**短促的浮起**（位移只在这一层，不碰带内联 transform 的面板）
            '@keyframes po06-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}',
            '@keyframes po06-row{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
            '@keyframes po06-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(4px) scale(.99)}}',
            // ⚠ !important 是必须的：入场规则（po06-pop/po06-help）与这条**同优先级**且写在后面，
            //   而入场动画是 fill-mode:both（播完仍占着 animation 槽）。不加 !important 时退场动画根本不会接管，
            //   元素就"啪一下消失"——2026-10-19 真机就是这个问题（优化选项 / ? / 拦截面板都没有退场）。
            '[data-po06-closing="1"]{animation:po06-out .16s ease-in both !important;pointer-events:none}',
            '[data-po06="intercept"][data-po06-closing="1"]{animation:po06-out-fade .24s ease-in both !important}',
            // 拦截面板的「果冻」入场/退场（2026-10-19 用户要求）：
            //   · 挤压—拉伸—回弹（不是等比缩放弹跳），且回弹收敛到静止；
            //   · **逐组件**错峰，间隔不等距（0/55/120/175ms），滚动区里的区块再往后压；
            //   · 只动 transform/opacity（不碰尺寸），所以自适应用户拉大拉小都不受影响；
            //   · 退场更短促：先轻微软塌再淡出，总时长控制在 260ms 内（与 ovExit 对齐）。
            '@keyframes po06-jelly-in{0%{opacity:0;transform:translate3d(0,7px,0) scale(.94,.88)}55%{opacity:1;transform:translate3d(0,-1px,0) scale(1.014,1.028)}76%{transform:translate3d(0,.5px,0) scale(.997,.992)}100%{opacity:1;transform:none}}',
            '@keyframes po06-jelly-out{0%{opacity:1;transform:none}55%{opacity:.62;transform:translate3d(0,2px,0) scale(1.008,.96)}100%{opacity:0;transform:translate3d(0,6px,0) scale(.97,.9)}}',
            '[data-po06="intercept"][data-po06-closing="0"] > *{animation:po06-jelly-in .42s cubic-bezier(.2,.9,.3,1) both}',
            '[data-po06="intercept"][data-po06-closing="0"] > *:nth-child(2){animation-delay:55ms}',
            '[data-po06="intercept"][data-po06-closing="0"] > *:nth-child(3){animation-delay:120ms}',
            '[data-po06="intercept"][data-po06-closing="0"] > *:nth-child(n+4){animation-delay:175ms}',
            '[data-po06="intercept"][data-po06-closing="0"] [data-po06="intercept-scroll"] > *{animation:po06-jelly-in .4s cubic-bezier(.2,.9,.3,1) both;animation-delay:95ms}',
            '[data-po06="intercept"][data-po06-closing="0"] [data-po06="intercept-scroll"] > *:nth-child(2){animation-delay:145ms}',
            '[data-po06="intercept"][data-po06-closing="0"] [data-po06="intercept-scroll"] > *:nth-child(3){animation-delay:195ms}',
            '[data-po06="intercept"][data-po06-closing="0"] [data-po06="intercept-scroll"] > *:nth-child(n+4){animation-delay:245ms}',
            '[data-po06="intercept"][data-po06-closing="1"] > *{animation:po06-jelly-out .16s ease-in both}',
            '[data-po06="intercept"][data-po06-closing="1"] > *:nth-child(2){animation-delay:24ms}',
            '[data-po06="intercept"][data-po06-closing="1"] > *:nth-child(n+3){animation-delay:48ms}',
            '[data-po06="intercept"][data-po06-closing="1"] [data-po06="intercept-scroll"] > *{animation:po06-jelly-out .15s ease-in both;animation-delay:18ms}',
            // 「逐渐展开」（2026-10-19）：面板正文用 clip-path 自上而下揭开，像把内容"放出来"，
            // 不改宽高（尺寸自适应不受影响），只裁可见区域；配合下面的逐按钮浮现。
            '@keyframes po06-unfold{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}',
            '[data-po06="intercept"][data-po06-closing="0"] [data-po06="intercept-scroll"]{animation:po06-unfold .38s cubic-bezier(.2,.9,.3,1) both;animation-delay:70ms}',
            // 各个按钮/输入区也跟着逐个浮现（每个父容器内按顺序错峰，读起来是"一层层打开"）
            '[data-po06="intercept"][data-po06-closing="0"] button,[data-po06="intercept"][data-po06-closing="0"] textarea{animation:po06-jelly-in .34s cubic-bezier(.2,.9,.3,1) both;animation-delay:170ms}',
            '[data-po06="intercept"][data-po06-closing="0"] button:nth-of-type(2){animation-delay:205ms}',
            '[data-po06="intercept"][data-po06-closing="0"] button:nth-of-type(3){animation-delay:240ms}',
            '[data-po06="intercept"][data-po06-closing="0"] button:nth-of-type(n+4){animation-delay:270ms}',
            '[data-po06="intercept"][data-po06-closing="1"] button,[data-po06="intercept"][data-po06-closing="1"] textarea,[data-po06="intercept"][data-po06-closing="1"] [data-po06="intercept-scroll"]{animation:po06-jelly-out .15s ease-in both;animation-delay:14ms}',
            // 完成/跳过后的**状态切换**也要软：footer 与正文区块「收一下再定住」，
            // 而不是文字突然换掉（用户 2026-10-19："完成发送/跳过发送时也要灵动"）。
            '@keyframes po06-settle{0%{opacity:.55;transform:translate3d(0,5px,0) scale(.985,.94)}58%{opacity:1;transform:translate3d(0,-1px,0) scale(1.006,1.02)}100%{opacity:1;transform:none}}',
            '[data-po06="intercept"][data-po06-phase="sent"] [data-po06="intercept-foot"],' +
              '[data-po06="intercept"][data-po06-phase="skipped"] [data-po06="intercept-foot"]{animation:po06-settle .34s cubic-bezier(.2,.9,.3,1) both}',
            '[data-po06="intercept"][data-po06-phase="sent"] [data-po06="intercept-scroll"] > *,' +
              '[data-po06="intercept"][data-po06-phase="skipped"] [data-po06="intercept-scroll"] > *{animation:po06-settle .32s cubic-bezier(.2,.9,.3,1) both}',
            // 离场分性格：完成发送 = 收束（向下软塌、稍慢）；跳过发送 = 放行（向上弹开、干脆）
            '@keyframes po06-release{0%{opacity:1;transform:none}55%{opacity:.72;transform:translate3d(0,-2px,0) scale(1.012,.93)}100%{opacity:0;transform:translate3d(0,-5px,0) scale(.985,.88)}}',
            '[data-po06="intercept"][data-po06-closing="1"][data-po06-exit="sent"] > *,' +
              '[data-po06="intercept"][data-po06-closing="1"][data-po06-exit="sent"] button,' +
              '[data-po06="intercept"][data-po06-closing="1"][data-po06-exit="sent"] [data-po06="intercept-scroll"] > *{animation:po06-jelly-out .2s ease-in both !important}',
            '[data-po06="intercept"][data-po06-closing="1"][data-po06-exit="skipped"] > *,' +
              '[data-po06="intercept"][data-po06-closing="1"][data-po06-exit="skipped"] button,' +
              '[data-po06="intercept"][data-po06-closing="1"][data-po06-exit="skipped"] [data-po06="intercept-scroll"] > *{animation:po06-release .15s cubic-bezier(.3,.7,.4,1) both !important}',
            '@keyframes po06-out-fade{from{opacity:1}to{opacity:0}}',
            '[data-po06="intercept"][data-po06-closing="1"]{animation:po06-out-fade .16s ease-in both}',
            // 档位特效（2026-10-19）：粒子湍流 + 重度档的轻微颤抖
            // 标准档：无序随机线性飘动（方向/时长由每个粒子的内联变量决定，alternate 来回）
            '@keyframes po06-drift{from{transform:translate3d(0,0,0)}to{transform:translate3d(var(--dx,10px),var(--dy,-8px),0)}}',
            // 重度档：白色流星从右向左穿过（顿挫感由 linear + 不同时长制造）
            // 流星：从右侧外面进来（left:100%），行程由每个粒子自己的 --dist 决定，末端淡出
            // 流星撞右边界：亮度与横向拉伸一起起伏，像被冲击推起的浪
            '@keyframes po06-shock{0%,100%{opacity:.22;transform:scaleX(.9) translateX(6px)}45%{opacity:.95;transform:scaleX(1.12) translateX(0)}70%{opacity:.55;transform:scaleX(.99) translateX(3px)}}',
            '@keyframes po06-shock-rim{0%,100%{opacity:.25;transform:scaleY(.9)}45%{opacity:.95;transform:scaleY(1.05)}70%{opacity:.5;transform:scaleY(.97)}}',
            '@keyframes po06-meteor{0%{transform:translate3d(0,0,0);opacity:0}8%{opacity:.95}70%{opacity:.7}100%{transform:translate3d(var(--dist,-320px),0,0);opacity:0}}',
            // 帮助弹层单独用一条更轻的入场（大块文字 + 阴影一起做 scale 会顿）
            '@keyframes po06-help{from{opacity:0;transform:translate3d(0,4px,0)}to{opacity:1;transform:none}}',
            '@keyframes po06-shake{0%,100%{transform:translate3d(0,0,0)}20%{transform:translate3d(.5px,-.4px,0)}40%{transform:translate3d(-.4px,.5px,0)}60%{transform:translate3d(.4px,.3px,0)}80%{transform:translate3d(-.3px,-.4px,0)}}',
            // 弹层（2026-10-19）：按用途给不同入场——面板从按钮方向浮起、帮助从右下滑入、弹窗带一点回弹
            '[data-po06="options-pop"],[data-po06="inject-card"]{animation:po06-pop .2s cubic-bezier(.2,.8,.2,1) both}',
            '[data-po06="help-pop"]{animation:po06-help .14s ease-out both;will-change:opacity,transform}',
            '[data-po06="preset-notice-backdrop"]{animation:po06-fade-in .16s ease-out both}',
            '[data-po06="preset-notice"]{animation:po06-pop .26s cubic-bezier(.2,.9,.25,1.04) both}',
            // 面板内容逐行浮现（错开 18ms，最多 10 行）：像"一点点展开"，而不是整块砸下来
            // 密度档（边界自动挤压）：空间不够就缩间距/行高/字号，而不是顶出屏幕或立刻滚动
            '[data-po06="options-pop"][data-po06-density="1"]{gap:5px !important;padding:10px 12px 6px !important}',
            '[data-po06="options-pop"][data-po06-density="1"] > div{min-height:24px !important}',
            '[data-po06="options-pop"][data-po06-density="1"] button{font-size:11.5px}',
            '[data-po06="options-pop"][data-po06-density="2"]{gap:4px !important;padding:8px 10px 6px !important}',
            '[data-po06="options-pop"][data-po06-density="2"] > div{min-height:22px !important}',
            '[data-po06="options-pop"][data-po06-density="2"] button{font-size:11px}',
            '[data-po06="options-pop"] > *{animation:po06-row .22s ease-out both}',
            ...Array.from({ length: 10 }, (_, i) => '[data-po06="options-pop"] > *:nth-child(' + (i + 1) + '){animation-delay:' + (i * 18) + 'ms}'),
            '[data-po06="intercept"]{animation:po06-fade-in .16s ease-out both}',
            '[data-po06="intercept"] [data-po06="intercept-head"]{animation:po06-fade-in .22s ease-out both}',
            '[data-po06="intercept"][data-po06-phase="optimizing"] [data-po06="state-dot"],'
              + '[data-po06="bar"][data-po06-busy="1"] [data-po06="state-dot"]{animation:po06-breathe 1.15s ease-in-out infinite}',
            '[data-po06="intercept-think-body"]{animation:po06-fade .18s ease-out both}',
            // ⑤ 尊重系统的"减少动态效果"
            '@media (prefers-reduced-motion: reduce){[data-po06] *{animation:none !important;transition:none !important}}',
            // ⑥ 主题副色（DSH 的 accent，原版是蓝）：只用在"选中 / 悬停 / 焦点"三处，克制不铺满
            // ⚠ 这一行同时是**整张主题 token 表**的落点：浅色为默认，深色用 DSH 的 `[data-ds-dark-theme]` 覆盖。
            //   （见 THEME_TOKENS 顶部那段说明：题目是"颜色由主题驱动"，不是"给浅色打补丁"。）
            themeTokensCss(),
            '[data-po06] button:hover{border-color:color-mix(in srgb, var(--po06-acc) 45%, transparent)}',
            '[data-po06="options-pop"] button:hover{background-color:var(--po06-hover)!important;border-color:var(--po06-acc20,rgba(127,127,127,.22))}',
            '[data-po06="options-btn"]:hover{color:var(--po06-acc)}',
            '[data-po06="intercept-scroll"]:focus-visible,[data-po06] [role="slider"]:focus-visible{outline:2px solid var(--po06-acc);outline-offset:1px}',
            // ⑦ 原生下拉的**面板**配色：深色主题下不能白底白字（Chromium 认这几条）
            '[data-po06] select{color-scheme:inherit}',
            '[data-po06] select option{background:var(--po06-surface);color:var(--po06-fg)}',
            '[data-po06] select option:checked{background:' + OVS.acc22 + ';color:' + OVS.acc + '}',
      ].join('')
      /**
       * 确保样式表在场：**缺失就建、已存在就接管属主并把内容刷新成当前代码的那份**。
       * 接管是关键：只判"在不在"等于默认"旧实例会把它摘掉"，而这正是故障本身。
       * 顺带刷新 textContent，让热重载后的新样式生效（旧实例留下的那份可能已经过期）。
       */
      const ensureUiCss = () => {
        try {
          let tag = document.getElementById(uiCssId)
          if (!tag) {
            tag = document.createElement('style')
            tag.id = uiCssId
            document.head.appendChild(tag)
          }
          tag.textContent = buildUiCss()
          tag.__po06Owner = uiCssOwner
          return tag
        } catch (e) { return null }   // 取不到 DOM 时不影响功能：最坏是没有悬停反馈
      }
      ensureUiCss()
      // 卸载即净：**只有仍归我所有**才摘。旧实例退休时若新实例已接管，就不许摘（上面那段竞态）。
      // ⚠ 必须按 id 取**当前**那一张，不能闭包捕获注入时的那张：自愈会重建元素，
      //   捕获旧引用会让"新表留在 DOM 里、被摘的是已脱离文档的旧表" ⇒ 卸载不净（本用例抓到过）。
      own(() => {
        try {
          const tag = document.getElementById(uiCssId)
          if (tag && tag.__po06Owner === uiCssOwner) tag.remove()
        } catch (e) { /* 已被别处摘掉 */ }
      })
      // 兜底自愈：这张表被摘掉等于"底色全没"，而摘它的可能是任何一方（旧实例、宿主换 head、
      // 扩展清 DOM）。只查一次不够，所以盯住 head 的子节点变化，发现自己的表没了就补回来。
      // 退休实例不补（isLive 为假），把机会留给新实例，避免两个实例互相盖。
      try {
        if (typeof MutationObserver === 'function' && document.head) {
          const cssWatch = new MutationObserver(() => { if (isLive() && !document.getElementById(uiCssId)) ensureUiCss() })
          cssWatch.observe(document.head, { childList: true })
          own(() => { try { cssWatch.disconnect() } catch (e) { /* 已断开 */ } })
        }
      } catch (e) { /* 观察不到 head 也不致命：本实例自己注入的那张仍在 */ }

      /**
       * **虚拟 POSIX 工具在对话流里的专属卡片**（2026-09-24，用户要求）。
       *
       * 为什么必须自己画一张：宿主的 `card:'terminal'` 只是给工具**声明一个呈现意图**，
       * 但当前 UI 把终端卡渲染成统一的"运行命令 · <摘要>"，**和 pwsh 调用长得一样**——
       * 用户原话："工作ai调用命令时，还是和原来的图标一样，看上去就像没有在正常使用新的虚拟工具"。
       * 宿主的插槽表里有 `tool.call.toolview`（**按 wire 工具名 keyed 分发**，`posix` 这个 key 没人占），
       * 注册它就能接管该工具的卡片，用自己的图标/徽标/正文把"这是虚拟层执行的、不是 PowerShell"说清楚。
       *
       * 契约（来自插槽目录的 ownerProps）：
       *   · `phase`：`preparing`（参数还在流式到来）/ `start`（已派发）/ `result`（已结算）；
       *   · `block`：dispatched 时 `block.call.argsRaw` 是原始 JSON 字符串；结算后是 `block.call` + `block.value` + `block.isError`；
       *   · `useToolCallArgumentsPartial()` 可选：preparing 阶段订阅参数前缀。
       * **全部按可选处理**：宿主换版本、字段改名都不该把对话流弄崩（画不出来就退回朴素一行）。
       */
      const POSIX_CARD_STYLE = {
        root: {
          border: '1px solid ' + OVS.line, borderRadius: '8px', overflow: 'hidden',
          background: OVS.bg, margin: '6px 0', fontFamily: 'inherit',
        },
        head: {
          display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px',
          background: OVS.bg2, borderBottom: '1px solid ' + OVS.line, fontSize: '12px',
        },
        icon: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontWeight: 700, fontSize: '13px', color: OVS.acc,
          background: OVS.acc22, borderRadius: '4px', padding: '1px 5px', lineHeight: '16px',
        },
        pill: {
          fontSize: '10px', lineHeight: '14px', padding: '1px 6px', borderRadius: '999px',
          color: OVS.acc, background: OVS.acc22, border: '1px solid ' + OVS.acc44,
          letterSpacing: '0.04em', whiteSpace: 'nowrap',
        },
        cmd: {
          flex: '1 1 auto', minWidth: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '12px', color: OVS.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
        note: { fontSize: '11px', color: OVS.dim, whiteSpace: 'nowrap' },
        body: {
          margin: 0, padding: '8px 10px', maxHeight: '260px', overflow: 'auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '11.5px', lineHeight: '1.5', color: OVS.fg, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
        refused: { color: OVS.warn },
      }
      /** 从 block 里尽量取出「命令原文」——三种阶段都试，取不到就空串。 */
      const posixCommandOf = (props) => {
        const b = props && props.block
        try {
          const raw = b && b.call && typeof b.call.argsRaw === 'string' ? b.call.argsRaw
            : (b && typeof b.argsRaw === 'string' ? b.argsRaw : '')
          if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed.command === 'string') return parsed.command
          }
        } catch (e) { /* 参数还没流完：不猜，退回空串 */ }
        return ''
      }
      /** 从 block 里取「结果正文」。 */
      const posixOutputOf = (props) => {
        const b = props && props.block
        if (!b) return ''
        if (typeof b.value === 'string') return b.value
        if (b.value && typeof b.value.output === 'string') return b.value.output
        if (typeof b.text === 'string') return b.text
        return ''
      }
      const PosixToolRow = (props) => {
        const phase = props && props.phase
        const running = phase === 'preparing' || phase === 'start'
        const partial = typeof props.useToolCallArgumentsPartial === 'function' ? (() => { try { return props.useToolCallArgumentsPartial() } catch (e) { return '' } })() : ''
        const cmd = posixCommandOf(props) || (running && partial ? String(partial) : '')
        const out = running ? '' : posixOutputOf(props)
        const refused = !running && out.trim().startsWith('拒绝')
        const isError = !!(props && props.block && props.block.isError)
        const head = h('div', { style: POSIX_CARD_STYLE.head },
          h('span', { style: POSIX_CARD_STYLE.icon, title: L('虚拟 POSIX（插件内执行）','Virtual POSIX (runs inside the plugin)') }, '$_'),
          h('span', { style: POSIX_CARD_STYLE.pill, title: L('由插件用纯 JS 执行：不经过 PowerShell、不依赖系统命令、只读','Runs inside the plugin in plain JS: no PowerShell, no system commands, read-only') }, L('虚拟', 'Virtual')),
          h('span', { style: POSIX_CARD_STYLE.cmd, title: cmd || '' }, cmd || L('（命令读取中…）', '(reading command…)')),
          h('span', { style: POSIX_CARD_STYLE.note },
            running ? L('执行中…', 'running…')
              : refused ? L('已拒绝', 'refused')
                : isError ? L('出错', 'error')
                  : L('只读', 'read-only')),
        )
        const body = running ? null : h('pre', {
          style: refused ? { ...POSIX_CARD_STYLE.body, ...POSIX_CARD_STYLE.refused } : POSIX_CARD_STYLE.body,
        }, out || L('（无输出）', '(no output)'))
        return h('div', { 'data-po06': 'posix-tool', 'data-po06-posix': refused ? 'refused' : (isError ? 'error' : 'ok'), style: POSIX_CARD_STYLE.root }, head, body)
      }

      /**
       * 注册一个插槽。**必须真的调用 attach()**——
       * 第一版只把 attach 塞进释放列表而没调用它，结果是：客户端模块加载成功、apply 执行、
       * 单例 token 也写了，**但一个界面元素都没注册**（真机 DOM 实测：`allCount: 0`，见 EV-0142）。
       */
      const mounts = {}
      const remounts = {}
      const attach = (slot, id, order, Component) => {
        if (!isLive()) return null
        if (typeof mounts[slot] === 'function') { try { mounts[slot]() } catch (e) { /* noop */ } mounts[slot] = null }
        const register = () => ctx.slots.register({ name: slot, id, order }, Component)
        mounts[slot] = (typeof ctx.slots.inject === 'function') ? ctx.slots.inject(slot, register) : register()
        return mounts[slot]
      }
      const mount = (slot, id, order, Component) => {
        try {
          attach(slot, id, order, Component)                     // ← 立刻注册（这一行曾经缺失）
        } catch (e) {
          rollbackActiveToken()                                  // 不许留下「有身份、没界面」的实例
          try { console.error('[po06] mount failed:', slot, e) } catch (err) { /* noop */ }
          return null
        }
        own(() => { if (typeof mounts[slot] === 'function') { try { mounts[slot]() } catch (e) { /* noop */ } } })
        remounts[slot] = () => attach(slot, id, order, Component)  // 供自愈重挂
        return remounts[slot]
      }
      /**
       * keyed 座位的**占位优先级**（`ui-slots` 的 `priority`，升序、**最小者渲染**）。
       *
       * 为什么必须显式给（2026-10-04 桌面端真机）：
       *   宿主自己带一个**演示用**的 bash 行 `bash-toolview-sample`，它占的 key 也是 `bash`、
       *   priority 取默认 0。而 `ui-slots` 的裁决是"**同 key + 同 priority 直接抛错**" ⇒
       *   谁的注册排在后面谁就抛、谁先到谁留下。web 端我们的 bundle 先到 ⇒ 看到的是我们的 `$_` 卡；
       *   桌面端加载顺序反过来 ⇒ 我们的注册抛错、留下宿主的 `>-` 卡（其余插槽照常，所以界面没崩）。
       *   给一个更小的 priority 之后：无论加载顺序都归我们，且两边不再同优先级、不再有人抛错。
       * 为什么是 -10 而不是 -1：留出余量，别的插件想插在中间（-1..-9）仍有位置。
       */
      const KEYED_PRIORITY = -10
      /**
       * 注册一个 **keyed** 插槽（`tool.call.toolview` 那种"按 key 分发"的座位）。
       * 与 `mount` 的区别只在注册参数：keyed 座位要 `{ name, key }`。
       * `key` 就是 **wire 工具名**（宿主的 keyDomain 是开放的：`posix` 这个 key 此前没人占）。
       * 注：宿主说"注册已占用的 key 会**替换**该视图"，所以我们只占自己工具的名字，不碰别人的；
       * 占位优先级见 `KEYED_PRIORITY`（同 key 同优先级会抛错，不能靠默认值赌顺序）。
       */
      const mountKeyed = (slot, key, Component) => {
        if (!isLive()) return null
        const id = NS + ':' + key
        if (typeof mounts[id] === 'function') { try { mounts[id]() } catch (e) { /* noop */ } mounts[id] = null }
        const register = () => ctx.slots.register({ name: slot, key, priority: KEYED_PRIORITY }, Component)
        mounts[id] = (typeof ctx.slots.inject === 'function') ? ctx.slots.inject(slot, register) : register()
        own(() => { if (typeof mounts[id] === 'function') { try { mounts[id]() } catch (e) { /* noop */ } } })
        return mounts[id]
      }

      // ① 控件栏（P10 换的挂载点：从 conversation.input.dock 搬到 conversation.input.left；
      //    旧的小胶囊**不再挂载**——"胶囊 + 一排控件"同时出现只会更乱）
      mount('conversation.input.left', 'prompt-optimizer', 20, ControlBar)
      mount('shell.overlay', NS + '-panel', 40, () => null)   // 面板本体在控件栏里渲染；这一条保证浮层槽可用
      mount('settings.plugins.tab', NS, 40, SettingsTab)
      // ⑤ 「本次注入」卡片：挂宿主的 **commandview** 子槽（按命令名分发，/vmake 同款机制）。
      //    行锚是宿主已知的 command/run + command/done 事件（插件写安全），正文来自插件内存。
      mountKeyed('conversation.chat.commandview', INJECTION_COMMAND, InjectionCommandCard)
      // 独立 list 项：不覆盖宿主文件卡片，也不接管 assistant 文本或停止边界。
      // 2026-10-18 用户指定：回复尾部不再挂复核旁注卡。
      void AdvisorDeliveryTail
      // ④ 虚拟 POSIX 工具在对话流里的**专属卡片**（用户 2026-09-24 要求：要能一眼看出用的是虚拟工具，
      //    而不是和 pwsh 一样的"运行命令"）。keyed 座位按 wire 工具名分发，我们只占 `posix`。
      // ── 内置 Bash 的专属卡片（0.7.3）──────────────────────────────────────
      // **原样复用**原插件的组件（同一份代码），不另做一套界面。
      // 原实现在 po06/lib/bash/client.js，但它是独立的 __ModuleLoader__ 模块
      // （id = dsh-bash-runtime）；并入本插件后**没有任何地方加载它** ⇒ 它的
      // key:'bash' 注册从未执行 ⇒ 卡片回落到宿主的通用工具样式。
      // 这里把同一份组件包进 IIFE（避免与 po06 自己的 S / C / h 符号冲突），
      // 再按本插件既有的 keyed 挂载方式注册同一个 key。
      const BashToolRow = (() => {
const react = require("react")
    const e = (type, props, ...children) => react.createElement(type, props, ...children)

    let primitivesCache
    const primitives = () => {
      if (primitivesCache !== undefined) return primitivesCache
      try {
        const mod = require("@deepseek-ai/dsh-client-ui-primitives")
        primitivesCache = mod && typeof mod.TerminalBlock === "function" ? mod : null
      } catch (err) { primitivesCache = null }
      return primitivesCache
    }

    const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace"
    const C = {
      fg: "var(--dsw-alias-label-primary, #1f1f1f)",
      dim: "var(--dsw-alias-label-tertiary, #8a8a8a)",
      err: "var(--dsw-alias-state-error-primary, #c0392b)",
      line: "var(--dsw-alias-border-l2, #e5e5e5)",
    }
    const S = {
      row: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", lineHeight: "18px", cursor: "pointer", userSelect: "none", padding: "1px 0" },
      icon: { flex: "0 0 auto", width: "16px", textAlign: "center", fontFamily: MONO, fontWeight: 600, color: C.dim },
      title: { flex: "0 0 auto", color: C.fg },
      sep: { flex: "0 0 auto", color: C.dim },
      cmd: { flex: "1 1 auto", minWidth: 0, fontFamily: MONO, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      caret: { flex: "0 0 auto", color: C.dim, fontSize: "10px" },
      body: { marginTop: "6px" },
      fallback: { margin: 0, padding: "8px 10px", border: "1px solid " + C.line, borderRadius: "6px", fontFamily: MONO, fontSize: "11.5px", lineHeight: 1.5, color: C.fg, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "260px", overflow: "auto" },
    }

    const argsOf = (props) => {
      try {
        const b = props && props.block
        const raw = b && b.call && typeof b.call.argsRaw === "string" ? b.call.argsRaw : ""
        return raw ? JSON.parse(raw) : null
      } catch (err) { return null }
    }
    /** 结果正文：宿主把已结算文本放在 block.content（一个 {type:"text",text} 数组），
     *  与客户端 singleResultText() 同源。此前读 block.value 取不到 → 显示"(无输出)"。 */
    const outputOf = (props) => {
      const b = props && props.block
      if (!b) return ""
      if (Array.isArray(b.content)) {
        const texts = b.content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text)
        if (texts.length > 0) return texts.join("\n")
      }
      if (typeof b.value === "string") return b.value
      if (b.value && typeof b.value.output === "string") return b.value.output
      if (typeof b.text === "string") return b.text
      return ""
    }
    const statusOf = (out) => {
      const sig = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(out || "")
      if (sig && sig[1] !== undefined) return { signal: sig[1], output: out.slice(0, sig.index) }
      const ex = /\n\[exit code: (\d+)\]$/.exec(out || "")
      if (ex && ex[1] !== undefined) return { exitCode: Number(ex[1]), output: out.slice(0, ex.index) }
      // 没有标记 → undefined（不渲染状态药丸）；null 会被原语显示成"无退出码"红药丸，
      // 而解析不到标记通常只是本工具没写标记，不代表命令没有退出码。
      return { exitCode: undefined, output: out || "" }
    }
    // 2026-10-19：这些标签以前是**写死的中文**，DSH 切英文后整张 bash 卡片还是中文。
    // 现在全部走 L(zh, en)：语言只管一个来源（DSH 的 locale 服务）。
    const LABELS = {
      signal: (s) => L("信号 " + s, "signal " + s),
      exitCode: (c) => L("退出码 " + c, "exit " + c),
      noExitCode: L("无退出码", "no exit code"),
      running: L("运行中", "running"),
      failed: L("失败", "failed"),
      done: L("完成", "done"),
      copy: L("复制", "copy"),
      copied: L("已复制", "copied"),
      noOutput: L("（无输出）", "(no output)"),
      collapseAria: L("收起输出", "Collapse output"),
      collapse: L("收起", "Collapse"),
      expandAria: (n) => L("展开剩余 " + n + " 行", "Show remaining " + n + " lines"),
      expand: (n) => L("展开剩余 " + n + " 行", "Show remaining " + n + " lines"),
    }

    function BashRow(props) {
      const [open, setOpen] = react.useState(false)
      const phase = props && props.phase
      const running = phase === "preparing" || phase === "start"
      const args = argsOf(props) || {}
      const partial = typeof props?.useToolCallArgumentsPartial === "function"
        ? (() => { try { return props.useToolCallArgumentsPartial() } catch (err) { return "" } })()
        : ""
      const cmd = typeof args.command === "string" ? args.command : (running && partial ? String(partial) : "")
      const settled = statusOf(running ? "" : outputOf(props))
      const failed = !!(props && props.block && props.block.isError) || (settled.exitCode !== undefined && settled.exitCode !== 0) || !!settled.signal

      const head = e("div", {
        style: S.row,
        onClick: () => setOpen((v) => !v),
        role: "button",
        tabIndex: 0,
        onKeyDown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpen((v) => !v) } },
        "aria-expanded": open,
      },
        e("span", { style: failed ? { ...S.icon, color: C.err } : S.icon, title: L("内置 Bash（插件自带 GNU bash/MSYS2 运行时：无需 WSL、不经过 PowerShell）", "Built-in Bash (bundled GNU bash/MSYS2 runtime: no WSL, no PowerShell)") }, "$_"),
        e("span", { style: S.title }, L("运行命令", "Run command")),
        e("span", { style: S.sep }, "·"),
        e("span", { style: S.cmd, title: cmd || "" }, cmd || (running ? L("（读取参数…）", "(reading arguments…)") : L("（未读到命令）", "(command unavailable)"))),
        e("span", { style: S.caret }, open ? "▾" : "▸"),
      )

      if (!open) return head

      // 2026-09-25：命令参数还没流到时**不渲染可执行卡片**。此前会渲染一个空的 TerminalBlock
      // （"（读取参数…）" + 空框）；若此刻被外层超时/取消，界面上就只剩这张空卡片，
      // 看起来像"命令是空的"故障。参数就绪后会自动进入正常渲染。
      if (!cmd && running) {
        return e("div", null, head, e("div", { style: S.body },
          e("div", { style: { fontSize: "11px", color: C.dim } }, L("正在接收命令参数…", "Receiving command arguments…"))))
      }

      const P = primitives()
      const body = P
        ? e(P.TerminalBlock, {
            command: cmd,
            cwd: typeof args.workdir === "string" && args.workdir ? args.workdir : undefined,
            output: running ? undefined : settled.output,
            exitCode: running ? undefined : settled.exitCode,
            signal: running ? undefined : settled.signal,
            running,
            copyText: cmd,
            runStateDot: false,
            labels: LABELS,
          })
        : e("pre", { style: S.fallback },
            "$ " + (cmd || "") + "\n" + (running ? "" : (settled.output || L("（无输出）", "(no output)"))) +
            (running ? "" : (settled.exitCode !== undefined ? "\n[exit code: " + settled.exitCode + "]" : "")))

      return e("div", null, head, e("div", { style: S.body }, body))
    }

    function Safe(fn) {
      return function (props) {
        try { return fn(props) } catch (err) {
          return e("div", { style: { fontSize: "11px", color: C.dim }, title: String(err) }, L("（bash 卡片渲染降级）", "(bash card degraded)"))
        }
      }
    }
        return BashRow
      })()
      mountKeyed('tool.call.toolview', 'posix', PosixToolRow)
      mountKeyed('tool.call.toolview', 'bash', BashToolRow)
      mountKeyed('tool.call.toolview', 'consult_task', AdvisorToolRow)

      // 测试钩子：让 Node 侧的单测能真的驱动"重挂"这条路（用来验单例闸门）。
      // 生产路径不读它；带 __ 前缀以免与宿主契约上的字段混淆。
      // `locale` / `detectLocale` 用来钉住"语言只来自 DSH 的 locale 服务"这条契约（真机事故：猜属性名 ⇒ 恒中文）。
      exports.__debug = {
        remount: (slot) => (typeof remounts[slot] === 'function' ? remounts[slot]() : null),
        locale: () => LOCALE,
        detectLocale,
        // 主题调色板（单测拿它算对比度：浅色模式"看不清"这类问题要能被机器挡住，不能只靠肉眼）
        AdvisorControls,EnglishControls,outgoingUserText,injectionCardModel, InjectIcon, Segmented, InferenceControls, InferenceMonitor, InferenceEvidenceDetails, InferenceRecordedPlan, inferenceStageLabel, inferencePaceLabel, InterceptPanel, InterceptDraftBody, interceptDraftOutput, advisorValueOf, advisorArgsOf, advisorDraftReply, advisorProgressPct, AdvisorToolRow, AdvisorMaterials, useAdvisorRun, slashReviewAllowed, usageText, normalizeUsage,
        overlayZIndex: OV_Z,
        composerRegion, clampOvPos, clampOvSize, defaultOvPos, defaultBallPos,
        ovReflowWatch, ovReflowAll, EDITABLE_SEL,
        ADVISOR_POLL_MS, ADVISOR_POLL_ERROR_MS, ADVISOR_POLL_IDLE_MS, ADVISOR_POLL_FULL_MS, ADVISOR_REQUEST_TIMEOUT_MS,
        advisorMergeProgress, advisorProgressKey, advisorNextDelayMs, advisorDeltaMiss,
        holdBridgeRead, holdBridgeWrite, holdBridgeOn, INJECTION_COMMAND, InjectionCommandCard,

        advisorDeliveryKey, advisorDeliveryBinding, advisorDeliveryValue, advisorDeliveryLabel, useAdvisorDelivery, AdvisorDeliveryTail, ADVISOR_DELIVERY_TIMEOUT_MS,
        themeTokens: THEME_TOKENS,
        tokenVars: TOKEN_VARS,
        themeIsDark,
        themeTokensCss,
        ControlBar,
      }

      const dispose = () => {
        for (const d of disposers.reverse()) { try { d() } catch (e) { /* noop */ } }
        try { if (window.__PO06_ACTIVE__ === INSTANCE_TOKEN) window.__PO06_ACTIVE__ = null } catch (e) { /* noop */ }
      }
      return dispose
    }

    void h
    return module.exports
  },
})
