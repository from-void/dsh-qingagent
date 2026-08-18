import { describe, expect, it } from 'vitest'
import type { ExternalReviewRenderModelResponse, PmDoc } from '../src/contracts.js'
import { isWholeDocReview } from '../src/reviewMode.js'

const BASE_DOC = pmDoc('旧版')
const EDITED_DOC = pmDoc('新版')

describe('共享整篇审判定', () => {
  it('wholeDocument 且 editedDoc 完整时进入整篇审', () => {
    expect(isWholeDocReview(
      { pmDoc: BASE_DOC },
      reviewModel({ wholeDocument: true, editedDoc: EDITED_DOC }),
      true,
    )).toBe(true)
  })

  it('editedDoc 缺失时即使 wholeDocument 为 true 也回落逐处审', () => {
    expect(isWholeDocReview(
      { pmDoc: BASE_DOC },
      reviewModel({ wholeDocument: true, editedDoc: undefined }),
      true,
    )).toBe(false)
  })
})

function reviewModel(
  overrides: Partial<ExternalReviewRenderModelResponse>,
): ExternalReviewRenderModelResponse {
  return {
    sessionId: 'qing-review',
    docVersion: 1,
    state: 'pendingReview',
    agentBusy: false,
    baseVersion: 1,
    suggestions: [],
    previewDoc: BASE_DOC,
    ...overrides,
  }
}

function pmDoc(text: string): PmDoc {
  return {
    type: 'doc',
    attrs: { schemaVersion: 1 },
    content: [{
      type: 'paragraph',
      attrs: { blockId: `paragraph-${text}` },
      content: [{ type: 'text', text }],
    }],
  }
}
