// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffHunk, DocSuggestion } from '@qingagent/contract-ts'
import type { PmDoc, PmNode } from '@qingagent/contract-ts'
import { DocumentSnapshotView } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import { blockPatchIds } from '@qingweb/pages/workspace/data/protocol'
import type {
  ExternalPmDocReadResponse,
  ExternalReviewRenderModelResponse,
} from '../src/contracts.js'
import { buildReviewPresentationModel } from '../src/client/reviewPresentation.js'

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg/>' })) },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  const rect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 })
  Element.prototype.getBoundingClientRect = rect
  Range.prototype.getBoundingClientRect = rect
  Element.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  host = document.createElement('div')
  host.dataset.qingagentDocPanel = ''
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

async function flush(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })
}

// w9C F1 真机场景:三项项目符号清单,只改第 1、3 项(2 处待裁决)。
const item = (blockId: string, value: string) => ({
  type: 'listItem' as const,
  attrs: { blockId },
  content: [{
    type: 'paragraph' as const,
    attrs: { blockId: `${blockId}-p` },
    content: [{ type: 'text' as const, text: value }],
  }],
})
const baseItems = [item('p74-item-a', '旧甲'), item('p74-item-b', '保留乙'), item('p74-item-c', '旧丙')]
const baseList = { type: 'bulletList' as const, attrs: { blockId: 'p74-list' }, content: baseItems }
const baseDoc: PmDoc = { type: 'doc', attrs: { schemaVersion: 1 }, content: [baseList] } as PmDoc

/**
 * 复刻 proposalDiff.createListItemReplaceHunk 的产物形状:
 * beforeBlock 是基准清单;afterBlock 是"只叠加本 hunk 那一处改动"的父清单投影
 * (每个 hunk 各自只含自己那一处,合并器负责重建叠加全部改动的整份清单)。
 */
function itemReplaceHunk(itemIndex: number, afterValue: string): DiffHunk {
  const beforeItem = baseItems[itemIndex]!
  const afterItem = item(beforeItem.attrs.blockId, afterValue)
  const afterItems = [...baseItems]
  afterItems[itemIndex] = afterItem
  const beforeText = beforeItem.content[0]!.content![0]!.text!
  return {
    hunkId: `p74-hunk-${itemIndex}`,
    reviewBatchId: `p74-hunk-${itemIndex}`,
    groupMode: 'independent',
    op: 'replace',
    blockPath: [0, itemIndex],
    anchor: {
      blockId: beforeItem.attrs.blockId,
      quoteBefore: beforeText,
      quoteAfter: afterValue,
      pmFrom: 0,
      pmTo: 0,
      anchorKind: 'range',
    },
    before: [beforeItem as unknown as PmNode],
    after: [afterItem as unknown as PmNode],
    beforeText,
    afterText: afterValue,
    beforeBlock: baseList as unknown as PmNode,
    afterBlock: { ...baseList, content: afterItems } as unknown as PmNode,
    summary: '替换列表项',
  }
}

const hunks = [itemReplaceHunk(0, '新甲'), itemReplaceHunk(2, '新丙')]

function suggestionFromHunk(hunk: DiffHunk): DocSuggestion {
  return {
    id: hunk.hunkId,
    reviewBatchId: hunk.reviewBatchId,
    groupMode: hunk.groupMode,
    docId: 'p74-doc',
    baseVersion: 1,
    baseSchemaVersion: 1,
    status: 'reviewing',
    anchor: {
      blockId: hunk.anchor.blockId ?? hunk.hunkId,
      pmFrom: hunk.anchor.pmFrom ?? 0,
      pmTo: hunk.anchor.pmTo ?? hunk.anchor.pmFrom ?? 0,
      quote: hunk.beforeText ?? hunk.afterText ?? hunk.summary,
      textHash: `hash-${hunk.hunkId}`,
    },
    patch: { kind: 'prosemirror_steps', steps: [] },
    preview: {
      deleteText: hunk.beforeText ?? '',
      insertText: hunk.afterText ?? '',
    },
    diffHunk: hunk,
    summary: hunk.summary,
  } as DocSuggestion
}

function buildModel() {
  const panelDoc = {
    sessionId: 'qing-p74', docVersion: 1, contentHash: 'hash-1', state: 'pendingReview',
    agentBusy: false, title: '审阅稿', ts: '2026-08-18T02:00:00.000Z', charCount: 6, pmDoc: baseDoc,
  } satisfies ExternalPmDocReadResponse
  const renderModel = {
    sessionId: 'qing-p74', docVersion: 1, state: 'pendingReview', agentBusy: false,
    baseVersion: 1, previewDoc: baseDoc, suggestions: hunks.map(suggestionFromHunk),
  } satisfies ExternalReviewRenderModelResponse
  const model = buildReviewPresentationModel(panelDoc, renderModel)
  expect(model).not.toBeNull()
  return model!
}

describe('P74:同一清单多处项级改动在待审纸面只渲染一份清单', () => {
  it('两个项级 hunk 合并成一条块级输入,且各自 patchId 都保留', () => {
    const model = buildModel()

    expect(model.blockPatchInputs).toHaveLength(1)
    expect(blockPatchIds(model.blockPatchInputs[0]!).sort()).toEqual(
      hunks.map((hunk) => hunk.hunkId).sort(),
    )
    expect(model.reviewTargets.map((target) => target.patchId).sort()).toEqual(
      hunks.map((hunk) => hunk.hunkId).sort(),
    )
  })

  it('真实渲染:纸面只有一份清单,两行分别绑定各自裁决目标;驳回其一后仍是一份清单', async () => {
    const model = buildModel()

    const render = (rejectedIds: Set<string>) => {
      root.render(
        <DocumentSnapshotView
          doc={model.doc}
          editable
          interactiveEditable={false}
          showPatches
          acceptedPatches={new Set()}
          rejectedPatches={rejectedIds}
          reviewBlockPatches={model.blockPatchInputs}
          reviewAppliedPatches={model.applied}
          reviewTargets={model.reviewTargets}
        />,
      )
    }

    act(() => render(new Set()))
    await flush()

    // 正面断言(jsdom 无布局,只断言 DOM 结构):插入 widget 只有 1 个,
    // 其中清单只有 1 份;连被隐藏的原清单在内,全文 ul 共 2 个(修复前是 3 个)。
    expect(host.querySelectorAll('.wf-blockmark.insert')).toHaveLength(1)
    expect(host.querySelectorAll('.wf-blockmark.insert ul')).toHaveLength(1)
    expect(host.querySelectorAll('ul')).toHaveLength(2)

    const changedRows = host.querySelectorAll('.wf-blockmark.insert .wf-list-row--changed')
    expect(Array.from(changedRows).map((row) => row.textContent)).toEqual(['新甲', '新丙'])
    // 两处仍可独立裁决:两行各自绑定不同的 review target,且对应不同 patchId。
    const targetIds = Array.from(changedRows).map((row) => row.getAttribute('data-review-target-id'))
    expect(new Set(targetIds).size).toBe(2)
    const patchByTarget = new Map(model.reviewTargets.map((target) => [target.id, target.patchId]))
    const rowPatchIds = targetIds.map((id) => patchByTarget.get(id ?? ''))
    expect(new Set(rowPatchIds).size).toBe(2)
    expect(rowPatchIds.sort()).toEqual(hunks.map((hunk) => hunk.hunkId).sort())

    // 部分裁决(驳回第 3 项的改动)后重渲染:仍只有一份清单,仅剩第 1 项的改动行。
    const rejectedPatchId = model.reviewTargets.find(
      (target) => target.id === targetIds[1],
    )!.patchId
    act(() => render(new Set([rejectedPatchId])))
    await flush()

    expect(host.querySelectorAll('.wf-blockmark.insert')).toHaveLength(1)
    expect(host.querySelectorAll('.wf-blockmark.insert ul')).toHaveLength(1)
    const remaining = host.querySelectorAll('.wf-blockmark.insert .wf-list-row--changed')
    expect(Array.from(remaining).map((row) => row.textContent)).toEqual(['新甲'])
  })
})
