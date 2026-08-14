import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {
  BridgeDocument,
  BridgeEvent,
  BridgeState,
  EngineStatusSnapshot,
  ExternalDoc,
  SessionBinding,
} from './contracts.js'
import type { EngineService } from './engine.js'
import type { BindingStore } from './bindings.js'

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
        const dshSessionId = requiredQuery(url, 'dshSessionId')
        const engineSessionId = requiredQuery(url, 'engineSessionId')
        if (!this.bindings.hasDoc(dshSessionId, engineSessionId)) {
          writeJson(response, 404, { error: '文稿不属于当前 DSH 会话。' })
          return
        }
        writeJson(response, 200, await this.readDoc(engineSessionId))
        return
      }
      writeJson(response, 404, { error: 'bridge route not found' })
    } catch (error) {
      const status = error instanceof HttpInputError ? 400 : 502
      writeJson(response, status, { error: error instanceof Error ? error.message : String(error) })
    }
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new HttpInputError('请求体超过 64 KiB。')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
  } catch {
    throw new HttpInputError('请求体不是合法 JSON。')
  }
}
