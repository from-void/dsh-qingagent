import { describe, expect, it } from 'vitest'
import type {
  DocSuggestion,
  ExternalPmDocReadResponse,
  ExternalReviewRenderModelResponse,
  PmDoc,
} from '../src/contracts.js'
import { buildReviewPresentationModel } from '../src/client/reviewPresentation.js'
import { renderedReviewSummary } from '../src/reviewCount.js'

const previewDoc = {
  type: 'doc', attrs: { schemaVersion: 1 },
  content: [{
    type: 'paragraph', attrs: { blockId: 'fixture-p' },
    content: [{ type: 'text', text: '青简原文' }],
  }],
} as PmDoc

const suggestion = {
  id: 'suggestion-1',
  reviewBatchId: 'batch-1',
  groupMode: 'independent',
  docId: 'qing-1',
  baseVersion: 4,
  baseSchemaVersion: 1,
  status: 'reviewing',
  anchor: {
    blockId: 'fixture-p', pmFrom: 3, pmTo: 5, quote: '原文', textHash: 'hash-fixture',
  },
  patch: {
    kind: 'prosemirror_steps',
    steps: [{ stepType: 'replace', from: 3, to: 5, slice: { content: [{ type: 'text', text: '新文' }] } }],
  },
  preview: { deleteText: '原文', insertText: '新文' },
  summary: '替换正文',
} satisfies DocSuggestion

describe('external review render-model → PatchDecorations 输入', () => {
  it('固定 DocSuggestion fixture 的计数、导航、hover meta 与 decoration 输入同源', () => {
    const panelDoc = {
      sessionId: 'qing-1', docVersion: 4, contentHash: 'hash-4', state: 'pendingReview',
      agentBusy: false, title: '审阅稿', ts: '2026-08-15T02:00:00.000Z', charCount: 4, pmDoc: previewDoc,
    } satisfies ExternalPmDocReadResponse
    const renderModel = {
      sessionId: 'qing-1', docVersion: 4, state: 'pendingReview', agentBusy: false,
      baseVersion: 4, previewDoc, suggestions: [suggestion],
    } satisfies ExternalReviewRenderModelResponse

    const model = buildReviewPresentationModel(panelDoc, renderModel)

    expect(model).not.toBeNull()
    expect(model?.overlayInputs).toHaveLength(1)
    expect(model?.blockPatchInputs).toHaveLength(0)
    expect(model?.applied.map((patch) => patch.id)).toEqual(['suggestion-1'])
    expect(model?.reviewTargets.map((target) => target.patchId)).toEqual(['suggestion-1'])
    expect(model?.visibleReviewTargets).toHaveLength(1)
    expect(model?.patchMeta.get('suggestion-1')).toMatchObject({
      before: '原文', after: '新文', index: 1,
    })
    expect(model?.droppedCount).toBe(0)
    expect(model?.conflictCount).toBe(0)
  })

  it('工具计数与面板实际 ReviewTarget 数一致，无法定位的 suggestion 不计入', () => {
    const panelDoc = {
      sessionId: 'qing-1', docVersion: 4, contentHash: 'hash-4', state: 'pendingReview',
      agentBusy: false, title: '审阅稿', ts: '2026-08-15T02:00:00.000Z', charCount: 4, pmDoc: previewDoc,
    } satisfies ExternalPmDocReadResponse
    const unrenderable = {
      ...suggestion,
      id: 'suggestion-unrenderable',
      anchor: { ...suggestion.anchor, blockId: 'missing-location', quote: '不存在的文字' },
    } satisfies DocSuggestion
    const renderModel = {
      sessionId: 'qing-1', docVersion: 4, state: 'pendingReview', agentBusy: false,
      baseVersion: 4, previewDoc, suggestions: [suggestion, unrenderable],
    } satisfies ExternalReviewRenderModelResponse

    const panelModel = buildReviewPresentationModel(panelDoc, renderModel)!
    const toolSummary = renderedReviewSummary(panelDoc.pmDoc, renderModel)

    expect(panelModel.visibleReviewTargets).toHaveLength(1)
    expect(toolSummary.count).toBe(panelModel.visibleReviewTargets.length)
    expect(toolSummary.patchIds).toEqual(['suggestion-1'])
    expect(toolSummary.reviewingPatchIds).toEqual(['suggestion-1', 'suggestion-unrenderable'])
  })
})
