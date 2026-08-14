import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { Service, type Context, type Logger } from '@deepseek-ai/cordis'
import type { EngineStatusSnapshot } from './contracts.js'

const DEFAULT_INSTANCE_PATH = `${homedir()}/.qingagent/instance.json`

interface EngineInstance {
  port: number
  pid: number
  version: string
  token: string
  startedAt: string
}

export interface EngineConfig {
  engineUrl: string
  engineCommand?: string
  engineCwd?: string
  autoLaunch: boolean
}

export interface EngineDependencies {
  fetch: typeof globalThis.fetch
  readInstance: () => Promise<EngineInstance>
  isProcessAlive: (pid: number) => boolean
  launch: (command: string, cwd: string | undefined, logger: Logger) => void
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export class EngineHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message = `青简接口返回 HTTP ${status}`,
  ) {
    super(message)
    this.name = 'EngineHttpError'
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('等待已取消'))
    }, { once: true })
  })
}

const defaultDependencies: EngineDependencies = {
  fetch: globalThis.fetch,
  readInstance: async () => JSON.parse(await readFile(DEFAULT_INSTANCE_PATH, 'utf8')) as EngineInstance,
  isProcessAlive: defaultAlive,
  launch: (command, cwd, logger) => {
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (chunk) => logger.info('[青简] %s', String(chunk).trimEnd()))
    child.stderr?.on('data', (chunk) => logger.warn('[青简] %s', String(chunk).trimEnd()))
    ;(child.stdout as typeof child.stdout & { unref?: () => void } | null)?.unref?.()
    ;(child.stderr as typeof child.stderr & { unref?: () => void } | null)?.unref?.()
    child.on('error', (error) => logger.error('青简启动失败：%s', error.message))
    child.unref()
  },
  wait,
}

/** 可注入依赖的连接器让 401 降级、离线和自启动路径可被单测覆盖。 */
export class EngineConnection {
  private instance?: EngineInstance
  private launchPromise?: Promise<EngineStatusSnapshot>
  private readonly controller = new AbortController()
  private lastStatus?: EngineStatusSnapshot

  constructor(
    readonly config: EngineConfig,
    private readonly logger: Logger,
    private readonly onStatus: (status: EngineStatusSnapshot) => void = () => undefined,
    private readonly dependencies: EngineDependencies = defaultDependencies,
  ) {}

  dispose(): void {
    this.controller.abort(new Error('dsh-qingagent 已卸载'))
  }

  private publish(status: EngineStatusSnapshot): EngineStatusSnapshot {
    if (JSON.stringify(status) !== JSON.stringify(this.lastStatus)) {
      this.lastStatus = status
      this.onStatus(status)
    }
    return status
  }

  private async reloadInstance(): Promise<EngineInstance> {
    const instance = await this.dependencies.readInstance()
    if (!Number.isInteger(instance.pid) || !this.dependencies.isProcessAlive(instance.pid)) {
      throw new Error('青简实例记录不存在或进程已退出')
    }
    if (!instance.token?.trim()) throw new Error('青简实例 token 缺失')
    this.instance = instance
    return instance
  }

  async status(timeoutMs = 1_500): Promise<EngineStatusSnapshot> {
    try {
      let instance = await this.reloadInstance()
      const signal = AbortSignal.timeout(timeoutMs)
      let response = await this.healthFetch(instance.token, signal)
      // feat/external-qingml 当前 external 子树（health 也在内）要求独立 Bearer；实例重启后只重读一次。
      if (response.status === 401) {
        instance = await this.reloadInstance()
        response = await this.healthFetch(instance.token, signal)
      }
      if (!response.ok) throw new Error(`health 返回 HTTP ${response.status}`)
      const body = await response.json() as { version?: string }
      return this.publish({
        state: 'online',
        engineUrl: this.config.engineUrl,
        version: body.version ?? instance.version,
      })
    } catch (error) {
      return this.publish({ state: 'offline', engineUrl: this.config.engineUrl, message: readableError(error) })
    }
  }

  private healthFetch(token: string, signal: AbortSignal): Promise<Response> {
    return this.dependencies.fetch(`${this.config.engineUrl.replace(/\/$/, '')}/api/v1/external/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
  }

  async ensureReady(): Promise<EngineStatusSnapshot> {
    const current = await this.status()
    if (current.state === 'online' || !this.config.autoLaunch || !this.config.engineCommand) return current
    this.launchPromise ??= this.launchAndPoll().finally(() => { this.launchPromise = undefined })
    return this.launchPromise
  }

  private async launchAndPoll(): Promise<EngineStatusSnapshot> {
    this.publish({ state: 'starting', engineUrl: this.config.engineUrl, message: '正在启动青简…' })
    this.logger.info('执行青简启动命令：%s', this.config.engineCommand)
    this.dependencies.launch(this.config.engineCommand!, this.config.engineCwd, this.logger)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !this.controller.signal.aborted) {
      try {
        await this.dependencies.wait(500, this.controller.signal)
      } catch {
        break
      }
      const status = await this.status()
      if (status.state === 'online') return status
      this.publish({ state: 'starting', engineUrl: this.config.engineUrl, message: '正在等待青简就绪…' })
    }
    return this.publish({ state: 'offline', engineUrl: this.config.engineUrl, message: '20 秒内未等到青简就绪' })
  }

  async fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const ready = await this.ensureReady()
    if (ready.state !== 'online') {
      throw new Error(`青简当前离线：${ready.message ?? '请先启动引擎，或在插件配置中启用 autoLaunch。'}`)
    }
    let instance = this.instance ?? await this.reloadInstance()
    let response = await this.authorizedFetch(path, init, instance.token)
    if (response.status === 401) {
      instance = await this.reloadInstance()
      response = await this.authorizedFetch(path, init, instance.token)
    }
    const body = await response.json().catch(() => undefined) as unknown
    if (!response.ok) throw new EngineHttpError(response.status, body)
    return body as T
  }

  private authorizedFetch(path: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return this.dependencies.fetch(`${this.config.engineUrl.replace(/\/$/, '')}/api/v1/external${path}`, { ...init, headers })
  }
}

export class EngineService extends Service {
  readonly connection: EngineConnection

  constructor(ctx: Context, config: EngineConfig, onStatus?: (status: EngineStatusSnapshot) => void) {
    super(ctx, 'qingagentEngine')
    this.connection = new EngineConnection(config, ctx.logger('qingagent-engine'), onStatus)
    ctx.effect(() => () => this.connection.dispose())
  }

  status(): Promise<EngineStatusSnapshot> { return this.connection.status() }
  ensureReady(): Promise<EngineStatusSnapshot> { return this.connection.ensureReady() }
  fetchJson<T>(path: string, init?: RequestInit): Promise<T> { return this.connection.fetchJson<T>(path, init) }
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    qingagentEngine: EngineService
  }
}
