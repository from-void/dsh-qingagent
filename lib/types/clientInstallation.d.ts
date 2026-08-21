export interface QingjianClientInstallation {
    installed: boolean;
    /** Windows 为 qingagent.exe，macOS 为匹配 bundle id 的 .app 路径。 */
    executablePath?: string;
}
export interface InstallationDependencies {
    execFileOutput: (file: string, args: string[], timeoutMs: number) => Promise<Buffer>;
    homedir: () => string;
    now: () => number;
    platform: () => NodeJS.Platform;
    spawnDetached: (file: string, args: string[]) => void;
    stat: (path: string) => Promise<unknown>;
}
/**
 * 对系统注册锚点做短缓存，避免 EngineConnection 的 5 秒轮询反复启动 reg.exe/mdfind。
 * 依赖可注入，测试不会访问真实注册表、Spotlight 或文件系统。
 */
export declare class QingjianClientInstallationDetector {
    private readonly dependencies;
    private readonly cacheMs;
    private cached?;
    private pending?;
    constructor(dependencies?: InstallationDependencies, cacheMs?: number);
    detect(): Promise<QingjianClientInstallation>;
    /** 只启动本检测器解析并 stat 过的路径，不接受来自 bridge 客户端的路径。 */
    launchDetected(): Promise<boolean>;
    private detectUncached;
    private detectWindows;
    private detectMacOS;
    private tryExec;
    private exists;
}
/** 兼容 reg.exe 的 UTF-16LE、UTF-8 与中文 Windows 常见 GB18030 输出。 */
export declare function decodeProcessOutput(output: Buffer): string;
export declare function parseWindowsProtocolOutput(output: string): string | undefined;
export declare function parseWindowsUninstallOutput(output: string): string[];
export declare function parseMdfindOutput(output: string): string[];
export declare function detectQingjianClientInstallation(): Promise<QingjianClientInstallation>;
export declare function launchDetectedQingjianClient(): Promise<boolean>;
//# sourceMappingURL=clientInstallation.d.ts.map