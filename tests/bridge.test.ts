import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BindingStore } from '../src/bindings.js'
import { BridgeHub } from '../src/bridge.js'
import type { ExternalDoc, SessionBinding } from '../src/contracts.js'
import type { EngineService } from '../src/engine.js'

interface CapturedResponse {
  status?: number
  headersSent: boolean
  destroyed: boolean
  ended: boolean
  body: string
  writes: string[]
  writeHead(status: number): CapturedResponse
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
    writeHead(status) { this.status = status; this.headersSent = true; return this },
    write(chunk) { this.writes.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.ended = true; return this },
  }
}

function request(method: string, url: string, remoteAddress = '127.0.0.1'): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as IncomingMessage & EventEmitter
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
})
