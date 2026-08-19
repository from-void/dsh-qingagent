import type {
  ExternalPmDocReadResponse,
  ExternalReviewRenderModelResponse,
} from '../contracts.js'
import { deriveRenderedReview } from '../reviewCount.js'
import type { BlockPatchInput, PatchOverlayInput, ReviewTarget, ViewDocumentSnapshot } from '@qingweb/pages/workspace/data/protocol'
import { buildPatchMeta } from '@qingweb/pages/workspace/data/reviewActions'
import type { PatchMeta } from '@qingweb/pages/workspace/data/patchMeta'

export interface ReviewPresentationModel {
  doc: ViewDocumentSnapshot
  suggestions: ExternalReviewRenderModelResponse['suggestions']
  overlayInputs: PatchOverlayInput[]
  blockPatchInputs: BlockPatchInput[]
  applied: ReturnType<typeof deriveRenderedReview>['presentation']['applied']
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
  const { doc, suggestions, overlayInputs, blockPatchInputs, presentation, reviewingIds } =
    deriveRenderedReview(baseDoc, renderModel, panelDoc.ts)

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
