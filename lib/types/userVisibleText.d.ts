/** 新鲜度闸门给模型的稳定错误；客户端据此隐藏仅用于自恢复的失败卡。 */
export declare const FRESH_DRAFT_REQUIRED_ERROR = "\u8BF7\u5148\u8C03\u7528 qing_read_draft \u8BFB\u53D6\u5F53\u524D\u6587\u7A3F\uFF0C\u518D\u57FA\u4E8E\u6700\u65B0\u5185\u5BB9\u4FEE\u6539\u3002";
/** 整稿替换必须真的取得全文，提纲或定位清单不能冒充完整正文。 */
export declare const FULL_DRAFT_REQUIRED_ERROR = "\u6574\u7A3F\u6539\u5199\u524D\uFF0C\u8BF7\u5148\u8C03\u7528 qing_read_draft\uFF0C\u4EE5 mode:\"full\"\u3001mode:\"base\" \u6216 mode:\"lines\" \u8BFB\u53D6\u5F53\u524D\u5168\u6587\uFF0C\u518D\u57FA\u4E8E\u5B8C\u6574\u5185\u5BB9\u91CD\u5199\u3002";
/**
 * 工具呈现、状态摘要与 toast 的统一用户文案出口。
 * 旧记录或引擎错误仍可能带内部定位信息；所有真正展示给用户的摘要在这里去内部术语。
 */
export declare function sanitizeUserVisibleText(text: string): string;
export declare function toolContentText(content: readonly unknown[]): string;
export declare function isFreshnessGateFailure(content: readonly unknown[]): boolean;
//# sourceMappingURL=userVisibleText.d.ts.map