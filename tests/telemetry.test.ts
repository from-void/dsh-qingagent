import { describe, expect, it, vi } from 'vitest'
import {
  Telemetry,
  ageDaysBucket,
  blocksBucket,
  browserStyleUserAgent,
  countBucket,
  editRejectedReason,
  engineStateBucket,
  patchesBucket,
  safeTelemetryErrorMessage,
  validateBridgeTelemetryEvent,
  wordsBucket,
  type TelemetryProfile,
} from '../src/telemetry.js'

const DEVICE_ID = '11111111-1111-4111-8111-111111111111'
const WEBSITE_ID = '22222222-2222-4222-8222-222222222222'
const NOW = Date.parse('2026-08-18T00:00:00.000Z')

function profile(overrides: Partial<TelemetryProfile> = {}): TelemetryProfile {
  return {
    deviceId: DEVICE_ID,
    firstRunAt: '2026-08-01T00:00:00.000Z',
    hasWritten: false,
    hasEdited: false,
    hasReviewed: false,
    ...overrides,
  }
}

function profileStore(initial = profile()) {
  let current = initial
  return {
    get: () => current,
    set: vi.fn(async (next: TelemetryProfile) => { current = next }),
  }
}

function telemetry(fetcher: typeof globalThis.fetch, overrides: ConstructorParameters<typeof Telemetry>[0] = {}) {
  const store = profileStore()
  return {
    store,
    instance: new Telemetry({
      env: {},
      endpoint: 'https://example.invalid/api/send',
      websiteId: WEBSITE_ID,
      pluginVersion: '1.2.3',
      locale: () => 'zh-CN',
      now: () => NOW,
      uuid: () => DEVICE_ID,
      openProfile: async () => store,
      fetch: fetcher,
      ...overrides,
    }),
  }
}

describe('telemetry 事件构造与分桶', () => {
  it.each([
    [0, '0'], [1, '1-200'], [200, '1-200'], [201, '201-500'], [500, '201-500'],
    [501, '501-1000'], [1_000, '501-1000'], [1_001, '1001-3000'], [3_000, '1001-3000'], [3_001, '>3000'],
  ])('wordsBucket(%s) → %s', (value, expected) => {
    expect(wordsBucket(value)).toBe(expected)
  })

  it.each([
    [0, '0'], [1, '1-5'], [5, '1-5'], [6, '6-20'], [20, '6-20'],
    [21, '21-50'], [50, '21-50'], [51, '>50'],
  ])('blocksBucket(%s) → %s', (value, expected) => {
    expect(blocksBucket(value)).toBe(expected)
  })

  it.each([
    [0, '0'], [1, '1'], [2, '2-5'], [5, '2-5'], [6, '6-20'], [20, '6-20'], [21, '>20'],
  ])('countBucket(%s) → %s', (value, expected) => {
    expect(countBucket(value)).toBe(expected)
  })

  it.each([[1, '1'], [2, '2-5'], [5, '2-5'], [6, '6-20'], [20, '6-20'], [21, '>20']])(
    'patchesBucket(%s) → %s',
    (value, expected) => expect(patchesBucket(value)).toBe(expected),
  )

  it('装机龄与引擎状态只产生低基数枚举', () => {
    expect(ageDaysBucket('2026-08-18T00:00:00.000Z', NOW)).toBe('0')
    expect(ageDaysBucket('2026-08-17T00:00:00.000Z', NOW)).toBe('1-7')
    expect(ageDaysBucket('2026-08-10T00:00:00.000Z', NOW)).toBe('8-30')
    expect(ageDaysBucket('2026-07-01T00:00:00.000Z', NOW)).toBe('30+')
    expect(engineStateBucket({ state: 'online', engineUrl: 'redacted' })).toBe('ok')
    expect(engineStateBucket({ state: 'offline', engineUrl: 'redacted', reason: 'instance-missing' })).toBe('absent')
    expect(engineStateBucket({ state: 'handshake-failed', engineUrl: 'redacted', reason: 'unauthorized' })).toBe('unreachable')
  })

  it('构造 Umami 单事件载荷并使用浏览器风格 UA', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof globalThis.fetch
    const { instance } = telemetry(fetchMock)

    await expect(instance.capture('draft_created', {
      words_bucket: '201-500', blocks_bucket: '6-20', retried: false,
    })).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = vi.mocked(fetchMock).mock.calls[0]!
    expect(url).toBe('https://example.invalid/api/send')
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('user-agent')).toMatch(/Mozilla\/5\.0 .*AppleWebKit\/537\.36.*Chrome\/130\.0\.0\.0.*Safari\/537\.36/)
    // 真机实测:umami 用 isbot 过滤 UA,只要出现自定义产品标记(如 dsh-qingagent/x.y.z)
    // 就把事件**静默丢弃**且照样回 200 {"ok":true}。同一份 body,干净 UA 进库、带 token 不进库。
    // 版本已在事件属性 pluginVersion 里,UA 必须保持纯净浏览器串。
    expect(browserStyleUserAgent()).not.toMatch(/dsh-qingagent/)
    expect(headers.get('user-agent')).not.toMatch(/dsh-qingagent/)
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'dsh-qingagent',
        language: 'zh-CN',
        url: '/panel',
        name: 'draft_created',
        data: expect.objectContaining({
          words_bucket: '201-500',
          blocks_bucket: '6-20',
          retried: false,
          device_id: DEVICE_ID,
          pluginVersion: '1.2.3',
          nodeVersion: process.versions.node,
          locale: 'zh-CN',
        }),
      },
    })
  })
})

describe('telemetry 开关、持久化与失败静默', () => {
  it('websiteId 未配置时硬禁用，不开存储也不发送', async () => {
    const fetchMock = vi.fn() as unknown as typeof globalThis.fetch
    const openProfile = vi.fn()
    const instance = new Telemetry({
      env: { QINGAGENT_PLUGIN_TELEMETRY_WEBSITE_ID: '' },
      websiteId: '',
      fetch: fetchMock,
      openProfile,
    })

    expect(instance.enabled).toBe(false)
    await instance.capture('doc_missing_shown', {})
    expect(openProfile).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['DSH_QINGAGENT_TELEMETRY_DISABLED', 'QINGAGENT_TELEMETRY_DISABLED'] as const)(
    '%s=1 完全关闭',
    async (key) => {
      const fetchMock = vi.fn() as unknown as typeof globalThis.fetch
      const instance = new Telemetry({ env: { [key]: '1' }, websiteId: WEBSITE_ID, fetch: fetchMock })
      await instance.capture('feedback_clicked', { target: 'bug' })
      expect(instance.enabled).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('新 storage domain 生成独立 UUID，并持久化使用里程碑', async () => {
    const store = profileStore(profile({ deviceId: '', firstRunAt: '' }))
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch
    const instance = new Telemetry({
      env: {}, websiteId: WEBSITE_ID, endpoint: 'https://example.invalid/api/send', fetch: fetchMock,
      uuid: () => DEVICE_ID, now: () => NOW, locale: () => 'zh-CN', openProfile: async () => store,
    })

    await instance.capture('draft_edited', { ops_bucket: '1', op_kinds: ['setTitle'], outcome: 'committed' })

    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: DEVICE_ID,
      firstRunAt: '2026-08-18T00:00:00.000Z',
      hasEdited: true,
    }))
  })

  it('plugin_activated 带首启、装机龄、引擎与初始里程碑快照', async () => {
    const store = profileStore(profile({
      deviceId: '', firstRunAt: '', hasWritten: true, hasReviewed: true,
    }))
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch
    const instance = new Telemetry({
      env: {}, websiteId: WEBSITE_ID, endpoint: 'https://example.invalid/api/send', fetch: fetchMock,
      uuid: () => DEVICE_ID, now: () => NOW, locale: () => 'zh-CN', openProfile: async () => store,
    })

    await instance.capturePluginActivated({
      state: 'offline', engineUrl: '不应外发', reason: 'instance-missing', message: '不应外发',
    })

    const body = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]?.[1]?.body))
    expect(body.payload.name).toBe('plugin_activated')
    expect(body.payload.data).toMatchObject({
      first_run: true,
      age_days: '0',
      engine_state: 'absent',
      has_written: false,
      has_edited: false,
      has_reviewed: false,
    })
    expect(JSON.stringify(body)).not.toContain('不应外发')
  })

  it.each([
    ['fetch 抛错', async () => { throw new Error('offline') }],
    ['HTTP 非 200', async () => new Response('bad gateway', { status: 502 })],
  ])('%s 时不抛且不重试', async (_label, implementation) => {
    const fetchMock = vi.fn(implementation) as unknown as typeof globalThis.fetch
    const { instance } = telemetry(fetchMock)
    await expect(instance.capture('feedback_clicked', { target: 'feature' })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('超时中止时不抛且不重试', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })) as unknown as typeof globalThis.fetch
    const { instance } = telemetry(fetchMock, { timeoutMs: 5 })
    await expect(instance.capture('panel_opened', { source: 'manual' })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('engine_unreachable 仅在可达状态翻转时各发一次', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch
    const { instance } = telemetry(fetchMock)
    const offline = { state: 'offline', engineUrl: 'private', reason: 'connection-refused' } as const
    instance.trackEngineStatus(offline)
    instance.trackEngineStatus({ ...offline, message: '仍不可达' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    instance.trackEngineStatus({ state: 'online', engineUrl: 'private' })
    instance.trackEngineStatus(offline)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})

describe('bridge 遥测白名单与错误脱敏', () => {
  it('只接受 UI 事件的精确字段与枚举', () => {
    expect(validateBridgeTelemetryEvent({
      event: 'panel_opened', properties: { source: 'tool_card' },
    })).toEqual({ event: 'panel_opened', properties: { source: 'tool_card' } })
    expect(validateBridgeTelemetryEvent({
      event: 'update_clicked', properties: { from_version: '0.1.19', to_version: '0.2.0-beta.1' },
    })).toMatchObject({ event: 'update_clicked' })
    expect(() => validateBridgeTelemetryEvent({ event: 'draft_created', properties: {} })).toThrow('不支持')
    expect(() => validateBridgeTelemetryEvent({
      event: 'feedback_clicked', properties: { target: 'https://private.example/token', message: 'secret' },
    })).toThrow('字段无效')
    expect(() => validateBridgeTelemetryEvent({
      event: 'update_clicked', properties: { from_version: '/home/alice/key', to_version: '0.2.0' },
    })).toThrow('字段无效')
  })

  it('edit_rejected 只映射枚举；错误消息脱敏且不含 stack', () => {
    expect(editRejectedReason(new Error('old 命中 3 处，未指定 nth'))).toBe('multi_hit_no_nth')
    expect(editRejectedReason(new Error('第 8 行不在当前文稿范围'))).toBe('line_drift')
    expect(editRejectedReason({ body: { code: 'REVIEW_PENDING' } })).toBe('review_pending')
    expect(safeTelemetryErrorMessage(new Error('read /home/alice/secret.txt token=ABC123SECRET')))
      .toBe('read [path] token=[redacted]')
  })
})
