export declare const REVIEW_TURN_EDIT_ERROR = "\u5F53\u524D\u662F\u5BA1\u67E5\u56DE\u5408,\u53EA\u80FD\u751F\u6210\u6279\u6CE8(qing_annotate),\u4E0D\u80FD\u6539\u52A8\u6B63\u6587";
export type ReviewTurnType = 'sensitive' | 'deai' | 'source' | 'consistency' | 'privacy' | 'format' | 'role' | 'custom';
export interface PendingReviewTurn {
    type: ReviewTurnType;
    templateId: string;
    templateName: string;
    targetEngineSessionId: string;
}
export interface ActiveReviewTurn extends PendingReviewTurn {
    turnId: number;
}
export declare function parseReviewTurn(input: unknown): PendingReviewTurn;
export declare class ReviewTurnCoordinator {
    private readonly pending;
    private readonly active;
    markPending(dshSessionId: string, review: PendingReviewTurn): void;
    cancelPending(dshSessionId: string): void;
    activate(dshSessionId: string, turnId: number): ActiveReviewTurn | undefined;
    getActive(dshSessionId: string): ActiveReviewTurn | undefined;
    assertAnnotationOnly(dshSessionId: string): void;
    finish(dshSessionId: string, turnId?: number): boolean;
    dispose(dshSessionId: string): void;
}
export declare function reviewTurnCoordinatorFor(owner: object): ReviewTurnCoordinator;
//# sourceMappingURL=reviewTurn.d.ts.map