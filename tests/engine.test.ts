import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@deepseek-ai/cordis'
import { EngineConnection, EngineHttpError, type EngineDependencies } from '../src/engine.js'

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
  it.each([
    [409, { error: '还有修改未裁决', code: 'REVIEW_PENDING', nextStep: '先处理审阅' }, '审阅待处理：还有修改未裁决（先处理审阅）'],
    [409, { error: 'AGENT_BUSY', code: 'AGENT_BUSY', nextStep: '稍后再试' }, '青简正在处理其他任务（稍后再试）'],
    [409, { error: '版本已变化', code: 'VERSION_CONFLICT', nextStep: '重新读取文稿' }, '文稿版本冲突：版本已变化（重新读取文稿）'],
    [404, { error: 'missing' }, '青简会话或资源不存在：missing（请用 qing_list_docs 重新确认文稿引用，不要重试原引用）'],
    [429, { error: '队列已满', code: 'RATE_LIMITED', nextStep: '降低频率' }, '请求过于频繁：队列已满（降低频率）'],
  ])('EngineHttpError 将 HTTP %s 结构化错误转换为可行动消息', (status, body, message) => {
    expect(new EngineHttpError(status, body).message).toBe(message)
  })

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

  it('资产读取访问引擎内部路径并只在宿主侧附加 Bearer', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/external/health')) return Response.json({ version: '1.0.0' })
      seen.push({ url, authorization: new Headers(init?.headers).get('Authorization') })
      return new Response('asset-bytes', { headers: { 'Content-Type': 'image/png' } })
    })
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        fetch: fetchMock,
        readInstance: async () => ({
          port: 8080, pid: 42, version: 'test', token: 'asset-token', startedAt: '',
        }),
      }),
    )

    const response = await engine.fetchAsset('/api/v1/files/asset/image.png')
    await expect(response.text()).resolves.toBe('asset-bytes')
    expect(seen).toEqual([{
      url: 'http://127.0.0.1:8080/api/v1/files/asset/image.png',
      authorization: 'Bearer asset-token',
    }])
  })
})
