import type { Context } from '@deepseek-ai/cordis';
import type { BridgeEvent, EngineStatusSnapshot, QingSelection, SessionBinding } from './contracts.js';
import { type EngineService } from './engine.js';
import type { BindingStore } from './bindings.js';
import { type UpdateCheckProvider } from './updateCheck.js';
import { type TelemetryCapture } from './telemetry.js';
export declare const TURN_SIGNAL_HEARTBEAT_MS = 17000;
export type AgentTurnLeaseState = 'acquired' | 'unsupported' | 'lost' | 'unknown';
export declare const LEASE_UNSUPPORTED_ERROR = "\u5F53\u524D\u5F15\u64CE\u4E0D\u652F\u6301\u7F16\u8F91\u9501\uFF0C\u8BF7\u5347\u7EA7\u5BA2\u6237\u7AEF";
export declare const LEASE_LOST_ERROR = "\u6587\u7A3F\u5DF2\u88AB\u5176\u4ED6\u6301\u6709\u8005\u9501\u5B9A/\u9501\u5DF2\u5931\u6548\uFF0C\u672C\u56DE\u5408\u505C\u6B62\u5199\u4F5C";
export declare const LEASE_BUSY_NATIVE_ERROR = "\u5BA2\u6237\u7AEF\u6B63\u5728\u5904\u7406\uFF0C\u7A0D\u540E\u518D\u8BD5";
export declare const LEASE_AUTH_ERROR = "\u9752\u7B80\u8FDE\u63A5\u6388\u6743\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u5BA2\u6237\u7AEF\uFF1B\u672C\u56DE\u5408\u505C\u6B62\u5199\u4F5C";
export declare const LEASE_UNKNOWN_ERROR = "\u65E0\u6CD5\u786E\u8BA4\u6587\u7A3F\u7F16\u8F91\u9501\u72B6\u6001\uFF0C\u672C\u56DE\u5408\u505C\u6B62\u5199\u4F5C";
/**
 * Agent 回合的多文稿忙碌租约。每个 (DSH 会话,青简文稿) 有独立租约段，
 * 只有 acquired 段才能发写/改/审阅请求。同一文稿的旧段 end 与新段 begin 串行，
 * 不同文稿则并行收口。
 */
export declare class AgentTurnLeaseCoordinator {
    private readonly engine;
    private readonly heartbeatMs;
    private readonly createTurnId;
    private readonly onSegmentOpened?;
    private readonly onTurnClosed?;
    private readonly turns;
    private readonly closingByDocument;
    private nextGeneration;
    constructor(engine: EngineService, heartbeatMs?: number, createTurnId?: () => string, onSegmentOpened?: ((dshSessionId: string, engineSessionId: string, generation: number) => void) | undefined, onTurnClosed?: ((dshSessionId: string, engineSessionIds: string[]) => void) | undefined);
    openTurn(dshSessionId: string, turn: number, pinnedEngineSessionId?: string): Promise<void>;
    pinnedDocument(dshSessionId: string): string | undefined;
    generation(dshSessionId: string, engineSessionId: string): number | undefined;
    state(dshSessionId: string, engineSessionId: string): AgentTurnLeaseState | undefined;
    /** 纯读只领取本回合的文稿 generation，不发 begin；后续写意图复用该段。 */
    observeDocument(dshSessionId: string, engineSessionId: string): number | undefined;
    /** 写意图首次触稿时冷 begin；同文稿并发写共享 beginAttempt。 */
    touchDocument(dshSessionId: string, engineSessionId: string): Promise<string | undefined>;
    /** 审查预申领遇到 BUSY_NATIVE 时，落批注前再做一次完整冷申领。 */
    retryBusyDocument(dshSessionId: string, engineSessionId: string): Promise<string | undefined>;
    endTurn(dshSessionId: string, turn: number): Promise<void>;
    disposeAgent(dshSessionId: string): Promise<void>;
    dispose(): void;
    markAgentError(dshSessionId: string, turn: number): void;
    recordWriteFailure(dshSessionId: string, engineSessionId: string, error: unknown): void;
    private createSegment;
    private beginCold;
    private recoverBegin;
    private startHeartbeat;
    private heartbeat;
    private closeTurn;
    private closeSegment;
    private transition;
    private blockingError;
    private documentKey;
    private signal;
}
export interface BridgeDocStateObserver {
    documentChanged(dshSessionId: string, engineSessionId: string): Promise<void> | void;
    documentDeleted?(dshSessionId: string, engineSessionId: string): Promise<void> | void;
}
export declare class BridgeHub {
    private readonly ctx;
    private readonly engine;
    private readonly bindings;
    private readonly drawioVendorRoot;
    private readonly updateChecker;
    private readonly telemetry?;
    private readonly docStateObserver?;
    private readonly subscribers;
    private readonly selections;
    constructor(ctx: Context, engine: EngineService, bindings: BindingStore, drawioVendorRoot?: string, updateChecker?: UpdateCheckProvider, telemetry?: TelemetryCapture | undefined, docStateObserver?: BridgeDocStateObserver | undefined);
    mount(): void;
    emit(dshSessionId: string, event: BridgeEvent): void;
    clearSelection(dshSessionId: string): void;
    getSelection(dshSessionId: string): QingSelection | undefined;
    private writeEvent;
    emitAll(event: BridgeEvent): void;
    bindingChanged(dshSessionId: string, binding: SessionBinding): void;
    engineStatus(engine: EngineStatusSnapshot): void;
    private route;
    private authorizedEngineSessionId;
    private documentChanged;
    private state;
    private readDoc;
    private openStream;
    private removeSubscriber;
}
export declare function isLoopback(address?: string): boolean;
//# sourceMappingURL=bridge.d.ts.map