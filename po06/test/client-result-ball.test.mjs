// 「结果 / 已发送」小球（2026-11-07 用户：优化完成后那个橙色按钮大家通常不需要）。
//
// 契约：
//   ① 优化**结束后**不再出现小球（避免完成后还要手动关掉一个没人点的按钮）；
//   ② 「优化中收起为球」必须保留——那时它是"消息还被拦着"的唯一提示，
//      一起去掉就会退化成吞消息；
//   ③ 结果仍可回看：输入栏的「本次注入」卡片走 /po06/api/injection，与球无关。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

test('球只在「优化中」渲染，完成后不再出现', () => {
  const gate = /ovBall\s*&&\s*ovBall\.visible\s*&&\s*ovBall\.phase === 'optimizing'\s*\?\s*h\(InterceptBall/.test(SRC)
  assert.ok(gate, '渲染入口必须限定 phase=optimizing')
  assert.ok(
    !/ovBall\s*&&\s*ovBall\.visible\s*\?\s*h\(InterceptBall/.test(SRC),
    '不允许存在"只要是球就渲染"的无条件入口（那会把结果球带回来）',
  )
})

test('「优化中收起为球」仍然是可达路径（不能顺手把它删了）', () => {
  assert.ok(/const collapseToBall = \(\) =>/.test(SRC), '收起为球的处理必须存在')
  assert.ok(
    /sent:\s*h\.phase === 'sent' \|\| h\.phase === 'skipped',\s*phase:\s*h\.phase/.test(SRC),
    '收起时仍要带上 phase（否则优化中收起后无法判断是否该画球）',
  )
})

test('结果回看不依赖小球：注入卡片走插件 API', () => {
  assert.ok(SRC.includes('/injection'), '注入记录应由 /po06/api/injection 取回')
})
