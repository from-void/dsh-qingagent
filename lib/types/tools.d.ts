import type { Context } from '@deepseek-ai/cordis';
import type { BindingStore } from './bindings.js';
import { type BridgeHub } from './bridge.js';
import { type EngineService } from './engine.js';
import { type TelemetryCapture } from './telemetry.js';
import { DocStateCache, FreshnessTracker, type DocStateSnapshot } from './docState.js';
import { PendingTitleCoordinator } from './pendingTitle.js';
interface ToolServices {
    ctx: Context;
    engine: EngineService;
    bindings: BindingStore;
    bridge: BridgeHub;
    telemetry?: TelemetryCapture;
    docStates?: DocStateCache;
    freshness?: FreshnessTracker;
    pendingTitles?: PendingTitleCoordinator;
}
interface DraftLengthRequirement {
    min?: number;
    max?: number;
    target?: number;
    targetKind?: 'approx' | 'bare';
}
interface DraftRequirements {
    length?: DraftLengthRequirement;
}
interface DraftRequirementInput {
    requirements?: string;
}
export declare function draftRequirementsOf(input: DraftRequirementInput): DraftRequirements;
export declare function registerTools(services: ToolServices): void;
interface DocStateReadServices {
    engine: EngineService;
    bindings: BindingStore;
}
/** 读取当前聚焦稿的权威摘要；正文只在进程内计算，缓存与注入均不保存正文。 */
export declare function refreshDocState(services: DocStateReadServices, cache: DocStateCache, dshSessionId: string): Promise<DocStateSnapshot | undefined>;
export {};
//# sourceMappingURL=tools.d.ts.map