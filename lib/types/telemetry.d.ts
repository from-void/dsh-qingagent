import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import { type Domain, type DomainGlobal } from '@deepseek-ai/dsh-storage-domain';
import type { EngineStatusReason, EngineStatusSnapshot } from './contracts.js';
export declare const TelemetryDomainSpec: {
    name: string;
    version: number;
    global: {
        schema: z.ZodObject<{
            deviceId: z.ZodString;
            firstRunAt: z.ZodString;
            hasWritten: z.ZodBoolean;
            hasEdited: z.ZodBoolean;
            hasReviewed: z.ZodBoolean;
        }, z.core.$strip>;
        initial: {
            deviceId: string;
            firstRunAt: string;
            hasWritten: boolean;
            hasEdited: boolean;
            hasReviewed: boolean;
        };
    };
    tables: {};
};
export type TelemetryDomain = Domain<typeof TelemetryDomainSpec>;
export type TelemetryProfile = ReturnType<TelemetryDomain['global']['get']>;
type TelemetryProfileStore = Pick<DomainGlobal<TelemetryProfile>, 'get' | 'set'>;
export type WordsBucket = '0' | '1-200' | '201-500' | '501-1000' | '1001-3000' | '>3000';
export type BlocksBucket = '0' | '1-5' | '6-20' | '21-50' | '>50';
export type CountBucket = '0' | '1' | '2-5' | '6-20' | '>20';
export type PatchesBucket = '1' | '2-5' | '6-20' | '>20';
export type AgeDaysBucket = '0' | '1-7' | '8-30' | '30+';
export type EngineStateBucket = 'ok' | 'absent' | 'unreachable';
export type EditRejectedReason = 'multi_hit_no_nth' | 'zero_hit' | 'line_drift' | 'review_pending' | 'other';
export type PanelOpenSource = 'tool_card' | 'manual' | 'auto';
export type ReviewAction = 'commit' | 'discard';
export type FeedbackTarget = 'bug' | 'feature';
export interface TelemetryEventMap {
    plugin_activated: {
        first_run: boolean;
        age_days: AgeDaysBucket;
        engine_state: EngineStateBucket;
        has_written: boolean;
        has_edited: boolean;
        has_reviewed: boolean;
    };
    panel_opened: {
        source: PanelOpenSource;
    };
    draft_created: {
        words_bucket: WordsBucket;
        blocks_bucket: BlocksBucket;
    };
    draft_edited: {
        ops_bucket: CountBucket;
        op_kinds: string[];
        outcome: 'committed' | 'review';
    };
    edit_rejected: {
        reason: EditRejectedReason;
    };
    review_settled: {
        action: ReviewAction;
        patches_bucket: PatchesBucket;
        retried: boolean;
    };
    engine_unreachable: {
        code: EngineStatusReason;
    };
    update_clicked: {
        from_version: string;
        to_version: string;
    };
    feedback_clicked: {
        target: FeedbackTarget;
    };
    doc_missing_shown: Record<string, never>;
}
export type TelemetryEventName = keyof TelemetryEventMap;
export type BridgeTelemetryEventName = Extract<TelemetryEventName, 'panel_opened' | 'review_settled' | 'update_clicked' | 'feedback_clicked' | 'doc_missing_shown'>;
export type BridgeTelemetryEvent = {
    [K in BridgeTelemetryEventName]: {
        event: K;
        properties: TelemetryEventMap[K];
    };
}[BridgeTelemetryEventName];
interface TelemetryConfig {
    enabled: boolean;
    endpoint: string;
    websiteId: string;
}
export interface TelemetryDependencies {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    uuid?: () => string;
    locale?: () => string;
    openProfile?: () => Promise<TelemetryProfileStore>;
    endpoint?: string;
    websiteId?: string;
    pluginVersion?: string;
    dshVersion?: string;
    timeoutMs?: number;
}
export interface TelemetryCapture {
    capture<K extends TelemetryEventName>(event: K, properties: TelemetryEventMap[K]): Promise<void>;
}
export interface TelemetryEnvelope {
    type: 'event';
    payload: {
        website: string;
        hostname: 'dsh-qingagent';
        language: string;
        url: '/panel';
        name: TelemetryEventName;
        data: Record<string, unknown>;
    };
}
export declare class Telemetry implements TelemetryCapture {
    private readonly config;
    private readonly fetcher;
    private readonly now;
    private readonly uuid;
    private readonly locale;
    private readonly openProfile;
    private readonly pluginVersion;
    private readonly dshVersion?;
    private readonly timeoutMs;
    private readyPromise?;
    private reachability?;
    constructor(dependencies?: TelemetryDependencies);
    get enabled(): boolean;
    init(): Promise<void>;
    capture<K extends TelemetryEventName>(event: K, properties: TelemetryEventMap[K]): Promise<void>;
    capturePluginActivated(engine: EngineStatusSnapshot): Promise<void>;
    trackEngineStatus(status: EngineStatusSnapshot): void;
    private ready;
    private initializeProfile;
    private markMilestone;
}
export declare function createTelemetry(ctx: Context, dependencies?: Omit<TelemetryDependencies, 'openProfile'>): Telemetry;
export declare function resolveTelemetryConfig(dependencies?: Pick<TelemetryDependencies, 'env' | 'endpoint' | 'websiteId'>): TelemetryConfig;
export declare function buildTelemetryEnvelope<K extends TelemetryEventName>(websiteId: string, locale: string, event: K, data: TelemetryEventMap[K] & Record<string, unknown>): TelemetryEnvelope;
export declare function wordsBucket(value: number): WordsBucket;
export declare function blocksBucket(value: number): BlocksBucket;
export declare function countBucket(value: number): CountBucket;
export declare function patchesBucket(value: number): PatchesBucket;
export declare function ageDaysBucket(firstRunAt: string, now?: number): AgeDaysBucket;
export declare function engineStateBucket(status: EngineStatusSnapshot): EngineStateBucket;
export declare function editRejectedReason(error: unknown): EditRejectedReason;
export declare function validateBridgeTelemetryEvent(value: unknown): BridgeTelemetryEvent;
/**
 * UA 必须是**纯净的浏览器串**:umami 用 isbot 过滤,UA 里只要出现自定义产品标记
 * (如 `dsh-qingagent/0.1.20`)就会被判成机器人**静默丢弃**——而且照样回 200 `{"ok":true}`,
 * 调用方完全无感。真机实测:同一份 body,干净 UA 进库、带自定义 token 不进库。
 * 插件版本已在事件属性 `pluginVersion` 里,不要再塞进 UA。
 */
export declare function browserStyleUserAgent(): string;
export declare function safeTelemetryErrorMessage(reason: unknown): string;
export {};
//# sourceMappingURL=telemetry.d.ts.map