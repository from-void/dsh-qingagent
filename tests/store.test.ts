// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeEvent, BridgeState, ExternalDoc, PmDoc } from '../src/contracts.js'
import { QingClientStore } from '../src/client/store.js'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event)
    const current = this.listeners.get(name) ?? []
    current.push(callback as (event: MessageEvent) => void)
    this.listeners.set(name, current)
  }

  emit(event: BridgeEvent): void {
    const message = new MessageEvent(event.type, { data: JSON.stringify(event) })
    for (const listener of this.listeners.get(event.type) ?? []) listener(message)
  }

  close(): void { this.closed = true }
}

function activeDoc(): ExternalDoc {
  return {
    sessionId: 'qing-1', docVersion: 0, state: 'empty', agentBusy: false,
    markdown: '', qingml: '', title: '测试稿',
  }
}

function bridgeState(): BridgeState {
  const doc = activeDoc()
  return {
    dshSessionId: 'dsh-1',
    binding: {
      docs: [{ engineSessionId: 'qing-1', title: '测试稿', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-1',
    },
    docs: [{
      engineSessionId: 'qing-1', title: '测试稿', createdAt: '2026-08-15T00:00:00.000Z',
      state: 'empty', docVersion: 0, agentBusy: false,
    }],
    activeDoc: doc,
    engine: { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
})

describe('QingClientStore 生成终态', () => {
  it('沿用 engine-status SSE 显示未连接面板，并在恢复后自动让位', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    let stateReads = 0
    const fetchMock = vi.fn(async () => {
      stateReads += 1
      return Response.json({
        dshSessionId: 'dsh-offline',
        binding: { docs: [] },
        docs: [],
        engine: stateReads === 1
          ? { state: 'offline', engineUrl: 'http://127.0.0.1:49123', reason: 'instance-missing' }
          : { state: 'online', engineUrl: 'http://127.0.0.1:49123', version: '1.2.3' },
      } satisfies BridgeState)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-offline')
    await vi.waitFor(() => expect(store.hasPanelContent('dsh-offline')).toBe(true))

    FakeEventSource.instances.at(-1)?.emit({
      type: 'engine-status',
      engine: { state: 'online', engineUrl: 'http://127.0.0.1:49123', version: '1.2.3' },
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.getSnapshot('dsh-offline').state?.engine.state).toBe('online'))
    expect(store.hasPanelContent('dsh-offline')).toBe(false)
    release()
  })

  it('draft-started 在首块前立即锁定写作态', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(bridgeState())))
    const store = new QingClientStore()
    const release = store.retain('dsh-started')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-started').state).toBeDefined())

    FakeEventSource.instances.at(-1)?.emit({
      type: 'draft-started', engineSessionId: 'qing-1', generation: 'draft-before-first-chunk',
    })

    expect(store.getSnapshot('dsh-started')).toMatchObject({
      activeEngineSessionId: 'qing-1', streaming: true, blocks: 0, words: 0,
    })
    release()
  })

  it('只接受当前 draft generation 的 chunk 与终态，忽略旧世代迟到事件', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(bridgeState())))
    const store = new QingClientStore()
    const release = store.retain('dsh-generation-order')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-generation-order').state).toBeDefined())
    const source = FakeEventSource.instances.at(-1)!

    source.emit({ type: 'draft-started', engineSessionId: 'qing-1', generation: 'draft-old' })
    source.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', generation: 'draft-old',
      chunkQingml: '<p>旧世代</p>', accumulatedBlocks: ['<p>旧世代</p>'], title: '旧', blocks: 1, words: 3,
    })
    source.emit({ type: 'draft-started', engineSessionId: 'qing-1', generation: 'draft-new' })
    source.emit({ type: 'draft-failed', engineSessionId: 'qing-1', generation: 'draft-old', message: '旧世代迟到失败' })
    source.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', generation: 'draft-old',
      chunkQingml: '<p>污染</p>', accumulatedBlocks: ['<p>污染</p>'], title: '污染', blocks: 1, words: 2,
    })

    expect(store.getSnapshot('dsh-generation-order')).toMatchObject({
      streaming: true, qingml: '<p>旧世代</p>', draftFailure: undefined,
    })

    source.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', generation: 'draft-new',
      chunkQingml: '<p>新世代</p>', accumulatedBlocks: ['<p>新世代</p>'], title: '新', blocks: 1, words: 3,
    })
    source.emit({ type: 'draft-failed', engineSessionId: 'qing-1', generation: 'draft-new', message: '新世代失败' })
    source.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', generation: 'draft-new',
      chunkQingml: '<p>终态后污染</p>', accumulatedBlocks: ['<p>终态后污染</p>'], title: '污染', blocks: 1, words: 5,
    })

    expect(store.getSnapshot('dsh-generation-order')).toMatchObject({
      streaming: false, qingml: '<p>新世代</p>', draftFailure: '新世代失败',
    })
    release()
  })

  it('abort/failure 后退出 streaming，后续 loadState 不复活僵死流并保留失败注记', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const fetchMock = vi.fn(async () => Response.json(bridgeState()))
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-1')

    await vi.waitFor(() => expect(store.getSnapshot('dsh-1').state).toBeDefined())
    expect(store.hasPanelContent('dsh-1')).toBe(true)
    const source = FakeEventSource.instances[0]!
    source.emit({ type: 'draft-started', engineSessionId: 'qing-1', generation: 'draft-abort' })
    source.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', generation: 'draft-abort', chunkQingml: '<p>半篇',
      accumulatedBlocks: ['<p>半篇</p>'], title: '测试稿', blocks: 1, words: 2,
    })
    expect(store.getSnapshot('dsh-1').streaming).toBe(true)

    source.emit({ type: 'binding-changed', binding: bridgeState().binding })
    source.emit({ type: 'draft-failed', engineSessionId: 'qing-1', generation: 'draft-abort', message: 'QingML 生成失败：用户已中止' })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.getSnapshot('dsh-1').streaming).toBe(false))
    expect(store.getSnapshot('dsh-1').draftFailure).toBe('QingML 生成失败：用户已中止')
    release()
    expect(source.closed).toBe(true)
  })

  it('按活跃文稿从 doc-pm 初始化，并在 pendingReview 冷启动补拉 render-model', async () => {
    const pmDoc = {
      type: 'doc', attrs: { schemaVersion: 1 },
      content: [{ type: 'paragraph', attrs: { blockId: 'p-1' }, content: [{ type: 'text', text: '真实正文' }] }],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 3, contentHash: 'hash-3', state: 'pendingReview',
          agentBusy: false, title: '真实文稿', ts: '2026-08-15T01:00:00.000Z', pmDoc,
        })
      }
      if (url.startsWith('/qingagent-bridge/review-render-model?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 3, state: 'pendingReview', agentBusy: false,
          baseVersion: 3, previewDoc: pmDoc, suggestions: [{ id: 'patch-1', status: 'reviewing' }],
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()

    await store.refreshPanel('dsh-1', 'qing-1')

    const snapshot = store.getSnapshot('dsh-1')
    expect(snapshot.panelEngineSessionId).toBe('qing-1')
    expect(snapshot.panelDoc).toMatchObject({ docVersion: 3, contentHash: 'hash-3', pmDoc })
    expect(snapshot.reviewModel).toMatchObject({ baseVersion: 3, suggestions: [{ id: 'patch-1' }] })
    expect(snapshot.reviewCount).toBe(1)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/qingagent-bridge/doc-pm?dshSessionId=dsh-1&engineSessionId=qing-1',
      '/qingagent-bridge/review-render-model?dshSessionId=dsh-1&engineSessionId=qing-1',
    ])
  })

  it('refreshPanel 对确定删除维持 docMissing，重复刷新仍保持，成功读回后清除', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    let restored = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/state?')) {
        return Response.json({
          dshSessionId: 'dsh-missing',
          binding: {
            docs: [
              { engineSessionId: 'qing-missing', title: '昨日旧稿', createdAt: '2026-08-15T00:00:00.000Z' },
              { engineSessionId: 'qing-live', title: '可用文稿', createdAt: '2026-08-15T00:01:00.000Z' },
            ],
            activeEngineSessionId: 'qing-missing',
          },
          docs: [
            {
              engineSessionId: 'qing-missing', title: '昨日旧稿', createdAt: '2026-08-15T00:00:00.000Z',
              state: 'editing', docVersion: 3,
            },
            {
              engineSessionId: 'qing-live', title: '可用文稿', createdAt: '2026-08-15T00:01:00.000Z',
              state: 'editing', docVersion: 2,
            },
          ],
          activeDoc: {
            sessionId: 'qing-missing', docVersion: 3, state: 'editing', agentBusy: false,
            markdown: '', qingml: '<p>旧正文</p>', title: '昨日旧稿',
          },
          engine: { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
        } satisfies BridgeState)
      }
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        if (!restored) {
          return Response.json(
            { error: '青简会话不存在', code: 'SESSION_NOT_FOUND', nextStep: '不要重试原引用' },
            { status: 404 },
          )
        }
        return Response.json({
          sessionId: 'qing-missing', docVersion: 4, contentHash: 'hash-4', state: 'editing',
          agentBusy: false, title: '恢复文稿', ts: 't4',
          pmDoc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
        })
      }
      if (url.startsWith('/qingagent-bridge/review-render-model?')) {
        return Response.json({
          sessionId: 'qing-missing', docVersion: 4, state: 'editing', agentBusy: false,
          baseVersion: 4, suggestions: [],
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-missing')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-missing').state).toBeDefined())

    await expect(store.refreshPanel('dsh-missing', 'qing-missing')).rejects.toMatchObject({ status: 404 })
    expect(store.getSnapshot('dsh-missing')).toMatchObject({
      docMissing: { engineSessionId: 'qing-missing' },
      panelEngineSessionId: 'qing-missing',
      panelLoading: false,
    })
    expect(store.getSnapshot('dsh-missing').panelDoc).toBeUndefined()
    expect(store.getSnapshot('dsh-missing').state?.docs.map((doc) => doc.engineSessionId))
      .toEqual(['qing-live'])

    await expect(store.refreshPanel('dsh-missing', 'qing-missing')).rejects.toMatchObject({ status: 404 })
    expect(store.getSnapshot('dsh-missing').docMissing).toEqual({ engineSessionId: 'qing-missing' })

    restored = true
    await store.refreshPanel('dsh-missing', 'qing-missing')
    expect(store.getSnapshot('dsh-missing').docMissing).toBeUndefined()
    expect(store.getSnapshot('dsh-missing').panelDoc).toMatchObject({ title: '恢复文稿', docVersion: 4 })
    release()
  })

  it.each([
    ['500 响应', () => Response.json(
      { error: '引擎暂时不可用', code: 'SESSION_NOT_FOUND' },
      { status: 500 },
    )],
    ['网络异常', () => Promise.reject(new TypeError('bridge disconnected'))],
    ['只有 error 字段的 404', () => Response.json(
      { error: 'SESSION_NOT_FOUND' },
      { status: 404 },
    )],
  ])('refreshPanel 遇到%s不得猜成 docMissing', async (_name, respond) => {
    vi.stubGlobal('fetch', vi.fn(respond))
    const store = new QingClientStore()

    await expect(store.refreshPanel('dsh-not-missing', 'qing-1')).rejects.toBeDefined()

    expect(store.getSnapshot('dsh-not-missing').docMissing).toBeUndefined()
    expect(store.getSnapshot('dsh-not-missing').error)
      .toBe('与青简桥的实时连接暂时中断，浏览器会自动重连。')
  })

  it('编辑态也装配 render-model annotations，缺省补丁不会误计审阅数', async () => {
    const pmDoc = {
      type: 'doc', attrs: { schemaVersion: 1 },
      content: [{ type: 'paragraph', attrs: { blockId: 'p-1' }, content: [{ type: 'text', text: '批注正文' }] }],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 4, contentHash: 'hash-4', state: 'editing',
          agentBusy: false, title: '批注文稿', ts: 't4', pmDoc,
        })
      }
      if (url.startsWith('/qingagent-bridge/review-render-model?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 4, state: 'editing', agentBusy: false,
          baseVersion: 4, suggestions: [], annotations: [{
            id: 'annotation-1', summary: '事实有误', note: '与材料不一致', origin: 'source-check',
            severity: 'error', status: 'reviewing',
            anchors: [{ blockId: 'p-1', pmFrom: 1, pmTo: 3, quote: '批注' }],
          }],
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    const store = new QingClientStore()

    await store.refreshPanel('dsh-annotations', 'qing-1')

    expect(store.getSnapshot('dsh-annotations').reviewModel?.annotations).toEqual([
      expect.objectContaining({ id: 'annotation-1', status: 'reviewing' }),
    ])
    expect(store.getSnapshot('dsh-annotations').reviewCount).toBe(0)
  })

  it('commit 成功回执立即清空审阅域并恢复可编辑终态', async () => {
    const pmDoc = { type: 'doc', attrs: { schemaVersion: 1 }, content: [] } as PmDoc
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/state?')) return Response.json(bridgeState())
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 3, contentHash: 'hash-3', state: 'pendingReview',
          agentBusy: true, title: '待审稿', ts: 't3', pmDoc,
        })
      }
      if (url.startsWith('/qingagent-bridge/review-render-model?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 3, state: 'pendingReview', agentBusy: false,
          baseVersion: 3, previewDoc: pmDoc, suggestions: [{ id: 'patch-1', status: 'accepted' }],
        })
      }
      throw new Error(`unexpected ${url}`)
    }))
    const store = new QingClientStore()
    const release = store.retain('dsh-commit')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-commit').state).toBeDefined())
    await store.refreshPanel('dsh-commit', 'qing-1')
    FakeEventSource.instances.at(-1)?.emit({ type: 'draft-started', engineSessionId: 'qing-1', generation: 'draft-commit' })
    FakeEventSource.instances.at(-1)?.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', generation: 'draft-commit', chunkQingml: '<p>在途</p>',
      accumulatedBlocks: ['<p>在途</p>'], title: '待审稿', blocks: 1, words: 2,
    })
    expect(store.getSnapshot('dsh-commit').streaming).toBe(true)

    store.applyReviewCommit('dsh-commit', 'qing-1', 4)

    expect(store.getSnapshot('dsh-commit')).toMatchObject({
      streaming: false,
      panelDoc: { docVersion: 4, state: 'editing', agentBusy: false },
      saveState: { kind: 'idle' },
    })
    expect(store.getSnapshot('dsh-commit').reviewModel).toBeUndefined()
    expect(store.getSnapshot('dsh-commit').reviewCount).toBeUndefined()
    release()
  })

  it('权威 PM 刷新必须等 dirty guard 放行后才能替换 panelDoc', async () => {
    const oldPm = { type: 'doc', attrs: { schemaVersion: 1 }, content: [] } as PmDoc
    const incomingPm = {
      type: 'doc', attrs: { schemaVersion: 1 },
      content: [{ type: 'paragraph', attrs: { blockId: 'remote' }, content: [{ type: 'text', text: 'Agent 落稿' }] }],
    } as PmDoc
    const store = new QingClientStore()
    let responsePm = oldPm
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      sessionId: 'qing-1', docVersion: responsePm === oldPm ? 1 : 2,
      contentHash: responsePm === oldPm ? 'hash-1' : 'hash-2', state: 'editing',
      agentBusy: false, title: 'Agent 稿', ts: 't2', pmDoc: responsePm,
    })))
    await store.refreshPanel('dsh-dirty', 'qing-1')

    const release = deferred<boolean>()
    const beforeApply = vi.fn(() => release.promise)
    store.registerPanelRefreshGuard('dsh-dirty', { beforeApply })
    responsePm = incomingPm

    const loading = store.refreshPanel('dsh-dirty', 'qing-1')
    await vi.waitFor(() => expect(beforeApply).toHaveBeenCalledTimes(1))
    expect(store.getSnapshot('dsh-dirty').panelDoc?.pmDoc).toEqual(oldPm)
    expect(store.getSnapshot('dsh-dirty').panelLoading).toBe(true)

    release.resolve(true)
    await loading
    expect(store.getSnapshot('dsh-dirty').panelDoc?.pmDoc).toEqual(incomingPm)
  })

  it('冲突态 refreshPanel 保持锁与本地正文，不静默换成远端稿', async () => {
    const localPm = { type: 'doc', attrs: { schemaVersion: 1 }, content: [] } as PmDoc
    const remotePm = {
      type: 'doc', attrs: { schemaVersion: 1 },
      content: [{ type: 'paragraph', attrs: { blockId: 'remote' }, content: [{ type: 'text', text: '远端正文' }] }],
    } as PmDoc
    let responsePm = localPm
    const store = new QingClientStore()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      sessionId: 'qing-conflict', docVersion: responsePm === localPm ? 1 : 2,
      contentHash: responsePm === localPm ? 'hash-1' : 'hash-2', state: 'editing',
      agentBusy: false, title: '冲突稿', ts: 't', pmDoc: responsePm,
    })))
    await store.refreshPanel('dsh-conflict', 'qing-conflict')
    store.setSaveState('dsh-conflict', {
      kind: 'conflict', engineSessionId: 'qing-conflict', expected: 1, actual: 2, message: '文档已被更新',
    })
    responsePm = remotePm

    await store.refreshPanel('dsh-conflict', 'qing-conflict')

    expect(store.getSnapshot('dsh-conflict').panelDoc?.pmDoc).toEqual(localPm)
    expect(store.getSnapshot('dsh-conflict').saveState).toMatchObject({ kind: 'conflict' })
  })

  it('冲突封锁按文稿隔离:切到别的文稿照常刷新,不跨稿传染', async () => {
    const otherPm = {
      type: 'doc', attrs: { schemaVersion: 1 },
      content: [{ type: 'paragraph', attrs: { blockId: 'other' }, content: [{ type: 'text', text: '另一篇正文' }] }],
    } as PmDoc
    const store = new QingClientStore()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json({
      sessionId: String(input).includes('qing-other') ? 'qing-other' : 'qing-conflict',
      docVersion: 1, contentHash: 'hash-other', state: 'editing',
      agentBusy: false, title: '另一篇', ts: 't', pmDoc: otherPm,
    })))
    store.setSaveState('dsh-conflict-iso', {
      kind: 'conflict', engineSessionId: 'qing-conflict', expected: 1, actual: 2, message: '文档已被更新',
    })

    await store.refreshPanel('dsh-conflict-iso', 'qing-other')

    // 换稿刷新必须应用内容(不得白纸),另一篇的冲突态保留在原稿名下。
    expect(store.getSnapshot('dsh-conflict-iso').panelDoc?.pmDoc).toEqual(otherPm)
    expect(store.getSnapshot('dsh-conflict-iso').saveState).toMatchObject({
      kind: 'conflict', engineSessionId: 'qing-conflict',
    })
  })

  it('resolveConflictByReload 清除冲突并拉回服务器权威版本', async () => {
    const remotePm = {
      type: 'doc', attrs: { schemaVersion: 1 },
      content: [{ type: 'paragraph', attrs: { blockId: 'remote' }, content: [{ type: 'text', text: '远端正文' }] }],
    } as PmDoc
    const store = new QingClientStore()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      sessionId: 'qing-conflict', docVersion: 2, contentHash: 'hash-2', state: 'editing',
      agentBusy: false, title: '冲突稿', ts: 't', pmDoc: remotePm,
    })))
    store.setSaveState('dsh-reload', {
      kind: 'conflict', engineSessionId: 'qing-conflict', expected: 1, actual: 2, message: '文档已被更新',
    })

    await store.resolveConflictByReload('dsh-reload', 'qing-conflict')

    expect(store.getSnapshot('dsh-reload').saveState).toMatchObject({ kind: 'idle' })
    expect(store.getSnapshot('dsh-reload').panelDoc?.pmDoc).toEqual(remotePm)
  })

  it('refreshPanel 在途若收到更新 draft-chunk，保留 streaming 世代', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const panelResponse = deferred<Response>()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/state?')) return Response.json(bridgeState())
      if (url.startsWith('/qingagent-bridge/doc-pm?')) return panelResponse.promise
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-generation')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-generation').state).toBeDefined())

    const refresh = store.refreshPanel('dsh-generation', 'qing-1')
    FakeEventSource.instances.at(-1)?.emit({ type: 'draft-started', engineSessionId: 'qing-1', generation: 'draft-new' })
    FakeEventSource.instances.at(-1)?.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', generation: 'draft-new', chunkQingml: '<p>新世代</p>',
      accumulatedBlocks: ['<p>新世代</p>'], title: '测试稿', blocks: 1, words: 3,
    })
    panelResponse.resolve(Response.json({
      sessionId: 'qing-1', docVersion: 1, contentHash: 'hash-1', state: 'editing',
      agentBusy: false, title: '旧响应', ts: 't1', pmDoc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
    }))
    await refresh

    expect(store.getSnapshot('dsh-generation').streaming).toBe(true)
    expect(store.getSnapshot('dsh-generation').qingml).toContain('新世代')
    release()
  })

  it('doc-committed 携带 QingML 时先乐观推进 panelDoc，再等待权威 PM 读回', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const authoritativePanel = deferred<Response>()
    let panelReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/state?')) return Response.json(bridgeState())
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        panelReads += 1
        if (panelReads === 1) {
          return Response.json({
            sessionId: 'qing-1', docVersion: 0, contentHash: 'hash-0', state: 'empty',
            agentBusy: false, title: '旧稿', ts: 't0', pmDoc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
          })
        }
        return authoritativePanel.promise
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-optimistic')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-optimistic').state).toBeDefined())
    await store.refreshPanel('dsh-optimistic', 'qing-1')
    const beforeApply = vi.fn(async () => true)
    store.registerPanelRefreshGuard('dsh-optimistic', { beforeApply })

    FakeEventSource.instances.at(-1)?.emit({
      type: 'doc-committed', engineSessionId: 'qing-1',
      doc: {
        sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
        markdown: '乐观正文', qingml: '<p>乐观正文</p>', title: '新稿',
      },
      blocks: 1, words: 4,
    })

    await vi.waitFor(() => expect(store.getSnapshot('dsh-optimistic').panelDoc?.docVersion).toBe(2))
    expect(JSON.stringify(store.getSnapshot('dsh-optimistic').panelDoc?.pmDoc)).toContain('乐观正文')
    expect(beforeApply).toHaveBeenCalledWith('qing-1', expect.objectContaining({ docVersion: 2 }))
    expect(panelReads).toBe(2)

    authoritativePanel.resolve(Response.json({
      sessionId: 'qing-1', docVersion: 2, contentHash: 'hash-2', state: 'editing',
      agentBusy: false, title: '新稿', ts: 't2', pmDoc: store.getSnapshot('dsh-optimistic').panelDoc?.pmDoc,
    }))
    await vi.waitFor(() => expect(store.getSnapshot('dsh-optimistic').panelLoading).toBe(false))
    release()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

  it('t14 回归:另一稿保存成功不得清掉冲突稿的冲突;切回仍受封锁', async () => {
    const remotePm = {
      type: 'doc', attrs: { schemaVersion: 1 },
      content: [{ type: 'paragraph', attrs: { blockId: 'r' }, content: [{ type: 'text', text: '服务器版' }] }],
    } as PmDoc
    const store = new QingClientStore()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      sessionId: 'qing-a', docVersion: 4, contentHash: 'hash-4', state: 'editing',
      agentBusy: false, title: '甲', ts: 't', pmDoc: remotePm,
    })))
    // 甲稿进入冲突
    store.setSaveState('dsh-t14', {
      kind: 'conflict', engineSessionId: 'qing-a', expected: 3, actual: 4, message: '文档已被更新',
    })
    // 乙稿保存成功发布瞬态 saved——不得抹掉甲稿冲突
    store.setSaveState('dsh-t14', { kind: 'saved', version: 2 })
    expect(store.getSnapshot('dsh-t14').conflicts?.['qing-a']).toBeTruthy()

    // 切回甲稿:refreshPanel 仍被冲突封锁,不应用服务器版
    await store.refreshPanel('dsh-t14', 'qing-a')
    expect(store.getSnapshot('dsh-t14').panelDoc).toBeUndefined()

    // 重载才解除
    await store.resolveConflictByReload('dsh-t14', 'qing-a')
    expect(store.getSnapshot('dsh-t14').conflicts?.['qing-a']).toBeUndefined()
    expect(store.getSnapshot('dsh-t14').panelDoc?.pmDoc).toEqual(remotePm)
  })

  it('P7 收养:draft-started 丢失时首个 chunk 世代被收养并渲染,已终结世代不收养', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(bridgeState())))
    const store = new QingClientStore()
    const release = store.retain('dsh-adopt')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-adopt').state).toBeDefined())
    const source = FakeEventSource.instances.at(-1)!

    // 无 draft-started,直接来 chunk → 收养
    source.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', generation: 'draft-lost-start',
      chunkQingml: '<p>首块</p>', accumulatedBlocks: ['<p>首块</p>'], title: '稿', blocks: 1, words: 2,
    })
    expect(store.getSnapshot('dsh-adopt')).toMatchObject({ streaming: true, qingml: '<p>首块</p>' })

    // 世代终结后,同世代迟到 chunk 不得复活
    source.emit({ type: 'draft-failed', engineSessionId: 'qing-1', generation: 'draft-lost-start', message: '中止' })
    source.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', generation: 'draft-lost-start',
      chunkQingml: '<p>迟到</p>', accumulatedBlocks: ['<p>迟到</p>'], title: '稿', blocks: 1, words: 2,
    })
    expect(store.getSnapshot('dsh-adopt').streaming).toBe(false)
    expect(store.getSnapshot('dsh-adopt').qingml).toBe('<p>首块</p>')
    release()
  })

  it('P11:冲突稿快照切换往返保留,重载时清除', async () => {
    const localPm = {
      type: 'doc', attrs: { schemaVersion: 1 },
      content: [{ type: 'paragraph', attrs: { blockId: 'l' }, content: [{ type: 'text', text: '本地未保内容' }] }],
    } as PmDoc
    const remotePm = {
      type: 'doc', attrs: { schemaVersion: 1 },
      content: [{ type: 'paragraph', attrs: { blockId: 'r' }, content: [{ type: 'text', text: '服务器版' }] }],
    } as PmDoc
    const store = new QingClientStore()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      sessionId: 'qing-c', docVersion: 5, contentHash: 'h5', state: 'editing',
      agentBusy: false, title: '冲突稿', ts: 't', pmDoc: remotePm,
    })))
    store.setSaveState('dsh-stash', {
      kind: 'conflict', engineSessionId: 'qing-c', expected: 4, actual: 5, message: '冲突',
    })
    store.stashConflictDoc('dsh-stash', 'qing-c', localPm)
    // 切换往返后快照仍在
    expect(store.getSnapshot('dsh-stash').conflictStash?.['qing-c']).toEqual(localPm)
    // 重载 = 显式放弃本地内容,快照与冲突一并清除
    await store.resolveConflictByReload('dsh-stash', 'qing-c')
    expect(store.getSnapshot('dsh-stash').conflictStash?.['qing-c']).toBeUndefined()
    expect(store.getSnapshot('dsh-stash').conflicts?.['qing-c']).toBeUndefined()
  })
