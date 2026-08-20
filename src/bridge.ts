import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {
  BridgeDocument,
  BridgeEvent,
  BridgeState,
  EngineStatusSnapshot,
  ExternalAssetUploadJsonRequest,
  ExternalAssetUploadResponse,
  ExternalAnnotationIgnoreRequest,
  ExternalAnnotationIgnoreResponse,
  ExternalDoc,
  ExternalDocReplaceRequest,
  ExternalDocReplaceResponse,
  ExternalPmDocReadResponse,
  ExternalReviewCommitPanelRequest,
  ExternalReviewCommitResponse,
  ExternalReviewRenderModelResponse,
  ExternalReviewVerdictRequest,
  ExternalReviewVerdictResponse,
  QingSelection,
  SessionBinding,
} from './contracts.js'
import {
  EngineHttpError,
  EngineUnavailableError,
  isMissingSessionError,
  type EngineService,
} from './engine.js'
import type { BindingStore } from './bindings.js'
import { engineAssetFileId } from './assetBridge.js'
import {
  DEFAULT_DRAWIO_VENDOR_ROOT,
  DRAWIO_ROUTE_PATH,
  serveDrawioAsset,
} from './drawioAssets.js'
import {
  CURRENT_PACKAGE_VERSION,
  PluginUpdateChecker,
  type UpdateCheckProvider,
} from './updateCheck.js'
import {
  validateBridgeTelemetryEvent,
  type TelemetryCapture,
} from './telemetry.js'
import { parseReviewTurn, reviewTurnCoordinatorFor } from './reviewTurn.js'

const MAX_ASSET_BYTES = 50 * 1024 * 1024
const MAX_ASSET_JSON_BYTES = 70 * 1024 * 1024
export const TURN_SIGNAL_HEARTBEAT_MS = 17_000

type TurnSignalAction = 'begin' | 'end' | 'heartbeat'

export type AgentTurnLeaseState = 'acquired' | 'unsupported' | 'lost' | 'unknown'

interface TurnSignalResponse {
  active: boolean
}

type LeaseBlockReason = 'busy-native' | 'lease-held' | 'lock-lost' | 'auth' | 'session-missing' | 'unknown'

interface TrackedLeaseSegment {
  dshSessionId: string
  engineSessionId: string
  turnId: string
  generation: number
  state: AgentTurnLeaseState
  blockReason?: LeaseBlockReason
  lastError?: unknown
  beginAttempt?: Promise<void>
  heartbeat?: ReturnType<typeof setInterval>
  heartbeatInFlight?: Promise<void>
  heartbeatFailureCount: number
  writeOutcomeUnknown: boolean
  unsupportedReported: boolean
  suspicious: boolean
  closing: boolean
  closePromise?: Promise<void>
}

interface TrackedAgentTurn {
  turn: number
  pinnedEngineSessionId?: string
  segments: Map<string, TrackedLeaseSegment>
}

const TURN_SIGNAL_DEADLINE_MS = 10_000
const TURN_CLOSE_DEADLINE_MS = 10_000
const BEGIN_RETRY_DELAY_MS = 2_000
const COLD_BEGIN_BUSY_RETRIES = 2
const RECOVERY_BEGIN_ATTEMPTS = 2
const UNKNOWN_DISAMBIGUATION_BUDGET_MS = 20_000

export const LEASE_UNSUPPORTED_ERROR = '当前引擎不支持编辑锁，请升级客户端'
export const LEASE_LOST_ERROR = '文稿已被其他持有者锁定/锁已失效，本回合停止写作'
export const LEASE_BUSY_NATIVE_ERROR = '客户端正在处理，稍后再试'
export const LEASE_AUTH_ERROR = '青简连接授权已失效，请重新连接客户端；本回合停止写作'
export const LEASE_UNKNOWN_ERROR = '无法确认文稿编辑锁状态，本回合停止写作'

/**
 * Agent 回合的多文稿忙碌租约。每个 (DSH 会话,青简文稿) 有独立租约段，
 * 只有 acquired 段才能发写/改/审阅请求。同一文稿的旧段 end 与新段 begin 串行，
 * 不同文稿则并行收口。
 */
export class AgentTurnLeaseCoordinator {
  private readonly turns = new Map<string, TrackedAgentTurn>()
  private readonly closingByDocument = new Map<string, Promise<void>>()
  private nextGeneration = 1

  constructor(
    private readonly engine: EngineService,
    private readonly heartbeatMs = TURN_SIGNAL_HEARTBEAT_MS,
    private readonly createTurnId: () => string = randomUUID,
    private readonly onSegmentOpened?: (dshSessionId: string, engineSessionId: string, generation: number) => void,
    private readonly onTurnClosed?: (dshSessionId: string, engineSessionIds: string[]) => void,
  ) {}

  async openTurn(dshSessionId: string, turn: number, pinnedEngineSessionId?: string): Promise<void> {
    const current = this.turns.get(dshSessionId)
    if (current?.turn === turn) return
    if (current) {
      this.turns.delete(dshSessionId)
      void this.closeTurn(current)
    }
    const opened: TrackedAgentTurn = {
      turn,
      pinnedEngineSessionId,
      segments: new Map(),
    }
    this.turns.set(dshSessionId, opened)
    if (pinnedEngineSessionId) {
      const segment = this.createSegment(dshSessionId, pinnedEngineSessionId)
      opened.segments.set(pinnedEngineSessionId, segment)
      await this.beginCold(segment)
    }
  }

  pinnedDocument(dshSessionId: string): string | undefined {
    return this.turns.get(dshSessionId)?.pinnedEngineSessionId
  }

  generation(dshSessionId: string, engineSessionId: string): number | undefined {
    return this.turns.get(dshSessionId)?.segments.get(engineSessionId)?.generation
  }

  state(dshSessionId: string, engineSessionId: string): AgentTurnLeaseState | undefined {
    return this.turns.get(dshSessionId)?.segments.get(engineSessionId)?.state
  }

  /** 纯读只领取本回合的文稿 generation，不发 begin；后续写意图复用该段。 */
  observeDocument(dshSessionId: string, engineSessionId: string): number | undefined {
    const current = this.turns.get(dshSessionId)
    if (!current) return undefined
    let segment = current.segments.get(engineSessionId)
    if (!segment) {
      segment = this.createSegment(dshSessionId, engineSessionId)
      current.segments.set(engineSessionId, segment)
    }
    return segment.generation
  }

  /** 写意图首次触稿时冷 begin；同文稿并发写共享 beginAttempt。 */
  async touchDocument(dshSessionId: string, engineSessionId: string): Promise<string | undefined> {
    let current = this.turns.get(dshSessionId)
    if (!current) {
      current = { turn: Number.MIN_SAFE_INTEGER, pinnedEngineSessionId: engineSessionId, segments: new Map() }
      this.turns.set(dshSessionId, current)
    }
    current.pinnedEngineSessionId ??= engineSessionId
    let segment = current.segments.get(engineSessionId)
    if (!segment) {
      segment = this.createSegment(dshSessionId, engineSessionId)
      current.segments.set(engineSessionId, segment)
    }
    segment.beginAttempt ??= this.beginCold(segment)
    await segment.beginAttempt
    if (segment.state !== 'acquired') throw this.blockingError(segment)
    return segment.turnId
  }

  /** 审查预申领遇到 BUSY_NATIVE 时，落批注前再做一次完整冷申领。 */
  async retryBusyDocument(dshSessionId: string, engineSessionId: string): Promise<string | undefined> {
    const segment = this.turns.get(dshSessionId)?.segments.get(engineSessionId)
    if (segment?.state === 'unknown' && segment.blockReason === 'busy-native') {
      segment.beginAttempt = undefined
      segment.blockReason = undefined
      segment.lastError = undefined
    }
    return this.touchDocument(dshSessionId, engineSessionId)
  }

  async endTurn(dshSessionId: string, turn: number): Promise<void> {
    const current = this.turns.get(dshSessionId)
    if (!current || current.turn !== turn) return
    this.turns.delete(dshSessionId)
    await this.closeTurn(current)
  }

  async disposeAgent(dshSessionId: string): Promise<void> {
    const current = this.turns.get(dshSessionId)
    if (!current) return
    this.turns.delete(dshSessionId)
    await this.closeTurn(current)
  }

  dispose(): void {
    const active = [...this.turns.values()]
    this.turns.clear()
    for (const current of active) void this.closeTurn(current)
  }

  markAgentError(dshSessionId: string, turn: number): void {
    const current = this.turns.get(dshSessionId)
    if (!current || current.turn !== turn) return
    for (const segment of current.segments.values()) segment.suspicious = true
  }

  recordWriteFailure(dshSessionId: string, engineSessionId: string, error: unknown): void {
    const segment = this.turns.get(dshSessionId)?.segments.get(engineSessionId)
    if (!segment || segment.state === 'lost') return
    const kind = signalFailureKind(error)
    if (kind === 'route-missing') this.transition(segment, 'unsupported', 'unknown', error)
    else if (kind === 'session-missing') this.transition(segment, 'lost', 'session-missing', error)
    else if (kind === 'auth') this.transition(segment, 'lost', 'auth', error)
    else if (kind === 'busy-native' || kind === 'lease-held' || kind === 'lock-lost') {
      this.transition(segment, 'lost', kind === 'busy-native' ? 'lock-lost' : kind, error)
    } else if (kind === 'transient') {
      segment.writeOutcomeUnknown = true
      if (segment.heartbeat) clearInterval(segment.heartbeat)
      segment.heartbeat = undefined
      this.transition(segment, 'unknown', 'unknown', error)
    }
  }

  private createSegment(dshSessionId: string, engineSessionId: string): TrackedLeaseSegment {
    const segment: TrackedLeaseSegment = {
      dshSessionId,
      engineSessionId,
      turnId: this.createTurnId(),
      generation: this.nextGeneration++,
      state: 'unknown',
      heartbeatFailureCount: 0,
      writeOutcomeUnknown: false,
      unsupportedReported: false,
      suspicious: false,
      closing: false,
    }
    this.onSegmentOpened?.(dshSessionId, engineSessionId, segment.generation)
    return segment
  }

  private async beginCold(segment: TrackedLeaseSegment): Promise<void> {
    segment.beginAttempt ??= (async () => {
      const previousClose = this.closingByDocument.get(this.documentKey(segment))
      if (previousClose) await previousClose.catch(() => undefined)
      for (let attempt = 0; attempt <= COLD_BEGIN_BUSY_RETRIES; attempt += 1) {
        if (segment.closing) return
        try {
          const response = await this.signal(segment, 'begin')
          if (response.active) {
            this.transition(segment, 'acquired')
            this.startHeartbeat(segment)
            return
          }
          return this.recoverBegin(segment, Date.now() + UNKNOWN_DISAMBIGUATION_BUDGET_MS)
        } catch (error) {
          const kind = signalFailureKind(error)
          if (kind === 'busy-native') {
            if (attempt < COLD_BEGIN_BUSY_RETRIES) {
              await delay(BEGIN_RETRY_DELAY_MS)
              continue
            }
            this.transition(segment, 'unknown', 'busy-native', error)
            return
          }
          if (kind === 'lease-held' || kind === 'lock-lost') {
            this.transition(segment, 'lost', kind, error)
            return
          }
          if (kind === 'auth') {
            this.transition(segment, 'lost', 'auth', error)
            return
          }
          if (kind === 'route-missing') {
            this.transition(segment, 'unsupported', 'unknown', error)
            return
          }
          if (kind === 'session-missing') {
            this.transition(segment, 'lost', 'session-missing', error)
            return
          }
          if (kind === 'transient') {
            this.transition(segment, 'unknown', 'unknown', error)
            await this.recoverBegin(segment, Date.now() + UNKNOWN_DISAMBIGUATION_BUDGET_MS)
            return
          }
          this.transition(segment, 'lost', 'unknown', error)
          return
        }
      }
    })()
    return segment.beginAttempt
  }

  private async recoverBegin(segment: TrackedLeaseSegment, deadline: number): Promise<void> {
    if (segment.state === 'lost' || segment.state === 'unsupported' || segment.closing) return
    segment.state = 'unknown'
    for (let attempt = 0; attempt < RECOVERY_BEGIN_ATTEMPTS; attempt += 1) {
      const remaining = deadline - Date.now()
      if (remaining <= 0 || segment.closing) break
      try {
        const response = await this.signal(segment, 'begin', Math.min(TURN_SIGNAL_DEADLINE_MS, remaining))
        if (response.active) {
          this.transition(segment, 'acquired')
          this.startHeartbeat(segment)
          return
        }
      } catch (error) {
        const kind = signalFailureKind(error)
        // H2:recovery begin 的 BUSY_NATIVE/LEASE_HELD 直接进 lost，不走 cold 重试。
        if (kind === 'busy-native' || kind === 'lease-held' || kind === 'lock-lost') {
          this.transition(segment, 'lost', kind === 'busy-native' ? 'lock-lost' : kind, error)
          return
        }
        if (kind === 'auth') {
          this.transition(segment, 'lost', 'auth', error)
          return
        }
        if (kind === 'route-missing') {
          this.transition(segment, 'unsupported', 'unknown', error)
          return
        }
        if (kind === 'session-missing') {
          this.transition(segment, 'lost', 'session-missing', error)
          return
        }
        if (kind !== 'transient') {
          this.transition(segment, 'lost', 'unknown', error)
          return
        }
        segment.lastError = error
      }
    }
    this.transition(segment, 'lost', 'unknown', segment.lastError)
  }

  private startHeartbeat(segment: TrackedLeaseSegment): void {
    if (segment.heartbeat || segment.closing || segment.state !== 'acquired') return
    segment.heartbeat = setInterval(() => {
      if (segment.closing || segment.heartbeatInFlight || (segment.state !== 'acquired' && segment.state !== 'unknown')) return
      const pending = this.heartbeat(segment)
      segment.heartbeatInFlight = pending
      void pending.finally(() => {
        if (segment.heartbeatInFlight === pending) segment.heartbeatInFlight = undefined
      })
    }, this.heartbeatMs)
    segment.heartbeat.unref?.()
  }

  private async heartbeat(segment: TrackedLeaseSegment): Promise<void> {
    if (segment.writeOutcomeUnknown) return
    try {
      const response = await this.signal(segment, 'heartbeat')
      if (response.active) {
        this.transition(segment, 'acquired')
        segment.heartbeatFailureCount = 0
        return
      }
      segment.beginAttempt = this.recoverBegin(segment, Date.now() + UNKNOWN_DISAMBIGUATION_BUDGET_MS)
      await segment.beginAttempt
    } catch (error) {
      const kind = signalFailureKind(error)
      if (kind === 'busy-native') {
        segment.beginAttempt = this.recoverBegin(segment, Date.now() + UNKNOWN_DISAMBIGUATION_BUDGET_MS)
        await segment.beginAttempt
      } else if (kind === 'lease-held' || kind === 'lock-lost') {
        this.transition(segment, 'lost', kind, error)
      } else if (kind === 'auth') {
        this.transition(segment, 'lost', 'auth', error)
      } else if (kind === 'route-missing') {
        this.transition(segment, 'unsupported', 'unknown', error)
      } else if (kind === 'session-missing') {
        this.transition(segment, 'lost', 'session-missing', error)
      } else {
        this.transition(segment, 'unknown', 'unknown', error)
        segment.heartbeatFailureCount += 1
        if (segment.heartbeatFailureCount >= 3) {
          segment.heartbeatFailureCount = 0
          segment.beginAttempt = this.recoverBegin(segment, Date.now() + UNKNOWN_DISAMBIGUATION_BUDGET_MS)
          await segment.beginAttempt
        }
      }
    }
  }

  private async closeTurn(current: TrackedAgentTurn): Promise<void> {
    const segments = [...current.segments.values()]
    const pending = Promise.allSettled(segments.map((segment) => this.closeSegment(segment)))
    await raceDeadline(pending, TURN_CLOSE_DEADLINE_MS)
    const dshSessionId = segments[0]?.dshSessionId
    if (!dshSessionId || segments.length === 0) return
    try {
      this.onTurnClosed?.(dshSessionId, segments.map((segment) => segment.engineSessionId))
    } catch {
      // 面板通知失败不能反向阻断租约本地收口。
    }
  }

  private closeSegment(segment: TrackedLeaseSegment): Promise<void> {
    if (segment.closePromise) return segment.closePromise
    segment.closing = true
    if (segment.heartbeat) {
      clearInterval(segment.heartbeat)
      segment.heartbeat = undefined
    }
    segment.closePromise = (async () => {
      const attempted = Boolean(segment.beginAttempt)
      if (segment.beginAttempt) await segment.beginAttempt.catch(() => undefined)
      if (!attempted) return
      if (segment.state !== 'acquired' && segment.state !== 'unknown') return
      await this.signal(segment, 'end').catch(() => undefined)
    })()
    const key = this.documentKey(segment)
    this.closingByDocument.set(key, segment.closePromise)
    void segment.closePromise.finally(() => {
      if (this.closingByDocument.get(key) === segment.closePromise) this.closingByDocument.delete(key)
    })
    return segment.closePromise
  }

  private transition(
    segment: TrackedLeaseSegment,
    state: AgentTurnLeaseState,
    blockReason?: LeaseBlockReason,
    lastError?: unknown,
  ): void {
    if (segment.state === 'lost' && state !== 'lost') return
    segment.state = state
    segment.blockReason = blockReason
    segment.lastError = lastError
    if (state === 'lost' || state === 'unsupported') {
      if (segment.heartbeat) clearInterval(segment.heartbeat)
      segment.heartbeat = undefined
    }
  }

  private blockingError(segment: TrackedLeaseSegment): Error {
    if (segment.blockReason === 'session-missing' && segment.lastError instanceof Error) return segment.lastError
    if (segment.state === 'unsupported') {
      if (!segment.unsupportedReported) {
        segment.unsupportedReported = true
        return new Error(LEASE_UNSUPPORTED_ERROR)
      }
      return new Error('当前引擎不支持编辑锁，本回合已停止写作')
    }
    if (segment.blockReason === 'busy-native') return new Error(LEASE_BUSY_NATIVE_ERROR)
    if (segment.blockReason === 'auth') return new Error(LEASE_AUTH_ERROR)
    if (segment.state === 'lost') return new Error(LEASE_LOST_ERROR)
    return new Error(LEASE_UNKNOWN_ERROR)
  }

  private documentKey(segment: TrackedLeaseSegment): string {
    return `${segment.dshSessionId}\u0000${segment.engineSessionId}`
  }

  private signal(
    segment: TrackedLeaseSegment,
    action: TurnSignalAction,
    timeoutMs = TURN_SIGNAL_DEADLINE_MS,
  ): Promise<TurnSignalResponse> {
    return this.engine.fetchTurnSignal<TurnSignalResponse>(
      `/sessions/${encodeURIComponent(segment.engineSessionId)}/turn-signal`,
      { action, turnId: segment.turnId },
      timeoutMs,
    )
  }
}

type SignalFailureKind =
  | 'busy-native'
  | 'lease-held'
  | 'lock-lost'
  | 'auth'
  | 'route-missing'
  | 'session-missing'
  | 'transient'
  | 'other'

function signalFailureKind(error: unknown): SignalFailureKind {
  if (isMissingSessionError(error)) return 'session-missing'
  if (error instanceof EngineHttpError) {
    const body = error.body as { code?: unknown } | null
    const code = typeof body?.code === 'string' ? body.code : ''
    if (code === 'BUSY_NATIVE' || code === 'AGENT_BUSY') return 'busy-native'
    if (code === 'LEASE_HELD') return 'lease-held'
    if (code === 'LOCK_LOST') return 'lock-lost'
    if (error.status === 401 || error.status === 403) return 'auth'
    if (error.status === 404) return 'route-missing'
    if (error.status === 429 || error.status >= 500) return 'transient'
    return 'other'
  }
  if (error instanceof EngineUnavailableError) {
    return error.status.reason === 'unauthorized' ? 'auth' : 'transient'
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'transient'
  return 'transient'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

async function raceDeadline(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds)
      timer.unref?.()
    }),
  ])
  if (timer) clearTimeout(timer)
}

interface Subscriber {
  dshSessionId: string
  response: ServerResponse
  heartbeat: ReturnType<typeof setInterval>
}

export interface BridgeDocStateObserver {
  documentChanged(dshSessionId: string, engineSessionId: string): Promise<void> | void
}

export class BridgeHub {
  private readonly subscribers = new Set<Subscriber>()
  private readonly selections = new Map<string, QingSelection>()

  constructor(
    private readonly ctx: Context,
    private readonly engine: EngineService,
    private readonly bindings: BindingStore,
    private readonly drawioVendorRoot = DEFAULT_DRAWIO_VENDOR_ROOT,
    private readonly updateChecker: UpdateCheckProvider = new PluginUpdateChecker(),
    private readonly telemetry?: TelemetryCapture,
    private readonly docStateObserver?: BridgeDocStateObserver,
  ) {}

  mount(): void {
    const disposeDrawio = this.ctx.webServer.register({
      kind: 'prefix',
      path: DRAWIO_ROUTE_PATH,
      handler: (request, response) => {
        if (!isLoopback(request.socket.remoteAddress)) {
          writeJson(response, 403, { error: 'drawio 静态资产仅允许本机访问。' })
          return
        }
        return serveDrawioAsset(request, response, this.drawioVendorRoot)
      },
    })
    const disposeBridge = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/qingagent-bridge',
      handler: (request, response) => this.route(request, response),
    })
    this.ctx.effect(() => () => {
      disposeDrawio()
      disposeBridge()
      for (const subscriber of this.subscribers) this.removeSubscriber(subscriber)
      this.selections.clear()
    })
  }

  emit(dshSessionId: string, event: BridgeEvent): void {
    if (event.type === 'doc-committed') this.clearSelection(dshSessionId)
    this.writeEvent(dshSessionId, event)
  }

  clearSelection(dshSessionId: string): void {
    if (!this.selections.delete(dshSessionId)) return
    this.writeEvent(dshSessionId, { type: 'selection-changed', selection: null })
  }

  getSelection(dshSessionId: string): QingSelection | undefined {
    return this.selections.get(dshSessionId)
  }

  private writeEvent(dshSessionId: string, event: BridgeEvent): void {
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
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/update-check') {
        let result
        try {
          result = await this.updateChecker.check()
        } catch {
          result = {
            current: CURRENT_PACKAGE_VERSION,
            latest: CURRENT_PACKAGE_VERSION,
            hasUpdate: false,
          }
        }
        writeJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/telemetry') {
        if (url.search) throw new HttpInputError('遥测端点不接受查询参数。')
        let event
        try {
          event = validateBridgeTelemetryEvent(await readJsonBody(request))
        } catch (error) {
          throw new HttpInputError(error instanceof Error ? error.message : '遥测请求无效。')
        }
        if (this.telemetry) void this.telemetry.capture(event.event, event.properties as never)
        writeJson(response, 202, { accepted: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/launch-client') {
        if (url.search) throw new HttpInputError('启动青简端点不接受路径或其他查询参数。')
        const launched = await this.engine.launchInstalledClient()
        if (!launched) {
          writeJson(response, 409, { error: '未找到可安全启动的青简安装路径。' })
          return
        }
        writeJson(response, 202, { launched: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/state') {
        const dshSessionId = requiredQuery(url, 'dshSessionId')
        writeJson(response, 200, await this.state(dshSessionId))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/stream') {
        this.openStream(requiredQuery(url, 'dshSessionId'), request, response)
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/selection') {
        const selection = this.selections.get(requiredQuery(url, 'dshSessionId')) ?? null
        writeJson(response, 200, { selection })
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/selection') {
        const selection = validateSelection(await readJsonBody(request))
        if (!this.bindings.hasDoc(selection.dshSessionId, selection.engineSessionId)) {
          throw new HttpNotFoundError('文稿不属于当前 DSH 会话。')
        }
        this.selections.set(selection.dshSessionId, selection)
        this.emit(selection.dshSessionId, { type: 'selection-changed', selection })
        writeJson(response, 200, { selection })
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/qingagent-bridge/selection') {
        const dshSessionId = requiredQuery(url, 'dshSessionId')
        this.clearSelection(dshSessionId)
        writeJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/focus') {
        const body = await readJsonBody(request) as {
          dshSessionId?: unknown
          engineSessionId?: unknown
          adopt?: unknown
          title?: unknown
        }
        if (typeof body.dshSessionId !== 'string' || typeof body.engineSessionId !== 'string') {
          throw new HttpInputError('dshSessionId 与 engineSessionId 均为必填字符串。')
        }
        if (body.adopt === true && !this.bindings.hasDoc(body.dshSessionId, body.engineSessionId)) {
          // 收养前确认引擎里确有这篇文稿,避免把不存在的 id 写进绑定表。
          await this.engine.fetchJson(
            `/sessions/${encodeURIComponent(body.engineSessionId)}/doc?lines=1`,
          )
          await this.bindings.adoptDoc(
            body.dshSessionId,
            body.engineSessionId,
            typeof body.title === 'string' ? body.title : '未命名文稿',
          )
        } else {
          await this.bindings.setActive(body.dshSessionId, body.engineSessionId)
        }
        this.emit(body.dshSessionId, { type: 'focus-changed', engineSessionId: body.engineSessionId })
        writeJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/review-turn') {
        const body = await readJsonBody(request) as Record<string, unknown>
        const dshSessionId = typeof body.dshSessionId === 'string' ? body.dshSessionId.trim() : ''
        if (!dshSessionId) throw new HttpInputError('dshSessionId 必须是非空字符串。')
        let review
        try {
          review = parseReviewTurn(body)
        } catch (error) {
          throw new HttpInputError(error instanceof Error ? error.message : '审查回合参数无效。')
        }
        if (!this.bindings.hasDoc(dshSessionId, review.targetEngineSessionId)) {
          throw new HttpInputError('engineSessionId 不属于当前 DSH 会话。')
        }
        reviewTurnCoordinatorFor(this.engine).markPending(dshSessionId, review)
        writeJson(response, 200, { pending: true })
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/qingagent-bridge/review-turn') {
        reviewTurnCoordinatorFor(this.engine).cancelPending(requiredQuery(url, 'dshSessionId'))
        writeJson(response, 200, { pending: false })
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/review-templates') {
        const type = requiredQuery(url, 'type')
        writeJson(response, 200, await fetchInternalJson(this.engine,
          `/external/review-templates?type=${encodeURIComponent(type)}`,
        ))
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/review-templates/select') {
        const body = await readJsonBody(request) as Record<string, unknown>
        const type = typeof body.type === 'string' ? body.type.trim() : ''
        const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : ''
        if (!type || !templateId) throw new HttpInputError('type 与 templateId 均为必填字符串。')
        const selected = await fetchInternalJson<{ id: string; type: string }>(this.engine,
          `/external/review-templates/${encodeURIComponent(templateId)}/select`,
          { method: 'POST', body: '{}' },
        )
        if (selected.type !== type) throw new HttpInputError('模板类型与审查类型不匹配。')
        writeJson(response, 200, selected)
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/review-templates') {
        const body = await readJsonBody(request) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const type = typeof body.type === 'string' ? body.type.trim() : ''
        const name = typeof body.name === 'string' ? body.name : ''
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        if (!type || !name.trim() || !prompt.trim()) {
          throw new HttpInputError('type、name、prompt 均为必填字符串。')
        }
        if (id) {
          const expectedUpdatedAt = typeof body.expectedUpdatedAt === 'string'
            ? body.expectedUpdatedAt.trim()
            : ''
          if (!expectedUpdatedAt) throw new HttpInputError('更新模板必须提供 expectedUpdatedAt。')
          writeJson(response, 200, await fetchInternalJson(this.engine,
            `/external/review-templates/${encodeURIComponent(id)}`,
            { method: 'PUT', body: JSON.stringify({ name, prompt, expectedUpdatedAt }) },
          ))
        } else {
          writeJson(response, 200, await fetchInternalJson(this.engine, '/external/review-templates', {
            method: 'POST',
            body: JSON.stringify({ type, name, prompt }),
          }))
        }
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/qingagent-bridge/review-templates') {
        const templateId = requiredQuery(url, 'templateId')
        writeJson(response, 200, await fetchInternalJson(this.engine,
          `/external/review-templates/${encodeURIComponent(templateId)}`,
          { method: 'DELETE' },
        ))
        return
      }
      if (url.pathname === '/qingagent-bridge/review-supplement'
        && (request.method === 'GET' || request.method === 'PUT')) {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const type = requiredQuery(url, 'type')
        const templateId = url.searchParams.get('templateId')?.trim()
        const query = `type=${encodeURIComponent(type)}${templateId ? `&templateId=${encodeURIComponent(templateId)}` : ''}`
        const path = `/sessions/${encodeURIComponent(engineSessionId)}/review-supplement?${query}`
        const supplement = request.method === 'GET'
          ? await fetchInternalJson(this.engine, `/external${path}`)
          : await fetchInternalJson(this.engine, `/external${path}`, {
            method: 'PUT',
            body: JSON.stringify(await readJsonBody(request)),
          })
        writeJson(response, 200, supplement)
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/lexicons') {
        writeJson(response, 200, await fetchInternalJson(this.engine, '/external/lexicons'))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/review-materials') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        writeJson(response, 200, await fetchInternalJson(this.engine,
          `/external/sessions/${encodeURIComponent(engineSessionId)}/files`,
        ))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/export') {
        // 导出:代理引擎内部导出接口,流式回传;格式白名单与青简 ExportMenu 一致。
        const engineSessionId = this.authorizedEngineSessionId(url)
        const format = url.searchParams.get('format') ?? ''
        if (!['pdf', 'docx', 'html', 'markdown', 'txt'].includes(format)) {
          throw new HttpInputError('不支持的导出格式。')
        }
        // 空文稿无可导出内容,短路 409(评测 P18;客户端已把 409 映射为「还没有可导出的内容」)。
        const docState = await this.readDoc(engineSessionId)
        if (docState.state === 'empty') {
          writeJson(response, 409, { error: '还没有可导出的内容' })
          return
        }
        const upstream = await this.engine.fetchInternal(
          // external 子树导出路由(引擎 0.1.5 新数据面;旧 /export 对插件身份 403)。
          `/external/sessions/${encodeURIComponent(engineSessionId)}/export?format=${encodeURIComponent(format)}`,
        )
        const headers: Record<string, string> = {
          'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
        }
        const degradations = upstream.headers.get('X-Qingagent-Export-Degradations')
        if (degradations) headers['X-Qingagent-Export-Degradations'] = degradations
        response.writeHead(upstream.status, headers)
        const body = upstream.body
        if (!body) { response.end(); return }
        const reader = body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          response.write(value)
        }
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/library') {
        // 青简文库:引擎最近更新的文稿(含其他会话的),供下拉「最近文稿」分组;token 不出主机端。
        requiredQuery(url, 'dshSessionId')
        const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '25', 10)
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 25
        const listing = await this.engine.fetchJson<{
          sessions: Array<{ id: string; title: string | null; state: string; updatedAt: string }>
        }>(`/sessions?limit=${limit}`)
        writeJson(response, 200, {
          library: listing.sessions.map((session) => ({
            engineSessionId: session.id,
            title: session.title ?? '未命名文稿',
            state: session.state,
            updatedAt: session.updatedAt,
          })),
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/doc') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        writeJson(response, 200, await this.readDoc(engineSessionId))
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/assets') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = validateAssetUploadBody(await readJsonBody(request, MAX_ASSET_JSON_BYTES))
        writeJson(response, 200, await this.engine.fetchJson<ExternalAssetUploadResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/assets`,
          { method: 'POST', body: JSON.stringify(body) },
        ))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/assets') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const reference = requiredQuery(url, 'ref')
        const fileId = engineAssetFileId(reference)
        if (!fileId) throw new HttpInputError('资产引用不是 external 上传回执签发的路径。')
        await writeAssetResponse(response, await this.engine.fetchAsset(
          `/sessions/${encodeURIComponent(engineSessionId)}/assets/${encodeURIComponent(fileId)}`,
          { method: 'GET' },
        ))
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/doc-pm') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        writeJson(response, 200, await this.engine.fetchJson<ExternalPmDocReadResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/doc?format=pm`,
        ))
        return
      }
      if (request.method === 'PUT' && url.pathname === '/qingagent-bridge/doc-pm') {
        const dshSessionId = requiredQuery(url, 'dshSessionId')
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = await readJsonBody(request, 8 * 1024 * 1024) as ExternalDocReplaceRequest
        const replaced = await this.engine.fetchJson<ExternalDocReplaceResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/doc`,
          { method: 'PUT', body: JSON.stringify(body) },
        )
        if (replaced.ok) await this.documentChanged(dshSessionId, engineSessionId)
        writeJson(response, 200, replaced)
        return
      }
      if (request.method === 'GET' && url.pathname === '/qingagent-bridge/review-render-model') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        writeJson(response, 200, await this.engine.fetchJson<ExternalReviewRenderModelResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/review?format=render-model`,
        ))
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/review-verdicts') {
        const dshSessionId = requiredQuery(url, 'dshSessionId')
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = await readJsonBody(request) as ExternalReviewVerdictRequest
        const verdict = await this.engine.fetchJson<ExternalReviewVerdictResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/review/verdicts`,
          { method: 'POST', body: JSON.stringify(body) },
        )
        await this.documentChanged(dshSessionId, engineSessionId)
        writeJson(response, 200, verdict)
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/review-annotations-ignore') {
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = await readJsonBody(request) as ExternalAnnotationIgnoreRequest
        writeJson(response, 200, await this.engine.fetchJson<ExternalAnnotationIgnoreResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/review/annotations/ignore`,
          { method: 'POST', body: JSON.stringify(body) },
        ))
        return
      }
      if (request.method === 'POST' && url.pathname === '/qingagent-bridge/review-commit') {
        const dshSessionId = requiredQuery(url, 'dshSessionId')
        const engineSessionId = this.authorizedEngineSessionId(url)
        const body = await readJsonBody(request) as ExternalReviewCommitPanelRequest
        const reviewed = await this.engine.fetchJson<ExternalReviewCommitResponse>(
          `/sessions/${encodeURIComponent(engineSessionId)}/review/commit`,
          { method: 'POST', body: JSON.stringify(body) },
        )
        await this.documentChanged(dshSessionId, engineSessionId)
        // 面板审阅发生在 agent 租约已经关闭之后，不会再自然收到租约的 turn-ended。
        // 主动推同一刷新信号，让所有发起方都从权威 /doc 清掉 busy/state 缓存。
        this.emit(dshSessionId, { type: 'turn-ended', engineSessionIds: [engineSessionId] })
        writeJson(response, 200, reviewed)
        return
      }
      writeJson(response, 404, { error: 'bridge route not found' })
    } catch (error) {
      if (error instanceof EngineHttpError) {
        writeJson(response, error.status, error.body ?? { error: error.message })
        return
      }
      const status = error instanceof HttpPayloadTooLargeError
        ? 413
        : error instanceof HttpInputError
          ? 400
          : error instanceof HttpNotFoundError
            ? 404
            : 502
      writeJson(response, status, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private authorizedEngineSessionId(url: URL): string {
    const dshSessionId = requiredQuery(url, 'dshSessionId')
    const engineSessionId = requiredQuery(url, 'engineSessionId')
    if (!this.bindings.hasDoc(dshSessionId, engineSessionId)) {
      throw new HttpNotFoundError('文稿不属于当前 DSH 会话。')
    }
    return engineSessionId
  }

  private async documentChanged(dshSessionId: string, engineSessionId: string): Promise<void> {
    try {
      await this.docStateObserver?.documentChanged(dshSessionId, engineSessionId)
    } catch {
      // 上游改动已经成功；摘要刷新失败不能把面板操作改写成失败。
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
          return { bound, doc: await this.readDoc(bound.engineSessionId), missing: false }
        } catch (error) {
          return { bound, doc: undefined, missing: isMissingSessionError(error) }
        }
      }))
      for (const item of loaded) {
        // 只有 external 明确返回 404 + SESSION_NOT_FOUND 才从切换数据源剔除。
        // 连接/服务错误仍作为 offline 保留，避免把暂时读不到误报成删除。
        if (item.missing) continue
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
    const selection = this.selections.get(dshSessionId)
    return {
      dshSessionId,
      binding,
      docs,
      ...(activeDoc ? { activeDoc } : {}),
      ...(selection ? { selection } : {}),
      engine,
    }
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
class HttpNotFoundError extends Error {}
class HttpPayloadTooLargeError extends Error {}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim()
  if (!value) throw new HttpInputError(`缺少查询参数 ${name}。`)
  return value
}

function validateSelection(value: unknown): QingSelection {
  if (!value || typeof value !== 'object') throw new HttpInputError('选段请求必须是 JSON 对象。')
  const body = value as Record<string, unknown>
  const anchor = body.anchor && typeof body.anchor === 'object'
    ? body.anchor as Record<string, unknown>
    : undefined
  const dshSessionId = typeof body.dshSessionId === 'string' ? body.dshSessionId.trim() : ''
  const engineSessionId = typeof body.engineSessionId === 'string' ? body.engineSessionId.trim() : ''
  const quote = typeof body.quote === 'string' ? body.quote.trim() : ''
  const blockId = typeof anchor?.blockId === 'string' ? anchor.blockId.trim() : ''
  const from = anchor?.from
  const to = anchor?.to
  if (!dshSessionId || !engineSessionId || !quote || !blockId) {
    throw new HttpInputError('dshSessionId、engineSessionId、quote 与 anchor.blockId 均为必填。')
  }
  if (quote.length > 100_000) throw new HttpInputError('选段引文过长。')
  if (blockId.length > 512) throw new HttpInputError('anchor.blockId 过长。')
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || (from as number) < 0 || (to as number) <= (from as number)) {
    throw new HttpInputError('anchor.from/to 必须是有效的 PM 选区范围。')
  }
  return {
    dshSessionId,
    engineSessionId,
    quote,
    anchor: { blockId, from: from as number, to: to as number },
  }
}

export function isLoopback(address?: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address?.startsWith('::ffff:127.') === true
}

async function fetchInternalJson<T = unknown>(
  engine: EngineService,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const upstream = await engine.fetchInternal(path, init)
  const body = await upstream.json().catch(() => undefined) as T | undefined
  if (!upstream.ok) throw new EngineHttpError(upstream.status, body)
  return body as T
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function writeAssetResponse(response: ServerResponse, upstream: Response): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': upstream.headers.get('cache-control') ?? 'private, max-age=300',
  }
  for (const name of ['content-length', 'content-disposition', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  response.writeHead(upstream.status, headers)
  response.end(Buffer.from(await upstream.arrayBuffer()))
}

function validateAssetUploadBody(value: unknown): ExternalAssetUploadJsonRequest {
  if (!value || typeof value !== 'object') throw new HttpInputError('资产上传请求必须是 JSON 对象。')
  const body = value as Record<string, unknown>
  const filename = typeof body.filename === 'string' ? body.filename : ''
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim() : undefined
  const base64 = body.base64
  if (!filename || filename.length > 512) throw new HttpInputError('资产 filename 无效。')
  if (body.mimeType !== undefined && (!mimeType || mimeType.length > 255)) {
    throw new HttpInputError('资产 mimeType 无效。')
  }
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new HttpInputError('资产 base64 无效。')
  }
  const unpadded = base64.replace(/=+$/, '')
  const normalized = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  const decoded = Buffer.from(normalized, 'base64')
  if (!unpadded || decoded.toString('base64').replace(/=+$/, '') !== unpadded) {
    throw new HttpInputError('资产 base64 无效。')
  }
  const decodedSize = decoded.length
  if (decodedSize === 0) throw new HttpInputError('资产内容不能为空。')
  if (decodedSize > MAX_ASSET_BYTES) throw new HttpPayloadTooLargeError('资产超过 50 MiB 上传上限。')
  return { filename, ...(mimeType ? { mimeType } : {}), base64 }
}

async function readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new HttpPayloadTooLargeError(`请求体超过 ${Math.ceil(maxBytes / 1024)} KiB。`)
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
  } catch {
    throw new HttpInputError('请求体不是合法 JSON。')
  }
}
