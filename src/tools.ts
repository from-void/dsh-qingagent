import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  aiBlocksToQingml,
  countDocVisibleChars,
  pmToAiIr,
  pmToMarkdownWithLineMap,
  type PmDoc,
} from '@qingagent/pm-schema'
import type { BindingStore } from './bindings.js'
import { AgentTurnLeaseCoordinator, type BridgeHub } from './bridge.js'
import type {
  ExternalDoc,
  ExternalDocReadResponse,
  ExternalEditProposalOp,
  ExternalPmDocReadResponse,
  ExternalProposalResponse,
  ExternalReviewCommitRequest,
  ExternalReviewCommitResponse,
  ExternalReviewRenderModelResponse,
} from './contracts.js'
import { DRAFT_MARK_COLORS } from './contracts.js'
import { EngineHttpError, EngineUnavailableError, type EngineService } from './engine.js'
import {
  completeTopLevelBlocks,
  convertQingmlSourceSyntax,
  extractTitle,
  outlineOf,
  structureFactsOf,
} from './qingml.js'
import { isWholeDocReview } from './reviewMode.js'
import {
  blocksBucket,
  countBucket,
  editRejectedReason,
  patchesBucket,
  wordsBucket,
  type TelemetryCapture,
} from './telemetry.js'
import {
  DocStateCache,
  FreshnessTracker,
  docStateLine,
  type DraftReadMode,
  type DocStateSnapshot,
} from './docState.js'
import { compileQingmlDocument } from './qingmlCompile.js'
import { sanitizeUserVisibleText } from './userVisibleText.js'
import { renderedReviewSummary } from './reviewCount.js'

interface ToolServices {
  ctx: Context
  engine: EngineService
  bindings: BindingStore
  bridge: BridgeHub
  telemetry?: TelemetryCapture
  docStates?: DocStateCache
  freshness?: FreshnessTracker
}

interface RuntimeToolServices extends ToolServices {
  docStates: DocStateCache
  freshness: FreshnessTracker
  turnLeases: AgentTurnLeaseCoordinator
  readTurns: ReadTurnTracker
}

const textBlock = (text: string) => [{ type: 'text' as const, text }]

const REVIEW_END_MESSAGE = '改动已提交审阅，右侧面板等待用户裁决。本次工具调用结束——不要重写、不要读稿复核、不要自动裁决、不要再调用工具；只补一句简短收尾，请用户在右侧完成裁决。'
const REVIEW_REPEAT_ERROR = '本回合已裁决过一次，禁止连环裁决；等待用户指示'
const WRITE_REPEAT_ERROR = '本回合的完整文稿重交额度已用尽；只有第二稿的字数偏差仍超过 15% 且差距比首稿缩小时，才允许第三次提交。请等待用户下一轮指示。'
const REVIEW_PENDING_ERROR = '文稿正在审阅中。待审内容可能是你此前轮次提交的,也可能来自其他会话——不要断言归属。先用 ask_user 向用户说明存在待审稿,经用户明确授权后才可处置;不得代为提交或放弃。'
const STR_REPLACE_PLAIN_TEXT_ERROR = 'old 必须是纯文本内容,不要带 ## 等 markdown 标记'
const STR_REPLACE_LINES_NOTICE = '注意:strReplace 的 old 用纯文本,不要带行首 ## - 等标记。'
const PM_INLINE_ATOM_PLACEHOLDER = '\uFFFC'
const EMPTY_DRAFT_ERROR = '提交的 QingML 只有标题、缺少正文内容，未提交文稿。'
const SOURCE_SYNTAX_LEAK_ERROR = '文稿中仍有无法识别的脚注或公式写法，未提交文稿。'
// 局部 op 只接受纯文本/Markdown;QingML/HTML 原始标签会被当普通文字刻进正文(用户实测颜色事故)。
const RAW_TAG_PATTERN = /<\/?\s*(article|title|h[1-6]|p|ul|ol|li|tasks?|blockquote|hr|pre|table|tr|td|th|callout|columns?|mermaid|drawio|math(?:-block)?|img|file|pennote|b|strong|i|em|u|s|del|code|a|mark|color|footnote|br|span|div)\b[^>]*>/i
const RAW_TAG_ERROR = '检测到 QingML/HTML 标签:局部操作(strReplace/insertAfterLine/appendSection)只接受纯文本或 Markdown；直接写入 <mark>/<color> 等标签会把它们当普通文字刻进正文。样式类修改请改用 qing_edit_draft 的 markText 操作。'
const ORPHAN_TABLE_ROW_ERROR = '检测到孤立的 Markdown 表格行；不能用插入或追加操作写入单行管道文本。请用 strReplace 定位既有表格整行并把新行一并扩展；完整表格必须包含表头分隔行。'

/**
 * 空壳按顶层块形态判定,不用字数阈值:合法的一句话通知也只需一个 <p>,
 * 而排除 <title> 后仍只有 h1-h6 的产物没有任何可落库的正文块。
 */
function isBodylessDraft(qingml: string): boolean {
  return !completeTopLevelBlocks(qingml).blocks.some((block) =>
    !/^<title(?:\s|>)/i.test(block) && !/^<h[1-6](?:\s|>)/i.test(block))
}

const LENGTH_INSTRUCTION_LEAK_PATTERN = /(?:字数要求|(?:全文|本文|文章|篇幅)?\s*(?:约|左右|上下|至少|不少于|不低于|不超过|不多于|最多|至多|控制在)\s*[零〇一二两三四五六七八九十百千万\d,，]+\s*字|[零〇一二两三四五六七八九十百千万\d,，]+\s*字\s*(?:以内|以下|以上|左右))/u

function draftInstructionLeakWarning(qingml: string, isFirstDraft: boolean): string | undefined {
  if (!isFirstDraft) return undefined
  const bodyBlocks = completeTopLevelBlocks(qingml).blocks.filter((block) =>
    !/^<title(?:\s|>)/i.test(block) && !/^<h1(?:\s|>)/i.test(block))
  const edges = bodyBlocks.length <= 1
    ? bodyBlocks
    : [bodyBlocks[0]!, bodyBlocks.at(-1)!]
  const leaked = edges.some((block) => LENGTH_INSTRUCTION_LEAK_PATTERN.test(
    block.replace(/<[^>]+>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39);/g, ' ').replace(/\s+/g, ' ').trim(),
  ))
  return leaked
    ? '正文首尾可能混入了用户的字数要求；字数/格式要求属于写作指令，不应作为正文内容。请检查并在下一轮按正文语义修正。'
    : undefined
}

interface DraftLengthRequirement {
  min?: number
  max?: number
  target?: number
  targetKind?: 'approx' | 'bare'
}

interface DraftRequirements {
  length?: DraftLengthRequirement
}

interface DraftRequirementInput {
  requirements?: string
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

function parseDraftNumber(raw: string): number | undefined {
  const normalized = raw.replace(/[，,\s]/g, '')
  if (/^\d+$/.test(normalized)) return Number(normalized)
  if (!/^[零〇一二两三四五六七八九十百千万]+$/.test(normalized)) return undefined
  let total = 0
  let section = 0
  let digit = 0
  for (const char of normalized) {
    if (char in CHINESE_DIGITS) {
      digit = CHINESE_DIGITS[char]!
      continue
    }
    const unit = char === '十' ? 10 : char === '百' ? 100 : char === '千' ? 1_000 : 10_000
    if (unit === 10_000) {
      section = (section + digit) * unit
      total += section
      section = 0
      digit = 0
    } else {
      section += (digit || 1) * unit
      digit = 0
    }
  }
  return total + section + digit
}

const DRAFT_NUMBER_SOURCE = String.raw`(?:\d[\d,，]*|[零〇一二两三四五六七八九十百千万]+)`

/**
 * 「每节约 300 字」这类**分项**字数不是全文约束。若把「1200 字分四节」中的
 * 「每节约 300 字」当成全文目标，会推出 max=330，与真实下限 1200 自相矛盾。
 */
const PER_UNIT_LOOKBEHIND = /每\s*(?:一)?\s*(?:小?节|段(?:落)?|章|部分|篇|页|条|项|个)[^，,。;；]{0,8}$/

function isPerUnitLength(text: string, matchIndex: number): boolean {
  return PER_UNIT_LOOKBEHIND.test(text.slice(Math.max(0, matchIndex - 20), matchIndex))
}

export function draftRequirementsOf(input: DraftRequirementInput): DraftRequirements {
  const text = input.requirements ?? ''
  const length: DraftLengthRequirement = {}
  const consumed: Array<{ start: number; end: number }> = []
  let hasHardBoundary = false
  const consume = (match: RegExpExecArray): void => {
    consumed.push({ start: match.index, end: match.index + match[0].length })
  }
  const overlapsConsumed = (match: RegExpExecArray): boolean => {
    const end = match.index + match[0].length
    return consumed.some((span) => match.index < span.end && end > span.start)
  }
  for (const range of text.matchAll(new RegExp(`(${DRAFT_NUMBER_SOURCE})\\s*(?:-|—|–|~|～|至|到)\\s*(${DRAFT_NUMBER_SOURCE})\\s*字`, 'g'))) {
    if (isPerUnitLength(text, range.index)) continue
    const min = parseDraftNumber(range[1]!)
    const max = parseDraftNumber(range[2]!)
    if (min === undefined || max === undefined) continue
    length.min = min
    length.max = max
    hasHardBoundary = true
    consume(range)
    break
  }
  for (const match of text.matchAll(new RegExp(`(?:至少|不少于|不低于|最低)\\s*(${DRAFT_NUMBER_SOURCE})\\s*字|(${DRAFT_NUMBER_SOURCE})\\s*字以上`, 'g'))) {
    if (isPerUnitLength(text, match.index)) continue
    const value = parseDraftNumber(match[1] ?? match[2] ?? '')
    if (value !== undefined) {
      length.min = Math.max(length.min ?? 0, value)
      hasHardBoundary = true
      consume(match)
    }
  }
  for (const match of text.matchAll(new RegExp(`(?:至多|不超过|不多于|最多|控制在)\\s*(${DRAFT_NUMBER_SOURCE})\\s*字(?:以内|以下)?|(${DRAFT_NUMBER_SOURCE})\\s*字(?:以内|以下)`, 'g'))) {
    if (isPerUnitLength(text, match.index)) continue
    const value = parseDraftNumber(match[1] ?? match[2] ?? '')
    if (value !== undefined) {
      length.max = Math.min(length.max ?? Number.POSITIVE_INFINITY, value)
      hasHardBoundary = true
      consume(match)
    }
  }
  if (!hasHardBoundary) {
    for (const approximate of text.matchAll(new RegExp(`(?:大概|约莫|约|差不多)\\s*(${DRAFT_NUMBER_SOURCE})\\s*字|(${DRAFT_NUMBER_SOURCE})\\s*字\\s*(?:左右|上下)`, 'g'))) {
      if (isPerUnitLength(text, approximate.index) || overlapsConsumed(approximate)) continue
      const target = parseDraftNumber(approximate[1] ?? approximate[2] ?? '')
      if (target !== undefined) {
        length.target = target
        length.targetKind = 'approx'
        consume(approximate)
        break
      }
    }
  }
  if (!hasHardBoundary && length.target === undefined) {
    for (const bare of text.matchAll(new RegExp(`(${DRAFT_NUMBER_SOURCE})\\s*字`, 'g'))) {
      if (isPerUnitLength(text, bare.index) || overlapsConsumed(bare)) continue
      const target = parseDraftNumber(bare[1] ?? '')
      if (target !== undefined) {
        length.target = target
        length.targetKind = 'bare'
        break
      }
    }
  }
  // 兜底:上下限自相矛盾时,显式下限优先,丢掉不可能满足的上限,绝不把矛盾交给重试循环。
  if (length.min !== undefined && length.max !== undefined && length.min > length.max) {
    delete length.max
  }

  return {
    ...(length.min !== undefined || length.max !== undefined || length.target !== undefined ? { length } : {}),
  }
}

interface DraftLengthReport {
  gap: number
  status: 'met' | 'unmet' | 'target-missed'
}

function draftLengthReport(actual: number, requirements: DraftRequirements): DraftLengthReport | undefined {
  const length = requirements.length
  if (!length) return undefined
  if (length.target !== undefined) {
    const gap = actual - length.target
    return {
      gap,
      status: Math.abs(gap) <= Math.max(1, Math.round(length.target * 0.1)) ? 'met' : 'target-missed',
    }
  }
  if (length.min !== undefined && actual < length.min) {
    return { gap: actual - length.min, status: 'unmet' }
  }
  if (length.max !== undefined && actual > length.max) {
    return { gap: actual - length.max, status: 'unmet' }
  }
  return { gap: 0, status: 'met' }
}

function forceExplicitDraftTitle(qingml: string, title: string | undefined): string {
  const exact = title?.trim()
  if (!exact) return qingml
  const escaped = exact
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
  const tag = `<title>${escaped}</title>`
  const withTitle = /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i.test(qingml)
    ? qingml.replace(/<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i, tag)
    : `${tag}${qingml}`
  const heading = `<h1>${escaped}</h1>`
  return /<h1(?:\s[^>]*)?>[\s\S]*?<\/h1>/i.test(withTitle)
    ? withTitle.replace(/<h1(?:\s[^>]*)?>[\s\S]*?<\/h1>/i, heading)
    : withTitle.replace(tag, `${tag}${heading}`)
}

/** P14(RC13):每个工具返回带当前聚焦文稿,纠偏模型沿用旧 docRef。 */
/** mode:"blocks" 用的宽松 PM 节点形状；真实引擎标识只在本进程内映射。 */
interface PmBlockNode {
  type?: string
  attrs?: { blockId?: string }
  content?: PmBlockNode[]
  text?: string
}

function pmNodeText(node: PmBlockNode): string {
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(pmNodeText).join('')
}

interface LocatedPmNode {
  locator: string
  node: PmBlockNode
  depth: number
}

const LIST_NODE_TYPES = new Set(['orderedList', 'bulletList', 'taskList'])

/**
 * 给模型的是当前版本内稳定的短定位键 L1/L2…，真实标识不越过工具边界。
 * 清单项递归编号，既覆盖嵌套清单，也避免把其内部承载文字的 paragraph 重复列出。
 */
function locatePmNodes(doc: PmDoc): LocatedPmNode[] {
  const located: LocatedPmNode[] = []
  const append = (node: PmBlockNode, depth: number): void => {
    located.push({ locator: `L${located.length + 1}`, node, depth })
    if (!LIST_NODE_TYPES.has(node.type ?? '')) return
    for (const item of node.content ?? []) {
      located.push({ locator: `L${located.length + 1}`, node: item, depth: depth + 1 })
      for (const child of item.content ?? []) {
        if (LIST_NODE_TYPES.has(child.type ?? '')) append(child, depth + 2)
      }
    }
  }
  for (const rawNode of doc.content ?? []) append(rawNode as unknown as PmBlockNode, 0)
  return located
}

function paperKind(type: string | undefined): string {
  switch (type) {
    case 'heading': return '标题'
    case 'paragraph': return '段落'
    case 'orderedList': return '有序清单'
    case 'bulletList': return '项目清单'
    case 'taskList': return '任务清单'
    case 'listItem': return '清单项'
    case 'taskItem': return '任务项'
    case 'table': return '表格'
    case 'blockquote': return '引文'
    case 'codeBlock': return '代码段'
    case 'image': return '图片'
    default: return '内容'
  }
}

function describeLocatedNode(entry: LocatedPmNode): string {
  const { node } = entry
  const summary = pmNodeText(node).replace(/\s+/g, ' ').trim()
  const clipped = summary.length > 40 ? `${summary.slice(0, 40)}…` : summary || '(无文本)'
  return `${'  '.repeat(entry.depth)}locator=${entry.locator}｜kind=${paperKind(node.type)}｜text=${clipped}`
}

type ModelEditProposalOp = ExternalEditProposalOp | {
  kind: 'deleteBlock' | 'deleteListItem'
  locator: string
} | {
  kind: 'insertAfterBlock'
  locator: string
  markdown: string
} | (Omit<Extract<ExternalEditProposalOp, { kind: 'markText' }>, 'withinRef'> & {
  withinLocator?: string
})

function resolveEditLocators(pmDoc: PmDoc, ops: readonly ModelEditProposalOp[]): ExternalEditProposalOp[] {
  const idByLocator = new Map(locatePmNodes(pmDoc).flatMap(({ locator, node }) =>
    typeof node.attrs?.blockId === 'string' && node.attrs.blockId
      ? [[locator, node.attrs.blockId] as const]
      : []))
  const resolve = (locator: string): string => {
    const blockId = idByLocator.get(locator)
    if (!blockId) throw new Error(`定位键 ${locator} 已失效。请重新读取内容定位清单后再试。`)
    return blockId
  }
  return ops.map((op): ExternalEditProposalOp => {
    if (op.kind === 'deleteBlock' || op.kind === 'deleteListItem') {
      if ('locator' in op) return { kind: op.kind, blockId: resolve(op.locator) }
      return op
    }
    if (op.kind === 'insertAfterBlock') {
      if ('locator' in op) return { kind: op.kind, blockId: resolve(op.locator), markdown: op.markdown }
      return op
    }
    if (op.kind === 'markText' && 'withinLocator' in op && op.withinLocator) {
      const { withinLocator, ...rest } = op
      return { ...rest, withinRef: resolve(withinLocator) }
    }
    return op as ExternalEditProposalOp
  })
}

const DOC_STATE_LABELS: Record<string, string> = {
  pendingReview: '审阅中(待用户裁决)',
  editing: '已落库生效',
  empty: '空文稿',
  offline: '引擎离线',
  unavailable: '暂不可读',
}

function docStateLabel(state: string): string {
  return DOC_STATE_LABELS[state] ?? '暂不可读'
}

function focusSuffix(services: ToolServices, dshSessionId: string): string {
  const active = services.bindings.getActive(dshSessionId)
  return active ? `\n(当前面板聚焦:《${active.title}》 docRef=${active.engineSessionId};用户未点名文稿时以聚焦稿为准)` : ''
}

function assertNoRawTags(ops: ExternalEditProposalOp[]): void {
  for (const op of ops) {
    const payloads = op.kind === 'strReplace' ? [op.new] : 'markdown' in op ? [op.markdown] : []
    for (const payload of payloads) {
      if (typeof payload === 'string' && RAW_TAG_PATTERN.test(payload)) throw new Error(RAW_TAG_ERROR)
    }
  }
}

function isPipeTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 3
}

function isTableDelimiterRow(line: string): boolean {
  if (!isPipeTableRow(line)) return false
  const cells = line.trim().slice(1, -1).split('|').map((cell) => cell.trim())
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function isPipeRowsOnly(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/).filter((line) => line.trim().length > 0)
  return lines.length > 0 && lines.every(isPipeTableRow)
}

function assertNoOrphanTableRows(ops: ExternalEditProposalOp[]): void {
  for (const op of ops) {
    if (!('markdown' in op) || typeof op.markdown !== 'string') continue
    const lines = op.markdown.split(/\r?\n/).filter((line) => line.trim().length > 0)
    if (lines.length > 0 && lines.every(isPipeTableRow) && !lines.some(isTableDelimiterRow)) {
      throw new Error(ORPHAN_TABLE_ROW_ERROR)
    }
  }
}

function assertSynchronizedTitleChange(
  currentTitle: string | null | undefined,
  pmDoc: PmDoc,
  ops: ExternalEditProposalOp[],
): void {
  const titleOp = ops.find((op): op is Extract<ExternalEditProposalOp, { kind: 'setTitle' }> => op.kind === 'setTitle')
  const oldTitle = currentTitle?.trim() ?? ''
  const newTitle = titleOp?.title.trim() ?? ''
  if (!titleOp || !oldTitle || !newTitle || oldTitle === newTitle) return
  let matchOrdinal = 0
  const headingMatchOrdinals = new Set<number>()
  for (const block of pmTextBlockEntries(pmDoc)) {
    let index = block.text.indexOf(oldTitle)
    while (index >= 0) {
      matchOrdinal += 1
      if (block.type === 'heading' && block.text.trim() === oldTitle) headingMatchOrdinals.add(matchOrdinal)
      index = block.text.indexOf(oldTitle, index + oldTitle.length)
    }
  }
  if (headingMatchOrdinals.size === 0) return
  const bodyTitleIsSynchronized = ops.some((op) =>
    op.kind === 'strReplace' &&
    op.old.trim() === oldTitle &&
    op.new.trim() === newTitle &&
    (op.all === true || (op.nth === undefined ? matchOrdinal === 1 : headingMatchOrdinals.has(op.nth))))
  if (!bodyTitleIsSynchronized) {
    throw new Error(`稿名和纸面开头的标题需要一起修改。请在同一批修改中，把正文开头的「${oldTitle}」也改成「${newTitle}」。`)
  }
}

const outlineSchema = {
  type: 'array' as const,
  items: { type: 'string' as const },
}

export function registerTools(services: ToolServices): void {
  const docStates = services.docStates ?? new DocStateCache()
  const freshness = services.freshness ?? new FreshnessTracker()
  const readTurns = new ReadTurnTracker()
  const turnLeases = new AgentTurnLeaseCoordinator(
    services.engine,
    undefined,
    undefined,
    (dshSessionId, engineSessionId, generation) => {
      freshness.resetSegment(dshSessionId, engineSessionId, generation)
      readTurns.resetSegment(dshSessionId, engineSessionId)
    },
    (dshSessionId, engineSessionIds) => {
      services.bridge.emit(dshSessionId, { type: 'turn-ended', engineSessionIds })
    },
  )
  const runtime: RuntimeToolServices = {
    ...services,
    docStates,
    freshness,
    turnLeases,
    readTurns,
  }
  const { ctx } = runtime
  const reviewTurns = new ReviewTurnTracker()
  const writeTurns = new WriteTurnTracker()
  installTurnTracking(ctx, reviewTurns, writeTurns, readTurns, runtime)
  ctx.effect(() => () => runtime.turnLeases.dispose())
  ctx.effect(() => ctx.tools.register(writeDraftTool(runtime, writeTurns)))
  ctx.effect(() => ctx.tools.register(editDraftTool(runtime)))
  ctx.effect(() => ctx.tools.register(reviewCommitTool(runtime, reviewTurns)))
  ctx.effect(() => ctx.tools.register(readDraftTool(runtime, readTurns)))
  ctx.effect(() => ctx.tools.register(listDocsTool(runtime)))
  ctx.effect(() => ctx.tools.register(focusDocTool(runtime)))
}

function writeDraftTool(services: RuntimeToolServices, writeTurns: WriteTurnTracker) {
  return defineTool({
    name: 'qing_write_draft',
    description: '把你在主对话中写好的完整 QingML 文稿提交到青简。省略 docRef 会新建文稿；改写已有文稿必须传当前会话内的 docRef，并先在本回合用 full/base/lines 模式取得全文。',
    parameters: {
      qingml: { type: 'string', required: true, description: '完整 QingML 全文；必须含最前面的 <title>、同名 <h1> 纸面大标题和全部正文。' },
      title: { type: 'string', description: '用户明确指定的标题；传入后工具会让 <title> 与首个 <h1> 逐字一致。' },
      requirements: { type: 'string', description: '仅在用户明确提出全文字数要求时，原样传入相关短句（如“约 1200 字”或“至少 800 字”），供工具报告差距；不要放正文。' },
      docRef: { type: 'string', description: '要整稿改写的青简会话 ID；省略即新建。传入时，本回合须已用 qing_read_draft 的 full/base/lines 模式取得全文，作者刚直写后的唯一一次重交除外。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          blocks: { type: 'integer', required: true },
          structure: { type: 'string', required: true, description: '按纸面形态汇总的标题、正文、清单、表格等结构。' },
          words: { type: 'integer', required: true },
          status: { type: 'string', enum: ['committed', 'review'], required: true },
          engineSessionId: { type: 'string', required: true },
          docVersion: { type: 'integer', required: true },
          patchCount: { type: 'integer', description: 'review 态的待裁决处数。' },
          patchIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'review 态本批次的补丁 ID。',
          },
          wholeDocReview: { type: 'boolean', required: true },
          outline: { ...outlineSchema, required: true },
          footnotes: { type: 'integer', required: true, description: '文稿实际包含的脚注数。' },
          formulas: { type: 'integer', required: true, description: '文稿实际包含的公式数。' },
          automaticConversions: { type: 'integer', required: true, description: '已自动整理为正确格式的脚注与公式数。' },
          lengthStatus: { type: 'string', enum: ['not-requested', 'met', 'unmet', 'target-missed'], required: true, description: '显式篇幅要求的确定性验收结果。' },
          lengthGap: { type: 'integer', description: '实际字数相对目标或最近边界的有符号差值；区间内为 0。' },
          warning: { type: 'string', description: '实际保留的内容项数与提交项数不符时的缺损警告。' },
        },
      },
      render: (_args, value) => value.status === 'review'
        ? textBlock(`${docStateLine('pendingReview', value.patchCount)}\n内容构成：${value.structure}。\n本稿含 ${value.footnotes} 处脚注、${value.formulas} 个公式，其中 ${value.automaticConversions} 处已自动整理为正确格式。\n${REVIEW_END_MESSAGE}`)
        : textBlock([
          docStateLine('editing'),
          `青简文稿《${value.title}》已提交。`,
          // 反幻觉锚点:committed 必须明确否定审阅态,防模型把审阅纪律泛化脑补(实测幻觉案例)。
          `文稿已直接落库生效,当前不在审阅态,没有任何待审稿,可以立即继续修改。`,
          `文稿引用：${value.engineSessionId}`,
          `全文约 ${value.words} 字。`,
          ...(typeof value.lengthGap === 'number'
            ? [value.lengthStatus === 'met'
                ? `字数要求已满足（差距 ${value.lengthGap >= 0 ? '+' : ''}${value.lengthGap}）。`
                : `字数要求未满足，当前相对目标或最近边界差 ${value.lengthGap >= 0 ? '+' : ''}${value.lengthGap}。`]
            : []),
          `内容构成：${value.structure}。`,
          `本稿含 ${value.footnotes} 处脚注、${value.formulas} 个公式，其中 ${value.automaticConversions} 处已自动整理为正确格式。`,
          ...(typeof value.warning === 'string' ? [`⚠ ${value.warning}`] : []),
          value.outline.length ? `提纲：\n${value.outline.map((line) => `- ${line}`).join('\n')}` : '提纲：暂无标题层级。',
        ].join('\n')),
      presentationMeta: (_args, value) => ({
        title: value.title,
        blocks: value.blocks,
        structure: value.structure,
        words: value.words,
        status: value.status,
        patchCount: value.patchCount ?? 0,
        wholeDocReview: value.wholeDocReview,
        engineSessionId: value.engineSessionId,
        ...(value.status === 'review' ? { patchIds: value.patchIds } : {}),
      }),
    },
    timeoutMs: 240_000,
    presentCall: (args) => ({
      card: 'generic',
      title: args.docRef ? '正在改写青简文稿' : '正在起草青简文稿',
      kind: 'edit',
      rawInput: { ...(args.title ? { title: args.title } : {}), ...(args.requirements ? { requirements: args.requirements } : {}) },
    }),
    presentResult: (_args, result) => result.isError
      ? failedResultPresentation('青简写作未完成', result.content)
      : { card: 'generic', title: '青简文稿已生成' },
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      try {
        await assertEngineOnline(services.engine)
        const inheritedRequirements = writeTurns.assertWriteAllowed(exec, args.docRef)
        const requirements = inheritedRequirements ?? draftRequirementsOf(args)
        let qingml = args.qingml.trim()
        if (!qingml) throw new Error('qingml 不能为空。请提交完整 QingML 全文。')
        qingml = forceExplicitDraftTitle(qingml, args.title)
        if (isBodylessDraft(qingml)) throw new Error(EMPTY_DRAFT_ERROR)
        const sourceConversion = convertQingmlSourceSyntax(qingml)
        qingml = sourceConversion.qingml
        if (sourceConversion.leaks.length > 0) throw new Error(SOURCE_SYNTAX_LEAK_ERROR)
        // 与最终报告共用唯一 QingML→PM 编译入口；引擎仍会在 qingmlDraft 通道做权威白名单校验。
        compileQingmlDocument(qingml)

        let bound
        if (args.docRef) {
          if (!services.bindings.hasDoc(dshSessionId, args.docRef)) {
            throw new Error('docRef 不属于当前 DSH 会话。请先调用 qing_list_docs 获取可用文稿。')
          }
          bound = services.bindings.listDocs(dshSessionId).find((doc) => doc.engineSessionId === args.docRef)!
          await services.bindings.setActive(dshSessionId, args.docRef)
        } else {
          bound = await services.bindings.createDoc(
            dshSessionId,
            args.title?.trim() || extractTitle(qingml, '未命名文稿'),
          )
        }

        // 改写时是显式写意图；新稿则在创建成功、拿到真实文稿 ID 后立即申领。
        await services.turnLeases.touchDocument(dshSessionId, bound.engineSessionId)
        if (args.docRef) {
          services.freshness.assertWholeDraftReady(
            exec,
            bound.engineSessionId,
            services.turnLeases.generation(dshSessionId, bound.engineSessionId),
          )
        }

        const docBefore = await readDoc(services, exec, bound.engineSessionId)
        if (docBefore.state === 'pendingReview') {
          throw new Error(REVIEW_PENDING_ERROR)
        }
        let proposal: ExternalProposalResponse
        try {
          proposal = await propose(services, exec, bound.engineSessionId, docBefore.docVersion, qingml)
          // proposal 已成功就必须占用本回合额度；后续权威读回失败也不能把已发生的写当作未发生。
          writeTurns.markSuccessful(
            exec,
            bound.engineSessionId,
            requirements,
            proposal.status === 'committed',
          )
          if (proposal.status === 'committed') {
            services.freshness.markAgentWritten(
              exec,
              bound.engineSessionId,
              services.turnLeases.generation(dshSessionId, bound.engineSessionId),
            )
          }
        } catch (error) {
          throw sanitizeToolBoundaryError(error)
        }

        try {
          const [official, reviewCandidate, officialPmDoc] = await Promise.all([
            readDoc(services, exec, bound.engineSessionId),
            proposal.status === 'review'
              ? readReviewCandidate(services, exec, bound.engineSessionId)
              : Promise.resolve(null),
            readPmDoc(services, exec, bound.engineSessionId),
          ])
          reconcileReadTrackingAfterWrite(
            services,
            dshSessionId,
            bound.engineSessionId,
            proposal.status,
            official,
            officialPmDoc,
          )
          const renderedQingml = reviewCandidate?.qingml ?? official.qingml ?? qingml
          const renderedPmDoc = reviewCandidate?.pmDoc ?? officialPmDoc
          const words = countDocVisibleChars(renderedPmDoc)
          const reviewSummary = reviewCandidate
            ? renderedReviewSummary(officialPmDoc, reviewCandidate.renderModel)
            : null
          const effectiveReview = Boolean(reviewSummary?.reviewingPatchIds.length)
          const wholeDocReview = reviewCandidate
            ? isWholeDocReview({ pmDoc: officialPmDoc }, reviewCandidate.renderModel, effectiveReview)
            : false
          const reviewSuggestionIds = reviewSummary?.reviewingPatchIds ?? []
          const reviewCount = reviewSummary
            ? wholeDocReview ? 1 : reviewSummary.count
            : 0
          const title = args.title?.trim() || official.title?.trim() || extractTitle(renderedQingml, bound.title)
          await services.bindings.updateTitle(dshSessionId, bound.engineSessionId, title)
          // committed 用权威落库稿，review 用 render-model 候选稿；两者都避开本地生成文本与
          // 引擎实际接受结构不一致时的误报。
          const outline = outlineOf(renderedQingml, title)
          const structureFacts = structureFactsOf(renderedQingml)
          const submittedBlocks = completeTopLevelBlocks(qingml).blocks
            .filter((block) => !/^<title(?:\s|>)/i.test(block)).length
          const lostBlocks = Math.max(0, submittedBlocks - outline.blocks)
          if (proposal.status === 'committed') {
            services.bridge.emit(dshSessionId, {
              type: 'doc-committed',
              engineSessionId: bound.engineSessionId,
              doc: official,
              blocks: outline.blocks,
              words,
              revealWholeDraft: true,
            })
          } else {
            services.bridge.emit(dshSessionId, {
              type: 'doc-review-pending',
              engineSessionId: bound.engineSessionId,
              doc: official,
              count: reviewCount,
              blocks: outline.blocks,
              words,
            })
          }
          void services.telemetry?.capture('draft_created', {
            words_bucket: wordsBucket(words),
            blocks_bucket: blocksBucket(outline.blocks),
          })
          rememberDocState(services, exec, bound.engineSessionId, {
            state: proposal.status === 'review' ? 'pendingReview' : 'editing',
            words,
            blocks: outline.blocks,
            structure: outline.structure,
            title,
            docVersion: official.docVersion,
            ...(proposal.status === 'review' ? { patchCount: reviewCount } : {}),
          }, true)
          const lengthReport = draftLengthReport(words, requirements)
          const lengthStatus: 'not-requested' | 'met' | 'unmet' | 'target-missed' = lengthReport?.status ?? 'not-requested'
          writeTurns.recordLengthResult(exec, bound.engineSessionId, words, lengthReport)
          const instructionLeakWarning = draftInstructionLeakWarning(renderedQingml, !args.docRef)
          const warnings = [
            ...(lostBlocks > 0
              ? [`生成了 ${submittedBlocks} 项正文内容，文稿实际保留 ${outline.blocks} 项；有 ${lostBlocks} 项未通过格式检查。请重新查看文稿，补回缺失内容。`]
              : []),
            ...(instructionLeakWarning ? [instructionLeakWarning] : []),
          ]
          return {
            title,
            blocks: outline.blocks,
            structure: outline.structure,
            words,
            ...(warnings.length > 0 ? { warning: warnings.join('；') } : {}),
            status: proposal.status,
            engineSessionId: bound.engineSessionId,
            docVersion: official.docVersion,
            wholeDocReview,
            footnotes: structureFacts.footnotes,
            formulas: structureFacts.formulas,
            automaticConversions: sourceConversion.converted,
            lengthStatus,
            ...(lengthReport ? { lengthGap: lengthReport.gap } : {}),
            ...(proposal.status === 'review'
              ? { patchCount: reviewCount, patchIds: reviewSuggestionIds }
              : {}),
            outline: outline.headings.map((heading) => `${'  '.repeat(Math.max(0, heading.level - 1))}${heading.text}`),
          }
        } catch (error) {
          throw sanitizeToolBoundaryError(error)
        }
      } catch (error) {
        throw sanitizeToolBoundaryError(error)
      } finally {
        services.bridge.clearSelection(dshSessionId)
      }
    },
  })
}

function editDraftTool(services: RuntimeToolServices) {
  return defineTool({
    name: 'qing_edit_draft',
    description: '对已有青简文稿做结构化局部修改。改标题时,若正文有与旧稿名相同的纸面大标题,要同时用 setTitle 改稿名(元数据)、用 strReplace 改纸面标题;两者必须在同一次 ops 里一起提交,文字保持一致。正文没有同名纸面大标题时,允许只用 setTitle。删除整段/整节/清单项用 deleteBlock/deleteListItem,先 qing_read_draft mode:"blocks" 取得短定位键 locator,严禁用 strReplace 置空留残壳;真实引擎标识由工具内部映射,不要猜测或传入。改一句、插入一段或追加一节用相应操作;高亮、文字颜色、加粗一句话等行内标记用 markText。markText remove 前先读稿确认现有标记的确切 attrs;代码段内文本不支持行内标记。strReplace 的 old/new 通常必须是纯文本，不含 ##、-、** 等 Markdown 标记；只有扩展既有表格行或整块替换 fenced Mermaid 时传完整 Markdown 块。表格行严禁用 insertAfterLine/insertAfterBlock/appendSection 插入孤立管道文本。只有用户明确表达「所有/全部/凡是/都」等全局意图时,才用单个 strReplace + all:true;all:true 不得与 nth 同时使用。多处修改必须放进同一次调用的 ops 数组原子提交。insertAfterLine 的行号来自读稿当刻;同批先增删内容会令后续旧行号失效。复杂清单或表格附近优先使用 mode:"blocks" 给出的 locator。修改 Mermaid 先用 mode:"lines" 读取完整 fenced 块,再整块 strReplace,不得逐行改。文稿审阅中不得调用，应先用 ask_user 征询用户如何处理待审稿。',
    parameters: {
      docRef: { type: 'string', description: '要局部修改的青简会话 ID；省略时使用当前激活文稿。' },
      ops: {
        type: 'array',
        required: true,
        description: '同一次调用中按顺序原子提交的局部操作（最多 50 条）；多处修改必须全部放在本数组中。strReplace 的 nth 为从 1 开始的命中序号；用户明确要求全量替换时改用单个 strReplace + all:true。',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'strReplace', required: true },
                old: { type: 'string', required: true, description: '要匹配的纯文本内容；扩展表格行或替换 Mermaid 时例外传既有完整 Markdown 行/块。' },
                new: { type: 'string', required: true, description: '替换后的纯文本内容；扩展表格行或替换 Mermaid 时例外传扩展后的完整 Markdown 行/块。' },
                nth: { type: 'integer', description: '只替换从 1 开始计数的第几处命中；不得与 all:true 同时使用。' },
                all: { type: 'boolean', description: '仅当用户明确说「所有/全部/凡是/都」等全局范围时设为 true；用单个操作替换全部命中，不得与 nth 同时使用。' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'markText', required: true },
                find: { type: 'string', required: true },
                mark: {
                  required: true,
                  oneOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'bold', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'italic', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'strike', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'underline', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'code', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        type: { type: 'string', const: 'highlight', required: true },
                        color: { type: 'string', enum: DRAFT_MARK_COLORS, required: true },
                      },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        type: { type: 'string', const: 'textColor', required: true },
                        color: { type: 'string', enum: DRAFT_MARK_COLORS, required: true },
                      },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        type: { type: 'string', const: 'link', required: true },
                        href: { type: 'string', required: true },
                        title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                      },
                    },
                  ],
                },
                op: { type: 'string', enum: ['add', 'remove'], required: true },
                all: { type: 'boolean' },
                isRegex: { type: 'boolean' },
                withinLocator: { type: 'string', description: '可选的内容定位键；从 qing_read_draft mode:"blocks" 的 locator 字段取得。' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'insertAfterLine', required: true },
                line: { type: 'integer', required: true },
                markdown: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'appendSection', required: true },
                markdown: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'deleteBlock', required: true },
                locator: { type: 'string', required: true, description: '要整段或整节删除的短定位键，从 qing_read_draft mode:"blocks" 的 locator 字段取得。' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'deleteListItem', required: true },
                locator: { type: 'string', required: true, description: '要删除的清单项/任务项定位键，从 qing_read_draft mode:"blocks" 获取。' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'insertAfterBlock', required: true },
                locator: { type: 'string', required: true, description: '插入位置的短定位键，从 qing_read_draft mode:"blocks" 获取。定位清单项时插入同层兄弟项；定位顶层内容时在其后插入。' },
                markdown: { type: 'string', required: true, description: '要插入的 Markdown 内容;禁止 HTML/QingML 标签。' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'setTitle', required: true },
                title: { type: 'string', required: true, description: '新标题;引擎约束:去空白后 1-48 字,同一批最多一个 setTitle,不与整篇 draft 混用。正文存在与旧稿名相同的大标题时,必须在同一次 ops 里用 strReplace 同步修改;不存在时允许只改稿名。' },
              },
            },
          ],
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['committed', 'review'], required: true },
          message: { type: 'string', required: true },
          engineSessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          blocks: { type: 'integer', required: true },
          structure: { type: 'string', required: true, description: '按纸面形态汇总的标题、正文、清单、表格等结构。' },
          words: { type: 'integer', required: true },
          docVersion: { type: 'integer', required: true },
          reviewCount: { type: 'integer', required: true },
          opResults: {
            type: 'array',
            required: true,
            description: '原始 ops 中每项文字替换实际涉及的处数；opIndex 从 1 开始。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                opIndex: { type: 'integer', required: true },
                affectedCount: { type: 'integer', required: true },
              },
            },
          },
          affectedCount: { type: 'integer', required: true, description: '本批文字替换共影响的处数。' },
          patchIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'review 态本批次的补丁 ID。',
          },
          wholeDocReview: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(value.message),
      presentationMeta: (_args, value) => ({
        status: value.status,
        engineSessionId: value.engineSessionId,
        title: value.title,
        blocks: value.blocks,
        structure: value.structure,
        words: value.words,
        reviewCount: value.reviewCount,
        opResults: value.opResults,
        affectedCount: value.affectedCount,
        wholeDocReview: value.wholeDocReview,
        ...(value.status === 'review' ? { patchIds: value.patchIds } : {}),
      }),
    },
    presentCall: () => ({ card: 'generic', title: '正在局部修改青简文稿', kind: 'edit' }),
    presentResult: (_args, result) => result.isError
      ? failedResultPresentation('青简局部修改未完成', result.content)
      : { card: 'generic', title: '青简局部修改已提交' },
    finalizeContent: (_exec, result) => result.isError
      ? sanitizeEditFailureContent(result.content)
      : undefined,
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      try {
        await assertEngineOnline(services.engine)
        const engineSessionId = resolveDocRef(services, dshSessionId, args.docRef)
        await services.turnLeases.touchDocument(dshSessionId, engineSessionId)
        services.freshness.assertFresh(
          exec,
          engineSessionId,
          services.turnLeases.generation(dshSessionId, engineSessionId),
        )
        await services.bindings.setActive(dshSessionId, engineSessionId)
        const before = await readDocWithLines(services, exec, engineSessionId)
        if (before.state === 'pendingReview') throw new Error(REVIEW_PENDING_ERROR)
        const modelOps = args.ops as ModelEditProposalOp[]
        const titleOnly = modelOps.every((op) => op.kind === 'setTitle')
        if (before.state === 'empty' && !titleOnly) throw new Error('文稿尚无正文；请先用 qing_write_draft 起草完整文稿。改标题可单独用 setTitle。')
        const needsLocatorMap = modelOps.some((op) =>
          'locator' in op || (op.kind === 'markText' && 'withinLocator' in op && Boolean(op.withinLocator)))
        const basePmDoc = modelOps.some((op) => op.kind === 'setTitle') || needsLocatorMap
          ? await readPmDoc(services, exec, engineSessionId)
          : undefined
        const ops = needsLocatorMap
          ? resolveEditLocators(basePmDoc!, modelOps)
          : modelOps as ExternalEditProposalOp[]
        assertNoRawTags(ops)
        assertNoOrphanTableRows(ops)
        if (basePmDoc) assertSynchronizedTitleChange(before.title, basePmDoc, ops)
        const prepared = await prepareEditOps(services, exec, engineSessionId, ops, basePmDoc)
        const proposal = await proposeEditOpsWithPlainTextRetry(
          services,
          exec,
          engineSessionId,
          before.docVersion,
          prepared.ops,
        )
        const [official, reviewCandidate, officialPmDoc] = await Promise.all([
          readDoc(services, exec, engineSessionId),
          proposal.status === 'review'
            ? readReviewCandidate(services, exec, engineSessionId)
            : Promise.resolve(null),
          readPmDoc(services, exec, engineSessionId),
        ])
        reconcileReadTrackingAfterWrite(
          services,
          dshSessionId,
          engineSessionId,
          proposal.status,
          official,
          officialPmDoc,
        )
        const renderedQingml = reviewCandidate?.qingml ?? official.qingml
        const renderedPmDoc = reviewCandidate?.pmDoc ?? officialPmDoc
        const words = countDocVisibleChars(renderedPmDoc)
        const reviewSummary = reviewCandidate
          ? renderedReviewSummary(officialPmDoc, reviewCandidate.renderModel)
          : null
        const effectiveReview = Boolean(reviewSummary?.reviewingPatchIds.length)
        const wholeDocReview = reviewCandidate
          ? isWholeDocReview({ pmDoc: officialPmDoc }, reviewCandidate.renderModel, effectiveReview)
          : false
        const reviewSuggestionIds = reviewSummary?.reviewingPatchIds ?? []
        const reviewCount = reviewSummary
          ? wholeDocReview ? 1 : reviewSummary.count
          : 0
        const outline = outlineOf(renderedQingml, official.title)
        await services.bindings.updateTitle(dshSessionId, engineSessionId, outline.title)
        if (proposal.status === 'committed') {
          services.bridge.emit(dshSessionId, {
            type: 'doc-committed',
            engineSessionId,
            doc: official,
            blocks: outline.blocks,
            words,
          })
        } else {
          services.bridge.emit(dshSessionId, {
            type: 'doc-review-pending',
            engineSessionId,
            doc: official,
            count: reviewCount,
            blocks: outline.blocks,
            words,
          })
        }
        const countLine = editCountLine(prepared.opResults, prepared.affectedCount)
        void services.telemetry?.capture('draft_edited', {
          ops_bucket: countBucket(modelOps.length),
          op_kinds: [...new Set(modelOps.map((op) => op.kind))],
          outcome: proposal.status,
        })
        rememberDocState(services, exec, engineSessionId, {
          state: proposal.status === 'review' ? 'pendingReview' : 'editing',
          words,
          blocks: outline.blocks,
          structure: outline.structure,
          title: outline.title,
          docVersion: official.docVersion,
          ...(proposal.status === 'review' ? { patchCount: reviewCount } : {}),
        }, true)
        return {
          status: proposal.status,
          message: (proposal.status === 'review'
            ? `${docStateLine('pendingReview', reviewCount)}${countLine}\n内容构成：${outline.structure}。\n${REVIEW_END_MESSAGE}`
            : `${docStateLine('editing')}\n局部修改已提交到《${outline.title}》。${countLine}\n内容构成：${outline.structure}。`) + focusSuffix(services, dshSessionId),
          engineSessionId,
          title: outline.title,
          blocks: outline.blocks,
          structure: outline.structure,
          words,
          docVersion: official.docVersion,
          reviewCount: proposal.status === 'review' ? reviewCount : 0,
          opResults: prepared.opResults,
          affectedCount: prepared.affectedCount,
          ...(proposal.status === 'review' ? { patchIds: reviewSuggestionIds } : {}),
          wholeDocReview,
        }
      } catch (error) {
        void services.telemetry?.capture('edit_rejected', { reason: editRejectedReason(error) })
        throw sanitizeToolBoundaryError(error)
      } finally {
        services.bridge.clearSelection(dshSessionId)
      }
    },
  })
}

function reviewCommitTool(services: RuntimeToolServices, reviewTurns: ReviewTurnTracker) {
  return defineTool({
    name: 'qing_review_commit',
    description: '全量接受或拒绝青简文稿的待审变更。仅当用户在原话中明确授权（如“直接改不用问”“全部接受”“全部放弃”）才可调用；默认必须让用户逐处裁决。审阅中收到新的修改指令时，先调 qing_list_docs 确认文稿仍在审阅中，确认后用 ask_user 征询用户如何处理当前待审稿，禁止擅自 accept_all/reject_all。同一 DSH 会话回合最多调用一次。docRef 省略时使用活跃文稿。',
    parameters: {
      docRef: { type: 'string', description: '青简会话 ID；省略时处理当前激活文稿。' },
      action: { type: 'string', enum: ['accept_all', 'reject_all'], required: true, description: 'accept_all 全部接受；reject_all 全部拒绝。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['reviewed', 'no_pending_review'], required: true },
          message: { type: 'string', required: true },
          engineSessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          docVersion: { type: 'integer', required: true },
          acceptedCount: { type: 'integer', required: true },
          rejectedCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => textBlock(value.message),
      presentationMeta: (_args, value) => ({
        status: value.status,
        engineSessionId: value.engineSessionId,
        title: value.title,
        acceptedCount: value.acceptedCount,
        rejectedCount: value.rejectedCount,
      }),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'accept_all' ? '接受全部青简修改' : '拒绝全部青简修改',
      kind: 'edit',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? '青简审阅处理未完成' : '青简审阅已处理',
    }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      await assertEngineOnline(services.engine)
      reviewTurns.assertFirstAdjudication(exec)
      const engineSessionId = resolveDocRef(services, dshSessionId, args.docRef)
      await services.turnLeases.touchDocument(dshSessionId, engineSessionId)
      const before = await readDoc(services, exec, engineSessionId)
      const beforeTitle = before.title?.trim() || services.bindings.listDocs(dshSessionId)
        .find((doc) => doc.engineSessionId === engineSessionId)?.title || '未命名文稿'
      if (before.state !== 'pendingReview') {
        await refreshAndPublishDocState(services, exec, true, engineSessionId)
        return {
          status: 'no_pending_review' as const,
          message: `【文稿状态】已落库生效,当前无待审稿——此前的审阅已由用户在面板处理完毕。不要再次询问如何处置待审稿,直接按用户最新指令继续。${focusSuffix(services, dshSessionId)}`,
          engineSessionId,
          title: beforeTitle,
          docVersion: before.docVersion,
          acceptedCount: 0,
          rejectedCount: 0,
        }
      }

      const body: ExternalReviewCommitRequest = {
        expectedDocVersion: before.docVersion,
        action: args.action,
      }
      const reviewed = await commitReview(services, exec, engineSessionId, body)
      const [official, officialPmDoc] = await Promise.all([
        readDoc(services, exec, engineSessionId),
        readPmDoc(services, exec, engineSessionId),
      ])
      reconcileReadTrackingAfterWrite(
        services,
        dshSessionId,
        engineSessionId,
        'committed',
        official,
        officialPmDoc,
      )
      const outline = outlineOf(official.qingml, official.title)
      const words = countDocVisibleChars(officialPmDoc)
      await services.bindings.updateTitle(dshSessionId, engineSessionId, outline.title)
      services.bridge.emit(dshSessionId, {
        type: 'doc-committed',
        engineSessionId,
        doc: official,
        blocks: outline.blocks,
        words,
      })
      const settledPatches = reviewed.acceptedCount + reviewed.rejectedCount
      if (settledPatches > 0) {
        void services.telemetry?.capture('review_settled', {
          action: args.action === 'reject_all' ? 'discard' : 'commit',
          patches_bucket: patchesBucket(settledPatches),
          retried: false,
        })
      }
      rememberDocState(services, exec, engineSessionId, {
        state: 'editing',
        words,
        blocks: outline.blocks,
        structure: outline.structure,
        title: outline.title,
        docVersion: official.docVersion,
      }, true)
      return {
        status: 'reviewed' as const,
        message: `【文稿状态】已落库生效,无待审稿。\n${args.action === 'accept_all' ? '已接受' : '已拒绝'}全部待审变更（接受 ${reviewed.acceptedCount} 处，拒绝 ${reviewed.rejectedCount} 处）。请继续完成已排队编辑。${focusSuffix(services, dshSessionId)}`,
        engineSessionId,
        title: outline.title,
        docVersion: official.docVersion,
        acceptedCount: reviewed.acceptedCount,
        rejectedCount: reviewed.rejectedCount,
      }
    },
  })
}

function readDraftTool(services: RuntimeToolServices, readTurns: ReadTurnTracker) {
  return defineTool({
    name: 'qing_read_draft',
    description: '读取当前会话绑定的青简文稿。审阅态下 outline/full 默认读取尚未生效的待审候选；mode:"base" 才读取已提交基线。局部插入前用 mode:"lines" 取得已提交 Markdown 行号；删除整段、整节或清单项前用 mode:"blocks" 取得短定位键。',
    parameters: {
      docRef: { type: 'string', description: '青简会话 ID；省略时读取当前激活文稿。' },
      mode: { type: 'string', enum: ['outline', 'full', 'base', 'lines', 'blocks'], default: 'outline', description: 'outline 返回提纲；full 返回完整候选；base 返回已提交基线 QingML；lines 返回带行号的已提交 Markdown；blocks 返回已提交内容的短定位键清单，供 deleteBlock/deleteListItem/insertAfterBlock 使用。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          words: { type: 'integer', required: true },
          blocks: { type: 'integer', required: true },
          structure: { type: 'string', required: true },
          mode: { type: 'string', enum: ['outline', 'full', 'base', 'lines', 'blocks'], required: true },
          content: { type: 'string', required: true },
          engineSessionId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          docVersion: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => textBlock(`${docStateLine(value.state)}\n《${value.title}》｜${value.structure}｜约 ${value.words} 字\n${value.content}`),
      presentationMeta: (_args, value) => ({ title: value.title, words: value.words, mode: value.mode }),
    },
    presentCall: () => ({ card: 'generic', title: '读取青简文稿', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '读取青简文稿失败' : '已读取青简文稿' }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      await assertEngineOnline(services.engine)
      const engineSessionId = resolveDocRef(services, dshSessionId, args.docRef)
      services.turnLeases.observeDocument(dshSessionId, engineSessionId)
      // 纯读不申领租约；同回合的其它 mode 复用这份单读快照。
      const held = readTurns.snapshot(dshSessionId, engineSessionId)
      let doc: TurnDocSnapshot['doc']
      let basePmDoc: TurnDocSnapshot['basePmDoc']
      let currentReviewCandidate: TurnDocSnapshot['reviewCandidate']
      if (held) {
        ;({ doc, basePmDoc, reviewCandidate: currentReviewCandidate } = held)
      } else {
        ;[doc, basePmDoc] = await Promise.all([
          readDoc(services, exec, engineSessionId),
          readPmDoc(services, exec, engineSessionId),
        ])
        currentReviewCandidate = doc.state === 'pendingReview'
          ? await readReviewCandidate(services, exec, engineSessionId)
          : null
        readTurns.rememberSnapshot(dshSessionId, engineSessionId, { doc, basePmDoc, reviewCandidate: currentReviewCandidate })
      }
      const mode = args.mode ?? 'outline'
      const currentQingml = currentReviewCandidate?.qingml ?? doc.qingml
      const currentPmDoc = currentReviewCandidate?.pmDoc ?? basePmDoc
      const currentOutline = outlineOf(currentQingml, doc.title)
      const currentReviewSummary = currentReviewCandidate
        ? renderedReviewSummary(basePmDoc, currentReviewCandidate.renderModel)
        : null
      const currentWholeDocReview = currentReviewCandidate
        ? isWholeDocReview(
            { pmDoc: basePmDoc },
            currentReviewCandidate.renderModel,
            Boolean(currentReviewSummary?.reviewingPatchIds.length),
          )
        : false
      const currentPatchCount = currentReviewSummary
        ? currentWholeDocReview ? 1 : currentReviewSummary.count
        : undefined
      const repeated = readTurns.has(exec, engineSessionId, mode, doc.docVersion)
      if (mode === 'blocks') {
        const outline = outlineOf(doc.qingml, doc.title)
        const content = repeated
          ? repeatedReadNotice(mode)
          : [
              '以下为已提交内容的机器定位清单；locator 只在当前版本有效，结构操作只传 locator，不要猜测真实标识。',
              ...locatePmNodes(basePmDoc).map(describeLocatedNode),
            ].join('\n')
        rememberDocState(services, exec, engineSessionId, {
          state: doc.state,
          words: countDocVisibleChars(currentPmDoc),
          blocks: currentOutline.blocks,
          structure: currentOutline.structure,
          title: currentOutline.title,
          docVersion: doc.docVersion,
          ...(currentPatchCount !== undefined ? { patchCount: currentPatchCount } : {}),
        }, true, mode)
        readTurns.remember(exec, engineSessionId, mode, doc.docVersion)
        return {
          title: outline.title,
          words: countDocVisibleChars(basePmDoc),
          blocks: outline.blocks,
          structure: outline.structure,
          mode,
          content,
          engineSessionId,
          state: doc.state,
          docVersion: doc.docVersion,
        }
      }
      if (mode === 'lines') {
        const lined = repeated ? null : await readDocWithLines(services, exec, engineSessionId)
        const outline = outlineOf(doc.qingml, doc.title)
        const notice = `${STR_REPLACE_LINES_NOTICE}\n${doc.state === 'pendingReview'
          ? '以下行号对应已提交基线（不含待审候选）。\n'
          : ''}`
        rememberDocState(services, exec, engineSessionId, {
          state: doc.state,
          words: countDocVisibleChars(currentPmDoc),
          blocks: currentOutline.blocks,
          structure: currentOutline.structure,
          title: currentOutline.title,
          docVersion: doc.docVersion,
          ...(currentPatchCount !== undefined ? { patchCount: currentPatchCount } : {}),
        }, true, mode)
        readTurns.remember(exec, engineSessionId, mode, doc.docVersion)
        return {
          title: outline.title,
          words: countDocVisibleChars(basePmDoc),
          blocks: outline.blocks,
          structure: outline.structure,
          mode,
          content: repeated
            ? repeatedReadNotice(mode)
            : `${notice}${lined!.markdownWithLineNumbers ?? lineNumbered(lined!.markdown)}`,
          engineSessionId,
          state: doc.state,
          docVersion: doc.docVersion,
        }
      }
      const reviewCandidate = mode !== 'base' ? currentReviewCandidate : null
      const candidate = reviewCandidate?.qingml ?? doc.qingml
      const candidatePmDoc = reviewCandidate?.pmDoc ?? basePmDoc
      const outline = outlineOf(candidate, doc.title)
      const notice = doc.state === 'pendingReview' && mode !== 'base'
        ? '以下为待审候选（尚未生效）；已提交基线请传 mode:"base"。\n'
        : mode === 'base' && doc.state === 'pendingReview'
          ? '以下为已提交基线（不含待审候选）。\n'
          : ''
      const content = repeated
        ? repeatedReadNotice(mode)
        : mode === 'full' || mode === 'base'
          ? `${notice}${candidate}`
          : `${notice}${outline.headings.map((heading) => `${'#'.repeat(heading.level)} ${heading.text}${heading.firstSentence ? `\n${heading.firstSentence}` : ''}`).join('\n') || '暂无标题层级。'}`
      rememberDocState(services, exec, engineSessionId, {
        state: doc.state,
        words: countDocVisibleChars(currentPmDoc),
        blocks: currentOutline.blocks,
        structure: currentOutline.structure,
        title: currentOutline.title,
        docVersion: doc.docVersion,
        ...(currentPatchCount !== undefined ? { patchCount: currentPatchCount } : {}),
      }, true, mode)
      readTurns.remember(exec, engineSessionId, mode, doc.docVersion)
      return {
        title: outline.title,
        words: countDocVisibleChars(candidatePmDoc),
        blocks: outline.blocks,
        structure: outline.structure,
        mode,
        content,
        engineSessionId,
        state: doc.state,
        docVersion: doc.docVersion,
      }
    },
  })
}

function listDocsTool(services: RuntimeToolServices) {
  return defineTool({
    name: 'qing_list_docs',
    description: '列出青简文稿。默认列当前 DSH 会话绑定的文稿;scope:"library" 列整个青简文库最近更新的文稿(含其他会话的,最多 50 篇),配合 qing_focus_doc 可收养到本会话。',
    parameters: {
      scope: { type: 'string', enum: ['session', 'library'], default: 'session', description: 'session=本会话绑定稿;library=全库最近文稿。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engine: { type: 'string', enum: ['online', 'offline', 'starting', 'handshake-failed'], required: true },
          docs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                engineSessionId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                active: { type: 'boolean', required: true },
                state: { type: 'string', required: true },
                docVersion: { type: 'integer' },
                createdAt: { type: 'string', required: true },
                bound: { type: 'boolean', description: 'library 模式下:是否已绑定到本会话。' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const active = args.scope !== 'library'
          ? value.docs.find((doc) => doc.active && typeof doc.docVersion === 'number')
          : undefined
        return textBlock([
          `青简引擎：${value.engine}`,
          ...(active ? [docStateLine(active.state)] : []),
          value.docs.length
            ? value.docs.map((doc) => `${doc.active ? '→' : ' '} ${doc.title}｜${docStateLabel(doc.state)}｜${doc.engineSessionId}${doc.bound === false ? '｜未绑定(可用 qing_focus_doc 收养)' : ''}`).join('\n')
            : args.scope === 'library' ? '文库暂无文稿。' : '当前会话还没有绑定文稿。',
        ].join('\n'))
      },
      presentationMeta: (args, value) => ({ count: value.docs.length, scope: args.scope ?? 'session' }),
    },
    presentCall: (args) => ({ card: 'generic', title: args.scope === 'library' ? '查看青简文库' : '查看青简文稿', kind: 'read' }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      const engine = await assertEngineOnline(services.engine)
      const binding = services.bindings.getBinding(dshSessionId)
      if (args.scope === 'library') {
        // 文库模式:引擎全库最近文稿(含其他会话),供空会话/跨会话收养闭环(P40,K3 定案 B)。
        const listing = await services.engine.fetchJson<{
          sessions: Array<{ id: string; title: string | null; state: string; updatedAt: string }>
        }>('/sessions?limit=50')
        const boundIds = new Set(binding.docs.map((doc) => doc.engineSessionId))
        await refreshAndPublishDocState(services, exec, false)
        return {
          engine: engine.state,
          docs: listing.sessions.map((session) => ({
            engineSessionId: session.id,
            title: session.title ?? '未命名文稿',
            active: session.id === binding.activeEngineSessionId,
            state: session.state,
            createdAt: session.updatedAt,
            bound: boundIds.has(session.id),
          })),
        }
      }
      const docs = await Promise.all(binding.docs.map(async (bound) => {
        let state = 'offline'
        let docVersion: number | undefined
        if (engine.state === 'online') {
          try {
            const current = await readDoc(services, exec, bound.engineSessionId)
            state = current.state
            docVersion = current.docVersion
          } catch (error) {
            if (error instanceof EngineUnavailableError) throw error
            state = 'unavailable'
          }
        }
        return {
          ...bound,
          active: bound.engineSessionId === binding.activeEngineSessionId,
          state,
          ...(docVersion !== undefined ? { docVersion } : {}),
        }
      }))
      await refreshAndPublishDocState(services, exec, false)
      return { engine: engine.state, docs }
    },
  })
}

function focusDocTool(services: RuntimeToolServices) {
  return defineTool({
    name: 'qing_focus_doc',
    description: '把右侧青简宣纸预览切换到指定文稿。docRef 未绑定到本会话时,会从青简文库收养该文稿(按 ID 或标题精确匹配且唯一;先用 qing_list_docs scope:"library" 查看文库)。',
    parameters: {
      docRef: { type: 'string', required: true, description: '青简会话 ID,或文库中的文稿标题(精确匹配)。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engineSessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          focused: { type: 'boolean', const: true, required: true },
          state: { type: 'string', required: true },
          docVersion: { type: 'integer', required: true },
          adopted: { type: 'boolean', description: '本次是否为从文库收养(跨会话)。' },
          warning: { type: 'string' },
        },
      },
      render: (_args, value) => textBlock([
        docStateLine(value.state),
        value.adopted
          ? `已从文库收养《${value.title}》(${value.engineSessionId})并切换右侧预览。`
          : `右侧预览已切换到《${value.title}》（${value.engineSessionId}）。`,
        ...(value.warning ? [`⚠ ${value.warning}`] : []),
      ].join('\n')),
      presentationMeta: (_args, value) => ({ adopted: Boolean(value.adopted), title: value.title }),
    },
    presentCall: () => ({ card: 'generic', title: '切换青简预览', kind: 'read' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError
        ? '切换青简预览失败'
        : (result.meta as { adopted?: boolean } | undefined)?.adopted ? '已收养文库文稿' : '已切换青简预览',
    }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      await assertEngineOnline(services.engine)
      const binding = services.bindings.getBinding(dshSessionId)
      if (binding.docs.some((item) => item.engineSessionId === args.docRef)) {
        const doc = await services.bindings.setActive(dshSessionId, args.docRef)
        const current = await readDoc(services, exec, doc.engineSessionId)
        services.bridge.emit(dshSessionId, { type: 'focus-changed', engineSessionId: doc.engineSessionId })
        await refreshAndPublishDocState(services, exec, false)
        return {
          engineSessionId: doc.engineSessionId,
          title: doc.title,
          focused: true as const,
          state: current.state,
          docVersion: current.docVersion,
        }
      }
      // 收养路径(P40,K3 定案):先按 ID 探测引擎确有此稿;未命中再按标题精确匹配,须唯一——
      // 模糊匹配是误收养的最大事故面,多命中一律报错并列候选让用户选。
      let target: { id: string; title: string; state: string } | undefined
      try {
        const probe = await readDoc(services, exec, args.docRef)
        target = { id: args.docRef, title: probe.title?.trim() || '未命名文稿', state: probe.state }
      } catch {
        const listing = await services.engine.fetchJson<{
          sessions: Array<{ id: string; title: string | null; state: string; updatedAt: string }>
        }>('/sessions?limit=50')
        const matches = listing.sessions.filter((session) => (session.title ?? '').trim() === args.docRef.trim())
        if (matches.length > 1) {
          throw new Error(`标题「${args.docRef}」在文库命中 ${matches.length} 篇,请改用文稿 ID:\n${matches.map((m) => `- ${m.title}｜${m.id}`).join('\n')}`)
        }
        if (matches.length === 1) {
          target = { id: matches[0].id, title: matches[0].title ?? '未命名文稿', state: matches[0].state }
        }
      }
      if (!target) {
        throw new Error('未找到该文稿:既不是本会话绑定稿,ID/标题在文库中也未精确命中。先用 qing_list_docs scope:"library" 查看文库。')
      }
      const doc = await services.bindings.adoptDoc(dshSessionId, target.id, target.title)
      const current = await readDoc(services, exec, doc.engineSessionId)
      services.bridge.emit(dshSessionId, { type: 'focus-changed', engineSessionId: doc.engineSessionId })
      await refreshAndPublishDocState(services, exec, false)
      return {
        engineSessionId: doc.engineSessionId,
        title: doc.title,
        focused: true as const,
        state: current.state,
        docVersion: current.docVersion,
        adopted: true,
        ...(current.state === 'pendingReview'
          ? { warning: '该稿有待审内容,可能来自其他会话——不得代为提交/放弃,先向用户说明。' }
          : {}),
      }
    },
  })
}

interface DocStateReadServices {
  engine: EngineService
  bindings: BindingStore
}

/** 读取当前聚焦稿的权威摘要；正文只在进程内计算，缓存与注入均不保存正文。 */
export async function refreshDocState(
  services: DocStateReadServices,
  cache: DocStateCache,
  dshSessionId: string,
): Promise<DocStateSnapshot | undefined> {
  const active = services.bindings.getActive(dshSessionId)
  if (!active) {
    cache.dispose(dshSessionId)
    return undefined
  }
  const [doc, basePmDoc] = await Promise.all([
    readDocRaw(services.engine, active.engineSessionId),
    readPmDocRaw(services.engine, active.engineSessionId),
  ])
  const reviewCandidate = doc.state === 'pendingReview'
    ? await readReviewCandidateRaw(services.engine, active.engineSessionId)
    : null
  const qingml = reviewCandidate?.qingml ?? doc.qingml
  const pmDoc = reviewCandidate?.pmDoc ?? basePmDoc
  const outline = outlineOf(qingml, doc.title ?? active.title)
  const reviewSummary = reviewCandidate
    ? renderedReviewSummary(basePmDoc, reviewCandidate.renderModel)
    : null
  const wholeDocReview = reviewCandidate
    ? isWholeDocReview(
        { pmDoc: basePmDoc },
        reviewCandidate.renderModel,
        Boolean(reviewSummary?.reviewingPatchIds.length),
      )
    : false
  const patchCount = reviewSummary
    ? wholeDocReview ? 1 : reviewSummary.count
    : undefined
  return cache.update(dshSessionId, {
    state: doc.state,
    words: countDocVisibleChars(pmDoc),
    blocks: outline.blocks,
    structure: outline.structure,
    title: outline.title,
    docVersion: doc.docVersion,
    ...(patchCount !== undefined ? { patchCount } : {}),
  })
}

function reconcileReadTrackingAfterWrite(
  services: RuntimeToolServices,
  dshSessionId: string,
  engineSessionId: string,
  status: ExternalProposalResponse['status'] | 'committed',
  official: ExternalDoc,
  officialPmDoc: PmDoc,
): void {
  if (status === 'committed') {
    // canonical 已推进：用新版本权威稿覆盖快照，作者当回合无需再读。
    services.readTurns.rememberSnapshot(dshSessionId, engineSessionId, {
      doc: official,
      basePmDoc: officialPmDoc,
      reviewCandidate: null,
    })
  } else {
    // review 只产生候选，canonical 版本未动；旧快照必须删掉而不能伪装成新稿。
    services.readTurns.invalidateSnapshot(dshSessionId, engineSessionId)
  }
  services.readTurns.clearMarks(dshSessionId, engineSessionId)
}

function rememberDocState(
  services: RuntimeToolServices,
  exec: ToolRunContext,
  engineSessionId: string,
  snapshot: Omit<DocStateSnapshot, 'dirty'>,
  establishesFreshness: boolean,
  readMode?: DraftReadMode,
): void {
  const dshSessionId = sessionIdOf(exec)
  services.docStates.update(dshSessionId, snapshot)
  if (establishesFreshness) {
    const generation = services.turnLeases.generation(dshSessionId, engineSessionId)
    if (readMode) services.freshness.markRead(exec, engineSessionId, readMode, generation)
    else services.freshness.markFresh(exec, engineSessionId, generation)
  }
}

async function refreshAndPublishDocState(
  services: RuntimeToolServices,
  exec: ToolRunContext,
  establishesFreshness: boolean,
  engineSessionId?: string,
): Promise<void> {
  const dshSessionId = sessionIdOf(exec)
  const target = engineSessionId ?? services.bindings.getActive(dshSessionId)?.engineSessionId
  if (establishesFreshness && target) {
    services.freshness.markFresh(
      exec,
      target,
      services.turnLeases.generation(dshSessionId, target),
    )
  }
  try {
    await refreshDocState(services, services.docStates, dshSessionId)
  } catch {
    services.docStates.markDirty(dshSessionId)
  }
}

async function propose(
  services: RuntimeToolServices,
  exec: ToolRunContext,
  engineSessionId: string,
  expectedDocVersion: number,
  qingml: string,
): Promise<ExternalProposalResponse> {
  return proposeOps(services, exec, engineSessionId, expectedDocVersion, [{ kind: 'qingmlDraft', qingml }])
}

const LINE_SHIFTING_BLOCK_OPS = new Set<ExternalEditProposalOp['kind']>([
  'deleteBlock',
  'deleteListItem',
  'insertAfterBlock',
])

interface EditOpResult {
  opIndex: number
  affectedCount: number
}

interface PreparedEditOps {
  ops: ExternalEditProposalOp[]
  opResults: EditOpResult[]
  affectedCount: number
}

interface ExpandedEditOps {
  ops: ExternalEditProposalOp[]
  origins: number[]
  structuralReplacements: Set<number>
}

async function prepareEditOps(
  services: RuntimeToolServices,
  exec: ToolRunContext,
  engineSessionId: string,
  ops: ExternalEditProposalOp[],
  suppliedPmDoc?: PmDoc,
): Promise<PreparedEditOps> {
  const needsPmDoc = ops.some((op) => op.kind === 'insertAfterLine' || op.kind === 'strReplace')
  if (!needsPmDoc) {
    return { ops, opResults: [], affectedCount: 0 }
  }
  const pmDoc = suppliedPmDoc ?? await readPmDoc(services, exec, engineSessionId)
  const sentenceSafeOps = ops.map((op) => expandFinalSentenceReplacement(pmDoc, op))
  const expanded = expandMarkdownBlockReplacements(pmDoc, sentenceSafeOps)
  const lineOps = expanded.ops.flatMap((op, index) => op.kind === 'insertAfterLine' ? [{ op, index }] : [])
  const strReplaceOps = expanded.ops.flatMap((op, index) => op.kind === 'strReplace' ? [{ op, index }] : [])

  for (const { index } of lineOps) {
    if (expanded.ops.slice(0, index).some((op) => LINE_SHIFTING_BLOCK_OPS.has(op.kind))) {
      throw new Error('这批修改先增删了内容，后面的旧行号会失效。请重新读取文稿后改用稳定的段落位置，或调整为先按行插入再增删。')
    }
  }

  const matchCounts = inspectStrReplaceTargets(pmDoc, strReplaceOps)
  const opResults = sentenceSafeOps.flatMap((op, originalIndex) => {
    if (op.kind !== 'strReplace') return []
    if (expanded.structuralReplacements.has(originalIndex)) {
      return [{ opIndex: originalIndex + 1, affectedCount: 1 }]
    }
    const expandedIndex = expanded.origins.findIndex((origin, index) =>
      origin === originalIndex && expanded.ops[index]?.kind === 'strReplace')
    const matches = matchCounts.get(expandedIndex) ?? 1
    return [{ opIndex: originalIndex + 1, affectedCount: op.all === true ? matches : 1 }]
  })
  const affectedCount = opResults.reduce((total, result) => total + result.affectedCount, 0)
  const expandAllReplacements = (preparedOps: ExternalEditProposalOp[]): ExternalEditProposalOp[] =>
    preparedOps.flatMap((op, index) => expandStrReplaceForEngine(op, matchCounts.get(index)))
  if (lineOps.length === 0) {
    return { ops: expandAllReplacements(expanded.ops), opResults, affectedCount }
  }

  const spans = pmToMarkdownWithLineMap(pmDoc).blocks
  for (const { op } of lineOps) {
    const span = spans.find((item) => op.line >= item.startLine && op.line <= item.endLine)
    if (!span) {
      throw new Error('所选位置不在当前文稿范围内。请重新读取文稿后再选择插入位置。')
    }
    if (span.contentEndLine > span.startLine && op.line < span.contentEndLine) {
      throw new Error('所选位置位于一段多行内容的中间，不能作为插入位置。请改在这段内容的末尾之后，或重新读取文稿后按整段定位。')
    }
  }

  const descending = [...lineOps].sort((left, right) =>
    right.op.line - left.op.line || right.index - left.index)
  let lineIndex = 0
  const reorderedOps = expanded.ops.map((op) => op.kind === 'insertAfterLine' ? descending[lineIndex++]!.op : op)
  return { ops: expandAllReplacements(reorderedOps), opResults, affectedCount }
}

function expandFinalSentenceReplacement(
  doc: PmDoc,
  op: ExternalEditProposalOp,
): ExternalEditProposalOp {
  if (
    op.kind !== 'strReplace' || op.all === true || op.nth !== undefined ||
    op.new.length <= op.old.length ||
    !/[。！？.!?]\s*$/u.test(op.old) || !/[。！？.!?]\s*$/u.test(op.new)
  ) return op
  const blocks = pmTextBlocks(doc)
  const matches = blocks.flatMap((text, index) => {
    const offset = text.indexOf(op.old)
    return offset >= 0 && offset + op.old.length === text.length ? [{ text, index, offset }] : []
  })
  if (matches.length !== 1 || matches[0]!.index !== blocks.length - 1 || matches[0]!.offset === 0) return op
  const match = matches[0]!
  const prefix = match.text.slice(0, match.offset)
  const previousBoundary = Math.max(
    prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？'),
    prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'),
  )
  const sentence = match.text.slice(previousBoundary + 1).trimStart()
  return sentence === op.old ? op : { ...op, old: sentence }
}

function expandMarkdownBlockReplacements(doc: PmDoc, ops: ExternalEditProposalOp[]): ExpandedEditOps {
  const serialized = pmToMarkdownWithLineMap(doc)
  const lines = serialized.markdown.split('\n')
  const spanById = new Map(serialized.blocks.map((span) => [span.blockId, span]))
  const topLevel = (doc.content as unknown as PmBlockNode[]).flatMap((node) => {
    const id = node.attrs?.blockId
    const span = id ? spanById.get(id) : undefined
    return id && span ? [{ id, type: node.type ?? '', span }] : []
  })
  const expanded: ExpandedEditOps = { ops: [], origins: [], structuralReplacements: new Set() }

  const append = (op: ExternalEditProposalOp, origin: number) => {
    expanded.ops.push(op)
    expanded.origins.push(origin)
  }
  ops.forEach((op, originalIndex) => {
    if (
      op.kind === 'strReplace'
      && op.all !== true
      && isPipeRowsOnly(op.old)
      && isPipeRowsOnly(op.new)
    ) {
      const oldLines = op.old.trim().split(/\r?\n/).map((line) => line.trim())
      const newLines = op.new.trim().split(/\r?\n/)
      const candidates = topLevel.flatMap((item) => {
        if (item.type !== 'table') return []
        const tableLines = lines.slice(item.span.startLine - 1, item.span.contentEndLine)
        const matches: Array<{ start: number }> = []
        for (let start = 0; start <= tableLines.length - oldLines.length; start += 1) {
          if (oldLines.every((line, offset) => tableLines[start + offset]?.trim() === line)) {
            matches.push({ start })
          }
        }
        return matches.map(({ start }) => ({ item, tableLines, start }))
      })
      const selected = op.nth !== undefined
        ? candidates[op.nth - 1]
        : candidates.length === 1 ? candidates[0] : undefined
      if (selected) {
        const replacement = [
          ...selected.tableLines.slice(0, selected.start),
          ...newLines,
          ...selected.tableLines.slice(selected.start + oldLines.length),
        ].join('\n')
        append({ kind: 'insertAfterBlock', blockId: selected.item.id, markdown: replacement }, originalIndex)
        append({ kind: 'deleteBlock', blockId: selected.item.id }, originalIndex)
        expanded.structuralReplacements.add(originalIndex)
        return
      }
    }
    if (op.kind !== 'strReplace' || !op.old.includes('\n') || op.all === true) {
      append(op, originalIndex)
      return
    }
    const candidates: Array<{ first: number; last: number }> = []
    for (let first = 0; first < topLevel.length; first += 1) {
      for (let last = first; last < topLevel.length; last += 1) {
        const startLine = topLevel[first]!.span.startLine
        const endLine = topLevel[last]!.span.contentEndLine
        const markdown = lines.slice(startLine - 1, endLine).join('\n').trim()
        if (markdown === op.old.trim()) candidates.push({ first, last })
      }
    }
    const selected = op.nth !== undefined ? candidates[op.nth - 1] : candidates.length === 1 ? candidates[0] : undefined
    if (!selected) {
      append(op, originalIndex)
      return
    }
    const covered = topLevel.slice(selected.first, selected.last + 1)
    const isStructural = covered.length > 1 || covered.some((item) =>
      item.type === 'table'
      || item.type === 'diagram'
      || item.type === 'orderedList'
      || item.type === 'bulletList'
      || item.type === 'taskList')
    if (!isStructural) {
      append(op, originalIndex)
      return
    }
    if (op.new.trim()) append({ kind: 'insertAfterBlock', blockId: covered.at(-1)!.id, markdown: op.new }, originalIndex)
    for (const item of covered) append({ kind: 'deleteBlock', blockId: item.id }, originalIndex)
    expanded.structuralReplacements.add(originalIndex)
  })
  return expanded
}

interface PmTextNodeLike {
  type?: string
  content?: PmTextNodeLike[]
  text?: string
}

interface PmTextBlockEntry {
  type?: string
  text: string
}

function pmTextBlockEntries(doc: PmDoc): PmTextBlockEntry[] {
  const blocks: PmTextBlockEntry[] = []
  const visit = (node: PmTextNodeLike): void => {
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock' || node.type === 'penNote') {
      blocks.push({
        type: node.type,
        text: (node.content ?? []).map((child) => {
          if (child.type === 'hardBreak') return '\n'
          if (child.type === 'inlineMath' || child.type === 'footnoteReference') return PM_INLINE_ATOM_PLACEHOLDER
          return child.type === 'text' && typeof child.text === 'string' ? child.text : ''
        }).join(''),
      })
    }
    for (const child of node.content ?? []) visit(child)
  }
  for (const node of doc.content as PmTextNodeLike[]) visit(node)
  return blocks
}

/** 与引擎 findLiteralMatches 同口径：文本节点跨 mark 拼接，hardBreak 投影为换行，块之间不串接。 */
function pmTextBlocks(doc: PmDoc): string[] {
  return pmTextBlockEntries(doc).map((block) => block.text)
}

function countLiteralMatches(blocks: readonly string[], find: string): number {
  if (!find) return 0
  let count = 0
  for (const block of blocks) {
    let index = block.indexOf(find)
    while (index >= 0) {
      count += 1
      index = block.indexOf(find, index + find.length)
    }
  }
  return count
}

function inspectStrReplaceTargets(
  doc: PmDoc,
  ops: Array<{ op: Extract<ExternalEditProposalOp, { kind: 'strReplace' }>; index: number }>,
): Map<number, number> {
  const matchCounts = new Map<number, number>()
  if (ops.length === 0) return matchCounts
  const blocks = pmTextBlocks(doc)
  for (const { op, index } of ops) {
    if (op.all === true && op.nth !== undefined) {
      throw new Error(`第 ${index + 1} 项不能同时选择全部替换和单处位置；请只保留一种范围。`)
    }
    let matches = countLiteralMatches(blocks, op.old)
    if (matches === 0) {
      const normalizedOld = normalizeStrReplaceText(op.old)
      if (normalizedOld !== op.old) matches = countLiteralMatches(blocks, normalizedOld)
    }
    if (matches === 0) {
      throw new Error(`第 ${index + 1} 个 strReplace 的 old 命中 0 处；请重新读取文稿，并改用当前正文中的精确文字。`)
    }
    if (matches >= 2 && op.nth === undefined && op.all !== true) {
      throw new Error(`第 ${index + 1} 个 strReplace 的 old 命中 ${matches} 处，未指定 nth；目标不唯一时先用原生 ask_user 让用户选。`)
    }
    matchCounts.set(index, matches)
  }
  return matchCounts
}

function expandStrReplaceForEngine(op: ExternalEditProposalOp, matches?: number): ExternalEditProposalOp[] {
  if (op.kind !== 'strReplace') return [op]
  const { all, ...engineOp } = op
  if (all !== true) return [all === undefined ? op : engineOp]

  // 当前引擎契约只支持 nth；从后往前处理可保持原文位置稳定，且整批仍只提交一次。
  return Array.from({ length: matches ?? 0 }, (_, index) => ({
    ...engineOp,
    nth: (matches ?? 0) - index,
  }))
}

function editCountLine(opResults: readonly EditOpResult[], affectedCount: number): string {
  if (opResults.length === 0) return ''
  const perOp = opResults
    .map((result) => `第 ${result.opIndex} 项修改 ${result.affectedCount} 处`)
    .join('，')
  return `\n${perOp}；本批共影响 ${affectedCount} 处。`
}

async function proposeEditOpsWithPlainTextRetry(
  services: RuntimeToolServices,
  exec: ToolRunContext,
  engineSessionId: string,
  expectedDocVersion: number,
  ops: ExternalEditProposalOp[],
): Promise<ExternalProposalResponse> {
  try {
    return await proposeOps(services, exec, engineSessionId, expectedDocVersion, ops)
  } catch (error) {
    if (!isStrReplaceNoMatch(error, ops)) throw error
    const normalizedOps = ops.map(normalizeEditOp)
    try {
      return await proposeOps(services, exec, engineSessionId, expectedDocVersion, normalizedOps)
    } catch (retryError) {
      if (isStrReplaceNoMatch(retryError, normalizedOps)) throw plainTextStrReplaceError(retryError)
      throw retryError
    }
  }
}

function normalizeEditOp(op: ExternalEditProposalOp): ExternalEditProposalOp {
  if (op.kind !== 'strReplace') return op
  return {
    ...op,
    old: normalizeStrReplaceText(op.old),
    new: normalizeStrReplaceText(op.new),
  }
}

function normalizeStrReplaceText(text: string): string {
  const withoutLinePrefixes = text.split('\n').map((line) => {
    const plain = line.replace(
      /^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+|>[ \t]+)/,
      '',
    )
    return unwrapMarkdownEmphasis(plain)
  }).join('\n')
  return unwrapMarkdownEmphasis(withoutLinePrefixes)
}

function unwrapMarkdownEmphasis(text: string): string {
  let normalized = text
  while (true) {
    const wrapped = /^(\*\*|__)([\s\S]+)\1$/.exec(normalized)
    if (!wrapped) return normalized
    normalized = wrapped[2]!
  }
}

function isStrReplaceNoMatch(error: unknown, ops: ExternalEditProposalOp[]): error is EngineHttpError {
  if (!(error instanceof EngineHttpError) || error.status !== 400 || !ops.some((op) => op.kind === 'strReplace')) return false
  const body = error.body as { error?: unknown } | null
  return typeof body?.error === 'string' && body.error.includes('未命中')
}

function plainTextStrReplaceError(error: EngineHttpError): EngineHttpError {
  return new EngineHttpError(error.status, error.body, `${error.message}；${STR_REPLACE_PLAIN_TEXT_ERROR}`)
}

async function proposeOps(
  services: RuntimeToolServices,
  exec: ToolRunContext,
  engineSessionId: string,
  expectedDocVersion: number,
  ops: ExternalEditProposalOp[] | Array<{ kind: 'qingmlDraft'; qingml: string }>,
): Promise<ExternalProposalResponse> {
  const dshSessionId = sessionIdOf(exec)
  const turnId = await services.turnLeases.touchDocument(dshSessionId, engineSessionId)
  // 引擎契约:结构操作批(deleteBlock/deleteListItem)必须携带请求级 opId(幂等寻址)。
  const structural = ops.some((op) => op.kind === 'deleteBlock' || op.kind === 'deleteListItem' || op.kind === 'insertAfterBlock')
  try {
    return await services.engine.fetchJson<ExternalProposalResponse>(`/sessions/${encodeURIComponent(engineSessionId)}/proposals`, {
      method: 'POST',
      body: JSON.stringify({
        expectedDocVersion,
        clientMutationId: `dsh-${randomUUID()}`,
        ...(structural ? { opId: `dsh-op-${randomUUID()}` } : {}),
        ...(turnId ? { turnId } : {}),
        ops,
      }),
    })
  } catch (error) {
    services.turnLeases.recordWriteFailure(dshSessionId, engineSessionId, error)
    throw error
  }
}

async function commitReview(
  services: RuntimeToolServices,
  exec: ToolRunContext,
  engineSessionId: string,
  body: ExternalReviewCommitRequest,
): Promise<ExternalReviewCommitResponse> {
  const dshSessionId = sessionIdOf(exec)
  const turnId = await services.turnLeases.touchDocument(dshSessionId, engineSessionId)
  try {
    return await services.engine.fetchJson<ExternalReviewCommitResponse>(
      `/sessions/${encodeURIComponent(engineSessionId)}/review/commit`,
      { method: 'POST', body: JSON.stringify({ ...body, ...(turnId ? { turnId } : {}) }) },
    )
  } catch (error) {
    services.turnLeases.recordWriteFailure(dshSessionId, engineSessionId, error)
    throw error
  }
}

async function readDoc(
  services: RuntimeToolServices,
  _exec: ToolRunContext,
  engineSessionId: string,
): Promise<ExternalDoc> {
  return readDocRaw(services.engine, engineSessionId)
}

function readDocRaw(engine: EngineService, engineSessionId: string): Promise<ExternalDoc> {
  return engine.fetchJson<ExternalDoc>(`/sessions/${encodeURIComponent(engineSessionId)}/doc?format=qingml`)
}

async function readDocWithLines(
  services: RuntimeToolServices,
  _exec: ToolRunContext,
  engineSessionId: string,
): Promise<ExternalDocReadResponse> {
  return services.engine.fetchJson<ExternalDocReadResponse>(`/sessions/${encodeURIComponent(engineSessionId)}/doc?lines=1`)
}

async function readPmDoc(
  services: RuntimeToolServices,
  _exec: ToolRunContext,
  engineSessionId: string,
): Promise<PmDoc> {
  return readPmDocRaw(services.engine, engineSessionId)
}

async function readPmDocRaw(engine: EngineService, engineSessionId: string): Promise<PmDoc> {
  const response = await engine.fetchJson<ExternalPmDocReadResponse>(
    `/sessions/${encodeURIComponent(engineSessionId)}/doc?format=pm`,
  )
  if (!response.pmDoc) throw new Error('青简文稿暂时无法读取，请稍后重试。')
  return response.pmDoc
}

async function readReviewCandidate(
  services: RuntimeToolServices,
  _exec: ToolRunContext,
  engineSessionId: string,
): Promise<{ qingml: string; pmDoc: PmDoc; renderModel: ExternalReviewRenderModelResponse }> {
  return readReviewCandidateRaw(services.engine, engineSessionId)
}

async function readReviewCandidateRaw(
  engine: EngineService,
  engineSessionId: string,
): Promise<{ qingml: string; pmDoc: PmDoc; renderModel: ExternalReviewRenderModelResponse }> {
  const renderModel = await engine.fetchJson<ExternalReviewRenderModelResponse>(
    `/sessions/${encodeURIComponent(engineSessionId)}/review?format=render-model`,
  )
  const candidate = renderModel.editedDoc ?? renderModel.previewDoc
  if (!candidate) throw new Error('青简待审候选缺少可读取的完整文档。请在右侧面板裁决当前变更。')
  return { qingml: serializePmQingml(candidate), pmDoc: candidate, renderModel }
}

function serializePmQingml(doc: PmDoc): string {
  return aiBlocksToQingml(pmToAiIr(doc).blocks)
}

function lineNumbered(markdown: string): string {
  return markdown.split('\n').map((line, index) => `${String(index + 1).padStart(4)} | ${line}`).join('\n')
}

function repeatedReadNotice(mode: 'outline' | 'full' | 'base' | 'lines' | 'blocks'): string {
  const label = mode === 'outline'
    ? '提纲'
    : mode === 'full'
      ? '完整文稿'
      : mode === 'base'
        ? '已提交文稿'
        : mode === 'lines'
          ? '行号内容'
          : '内容定位清单'
  return `本回合已读取过相同版本的${label}；请沿用上一次结果，不要重复读取。`
}

function sessionIdOf(exec: ToolRunContext): string {
  if (!exec.agent) throw new Error('此工具必须在 DSH 会话中调用。')
  return String(exec.agent.id)
}

function resolveDocRef(services: RuntimeToolServices, dshSessionId: string, docRef?: string): string {
  const { bindings } = services
  if (docRef) {
    if (!bindings.hasDoc(dshSessionId, docRef)) throw new Error('docRef 不属于当前 DSH 会话。')
    return docRef
  }
  const pinned = services.turnLeases.pinnedDocument(dshSessionId)
  if (pinned && bindings.hasDoc(dshSessionId, pinned)) return pinned
  const active = bindings.getActive(dshSessionId)
  if (!active) throw new Error('当前会话没有激活文稿。请先写一篇，或用 qing_list_docs / qing_focus_doc 选择。')
  return active.engineSessionId
}

async function assertEngineOnline(
  engine: EngineService,
): Promise<Awaited<ReturnType<EngineService['ensureReady']>> & { state: 'online' }> {
  const status = await engine.ensureReady()
  if (status.state !== 'online') {
    throw new EngineUnavailableError(status)
  }
  return status as typeof status & { state: 'online' }
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function engineErrorDetail(body: unknown): { code: string; error: string } {
  if (!body || typeof body !== 'object') return { code: '', error: '' }
  const value = body as { code?: unknown; error?: unknown }
  return {
    code: typeof value.code === 'string' ? value.code.trim() : '',
    error: typeof value.error === 'string' ? value.error.trim() : '',
  }
}

function sanitizeToolBoundaryError(error: unknown): unknown {
  if (!(error instanceof EngineHttpError)) return error
  const detail = engineErrorDetail(error.body)
  const raw = `${detail.error}\n${error.message}`
  if (error.message.includes(STR_REPLACE_PLAIN_TEXT_ERROR)) return new Error(STR_REPLACE_PLAIN_TEXT_ERROR)
  if (/位于多行|insertAfter(?:Line|Block)|paragraph\s*块/i.test(raw)) {
    return new Error('所选位置位于一段多行内容的中间，不能作为插入位置。请改在这段内容的末尾之后，或重新读取文稿后按整段定位。')
  }
  if (/未命中|未唯一命中/u.test(raw)) {
    return new Error('没有找到唯一的目标文字。请重新读取文稿，缩小目标范围后再试。')
  }
  if (detail.code === 'REVIEW_PENDING') return new Error(REVIEW_PENDING_ERROR)
  if (detail.code === 'AGENT_BUSY') return new Error('青简正在处理其他任务，请稍后重试。')
  if (detail.code === 'VERSION_CONFLICT') return new Error('文稿内容已经变化，请重新读取后基于最新内容修改。')
  if (detail.code === 'RATE_LIMITED' || error.status === 429) return new Error('请求过于频繁，请稍后重试。')
  if (detail.code === 'SESSION_NOT_FOUND' || detail.code === 'NOT_FOUND' || error.status === 404) {
    return new Error('没有找到目标文稿，请重新查看文稿列表后再试。')
  }
  if (error.status === 409) return new Error('文稿当前状态不允许这次操作，请重新读取文稿状态后再试。')
  if (error.status === 400) return new Error('这次修改没有生效。请重新读取文稿，换用清晰、稳定的内容位置后再试。')
  return new Error('青简暂时无法完成这次操作，请稍后重试。')
}

function sanitizeFailureSummary(text: string): string {
  if (/paragraph|insertAfter(?:Line|Block)?|blockId|HTTP\s*\d{3}|\b[45]\d{2}\b|第\s*\d+\s*行|块\s+[A-Za-z0-9_-]+/i.test(text)) {
    return '修改位置需要重新确认，请重新读取文稿后再试'
  }
  return sanitizeUserVisibleText(text)
}

function sanitizeEditFailureContent(content: readonly unknown[]) {
  const raw = content.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const value = block as { type?: unknown; text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n')
  return sanitizeFailureSummary(raw) === raw
    ? undefined
    : textBlock('Error: 修改位置需要重新确认，请重新读取文稿后再试。')
}

function failedResultPresentation(title: string, content: readonly unknown[]) {
  const summary = failureSummary(content)
  return {
    card: 'generic' as const,
    title,
    ...(summary ? { content: textBlock(`未完成 · ${summary}`) } : {}),
  }
}

function failureSummary(content: readonly unknown[]): string {
  const rawText = content.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const value = block as { type?: unknown; text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n').split(/\r?\n/, 1)[0]?.replace(/^Error:\s*/i, '').trim() ?? ''
  const text = sanitizeFailureSummary(rawText)
  if (/审阅|REVIEW_PENDING/i.test(text)) return '文稿审阅中'
  if (/AGENT_BUSY|正在处理其他任务|引擎忙/i.test(text)) return '引擎忙'
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

class ReviewTurnTracker {
  private readonly turns = new Map<string, number>()
  private readonly adjudicated = new Map<string, string>()

  begin(agentId: string, turn: number): void {
    if (this.turns.get(agentId) === turn) return
    this.turns.set(agentId, turn)
    this.adjudicated.delete(agentId)
  }

  dispose(agentId: string): void {
    this.turns.delete(agentId)
    this.adjudicated.delete(agentId)
  }

  assertFirstAdjudication(exec: ToolRunContext): void {
    const agentId = sessionIdOf(exec)
    const turn = this.turns.get(agentId)
    const key = turn === undefined ? `root:${String(exec.rootCallId)}` : `turn:${turn}`
    if (this.adjudicated.get(agentId) === key) throw new Error(REVIEW_REPEAT_ERROR)
    this.adjudicated.set(agentId, key)
  }
}

class WriteTurnTracker {
  private readonly turns = new Map<string, number>()
  private readonly successful = new Map<string, {
    key: string
    engineSessionId: string
    retryAllowed: boolean
    successfulAttempts: number
    retryClaims: number
    requirements: DraftRequirements
    lengthResults: Array<{ actual: number; report: DraftLengthReport } | undefined>
  }>()

  begin(agentId: string, turn: number): void {
    if (this.turns.get(agentId) === turn) return
    this.turns.set(agentId, turn)
    this.successful.delete(agentId)
  }

  dispose(agentId: string): void {
    this.turns.delete(agentId)
    this.successful.delete(agentId)
  }

  assertWriteAllowed(exec: ToolRunContext, docRef?: string): DraftRequirements | undefined {
    const agentId = sessionIdOf(exec)
    const key = this.key(agentId, exec)
    const state = this.successful.get(agentId)
    if (!state || state.key !== key) return undefined
    const firstRetry = state.successfulAttempts === 1 && state.retryClaims === 0
    const finalLengthRetry = state.successfulAttempts === 2
      && state.retryClaims === 1
      && this.canUseFinalLengthRetry(state)
    if (state.retryAllowed && docRef === state.engineSessionId && (firstRetry || finalLengthRetry)) {
      state.retryClaims += 1
      return state.requirements
    }
    throw new Error(WRITE_REPEAT_ERROR)
  }

  markSuccessful(
    exec: ToolRunContext,
    engineSessionId: string,
    requirements: DraftRequirements,
    retryAllowed: boolean,
  ): void {
    const agentId = sessionIdOf(exec)
    const key = this.key(agentId, exec)
    const previous = this.successful.get(agentId)
    this.successful.set(agentId, {
      key,
      engineSessionId,
      retryAllowed,
      successfulAttempts: previous?.key === key ? previous.successfulAttempts + 1 : 1,
      retryClaims: previous?.key === key ? previous.retryClaims : 0,
      requirements: previous?.key === key ? previous.requirements : requirements,
      lengthResults: previous?.key === key ? previous.lengthResults : [],
    })
  }

  recordLengthResult(
    exec: ToolRunContext,
    engineSessionId: string,
    actual: number,
    report: DraftLengthReport | undefined,
  ): void {
    if (!report) return
    const agentId = sessionIdOf(exec)
    const state = this.successful.get(agentId)
    if (!state || state.key !== this.key(agentId, exec) || state.engineSessionId !== engineSessionId) return
    state.lengthResults[state.successfulAttempts - 1] = { actual, report }
  }

  private canUseFinalLengthRetry(state: {
    lengthResults: Array<{ actual: number; report: DraftLengthReport } | undefined>
  }): boolean {
    const first = state.lengthResults[0]
    const second = state.lengthResults[1]
    if (!first || !second) return false
    const firstGap = Math.abs(first.report.gap)
    const secondGap = Math.abs(second.report.gap)
    return first.report.status !== 'met'
      && second.report.status !== 'met'
      && lengthDeviationRatio(first.actual, first.report) > 0.15
      && lengthDeviationRatio(second.actual, second.report) > 0.15
      && secondGap < firstGap
  }

  private key(agentId: string, exec: ToolRunContext): string {
    const turn = this.turns.get(agentId)
    return turn === undefined ? `root:${String(exec.rootCallId)}` : `turn:${turn}`
  }
}

function lengthDeviationRatio(actual: number, report: DraftLengthReport): number {
  const reference = Math.abs(actual - report.gap)
  return Math.abs(report.gap) / Math.max(1, reference)
}

interface TurnDocSnapshot {
  doc: Awaited<ReturnType<typeof readDoc>>
  basePmDoc: Awaited<ReturnType<typeof readPmDoc>>
  reviewCandidate: Awaited<ReturnType<typeof readReviewCandidate>> | null
}

class ReadTurnTracker {
  private readonly turns = new Map<string, number>()
  private readonly reads = new Map<string, Set<string>>()
  private readonly snapshots = new Map<string, Map<string, TurnDocSnapshot>>()

  begin(agentId: string, turn: number): void {
    if (this.turns.get(agentId) === turn) return
    this.turns.set(agentId, turn)
    this.reads.delete(agentId)
    this.snapshots.delete(agentId)
  }

  has(
    exec: ToolRunContext,
    engineSessionId: string,
    mode: string,
    docVersion: number,
  ): boolean {
    const agentId = sessionIdOf(exec)
    // 独立工具调用没有 agent/pre-step，不能假定不同 rootCallId 属于同一回合。
    if (!this.turns.has(agentId)) return false
    return this.reads.get(agentId)?.has(this.key(engineSessionId, mode, docVersion)) ?? false
  }

  remember(
    exec: ToolRunContext,
    engineSessionId: string,
    mode: string,
    docVersion: number,
  ): void {
    const agentId = sessionIdOf(exec)
    if (!this.turns.has(agentId)) return
    const reads = this.reads.get(agentId) ?? new Set<string>()
    reads.add(this.key(engineSessionId, mode, docVersion))
    this.reads.set(agentId, reads)
  }

  /**
   * 本回合的文稿快照。纯读不申领编辑租约，但同回合的其它 mode 仍复用这份快照。
   * committed 写后由新版权威快照覆盖；review 写后才 invalidate，下次读取重拿候选。
   */
  snapshot(agentId: string, engineSessionId: string): TurnDocSnapshot | undefined {
    if (!this.turns.has(agentId)) return undefined
    return this.snapshots.get(agentId)?.get(engineSessionId)
  }

  rememberSnapshot(agentId: string, engineSessionId: string, snapshot: TurnDocSnapshot): void {
    if (!this.turns.has(agentId)) return
    const snapshots = this.snapshots.get(agentId) ?? new Map<string, TurnDocSnapshot>()
    snapshots.set(engineSessionId, snapshot)
    this.snapshots.set(agentId, snapshots)
  }

  invalidateSnapshot(agentId: string, engineSessionId: string): void {
    const snapshots = this.snapshots.get(agentId)
    snapshots?.delete(engineSessionId)
    if (snapshots?.size === 0) this.snapshots.delete(agentId)
  }

  clearMarks(agentId: string, engineSessionId: string): void {
    const prefix = `${engineSessionId}\u0000`
    const reads = this.reads.get(agentId)
    if (!reads) return
    for (const key of reads) {
      if (key.startsWith(prefix)) reads.delete(key)
    }
    if (reads.size === 0) this.reads.delete(agentId)
  }

  resetSegment(agentId: string, engineSessionId: string): void {
    this.invalidateSnapshot(agentId, engineSessionId)
    this.clearMarks(agentId, engineSessionId)
  }

  dispose(agentId: string): void {
    this.turns.delete(agentId)
    this.reads.delete(agentId)
    this.snapshots.delete(agentId)
  }

  private key(engineSessionId: string, mode: string, docVersion: number): string {
    return `${engineSessionId}\u0000${mode}\u0000${docVersion}`
  }
}

function installTurnTracking(
  ctx: Context,
  reviewTurns: ReviewTurnTracker,
  writeTurns: WriteTurnTracker,
  readTurns: ReadTurnTracker,
  services: RuntimeToolServices,
): void {
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const dshSessionId = String(payload.agent.id)
    reviewTurns.begin(dshSessionId, payload.turn)
    writeTurns.begin(dshSessionId, payload.turn)
    readTurns.begin(dshSessionId, payload.turn)
    services.freshness.begin(dshSessionId, payload.turn)
    // 回合起点钉住当时聚焦稿；面板在回合中途切换只影响下一回合。
    const pinned = services.bindings.getActive(dshSessionId)?.engineSessionId
    await services.turnLeases.openTurn(dshSessionId, payload.turn, pinned)
    if (pinned && services.docStates.needsRefresh(dshSessionId)) {
      try {
        await refreshDocState(services, services.docStates, dshSessionId)
      } catch {
        services.docStates.markDirty(dshSessionId)
      }
    }
    return next()
  }))
  ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    await services.turnLeases.endTurn(String(agent.id), turn)
  }))
  ctx.effect(() => ctx.on('agent/error', async ({ agent, turn }) => {
    // step 级 error 不等于回合结束；保持租约与心跳，等 stopping/dispose 收口。
    services.turnLeases.markAgentError(String(agent.id), turn)
  }))
  ctx.effect(() => ctx.on('agent/disposed', async ({ agent }) => {
    const dshSessionId = String(agent.id)
    await services.turnLeases.disposeAgent(dshSessionId)
    reviewTurns.dispose(dshSessionId)
    writeTurns.dispose(dshSessionId)
    readTurns.dispose(dshSessionId)
    services.freshness.dispose(dshSessionId)
    services.docStates.dispose(dshSessionId)
  }))
}
