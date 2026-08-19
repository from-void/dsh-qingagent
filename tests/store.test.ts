// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeEvent, BridgeState, ExternalDoc, PmDoc } from '../src/contracts.js'
import { PANEL_BUSY_REFRESH_DELAY_MS, QingClientStore } from '../src/client/store.js'

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
  vi.useRealTimers()
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

  it('refreshPanel 累积多篇 docMissing，刷新别稿不清空，成功读回时只恢复当前篇', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const readable = new Set(['qing-live'])
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/state?')) {
        return Response.json({
          dshSessionId: 'dsh-missing',
          binding: {
            docs: [
              { engineSessionId: 'qing-a', title: '昨日旧稿 A', createdAt: '2026-08-15T00:00:00.000Z' },
              { engineSessionId: 'qing-b', title: '昨日旧稿 B', createdAt: '2026-08-15T00:00:30.000Z' },
              { engineSessionId: 'qing-live', title: '可用文稿', createdAt: '2026-08-15T00:01:00.000Z' },
            ],
            activeEngineSessionId: 'qing-a',
          },
          docs: [
            {
              engineSessionId: 'qing-a', title: '昨日旧稿 A', createdAt: '2026-08-15T00:00:00.000Z',
              state: 'editing', docVersion: 3,
            },
            {
              engineSessionId: 'qing-b', title: '昨日旧稿 B', createdAt: '2026-08-15T00:00:30.000Z',
              state: 'editing', docVersion: 3,
            },
            {
              engineSessionId: 'qing-live', title: '可用文稿', createdAt: '2026-08-15T00:01:00.000Z',
              state: 'editing', docVersion: 2,
            },
          ],
          activeDoc: {
            sessionId: 'qing-a', docVersion: 3, state: 'editing', agentBusy: false,
            markdown: '', qingml: '<p>旧正文</p>', title: '昨日旧稿 A',
          },
          engine: { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
        } satisfies BridgeState)
      }
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        const engineSessionId = new URL(url, 'http://local').searchParams.get('engineSessionId')!
        if (!readable.has(engineSessionId)) {
          return Response.json(
            { error: '青简会话不存在', code: 'SESSION_NOT_FOUND', nextStep: '不要重试原引用' },
            { status: 404 },
          )
        }
        return Response.json({
          sessionId: engineSessionId, docVersion: 4, contentHash: 'hash-4', state: 'editing',
          agentBusy: false, title: `恢复文稿 ${engineSessionId}`, ts: 't4',
          pmDoc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
        })
      }
      if (url.startsWith('/qingagent-bridge/review-render-model?')) {
        const engineSessionId = new URL(url, 'http://local').searchParams.get('engineSessionId')!
        return Response.json({
          sessionId: engineSessionId, docVersion: 4, state: 'editing', agentBusy: false,
          baseVersion: 4, suggestions: [],
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-missing')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-missing').state).toBeDefined())

    await expect(store.refreshPanel('dsh-missing', 'qing-a')).rejects.toMatchObject({ status: 404 })
    expect(store.getSnapshot('dsh-missing')).toMatchObject({
      docMissing: { engineSessionIds: ['qing-a'] },
      panelEngineSessionId: 'qing-a',
      panelLoading: false,
    })
    expect(store.getSnapshot('dsh-missing').panelDoc).toBeUndefined()

    await store.refreshPanel('dsh-missing', 'qing-live')
    expect(store.getSnapshot('dsh-missing').docMissing).toEqual({ engineSessionIds: ['qing-a'] })

    await expect(store.refreshPanel('dsh-missing', 'qing-b')).rejects.toMatchObject({ status: 404 })
    expect(store.getSnapshot('dsh-missing').docMissing).toEqual({ engineSessionIds: ['qing-a', 'qing-b'] })

    await expect(store.refreshPanel('dsh-missing', 'qing-a')).rejects.toMatchObject({ status: 404 })
    expect(store.getSnapshot('dsh-missing').docMissing).toEqual({ engineSessionIds: ['qing-a', 'qing-b'] })
    expect(store.getSnapshot('dsh-missing').state?.docs.map((doc) => doc.engineSessionId))
      .toEqual(['qing-a', 'qing-b', 'qing-live'])

    readable.add('qing-a')
    await store.refreshPanel('dsh-missing', 'qing-a')
    expect(store.getSnapshot('dsh-missing').docMissing).toEqual({ engineSessionIds: ['qing-b'] })
    expect(store.getSnapshot('dsh-missing').panelDoc).toMatchObject({ title: '恢复文稿 qing-a', docVersion: 4 })

    readable.add('qing-b')
    await store.refreshPanel('dsh-missing', 'qing-b')
    expect(store.getSnapshot('dsh-missing').docMissing).toBeUndefined()
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

    store.applyReviewCommit('dsh-commit', 'qing-1', 4)

    expect(store.getSnapshot('dsh-commit')).toMatchObject({
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

  it('doc-committed 携带 QingML 时先乐观推进 panelDoc，再等待权威 PM 读回', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const authoritativePanel = deferred<{
      sessionId: string
      docVersion: number
      contentHash: string
      state: 'editing'
      agentBusy: boolean
      title: string
      ts: string
      pmDoc: PmDoc | null | undefined
    }>()
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
        return Response.json(await authoritativePanel.promise)
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
      revealWholeDraft: true,
      doc: {
        sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
        markdown: '乐观正文', qingml: '<p>乐观正文</p>', title: '新稿',
      },
      blocks: 1, words: 4,
    })

    await vi.waitFor(() => expect(store.getSnapshot('dsh-optimistic').panelDoc?.docVersion).toBe(2))
    expect(JSON.stringify(store.getSnapshot('dsh-optimistic').panelDoc?.pmDoc)).toContain('乐观正文')
    expect(store.getSnapshot('dsh-optimistic').revealRequest).toEqual({
      engineSessionId: 'qing-1', docVersion: 2, nonce: 1,
    })
    store.finishReveal('dsh-optimistic', 1)
    expect(store.getSnapshot('dsh-optimistic').revealRequest).toBeUndefined()
    expect(beforeApply).toHaveBeenCalledWith('qing-1', expect.objectContaining({ docVersion: 2 }))
    expect(panelReads).toBe(3)

    authoritativePanel.resolve({
      sessionId: 'qing-1', docVersion: 2, contentHash: 'hash-2', state: 'editing',
      agentBusy: false, title: '新稿', ts: 't2', pmDoc: store.getSnapshot('dsh-optimistic').panelDoc?.pmDoc,
    })
    await vi.waitFor(() => expect(store.getSnapshot('dsh-optimistic').panelLoading).toBe(false))
    release()
  })

  it('普通 doc-committed 静默刷新，不创建整稿 reveal 请求', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/state?')) return Response.json(bridgeState())
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 2, contentHash: 'hash-2', state: 'editing',
          agentBusy: false, title: '局部编辑稿', ts: 't2',
          pmDoc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
        })
      }
      if (url.startsWith('/qingagent-bridge/review-render-model?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          baseVersion: 2, suggestions: [],
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-silent-commit')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-silent-commit').state).toBeDefined())

    FakeEventSource.instances.at(-1)?.emit({
      type: 'doc-committed', engineSessionId: 'qing-1',
      doc: {
        sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
        markdown: '局部修改', qingml: '<p>局部修改</p>', title: '局部编辑稿',
      },
      blocks: 1, words: 4,
    })

    expect(store.getSnapshot('dsh-silent-commit').revealRequest).toBeUndefined()
    release()
  })

  it('收到 turn-ended 后重拉当前活跃稿并清除各状态域的 busy 缓存', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    let agentBusy = true
    let charCount = 8
    let panelReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/state?')) {
        const state = bridgeState()
        state.activeDoc!.agentBusy = agentBusy
        state.docs[0]!.agentBusy = agentBusy
        return Response.json(state)
      }
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        panelReads += 1
        return Response.json({
          sessionId: 'qing-1', docVersion: 2, contentHash: 'hash-2', state: 'editing',
          agentBusy, title: '测试稿', ts: 't2', charCount,
          pmDoc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
        })
      }
      if (url.startsWith('/qingagent-bridge/review-render-model?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy,
          baseVersion: 2, suggestions: [],
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-turn-ended')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-turn-ended').state).toBeDefined())
    await store.refreshPanel('dsh-turn-ended', 'qing-1')
    expect(store.getSnapshot('dsh-turn-ended').panelDoc?.agentBusy).toBe(true)

    agentBusy = false
    charCount = 24
    FakeEventSource.instances.at(-1)?.emit({
      type: 'turn-ended', engineSessionIds: ['qing-1'],
    })

    await vi.waitFor(() => expect(store.getSnapshot('dsh-turn-ended').panelDoc?.agentBusy).toBe(false))
    const snapshot = store.getSnapshot('dsh-turn-ended')
    expect(snapshot.activeDoc?.agentBusy).toBe(false)
    expect(snapshot.state?.docs[0]?.agentBusy).toBe(false)
    expect(snapshot.words).toBe(24)
    expect(panelReads).toBe(2)
    release()
  })

  it.each(['panelDoc', 'activeDoc', 'activeBound'] as const)(
    '%s 单独滞留 busy 90 秒且无后续事件时也只兜底重拉一次',
    async (source) => {
    vi.stubGlobal('EventSource', FakeEventSource)
    let panelReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/state?')) return Response.json(bridgeState())
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        panelReads += 1
        return Response.json({
          sessionId: 'qing-1', docVersion: 1, contentHash: 'hash-1', state: 'editing',
          agentBusy: false, title: '测试稿', ts: 't1', charCount: 12,
          pmDoc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
        })
      }
      if (url.startsWith('/qingagent-bridge/review-render-model?')) {
        return Response.json({
          sessionId: 'qing-1', docVersion: 1, state: 'editing', agentBusy: false,
          baseVersion: 1, suggestions: [],
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-busy-fallback')
    await vi.waitFor(() => expect(store.getSnapshot('dsh-busy-fallback').state).toBeDefined())
    await store.refreshPanel('dsh-busy-fallback', 'qing-1')
    const stale = store.getSnapshot('dsh-busy-fallback')
    if (source === 'panelDoc') stale.panelDoc!.agentBusy = true
    if (source === 'activeDoc') stale.activeDoc!.agentBusy = true
    if (source === 'activeBound') stale.state!.docs[0]!.agentBusy = true
    vi.useFakeTimers()
    // 触发一次正常 store 发布，让兜底计时器从与渲染相同的三域 busy 口径启动。
    store.setSaveState('dsh-busy-fallback', { kind: 'idle' })

    await vi.advanceTimersByTimeAsync(PANEL_BUSY_REFRESH_DELAY_MS - 1)
    expect(panelReads).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(panelReads).toBe(2)
    const refreshed = store.getSnapshot('dsh-busy-fallback')
    expect(refreshed.panelDoc?.agentBusy).toBe(false)
    expect(refreshed.activeDoc?.agentBusy).toBe(false)
    expect(refreshed.state?.docs[0]?.agentBusy).toBe(false)
    await vi.advanceTimersByTimeAsync(PANEL_BUSY_REFRESH_DELAY_MS * 2)
    expect(panelReads).toBe(2)
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
