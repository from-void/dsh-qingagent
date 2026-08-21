import type { ExternalReviewRenderModelResponse, PmDoc } from './contracts.js';
/** 面板和服务端计数共同使用的原生审阅投影。 */
export declare function deriveRenderedReview(basePmDoc: PmDoc, renderModel: ExternalReviewRenderModelResponse, timestamp?: string): {
    doc: {
        version: number;
        ts: string;
        sections: unknown[];
        pmDoc: PmDoc;
    };
    suggestions: import("./contracts.js").DocSuggestion[];
    overlayInputs: import("@qingweb/pages/workspace/data/protocol").PatchOverlayInput[];
    blockPatchInputs: import("@qingweb/pages/workspace/data/protocol").BlockPatchInput[];
    presentation: {
        applied: import("@qingweb/pages/workspace/data/protocol").AppliedPatch[];
        reviewTargets: import("@qingweb/pages/workspace/data/protocol").ReviewTarget[];
        groups: unknown[];
        appliedGroupIds: Set<string>;
        appliedIds: Set<string>;
        droppedIds: string[];
        conflictIds: string[];
    };
    reviewingIds: Set<string>;
};
/**
 * 与右侧面板完全同源地派生可裁决目标。suggestion 只是引擎意图；只有成功投影成
 * ReviewTarget 的目标才会实际出现在逐项裁决面板里。
 */
export declare function renderedReviewSummary(basePmDoc: PmDoc, renderModel: ExternalReviewRenderModelResponse): {
    count: number;
    patchIds: string[];
    reviewingPatchIds: string[];
    droppedCount: number;
    conflictCount: number;
};
//# sourceMappingURL=reviewCount.d.ts.map