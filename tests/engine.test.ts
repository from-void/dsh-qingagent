import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@deepseek-ai/cordis'
import { EngineConnection, type EngineDependencies } from '../src/engine.js'

const logger = {
  name: 'test',
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger

function dependencies(overrides: Partial<EngineDependencies>): EngineDependencies {
  return {
    fetch: vi.fn(),
    readInstance: async () => ({ port: 8080, pid: 42, version: 'test', token: 'token', startedAt: '' }),
    isProcessAlive: () => true,
    launch: vi.fn(),
    wait: async () => undefined,
    ...overrides,
  }
}

describe('EngineConnection', () => {
  it('instance 缺失时 status 安全降级为 offline', async () => {
    const fetchMock = vi.fn()
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({ fetch: fetchMock, readInstance: async () => { throw new Error('ENOENT') } }),
    )
    await expect(engine.status()).resolves.toMatchObject({ state: 'offline', message: 'ENOENT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('业务请求遇到 401 时只重读 token 一次', async () => {
    let reads = 0
    const seenTokens: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return Response.json({ version: '1.0.0' })
      seenTokens.push(new Headers(init?.headers).get('Authorization') ?? '')
      return seenTokens.length === 1
        ? Response.json({ error: 'expired' }, { status: 401 })
        : Response.json({ ok: true })
    })
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        fetch: fetchMock,
        readInstance: async () => ({
          port: 8080,
          pid: 42,
          version: 'test',
          token: ++reads === 1 ? 'old-token' : 'new-token',
          startedAt: '',
        }),
      }),
    )

    await expect(engine.fetchJson('/sessions')).resolves.toEqual({ ok: true })
    expect(seenTokens).toEqual(['Bearer old-token', 'Bearer new-token'])
    expect(reads).toBe(2)
  })

  it('health 探测也携带 external Bearer', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer health-token')
      return Response.json({ version: '1.0.0' })
    })
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        fetch: fetchMock,
        readInstance: async () => ({ port: 8080, pid: 42, version: 'test', token: 'health-token', startedAt: '' }),
      }),
    )

    await expect(engine.status()).resolves.toMatchObject({ state: 'online', version: '1.0.0' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
