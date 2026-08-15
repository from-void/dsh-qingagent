import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {
  BridgeDocument,
  BridgeEvent,
  BridgeState,
  EngineStatusSnapshot,
  ExternalDoc,
  ExternalDocReplaceRequest,
  ExternalDocReplaceResponse,
  ExternalPmDocReadResponse,
  ExternalReviewCommitPanelRequest,
  ExternalReviewCommitResponse,
  ExternalReviewRenderModelResponse,
  ExternalReviewVerdictRequest,
  ExternalReviewVerdictResponse,
  SessionBinding,
} from './contracts.js'
import { EngineHttpError, type EngineService } from './engine.js'
import type { BindingStore } from './bindings.js'
import { isEngineAssetReference } from './assetBridge.js'

const MAX_ASSET_BYTES = 50 * 1024 * 1024
const MAX_ASSET_JSON_BYTES = 70 * 1024 * 1024

interface Subscriber {
  dshSessionId: string
  response: ServerResponse
  heartbeat: ReturnType<typeof setInterval>
}

export class BridgeHub {
  private readonly subscribers = new Set<Subscriber>()

  constructor(
    private readonly ctx: Context,
    private readonly engine: EngineService,
    private readonly bindings: BindingStore,
  ) {}

  mount(): void {
    const dispose = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/qingagent-bridge',
      handler: (request, response) => this.route(request, response),
    })
    this.ctx.effect(() => () => {
      dispose()
      for (const subscriber of this.subscribers) this.removeSubscriber(subscriber)
    })
  }

  emit(dshSessionId: string, event: BridgeEvent): void {
    const wire = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    for (const subscriber of this.subscribers) {
      if (subscriber.dshSessionId === dshSessionId && !subscriber.response.destroyed) {
        subscriber.response.write(wire)
      }
    }
  }

  emitAll(event: BridgeEvent): void {
    const sessions = new Set([...this.subscribers].map((subscriber) => subscriber.dshSessionId))
    for (const sessionId of sessions) this.emit(sessionId, event)
  }

  bindingChanged(dshSessionId: string, binding: SessionBinding): void {
    this.emit(dshSessionId, { type: 'binding-changed', binding })
  }

  engineStatus(engine: EngineStatusSnapshot): void {
    this.emitAll({ type: 'engine-status', engine })
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLoopback(request.socket.remoteAddress)) {
      writeJson(response, 403, { error: 'QingAgent bridge 仅允许本机访问。' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    try {
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/state') {
        const dshSessionId = requiredQuery(url, 'dshSessionId')
        writeJson(response, 200, await this.state(dshSessionId))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/stream') {
        this.openStream(requiredQuery(url, 'dshSessionId'), request, response)
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/focus') {
        const body = await readJsonBody(request) as { dshSessionId?: unknown; engineSessionId?: unknown }
        if (typeof body.dshSessionId !== 'string' || typeof body.engineSessionId !== 'string') {
          throw new HttpInputError('dshSessionId 与 engineSessionId 均为必填字符串。')
        }
        await this.bindings.setActive(body.dshSessionId, body.engineSessionId)
        this.emit(body.dshSessionId, { type: 'focus-changed', engineSessionId: body.engineSessionId })
        writeJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/doc') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        writeJson(response, 200, await this.readDoc(engineSessionId))
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/assets') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = validateAssetUploadBody(await readJsonBody(request, MAX_ASSET_JSON_BYTES))
        // TODO(dsh-bridge): 青简侧 external assets 端点定稿后同步 multipart/base64 最终契约。
        writeJson(response, 200, await this.engine.fetchJson<unknown>(
          `/sessions/${encodeURIComponent(engineSessionId)}/assets`,
          { method: 'POST', body: JSON.stringify(body) },
        ))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/assets') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const reference = requiredQuery(url, 'ref')
        assertAssetReference(reference, engineSessionId)
        await writeAssetResponse(response, await this.engine.fetchAsset(reference, { method: 'GET' }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/doc-pm') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        writeJson(response, 200, await this.engine.fetchJson<ExternalPmDocReadResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/doc?format=pm`,
        ))
        return
      }
      if (request.method === 'PUT' && url.pathname === '/qingagent-bridge/doc-pm') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = await readJsonBody(request, 8 * 1024 * 1024) as ExternalDocReplaceRequest
        writeJson(response, 200, await this.engine.fetchJson<ExternalDocReplaceResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/doc`,
          { method: 'PUT', body: JSON.stringify(body) },
        ))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/review-render-model') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        writeJson(response, 200, await this.engine.fetchJson<ExternalReviewRenderModelResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/review?format=render-model`,
        ))
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/review-verdicts') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = await readJsonBody(request) as ExternalReviewVerdictRequest
        writeJson(response, 200, await this.engine.fetchJson<ExternalReviewVerdictResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/review/verdicts`,
          { method: 'POST', body: JSON.stringify(body) },
        ))
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/review-commit') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = await readJsonBody(request) as ExternalReviewCommitPanelRequest
        writeJson(response, 200, await this.engine.fetchJson<ExternalReviewCommitResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/review/commit`,
          { method: 'POST', body: JSON.stringify(body) },
        ))
        return
      }
      writeJson(response, 404, { error: 'bridge route not found' })
    } catch (error) {
      if (error instanceof EngineHttpError) {
        writeJson(response, error.status, error.body ?? { error: error.message })
        return
      }
      const status = error instanceof HttpPayloadTooLargeError
        ? 413
        : error instanceof HttpInputError
          ? 400
          : error instanceof HttpNotFoundError
            ? 404
            : 502
      writeJson(response, status, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private authorizedEngineSessionId(url: URL): string {
    const dshSessionId = requiredQuery(url, 'dshSessionId')
    const engineSessionId = requiredQuery(url, 'engineSessionId')
    if (!this.bindings.hasDoc(dshSessionId, engineSessionId)) {
      throw new HttpNotFoundError('文稿不属于当前 DSH 会话。')
    }
    return engineSessionId
  }

  private async state(dshSessionId: string): Promise<BridgeState> {
    const engine = await this.engine.status()
    const binding = this.bindings.getBinding(dshSessionId)
    let activeDoc: ExternalDoc | undefined
    const docs: BridgeDocument[] = []
    if (engine.state === 'online') {
      const loaded = await Promise.all(binding.docs.map(async (bound) => {
        try {
          return { bound, doc: await this.readDoc(bound.engineSessionId) }
        } catch {
          return { bound, doc: undefined }
        }
      }))
      for (const item of loaded) {
        docs.push({
          ...item.bound,
          title: item.doc?.title ?? item.bound.title,
          state: item.doc?.state ?? 'offline',
          docVersion: item.doc?.docVersion ?? null,
          ...(item.doc ? { agentBusy: item.doc.agentBusy } : {}),
        })
        if (item.bound.engineSessionId === binding.activeEngineSessionId) activeDoc = item.doc
      }
    } else {
      docs.push(...binding.docs.map((doc) => ({ ...doc, state: 'offline' as const, docVersion: null })))
    }
    return { dshSessionId, binding, docs, ...(activeDoc ? { activeDoc } : {}), engine }
  }

  private readDoc(engineSessionId: string): Promise<ExternalDoc> {
    return this.engine.fetchJson<ExternalDoc>(`/sessions/${encodeURIComponent(engineSessionId)}/doc?format=qingml`)
  }

  private openStream(dshSessionId: string, request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.write(': qingagent bridge ready\n\n')
    const subscriber: Subscriber = {
      dshSessionId,
      response,
      heartbeat: setInterval(() => response.write(': heartbeat\n\n'), 15_000),
    }
    this.subscribers.add(subscriber)
    request.once('close', () => this.removeSubscriber(subscriber))
  }

  private removeSubscriber(subscriber: Subscriber): void {
    if (!this.subscribers.delete(subscriber)) return
    clearInterval(subscriber.heartbeat)
    if (!subscriber.response.destroyed) subscriber.response.end()
  }
}

class HttpInputError extends Error {}
class HttpNotFoundError extends Error {}
class HttpPayloadTooLargeError extends Error {}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim()
  if (!value) throw new HttpInputError(`缺少查询参数 ${name}。`)
  return value
}

export function isLoopback(address?: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address?.startsWith('::ffff:127.') === true
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function writeAssetResponse(response: ServerResponse, upstream: Response): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': upstream.headers.get('cache-control') ?? 'private, max-age=300',
  }
  for (const name of ['content-length', 'content-disposition', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  response.writeHead(upstream.status, headers)
  response.end(Buffer.from(await upstream.arrayBuffer()))
}

interface AssetUploadBody {
  filename: string
  mimeType: string
  size: number
  dataBase64: string
  purpose?: string
}

function validateAssetUploadBody(value: unknown): AssetUploadBody {
  if (!value || typeof value !== 'object') throw new HttpInputError('资产上传请求必须是 JSON 对象。')
  const body = value as Record<string, unknown>
  const filename = typeof body.filename === 'string' ? body.filename.trim() : ''
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim() : ''
  const size = body.size
  const dataBase64 = body.dataBase64
  if (!filename || filename.length > 512) throw new HttpInputError('资产 filename 无效。')
  if (!mimeType || mimeType.length > 255) throw new HttpInputError('资产 mimeType 无效。')
  if (!Number.isSafeInteger(size) || (size as number) < 0) throw new HttpInputError('资产 size 无效。')
  if ((size as number) > MAX_ASSET_BYTES) throw new HttpPayloadTooLargeError('资产超过 50 MiB 上传上限。')
  if (typeof dataBase64 !== 'string' || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw new HttpInputError('资产 dataBase64 无效。')
  }
  const decodedSize = Buffer.from(dataBase64, 'base64').length
  if (decodedSize !== size) throw new HttpInputError('资产 size 与 dataBase64 长度不一致。')
  const purpose = typeof body.purpose === 'string' && body.purpose.trim() ? body.purpose.trim() : undefined
  return { filename, mimeType, size: size as number, dataBase64, ...(purpose ? { purpose } : {}) }
}

function assertAssetReference(reference: string, engineSessionId: string): void {
  if (!isEngineAssetReference(reference)) throw new HttpInputError('资产引用不是受支持的引擎路径。')
  const pathname = new URL(reference, 'http://qingagent.local').pathname
  const match = pathname.match(/^\/api\/v1\/external\/sessions\/([^/]+)\/assets(?:\/|$)/)
  if (!match) return
  let referencedSessionId: string
  try {
    referencedSessionId = decodeURIComponent(match[1]!)
  } catch {
    throw new HttpInputError('资产引用中的会话 ID 无效。')
  }
  if (referencedSessionId !== engineSessionId) throw new HttpNotFoundError('资产不属于当前青简文稿。')
}

async function readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new HttpPayloadTooLargeError(`请求体超过 ${Math.ceil(maxBytes / 1024)} KiB。`)
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
  } catch {
    throw new HttpInputError('请求体不是合法 JSON。')
  }
}
