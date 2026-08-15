import {
  assetBridgeUrl,
  decodeAssetBridgeContext,
  engineAssetFileId,
  isEngineAssetReference,
  type AssetBridgeContext,
} from '../../assetBridge.js'

export interface UploadedAsset {
  fileId: string
  filename: string
  mimeType: string
  size: number
  /** 引擎 canonical PM 使用的内部引用。 */
  reference: string
  /** 浏览器显示时走的无 token 桥地址。 */
  bridgeUrl: string
}

export interface UploadAssetOptions {
  onProgress?: (progress: number | null) => void
  purpose?: string
  sessionId?: string
}

export const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
const LARGE_MATERIAL_NOTICE_BYTES = 1024 * 1024

export type UploadAssetErrorCode =
  | 'file_too_large'
  | 'network'
  | 'upload_failed'
  | 'invalid_response'
  | 'material_format_mismatch'
  | 'material_unreadable'
  | 'material_unsupported'

export class UploadAssetError extends Error {
  constructor(
    public readonly code: UploadAssetErrorCode,
    public readonly file: File,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'UploadAssetError'
  }
}

export function largeMaterialUploadNotice(
  assets: readonly Pick<UploadedAsset, 'filename' | 'size'>[],
): string | null {
  const largeAssets = assets.filter((asset) => asset.size > LARGE_MATERIAL_NOTICE_BYTES)
  if (largeAssets.length === 0) return null
  const subject = largeAssets.length === 1
    ? `素材“${largeAssets[0]!.filename}”`
    : `${largeAssets.length} 个素材`
  return `${subject}较大；对话中会按相关片段参考。如需逐字处理，请拆分素材后分段发送。`
}

export function uploadFileSizeError(file: Pick<File, 'size'>): Error | null {
  return file.size > DEFAULT_UPLOAD_MAX_BYTES
    ? new Error(fileTooLargeMessage(DEFAULT_UPLOAD_MAX_BYTES))
    : null
}

export function uploadFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof UploadAssetError) return error.message
  const message = error instanceof Error ? error.message : ''
  return message.startsWith('文件过大（上传上限 ') ? message : fallback
}

export async function uploadAssetFile(file: File, options: UploadAssetOptions = {}): Promise<UploadedAsset> {
  const sizeError = uploadFileSizeError(file)
  if (sizeError) throw sizeError
  const context = decodeAssetBridgeContext(options.sessionId)
  if (!context) {
    throw new UploadAssetError('upload_failed', file, '当前文稿未绑定青简资产会话', false)
  }
  const dataBase64 = await readFileBase64(file)
  return uploadBase64(file, dataBase64, context, options)
}

export function uploadedAssetUrl(asset: Pick<UploadedAsset, 'fileId' | 'filename'> & Partial<UploadedAsset>): string {
  if (asset.reference) return asset.reference
  return `/api/v1/files/${encodeURIComponent(asset.fileId)}/${encodeURIComponent(asset.filename)}`
}

function uploadBase64(
  file: File,
  dataBase64: string,
  context: AssetBridgeContext,
  options: UploadAssetOptions,
): Promise<UploadedAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const query = new URLSearchParams({
      dshSessionId: context.dshSessionId,
      engineSessionId: context.engineSessionId,
    })
    xhr.open('POST', `/qingagent-bridge/assets?${query.toString()}`)
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        options.onProgress?.(null)
        return
      }
      options.onProgress?.(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))))
    }
    xhr.onerror = () => reject(new UploadAssetError('network', file, '文件上传失败，请重试', true))
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new UploadAssetError(
          xhr.status === 413 ? 'file_too_large' : 'upload_failed',
          file,
          xhr.status === 413 ? fileTooLargeMessage(DEFAULT_UPLOAD_MAX_BYTES) : '文件上传失败，请重试',
          xhr.status >= 500,
        ))
        return
      }
      try {
        resolve(normalizeUploadResponse(JSON.parse(xhr.responseText) as unknown, file, context))
      } catch (error) {
        reject(error instanceof UploadAssetError
          ? error
          : new UploadAssetError('invalid_response', file, '文件已上传，但回执无法确认，请重试', true))
      }
    }
    xhr.send(JSON.stringify({
      filename: file.name,
      ...(file.type ? { mimeType: file.type } : {}),
      base64: dataBase64,
    }))
  })
}

function normalizeUploadResponse(value: unknown, file: File, context: AssetBridgeContext): UploadedAsset {
  const body = objectRecord(value)
  const fileId = stringValue(body?.fileId)
  const filename = stringValue(body?.filename)
  const mimeType = stringValue(body?.mimeType)
  const size = numberValue(body?.size)
  const reference = stringValue(body?.src)
  if (
    !fileId || !filename || !mimeType || size === undefined || !reference ||
    !isEngineAssetReference(reference) || engineAssetFileId(reference) !== fileId
  ) {
    throw new UploadAssetError('invalid_response', file, '文件已上传，但回执无法确认，请重试', true)
  }
  return {
    fileId,
    filename,
    mimeType,
    size,
    reference,
    bridgeUrl: assetBridgeUrl(context, reference),
  }
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new UploadAssetError('network', file, '文件读取失败，请重试', true))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new UploadAssetError('network', file, '文件读取失败，请重试', true))
        return
      }
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

function formatUploadLimit(maxBytes: number): string {
  const mib = maxBytes / (1024 * 1024)
  return mib >= 1 ? `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB` : `${Math.ceil(maxBytes / 1024)} KiB`
}

function fileTooLargeMessage(maxBytes: number): string {
  return `文件过大（上传上限 ${formatUploadLimit(maxBytes)}）`
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
