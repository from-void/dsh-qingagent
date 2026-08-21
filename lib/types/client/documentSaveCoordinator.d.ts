import type { ExternalDocReplaceRequest, ExternalDocReplaceResponse, PmDoc } from '../contracts.js';
import { type DocWriteBaseline, type KnownDocVersionOrigin } from '@qingweb/pages/workspace/data/docWriteBaseline';
export type DocumentSaveState = {
    kind: 'idle';
} | {
    kind: 'saving';
} | {
    kind: 'saved';
    version: number;
} | {
    kind: 'conflict';
    engineSessionId: string;
    expected: number;
    actual: number;
    message: string;
} | {
    kind: 'blocked';
    code: 'AGENT_BUSY' | 'REVIEW_PENDING';
    message: string;
} | {
    kind: 'error';
    message: string;
    transient: boolean;
};
export interface DocumentSaveCoordinatorOptions {
    send: (engineSessionId: string, request: ExternalDocReplaceRequest) => Promise<ExternalDocReplaceResponse>;
    onCommitted: (engineSessionId: string, doc: PmDoc, response: Extract<ExternalDocReplaceResponse, {
        ok: true;
    }>) => void;
    onStateChange?: (state: DocumentSaveState) => void;
    /** 只有能证明 live editor 与 canonical 语义一致时，已知版本 409 才允许静默重放。 */
    hasLocalDocumentChanges?: (engineSessionId: string) => boolean;
    createMutationId?: () => string;
    schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}
export interface SaveHttpErrorBody {
    code?: string;
    error?: string;
    nextStep?: string;
    ok?: boolean;
    clientMutationId?: string;
    conflict?: {
        expected?: number;
        actual?: number;
    };
    actualContentHash?: string;
}
/**
 * 青简 updateDoc 的 latest-only 单飞协调器。400ms trailing 与首笔 baseline 冻结仍由
 * DocumentSnapshotView 原实现负责；这里接管直写、同 payload 瞬态重试、成功后队列 rebase。
 */
export declare class DocumentSaveCoordinator {
    private readonly options;
    private current;
    private queued;
    private retryTimer;
    private failedTransient;
    private disposed;
    private state;
    private readonly knownVersionsByDocument;
    private readonly createMutationId;
    private readonly schedule;
    private readonly cancelSchedule;
    constructor(options: DocumentSaveCoordinatorOptions);
    getState(): DocumentSaveState;
    getWriteActivity(engineSessionId: string): {
        pendingDocWrite: boolean;
        queuedDocWrite: boolean;
    };
    rememberKnownVersion(engineSessionId: string, baseline: DocWriteBaseline, origin: KnownDocVersionOrigin): void;
    enqueue(engineSessionId: string, doc: PmDoc, baseline: DocWriteBaseline): Promise<void>;
    /** 浏览器 online 事件调用；只重发最后一次耗尽瞬态重试的最新全文。 */
    retryOnline(): void;
    dispose(): void;
    private pending;
    private sendCurrent;
    private handleResponse;
    private handleError;
    private handleConflict;
    private failCurrent;
    private versionLedger;
    private publish;
    private resolveWrite;
    private rejectWrite;
}
//# sourceMappingURL=documentSaveCoordinator.d.ts.map