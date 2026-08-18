import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, type Domain, type DomainGlobal } from '@deepseek-ai/dsh-storage-domain'
import packageJson from '../package.json' with { type: 'json' }
import type { EngineStatusReason, EngineStatusSnapshot } from './contracts.js'
import { redactPotentialPii } from './telemetry/redact.js'

const DEFAULT_ENDPOINT = 'https://t.qingagent.com/api/send'
const DEFAULT_WEBSITE_ID = '5a1b5f2f-8b52-479d-9b7d-0153362f25f2'
const DEFAULT_TIMEOUT_MS = 4_000
const WEBSITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const TelemetryDomainSpec = defineDomain({
  name: 'dsh_qingagent_telemetry',
  version: 1,
  global: {
    schema: z.object({
      deviceId: z.string(),
      firstRunAt: z.string(),
      hasWritten: z.boolean(),
      hasEdited: z.boolean(),
      hasReviewed: z.boolean(),
    }),
    initial: {
      deviceId: '',
      firstRunAt: '',
      hasWritten: false,
      hasEdited: false,
      hasReviewed: false,
    },
  },
  tables: {},
})

export type TelemetryDomain = Domain<typeof TelemetryDomainSpec>
export type TelemetryProfile = ReturnType<TelemetryDomain['global']['get']>
type TelemetryProfileStore = Pick<DomainGlobal<TelemetryProfile>, 'get' | 'set'>

export type WordsBucket = '0' | '1-200' | '201-500' | '501-1000' | '1001-3000' | '>3000'
export type BlocksBucket = '0' | '1-5' | '6-20' | '21-50' | '>50'
export type CountBucket = '0' | '1' | '2-5' | '6-20' | '>20'
export type PatchesBucket = '1' | '2-5' | '6-20' | '>20'
export type AgeDaysBucket = '0' | '1-7' | '8-30' | '30+'
export type EngineStateBucket = 'ok' | 'absent' | 'unreachable'
export type EditRejectedReason = 'multi_hit_no_nth' | 'zero_hit' | 'line_drift' | 'review_pending' | 'other'
export type PanelOpenSource = 'tool_card' | 'manual' | 'auto'
export type ReviewAction = 'commit' | 'discard'
export type FeedbackTarget = 'bug' | 'feature'

export interface TelemetryEventMap {
  plugin_activated: {
    first_run: boolean
    age_days: AgeDaysBucket
    engine_state: EngineStateBucket
    has_written: boolean
    has_edited: boolean
    has_reviewed: boolean
  }
  panel_opened: { source: PanelOpenSource }
  draft_created: { words_bucket: WordsBucket; blocks_bucket: BlocksBucket; retried: boolean }
  draft_edited: { ops_bucket: CountBucket; op_kinds: string[]; outcome: 'committed' | 'review' }
  edit_rejected: { reason: EditRejectedReason }
  review_settled: { action: ReviewAction; patches_bucket: PatchesBucket; retried: boolean }
  engine_unreachable: { code: EngineStatusReason }
  update_clicked: { from_version: string; to_version: string }
  feedback_clicked: { target: FeedbackTarget }
  doc_missing_shown: Record<string, never>
}

export type TelemetryEventName = keyof TelemetryEventMap
export type BridgeTelemetryEventName = Extract<
  TelemetryEventName,
  'panel_opened' | 'review_settled' | 'update_clicked' | 'feedback_clicked' | 'doc_missing_shown'
>

export type BridgeTelemetryEvent = {
  [K in BridgeTelemetryEventName]: { event: K; properties: TelemetryEventMap[K] }
}[BridgeTelemetryEventName]

interface TelemetryConfig {
  enabled: boolean
  endpoint: string
  websiteId: string
}

interface TelemetryReady {
  profile: TelemetryProfile
  firstRun: boolean
  store?: TelemetryProfileStore
}

export interface TelemetryDependencies {
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  now?: () => number
  uuid?: () => string
  locale?: () => string
  openProfile?: () => Promise<TelemetryProfileStore>
  endpoint?: string
  websiteId?: string
  pluginVersion?: string
  dshVersion?: string
  timeoutMs?: number
}

export interface TelemetryCapture {
  capture<K extends TelemetryEventName>(event: K, properties: TelemetryEventMap[K]): Promise<void>
}

export interface TelemetryEnvelope {
  type: 'event'
  payload: {
    website: string
    hostname: 'dsh-qingagent'
    language: string
    url: '/panel'
    name: TelemetryEventName
    data: Record<string, unknown>
  }
}

export class Telemetry implements TelemetryCapture {
  private readonly config: TelemetryConfig
  private readonly fetcher: typeof globalThis.fetch
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly locale: () => string
  private readonly openProfile: () => Promise<TelemetryProfileStore>
  private readonly pluginVersion: string
  private readonly dshVersion?: string
  private readonly timeoutMs: number
  private readyPromise?: Promise<TelemetryReady>
  private reachability?: 'reachable' | 'unreachable'

  constructor(dependencies: TelemetryDependencies = {}) {
    this.config = resolveTelemetryConfig(dependencies)
    this.fetcher = dependencies.fetch ?? globalThis.fetch
    this.now = dependencies.now ?? Date.now
    this.uuid = dependencies.uuid ?? randomUUID
    this.locale = dependencies.locale ?? defaultLocale
    this.openProfile = dependencies.openProfile ?? (async () => {
      throw new Error('telemetry profile storage 未配置')
    })
    this.pluginVersion = dependencies.pluginVersion ?? packageJson.version
    this.dshVersion = optionalString(dependencies.dshVersion) || undefined
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  async init(): Promise<void> {
    if (!this.config.enabled) return
    await this.ready()
  }

  async capture<K extends TelemetryEventName>(event: K, properties: TelemetryEventMap[K]): Promise<void> {
    if (!this.config.enabled) return
    try {
      const ready = await this.ready()
      await this.markMilestone(ready, event)
      const common = commonProperties({
        deviceId: ready.profile.deviceId,
        pluginVersion: this.pluginVersion,
        dshVersion: this.dshVersion,
        locale: this.locale(),
      })
      const envelope = buildTelemetryEnvelope(
        this.config.websiteId,
        common.locale,
        event,
        { ...properties, ...common.data },
      )
      const response = await this.fetcher(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': browserStyleUserAgent(),
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) return
    } catch {
      // 埋点失败必须完全静默:不重试、不排队、不影响调用方。
    }
  }

  async capturePluginActivated(engine: EngineStatusSnapshot): Promise<void> {
    if (!this.config.enabled) return
    try {
      const ready = await this.ready()
      await this.capture('plugin_activated', {
        first_run: ready.firstRun,
        age_days: ageDaysBucket(ready.profile.firstRunAt, this.now()),
        engine_state: engineStateBucket(engine),
        has_written: ready.profile.hasWritten,
        has_edited: ready.profile.hasEdited,
        has_reviewed: ready.profile.hasReviewed,
      })
    } catch {
      // 初始化与画像读取失败同样不能影响插件加载。
    }
  }

  trackEngineStatus(status: EngineStatusSnapshot): void {
    if (status.state === 'online') {
      this.reachability = 'reachable'
      return
    }
    if (status.state === 'starting' || !status.reason) return
    if (this.reachability === 'unreachable') return
    this.reachability = 'unreachable'
    void this.capture('engine_unreachable', { code: status.reason })
  }

  private ready(): Promise<TelemetryReady> {
    return this.readyPromise ??= this.initializeProfile()
  }

  private async initializeProfile(): Promise<TelemetryReady> {
    let store: TelemetryProfileStore | undefined
    try {
      store = await this.openProfile()
    } catch {
      // 存储不可用时退化为进程内匿名画像。
    }
    const existing = store?.get()
    const usable = Boolean(
      existing
      && WEBSITE_ID_RE.test(existing.deviceId)
      && Number.isFinite(Date.parse(existing.firstRunAt)),
    )
    if (usable) return { profile: { ...existing! }, firstRun: false, store }

    const profile: TelemetryProfile = {
      deviceId: this.uuid(),
      firstRunAt: new Date(this.now()).toISOString(),
      hasWritten: false,
      hasEdited: false,
      hasReviewed: false,
    }
    if (store) await store.set(profile).catch(() => undefined)
    return { profile, firstRun: true, store }
  }

  private async markMilestone(ready: TelemetryReady, event: TelemetryEventName): Promise<void> {
    const field = event === 'draft_created'
      ? 'hasWritten'
      : event === 'draft_edited'
        ? 'hasEdited'
        : event === 'review_settled'
          ? 'hasReviewed'
          : undefined
    if (!field || ready.profile[field]) return
    ready.profile = { ...ready.profile, [field]: true }
    if (ready.store) await ready.store.set(ready.profile).catch(() => undefined)
  }
}

export function createTelemetry(ctx: Context, dependencies: Omit<TelemetryDependencies, 'openProfile'> = {}): Telemetry {
  return new Telemetry({
    ...dependencies,
    openProfile: async () => {
      const domain = await ctx.storageDomain.open(TelemetryDomainSpec)
      ctx.effect(() => () => domain.close())
      return domain.global
    },
  })
}

export function resolveTelemetryConfig(dependencies: Pick<
  TelemetryDependencies,
  'env' | 'endpoint' | 'websiteId'
> = {}): TelemetryConfig {
  const env = dependencies.env ?? process.env
  const disabled = env.DSH_QINGAGENT_TELEMETRY_DISABLED === '1'
    || env.QINGAGENT_TELEMETRY_DISABLED === '1'
  const websiteId = Object.prototype.hasOwnProperty.call(env, 'QINGAGENT_PLUGIN_TELEMETRY_WEBSITE_ID')
    ? optionalString(env.QINGAGENT_PLUGIN_TELEMETRY_WEBSITE_ID)
    : optionalString(dependencies.websiteId ?? DEFAULT_WEBSITE_ID)
  const endpoint = optionalString(dependencies.endpoint ?? DEFAULT_ENDPOINT)
  return {
    enabled: !disabled && WEBSITE_ID_RE.test(websiteId) && isHttpUrl(endpoint),
    endpoint,
    websiteId,
  }
}

export function buildTelemetryEnvelope<K extends TelemetryEventName>(
  websiteId: string,
  locale: string,
  event: K,
  data: TelemetryEventMap[K] & Record<string, unknown>,
): TelemetryEnvelope {
  return {
    type: 'event',
    payload: {
      website: websiteId,
      hostname: 'dsh-qingagent',
      language: locale,
      url: '/panel',
      name: event,
      data,
    },
  }
}

export function wordsBucket(value: number): WordsBucket {
  if (value <= 0) return '0'
  if (value <= 200) return '1-200'
  if (value <= 500) return '201-500'
  if (value <= 1_000) return '501-1000'
  if (value <= 3_000) return '1001-3000'
  return '>3000'
}

export function blocksBucket(value: number): BlocksBucket {
  if (value <= 0) return '0'
  if (value <= 5) return '1-5'
  if (value <= 20) return '6-20'
  if (value <= 50) return '21-50'
  return '>50'
}

export function countBucket(value: number): CountBucket {
  if (value <= 0) return '0'
  if (value === 1) return '1'
  if (value <= 5) return '2-5'
  if (value <= 20) return '6-20'
  return '>20'
}

export function patchesBucket(value: number): PatchesBucket {
  if (value <= 1) return '1'
  if (value <= 5) return '2-5'
  if (value <= 20) return '6-20'
  return '>20'
}

export function ageDaysBucket(firstRunAt: string, now = Date.now()): AgeDaysBucket {
  const days = Math.floor((now - Date.parse(firstRunAt)) / 86_400_000)
  if (!Number.isFinite(days) || days <= 0) return '0'
  if (days <= 7) return '1-7'
  if (days <= 30) return '8-30'
  return '30+'
}

export function engineStateBucket(status: EngineStatusSnapshot): EngineStateBucket {
  if (status.state === 'online') return 'ok'
  if (status.reason === 'instance-missing' || status.reason === 'instance-process-exited') return 'absent'
  return 'unreachable'
}

export function editRejectedReason(error: unknown): EditRejectedReason {
  const detail = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object'
    ? (error as { body?: { code?: unknown } }).body?.code
    : undefined
  if (code === 'REVIEW_PENDING' || /审阅中|REVIEW_PENDING/i.test(detail)) return 'review_pending'
  if (/命中\s*0\s*处|未命中/u.test(detail)) return 'zero_hit'
  if (/命中\s*\d+\s*处.*(?:未指定\s*nth|目标不唯一)|未唯一命中/u.test(detail)) return 'multi_hit_no_nth'
  if (code === 'VERSION_CONFLICT' || /旧行号|第\s*\d+\s*行|多行内容|insertAfter(?:Line|Block)|VERSION_CONFLICT|内容已经变化/iu.test(detail)) {
    return 'line_drift'
  }
  return 'other'
}

export function validateBridgeTelemetryEvent(value: unknown): BridgeTelemetryEvent {
  if (!isExactObject(value, ['event', 'properties'])) throw new Error('遥测请求字段无效。')
  const event = value.event
  const properties = value.properties
  if (event === 'panel_opened') {
    if (!isExactObject(properties, ['source']) || !isEnum(properties.source, ['tool_card', 'manual', 'auto'])) {
      throw new Error('panel_opened 字段无效。')
    }
    return { event, properties: { source: properties.source } }
  }
  if (event === 'review_settled') {
    if (
      !isExactObject(properties, ['action', 'patches_bucket', 'retried'])
      || !isEnum(properties.action, ['commit', 'discard'])
      || !isEnum(properties.patches_bucket, ['1', '2-5', '6-20', '>20'])
      || typeof properties.retried !== 'boolean'
    ) throw new Error('review_settled 字段无效。')
    return {
      event,
      properties: {
        action: properties.action,
        patches_bucket: properties.patches_bucket,
        retried: properties.retried,
      },
    }
  }
  if (event === 'update_clicked') {
    if (
      !isExactObject(properties, ['from_version', 'to_version'])
      || !isVersion(properties.from_version)
      || !isVersion(properties.to_version)
    ) throw new Error('update_clicked 字段无效。')
    return {
      event,
      properties: { from_version: properties.from_version, to_version: properties.to_version },
    }
  }
  if (event === 'feedback_clicked') {
    if (!isExactObject(properties, ['target']) || !isEnum(properties.target, ['bug', 'feature'])) {
      throw new Error('feedback_clicked 字段无效。')
    }
    return { event, properties: { target: properties.target } }
  }
  if (event === 'doc_missing_shown') {
    if (!isExactObject(properties, [])) throw new Error('doc_missing_shown 不接受属性。')
    return { event, properties: {} }
  }
  throw new Error('不支持的遥测事件。')
}

/**
 * UA 必须是**纯净的浏览器串**:umami 用 isbot 过滤,UA 里只要出现自定义产品标记
 * (如 `dsh-qingagent/0.1.20`)就会被判成机器人**静默丢弃**——而且照样回 200 `{"ok":true}`,
 * 调用方完全无感。真机实测:同一份 body,干净 UA 进库、带自定义 token 不进库。
 * 插件版本已在事件属性 `pluginVersion` 里,不要再塞进 UA。
 */
export function browserStyleUserAgent(): string {
  const osToken = process.platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36`
}

export function safeTelemetryErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return redactPotentialPii(message).slice(0, 200)
}

function commonProperties(input: {
  deviceId: string
  pluginVersion: string
  dshVersion?: string
  locale: string
}): { locale: string; data: Record<string, string> } {
  return {
    locale: input.locale,
    data: {
      device_id: input.deviceId,
      pluginVersion: input.pluginVersion,
      ...(input.dshVersion ? { dshVersion: input.dshVersion } : {}),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      locale: input.locale,
    },
  }
}

function defaultLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'unknown'
  } catch {
    return 'unknown'
  }
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname.length > 0
  } catch {
    return false
  }
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && VERSION_RE.test(value)
}

function isEnum<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
