import type { PmDoc } from '@qingagent/pm-schema';
export interface DocumentRevealFrame {
    pmDoc: PmDoc;
    charEnters: Array<{
        from: number;
        to: number;
    }>;
}
export interface DocumentRevealProgress {
    nonce: number;
    index: number;
}
/**
 * 渲染期同步选帧：新 reveal 请求尚未来得及进入 effect 时必须直接返回首帧，
 * 不能暂退到完整文档，否则浏览器会闪出终稿。
 */
export declare function documentRevealFrameForRender(frames: readonly DocumentRevealFrame[], requestNonce: number, progress: DocumentRevealProgress | null): DocumentRevealFrame | null;
/** 把一次落库的完整 PM 文档规划成纸面逐字帧，不参与网络或定时。 */
export declare function planDocumentReveal(document: PmDoc, concurrency?: number, charsPerTick?: number): DocumentRevealFrame[];
//# sourceMappingURL=documentReveal.d.ts.map