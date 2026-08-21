import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { BindingStore } from './bindings.js';
import { type BridgeDocStateObserver } from './bridge.js';
import { EngineService } from './engine.js';
import { PendingTitleCoordinator } from './pendingTitle.js';
import { DocStateCache } from './docState.js';
export declare const name = "dsh-qingagent";
export declare const inject: string[];
export interface Config {
    engineUrl?: string;
    engineCommand?: string;
    engineCwd?: string;
    autoLaunch?: boolean;
    /** 批次 1 保留配置位；工作区导出将在后续批次实现。 */
    workspaceProjection?: boolean;
}
export declare const Config: z<Config>;
export declare function createBridgeDocStateObserver(ctx: Context, engine: EngineService, bindings: BindingStore, docStates: DocStateCache, pendingTitles?: PendingTitleCoordinator): BridgeDocStateObserver;
export declare function apply(ctx: Context, config?: Config): Promise<void>;
export { BindingStore, BindingDomainSpec } from './bindings.js';
export { BridgeHub, isLoopback } from './bridge.js';
export { EngineConnection, EngineHttpError, EngineService } from './engine.js';
export { Telemetry, TelemetryDomainSpec, ageDaysBucket, blocksBucket, browserStyleUserAgent, countBucket, createTelemetry, editRejectedReason, engineStateBucket, patchesBucket, safeTelemetryErrorMessage, validateBridgeTelemetryEvent, wordsBucket, } from './telemetry.js';
export { detectQingjianClientInstallation, launchDetectedQingjianClient, QingjianClientInstallationDetector, } from './clientInstallation.js';
export { CURRENT_PACKAGE_VERSION, isNewer, PluginUpdateChecker, } from './updateCheck.js';
export { QINGJIAN_DOWNLOAD_URL, qingjianUnavailableMessage } from './onboarding.js';
export { completeTopLevelBlocks, outlineOf } from './qingml.js';
export { PendingTitleCoordinator } from './pendingTitle.js';
export { compileQingmlDocument } from './qingmlCompile.js';
export { selectionSystemPrompt } from './selection.js';
export { AgentIndex, DOC_STATE_STALE_LINE, DocStateCache, FRESH_DRAFT_REQUIRED_ERROR, FreshnessTracker, docStateLine, formatDocState, } from './docState.js';
export type * from './contracts.js';
//# sourceMappingURL=index.d.ts.map