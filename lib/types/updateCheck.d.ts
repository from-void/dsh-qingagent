export declare const UPDATE_CHECK_URL = "https://registry.npmjs.org/dsh-qingagent/latest";
export declare const UPDATE_CHECK_TIMEOUT_MS = 3000;
export declare const UPDATE_CHECK_CACHE_MS: number;
export interface UpdateCheckResult {
    current: string;
    latest: string;
    hasUpdate: boolean;
}
export interface UpdateCheckDependencies {
    fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
    now: () => number;
}
export interface UpdateCheckProvider {
    check: () => Promise<UpdateCheckResult>;
}
export declare const CURRENT_PACKAGE_VERSION: string;
/**
 * registry 查询只影响提示，不得阻塞或打扰青简主链路：失败、超时、非 200 与坏载荷
 * 一律折叠为“当前即最新”。正负结果共用 12h 缓存，并合并并发挂载产生的查询。
 */
export declare class PluginUpdateChecker implements UpdateCheckProvider {
    private readonly currentVersion;
    private readonly dependencies;
    private readonly cacheMs;
    private cached?;
    private pending?;
    constructor(currentVersion?: string, dependencies?: UpdateCheckDependencies, cacheMs?: number);
    check(): Promise<UpdateCheckResult>;
    private checkUncached;
    private noUpdate;
}
/** latest 严格新于 current 时返回 true；任一输入不是最小 semver 形态则静默返回 false。 */
export declare function isNewer(latest: string, current: string): boolean;
//# sourceMappingURL=updateCheck.d.ts.map