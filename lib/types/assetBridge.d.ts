export declare const ASSET_BRIDGE_PATH = "/qingagent-bridge/assets";
export interface AssetBridgeContext {
    dshSessionId: string;
    engineSessionId: string;
}
export declare function encodeAssetBridgeContext(context: AssetBridgeContext): string;
export declare function decodeAssetBridgeContext(value: string | undefined): AssetBridgeContext | null;
/** 只把 external 上传回执签发的 canonical src 交给带 token 的宿主桥。 */
export declare function isEngineAssetReference(value: string): boolean;
export declare function engineAssetFileId(reference: string): string | null;
export declare function assetBridgeUrl(context: AssetBridgeContext, reference: string): string;
export declare function readAssetBridgeReference(value: string, expected?: AssetBridgeContext): string | null;
//# sourceMappingURL=assetBridge.d.ts.map