export interface WholeDocReviewNavProps {
    /** 当前整篇审作用域；确认弹层异步返回后必须仍匹配，避免跨会话/跨审阅误执行。 */
    reviewScopeKey: string;
    version: 'new' | 'old';
    isSubmitting?: boolean;
    onVersionChange: (version: 'new' | 'old') => void;
    /** 应用新版 = 提交本轮全部修改(commit)。 */
    onApply: () => void | Promise<void>;
    /** 退回旧版 = 放弃本轮全部修改(discard)。 */
    onRevert: () => void | Promise<void>;
    onToast?: (message: string) => void;
}
/** 青简 WholeDocReviewNav.tsx 逐结构移植；DOM/class/文案/交互与产品源一致。 */
export declare function WholeDocReviewNav({ reviewScopeKey, version, isSubmitting, onVersionChange, onApply, onRevert, onToast, }: WholeDocReviewNavProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=WholeDocReviewNav.d.ts.map