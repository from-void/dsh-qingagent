export interface RevealCursorInfo {
    id: string;
    lane: number;
}
export interface RevealFrame {
    revealed: string[];
    typed: Array<[string, number]>;
    cursors: RevealCursorInfo[];
}
export declare function revealNewPartLen(before: string, after: string): number;
export declare function planRevealTypewriter(ids: readonly string[], targetOf: (id: string) => number, concurrency: number, charsPerTick: number): RevealFrame[];
export declare const DEFAULT_REVEAL_CONCURRENCY = 5;
export declare const DEFAULT_REVEAL_STEP_DELAY_MS = 20;
export declare const DEFAULT_REVEAL_CHARS_PER_TICK = 1;
export declare const DEFAULT_REVEAL_TAIL_HOLD_MS = 390;
export declare const DEFAULT_REVEAL_TIMEOUT_GRACE_MS = 3000;
/** 动画定时器失活时的总预算；到点后消费侧必须清掉 reveal 请求。 */
export declare function revealHardTimeoutMs(frameCount: number): number;
//# sourceMappingURL=revealTypewriter.d.ts.map