import { type ReactNode } from 'react';
import { type AssetBridgeContext } from '../assetBridge.js';
export declare function AssetBridgeProvider({ context, children, }: {
    context: AssetBridgeContext | null;
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
/** ImageView 仅在 DOM 层换加载地址，PM attrs.src 始终保持青简 schema 允许的内部引用。 */
export declare function useAssetBridgeSource(source: string): string;
//# sourceMappingURL=AssetBridgeProvider.d.ts.map