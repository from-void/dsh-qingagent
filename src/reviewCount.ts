import type { ExternalReviewRenderModelResponse, PmDoc } from './contracts.js'
import {
  derivePatchPresentation,
  mergeGranularListBlockPatchInputs,
  pmDocToViewDocumentSnapshot,
  suggestionToBlockPatchInputs,
  suggestionToPatchOverlay,
} from '@qingweb/pages/workspace/data/protocol'

const ACTIVE_REVIEW_STATUSES = new Set(['reviewing', 'accepted', 'rejected'])

/** 面板和服务端计数共同使用的原生审阅投影。 */
export function deriveRenderedReview(
  basePmDoc: PmDoc,
  renderModel: ExternalReviewRenderModelResponse,
  timestamp = '',
) {
  const doc = pmDocToViewDocumentSnapshot(
    renderModel.previewDoc ?? basePmDoc,
    renderModel.baseVersion,
    timestamp,
  )
  const suggestions = renderModel.suggestions.filter((suggestion) =>
    suggestion.kind !== 'annotation' && ACTIVE_REVIEW_STATUSES.has(suggestion.status))
  const overlayInputs = suggestions.flatMap((suggestion, order) => {
    try {
      const overlay = suggestionToPatchOverlay(doc, suggestion, order)
      return overlay ? [overlay] : []
    } catch {
      return []
    }
  })
  const overlayCoveredIds = new Set(overlayInputs.map((input) => input.id))
  const blockPatchInputs = mergeGranularListBlockPatchInputs(suggestions.flatMap((suggestion, order) => {
    if (overlayCoveredIds.has(suggestion.id)) return []
    try {
      return suggestionToBlockPatchInputs(suggestion, order)
    } catch {
      return []
    }
  }))
  const presentation = derivePatchPresentation(doc, overlayInputs, blockPatchInputs)
  const reviewingIds = new Set(
    suggestions.filter((suggestion) => suggestion.status === 'reviewing').map((suggestion) => suggestion.id),
  )

  return { doc, suggestions, overlayInputs, blockPatchInputs, presentation, reviewingIds }
}

/**
 * 与右侧面板完全同源地派生可裁决目标。suggestion 只是引擎意图；只有成功投影成
 * ReviewTarget 的目标才会实际出现在逐项裁决面板里。
 */
export function renderedReviewSummary(
  basePmDoc: PmDoc,
  renderModel: ExternalReviewRenderModelResponse,
): {
  count: number
  patchIds: string[]
  reviewingPatchIds: string[]
  droppedCount: number
  conflictCount: number
} {
  const { suggestions, presentation, reviewingIds } = deriveRenderedReview(basePmDoc, renderModel)
  const reviewingPatchIds = suggestions
    .filter((suggestion) => suggestion.status === 'reviewing')
    .map((suggestion) => suggestion.id)
  const visibleTargets = presentation.reviewTargets.filter((target) => reviewingIds.has(target.patchId))

  return {
    count: visibleTargets.length,
    patchIds: [...new Set(visibleTargets.map((target) => target.patchId))],
    reviewingPatchIds,
    droppedCount: presentation.droppedIds.length,
    conflictCount: presentation.conflictIds.length,
  }
}
