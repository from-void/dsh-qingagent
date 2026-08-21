import type { BridgeTelemetryEventName, PanelOpenSource, TelemetryEventMap } from '../telemetry.js';
export declare function markPanelOpenSource(sessionId: string, source: PanelOpenSource): void;
export declare function beginPanelMount(sessionId: string): PanelOpenSource;
export declare function endPanelMount(sessionId: string): void;
export declare function panelPatchesBucket(value: number): '1' | '2-5' | '6-20' | '>20';
/** 面板只把严格的白名单事件送到同源 bridge；外网请求始终由 node 侧完成。 */
export declare function capturePanelTelemetry<K extends BridgeTelemetryEventName>(event: K, properties: TelemetryEventMap[K]): void;
//# sourceMappingURL=telemetry.d.ts.map