import { randomInt } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '@deepseek-ai/cordis'
import { EngineConnection, type EngineDependencies } from '../src/engine.js'
import type { EngineStatusSnapshot } from '../src/contracts.js'

const logger = {
  name: 'onboarding-test',
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger

type HealthMode = 'online' | 'unauthorized' | 'protocol-mismatch' | 'version-mismatch' | 'invalid-json' | 'connection-refused'

describe('青简启动探测与自愈状态机', () => {
  let fakeHome: string
  let instancePath: string
  let port: number
  let healthMode: HealthMode
  let server: Server | undefined
  let localFetch: typeof globalThis.fetch

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'dsh-qingagent-home-'))
    instancePath = join(fakeHome, '.qingagent', 'instance.json')
    await mkdir(join(fakeHome, '.qingagent'))
    healthMode = 'online'
    const candidate = createServer((request, response) => {
      const result = mockHealthResponse(request.url ?? '', request.headers.authorization)
      void result.text().then((body) => {
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
        response.end(body)
      })
    })
    try {
      port = await new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        candidate.once('error', onError)
        candidate.listen(0, '127.0.0.1', () => {
          candidate.off('error', onError)
          const address = candidate.address()
          if (!address || typeof address === 'string') reject(new Error('mock server 未取得随机端口'))
          else resolve(address.port)
        })
      })
      server = candidate
      localFetch = globalThis.fetch
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      // Codex 文件沙箱禁止 listen(2)；保留同一 HTTP wire mock 与随机 endpoint，避免触网。
      port = randomInt(49_152, 65_536)
      server = undefined
      localFetch = inProcessLocalFetch
    }
    expect([3_080, 8_080]).not.toContain(port)
  })

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
    await rm(fakeHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function instance(attachProtocolVersion = 1) {
    return {
      schemaVersion: 2,
      port,
      pid: process.pid,
      version: '1.2.3',
      attachProtocolVersion,
      token: 'temporary-test-token',
      startedAt: '2026-08-16T00:00:00.000Z',
    }
  }

  async function writeInstance(attachProtocolVersion = 1): Promise<void> {
    await writeFile(instancePath, JSON.stringify(instance(attachProtocolVersion)), 'utf8')
  }

  function dependencies(wait: EngineDependencies['wait'] = defaultWait): EngineDependencies {
    return {
      fetch: localFetch,
      readInstance: async (path) => JSON.parse(await readFile(path, 'utf8')) as unknown,
      isProcessAlive: (pid) => pid === process.pid,
      launch: vi.fn(),
      wait,
    }
  }

  const inProcessLocalFetch: typeof globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe(`http://127.0.0.1:${port}/api/v1/external/health`)
    return mockHealthResponse('/api/v1/external/health', new Headers(init?.headers).get('Authorization') ?? undefined)
  }

  function mockHealthResponse(path: string, authorization?: string): Response {
    if (path !== '/api/v1/external/health') return new Response(null, { status: 404 })
    if (healthMode === 'connection-refused') {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }
    if (healthMode === 'unauthorized' || authorization !== 'Bearer temporary-test-token') {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (healthMode === 'invalid-json') {
      return new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return Response.json({
      version: healthMode === 'version-mismatch' ? '9.9.9' : '1.2.3',
      attachProtocolVersion: healthMode === 'protocol-mismatch' ? 2 : 1,
    })
  }

  function connection(
    onStatus: (status: EngineStatusSnapshot) => void = () => undefined,
    deps = dependencies(),
    autoLaunch = false,
  ): EngineConnection {
    return new EngineConnection({
      engineUrl: `http://127.0.0.1:${port}`,
      autoLaunch,
      ...(autoLaunch ? { engineCommand: 'mock-qingjian-start' } : {}),
      instancePath,
    }, logger, onStatus, deps)
  }

  it('覆盖未安装、已连接、握手失败各态，并可从失败恢复', async () => {
    const seen: EngineStatusSnapshot[] = []
    const engine = connection((status) => seen.push(status))

    await expect(engine.status()).resolves.toMatchObject({
      state: 'offline', reason: 'instance-missing',
    })

    await writeFile(instancePath, '{not-json', 'utf8')
    await expect(engine.status()).resolves.toMatchObject({
      state: 'handshake-failed', reason: 'instance-invalid', message: expect.stringContaining('损坏'),
    })

    await writeInstance()
    healthMode = 'unauthorized'
    await expect(engine.status()).resolves.toMatchObject({
      state: 'handshake-failed', reason: 'unauthorized', message: expect.stringContaining('HTTP 401'),
    })

    healthMode = 'protocol-mismatch'
    await expect(engine.status()).resolves.toMatchObject({
      state: 'handshake-failed', reason: 'protocol-incompatible', message: expect.stringContaining('attachProtocolVersion'),
    })

    healthMode = 'version-mismatch'
    await expect(engine.status()).resolves.toMatchObject({
      state: 'handshake-failed', reason: 'version-mismatch', message: expect.stringContaining('版本不符'),
    })

    healthMode = 'invalid-json'
    await expect(engine.status()).resolves.toMatchObject({
      state: 'handshake-failed', reason: 'health-response-invalid', message: expect.stringContaining('响应格式无效'),
    })

    healthMode = 'online'
    await expect(engine.status()).resolves.toMatchObject({ state: 'online', version: '1.2.3' })
    expect(seen.at(-1)?.state).toBe('online')
    engine.dispose()
  })

  it('自动启动时发布 starting，而不是底层文件错误', async () => {
    const seen: EngineStatusSnapshot[] = []
    const waitUntilAbort: EngineDependencies['wait'] = (_milliseconds, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const deps = dependencies(waitUntilAbort)
    const engine = connection((status) => seen.push(status), deps, true)

    const pending = engine.ensureReady()
    await vi.waitFor(() => expect(seen.some((status) => status.state === 'starting')).toBe(true))
    expect(deps.launch).toHaveBeenCalledWith('mock-qingjian-start', undefined, logger)
    engine.dispose()
    await expect(pending).resolves.toMatchObject({ state: 'offline' })
  })

  it('后台轮询按 5s 起指数退避，并在青简启动后自动恢复', async () => {
    const seen: EngineStatusSnapshot[] = []
    const waits: Array<{ milliseconds: number; resolve: () => void }> = []
    const controlledWait: EngineDependencies['wait'] = (milliseconds, signal) => new Promise((resolve, reject) => {
      const item = { milliseconds, resolve }
      waits.push(item)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const engine = connection((status) => seen.push(status), dependencies(controlledWait))

    engine.startMonitoring()
    await vi.waitFor(() => expect(waits[0]?.milliseconds).toBe(5_000))
    waits[0]!.resolve()
    await vi.waitFor(() => expect(waits[1]?.milliseconds).toBe(10_000))

    await writeInstance()
    waits[1]!.resolve()
    await vi.waitFor(() => expect(seen.at(-1)?.state).toBe('online'))
    await vi.waitFor(() => expect(waits[2]?.milliseconds).toBe(5_000))
    engine.dispose()
  })

  it('instance 存在但监听已退出时归类为未检测到，而非握手失败', async () => {
    await writeInstance()
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
    healthMode = 'connection-refused'
    const engine = connection()

    await expect(engine.status()).resolves.toMatchObject({
      state: 'offline', reason: 'connection-refused', message: expect.stringContaining('无法连接'),
    })
    engine.dispose()
  })
})

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}
