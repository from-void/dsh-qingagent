import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { InputTriggerSource, ReferenceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { QingSelection } from '../contracts.js';
export declare const QING_SELECTION_REFERENCE_SOURCE = "qingagent-selection";
export declare const CHIP_LABEL_PREVIEW_LENGTH = 10;
/** WORD JOINER(U+2060):零宽、禁断行。织入 label 字符间让整枚 chip 成为浏览器眼中
 *  的原子词——换行时整体挪行,从根上消灭「chip 中间被拆成两段、覆盖层只画一半」的
 *  空白块(用户实测)。零宽不改字符度量,textarea 与镜像同规则;发送展开走 ref,
 *  joiner 永不进入消息正文。 */
export declare const CHIP_ATOMIC_JOINER = "\u2060";
export declare function weaveAtomicLabel(label: string): string;
export declare function unweaveAtomicLabel(label: string): string;
/** 多枚 chip 的投影 label 必须互不为前缀(setDraft diff 歧义会吞相邻 occurrence)。
 *  序号前置:首字符即分叉。选段连选相邻内容时前 10 字极易相同,与批注共用这道防线。 */
export declare function dedupeChipLabel(label: string, takenLabels: readonly string[]): string;
/**
 * 模型侧的选段表示。ref 自身携带文稿、块与字符范围，不能依赖 bridge 中稍后会清掉的
 * 单槽 selection，也不能依赖只供复制/持久化的 clipboardText。
 */
export declare function selectionReferenceText(selection: QingSelection, title?: string | null, paragraphOrdinal?: number): string;
/**
 * 解析选段 chip 的文稿名。匹配一律以 activeDoc 自带的 sessionId 为准,绝不信
 * activeEngineSessionId:切稿时后者由 binding-changed 同步更新,activeDoc 却要等
 * 异步 refresh 才换代——窗口期划词会把刚切出的稿名铸进 chip(评测 r4 席3 实证)。
 */
export declare function resolveSelectionTitle(snapshot: {
    activeDoc?: {
        sessionId?: string;
        title?: string | null;
    };
    state?: {
        binding: {
            docs: ReadonlyArray<{
                engineSessionId: string;
                title?: string | null;
            }>;
        };
    };
}, engineSessionId: string): string | undefined;
export interface PmBlockNode {
    attrs?: {
        blockId?: string;
    };
    content?: PmBlockNode[];
}
/** blockId 命中判定:顶层块自身或其任意后代——选中列表项/表格单元格等嵌套块时,
 *  「第 N 段」按包含它的顶层块计序(评测 r5 席3 实证:列表项选段丢段号)。 */
export declare function blockContainsId(block: PmBlockNode, blockId: string): boolean;
/** 底层投影 label 只留引文本体(10 字截断):图标与「选段:」前缀由呈现层覆盖文本
 *  提供,底层越短 chip 越紧凑(用户裁定宽度自适应,右侧不留空)。 */
export declare function selectionReferenceLabel(quote: string): string;
export declare function createSelectionReference(selection: QingSelection, title?: string | null, paragraphOrdinal?: number, takenLabels?: readonly string[]): ReferenceInsert;
/**
 * 选段不是 slash token，使用当前草稿末尾的合法零宽 TokenSpan。事件的同步 true 回值
 * 表示 composer 已通过 phase + draftRev CAS 并实际插入 occurrence。
 */
export declare function insertSelectionReference(actx: ClientContext, selection: QingSelection, title?: string | null, paragraphOrdinal?: number): boolean;
/**
 * occurrence 提交时由 composer 按 source/ref 路由到这里；ref 已经是模型需要看到的
 * 完整锚点引文，serializer 只做恒等展开。
 */
export declare const qingSelectionReferenceSource: InputTriggerSource;
/**
 * chip hover 展示原始内容:宿主 chipLabel 定宽硬裁无 tooltip,这里以委托监听为可见 chip
 * 补 title(浏览器原生悬浮)。chip DOM 顺序与 InputState.occurrences 的 offset 顺序一致,
 * 按序配对;只给本插件来源的 occurrence 写 title(内容=完整锚点引文)。
 * 返回卸载函数,随会话作用域清理。
 */
export declare function installSelectionChipHoverTitles(getOccurrences: () => readonly {
    source: string;
    ref: string;
}[] | undefined): () => void;
//# sourceMappingURL=selectionReference.d.ts.map