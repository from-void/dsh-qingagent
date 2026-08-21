import type { BindingStore } from './bindings.js';
import { type EngineService } from './engine.js';
export interface PendingTitle {
    dshSessionId: string;
    engineSessionId: string;
    title: string;
}
export type PendingTitleSettlement = 'none' | 'pending-review' | 'discarded' | 'applied';
/**
 * 同批正文改名的运行时扣留槽。一稿只保留最新标题；标题必须等正文退出审阅态后，
 * 再按生效 H1 对齐补发。回合结束不清理，因为面板裁决通常晚于写作回合。
 */
export declare class PendingTitleCoordinator {
    private readonly engine;
    private readonly bindings;
    private readonly pending;
    private readonly settling;
    private readonly revisions;
    private disposedRevision;
    constructor(engine: EngineService, bindings: BindingStore);
    deferTitle(dshSessionId: string, engineSessionId: string, title: string): void;
    hasPendingTitle(dshSessionId: string, engineSessionId: string): boolean;
    clearDocument(dshSessionId: string, engineSessionId: string): void;
    clearSession(dshSessionId: string): void;
    dispose(): void;
    /** 幂等、可重入：并发刷新复用同一结算 Promise，补发前先取走槽位避免双发。 */
    settlePendingTitle(dshSessionId: string, engineSessionId: string, turnId?: string): Promise<PendingTitleSettlement>;
    private settle;
}
//# sourceMappingURL=pendingTitle.d.ts.map