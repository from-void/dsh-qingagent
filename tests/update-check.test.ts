import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BindingStore } from '../src/bindings.js'
import { BridgeHub } from '../src/bridge.js'
import type { EngineService } from '../src/engine.js'
import {
  CURRENT_PACKAGE_VERSION,
  isNewer,
  PluginUpdateChecker,
  UPDATE_CHECK_CACHE_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_URL,
  type UpdateCheckProvider,
} from '../src/updateCheck.js'

describe('插件版本更新检测', () => {
  it('按 semver 比较正式版、预发布与构建信息，坏版本静默返回 false', () => {
    expect(isNewer('0.1.20', '0.1.19')).toBe(true)
    expect(isNewer('0.2.0', '0.1.99')).toBe(true)
    expect(isNewer('0.1.5', '0.1.5-1')).toBe(true)
    expect(isNewer('0.1.5-1', '0.1.5')).toBe(false)
    expect(isNewer('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true)
    expect(isNewer('1.0.0-beta', '1.0.0-alpha')).toBe(true)
    expect(isNewer('1.0.0+next', '1.0.0+current')).toBe(false)
    expect(isNewer('0.1.19', '0.1.19')).toBe(false)
    expect(isNewer('latest', '0.1.19')).toBe(false)
    expect(isNewer('0.1.20', 'broken')).toBe(false)
  })

  it('只查 latest 小文档，使用 3s signal，并合并并发与缓存 12h', async () => {
    let now = 1_000
    let resolveFirst!: (response: Response) => void
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve })
    const fetchMock = vi.fn((_: string | URL, _init?: RequestInit) => firstResponse)
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue(Response.json({ version: '0.1.21' }))
    const checker = new PluginUpdateChecker('0.1.19', {
      fetch: fetchMock,
      now: () => now,
    })

    const first = checker.check()
    const concurrent = checker.check()
    expect(first).toBe(concurrent)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(UPDATE_CHECK_URL)
    const requestInit = fetchMock.mock.calls[0]?.[1]
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal)
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(3_000)

    resolveFirst(Response.json({ version: '0.1.20' }))
    await expect(first).resolves.toEqual({ current: '0.1.19', latest: '0.1.20', hasUpdate: true })
    await expect(concurrent).resolves.toEqual({ current: '0.1.19', latest: '0.1.20', hasUpdate: true })

    now += UPDATE_CHECK_CACHE_MS - 1
    await checker.check()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 1
    await expect(checker.check()).resolves.toEqual({ current: '0.1.19', latest: '0.1.21', hasUpdate: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(UPDATE_CHECK_CACHE_MS).toBe(12 * 60 * 60 * 1_000)
  })

  it('网络失败、非 200、解析失败与坏载荷都降级为无更新并进入负缓存', async () => {
    const fetches = [
      vi.fn(async () => { throw new Error('offline') }),
      vi.fn(async () => new Response('unavailable', { status: 503 })),
      vi.fn(async () => new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } })),
      vi.fn(async () => Response.json({ version: 19 })),
      vi.fn(async () => Response.json({ version: 'not-semver' })),
    ]

    for (const fetchMock of fetches) {
      const checker = new PluginUpdateChecker('0.1.19', {
        fetch: fetchMock,
        now: () => 1_000,
      })
      await expect(checker.check()).resolves.toEqual({
        current: '0.1.19',
        latest: '0.1.19',
        hasUpdate: false,
      })
      await checker.check()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('bridge 端点返回固定载荷，checker 意外拒绝时也不返回 5xx', async () => {
    const available = endpointFixture({
      check: vi.fn(async () => ({ current: '0.1.19', latest: '0.1.20', hasUpdate: true })),
    })
    const response = capturedResponse()
    await available.handler(
      request('/qingagent-bridge/update-check'),
      response as unknown as ServerResponse,
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ current: '0.1.19', latest: '0.1.20', hasUpdate: true })
    available.dispose()

    const unavailable = endpointFixture({ check: vi.fn(async () => { throw new Error('unexpected') }) })
    const degraded = capturedResponse()
    await unavailable.handler(
      request('/qingagent-bridge/update-check'),
      degraded as unknown as ServerResponse,
    )
    expect(degraded.status).toBe(200)
    expect(JSON.parse(degraded.body)).toEqual({
      current: CURRENT_PACKAGE_VERSION,
      latest: CURRENT_PACKAGE_VERSION,
      hasUpdate: false,
    })
    unavailable.dispose()
  })
})

function endpointFixture(updateChecker: UpdateCheckProvider) {
  let handler: ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>) | undefined
  const cleanups: Array<() => void> = []
  const ctx = {
    webServer: {
      register: vi.fn((route: { path: string; handler: typeof handler }) => {
        if (route.path === '/qingagent-bridge') handler = route.handler
        return vi.fn()
      }),
    },
    effect: (setup: () => () => void) => { cleanups.push(setup()); return vi.fn() },
  } as unknown as Context
  const hub = new BridgeHub(
    ctx,
    {} as EngineService,
    {} as BindingStore,
    undefined,
    updateChecker,
  )
  hub.mount()
  return {
    handler: handler!,
    dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() },
  }
}

function request(url: string): IncomingMessage & EventEmitter {
  return Object.assign(new EventEmitter(), {
    method: 'GET',
    url,
    socket: { remoteAddress: '127.0.0.1' },
  }) as IncomingMessage & EventEmitter
}

function capturedResponse() {
  return {
    status: 0,
    body: '',
    destroyed: false,
    headersSent: false,
    writeHead(status: number) { this.status = status; this.headersSent = true; return this },
    write() { return true },
    end(chunk?: unknown) { if (chunk !== undefined) this.body += String(chunk); return this },
  }
}
