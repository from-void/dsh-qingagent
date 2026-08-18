import { countDocVisibleChars, countVisibleChars } from '@qingagent/pm-schema'
import type { ExternalReviewRenderModelResponse, PmDoc } from './contracts.js'

export const WHOLE_DOC_REVIEW_THRESHOLD = 0.7

interface ReviewBaseDocument {
  pmDoc?: PmDoc | null
}

/**
 * 与青简产品侧 external review render-model 使用同一可见字符口径。
 * 放在 host/client 共用纯模块中，避免工具卡与面板各自复制阈值和派生公式。
 */
export function computeExternalReviewChangeRatio<T extends ReviewBaseDocument>(
  panelDoc: T,
  renderModel: ExternalReviewRenderModelResponse,
): number {
  const changed = renderModel.suggestions.reduce((sum, suggestion) => {
    if (suggestion.kind === 'annotation') return sum
    if (
      suggestion.status !== 'reviewing' &&
      suggestion.status !== 'accepted' &&
      suggestion.status !== 'rejected'
    ) return sum
    const before = suggestion.diffHunk?.beforeText ?? suggestion.preview.deleteText
    const after = suggestion.diffHunk?.afterText ?? suggestion.preview.insertText
    return sum + countVisibleChars(before ?? '') + countVisibleChars(after ?? '')
  }, 0)
  const baseDoc = renderModel.previewDoc ?? panelDoc.pmDoc
  const total = (baseDoc ? countDocVisibleChars(baseDoc) : 0) +
    (renderModel.editedDoc ? countDocVisibleChars(renderModel.editedDoc) : 0)
  return total > 0 ? changed / total : 0
}

/** editedDoc 缺失时必须回落逐处审，与右侧面板的真实渲染条件保持一致。 */
export function isWholeDocReview<T extends ReviewBaseDocument>(
  panelDoc: T,
  renderModel: ExternalReviewRenderModelResponse,
  effectiveReview: boolean,
): boolean {
  if (!effectiveReview || !renderModel.editedDoc) return false
  const engineChangeRatio = renderModel.changeRatio
  const changeRatio = typeof engineChangeRatio === 'number' && Number.isFinite(engineChangeRatio)
    ? engineChangeRatio
    : computeExternalReviewChangeRatio(panelDoc, renderModel)
  return renderModel.wholeDocument === true || changeRatio >= WHOLE_DOC_REVIEW_THRESHOLD
}
