import type {
  ExternalPmDocReadResponse,
  ExternalReviewRenderModelResponse,
} from '../contracts.js'
import {
  derivePatchPresentation,
  mergeGranularListBlockPatchInputs,
  pmDocToViewDocumentSnapshot,
  suggestionToBlockPatchInputs,
  suggestionToPatchOverlay,
  type BlockPatchInput,
  type PatchOverlayInput,
  type ReviewTarget,
  type ViewDocumentSnapshot,
} from '@qingweb/pages/workspace/data/protocol'
import { buildPatchMeta } from '@qingweb/pages/workspace/data/reviewActions'
import type { PatchMeta } from '@qingweb/pages/workspace/data/patchMeta'

export interface ReviewPresentationModel {
  doc: ViewDocumentSnapshot
  suggestions: ExternalReviewRenderModelResponse['suggestions']
  overlayInputs: PatchOverlayInput[]
  blockPatchInputs: BlockPatchInput[]
  applied: ReturnType<typeof derivePatchPresentation>['applied']
  reviewTargets: ReviewTarget[]
  visibleReviewTargets: ReviewTarget[]
  patchMeta: Map<string, PatchMeta>
  acceptedIds: Set<string>
  rejectedIds: Set<string>
  droppedCount: number
  conflictCount: number
}

/** external durable render-model → 青简原生 PatchDecorations 的完整输入。 */
export function buildReviewPresentationModel(
  panelDoc: ExternalPmDocReadResponse,
  renderModel: ExternalReviewRenderModelResponse,
): ReviewPresentationModel | null {
  const baseDoc = renderModel.previewDoc ?? panelDoc.pmDoc
  if (!baseDoc) return null
  const doc = pmDocToViewDocumentSnapshot(baseDoc, renderModel.baseVersion, panelDoc.ts)
  const suggestions = renderModel.suggestions.filter((suggestion) =>
    suggestion.kind !== 'annotation' &&
    (suggestion.status === 'reviewing' || suggestion.status === 'accepted' || suggestion.status === 'rejected'))

  const overlayInputs = suggestions.flatMap((suggestion, order) => {
    const overlay = suggestionToPatchOverlay(doc, suggestion, order)
    return overlay ? [overlay] : []
  })
  const overlayCoveredIds = new Set(overlayInputs.map((input) => input.id))
  // P74:同一父清单的多个项级 hunk 必须合并成一条输入,否则每条 replace 输入
  // 各自渲染整份清单,纸面把同一份清单重复 N 遍(N=项级改动数)。
  // 与青简客户端 useWorkspacePageController 的 blockPatchInputs 收集器保持一致。
  const blockPatchInputs = mergeGranularListBlockPatchInputs(suggestions.flatMap((suggestion, order) =>
    overlayCoveredIds.has(suggestion.id) ? [] : suggestionToBlockPatchInputs(suggestion, order)))
  const presentation = derivePatchPresentation(doc, overlayInputs, blockPatchInputs)
  const reviewingIds = new Set(
    suggestions.filter((suggestion) => suggestion.status === 'reviewing').map((suggestion) => suggestion.id),
  )

  return {
    doc,
    suggestions,
    overlayInputs,
    blockPatchInputs,
    applied: presentation.applied,
    reviewTargets: presentation.reviewTargets,
    visibleReviewTargets: presentation.reviewTargets.filter((target) => reviewingIds.has(target.patchId)),
    patchMeta: buildPatchMeta(presentation.applied),
    acceptedIds: new Set(
      suggestions.filter((suggestion) => suggestion.status === 'accepted').map((suggestion) => suggestion.id),
    ),
    rejectedIds: new Set(
      suggestions.filter((suggestion) => suggestion.status === 'rejected').map((suggestion) => suggestion.id),
    ),
    droppedCount: presentation.droppedIds.length,
    conflictCount: presentation.conflictIds.length,
  }
}
