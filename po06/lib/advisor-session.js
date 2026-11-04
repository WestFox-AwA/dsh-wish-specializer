// 顾问调用的"会话外壳"（2026-10-20）：把台账接线从 apply 里抽出来，做成可测的纯包装器。
//
// 为什么抽出来：真机两次都回"没有旧账"，根因是包装器把 question 改到了 args[1]（exec）上。
// 那段逻辑当时写在 apply 里，任何单测都够不着，只能靠真机撞——抽出来之后这类错误一条测试就能钉住。
//
// 契约（与 index.js 里的用法一致）：
//   调用前：tick 台账 → 把未结结论塞进 toolArgs.question；
//   调用后：ok 时记录 failed checks（major）与 findings（minor），并应用 report.resolvedClaims；
//   顾问关闭：清账，且不改 question。

/** 从工具回调参数里取会话 id（(toolArgs, exec)）。 */
export function sessionIdOf(args) {
  const exec = args && args[1]
  return String(exec && exec.agent && exec.agent.session && exec.agent.session.id || '')
}

/**
 * @param {object} deps
 * @param {{tick:Function, render:Function, add:Function, applyUpdates:Function, clear:Function}} deps.ledger
 * @param {(sessionId:string) => object|null} deps.policyFor 读当前策略（要带 advisor / englishMode）
 * @returns {(execute:Function) => Function}
 */
export function createAdvisorWrapper({ ledger, policyFor }) {
  return function wrap(execute) {
    const wrapped = async (...args) => {
      const sid = sessionIdOf(args)
      let injected = ''
      try {
        const pol = sid && policyFor ? policyFor(sid) : null
        if (sid && pol && pol.advisor === false) ledger.clear(sid)
        if (sid && pol && pol.advisor !== false) {
          ledger.tick(sid)
          const prior = ledger.render(sid, pol.englishMode === true)
          const toolArgs = args[0]
          if (prior && toolArgs && typeof toolArgs.question === 'string') {
            injected = prior
            args = [{ ...toolArgs, question: prior + '\n\n' + toolArgs.question }, ...args.slice(1)]
          }
        }
      } catch { /* 台账坏掉不影响这次咨询 */ }

      const out = await execute(...args)
      // 可见性（issue #46）：告诉调用方本轮带了几条历史结论，便于判断是否被历史污染。
      let withPrior = out
      if (injected && out && typeof out === 'object') {
        const n = (injected.match(/^- \[/gm) || []).length
        if (n > 0) withPrior = { ...out, priorConclusions: n }
      }
      try {
        if (sid && out && out.ok === true) {
          const rep = out.report || {}
          for (const c of Array.isArray(rep.checks) ? rep.checks : []) {
            if (c && c.status === 'failed') ledger.add(sid, { claim: c.criterion, kind: 'check', authority: 'check', severity: 'major', evidence: c.evidenceRefs || [] })
          }
          for (const f of Array.isArray(rep.findings) ? rep.findings : []) {
            if (!f || !f.text) continue
            // 严重度按文本看：顾问的贡献条目里"缺陷：…"是明确的坏，按 major 记；
            // 其余观察按 minor（提示）。这样台账里的 concern/hint 与用户的口径一致。
            const severe = /^\s*(缺陷|bug|defect)[:：]/i.test(String(f.text))
            ledger.add(sid, { claim: f.text, kind: 'finding', authority: severe ? 'concern' : 'proposal', severity: severe ? 'major' : 'minor', evidence: f.evidenceRefs || [] })
          }
          if (Array.isArray(rep.resolvedClaims)) ledger.applyUpdates(sid, rep.resolvedClaims)
        }
      } catch { /* 记不上也不影响这次答复 */ }
      return withPrior
    }
    try { if (typeof execute?.dispose === 'function') wrapped.dispose = execute.dispose } catch { /* 只读属性就算了 */ }
    return wrapped
  }
}
