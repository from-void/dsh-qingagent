export interface UploadedAsset {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    /** 引擎 canonical PM 使用的内部引用。 */
    reference: string;
    /** 浏览器显示时走的无 token 桥地址。 */
    bridgeUrl: string;
}
export interface UploadAssetOptions {
    onProgress?: (progress: number | null) => void;
    purpose?: string;
    sessionId?: string;
}
export declare const DEFAULT_UPLOAD_MAX_BYTES: number;
export type UploadAssetErrorCode = 'file_too_large' | 'network' | 'upload_failed' | 'invalid_response' | 'material_format_mismatch' | 'material_unreadable' | 'material_unsupported';
export declare class UploadAssetError extends Error {
    readonly code: UploadAssetErrorCode;
    readonly file: File;
    readonly retryable: boolean;
    constructor(code: UploadAssetErrorCode, file: File, message: string, retryable: boolean);
}
export declare function largeMaterialUploadNotice(assets: readonly Pick<UploadedAsset, 'filename' | 'size'>[]): string | null;
export declare function uploadFileSizeError(file: Pick<File, 'size'>): Error | null;
export declare function uploadFailureMessage(error: unknown, fallback: string): string;
export declare function uploadAssetFile(file: File, options?: UploadAssetOptions): Promise<UploadedAsset>;
export declare function uploadedAssetUrl(asset: Pick<UploadedAsset, 'fileId' | 'filename'> & Partial<UploadedAsset>): string;
//# sourceMappingURL=uploadAsset.d.ts.map