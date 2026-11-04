import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAdvisorMaterials, validateMaterialInput, MATERIAL_TEXT_CHARS } from '../lib/advisor-materials.js'
import { createHash } from 'node:crypto'
import { createAdvisor, ADVISOR_PARAMETERS } from '../lib/advisor.js'

const root = mkdtempSync(join(tmpdir(), 'po06-materials-'))
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64')
writeFileSync(join(root, 'out.html'), '<html>REAL ARTIFACT</html>')
writeFileSync(join(root, 'shot.png'), image)
writeFileSync(join(root, 'long.txt'), 'x'.repeat(MATERIAL_TEXT_CHARS + 100))
const desc = (path, purpose = '核对成果') => ({ path, purpose })
const prepare = args => prepareAdvisorMaterials({ root, enabled: true, args })
const events = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '验收当前成果' }] } }]
const exec = { callId: 'c1', agent: { session: { id: 's1', snapshotEvents: () => events } } }
const report = ref => ({ verdict: 'pass', summary: '有证据', findings: [], checks: [{ criterion: '成果', status: 'satisfied', evidenceRefs: [ref] }], nextStep: '交付', stopCondition: '出现反例重审' })

test('文件内容真实附入，用途保留，截断明确，旧artifacts兼容', async () => {
  const out = await prepare({ artifacts: ['out.html'], files: [desc('long.txt')] })
  assert.ok(out.evidence[0].text.includes('REAL ARTIFACT'))
  assert.equal(out.materials[0].status, 'ready')
  assert.equal(out.materials[1].status, 'truncated')
  assert.equal(out.materials[1].sentChars, MATERIAL_TEXT_CHARS)
  assert.equal(out.materials[1].purpose, '核对成果')
  assert.equal(out.limited, true)
  assert.ok(out.resultIds.has('F0'))
})

test('越界/绝对/不存在/关闭读取/二进制材料明确不可用，不能生成验收证据', async () => {
  for (const path of ['../outside.txt', 'C:/outside.txt', 'missing.txt', 'shot.png']) {
    const out = await prepare({ files: [desc(path)] })
    assert.equal(out.materials[0].sent, false)
    assert.equal(out.resultIds.size, 0)
  }
  const off = await prepareAdvisorMaterials({ root, enabled: false, args: { files: [desc('out.html')] } })
  // issue #45：原因码拆开，并且被丢弃的附件要显式告警
  assert.equal(off.materials[0].reason, 'read-tools-disabled')
  assert.ok(Array.isArray(off.warnings) && off.warnings.some((w) => w.startsWith('attachments-dropped:read-tools-disabled')), '关闭只读工具丢弃附件时必须告警')
  const noCwd = await prepareAdvisorMaterials({ root: '', enabled: true, args: { files: [desc('out.html')] } })
  assert.equal(noCwd.materials[0].reason, 'no-cwd', '没有工作目录是另一个原因，不能和开关关闭混在一起')
})

test('图片能力未知/不支持时不保存图片、不传块，卡片状态未检查', async () => {
  let calls = 0
  for (const imageSupport of [null, false]) {
    const out = await prepareAdvisorMaterials({ root, enabled: true, imageSupport,
      attachments: { saveImage: async () => { calls++ } }, args: { images: [desc('shot.png', '默认曝光')] } })
    assert.equal(out.materials[0].status, 'not-inspected')
    assert.equal(out.images.length, 0)
    assert.equal(out.resultIds.size, 0)
  }
  assert.equal(calls, 0)
})

test('支持图像时通过正规saveImage引用传递，图片字节不泄漏到工具结果', async () => {
  let saved, opts
  const ref = { attachmentId: 'fake-id', mediaType: 'image/png', bytes: image.length, width: 1, height: 1 }
  const runtime = { ok: true, cwd: root, readTools: true, imageSupport: true, cfg: { provider: 'p', model: 'vision' },
    attachments: { saveImage: async input => { saved = input; return ref } } }
  const invoke = createAdvisor({ resolveRuntime: async () => runtime, runLoop: async o => {
    opts = o
    return { text: JSON.stringify(report('I0')), trace: [], toolCalls: 0 }
  } })
  const out = await invoke({ mode: 'review_result', question: '看默认画面', images: [desc('shot.png', '默认曝光')] }, exec)
  assert.equal(out.ok, true)
  assert.deepEqual(saved.data, image)
  assert.equal(saved.mediaType, 'image/png')
  assert.equal(opts.messages[0].content.find(x => x.type === 'image').attachment, ref)
  assert.ok(opts.messages[0].content.some(x => x.type === 'text' && x.text.includes('默认曝光')))
  assert.equal(out.materials[0].sent, true)
  assert.ok(!JSON.stringify(out).includes(image.toString('base64')))
})

test('关闭只读工具不会偷偷读取图片；缺失图片导致整体通过降级', async () => {
  let opts
  const ref = { attachmentId: 'fake', mediaType: 'image/png', bytes: image.length, width: 1, height: 1 }
  // readTools false must not secretly read explicitly listed images.
  const off = createAdvisor({ resolveRuntime: async () => ({ ok: true, cwd: root, readTools: false, cfg: { provider: 'p', model: 'm' }, llm: { stream: o => {
    opts = o
    return (async function* () { yield { type: 'text-delta', text: JSON.stringify({ ...report('none'), verdict: 'unverified', checks: [] }) } })()
  } } }) })
  const out = await off({ mode: 'review_result', question: '看图', images: [desc('shot.png')] }, exec)
  assert.equal(out.ok, true)
  assert.equal(opts.messages[0].content.filter(x => x.type === 'image').length, 0)
  assert.equal(out.materials[0].sent, false)
  const invoke = createAdvisor({ resolveRuntime: async () => ({ ok: true, cwd: root, readTools: true, imageSupport: false, cfg: {provider:'p',model:'m'} }),
    runLoop: async () => ({ text: JSON.stringify(report('F0')), trace: [] }) })
  const limited = await invoke({ mode: 'review_result', question: '审完整成果', files:[desc('out.html')],images:[desc('shot.png')] }, exec)
  assert.equal(limited.report.verdict, 'unverified')
})

test('schema有文件/图片用途，执行端限制数量，无不兼容maxItems', () => {
  assert.ok(ADVISOR_PARAMETERS.properties.files.items.properties.purpose)
  assert.ok(ADVISOR_PARAMETERS.properties.images.items.properties.purpose)
  assert.equal(ADVISOR_PARAMETERS.properties.images.maxItems, undefined)
  assert.equal(validateMaterialInput({ artifacts:['a','b','c','d'],files:[desc('x')] }), 'invalid-artifacts')
  assert.equal(validateMaterialInput({ images:[desc('a'),desc('b'),desc('c'),desc('d'),desc('e')] }), 'invalid-images')
  assert.equal(validateMaterialInput({ images:[{path:'a'}] }), 'invalid-images')
  assert.equal(validateMaterialInput({}), null)
})

test('模型报错或空产出时仍保留每份材料状态', async () => {
  for (const failed of [false, true]) {
    const invoke = createAdvisor({ resolveRuntime: async () => ({ ok:true,cwd:root,readTools:true,cfg:{provider:'p',model:'m'} }),
      runLoop: async () => { if (failed) throw new Error('provider-failed'); return {text:'',trace:[]} } })
    const out = await invoke({mode:'review_result',question:'审代码',files:[desc('out.html')]},exec)
    assert.equal(out.ok,false)
    assert.equal(out.materials.length,1)
    assert.equal(out.materials[0].status,'ready')
    assert.ok(out.materials[0].excerpt.includes('REAL ARTIFACT'))
  }
})

test('附件服务拒绝假图时只显示不可用，不发送任何图片', async () => {
  const out = await prepareAdvisorMaterials({root,enabled:true,imageSupport:true,args:{images:[desc('shot.png')]},
    attachments:{saveImage:async()=>{throw new Error('IMAGE_INVALID')}}})
  assert.equal(out.images.length,0)
  assert.equal(out.materials[0].sent,false)
  assert.equal(out.materials[0].reason,'IMAGE_INVALID')
})

test('four large files receive equal nonzero budgets, repeatably', async () => {
  const files = ['a', 'b', 'c', 'd'].map(letter => {
    const path = 'large-' + letter + '.txt'
    writeFileSync(join(root, path), letter.repeat(20000))
    return desc(path)
  })
  const first = await prepare({ files })
  const second = await prepare({ files })
  assert.deepEqual(first, second)
  assert.deepEqual(first.materials.map(row => row.sentChars), [12000, 12000, 12000, 12000])
  assert.equal(first.evidence.reduce((sum, entry) => sum + entry.text.length, 0), 48000)
  for (const [i, row] of first.materials.entries()) {
    assert.equal(row.status, 'truncated')
    assert.equal(row.selectionScope, 'whole-file')
    assert.equal(row.selectionComplete, false)
    assert.equal(row.wholeFileComplete, false)
    assert.equal(row.sent, true)
    assert.equal(first.evidence[i].text, ['a', 'b', 'c', 'd'][i].repeat(12000))
    assert.ok(first.evidenceIds.has(row.id))
    assert.ok(first.resultIds.has(row.id))
  }
  const mixed = await prepare({ files: [desc('out.html'), ...files.slice(1)] })
  assert.deepEqual(mixed.materials.slice(1).map(row => row.sentChars), [15992, 15991, 15991])
  const unavailable = await prepare({ files: [desc('missing.txt'), ...files.slice(1)] })
  assert.deepEqual(unavailable.materials.slice(1).map(row => row.sentChars), [16000, 16000, 16000])
})

test('inclusive line ranges preserve endings and distinguish complete selection from whole file', async () => {
  const text = 'first\r\nsecond\nthird\rfourth\n'
  writeFileSync(join(root, 'lines.txt'), text)
  const cases = [
    [{ startLine: 2, endLine: 3 }, 'second\nthird\r', false],
    [{ startLine: 3 }, 'third\rfourth\n', false],
    [{ endLine: 2 }, 'first\r\nsecond\n', false],
    [{ startLine: 1, endLine: 4 }, text, true],
  ]
  for (const [range, selected, complete] of cases) {
    const out = await prepare({ files: [{ ...desc('lines.txt'), ...range, evidenceType: 'source' }] })
    const row = out.materials[0], entry = out.evidence[0]
    assert.equal(entry.text, selected)
    assert.equal(row.status, 'ready')
    assert.equal(row.selectionScope, 'line-range')
    assert.equal(row.selectionComplete, true)
    assert.equal(row.wholeFileComplete, complete)
    assert.equal(row.truncated, false)
    assert.equal(out.limited, !complete)
    assert.equal(row.totalLines, 4)
    assert.equal(row.chars, text.length)
    assert.equal(row.selectedChars, selected.length)
    assert.equal(row.sha256, createHash('sha256').update(text).digest('hex'))
    for (const key of ['evidenceType', 'selectionScope', 'selectionComplete', 'wholeFileComplete', 'totalLines', 'selectedStartLine', 'selectedEndLine', 'selectedChars', 'sha256']) {
      assert.equal(entry[key], row[key])
    }
  }
  const whole = await prepare({ files: [desc('lines.txt')] })
  assert.equal(whole.evidence[0].text, text)
  assert.equal(whole.materials[0].selectionScope, 'whole-file')
  assert.equal(whole.materials[0].wholeFileComplete, true)
  assert.equal(whole.limited, false)
  const clipped = await prepare({ files: [{ ...desc('long.txt'), startLine: 1, endLine: 1 }] })
  assert.equal(clipped.materials[0].selectionScope, 'line-range')
  assert.equal(clipped.materials[0].selectionComplete, false)
  assert.equal(clipped.materials[0].wholeFileComplete, false)
  writeFileSync(join(root, 'empty.txt'), '')
  const empty = await prepare({ files: [{ ...desc('empty.txt'), startLine: 1, endLine: 1 }] })
  assert.equal(empty.evidence[0].text, '')
  assert.equal(empty.materials[0].wholeFileComplete, true)
})

test('invalid and out-of-bounds ranges never silently read a whole file', async () => {
  const invalid = [
    { startLine: 0 }, { endLine: -1 }, { startLine: 1.5 }, { endLine: '2' },
    { startLine: null }, { endLine: NaN }, { startLine: Infinity },
    { endLine: Number.MAX_SAFE_INTEGER + 1 }, { startLine: true }, { startLine: 3, endLine: 2 },
  ]
  for (const range of invalid) {
    const files = [{ ...desc('lines.txt'), ...range }]
    assert.equal(validateMaterialInput({ files }), 'invalid-artifacts')
    const out = await prepare({ files })
    assert.equal(out.materials[0].reason, 'invalid-line-range')
    assert.equal(out.materials[0].sent, false)
    assert.equal(out.evidence[0].text, undefined)
    assert.equal(out.resultIds.size, 0)
  }
  for (const range of [{ startLine: 5 }, { endLine: 5 }, { startLine: 4, endLine: 5 }]) {
    const files = [{ ...desc('lines.txt'), ...range }]
    assert.equal(validateMaterialInput({ files }), null)
    const out = await prepare({ files })
    assert.equal(out.materials[0].reason, 'line-range-out-of-bounds')
    assert.equal(out.materials[0].sent, false)
    assert.equal(out.materials[0].selectionComplete, false)
    assert.equal(out.materials[0].wholeFileComplete, false)
    assert.equal(out.evidence[0].text, undefined)
    assert.equal(out.resultIds.size, 0)
    assert.equal(out.limited, true)
  }
})

test('evidence types are validated, defaulted, and propagated for files and images', async () => {
  for (const evidenceType of ['source', 'test-log', 'runtime-log', 'other', undefined]) {
    const args = { files: [{ ...desc('out.html'), evidenceType }] }
    assert.equal(validateMaterialInput(args), null)
    const out = await prepare(args)
    assert.equal(out.materials[0].evidenceType, evidenceType ?? 'other')
    assert.equal(out.evidence[0].evidenceType, evidenceType ?? 'other')
  }
  for (const evidenceType of ['runtime-capture', 'software-preview', 'reference', 'other', undefined]) {
    const args = { images: [{ ...desc('shot.png'), evidenceType }] }
    assert.equal(validateMaterialInput(args), null)
    const out = await prepareAdvisorMaterials({ root, enabled: true, imageSupport: true, args,
      attachments: { saveImage: async () => ({ attachmentId: 'typed', mediaType: 'image/png', bytes: image.length, width: 1, height: 1 }) } })
    assert.equal(out.materials[0].evidenceType, evidenceType ?? 'other')
    assert.equal(out.evidence[0].evidenceType, evidenceType ?? 'other')
    assert.ok(out.images[0].text.includes(evidenceType ?? 'other'))
    assert.equal(out.evidence[0].sha256, out.materials[0].sha256)
  }
  for (const evidenceType of ['runtime-capture', '', null, 1]) {
    const args = { files: [{ ...desc('out.html'), evidenceType }] }
    assert.equal(validateMaterialInput(args), 'invalid-artifacts')
  }
  for (const evidenceType of ['source', '', null, 1]) {
    assert.equal(validateMaterialInput({ images: [{ ...desc('shot.png'), evidenceType }] }), 'invalid-images')
  }
  const legacy = await prepare({ artifacts: ['out.html'] })
  assert.equal(legacy.materials[0].evidenceType, 'other')
  assert.equal(legacy.materials[0].wholeFileComplete, true)
  const missing = await prepare({ files: [{ ...desc('missing.txt'), evidenceType: 'test-log' }] })
  assert.equal(missing.evidence[0].evidenceType, 'test-log')
  const unsupported = await prepare({ images: [{ ...desc('shot.png'), evidenceType: 'reference' }] })
  assert.equal(unsupported.evidence[0].evidenceType, 'reference')
  assert.equal(unsupported.materials[0].status, 'not-inspected')
})

test('文件被附入的快照与当前预览路径分开，材料有内容指纹', async () => {
  const out = await prepare({ files:[desc('out.html')] })
  assert.equal(out.materials[0].sha256.length, 64)
  assert.equal(out.materials[0].previewAvailable, true)
  assert.ok(out.materials[0].excerpt.includes('REAL ARTIFACT'))
  rmSync(root, { recursive: true, force: true })
})
