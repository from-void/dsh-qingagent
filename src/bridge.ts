import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {
  BridgeDocument,
  BridgeEvent,
  BridgeState,
  EngineStatusSnapshot,
  ExternalAssetUploadJsonRequest,
  ExternalAssetUploadResponse,
  ExternalAnnotationIgnoreRequest,
  ExternalAnnotationIgnoreResponse,
  ExternalDoc,
  ExternalDocReplaceRequest,
  ExternalDocReplaceResponse,
  ExternalPmDocReadResponse,
  ExternalReviewCommitPanelRequest,
  ExternalReviewCommitResponse,
  ExternalReviewRenderModelResponse,
  ExternalReviewVerdictRequest,
  ExternalReviewVerdictResponse,
  QingSelection,
  SessionBinding,
} from './contracts.js'
import { EngineHttpError, type EngineService } from './engine.js'
import type { BindingStore } from './bindings.js'
import { engineAssetFileId } from './assetBridge.js'
import {
  DEFAULT_DRAWIO_VENDOR_ROOT,
  DRAWIO_ROUTE_PATH,
  serveDrawioAsset,
} from './drawioAssets.js'

const MAX_ASSET_BYTES = 50 * 1024 * 1024
const MAX_ASSET_JSON_BYTES = 70 * 1024 * 1024

interface Subscriber {
  dshSessionId: string
  response: ServerResponse
  heartbeat: ReturnType<typeof setInterval>
}

export class BridgeHub {
  private readonly subscribers = new Set<Subscriber>()
  private readonly selections = new Map<string, QingSelection>()

  constructor(
    private readonly ctx: Context,
    private readonly engine: EngineService,
    private readonly bindings: BindingStore,
    private readonly drawioVendorRoot = DEFAULT_DRAWIO_VENDOR_ROOT,
  ) {}

  mount(): void {
    const disposeDrawio = this.ctx.webServer.register({
      kind: 'prefix',
      path: DRAWIO_ROUTE_PATH,
      handler: (request, response) => {
        if (!isLoopback(request.socket.remoteAddress)) {
          writeJson(response, 403, { error: 'drawio 静态资产仅允许本机访问。' })
          return
        }
        return serveDrawioAsset(request, response, this.drawioVendorRoot)
      },
    })
    const disposeBridge = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/qingagent-bridge',
      handler: (request, response) => this.route(request, response),
    })
    this.ctx.effect(() => () => {
      disposeDrawio()
      disposeBridge()
      for (const subscriber of this.subscribers) this.removeSubscriber(subscriber)
      this.selections.clear()
    })
  }

  emit(dshSessionId: string, event: BridgeEvent): void {
    if (event.type === 'doc-committed') this.clearSelection(dshSessionId)
    this.writeEvent(dshSessionId, event)
  }

  clearSelection(dshSessionId: string): void {
    if (!this.selections.delete(dshSessionId)) return
    this.writeEvent(dshSessionId, { type: 'selection-changed', selection: null })
  }

  getSelection(dshSessionId: string): QingSelection | undefined {
    return this.selections.get(dshSessionId)
  }

  private writeEvent(dshSessionId: string, event: BridgeEvent): void {
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
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/launch-client') {
        if (url.search) throw new HttpInputError('启动青简端点不接受路径或其他查询参数。')
        const launched = await this.engine.launchInstalledClient()
        if (!launched) {
          writeJson(response, 409, { error: '未找到可安全启动的青简安装路径。' })
          return
        }
        writeJson(response, 202, { launched: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/state') {
        const dshSessionId = requiredQuery(url, 'dshSessionId')
        writeJson(response, 200, await this.state(dshSessionId))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/stream') {
        this.openStream(requiredQuery(url, 'dshSessionId'), request, response)
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/selection') {
        const selection = this.selections.get(requiredQuery(url, 'dshSessionId')) ?? null
        writeJson(response, 200, { selection })
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/selection') {
        const selection = validateSelection(await readJsonBody(request))
        if (!this.bindings.hasDoc(selection.dshSessionId, selection.engineSessionId)) {
          throw new HttpNotFoundError('文稿不属于当前 DSH 会话。')
        }
        this.selections.set(selection.dshSessionId, selection)
        this.emit(selection.dshSessionId, { type: 'selection-changed', selection })
        writeJson(response, 200, { selection })
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/qingagent-bridge/selection') {
        const dshSessionId = requiredQuery(url, 'dshSessionId')
        this.clearSelection(dshSessionId)
        writeJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/focus') {
        const body = await readJsonBody(request) as {
          dshSessionId?: unknown
          engineSessionId?: unknown
          adopt?: unknown
          title?: unknown
        }
        if (typeof body.dshSessionId !== 'string' || typeof body.engineSessionId !== 'string') {
          throw new HttpInputError('dshSessionId 与 engineSessionId 均为必填字符串。')
        }
        if (body.adopt === true && !this.bindings.hasDoc(body.dshSessionId, body.engineSessionId)) {
          // 收养前确认引擎里确有这篇文稿,避免把不存在的 id 写进绑定表。
          await this.engine.fetchJson(
            `/sessions/${encodeURIComponent(body.engineSessionId)}/doc?lines=1`,
          )
          await this.bindings.adoptDoc(
            body.dshSessionId,
            body.engineSessionId,
            typeof body.title === 'string' ? body.title : '未命名文稿',
          )
        } else {
          await this.bindings.setActive(body.dshSessionId, body.engineSessionId)
        }
        this.emit(body.dshSessionId, { type: 'focus-changed', engineSessionId: body.engineSessionId })
        writeJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/export') {
        // 导出:代理引擎内部导出接口,流式回传;格式白名单与青简 ExportMenu 一致。
        const engineSessionId = this.authorizedEngineSessionId(url)
        const format = url.searchParams.get('format') ?? ''
        if (!['pdf', 'docx', 'html', 'markdown', 'txt'].includes(format)) {
          throw new HttpInputError('不支持的导出格式。')
        }
        // 空文稿无可导出内容,短路 409(评测 P18;客户端已把 409 映射为「还没有可导出的内容」)。
        const docState = await this.readDoc(engineSessionId)
        if (docState.state === 'empty') {
          writeJson(response, 409, { error: '还没有可导出的内容' })
          return
        }
        const upstream = await this.engine.fetchInternal(
          `/export/${encodeURIComponent(engineSessionId)}?format=${encodeURIComponent(format)}`,
        )
        const headers: Record<string, string> = {
          'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
        }
        const degradations = upstream.headers.get('X-Qingagent-Export-Degradations')
        if (degradations) headers['X-Qingagent-Export-Degradations'] = degradations
        response.writeHead(upstream.status, headers)
        const body = upstream.body
        if (!body) { response.end(); return }
        const reader = body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          response.write(value)
        }
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/library') {
        // 青简文库:引擎最近更新的文稿(含其他会话的),供下拉「最近文稿」分组;token 不出主机端。
        requiredQuery(url, 'dshSessionId')
        const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '25', 10)
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 25
        const listing = await this.engine.fetchJson<{
          sessions: Array<{ id: string; title: string | null; state: string; updatedAt: string }>
        }>(`/sessions?limit=${limit}`)
        writeJson(response, 200, {
          library: listing.sessions.map((session) => ({
            engineSessionId: session.id,
            title: session.title ?? '未命名文稿',
            state: session.state,
            updatedAt: session.updatedAt,
          })),
        })
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
        writeJson(response, 200, await this.engine.fetchJson<ExternalAssetUploadResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/assets`,
          { method: 'POST', body: JSON.stringify(body) },
        ))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/assets') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const reference = requiredQuery(url, 'ref')
        const fileId = engineAssetFileId(reference)
        if (!fileId) throw new HttpInputError('资产引用不是 external 上传回执签发的路径。')
        await writeAssetResponse(response, await this.engine.fetchAsset(
          `/sessions/${encodeURIComponent(engineSessionId)}/assets/${encodeURIComponent(fileId)}`,
          { method: 'GET' },
        ))
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
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/review-annotations-ignore') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = await readJsonBody(request) as ExternalAnnotationIgnoreRequest
        writeJson(response, 200, await this.engine.fetchJson<ExternalAnnotationIgnoreResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/review/annotations/ignore`,
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
    const selection = this.selections.get(dshSessionId)
    return {
      dshSessionId,
      binding,
      docs,
      ...(activeDoc ? { activeDoc } : {}),
      ...(selection ? { selection } : {}),
      engine,
    }
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

function validateSelection(value: unknown): QingSelection {
  if (!value || typeof value !== 'object') throw new HttpInputError('选段请求必须是 JSON 对象。')
  const body = value as Record<string, unknown>
  const anchor = body.anchor && typeof body.anchor === 'object'
    ? body.anchor as Record<string, unknown>
    : undefined
  const dshSessionId = typeof body.dshSessionId === 'string' ? body.dshSessionId.trim() : ''
  const engineSessionId = typeof body.engineSessionId === 'string' ? body.engineSessionId.trim() : ''
  const quote = typeof body.quote === 'string' ? body.quote.trim() : ''
  const blockId = typeof anchor?.blockId === 'string' ? anchor.blockId.trim() : ''
  const from = anchor?.from
  const to = anchor?.to
  if (!dshSessionId || !engineSessionId || !quote || !blockId) {
    throw new HttpInputError('dshSessionId、engineSessionId、quote 与 anchor.blockId 均为必填。')
  }
  if (quote.length > 100_000) throw new HttpInputError('选段引文过长。')
  if (blockId.length > 512) throw new HttpInputError('anchor.blockId 过长。')
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || (from as number) < 0 || (to as number) <= (from as number)) {
    throw new HttpInputError('anchor.from/to 必须是有效的 PM 选区范围。')
  }
  return {
    dshSessionId,
    engineSessionId,
    quote,
    anchor: { blockId, from: from as number, to: to as number },
  }
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

function validateAssetUploadBody(value: unknown): ExternalAssetUploadJsonRequest {
  if (!value || typeof value !== 'object') throw new HttpInputError('资产上传请求必须是 JSON 对象。')
  const body = value as Record<string, unknown>
  const filename = typeof body.filename === 'string' ? body.filename : ''
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim() : undefined
  const base64 = body.base64
  if (!filename || filename.length > 512) throw new HttpInputError('资产 filename 无效。')
  if (body.mimeType !== undefined && (!mimeType || mimeType.length > 255)) {
    throw new HttpInputError('资产 mimeType 无效。')
  }
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new HttpInputError('资产 base64 无效。')
  }
  const unpadded = base64.replace(/=+$/, '')
  const normalized = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  const decoded = Buffer.from(normalized, 'base64')
  if (!unpadded || decoded.toString('base64').replace(/=+$/, '') !== unpadded) {
    throw new HttpInputError('资产 base64 无效。')
  }
  const decodedSize = decoded.length
  if (decodedSize === 0) throw new HttpInputError('资产内容不能为空。')
  if (decodedSize > MAX_ASSET_BYTES) throw new HttpPayloadTooLargeError('资产超过 50 MiB 上传上限。')
  return { filename, ...(mimeType ? { mimeType } : {}), base64 }
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
