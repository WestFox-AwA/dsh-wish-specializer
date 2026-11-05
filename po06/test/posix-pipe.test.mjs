// `… | head` / `… | tail` 的管道语义（2026-11-05 真机：ollama ds41f 的顾问）。
//
// 事故经过：顾问在 ollama 的 DeepSeek 上"看起来读不到东西"。查下去不是模型问题，是
// `head`/`tail` 只接受**文件名**：模型习惯写 `grep -rn x . | head -50`，这一步被拒绝，
// 而当时"任意一次拒绝"会终止整轮查证 ⇒ 顾问只剩空手结论。
// 现在：没有文件名时按管道输入取行；仍没有输入才拒绝，且拒绝理由给出可用写法。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPosix } from '../lib/posix.js'

const root = mkdtempSync(join(tmpdir(), 'po06-pipe-'))
writeFileSync(join(root, 'a.txt'), ['one', 'two', 'three', 'four'].join('\n'))
writeFileSync(join(root, 'b.md'), 'x\n')
writeFileSync(join(root, 'c.md'), 'y\n')

test.after(() => rmSync(root, { recursive: true, force: true }))

test('管道里的 head/tail 按输入取行，不需要文件名', () => {
  const head = runPosix(root, 'ls | head -n 2')
  assert.equal(head.ok, true, head.text)
  assert.equal(head.text.split('\n').length, 2)
  const tail = runPosix(root, 'ls | tail -n 1')
  assert.equal(tail.ok, true, tail.text)
  assert.equal(tail.text.split('\n').length, 1)
  const cat = runPosix(root, 'cat a.txt | head -n 2')
  assert.equal(cat.ok, true, cat.text)
  assert.equal(cat.text, 'one\ntwo')
})

test('带文件名时行为不变；既没有文件名也没有输入才拒绝，且给出可用写法', () => {
  assert.equal(runPosix(root, 'head -n 2 a.txt').text, 'one\ntwo')
  const refused = runPosix(root, 'head -n 2')
  assert.equal(refused.ok, false)
  assert.equal(refused.rejected, true)
  assert.match(refused.text, /head -n 50/, '拒绝理由要给出可用写法，模型才能改')
})
