import type { PmDoc } from '@qingagent/pm-schema'
import {
  DEFAULT_REVEAL_CHARS_PER_TICK,
  DEFAULT_REVEAL_CONCURRENCY,
  planRevealTypewriter,
} from './revealTypewriter.js'

interface JsonPmNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: unknown[]
  content?: JsonPmNode[]
  [key: string]: unknown
}

export interface DocumentRevealFrame {
  pmDoc: PmDoc
  charEnters: Array<{ from: number; to: number }>
}

function textLength(node: JsonPmNode): number {
  if (typeof node.text === 'string') return Array.from(node.text).length
  return node.content?.reduce((total, child) => total + textLength(child), 0) ?? 0
}

function truncateNode(node: JsonPmNode, remaining: { value: number }): JsonPmNode | null {
  if (typeof node.text === 'string') {
    if (remaining.value <= 0) return null
    const points = Array.from(node.text)
    const text = points.slice(0, remaining.value).join('')
    remaining.value -= Math.min(points.length, remaining.value)
    return text ? { ...node, text } : null
  }
  if (!node.content) return { ...node }
  return {
    ...node,
    content: node.content.flatMap((child) => {
      const truncated = truncateNode(child, remaining)
      return truncated ? [truncated] : []
    }),
  }
}

function nodeSize(node: JsonPmNode): number {
  if (typeof node.text === 'string') return node.text.length
  if (!node.content) return 1
  return 2 + node.content.reduce((total, child) => total + nodeSize(child), 0)
}

function collectTextRanges(
  node: JsonPmNode,
  position: number,
  localOffset: { value: number },
  fromCodePoint: number,
  toCodePoint: number,
  ranges: Array<{ from: number; to: number }>,
): void {
  if (typeof node.text === 'string') {
    const points = Array.from(node.text)
    const start = localOffset.value
    const end = start + points.length
    const overlapFrom = Math.max(start, fromCodePoint)
    const overlapTo = Math.min(end, toCodePoint)
    if (overlapTo > overlapFrom) {
      const from = position + points.slice(0, overlapFrom - start).join('').length
      const to = position + points.slice(0, overlapTo - start).join('').length
      ranges.push({ from, to })
    }
    localOffset.value = end
    return
  }
  let childPosition = position + 1
  for (const child of node.content ?? []) {
    collectTextRanges(child, childPosition, localOffset, fromCodePoint, toCodePoint, ranges)
    childPosition += nodeSize(child)
  }
}

/** 把一次落库的完整 PM 文档规划成纸面逐字帧，不参与网络或定时。 */
export function planDocumentReveal(
  document: PmDoc,
  concurrency = DEFAULT_REVEAL_CONCURRENCY,
  charsPerTick = DEFAULT_REVEAL_CHARS_PER_TICK,
): DocumentRevealFrame[] {
  const root = document as unknown as JsonPmNode
  const blocks = root.content ?? []
  const ids = blocks.map((_, index) => `block:${index}`)
  const targets = new Map(ids.map((id, index) => [id, textLength(blocks[index]!)]))
  const planned = planRevealTypewriter(ids, (id) => targets.get(id) ?? 0, concurrency, charsPerTick)
  let previousTyped = new Map<string, number>()

  return planned.map((frame) => {
    const typed = new Map(frame.typed)
    const revealed = new Set(frame.revealed)
    const content: JsonPmNode[] = []
    const charEnters: Array<{ from: number; to: number }> = []
    let topPosition = 0
    blocks.forEach((block, index) => {
      const id = ids[index]!
      if (!revealed.has(id)) return
      const current = typed.get(id) ?? 0
      const partial = truncateNode(block, { value: current }) ?? { ...block, content: [] }
      content.push(partial)
      const previous = previousTyped.get(id) ?? 0
      if (current > previous) {
        collectTextRanges(partial, topPosition, { value: 0 }, previous, current, charEnters)
      }
      topPosition += nodeSize(partial)
    })
    previousTyped = typed
    return {
      pmDoc: { ...root, content } as unknown as PmDoc,
      charEnters,
    }
  })
}
