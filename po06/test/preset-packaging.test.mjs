// Wish 预设必须**随包发布**（2026-10-19 用户发现：从 Release 装的人没有 Wish 预设）。
//
// 真机事实：预设原来是靠手工贴进 profiles/<name>/cordis.patch.yml 的，仓库里只有一份
// po06/presets/wish.patch.yml 片段，而 package.json 的 files 既没含 presets 目录，
// bundle 补丁也没插入 preset —— 于是下载用户装完只有插件、没有预设。
//
// 现在的契约有三条，缺一条就等于没发：
//   ① bundle 补丁（po06/cordis.patch.yml）里插入 preset-wish；
//   ② presets 目录进 package.json 的 files（手工接入的人还能拿到片段）；
//   ③ 片段文件本身仍然存在且是可用的 patch。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

test('bundle 补丁里插入 Wish 预设（dsh plugin add 之后就有预设）', () => {
  const patch = readFileSync(join(ROOT, 'po06', 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('preset-wish'), 'bundle 补丁必须插入 preset-wish')
  assert.ok(patch.includes('@deepseek-ai/dsh-agent-preset'), '预设行要指向 agent-preset')
  assert.ok(/config:\s*\n\s+id: wish/.test(patch), '预设 id 必须是 wish')
})

test('presets 目录随包发布', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('po06/presets'), 'package.json files 必须包含 po06/presets')
  assert.ok(existsSync(join(ROOT, 'po06', 'presets', 'wish.patch.yml')), '片段文件必须存在')
})

test('片段本身仍是有效的 patch（insert + agent-preset + 插件清单）', () => {
  const frag = readFileSync(join(ROOT, 'po06', 'presets', 'wish.patch.yml'), 'utf8')
  assert.ok(/^- insert:/m.test(frag), '必须是一条 insert 补丁')
  assert.ok(frag.includes("name: '@deepseek-ai/dsh-agent-preset'"), '必须是 agent-preset 行')
  assert.ok(frag.includes('@dsh-external/dsh-wish-specializer/check'), '预设要带上 wish-check 工具')
})

test('预设只引用宿主已注册的模板变量（issue #47：{{cwd}} 会让整份预设渲染失败）', () => {
  // 宿主 prompt 渲染器对 section 做**严格**变量解析：未注册的变量直接抛
  // unknown prompt variable，整份预设不可用。当前 DSH 只注册 provider / model。
  const allowed = new Set(['provider', 'model'])
  for (const rel of ['po06/cordis.patch.yml', 'po06/presets/wish.patch.yml']) {
    // 只看生效内容：YAML 注释里的示例不算引用（注释不会被渲染）
    const raw = readFileSync(join(ROOT, rel), 'utf8')
    const NL = String.fromCharCode(10)
    const text = raw.split(NL).filter((line) => !/^\s*#/.test(line)).join(NL)
    for (const m of text.matchAll(/\{\{([^}]+)\}\}/g)) {
      const name = m[1].trim()
      assert.ok(allowed.has(name), rel + ' 引用了未注册的模板变量 {{' + name + '}}；宿主只注册 provider/model')
    }
  }
})

test('po06/package.json 导出 ./check（issue #41：预设声明了它，缺导出就加载失败）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'po06', 'package.json'), 'utf8'))
  assert.ok(pkg.exports && pkg.exports['./check'], 'po06/package.json 必须导出 ./check')
  const target = pkg.exports['./check'].default || pkg.exports['./check']
  assert.equal(target, './lib/wish-check.js', './check 必须指向 lib/wish-check.js')
  assert.ok(existsSync(join(ROOT, 'po06', 'lib', 'wish-check.js')), '被导出的文件必须存在')
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(root.exports && root.exports['./check'], '根薄壳也必须导出 ./check')
})
