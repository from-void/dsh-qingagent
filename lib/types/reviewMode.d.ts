import type { ExternalReviewRenderModelResponse, PmDoc } from './contracts.js';
export declare const WHOLE_DOC_REVIEW_THRESHOLD = 0.7;
interface ReviewBaseDocument {
    pmDoc?: PmDoc | null;
}
/**
 * 与青简产品侧 external review render-model 使用同一可见字符口径。
 * 放在 host/client 共用纯模块中，避免工具卡与面板各自复制阈值和派生公式。
 */
export declare function computeExternalReviewChangeRatio<T extends ReviewBaseDocument>(panelDoc: T, renderModel: ExternalReviewRenderModelResponse): number;
/** editedDoc 缺失时必须回落逐处审，与右侧面板的真实渲染条件保持一致。 */
export declare function isWholeDocReview<T extends ReviewBaseDocument>(panelDoc: T, renderModel: ExternalReviewRenderModelResponse, effectiveReview: boolean): boolean;
export {};
//# sourceMappingURL=reviewMode.d.ts.map