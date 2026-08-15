const ASSET_CONTEXT_PREFIX = 'dsh-qingasset:'
export const ASSET_BRIDGE_PATH = '/qingagent-bridge/assets'

export interface AssetBridgeContext {
  dshSessionId: string
  engineSessionId: string
}

export function encodeAssetBridgeContext(context: AssetBridgeContext): string {
  return `${ASSET_CONTEXT_PREFIX}${encodeURIComponent(context.dshSessionId)}:${encodeURIComponent(context.engineSessionId)}`
}

export function decodeAssetBridgeContext(value: string | undefined): AssetBridgeContext | null {
  if (!value?.startsWith(ASSET_CONTEXT_PREFIX)) return null
  const encoded = value.slice(ASSET_CONTEXT_PREFIX.length)
  const separator = encoded.indexOf(':')
  if (separator <= 0 || separator === encoded.length - 1) return null
  try {
    const dshSessionId = decodeURIComponent(encoded.slice(0, separator))
    const engineSessionId = decodeURIComponent(encoded.slice(separator + 1))
    return dshSessionId && engineSessionId ? { dshSessionId, engineSessionId } : null
  } catch {
    return null
  }
}

/** 只把引擎自己签发的同源资产路径交给带 token 的宿主桥。 */
export function isEngineAssetReference(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false
  const rawPath = value.split(/[?#]/, 1)[0]!
  if (/%2f|%5c|%2e%2e/i.test(rawPath) || rawPath.includes('/../') || rawPath.endsWith('/..')) return false
  let pathname: string
  try {
    pathname = new URL(value, 'http://qingagent.local').pathname
  } catch {
    return false
  }
  if (/^\/api\/v1\/files\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[A-Za-z0-9._~%!*'()-]+$/.test(pathname)) return true
  return pathname.startsWith('/api/v1/assets/') ||
    pathname.startsWith('/api/v1/external/assets/') ||
    /^\/api\/v1\/external\/sessions\/[^/]+\/assets(?:\/|$)/.test(pathname)
}

export function assetBridgeUrl(context: AssetBridgeContext, reference: string): string {
  const query = new URLSearchParams({
    dshSessionId: context.dshSessionId,
    engineSessionId: context.engineSessionId,
    ref: reference,
  })
  return `${ASSET_BRIDGE_PATH}?${query.toString()}`
}

export function readAssetBridgeReference(
  value: string,
  expected?: AssetBridgeContext,
): string | null {
  let url: URL
  try {
    url = new URL(value, 'http://qingagent.local')
  } catch {
    return null
  }
  if (url.pathname !== ASSET_BRIDGE_PATH) return null
  if (expected && (
    url.searchParams.get('dshSessionId') !== expected.dshSessionId ||
    url.searchParams.get('engineSessionId') !== expected.engineSessionId
  )) return null
  const reference = url.searchParams.get('ref')
  return reference && isEngineAssetReference(reference) ? reference : null
}
