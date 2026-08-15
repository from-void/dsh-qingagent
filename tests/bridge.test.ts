import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BindingStore } from '../src/bindings.js'
import { BridgeHub } from '../src/bridge.js'
import type { ExternalDoc, SessionBinding } from '../src/contracts.js'
import type { EngineService } from '../src/engine.js'
import { EngineHttpError } from '../src/engine.js'

interface CapturedResponse {
  status?: number
  headers?: Record<string, unknown>
  headersSent: boolean
  destroyed: boolean
  ended: boolean
  body: string
  writes: string[]
  writeHead(status: number, headers?: Record<string, unknown>): CapturedResponse
  write(chunk: unknown): boolean
  end(chunk?: unknown): CapturedResponse
}

function response(): CapturedResponse {
  return {
    headersSent: false,
    destroyed: false,
    ended: false,
    body: '',
    writes: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this },
    write(chunk) { this.writes.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.ended = true; return this },
  }
}

function request(
  method: string,
  url: string,
  remoteAddress = '127.0.0.1',
  body?: unknown,
): IncomingMessage & EventEmitter {
  const req = (body === undefined ? new EventEmitter() : Readable.from([JSON.stringify(body)])) as IncomingMessage & EventEmitter
  Object.assign(req, { method, url, socket: { remoteAddress } })
  return req
}

function fixture(bindingsBySession: Record<string, SessionBinding>) {
  let handler: ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>) | undefined
  const lifecycle: Array<() => void> = []
  const ctx = {
    webServer: {
      register: vi.fn((route: { handler: typeof handler }) => { handler = route.handler; return vi.fn() }),
    },
    effect: (setup: () => () => void) => { lifecycle.push(setup()); return vi.fn() },
  } as unknown as Context
  const engine = {
    status: vi.fn(async () => ({ state: 'online', engineUrl: 'http://127.0.0.1:8080' })),
    fetchJson: vi.fn(async () => ({
      sessionId: 'qing-a', docVersion: 1, state: 'editing', agentBusy: false,
      markdown: '', qingml: '<p>正文</p>', title: '文稿',
    } satisfies ExternalDoc)),
    fetchAsset: vi.fn(async () => new Response('image-bytes', {
      status: 200,
      headers: { 'Content-Type': 'image/png', ETag: 'asset-v1' },
    })),
  } as unknown as EngineService
  const bindings = {
    getBinding: (sessionId: string) => bindingsBySession[sessionId] ?? { docs: [] },
    hasDoc: (sessionId: string, engineSessionId: string) =>
      (bindingsBySession[sessionId]?.docs ?? []).some((doc) => doc.engineSessionId === engineSessionId),
    setActive: vi.fn(),
  } as unknown as BindingStore
  const hub = new BridgeHub(ctx, engine, bindings)
  hub.mount()
  return {
    hub,
    engine,
    handler: handler!,
    dispose: () => { for (const cleanup of lifecycle.reverse()) cleanup() },
  }
}

describe('BridgeHub', () => {
  it('拒绝非回环地址', async () => {
    const { handler, dispose } = fixture({})
    const res = response()
    await handler(request('GET', '/qingagent-bridge/state?dshSessionId=dsh-a', '10.0.0.8'), res as unknown as ServerResponse)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'QingAgent bridge 仅允许本机访问。' })
    dispose()
  })

  it('双会话 SSE 事件严格隔离，连接 close 后释放订阅', async () => {
    const { hub, handler, dispose } = fixture({})
    const reqA = request('GET', '/qingagent-bridge/stream?dshSessionId=dsh-a')
    const reqB = request('GET', '/qingagent-bridge/stream?dshSessionId=dsh-b')
    const resA = response()
    const resB = response()
    await handler(reqA, resA as unknown as ServerResponse)
    await handler(reqB, resB as unknown as ServerResponse)

    hub.emit('dsh-a', { type: 'draft-failed', engineSessionId: 'qing-a', message: '已中止' })

    expect(resA.writes.join('')).toContain('event: draft-failed')
    expect(resB.writes.join('')).not.toContain('event: draft-failed')
    expect((hub as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(2)

    reqA.emit('close')
    expect((hub as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(1)
    expect(resA.ended).toBe(true)
    reqB.emit('close')
    expect((hub as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(0)
    dispose()
  })

  it('跨会话读取 /doc 返回 404，且不访问引擎', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const res = response()
    await handler(
      request('GET', '/qingagent-bridge/doc?dshSessionId=dsh-b&engineSessionId=qing-a'),
      res as unknown as ServerResponse,
    )
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: '文稿不属于当前 DSH 会话。' })
    expect(engine.fetchJson).not.toHaveBeenCalled()
    dispose()
  })

  it('/doc 与 PM 路由共用 authorizedEngineSessionId 授权并代理活跃绑定稿', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const res = response()

    await handler(
      request('GET', '/qingagent-bridge/doc?dshSessionId=dsh-a&engineSessionId=qing-a'),
      res as unknown as ServerResponse,
    )

    expect(res.status).toBe(200)
    expect(engine.fetchJson).toHaveBeenCalledWith('/sessions/qing-a/doc?format=qingml')
    dispose()
  })

  it('PM 文档、审阅渲染模型与 verdict/commit 均按绑定会话代理到 external API', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const fetchJson = vi.mocked(engine.fetchJson)
    fetchJson.mockImplementation(async (path) => ({ path }))

    const pm = response()
    await handler(
      request('GET', '/qingagent-bridge/doc-pm?dshSessionId=dsh-a&engineSessionId=qing-a'),
      pm as unknown as ServerResponse,
    )
    expect(pm.status).toBe(200)
    expect(fetchJson).toHaveBeenCalledWith('/sessions/qing-a/doc?format=pm')

    const review = response()
    await handler(
      request('GET', '/qingagent-bridge/review-render-model?dshSessionId=dsh-a&engineSessionId=qing-a'),
      review as unknown as ServerResponse,
    )
    expect(fetchJson).toHaveBeenCalledWith('/sessions/qing-a/review?format=render-model')

    const verdictBody = { expectedDocVersion: 3, patchId: 'p-1', verdict: 'rejected' }
    const verdict = response()
    await handler(
      request(
        'POST',
        '/qingagent-bridge/review-verdicts?dshSessionId=dsh-a&engineSessionId=qing-a',
        '127.0.0.1',
        verdictBody,
      ),
      verdict as unknown as ServerResponse,
    )
    expect(fetchJson).toHaveBeenCalledWith('/sessions/qing-a/review/verdicts', {
      method: 'POST', body: JSON.stringify(verdictBody),
    })

    const commitBody = { expectedDocVersion: 3, action: 'commit' }
    const commit = response()
    await handler(
      request(
        'POST',
        '/qingagent-bridge/review-commit?dshSessionId=dsh-a&engineSessionId=qing-a',
        '127.0.0.1',
        commitBody,
      ),
      commit as unknown as ServerResponse,
    )
    expect(fetchJson).toHaveBeenCalledWith('/sessions/qing-a/review/commit', {
      method: 'POST', body: JSON.stringify(commitBody),
    })
    dispose()
  })

  it('直写完整透传 frozen baseline，并保留引擎 409 冲突响应', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const write = {
      expectedDocumentSnapshot: 7,
      baseContentHash: 'hash-7',
      clientMutationId: 'mutation-1',
      doc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
    }
    vi.mocked(engine.fetchJson).mockRejectedValueOnce(new EngineHttpError(409, {
      ok: false,
      clientMutationId: 'mutation-1',
      code: 'VERSION_CONFLICT',
      conflict: { expected: 7, actual: 8 },
      actualContentHash: 'hash-8',
    }))
    const res = response()
    await handler(
      request(
        'PUT',
        '/qingagent-bridge/doc-pm?dshSessionId=dsh-a&engineSessionId=qing-a',
        '127.0.0.1',
        write,
      ),
      res as unknown as ServerResponse,
    )

    expect(engine.fetchJson).toHaveBeenCalledWith('/sessions/qing-a/doc', {
      method: 'PUT', body: JSON.stringify(write),
    })
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false, code: 'VERSION_CONFLICT', conflict: { expected: 7, actual: 8 },
    })
    dispose()
  })

  it('资产上传以 base64 JSON 代理到绑定文稿的 external assets 端点', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const body = {
      filename: '插图.png',
      mimeType: 'image/png',
      size: 3,
      dataBase64: 'aW1n',
    }
    vi.mocked(engine.fetchJson).mockResolvedValueOnce({
      fileId: 'asset-1',
      reference: '/api/v1/files/550e8400-e29b-41d4-a716-446655440000/%E6%8F%92%E5%9B%BE.png',
    })
    const res = response()

    await handler(
      request(
        'POST',
        '/qingagent-bridge/assets?dshSessionId=dsh-a&engineSessionId=qing-a',
        '127.0.0.1',
        body,
      ),
      res as unknown as ServerResponse,
    )

    expect(res.status).toBe(200)
    expect(engine.fetchJson).toHaveBeenCalledWith('/sessions/qing-a/assets', {
      method: 'POST', body: JSON.stringify(body),
    })
    expect(JSON.parse(res.body)).toMatchObject({ fileId: 'asset-1' })
    dispose()
  })

  it('资产读取只接受引擎资产路径，并由宿主携 token 取回二进制', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const reference = '/api/v1/files/550e8400-e29b-41d4-a716-446655440000/%E6%8F%92%E5%9B%BE.png'
    const res = response()

    await handler(
      request('GET', `/qingagent-bridge/assets?dshSessionId=dsh-a&engineSessionId=qing-a&ref=${encodeURIComponent(reference)}`),
      res as unknown as ServerResponse,
    )

    expect(engine.fetchAsset).toHaveBeenCalledWith(reference, { method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.headers?.['Content-Type']).toBe('image/png')
    expect(res.body).toBe('image-bytes')

    const rejected = response()
    await handler(
      request('GET', '/qingagent-bridge/assets?dshSessionId=dsh-a&engineSessionId=qing-a&ref=https%3A%2F%2Fevil.example%2Fx'),
      rejected as unknown as ServerResponse,
    )
    expect(rejected.status).toBe(400)
    expect(engine.fetchAsset).toHaveBeenCalledOnce()
    dispose()
  })
})
