import { aiBlocksToQingml, qingmlParse, type AiBlock, type AiRun, type AiTextRun } from '@qingagent/pm-schema'

export type QingmlSourceSyntaxLeak = 'footnote-reference' | 'footnote-definition' | 'inline-math' | 'block-math'

export interface QingmlSourceSyntaxConversion {
  qingml: string
  convertedFootnotes: number
  convertedFormulas: number
  converted: number
  leaks: QingmlSourceSyntaxLeak[]
}

export interface QingmlStructureFacts {
  footnotes: number
  formulas: number
}

const FOOTNOTE_ID_SOURCE = '[A-Za-z0-9_-]{1,64}'
const FOOTNOTE_NOTE_MAX_LENGTH = 4096
const LATEX_INLINE_FEATURE_PATTERN = /[\\^_=]/u

function footnoteReferencePattern(global = false): RegExp {
  return new RegExp(`\\[\\^(${FOOTNOTE_ID_SOURCE})\\](?![ \\t]*:)`, global ? 'gu' : 'u')
}

function footnoteDefinitionPattern(global = false): RegExp {
  return new RegExp(`(^|(?<=\\n))[ \\t]{0,3}\\[\\^(${FOOTNOTE_ID_SOURCE})\\][ \\t]*:[ \\t]*([^\\n]*)(?:\\n|$)`, global ? 'gu' : 'u')
}

function inlineMathPattern(global = false): RegExp {
  return new RegExp(String.raw`(?<!\\)\$(?!\$)(?=[^$\n]*[\\^_=])([^$\n]+?)(?<!\\)\$(?!\$)`, global ? 'gu' : 'u')
}

const ANY_BLOCK_MATH_SOURCE_PATTERN = /\$\$[\s\S]+?\$\$/u

function isMathRun(run: AiRun): boolean {
  return 'text' in run && Boolean(run.marks?.some((mark) => mark.type === 'math'))
}

function collectRunSourceSyntaxLeaks(runs: readonly AiRun[], leaks: Set<QingmlSourceSyntaxLeak>): void {
  for (const run of runs) {
    if (!('text' in run) || isMathRun(run)) continue
    if (footnoteReferencePattern().test(run.text)) leaks.add('footnote-reference')
    if (footnoteDefinitionPattern().test(run.text)) leaks.add('footnote-definition')
    if (ANY_BLOCK_MATH_SOURCE_PATTERN.test(run.text)) leaks.add('block-math')
    for (const match of run.text.matchAll(inlineMathPattern(true))) {
      if (LATEX_INLINE_FEATURE_PATTERN.test(match[1] ?? '')) leaks.add('inline-math')
    }
  }
}

function collectBlockSourceSyntaxLeaks(block: AiBlock, leaks: Set<QingmlSourceSyntaxLeak>): void {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'penNote':
      collectRunSourceSyntaxLeaks(block.runs, leaks)
      return
    case 'blockquote':
    case 'callout':
      if (block.runs) collectRunSourceSyntaxLeaks(block.runs, leaks)
      else block.blocks?.forEach((child) => collectBlockSourceSyntaxLeaks(child, leaks))
      return
    case 'bulletList':
    case 'orderedList':
      for (const item of block.items) {
        collectRunSourceSyntaxLeaks(item.runs, leaks)
        item.children?.forEach((child) => collectBlockSourceSyntaxLeaks(child, leaks))
      }
      return
    case 'taskList':
      for (const item of block.items) {
        collectRunSourceSyntaxLeaks(item.runs, leaks)
        item.children?.forEach((child) => collectBlockSourceSyntaxLeaks(child, leaks))
      }
      return
    case 'table':
      block.rows.forEach((row) => row.cells.forEach((cell) =>
        cell.blocks.forEach((child) => collectBlockSourceSyntaxLeaks(child, leaks))))
      return
    case 'columnList':
      block.columns.forEach((column) =>
        column.blocks.forEach((child) => collectBlockSourceSyntaxLeaks(child, leaks)))
      return
    default:
      // codeBlock、inlineMath/blockMath 和图表源码不是正文文本节点，不参与泄漏检测。
      return
  }
}

/**
 * 在落库前检查解析后的正文文本节点，避免把 GFM 脚注源语法当普通文字写进纸面。
 * 基于 AI-IR 而非原始字符串检查，可自然排除代码块和原生脚注/公式节点。
 */
export function findQingmlSourceSyntaxLeaks(qingml: string): QingmlSourceSyntaxLeak[] {
  const leaks = new Set<QingmlSourceSyntaxLeak>()
  for (const block of qingmlParse(qingml).blocks) collectBlockSourceSyntaxLeaks(block, leaks)
  return [...leaks]
}

interface FootnoteDefinitionCandidate {
  note: string
}

interface RunTextSegment {
  runIndex: number
  start: number
  end: number
}

function projectRunText(runs: readonly AiRun[]): { text: string; segments: RunTextSegment[] } {
  let text = ''
  const segments: RunTextSegment[] = []
  runs.forEach((run, runIndex) => {
    if (!('text' in run) || isMathRun(run)) {
      text += '\uFFFC'
      return
    }
    const start = text.length
    text += run.text
    segments.push({ runIndex, start, end: text.length })
  })
  return { text, segments }
}

function forEachRunCollection(block: AiBlock, visit: (runs: readonly AiRun[]) => void): void {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'penNote':
      visit(block.runs)
      return
    case 'blockquote':
    case 'callout':
      if (block.runs) visit(block.runs)
      else block.blocks?.forEach((child) => forEachRunCollection(child, visit))
      return
    case 'bulletList':
    case 'orderedList':
      for (const item of block.items) {
        visit(item.runs)
        item.children?.forEach((child) => forEachRunCollection(child, visit))
      }
      return
    case 'taskList':
      for (const item of block.items) {
        visit(item.runs)
        item.children?.forEach((child) => forEachRunCollection(child, visit))
      }
      return
    case 'table':
      block.rows.forEach((row) => row.cells.forEach((cell) =>
        cell.blocks.forEach((child) => forEachRunCollection(child, visit))))
      return
    case 'columnList':
      block.columns.forEach((column) =>
        column.blocks.forEach((child) => forEachRunCollection(child, visit)))
      return
    default:
      return
  }
}

function sourceFootnoteDefinitions(blocks: readonly AiBlock[]): Map<string, string> {
  const candidates = new Map<string, FootnoteDefinitionCandidate[]>()
  const references = new Set<string>()
  for (const block of blocks) {
    forEachRunCollection(block, (runs) => {
      const projected = projectRunText(runs)
      for (const match of projected.text.matchAll(footnoteDefinitionPattern(true))) {
        const id = match[2]
        if (!id) continue
        const values = candidates.get(id) ?? []
        values.push({ note: (match[3] ?? '').trim() })
        candidates.set(id, values)
      }
      for (const run of runs) {
        if (!('text' in run) || isMathRun(run)) continue
        const withoutDefinitions = run.text.replace(footnoteDefinitionPattern(true), '')
        for (const match of withoutDefinitions.matchAll(footnoteReferencePattern(true))) {
          if (match[1]) references.add(match[1])
        }
      }
    })
  }

  const definitions = new Map<string, string>()
  for (const [id, values] of candidates) {
    const note = values[0]?.note ?? ''
    if (
      references.has(id)
      && note.length > 0
      && note.length <= FOOTNOTE_NOTE_MAX_LENGTH
      && !note.includes('\uFFFC')
      && values.every((value) => value.note === note)
    ) {
      definitions.set(id, note)
    }
  }
  return definitions
}

function stripConvertedFootnoteDefinitions(runs: readonly AiRun[], definitions: ReadonlyMap<string, string>): AiRun[] {
  const projected = projectRunText(runs)
  const removals: Array<{ start: number; end: number }> = []
  for (const match of projected.text.matchAll(footnoteDefinitionPattern(true))) {
    const id = match[2]
    const note = (match[3] ?? '').trim()
    if (id && definitions.get(id) === note) {
      removals.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  if (removals.length === 0) return [...runs]

  const segments = new Map(projected.segments.map((segment) => [segment.runIndex, segment]))
  return runs.flatMap((run, runIndex): AiRun[] => {
    if (!('text' in run) || isMathRun(run)) return [run]
    const segment = segments.get(runIndex)
    if (!segment) return [run]
    let text = run.text
    for (const removal of removals.toReversed()) {
      const start = Math.max(removal.start, segment.start)
      const end = Math.min(removal.end, segment.end)
      if (start < end) {
        text = `${text.slice(0, start - segment.start)}${text.slice(end - segment.start)}`
      }
    }
    return text ? [{ ...run, text }] : []
  })
}

function pushTextRun(target: AiRun[], text: string, source: AiTextRun): void {
  if (!text) return
  target.push(source.marks?.length ? { text, marks: source.marks } : { text })
}

function convertInlineSourceSyntax(
  runs: readonly AiRun[],
  definitions: ReadonlyMap<string, string>,
  counts: { footnotes: number; formulas: number },
): AiRun[] {
  const converted: AiRun[] = []
  const tokenPattern = new RegExp(
    `\\[\\^(${FOOTNOTE_ID_SOURCE})\\](?![ \\t]*:)|(?<!\\\\)\\$(?!\\$)(?=[^$\\n]*[\\\\^_=])([^$\\n]+?)(?<!\\\\)\\$(?!\\$)`,
    'gu',
  )
  for (const run of runs) {
    if (!('text' in run) || isMathRun(run)) {
      converted.push(run)
      continue
    }
    let cursor = 0
    for (const match of run.text.matchAll(tokenPattern)) {
      const index = match.index
      pushTextRun(converted, run.text.slice(cursor, index), run)
      const id = match[1]
      const latex = match[2]
      if (id && definitions.has(id)) {
        converted.push({ type: 'footnote', id, note: definitions.get(id)! })
        counts.footnotes += 1
      } else if (latex !== undefined && LATEX_INLINE_FEATURE_PATTERN.test(latex)) {
        converted.push({ text: latex.trim(), marks: [{ type: 'math' }] })
        counts.formulas += 1
      } else {
        pushTextRun(converted, match[0], run)
      }
      cursor = index + match[0].length
    }
    pushTextRun(converted, run.text.slice(cursor), run)
  }
  return converted
}

function runsHaveContent(runs: readonly AiRun[]): boolean {
  return runs.some((run) => 'text' in run ? run.text.length > 0 : true)
}

type ParagraphSourcePart = { runs: AiRun[] } | { latex: string }

function splitParagraphBlockMath(runs: readonly AiRun[]): ParagraphSourcePart[] {
  const parts: ParagraphSourcePart[] = []
  let current: AiRun[] = []
  const flushRuns = (): void => {
    if (runsHaveContent(current)) parts.push({ runs: current })
    current = []
  }

  for (const run of runs) {
    if (!('text' in run) || isMathRun(run)) {
      current.push(run)
      continue
    }
    const pattern = /\$\$([\s\S]+?)\$\$/gu
    let cursor = 0
    for (const match of run.text.matchAll(pattern)) {
      const latex = (match[1] ?? '').trim()
      if (!latex) continue
      pushTextRun(current, run.text.slice(cursor, match.index), run)
      flushRuns()
      parts.push({ latex })
      cursor = match.index + match[0].length
    }
    pushTextRun(current, run.text.slice(cursor), run)
  }
  flushRuns()
  return parts
}

function convertSourceSyntaxBlocks(
  blocks: readonly AiBlock[],
  definitions: ReadonlyMap<string, string>,
  counts: { footnotes: number; formulas: number },
): AiBlock[] {
  return blocks.flatMap((block): AiBlock[] => {
    switch (block.type) {
      case 'paragraph': {
        const stripped = stripConvertedFootnoteDefinitions(block.runs, definitions)
        const parts = splitParagraphBlockMath(stripped)
        let keepBlockId = true
        return parts.flatMap((part): AiBlock[] => {
          const identity = keepBlockId && block.blockId ? { blockId: block.blockId } : {}
          if ('latex' in part) {
            counts.formulas += 1
            keepBlockId = false
            return [{ type: 'blockMath', latex: part.latex, ...identity }]
          }
          const runs = convertInlineSourceSyntax(part.runs, definitions, counts)
          if (!runsHaveContent(runs)) return []
          keepBlockId = false
          return [{
            type: 'paragraph',
            runs,
            ...identity,
            ...(block.textAlign ? { textAlign: block.textAlign } : {}),
          }]
        })
      }
      case 'heading':
      case 'penNote': {
        const stripped = stripConvertedFootnoteDefinitions(block.runs, definitions)
        const runs = convertInlineSourceSyntax(stripped, definitions, counts)
        return runsHaveContent(runs) ? [{ ...block, runs }] : []
      }
      case 'blockquote':
      case 'callout': {
        if (block.runs) {
          const stripped = stripConvertedFootnoteDefinitions(block.runs, definitions)
          const runs = convertInlineSourceSyntax(stripped, definitions, counts)
          return runsHaveContent(runs) ? [{ ...block, runs }] : []
        }
        const nested = convertSourceSyntaxBlocks(block.blocks ?? [], definitions, counts)
        return nested.length > 0 ? [{ ...block, blocks: nested }] : []
      }
      case 'bulletList':
      case 'orderedList': {
        const items = block.items.flatMap((item) => {
          const stripped = stripConvertedFootnoteDefinitions(item.runs, definitions)
          const runs = convertInlineSourceSyntax(stripped, definitions, counts)
          const children = item.children ? convertSourceSyntaxBlocks(item.children, definitions, counts) : []
          return runsHaveContent(runs) || children.length > 0
            ? [{ ...item, runs, ...(children.length > 0 ? { children } : { children: undefined }) }]
            : []
        })
        return items.length > 0 ? [{ ...block, items }] : []
      }
      case 'taskList': {
        const items = block.items.flatMap((item) => {
          const stripped = stripConvertedFootnoteDefinitions(item.runs, definitions)
          const runs = convertInlineSourceSyntax(stripped, definitions, counts)
          const children = item.children ? convertSourceSyntaxBlocks(item.children, definitions, counts) : []
          return runsHaveContent(runs) || children.length > 0
            ? [{ ...item, runs, ...(children.length > 0 ? { children } : { children: undefined }) }]
            : []
        })
        return items.length > 0 ? [{ ...block, items }] : []
      }
      case 'table':
        return [{
          ...block,
          rows: block.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => {
              const nested = convertSourceSyntaxBlocks(cell.blocks, definitions, counts)
              return { ...cell, blocks: nested.length > 0 ? nested : [{ type: 'paragraph', runs: [] }] }
            }),
          })),
        }]
      case 'columnList':
        return [{
          ...block,
          columns: block.columns.map((column) => {
            const nested = convertSourceSyntaxBlocks(column.blocks, definitions, counts)
            return { ...column, blocks: nested.length > 0 ? nested : [{ type: 'paragraph', runs: [] }] }
          }),
        }]
      default:
        return [block]
    }
  })
}

function escapeQingmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 把正文文本节点中的脚注/公式源写法确定性转换成 AI-IR 原生结构。
 * 只有配对且可无损处理的脚注、明确的块公式和带 LaTeX 特征的行内公式会转换。
 */
export function convertQingmlSourceSyntax(qingml: string): QingmlSourceSyntaxConversion {
  const parsed = qingmlParse(qingml)
  const definitions = sourceFootnoteDefinitions(parsed.blocks)
  const counts = { footnotes: 0, formulas: 0 }
  const blocks = convertSourceSyntaxBlocks(parsed.blocks, definitions, counts)
  const converted = counts.footnotes + counts.formulas
  const normalized = converted > 0
    ? `${parsed.title ? `<title>${escapeQingmlText(parsed.title)}</title>` : ''}${aiBlocksToQingml(blocks)}`
    : qingml
  return {
    qingml: normalized,
    convertedFootnotes: counts.footnotes,
    convertedFormulas: counts.formulas,
    converted,
    leaks: findQingmlSourceSyntaxLeaks(normalized),
  }
}

function structureFactsFromBlocks(blocks: readonly AiBlock[]): QingmlStructureFacts {
  const facts: QingmlStructureFacts = { footnotes: 0, formulas: 0 }
  const countRuns = (runs: readonly AiRun[]): void => {
    for (const run of runs) {
      if (!('text' in run)) facts.footnotes += 1
      else if (isMathRun(run)) facts.formulas += 1
    }
  }
  const countBlocks = (nested: readonly AiBlock[]): void => {
    for (const block of nested) {
      switch (block.type) {
        case 'paragraph':
        case 'heading':
        case 'penNote':
          countRuns(block.runs)
          break
        case 'blockquote':
        case 'callout':
          if (block.runs) countRuns(block.runs)
          else countBlocks(block.blocks ?? [])
          break
        case 'bulletList':
        case 'orderedList':
        case 'taskList':
          for (const item of block.items) {
            countRuns(item.runs)
            countBlocks(item.children ?? [])
          }
          break
        case 'table':
          block.rows.forEach((row) => row.cells.forEach((cell) => countBlocks(cell.blocks)))
          break
        case 'columnList':
          block.columns.forEach((column) => countBlocks(column.blocks))
          break
        case 'blockMath':
          facts.formulas += 1
          break
        default:
          break
      }
    }
  }
  countBlocks(blocks)
  return facts
}

export function structureFactsOf(qingml: string): QingmlStructureFacts {
  return structureFactsFromBlocks(qingmlParse(qingml).blocks)
}

export interface CompleteBlocks {
  blocks: string[]
  completeLength: number
}

const VOID_TAGS = new Set(['hr', 'br', 'img', 'file', 'footnote'])

/**
 * 找出当前流中已经闭合的顶层块。解析只负责流式边界，不替代引擎的权威 QingML 校验。
 */
export function completeTopLevelBlocks(input: string): CompleteBlocks {
  const blocks: string[] = []
  const stack: string[] = []
  let blockStart = -1
  let cursor = 0
  let completeLength = 0
  while (cursor < input.length) {
    const opening = input.indexOf('<', cursor)
    if (opening < 0) break
    const closing = input.indexOf('>', opening + 1)
    if (closing < 0) break
    const raw = input.slice(opening + 1, closing).trim()
    cursor = closing + 1
    if (!raw || raw.startsWith('!') || raw.startsWith('?')) continue
    const isClosing = raw.startsWith('/')
    const name = raw.replace(/^\//, '').match(/^[A-Za-z][\w-]*/)?.[0]?.toLowerCase()
    if (!name) continue
    if (!isClosing) {
      if (stack.length === 0) blockStart = opening
      const selfClosing = raw.endsWith('/') || VOID_TAGS.has(name)
      if (!selfClosing) stack.push(name)
      if (selfClosing && stack.length === 0 && blockStart >= 0) {
        blocks.push(input.slice(blockStart, cursor))
        completeLength = cursor
        blockStart = -1
      }
      continue
    }
    const index = stack.lastIndexOf(name)
    if (index < 0) continue
    stack.length = index
    if (stack.length === 0 && blockStart >= 0) {
      blocks.push(input.slice(blockStart, cursor))
      completeLength = cursor
      blockStart = -1
    }
  }
  return { blocks, completeLength }
}

export function stripQingml(text: string): string {
  return text
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractTitle(qingml: string, fallback = '未命名文稿'): string {
  const match = qingml.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)
  return match ? stripQingml(match[1] ?? '').slice(0, 120) || fallback : fallback
}

export interface DraftOutline {
  title: string
  headings: Array<{ level: number; text: string; firstSentence?: string }>
  blocks: number
  structure: string
}

interface StructureCounts {
  titles: number
  subtitles: number
  paragraphs: number
  lists: number
  tables: number
  quotes: number
  callouts: number
  columns: number
  codeBlocks: number
  diagrams: number
  formulas: number
  footnotes: number
  images: number
  files: number
  notes: number
  separators: number
  other: number
}

function structureSummary(blocks: string[], facts: QingmlStructureFacts): string {
  const counts: StructureCounts = {
    titles: 0,
    subtitles: 0,
    paragraphs: 0,
    lists: 0,
    tables: 0,
    quotes: 0,
    callouts: 0,
    columns: 0,
    codeBlocks: 0,
    diagrams: 0,
    formulas: facts.formulas,
    footnotes: facts.footnotes,
    images: 0,
    files: 0,
    notes: 0,
    separators: 0,
    other: 0,
  }
  for (const block of blocks) {
    const tag = block.match(/^<([\w-]+)(?:\s|>|\/)/i)?.[1]?.toLowerCase()
    if (!tag || tag === 'title') continue
    if (tag === 'h1') counts.titles += 1
    else if (/^h[2-6]$/.test(tag)) counts.subtitles += 1
    else if (tag === 'p') counts.paragraphs += 1
    else if (tag === 'ul' || tag === 'ol' || tag === 'tasks') counts.lists += 1
    else if (tag === 'table') counts.tables += 1
    else if (tag === 'blockquote') counts.quotes += 1
    else if (tag === 'callout') counts.callouts += 1
    else if (tag === 'columns') counts.columns += 1
    else if (tag === 'pre') counts.codeBlocks += 1
    else if (tag === 'mermaid' || tag === 'drawio') counts.diagrams += 1
    else if (tag === 'math-block') continue
    else if (tag === 'img') counts.images += 1
    else if (tag === 'file') counts.files += 1
    else if (tag === 'pennote') counts.notes += 1
    else if (tag === 'hr') counts.separators += 1
    else counts.other += 1
  }
  const parts = [
    counts.titles ? (counts.titles === 1 ? '一个标题' : `${counts.titles} 个标题`) : '',
    counts.subtitles ? `${counts.subtitles} 个小标题` : '',
    counts.paragraphs ? `${counts.paragraphs} 段正文` : '',
    counts.lists ? `${counts.lists} 个清单` : '',
    counts.tables ? `${counts.tables} 张表格` : '',
    counts.quotes ? `${counts.quotes} 处引用` : '',
    counts.callouts ? `${counts.callouts} 处提示` : '',
    counts.columns ? `${counts.columns} 组分栏` : '',
    counts.codeBlocks ? `${counts.codeBlocks} 段代码` : '',
    counts.diagrams ? `${counts.diagrams} 张图表` : '',
    counts.formulas ? `${counts.formulas} 个公式` : '',
    counts.footnotes ? `${counts.footnotes} 处脚注` : '',
    counts.images ? `${counts.images} 张图片` : '',
    counts.files ? `${counts.files} 个附件` : '',
    counts.notes ? `${counts.notes} 则旁注` : '',
    counts.separators ? `${counts.separators} 条分隔线` : '',
    counts.other ? `${counts.other} 项其他内容` : '',
  ].filter(Boolean)
  if (parts.length === 0) return '暂无正文内容'
  if (parts.length === 1) return parts[0]!
  if (parts.length === 2) return `${parts[0]}加 ${parts[1]}`
  return `${parts.slice(0, -1).join('、')}和 ${parts.at(-1)}`
}

export function outlineOf(qingml: string, title?: string | null): DraftOutline {
  const complete = completeTopLevelBlocks(qingml).blocks
  const facts = structureFactsOf(qingml)
  const headings: DraftOutline['headings'] = []
  for (let index = 0; index < complete.length; index += 1) {
    const block = complete[index] ?? ''
    const heading = block.match(/^<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>$/i)
    if (!heading) continue
    let firstSentence: string | undefined
    for (const following of complete.slice(index + 1)) {
      if (/^<h[1-6](?:\s|>)/i.test(following)) break
      const plain = stripQingml(following)
      if (plain) {
        firstSentence = plain.split(/(?<=[。！？.!?])\s*/u)[0]?.slice(0, 160)
        break
      }
    }
    headings.push({ level: Number(heading[1]), text: stripQingml(heading[2] ?? ''), ...(firstSentence ? { firstSentence } : {}) })
  }
  return {
    title: title?.trim() || extractTitle(qingml),
    headings,
    blocks: complete.filter((block) => !/^<title(?:\s|>)/i.test(block)).length,
    structure: structureSummary(complete, facts),
  }
}
