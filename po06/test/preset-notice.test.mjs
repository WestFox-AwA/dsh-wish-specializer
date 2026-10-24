// 预设提示（2026-10-19 最终口径）：**不判断预设**，切会话/打开 DSH 就提示一次。
//
// 目的只是让新用户知道有这个特性；觉得烦点「以后不再显示」，写进设置后永久闭嘴。
// 这里钉住：触发条件（会话切换/启动）、每个会话一次、dismissed 尊重、body 级浮层、两个出口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from '../lib/settings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT_SRC = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

test('设置：默认提示，且能持久关闭', () => {
  assert.equal(DEFAULT_SETTINGS.presetNoticeDismissed, false, '默认要提示')
  assert.ok(SETTINGS_KEYS.includes('presetNoticeDismissed'), '必须在白名单里')
  assert.ok(CLIENT_SRC.includes('forever: true'), 'forever 走宿主持久设置')
})

test('触发：一次 DSH 运行进程最多提示一次（不再判断预设）', () => {
  assert.ok(CLIENT_SRC.includes('let PRESET_NOTICE_SHOWN = false'), '进程级标记')
  assert.ok(CLIENT_SRC.includes('if (!sessionId || PRESET_NOTICE_SHOWN) return'), '已经提示过就不再弹')
  assert.ok(CLIENT_SRC.includes('PRESET_NOTICE_SHOWN = true'), '提示/或已关闭后都要标记')
  assert.ok(/\}, \[sessionId, data, s && s\.presetNoticeDismissed\]\)/.test(CLIENT_SRC), '会话或首个状态快照变化即触发，并尊重 dismissed')
  assert.ok(CLIENT_SRC.includes('if (!data) return'), '首帧状态未知时必须等待，不能抢先弹或提前标记')
  // 不再为弹窗去问 /preset（也不再拿预设做判据）
  assert.equal(CLIENT_SRC.includes("apiGet('/preset?via=enter"), false, '发送路径不再被预设闸门拦住')
  assert.equal(CLIENT_SRC.includes('presetLabelIn'), false, '不再读按钮文案')
  // 第二个触发：新会话里把预设切到非 PTC/Wish ⇒ 也要弹（只认 presetAt 变化，首帧不弹）
  assert.ok(CLIENT_SRC.includes("apiGet('/preset?via=watch&light=1&session='"), '预设变化的轻查询（light=1 跳过 inspect）')
  assert.ok(CLIENT_SRC.includes('setInterval(tick, 500)'), '0.5s 一次（用户要求切完就弹）')
  assert.ok(CLIENT_SRC.includes('const seen = { armed: false, at: null }'), '自己维护基线')
  assert.ok(CLIENT_SRC.includes('if (!at || at === seen.at) return'), '只有真的变了才动')
  assert.ok(CLIENT_SRC.includes('if (r.notice && !(s && s.presetNoticeDismissed === true)) setNotice(r.notice)'), '变了且非推荐预设才弹')
})

test('弹窗：body 级浮层 + 两个出口', () => {
  assert.ok(CLIENT_SRC.includes("card.setAttribute('data-po06', 'preset-notice')"), '卡片节点')
  assert.ok(CLIENT_SRC.includes('document.body.appendChild(el)'), '画到 body（不被输入区裁剪）')
  assert.ok(CLIENT_SRC.includes('z-index:2147482000'), '层级足够高')
  assert.ok(CLIENT_SRC.includes('notice-ok') && CLIENT_SRC.includes('notice-never'), '知道了 / 以后不再显示')
  assert.ok(CLIENT_SRC.includes("L('以后不再显示', 'Do not show again')"), '文案')
})
