/**
 * 输入区镜像层 chip 的呈现与交互层(席 K):打标、样式注入、hover 面板、✕ 移除角标。
 * 是 installSelectionChipHoverTitles 的全面升级替代(旧函数由整合层下线,本文件不改它)。
 *
 * 布局零影响铁律:镜像层与 textarea 逐字符对齐,任何占布局/改文字度量的样式都会让
 * 输入框排版错位——注入样式只准用 background / box-shadow(spread 模拟描边)/ color /
 * border-radius;面板与角标都是 document.body 下 position:fixed 的单例浮层,不入镜像层。
 */
/**
 * 宿主 InputState 的结构子集。类型包(@deepseek-ai/* 0.1.0-rc.6)未导出该类型,
 * 字段按 SPEC 真机实测定义;occurrences 按 offset 升序。整合层传入的真实快照
 * 只要结构上含这些字段即可(TypeScript 结构类型)。
 */
export interface InputOccurrence {
    occurrenceId: number;
    source: string;
    ref: string;
    offset: number;
    label: string;
    clipboardText: string;
    invalid?: boolean;
}
export interface InputState {
    draft: string;
    draftRev: number;
    phase?: string;
    occurrences?: InputOccurrence[];
}
export interface ChipPresentationDeps {
    /** 当前会话 InputState 快照;无会话时 undefined */
    getInputState(): InputState | undefined;
    /** 订阅 input state 变化;返回退订函数 */
    subscribeInputState(listener: () => void): () => void;
    /** 整合层会接到席 C 的原语;席 K 只调用 */
    removeOccurrence(occurrenceId: number): boolean;
    replaceOccurrenceRef(occurrenceId: number, newRef: string): boolean;
    onToast(text: string): void;
    /** 面板标题旁展示的文稿名解析(选区 chip 用);拿不到给 undefined */
    getDocTitle?(): string | undefined;
}
/** SVG 图标(用户裁定按 SVG 画):左双引号(两勾)=选段;钢笔=批注。
 *  mask 方案让图标吃 CSS background-color,主题两态都清晰。 */
export declare const QUOTE_ICON_SVG: string;
export declare const PEN_ICON_SVG: string;
/** hover 面板时序:命中后 80ms 显示;离开(chip 与浮层都不含鼠标)350ms 关闭。 */
export declare const CHIP_PANEL_SHOW_DELAY = 80;
export declare const CHIP_PANEL_HIDE_DELAY = 350;
/** 「修改方向」初值只留改法本身:模型爱写「替换为:"…"」一类前缀与包裹引号,
 *  评测口径(与客户端一致)要求初值不含前缀、不带引号包裹;确定性剥除比约束模型可靠。 */
export declare function normalizeDirectionText(text: string): string;
/** 覆盖层文案:批注=✎ 笔图标,选段=“中文弯双引号(用户裁定);内容取 ref 的完整
 *  引文/修改方向,超宽由 CSS ellipsis 兜底(宽度自适应,不预截断)。ref 解析不出时
 *  回落到底层 label(剥 dedupe 圈号)。 */
export declare function chipDisplayText(kind: 'selection' | 'annotation', label: string, ref?: string): string;
/**
 * 安装打标+样式+hover 面板+移除交互;返回卸载函数(移除样式、面板 DOM、监听器)。
 * 可重复安装/卸载:所有副作用都在卸载函数里清干净。
 */
export declare function installChipPresentation(deps: ChipPresentationDeps): () => void;
//# sourceMappingURL=chipPresentation.d.ts.map