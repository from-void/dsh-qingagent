import { Service, type Context, type Logger } from '@deepseek-ai/cordis';
import type { EngineStatusSnapshot } from './contracts.js';
import { type QingjianClientInstallation } from './clientInstallation.js';
export interface EngineConfig {
    engineUrl: string;
    engineCommand?: string;
    engineCwd?: string;
    autoLaunch: boolean;
    /** 测试与受控部署可覆盖；默认始终读取当前用户 ~/.qingagent/instance.json。 */
    instancePath?: string;
}
export interface EngineDependencies {
    fetch: typeof globalThis.fetch;
    detectClientInstallation: () => Promise<QingjianClientInstallation>;
    launchDetectedClient: () => Promise<boolean>;
    readInstance: (path: string) => Promise<unknown>;
    isProcessAlive: (pid: number) => boolean;
    launch: (command: string, cwd: string | undefined, logger: Logger) => void;
    wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    now?: () => number;
}
export declare class EngineHttpError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(status: number, body: unknown, message?: string);
}
export declare function isMissingSessionError(error: unknown): boolean;
/** 可注入依赖的连接器让 401 降级、离线和自启动路径可被单测覆盖。 */
export declare class EngineConnection {
    readonly config: EngineConfig;
    private readonly logger;
    private readonly onStatus;
    private readonly dependencies;
    private instance?;
    private launchPromise?;
    private probePromise?;
    private monitorPromise?;
    private instanceInvalidSince?;
    private readonly controller;
    private lastStatus?;
    private clientInstallation;
    constructor(config: EngineConfig, logger: Logger, onStatus?: (status: EngineStatusSnapshot) => void, dependencies?: EngineDependencies);
    dispose(): void;
    /** 插件启动即探测；失败后 5s 起指数退避到 30s，恢复后继续轻量健康检查。 */
    startMonitoring(): void;
    private publish;
    /** 引擎地址以 instance.json 的 port 为权威(单库:连的就是写出该文件的引擎);读不到实例时回退配置值。 */
    private baseUrl;
    private instancePath;
    private reloadInstance;
    private instanceReadFailureStatus;
    status(timeoutMs?: number): Promise<EngineStatusSnapshot>;
    private probe;
    private healthFetch;
    ensureReady(): Promise<EngineStatusSnapshot>;
    /** bridge 只触发这个无参入口，实际路径始终来自 host 检测器自己的缓存。 */
    launchInstalledClient(): Promise<boolean>;
    private launchAndPoll;
    fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
    /**
     * 回合租约信号的 10s 是端到端 deadline：包含 ensureReady/autoLaunch，且超时后
     * 已取消的请求不会在引擎稍后就绪时补发，避免产生“幽灵 begin”。
     */
    fetchTurnSignal<T>(path: string, body: unknown, timeoutMs?: number): Promise<T>;
    fetchAsset(path: string, init?: RequestInit): Promise<Response>;
    private fetchExternalResponse;
    private fetchReadyResponse;
    private monitor;
    private authorizedFetch;
    /** 引擎内部(非 external)只读接口,当前仅导出用;仍带 Bearer(无全局令牌时被忽略,无副作用)。 */
    fetchInternal(path: string, init?: RequestInit): Promise<Response>;
}
export declare class EngineService extends Service {
    readonly connection: EngineConnection;
    constructor(ctx: Context, config: EngineConfig, onStatus?: (status: EngineStatusSnapshot) => void);
    status(): Promise<EngineStatusSnapshot>;
    ensureReady(): Promise<EngineStatusSnapshot>;
    launchInstalledClient(): Promise<boolean>;
    startMonitoring(): void;
    fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
    fetchTurnSignal<T>(path: string, body: unknown, timeoutMs?: number): Promise<T>;
    fetchAsset(path: string, init?: RequestInit): Promise<Response>;
    fetchInternal(path: string, init?: RequestInit): Promise<Response>;
}
export declare class EngineUnavailableError extends Error {
    readonly status: EngineStatusSnapshot;
    constructor(status: EngineStatusSnapshot);
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        qingagentEngine: EngineService;
    }
}
//# sourceMappingURL=engine.d.ts.map