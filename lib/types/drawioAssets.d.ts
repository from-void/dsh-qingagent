import type { IncomingMessage, ServerResponse } from 'node:http';
export declare const DRAWIO_ROUTE_PATH = "/drawio";
/**
 * 青简产品仓已经把 draw.io v31.0.2 裁成离线、同源运行时；插件只通过宿主桥只读发布，
 * 不再引入第二份 vendor，也不会回退到 embed.diagrams.net。
 * 资产位置:QING_ROOT(或 QINGAGENT_DRAWIO_ROOT 直指资产目录)可覆盖,
 * 默认取 vendor/qingagent submodule(相对本模块 lib/ 上一级)。
 */
export declare const DEFAULT_DRAWIO_VENDOR_ROOT: string;
export declare const DRAWIO_DOCUMENT_CSP: string;
export declare function serveDrawioAsset(request: IncomingMessage, response: ServerResponse, vendorRoot?: string): Promise<void>;
//# sourceMappingURL=drawioAssets.d.ts.map