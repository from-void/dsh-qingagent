import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
export declare const QING_ANNOTATION_REFERENCE_SOURCE = "qingagent-annotation";
type SessionInput = ReturnType<IConversation['input']['for']>;
export type InputState = ReturnType<SessionInput['state']['getSnapshot']>;
/** 批注 chip 底层 label 只留修改方向本体(10 字截断):图标与「批注:」前缀由呈现层
 *  覆盖文本提供,底层越短 chip 越紧凑(用户裁定宽度自适应)。完整指令保存在 ref 中。 */
export declare function annotationReferenceLabel(instruction: string): string;
/** 多枚批注 chip 的投影文本必须互不为前缀:尾缀「·N」不行(@X 仍是 @X·2 的前缀),
 *  setDraft 的 diff 依旧歧义,替换某枚时会把相邻 occurrence 吞掉(评测 r2 席3 两轮实证)。
 *  改为序号前置——首字符即分叉,任意两枚互不为前缀;序号取未被占用的最小圈号。 */
export declare function dedupeAnnotationLabel(label: string, takenLabels: readonly string[]): string;
/** 在当前草稿末尾追加一枚批注 chip；同一指令可按用户操作重复追加。 */
export declare function insertAnnotationReference(actx: ClientContext, instruction: string): boolean;
/** 批注 occurrence 提交时将完整修改指令原样展开。 */
export declare const qingAnnotationReferenceSource: InputTriggerSource;
/**
 * 宿主版本可能把 occurrence 投影成单个 U+FFFC，也可能投影成 @label 文本；
 * 只接受 offset 处的精确形态，避免错删用户正文。
 */
export declare function findOccurrenceProjection(state: InputState, occurrenceId: number): {
    start: number;
    end: number;
} | undefined;
/** 仅在普通输入阶段删除已精确定位的 occurrence 投影。 */
export declare function removeOccurrenceFromDraft(actx: ClientContext, occurrenceId: number): boolean;
/**
 * 原位替换 occurrence。先删除旧投影，再用删除后的 draftRev 插入新引用；插入失败时
 * 优先通过旧 reference 重建 occurrence，若宿主拒绝重建则至少恢复原草稿文本。
 */
export declare function replaceOccurrenceRef(actx: ClientContext, occurrenceId: number, newRef: string): boolean;
export declare function remintDraftReferences(actx: ClientContext): number;
export {};
//# sourceMappingURL=annotationReference.d.ts.map