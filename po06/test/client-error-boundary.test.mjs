import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

test('控件栏有边界：渲染异常不得扩散，且会话切换可重置', () => {
  assert.match(source, /class BarBoundary extends \(React\.Component \|\| class \{\}\)/)
  assert.match(source, /componentDidCatch\(/)
  assert.match(source, /event:\s*["']bar-crash["']/)
  assert.match(source, /event:\s*["']page-error["']/)
  assert.match(source, /const ControlBarSafe = \(props\) =>/)
  assert.match(source, /mount\('conversation\.input\.left',\s*'prompt-optimizer',\s*20,\s*ControlBarSafe\)/)
})

test('错误边界的异常记录不依赖同步日志成功', () => {
  assert.match(source, /apiPost\(["']\/client-log["'][\s\S]{0,260}\.catch\(\(\) => \{\}\)/)
  assert.match(source, /window\.addEventListener\(["']error["']/)
  assert.match(source, /window\.addEventListener\(["']unhandledrejection["']/)
})
