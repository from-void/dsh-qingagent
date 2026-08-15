import { describe, expect, it } from 'vitest'
import {
  assetBridgeUrl,
  decodeAssetBridgeContext,
  encodeAssetBridgeContext,
  readAssetBridgeReference,
} from '../src/assetBridge.js'

const context = { dshSessionId: 'dsh:中文', engineSessionId: 'qing/a:1' }

describe('assetBridge', () => {
  it('上传上下文可逆且不会把引擎 token 放进浏览器 URL', () => {
    const encoded = encodeAssetBridgeContext(context)
    expect(decodeAssetBridgeContext(encoded)).toEqual(context)
    const reference = '/api/v1/files/550e8400-e29b-41d4-a716-446655440000/%E6%8F%92%E5%9B%BE.png'
    const url = assetBridgeUrl(context, reference)
    expect(url).toContain('/qingagent-bridge/assets?')
    expect(url).toContain('dshSessionId=')
    expect(url).not.toContain('token')
    expect(readAssetBridgeReference(url, context)).toBe(reference)
  })
})
