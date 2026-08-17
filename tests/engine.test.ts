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
    detectClientInstallation: async () => ({ installed: false }),
    launchDetectedClient: async () => false,
    readInstance: async () => instance(),
    isProcessAlive: () => true,
    launch: vi.fn(),
    wait: async () => undefined,
    ...overrides,
  }
}

function instance(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    port: 8080,
    pid: 42,
    version: '1.0.0',
    attachProtocolVersion: 1,
    token: 'token',
    startedAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  }
}

describe('EngineConnection', () => {
  it.each([
    [409, { error: '还有修改未裁决', code: 'REVIEW_PENDING', nextStep: '先处理审阅' }, '审阅待处理：还有修改未裁决（先处理审阅）'],
    [409, { error: '还有修改未裁决', code: 'REVIEW_PENDING' }, '审阅待处理：还有修改未裁决（待审稿归属不明,先向用户说明其存在;仅在用户明确授权后才可 qing_review_commit,不得代为处置）'],
    [409, { error: 'AGENT_BUSY', code: 'AGENT_BUSY', nextStep: '稍后再试' }, '青简正在处理其他任务（稍后再试）'],
    [409, { error: '版本已变化', code: 'VERSION_CONFLICT', nextStep: '重新读取文稿' }, '文稿版本冲突：版本已变化（重新读取文稿）'],
    [404, { error: 'missing' }, '青简会话或资源不存在：missing（请用 qing_list_docs 重新确认文稿引用，不要重试原引用）'],
    [429, { error: '队列已满', code: 'RATE_LIMITED', nextStep: '降低频率' }, '请求过于频繁：队列已满（降低频率）'],
  ])('EngineHttpError 将 HTTP %s 结构化错误转换为可行动消息', (status, body, message) => {
    expect(new EngineHttpError(status, body).message).toBe(message)
  })

  it('instance 撕裂读首击时处于 starting 宽限态', async () => {
    const fetchMock = vi.fn()
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        fetch: fetchMock,
        readInstance: async () => { throw new SyntaxError('Unexpected end of JSON input') },
      }),
    )

    await expect(engine.status()).resolves.toMatchObject({
      state: 'starting',
      reason: 'instance-invalid',
      message: '青简实例信息正在写入，等待完成…',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('instance 持续残缺超过宽限期后升级为 handshake-failed', async () => {
    let now = 1_000
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        now: () => now,
        readInstance: async () => { throw new SyntaxError('instance.json 字段无效') },
      }),
    )

    await expect(engine.status()).resolves.toMatchObject({
      state: 'starting', reason: 'instance-invalid',
    })
    now += 9_999
    await expect(engine.status()).resolves.toMatchObject({
      state: 'starting', reason: 'instance-invalid',
    })
    now += 2
    await expect(engine.status()).resolves.toMatchObject({
      state: 'handshake-failed',
      reason: 'instance-invalid',
      message: expect.stringContaining('损坏'),
    })
  })

  it('instance 宽限内自愈后再次残缺会重新计时', async () => {
    let now = 1_000
    const readInstance = vi.fn()
      .mockRejectedValueOnce(new SyntaxError('Unexpected end of JSON input'))
      .mockResolvedValueOnce(instance())
      .mockRejectedValueOnce(new SyntaxError('Unexpected end of JSON input'))
    const fetchMock = vi.fn(async () => Response.json({ version: '1.0.0', attachProtocolVersion: 1 }))
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({ fetch: fetchMock, now: () => now, readInstance }),
    )

    await expect(engine.status()).resolves.toMatchObject({
      state: 'starting', reason: 'instance-invalid',
    })
    now += 5_000
    await expect(engine.status()).resolves.toMatchObject({ state: 'online' })
    now += 5_001
    await expect(engine.status()).resolves.toMatchObject({
      state: 'starting', reason: 'instance-invalid',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('instance 缺失不受宽限影响，status 立即降级为 offline', async () => {
    const fetchMock = vi.fn()
    let now = 1_000
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        fetch: fetchMock,
        now: () => now,
        readInstance: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      }),
    )
    await expect(engine.status()).resolves.toMatchObject({
      state: 'offline', reason: 'instance-missing', message: expect.stringContaining('未找到'),
    })
    now += 10_001
    await expect(engine.status()).resolves.toMatchObject({
      state: 'offline', reason: 'instance-missing', message: expect.stringContaining('未找到'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('每次状态探测都刷新客户端安装结果和 host 路径并写入状态快照', async () => {
    const detectClientInstallation = vi.fn()
      .mockResolvedValueOnce({ installed: true, executablePath: 'D:\\Qing\\qingagent.exe' })
      .mockResolvedValueOnce({ installed: false })
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:49123', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        detectClientInstallation,
        readInstance: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      }),
    )

    await expect(engine.status()).resolves.toMatchObject({
      state: 'offline',
      clientInstalled: true,
      clientExecutablePath: 'D:\\Qing\\qingagent.exe',
    })
    const second = await engine.status()
    expect(second).toMatchObject({ state: 'offline', clientInstalled: false })
    expect(second).not.toHaveProperty('clientExecutablePath')
    expect(detectClientInstallation).toHaveBeenCalledTimes(2)
  })

  it('安全启动只调用 host 的无参检测启动器，未检测到路径时拒绝启动', async () => {
    const launchDetectedClient = vi.fn(async () => true)
    const installed = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:49123', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        detectClientInstallation: async () => ({
          installed: true,
          executablePath: 'D:\\Qing\\qingagent.exe',
        }),
        launchDetectedClient,
        readInstance: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      }),
    )
    await installed.status()
    await expect(installed.launchInstalledClient()).resolves.toBe(true)
    expect(launchDetectedClient).toHaveBeenCalledWith()

    const missing = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:49123', autoLaunch: false },
      logger,
      undefined,
      dependencies({ launchDetectedClient }),
    )
    await expect(missing.launchInstalledClient()).resolves.toBe(false)
    expect(launchDetectedClient).toHaveBeenCalledTimes(1)
  })

  it('业务请求遇到 401 时只重读 token 一次', async () => {
    let reads = 0
    const seenTokens: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return Response.json({ version: '1.0.0', attachProtocolVersion: 1 })
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
        readInstance: async () => instance({ token: ++reads === 1 ? 'old-token' : 'new-token' }),
      }),
    )

    await expect(engine.fetchJson('/sessions')).resolves.toEqual({ ok: true })
    expect(seenTokens).toEqual(['Bearer old-token', 'Bearer new-token'])
    expect(reads).toBe(2)
  })

  it('health 探测也携带 external Bearer', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer health-token')
      return Response.json({ version: '1.0.0', attachProtocolVersion: 1 })
    })
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        fetch: fetchMock,
        readInstance: async () => instance({ token: 'health-token' }),
      }),
    )

    await expect(engine.status()).resolves.toMatchObject({ state: 'online', version: '1.0.0' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('引擎地址以 instance.json 的 port 为权威(客户端内置引擎端口随机,配置默认 8080 不再劫持)', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('http://127.0.0.1:21823/api/v1/external/health')
      return Response.json({ version: '1.0.0', attachProtocolVersion: 1 })
    })
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        fetch: fetchMock,
        readInstance: async () => instance({ port: 21823 }),
      }),
    )

    await expect(engine.status()).resolves.toMatchObject({
      state: 'online',
      engineUrl: 'http://127.0.0.1:21823',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('资产读取访问 external 会话端点并只在宿主侧附加 Bearer', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/external/health')) {
        return Response.json({ version: '1.0.0', attachProtocolVersion: 1 })
      }
      seen.push({ url, authorization: new Headers(init?.headers).get('Authorization') })
      return new Response('asset-bytes', { headers: { 'Content-Type': 'image/png' } })
    })
    const engine = new EngineConnection(
      { engineUrl: 'http://127.0.0.1:8080', autoLaunch: false },
      logger,
      undefined,
      dependencies({
        fetch: fetchMock,
        readInstance: async () => instance({ token: 'asset-token' }),
      }),
    )

    const response = await engine.fetchAsset('/sessions/qing-a/assets/550e8400-e29b-41d4-a716-446655440000')
    await expect(response.text()).resolves.toBe('asset-bytes')
    expect(seen).toEqual([{
      url: 'http://127.0.0.1:8080/api/v1/external/sessions/qing-a/assets/550e8400-e29b-41d4-a716-446655440000',
      authorization: 'Bearer asset-token',
    }])
  })
})
