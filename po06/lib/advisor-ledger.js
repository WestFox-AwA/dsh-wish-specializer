// 顾问台账（2026-10-20 重构 2/4）：**会话级、由顾问自己动态维护**的结论账。
//
// 为什么不是"哈希变了就作废"：用户明确要求"动态地让有智能处理能力的顾问去管理这些结论"。
// 机械作废会在两种情况下出错：①文件只是换行变了，结论其实还成立；②文件没变但上下文变了，
// 结论其实已经过时。所以哈希只作为**提示**（告诉顾问哪里变了），是否失效由顾问判断。
//
// 本模块只做三件事：记账、去重、把未结项渲染成"上一轮欠的账"喂回去。
// 它不判断对错，也不自动销账——销账必须由顾问显式给出 resolved。

const MAX_OPEN = 8

/** 一条结论的规范化形式。 */
function normalize(row, { turn = 0 } = {}) {
  const claim = String(row && (row.claim || row.text || row.criterion) || '').replace(/\s+/g, ' ').trim()
  if (!claim) return null
  return {
    id: String((row && row.id) || ''),
    claim: claim.slice(0, 160),
    kind: String((row && (row.kind || row.status)) || 'note'),
    authority: String((row && row.authority) || 'proposal'),
    severity: (row && row.severity) === 'major' ? 'major' : 'minor',
    status: 'open',
    evidence: Array.isArray(row && row.evidence) ? row.evidence.slice(0, 4) : [],
    firstSeenTurn: turn,
    lastCheckedTurn: turn,
  }
}

export function createLedger() {
  /** sessionId -> {rows: Map<claim, row>, seq, turn} */
  const bySession = new Map()
  const state = (sid) => {
    const key = String(sid || '')
    if (!bySession.has(key)) bySession.set(key, { rows: new Map(), seq: 0, turn: 0 })
    return bySession.get(key)
  }

  return {
    /** 记一条结论（去重：同一句 claim 只保留一条，刷新 lastCheckedTurn）。 */
    add(sessionId, row, opts = {}) {
      const s = state(sessionId)
      const turn = Number.isFinite(opts.turn) ? opts.turn : s.turn
      const n = normalize(row, { turn })
      if (!n) return null
      const existed = s.rows.get(n.claim)
      if (existed) {
        existed.lastCheckedTurn = turn
        if (opts.turn != null) existed.status = 'open'   // 顾问这轮又提了一次 ⇒ 仍成立
        return existed
      }
      n.id = n.id || ('adv-' + (++s.seq))
      s.rows.set(n.claim, n)
      // 只保留最近的 MAX_OPEN 条未结项；更早的折叠掉（不注入，但仍可查）
      const open = [...s.rows.values()].filter((r) => r.status === 'open')
      if (open.length > MAX_OPEN) {
        open.sort((a, b) => a.lastCheckedTurn - b.lastCheckedTurn)
        for (const old of open.slice(0, open.length - MAX_OPEN)) old.status = 'archived'
      }
      return n
    },
    /** 应用顾问自己给的销账（resolved / obsolete / superseded / unknown）。 */
    applyUpdates(sessionId, updates = [], opts = {}) {
      const s = state(sessionId)
      const turn = Number.isFinite(opts.turn) ? opts.turn : s.turn
      const applied = []
      for (const u of Array.isArray(updates) ? updates : []) {
        if (!u) continue
        const id = String(u.id || '')
        const claim = String(u.claim || '').replace(/\s+/g, ' ').trim()
        const row = id ? [...s.rows.values()].find((r) => r.id === id) : s.rows.get(claim)
        if (!row) continue
        const status = ['resolved', 'obsolete', 'superseded', 'unknown', 'open'].includes(String(u.status)) ? String(u.status) : 'unknown'
        row.status = status
        row.note = String(u.note || '').slice(0, 200)
        row.lastCheckedTurn = turn
        applied.push({ id: row.id, status })
      }
      return applied
    },
    /** 未结项（给顾问看的"上一轮欠的账"）。 */
    open(sessionId) {
      const s = state(sessionId)
      return [...s.rows.values()].filter((r) => r.status === 'open' || r.status === 'unknown')
    },
    /** 推进轮次（每次真正调用顾问前 +1）。 */
    tick(sessionId) {
      const s = state(sessionId)
      s.turn += 1
      return s.turn
    },
    /** 开关关掉/会话结束时清空（用户要求：关了就不留半截结构）。 */
    clear(sessionId) {
      bySession.delete(String(sessionId || ''))
    },
    /** 全部清空：顾问开关被关掉时用（这个设置是全局的，账也该全局清）。 */
    clearAll() {
      bySession.clear()
    },
    /** 渲染成顾问输入里的那一段（空则返回 ''）。 */
    render(sessionId, english = false) {
      const rows = this.open(sessionId)
      if (!rows.length) return ''
      const head = english ? '[Open items from your previous reviews]' : '【你上次留下的未结结论】'
      // 去重（同一句话反复出现只会让回答自我复读）+ 限流（issue #46）
      const seen = new Set()
      const uniq = rows.filter((r) => {
        const key = String(r.claim || '').replace(/\s+/g, ' ').trim().slice(0, 160)
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      const kept = uniq.slice(0, MAX_OPEN)
      const lines = kept.map((r) => '- [' + r.id + '] ' + r.claim)
      const overflow = uniq.length - kept.length
      if (overflow > 0) {
        lines.push(english
          ? '- (' + overflow + ' more earlier items omitted; ask again if that context matters.)'
          : '- （另有 ' + overflow + ' 条更早的未结结论未列入；需要时再查。）')
      }
      return head + '\n' + lines.join('\n')
    },
  }
}

export const LEDGER_MAX_OPEN = MAX_OPEN
