export type QingReviewType = 'sensitive' | 'deai' | 'source' | 'consistency' | 'privacy' | 'format' | 'role' | 'custom';
export declare const QING_REVIEW_MENU_ORDER: readonly QingReviewType[];
export interface DshReviewTemplate {
    id: string;
    name: string;
    prompt: string;
}
export declare function assembleDshReviewQuery(type: QingReviewType, template: DshReviewTemplate, supplement: string, lexicons?: ReadonlyArray<{
    id: string;
    name: string;
}>, targetTitle?: string): string;
export interface QingExportFormat {
    id: 'pdf' | 'docx' | 'html' | 'markdown' | 'txt';
    label: string;
    ext: string;
    savedToast: string;
}
/** 与青简 ExportMenu 的确定性格式清单一致(飞书等平台技能不在 dsh 语境,不列)。 */
export declare const QING_EXPORT_FORMATS: readonly QingExportFormat[];
export declare function exportFilename(title: string, ext: string, now?: Date): string;
/** 降级提示按引擎申报的 description 逐条转述——种类不同(源码导出 vs 画布布局未应用)不能混为一谈。 */
export declare function describeExportDegradations(encoded: string | undefined): string;
//# sourceMappingURL=reviewExport.d.ts.map