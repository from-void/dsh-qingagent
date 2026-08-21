import type { BridgeState, ExternalDoc, ExternalDocReplaceRequest, ExternalDocReplaceResponse, ExternalErrorResponse, ExternalPmDocReadResponse, ExternalReviewCommitPanelRequest, ExternalReviewCommitResponse, ExternalReviewRenderModelResponse, ExternalReviewVerdictRequest, ExternalReviewVerdictResponse, PmDoc, QingSelection, QingSelectionAnchor } from '../contracts.js';
import type { DocumentSaveState } from './documentSaveCoordinator.js';
export interface QingClientSnapshot {
    state?: BridgeState;
    activeEngineSessionId?: string;
    activeDoc?: ExternalDoc;
    blocks: number;
    words: number;
    bindingCount: number;
    reviewCount?: number;
    /** 直写落库后的一次性纸面逐字入场请求。 */
    revealRequest?: {
        engineSessionId: string;
        docVersion: number;
        nonce: number;
    };
    panelEngineSessionId?: string;
    panelDoc?: ExternalPmDocReadResponse;
    reviewModel?: ExternalReviewRenderModelResponse;
    panelLoading?: boolean;
    /** external 明确确认不存在的文稿集合；按文稿 ID 持久排除，读回成功时逐篇恢复。 */
    docMissing?: {
        engineSessionIds: string[];
    };
    /** 「重载」等显式放弃本地内容的操作递增它,面板据此强制重挂编辑器。 */
    panelReloadNonce?: number;
    saveState?: DocumentSaveState;
    /** 冲突态按文稿分槽持久保存;saveState 单槽只承载瞬态,避免另一稿保存成功把冲突顶掉(评测 t14)。 */
    conflicts?: Record<string, {
        expected: number;
        actual: number;
        message: string;
    }>;
    /** 冲突稿本地内容快照(切走前抓取,切回恢复;评测 P11「切换往返丢内容落 v0 空白」,K3 定案)。 */
    conflictStash?: Record<string, PmDoc>;
    selection?: QingSelection;
    /** 仅当 selection 来自用户显式 setSelection 时为 true;SSE 回声与 loadState 重放为 false。
     *  插入门只放行 fresh 选段——否则陈旧单槽经 loadState 回灌会让已移除的 chip 复活。 */
    selectionFresh?: boolean;
    error?: string;
}
export type CurrentReviewState = 'pending' | 'settled' | 'unknown';
/**
 * 工具卡只把 meta 冻结的 patchIds 与当前 render-model 精确对表；文稿相同但批次
 * 不同不能推断旧卡结局。逐条表态但尚未 commit 的 accepted/rejected 仍属待审。
 */
export declare function currentReviewStateFor(snapshot: QingClientSnapshot, engineSessionId: string | undefined, patchIds: readonly string[] | undefined): CurrentReviewState;
/** 面板描述当前文稿而非历史工具事件，因此继续按当前 PM/render-model 判定。 */
export declare function currentPanelReviewStateFor(snapshot: QingClientSnapshot, engineSessionId: string | undefined): CurrentReviewState;
export interface QingLibraryDoc {
    engineSessionId: string;
    title: string;
    state: string;
    updatedAt: string;
}
export interface PanelRefreshGuard {
    beforeApply(engineSessionId: string, panelDoc: ExternalPmDocReadResponse): Promise<boolean>;
    afterApply?(engineSessionId: string, panelDoc: ExternalPmDocReadResponse): void;
}
export declare const PANEL_BUSY_REFRESH_DELAY_MS = 15000;
export declare class QingClientStore {
    private readonly entries;
    constructor();
    getSnapshot(sessionId: string): QingClientSnapshot;
    subscribe(sessionId: string, listener: () => void): () => void;
    hasPanelContent(sessionId: string): boolean;
    /** × 关闭:dsh 详情列显隐由插槽注册决定,layout.closeDetails 对它无效;这里置关闭位驱动注销。 */
    closePanel(sessionId: string): void;
    /** P11:切走冲突/脏稿前抓本地内容快照,切回时优先恢复而非重拉。 */
    stashConflictDoc(sessionId: string, engineSessionId: string, doc: PmDoc): void;
    /** 「查看」等显式重开入口。 */
    reopenPanel(sessionId: string): void;
    finishReveal(sessionId: string, nonce: number): void;
    retain(sessionId: string, openDetails?: () => void): () => void;
    registerPanelRefreshGuard(sessionId: string, guard: PanelRefreshGuard): () => void;
    focus(sessionId: string, engineSessionId: string, options?: {
        adopt?: boolean;
        title?: string;
    }): Promise<void>;
    /** 导出当前文稿:走桥接代理引擎导出接口,返回文件字节与降级说明。 */
    exportDoc(sessionId: string, engineSessionId: string, format: string): Promise<{
        blob: Blob;
        degradations?: string;
    }>;
    /** 青简文库:引擎最近更新的文稿列表(含其他会话的),下拉「最近文稿」分组用。 */
    loadLibrary(sessionId: string, limit?: number): Promise<QingLibraryDoc[]>;
    setSelection(sessionId: string, engineSessionId: string, quote: string, anchor: QingSelectionAnchor): Promise<QingSelection>;
    /** 插入门消费 fresh:成功插入后调用,防同一显式选段被后续状态发布重复插入。 */
    consumeSelectionFresh(sessionId: string): void;
    clearSelection(sessionId: string): Promise<void>;
    refreshDoc(sessionId: string, engineSessionId: string): Promise<ExternalDoc>;
    refreshPanel(sessionId: string, engineSessionId: string, options?: {
        bypassGuard?: boolean;
    }): Promise<void>;
    replaceDocument(sessionId: string, engineSessionId: string, request: ExternalDocReplaceRequest): Promise<ExternalDocReplaceResponse>;
    reviewVerdict(sessionId: string, engineSessionId: string, request: ExternalReviewVerdictRequest): Promise<ExternalReviewVerdictResponse>;
    reviewCommit(sessionId: string, engineSessionId: string, request: ExternalReviewCommitPanelRequest): Promise<ExternalReviewCommitResponse>;
    setSaveState(sessionId: string, state: DocumentSaveState): void;
    /** 青简同款「重载」出路:用户明确同意放弃本地未保存内容,拉服务器权威版本继续编辑。
     *  绕过刷新守卫(守卫的职责是保护本地未保存内容,重载正是对它的显式放弃),
     *  并递增 reloadNonce 强制编辑器重挂,确保纸面内容切到服务器版本。 */
    resolveConflictByReload(sessionId: string, engineSessionId: string): Promise<void>;
    applySavedDocument(sessionId: string, engineSessionId: string, doc: PmDoc, response: Extract<ExternalDocReplaceResponse, {
        ok: true;
    }>): void;
    applyReviewVerdict(sessionId: string, engineSessionId: string, patchIds: readonly string[], verdict: 'accepted' | 'rejected'): void;
    ignoreAnnotation(sessionId: string, engineSessionId: string, expectedDocVersion: number, annotationId: string): Promise<void>;
    applyReviewCommit(sessionId: string, engineSessionId: string, docVersion: number): void;
    private entry;
    private connect;
    private handleEvent;
    private loadState;
    private applyCommittedPanelDoc;
    private update;
    private noteTurnActivity;
    private syncBusyFallback;
    private clearBusyFallback;
    private open;
}
export declare class BridgeHttpError extends Error {
    readonly status: number;
    readonly body: ExternalErrorResponse | Record<string, unknown>;
    constructor(status: number, body: ExternalErrorResponse | Record<string, unknown>);
}
export declare const qingClientStore: QingClientStore;
//# sourceMappingURL=store.d.ts.map