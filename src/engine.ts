import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { Service, type Context, type Logger } from '@deepseek-ai/cordis'
import type { EngineStatusReason, EngineStatusSnapshot } from './contracts.js'
import {
  detectQingjianClientInstallation,
  launchDetectedQingjianClient,
  type QingjianClientInstallation,
} from './clientInstallation.js'
import { qingjianUnavailableMessage } from './onboarding.js'

const ATTACH_PROTOCOL_VERSION = 1
const INITIAL_RETRY_MS = 5_000
const MAX_RETRY_MS = 30_000
const INSTANCE_INVALID_GRACE_MS = 10_000

interface EngineInstance {
  schemaVersion: number
  port: number
  pid: number
  version: string
  attachProtocolVersion: number
  token: string
  startedAt: string
}

export interface EngineConfig {
  engineUrl: string
  engineCommand?: string
  engineCwd?: string
  autoLaunch: boolean
  /** 测试与受控部署可覆盖；默认始终读取当前用户 ~/.qingagent/instance.json。 */
  instancePath?: string
}

export interface EngineDependencies {
  fetch: typeof globalThis.fetch
  detectClientInstallation: () => Promise<QingjianClientInstallation>
  launchDetectedClient: () => Promise<boolean>
  readInstance: (path: string) => Promise<unknown>
  isProcessAlive: (pid: number) => boolean
  launch: (command: string, cwd: string | undefined, logger: Logger) => void
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}

export class EngineHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? engineErrorMessage(status, body))
    this.name = 'EngineHttpError'
  }
}

interface EngineErrorBody {
  error?: unknown
  code?: unknown
  nextStep?: unknown
}

const CODE_MESSAGES: Record<string, string> = {
  REVIEW_PENDING: '审阅待处理',
  AGENT_BUSY: '青简正在处理其他任务',
  VERSION_CONFLICT: '文稿版本冲突',
  RATE_LIMITED: '请求过于频繁',
  SESSION_NOT_FOUND: '青简会话不存在',
  NOT_FOUND: '青简资源不存在',
}

const STATUS_MESSAGES: Record<number, string> = {
  404: '青简会话或资源不存在',
  409: '青简当前状态不允许此操作',
  429: '请求过于频繁',
}

const CODE_NEXT_STEPS: Record<string, string> = {
  REVIEW_PENDING: '待审稿归属不明,先向用户说明其存在;仅在用户明确授权后才可 qing_review_commit,不得代为处置',
  AGENT_BUSY: '请稍后重试一次；仍忙则告知用户等待',
  VERSION_CONFLICT: '请重新读取文稿，基于最新版本重做操作，勿原样重发',
  RATE_LIMITED: '请降低请求频率，稍后再试',
  SESSION_NOT_FOUND: '请用 qing_list_docs 重新确认文稿引用，不要重试原引用',
  NOT_FOUND: '请重新确认目标资源，不要重试原引用',
}

const STATUS_NEXT_STEPS: Record<number, string> = {
  404: '请用 qing_list_docs 重新确认文稿引用，不要重试原引用',
  409: '请重新读取文稿状态后再决定下一步',
  429: '请降低请求频率，稍后再试',
}

function engineErrorMessage(status: number, body: unknown): string {
  const details = isEngineErrorBody(body) ? body : undefined
  const code = typeof details?.code === 'string' ? details.code.trim() : ''
  const error = typeof details?.error === 'string' ? details.error.trim() : ''
  const suppliedNextStep = typeof details?.nextStep === 'string' ? details.nextStep.trim() : ''
  const headline = CODE_MESSAGES[code] ?? STATUS_MESSAGES[status] ?? `青简接口请求失败（HTTP ${status}）`
  const withDetail = error && error !== code && error !== headline ? `${headline}：${error}` : headline
  const nextStep = suppliedNextStep || CODE_NEXT_STEPS[code] || STATUS_NEXT_STEPS[status]
  return nextStep ? `${withDetail}（${nextStep}）` : withDetail
}

function isEngineErrorBody(value: unknown): value is EngineErrorBody {
  return typeof value === 'object' && value !== null
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
    if (signal.aborted) {
      reject(signal.reason ?? new Error('等待已取消'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('等待已取消'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const defaultDependencies: EngineDependencies = {
  fetch: globalThis.fetch,
  detectClientInstallation: detectQingjianClientInstallation,
  launchDetectedClient: launchDetectedQingjianClient,
  readInstance: async (path) => JSON.parse(await readFile(path, 'utf8')) as unknown,
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
  now: Date.now,
}

/** 可注入依赖的连接器让 401 降级、离线和自启动路径可被单测覆盖。 */
export class EngineConnection {
  private instance?: EngineInstance
  private launchPromise?: Promise<EngineStatusSnapshot>
  private probePromise?: Promise<EngineStatusSnapshot>
  private monitorPromise?: Promise<void>
  private instanceInvalidSince?: number
  private readonly controller = new AbortController()
  private lastStatus?: EngineStatusSnapshot
  private clientInstallation: QingjianClientInstallation = { installed: false }

  constructor(
    readonly config: EngineConfig,
    private readonly logger: Logger,
    private readonly onStatus: (status: EngineStatusSnapshot) => void = () => undefined,
    private readonly dependencies: EngineDependencies = defaultDependencies,
  ) {}

  dispose(): void {
    this.controller.abort(new Error('dsh-qingagent 已卸载'))
  }

  /** 插件启动即探测；失败后 5s 起指数退避到 30s，恢复后继续轻量健康检查。 */
  startMonitoring(): void {
    this.monitorPromise ??= this.monitor()
      .catch((error) => {
        if (!this.controller.signal.aborted) this.logger.warn('青简后台探测意外中断：%s', readableError(error))
      })
      .finally(() => { this.monitorPromise = undefined })
  }

  private publish(status: EngineStatusSnapshot): EngineStatusSnapshot {
    const snapshot = {
      ...status,
      clientInstalled: this.clientInstallation.installed,
      ...(this.clientInstallation.executablePath
        ? { clientExecutablePath: this.clientInstallation.executablePath }
        : {}),
    }
    if (JSON.stringify(snapshot) !== JSON.stringify(this.lastStatus)) {
      this.lastStatus = snapshot
      this.onStatus(snapshot)
    }
    return snapshot
  }

  /** 引擎地址以 instance.json 的 port 为权威(单库:连的就是写出该文件的引擎);读不到实例时回退配置值。 */
  private baseUrl(): string {
    return this.instance ? `http://127.0.0.1:${this.instance.port}` : this.config.engineUrl.replace(/\/$/, '')
  }

  private instancePath(): string {
    return this.config.instancePath ?? `${homedir()}/.qingagent/instance.json`
  }

  private async reloadInstance(): Promise<EngineInstance> {
    const instance = parseInstance(await this.dependencies.readInstance(this.instancePath()))
    this.instanceInvalidSince = undefined
    this.instance = instance
    return instance
  }

  private instanceReadFailureStatus(error: unknown): EngineStatusSnapshot {
    const reason = instanceReadFailureReason(error)
    if (reason === 'instance-missing') {
      this.instanceInvalidSince = undefined
      return disconnectedStatus(this.baseUrl(), reason, instanceReadFailureMessage(reason))
    }

    const now = this.dependencies.now?.() ?? Date.now()
    this.instanceInvalidSince ??= now
    if (now - this.instanceInvalidSince < INSTANCE_INVALID_GRACE_MS) {
      return {
        state: 'starting',
        engineUrl: this.baseUrl(),
        reason,
        message: '青简实例信息正在写入，等待完成…',
      }
    }
    return disconnectedStatus(this.baseUrl(), reason, instanceReadFailureMessage(reason))
  }

  async status(timeoutMs = 1_500): Promise<EngineStatusSnapshot> {
    this.probePromise ??= this.probe(timeoutMs).finally(() => { this.probePromise = undefined })
    return this.probePromise
  }

  private async probe(timeoutMs: number): Promise<EngineStatusSnapshot> {
    this.clientInstallation = await this.dependencies.detectClientInstallation()
      .catch(() => ({ installed: false }))
    let instance: EngineInstance
    try {
      instance = await this.reloadInstance()
    } catch (error) {
      return this.publish(this.instanceReadFailureStatus(error))
    }
    if (instance.attachProtocolVersion !== ATTACH_PROTOCOL_VERSION) {
      return this.publish(handshakeFailure(
        this.baseUrl(),
        'protocol-incompatible',
        `attachProtocolVersion 不兼容：青简为 ${instance.attachProtocolVersion}，插件需要 ${ATTACH_PROTOCOL_VERSION}。`,
      ))
    }
    if (!this.dependencies.isProcessAlive(instance.pid)) {
      return this.publish(disconnectedStatus(
        this.baseUrl(),
        'instance-process-exited',
        'instance.json 存在，但记录的青简进程已退出。',
      ))
    }
    try {
      const signal = AbortSignal.timeout(timeoutMs)
      let response = await this.healthFetch(instance.token, signal)
      // feat/external-qingml 当前 external 子树（health 也在内）要求独立 Bearer；实例重启后只重读一次。
      if (response.status === 401) {
        try {
          instance = await this.reloadInstance()
        } catch (error) {
          return this.publish(this.instanceReadFailureStatus(error))
        }
        response = await this.healthFetch(instance.token, signal)
      }
      if (response.status === 401 || response.status === 403) {
        return this.publish(handshakeFailure(
          this.baseUrl(),
          'unauthorized',
          `青简拒绝了实例令牌（HTTP ${response.status}），instance.json 可能已经过期。`,
        ))
      }
      if (!response.ok) {
        return this.publish(handshakeFailure(
          this.baseUrl(),
          'health-http-error',
          `青简健康检查返回 HTTP ${response.status}。`,
        ))
      }
      let body: EngineHealth
      try {
        body = parseHealth(await response.json())
      } catch {
        return this.publish(handshakeFailure(
          this.baseUrl(),
          'health-response-invalid',
          '青简健康检查响应格式无效。',
        ))
      }
      if (body.attachProtocolVersion !== ATTACH_PROTOCOL_VERSION) {
        return this.publish(handshakeFailure(
          this.baseUrl(),
          'protocol-incompatible',
          `attachProtocolVersion 不兼容：青简为 ${body.attachProtocolVersion}，插件需要 ${ATTACH_PROTOCOL_VERSION}。`,
        ))
      }
      if (body.version !== instance.version) {
        return this.publish(handshakeFailure(
          this.baseUrl(),
          'version-mismatch',
          `版本不符：instance.json 记录 ${instance.version}，实际引擎为 ${body.version}。`,
        ))
      }
      return this.publish({
        state: 'online',
        engineUrl: this.baseUrl(),
        version: body.version,
      })
    } catch (error) {
      const reason = networkFailureReason(error)
      return this.publish(disconnectedStatus(this.baseUrl(), reason, networkFailureMessage(reason)))
    }
  }

  private healthFetch(token: string, signal: AbortSignal): Promise<Response> {
    return this.dependencies.fetch(`${this.baseUrl()}/api/v1/external/health`, {
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

  /** bridge 只触发这个无参入口，实际路径始终来自 host 检测器自己的缓存。 */
  async launchInstalledClient(): Promise<boolean> {
    if (!this.clientInstallation.installed || !this.clientInstallation.executablePath) return false
    return this.dependencies.launchDetectedClient().catch(() => false)
  }

  private async launchAndPoll(): Promise<EngineStatusSnapshot> {
    this.publish({ state: 'starting', engineUrl: this.baseUrl(), message: '正在启动青简…' })
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
      this.publish({ state: 'starting', engineUrl: this.baseUrl(), message: '正在等待青简就绪…' })
    }
    return this.publish({ state: 'offline', engineUrl: this.baseUrl(), message: '20 秒内未等到青简就绪' })
  }

  async fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchExternalResponse(path, init)
    const body = await response.json().catch(() => undefined) as unknown
    if (!response.ok) throw new EngineHttpError(response.status, body)
    return body as T
  }

  async fetchAsset(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchReadyResponse((token) => this.authorizedFetch(path, init, token))
  }

  private async fetchExternalResponse(path: string, init: RequestInit): Promise<Response> {
    return this.fetchReadyResponse((token) => this.authorizedFetch(path, init, token))
  }

  private async fetchReadyResponse(request: (token: string) => Promise<Response>): Promise<Response> {
    const ready = await this.ensureReady()
    if (ready.state !== 'online') {
      throw new EngineUnavailableError(ready)
    }
    let instance: EngineInstance
    try {
      instance = this.instance ?? await this.reloadInstance()
    } catch (error) {
      throw new EngineUnavailableError(this.publish(this.instanceReadFailureStatus(error)))
    }
    let response: Response
    try {
      response = await request(instance.token)
    } catch (error) {
      const reason = networkFailureReason(error)
      throw new EngineUnavailableError(this.publish(
        disconnectedStatus(this.baseUrl(), reason, networkFailureMessage(reason)),
      ))
    }
    if (response.status === 401) {
      try {
        instance = await this.reloadInstance()
      } catch (error) {
        throw new EngineUnavailableError(this.publish(this.instanceReadFailureStatus(error)))
      }
      try {
        response = await request(instance.token)
      } catch (error) {
        const reason = networkFailureReason(error)
        throw new EngineUnavailableError(this.publish(
          disconnectedStatus(this.baseUrl(), reason, networkFailureMessage(reason)),
        ))
      }
      if (response.status === 401 || response.status === 403) {
        throw new EngineUnavailableError(this.publish(handshakeFailure(
          this.baseUrl(),
          'unauthorized',
          `青简拒绝了实例令牌（HTTP ${response.status}），instance.json 可能已经过期。`,
        )))
      }
    }
    return response
  }

  private async monitor(): Promise<void> {
    let retryMs = INITIAL_RETRY_MS
    let initialProbe = true
    while (!this.controller.signal.aborted) {
      const status = initialProbe ? await this.ensureReady() : await this.status()
      initialProbe = false
      const nextWait = status.state === 'online' ? INITIAL_RETRY_MS : retryMs
      retryMs = status.state === 'online'
        ? INITIAL_RETRY_MS
        : Math.min(MAX_RETRY_MS, retryMs * 2)
      try {
        await this.dependencies.wait(nextWait, this.controller.signal)
      } catch {
        return
      }
    }
  }

  private authorizedFetch(path: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    // 来源归属:引擎按 x-qa-client 把外部改动记为 DeepSeek Harness(客户端展示专用图标)。
    headers.set('x-qa-client', 'deepseek')
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return this.dependencies.fetch(`${this.baseUrl()}/api/v1/external${path}`, { ...init, headers })
  }

  /** 引擎内部(非 external)只读接口,当前仅导出用;仍带 Bearer(无全局令牌时被忽略,无副作用)。 */
  async fetchInternal(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchReadyResponse((token) => {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${token}`)
      return this.dependencies.fetch(`${this.baseUrl()}/api/v1${path}`, { ...init, headers })
    })
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
  launchInstalledClient(): Promise<boolean> { return this.connection.launchInstalledClient() }
  startMonitoring(): void { this.connection.startMonitoring() }
  fetchJson<T>(path: string, init?: RequestInit): Promise<T> { return this.connection.fetchJson<T>(path, init) }
  fetchAsset(path: string, init?: RequestInit): Promise<Response> { return this.connection.fetchAsset(path, init) }
  fetchInternal(path: string, init?: RequestInit): Promise<Response> { return this.connection.fetchInternal(path, init) }
}

export class EngineUnavailableError extends Error {
  constructor(readonly status: EngineStatusSnapshot) {
    super(qingjianUnavailableMessage(status))
    this.name = 'EngineUnavailableError'
  }
}

interface EngineHealth {
  version: string
  attachProtocolVersion: number
}

function parseInstance(value: unknown): EngineInstance {
  if (!value || typeof value !== 'object') throw new SyntaxError('instance.json 不是对象')
  const instance = value as Partial<EngineInstance>
  if (
    instance.schemaVersion !== 2
    || !Number.isInteger(instance.port) || instance.port! < 1 || instance.port! > 65_535
    || !Number.isInteger(instance.pid) || instance.pid! < 1
    || typeof instance.version !== 'string' || !instance.version.trim()
    || !Number.isInteger(instance.attachProtocolVersion)
    || typeof instance.token !== 'string' || !instance.token.trim()
    || typeof instance.startedAt !== 'string' || !Number.isFinite(Date.parse(instance.startedAt))
  ) throw new SyntaxError('instance.json 字段无效')
  return instance as EngineInstance
}

function parseHealth(value: unknown): EngineHealth {
  if (!value || typeof value !== 'object') throw new Error('invalid health')
  const body = value as Partial<EngineHealth>
  if (!body.version?.trim() || !Number.isInteger(body.attachProtocolVersion)) {
    throw new Error('invalid health')
  }
  return body as EngineHealth
}

function instanceReadFailureReason(error: unknown): Extract<EngineStatusReason, 'instance-missing' | 'instance-invalid'> {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'instance-missing' : 'instance-invalid'
}

function instanceReadFailureMessage(reason: 'instance-missing' | 'instance-invalid'): string {
  return reason === 'instance-missing'
    ? '未找到 ~/.qingagent/instance.json；青简可能尚未安装或从未启动。'
    : 'instance.json 存在但已损坏、不可读或字段不完整。'
}

function networkFailureReason(error: unknown): Extract<EngineStatusReason, 'connection-refused' | 'connection-timeout'> {
  const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code
    ?? (error as { code?: unknown })?.code
  return code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || (error as Error)?.name === 'TimeoutError'
    ? 'connection-timeout'
    : 'connection-refused'
}

function networkFailureMessage(reason: 'connection-refused' | 'connection-timeout'): string {
  return reason === 'connection-timeout'
    ? '连接青简超时；引擎可能仍在启动。'
    : '无法连接青简服务；青简可能尚未启动或已经退出。'
}

function disconnectedStatus(
  engineUrl: string,
  reason: Extract<EngineStatusReason, 'instance-missing' | 'instance-invalid' | 'instance-process-exited' | 'connection-refused' | 'connection-timeout'>,
  message: string,
): EngineStatusSnapshot {
  return {
    state: reason === 'instance-invalid' ? 'handshake-failed' : 'offline',
    engineUrl,
    reason,
    message,
  }
}

function handshakeFailure(
  engineUrl: string,
  reason: Extract<EngineStatusReason, 'unauthorized' | 'health-http-error' | 'health-response-invalid' | 'version-mismatch' | 'protocol-incompatible'>,
  message: string,
): EngineStatusSnapshot {
  return { state: 'handshake-failed', engineUrl, reason, message }
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    qingagentEngine: EngineService
  }
}
