import type { ExternalPmDocReadResponse, ExternalReviewRenderModelResponse } from '../contracts.js';
import { deriveRenderedReview } from '../reviewCount.js';
import type { BlockPatchInput, PatchOverlayInput, ReviewTarget, ViewDocumentSnapshot } from '@qingweb/pages/workspace/data/protocol';
import type { PatchMeta } from '@qingweb/pages/workspace/data/patchMeta';
export interface ReviewPresentationModel {
    doc: ViewDocumentSnapshot;
    suggestions: ExternalReviewRenderModelResponse['suggestions'];
    overlayInputs: PatchOverlayInput[];
    blockPatchInputs: BlockPatchInput[];
    applied: ReturnType<typeof deriveRenderedReview>['presentation']['applied'];
    reviewTargets: ReviewTarget[];
    visibleReviewTargets: ReviewTarget[];
    patchMeta: Map<string, PatchMeta>;
    acceptedIds: Set<string>;
    rejectedIds: Set<string>;
    droppedCount: number;
    conflictCount: number;
}
/** external durable render-model → 青简原生 PatchDecorations 的完整输入。 */
export declare function buildReviewPresentationModel(panelDoc: ExternalPmDocReadResponse, renderModel: ExternalReviewRenderModelResponse): ReviewPresentationModel | null;
//# sourceMappingURL=reviewPresentation.d.ts.map