import { openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute, win32, basename, extname } from 'node:path'
import { createHash } from 'node:crypto'

export const MATERIAL_MAX_FILES = 4
export const MATERIAL_MAX_IMAGES = 4
export const MATERIAL_FILE_BYTES = 2 * 1024 * 1024
export const MATERIAL_TEXT_CHARS = 16000
export const MATERIAL_TOTAL_CHARS = 48000
export const MATERIAL_IMAGE_BYTES = 5 * 1024 * 1024
export const MATERIAL_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024
const mediaTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

const fileEvidenceTypes = new Set(['source', 'test-log', 'runtime-log', 'other'])
const imageEvidenceTypes = new Set(['runtime-capture', 'software-preview', 'reference', 'other'])
const validRange = x => ['startLine', 'endLine'].every(key => x[key] === undefined || (Number.isSafeInteger(x[key]) && x[key] > 0))
  && (x.startLine === undefined || x.endLine === undefined || x.startLine <= x.endLine)

export function validateMaterialInput(args) {
  const descriptor = x => x && typeof x === 'object' && typeof x.path === 'string' && x.path.trim() && x.path.length <= 1000
    && typeof x.purpose === 'string' && x.purpose.trim() && x.purpose.length <= 1200
  const legacy = args.artifacts || []
  const files = args.files || []
  const images = args.images || []
  if (!Array.isArray(legacy) || !legacy.every(p => typeof p === 'string' && p.trim() && p.length <= 1000)
    || !Array.isArray(files) || !files.every(x => descriptor(x) && validRange(x) && (x.evidenceType === undefined || fileEvidenceTypes.has(x.evidenceType))) || legacy.length + files.length > MATERIAL_MAX_FILES) return 'invalid-artifacts'
  if (!Array.isArray(images) || !images.every(x => descriptor(x) && (x.evidenceType === undefined || imageEvidenceTypes.has(x.evidenceType))) || images.length > MATERIAL_MAX_IMAGES) return 'invalid-images'
  return null
}

// Lexical and realpath checks. Refuse directories, outside symlinks, UNC and drive-relative names.
export function materialPath(root, path) {
  if (!root || typeof path !== 'string' || !path.trim() || isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path)) throw new Error('outside-workspace')
  const base = realpathSync(root)
  const target = resolve(base, path)
  const back = relative(base, target)
  if (!back || back === '..' || back.startsWith('..' + '/') || back.startsWith('..' + String.fromCharCode(92)) || isAbsolute(back)) throw new Error('outside-workspace')
  const actual = realpathSync(target)
  const rel = relative(base, actual)
  if (!rel || rel === '..' || rel.startsWith('..' + '/') || rel.startsWith('..' + String.fromCharCode(92)) || isAbsolute(rel)) throw new Error('outside-workspace')
  return actual
}
export function readBounded(root, path, cap) {
  const actual = materialPath(root, path)
  const fd = openSync(actual, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('not-a-file')
    if (stat.size > cap) throw new Error('file-too-large')
    const buffer = Buffer.alloc(stat.size + 1)
    let count = 0, n
    while (count < buffer.length && (n = readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += n
    if (count > stat.size) throw new Error('file-changed-during-read')
    return { data: buffer.subarray(0, count), actual }
  } finally { closeSync(fd) }
}
// Preserve complete observed lines in the bounded head/tail excerpt. Omitted lines are never result evidence.
export function selectMaterialExcerpt(text,budget,startLine=1) {
  if(text.length<=budget)return {content:text,ranges:[{startLine,endLine:startLine+Math.max(0,text.split('\n').length-(text.endsWith('\n')?2:1)),selectionComplete:true}]}
  const room=Math.max(0,budget-120),headLimit=Math.floor(room/2),tailLimit=room-headLimit
  const firstBreak=text.lastIndexOf('\n',headLimit),lastBreak=text.indexOf('\n',Math.max(0,text.length-tailLimit))
  if(firstBreak<0 || lastBreak<0 || firstBreak>=lastBreak)return {content:text.slice(0,budget),ranges:[],partialLine:true}
  const head=text.slice(0,firstBreak+1),tail=text.slice(lastBreak+1)
  const headCount=head.split('\n').length-1,tailStart=startLine+text.slice(0,lastBreak+1).split('\n').length-1
  const endLine=startLine+text.split('\n').length-(text.endsWith('\n')?2:1)
  return {content:head+'[omitted lines '+(startLine+headCount)+'..'+(tailStart-1)+'; read the required range before using it]\n'+tail,
    ranges:[{startLine,endLine:startLine+headCount-1,selectionComplete:true},{startLine:tailStart,endLine,selectionComplete:true}]}
}
function reasonOf(error) {
  if (error?.code === 'ENOENT') return 'file-not-found'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission-denied'
  return String(error?.message || 'material-unavailable').slice(0, 180)
}

// Text payload and image blocks stay separate: no image bytes in the UI or tool result.
export async function prepareAdvisorMaterials({ args, root, enabled, imageSupport, attachments, signal } = {}) {
  const materials = [], evidence = [], images = [], evidenceIds = new Set(), resultIds = new Set()
  const files = [...(args.artifacts || []).map(path => ({ path, purpose: '本次成果或验证材料' })), ...(args.files || [])]
  const pending = []
  let imageBytes = 0, limited = false
  const descriptors = [...files.map((d,i)=>({...d,id:'F'+i,kind:'file'})), ...(args.images || []).map((d,i)=>({...d,id:'I'+i,kind:'image'}))]
  for (const descriptor of descriptors) {
    if (signal?.aborted) throw signal.reason || new Error('cancelled')
    const row = { ...descriptor, evidenceType: descriptor.evidenceType ?? 'other', status: 'unavailable', sent: false, previewAvailable: false }
    if (row.kind === 'file') Object.assign(row, { selectionScope: row.startLine !== undefined || row.endLine !== undefined ? 'line-range' : 'whole-file', selectionComplete: false, wholeFileComplete: false })
    materials.push(row)
    const fail = reason => {
      evidenceIds.add(row.id);
 row.reason = reason; limited = true; evidence.push({ id: row.id, path: row.path, purpose: row.purpose, status: row.status, evidenceType: row.evidenceType, selectionScope: row.selectionScope, selectionComplete: row.selectionComplete, wholeFileComplete: row.wholeFileComplete, reason }) }
    // issue #45：把「开关关着」和「没有工作目录」拆开，否则「路径写错／文件不存在」
    // 也会被这同一句盖住，调用方完全看不出该改什么。
    if (!enabled) { fail('read-tools-disabled'); continue }
    if (!root) { fail('no-cwd'); continue }
    try {
      if (row.kind === 'file') {
        if (!validRange(row)) { fail('invalid-line-range'); continue }
        if (!fileEvidenceTypes.has(row.evidenceType)) { fail('invalid-evidence-type'); continue }
        const { data, actual } = readBounded(root, row.path, MATERIAL_FILE_BYTES)
        row.previewAvailable = true; row.previewPath = actual; row.bytes = data.length
        if (data.includes(0)) { fail('binary-file-not-supported'); continue }
        let text
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { fail('text-is-not-utf8'); continue }
        row.chars = text.length
        row.sha256 = createHash('sha256').update(data).digest('hex')
        const lines = text.split(/(?<=\n)|(?<=\r)(?!\n)/)
        if (lines.length > 1 && lines.at(-1) === '') lines.pop()
        row.totalLines = lines.length
        row.selectedStartLine = row.startLine ?? 1
        row.selectedEndLine = row.endLine ?? row.totalLines
        if (row.selectedStartLine > row.totalLines || row.selectedEndLine > row.totalLines) { fail('line-range-out-of-bounds'); continue }
        const selected = lines.slice(row.selectedStartLine - 1, row.selectedEndLine).join('')
        row.selectedChars = selected.length
        const entry = { id: row.id, path: row.path, purpose: row.purpose, evidenceType: row.evidenceType }
        evidence.push(entry)
        pending.push({ row, selected, entry, budget: 0 })
      } else {
        if (!imageEvidenceTypes.has(row.evidenceType)) { fail('invalid-evidence-type'); continue }
        const type = mediaTypes[extname(row.path).toLowerCase()]
        if (!type) { fail('unsupported-image-format'); continue }
        const { data, actual } = readBounded(root, row.path, MATERIAL_IMAGE_BYTES)
        row.previewAvailable = true; row.previewPath = actual; row.bytes = data.length
        if (imageSupport !== true) { row.status = 'not-inspected'; fail(imageSupport === false ? 'model-text-only' : 'model-image-capability-unknown'); continue }
        if (!attachments || typeof attachments.saveImage !== 'function') { row.status = 'not-inspected'; fail('attachment-service-unavailable'); continue }
        if (imageBytes + data.length > MATERIAL_TOTAL_IMAGE_BYTES) { fail('image-budget-exhausted'); continue }
        const attachment = await attachments.saveImage({ data, mediaType: type, name: basename(row.path) })
        if (signal?.aborted) throw signal.reason || new Error('cancelled')
        imageBytes += data.length
        row.status = 'ready'; row.sent = true
        row.image = { mediaType: attachment.mediaType, bytes: attachment.bytes, width: attachment.width, height: attachment.height,
          resized: !!attachment.originalDimensions }
        row.sha256 = createHash('sha256').update(data).digest('hex')
        evidence.push({ id: row.id, path: row.path, purpose: row.purpose, status: 'ready', evidenceType: row.evidenceType, sha256: row.sha256, image: row.image })
        images.push({ type: 'text', text: '图像证据 ' + row.id + '：' + row.path + '；证据类型：' + row.evidenceType + '；检查用途：' + row.purpose }, { type: 'image', attachment })
        evidenceIds.add(row.id); resultIds.add(row.id)
      }
    } catch (error) {
      if (signal?.aborted) throw error
      fail(reasonOf(error))
    }
  }
  // Water-fill capped selections before sending; short files release their unused share.
  let remaining = MATERIAL_TOTAL_CHARS
  let active = pending.filter(item => item.selected.length > 0)
  while (active.length && remaining > 0) {
    const share = Math.max(1, Math.floor(remaining / active.length))
    for (const item of active) {
      const extra = Math.min(share, remaining, MATERIAL_TEXT_CHARS - item.budget, item.selected.length - item.budget)
      item.budget += extra
      remaining -= extra
    }
    active = active.filter(item => item.budget < Math.min(MATERIAL_TEXT_CHARS, item.selected.length))
  }
  for (const { row, selected, entry, budget } of pending) {
    if (signal?.aborted) throw signal.reason || new Error('cancelled')
    const excerpt = selectMaterialExcerpt(selected,budget,row.selectedStartLine)
    const body = excerpt.content
    row.observedRanges = excerpt.ranges
    row.selectionComplete = selected.length <= budget
    row.wholeFileComplete = row.selectionComplete && row.selectedStartLine === 1 && row.selectedEndLine === row.totalLines
    row.status = row.selectionComplete ? 'ready' : 'truncated'
    row.truncated = !row.selectionComplete; row.sent = true
    row.sentChars = body.length; row.excerpt = body.slice(0, 2400)
    Object.assign(entry, { status: row.status, chars: row.chars, sentChars: row.sentChars, sha256: row.sha256,
      selectionScope: row.selectionScope, selectionComplete: row.selectionComplete, wholeFileComplete: row.wholeFileComplete,
      totalLines: row.totalLines, selectedStartLine: row.selectedStartLine, selectedEndLine: row.selectedEndLine,
      selectedChars: row.selectedChars, observedRanges: row.observedRanges, text: body })
    evidenceIds.add(row.id); resultIds.add(row.id)
    limited ||= !row.wholeFileComplete
  }
  // 附件被丢弃时必须能被告知（issue #45：默认配置下静默丢弃，调用方以为建议基于文件）。
  const warnings = []
  if (!enabled) {
    const n = descriptors.length
    if (n > 0) warnings.push('attachments-dropped:read-tools-disabled:' + n)
  } else if (!root) {
    const n = descriptors.length
    if (n > 0) warnings.push('attachments-dropped:no-cwd:' + n)
  }
  return { materials, evidence, images, evidenceIds, resultIds, limited, warnings }
}
