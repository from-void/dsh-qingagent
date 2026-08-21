export type QingmlSourceSyntaxLeak = 'footnote-reference' | 'footnote-definition' | 'inline-math' | 'block-math';
export interface QingmlSourceSyntaxConversion {
    qingml: string;
    convertedFootnotes: number;
    convertedFormulas: number;
    converted: number;
    leaks: QingmlSourceSyntaxLeak[];
}
export interface QingmlStructureFacts {
    footnotes: number;
    formulas: number;
}
/**
 * 在落库前检查解析后的正文文本节点，避免把 GFM 脚注源语法当普通文字写进纸面。
 * 基于 AI-IR 而非原始字符串检查，可自然排除代码块和原生脚注/公式节点。
 */
export declare function findQingmlSourceSyntaxLeaks(qingml: string): QingmlSourceSyntaxLeak[];
/**
 * 把正文文本节点中的脚注/公式源写法确定性转换成 AI-IR 原生结构。
 * 只有配对且可无损处理的脚注、明确的块公式和带 LaTeX 特征的行内公式会转换。
 */
export declare function convertQingmlSourceSyntax(qingml: string): QingmlSourceSyntaxConversion;
export declare function structureFactsOf(qingml: string): QingmlStructureFacts;
export interface CompleteBlocks {
    blocks: string[];
    completeLength: number;
}
/**
 * 找出当前流中已经闭合的顶层块。解析只负责流式边界，不替代引擎的权威 QingML 校验。
 */
export declare function completeTopLevelBlocks(input: string): CompleteBlocks;
export declare function stripQingml(text: string): string;
export declare function extractTitle(qingml: string, fallback?: string): string;
export interface DraftOutline {
    title: string;
    headings: Array<{
        level: number;
        text: string;
        firstSentence?: string;
    }>;
    blocks: number;
    structure: string;
}
export declare function outlineOf(qingml: string, title?: string | null): DraftOutline;
//# sourceMappingURL=qingml.d.ts.map