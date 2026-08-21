import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BindingStore } from '../src/bindings.js'
import { BridgeHub, type BridgeDocStateObserver } from '../src/bridge.js'
import type { ExternalDoc, SessionBinding } from '../src/contracts.js'
import { DocStateCache } from '../src/docState.js'
import type { EngineService } from '../src/engine.js'
import { EngineHttpError } from '../src/engine.js'
import { createBridgeDocStateObserver } from '../src/index.js'
import { PendingTitleCoordinator } from '../src/pendingTitle.js'
import type { TelemetryCapture } from '../src/telemetry.js'
import { reviewTurnCoordinatorFor } from '../src/reviewTurn.js'

interface CapturedResponse {
  status?: number
  headers?: Record<string, unknown>
  headersSent: boolean
  destroyed: boolean
  ended: boolean
  body: string
  writes: string[]
  writeHead(status: number, headers?: Record<string, unknown>): CapturedResponse
  write(chunk: unknown): boolean
  end(chunk?: unknown): CapturedResponse
}

function response(): CapturedResponse {
  return {
    headersSent: false,
    destroyed: false,
    ended: false,
    body: '',
    writes: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this },
    write(chunk) { this.writes.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.ended = true; return this },
  }
}

function request(
  method: string,
  url: string,
  remoteAddress = '127.0.0.1',
  body?: unknown,
): IncomingMessage & EventEmitter {
  const req = (body === undefined ? new EventEmitter() : Readable.from([JSON.stringify(body)])) as IncomingMessage & EventEmitter
  Object.assign(req, { method, url, socket: { remoteAddress } })
  return req
}

function fixture(
  bindingsBySession: Record<string, SessionBinding>,
  docStateObserver?: BridgeDocStateObserver,
) {
  let handler: ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>) | undefined
  const lifecycle: Array<() => void> = []
  const ctx = {
    webServer: {
      register: vi.fn((route: { handler: typeof handler }) => { handler = route.handler; return vi.fn() }),
    },
    effect: (setup: () => () => void) => { lifecycle.push(setup()); return vi.fn() },
  } as unknown as Context
  const engine = {
    status: vi.fn(async () => ({
      state: 'online',
      engineUrl: 'http://127.0.0.1:8080',
      clientInstalled: true,
      clientExecutablePath: 'D:\\Qingjian\\qingagent.exe',
    })),
    fetchJson: vi.fn(async () => ({
      sessionId: 'qing-a', docVersion: 1, state: 'editing', agentBusy: false,
      markdown: '', qingml: '<p>正文</p>', title: '文稿',
    } satisfies ExternalDoc)),
    fetchAsset: vi.fn(async () => new Response('image-bytes', {
      status: 200,
      headers: { 'Content-Type': 'image/png', ETag: 'asset-v1' },
    })),
    fetchInternal: vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })),
    launchInstalledClient: vi.fn(async () => true),
  } as unknown as EngineService
  const bindings = {
    getBinding: (sessionId: string) => bindingsBySession[sessionId] ?? { docs: [] },
    getActive: (sessionId: string) => {
      const binding = bindingsBySession[sessionId]
      return binding?.docs.find((doc) => doc.engineSessionId === binding.activeEngineSessionId)
    },
    hasDoc: (sessionId: string, engineSessionId: string) =>
      (bindingsBySession[sessionId]?.docs ?? []).some((doc) => doc.engineSessionId === engineSessionId),
    setActive: vi.fn(),
    adoptDoc: vi.fn(),
    updateTitle: vi.fn(async () => undefined),
  } as unknown as BindingStore
  const telemetry = { capture: vi.fn(async () => undefined) } as unknown as TelemetryCapture
  const hub = new BridgeHub(ctx, engine, bindings, undefined, undefined, telemetry, docStateObserver)
  hub.mount()
  return {
    ctx,
    hub,
    engine,
    bindings,
    telemetry,
    handler: handler!,
    dispose: () => { for (const cleanup of lifecycle.reverse()) cleanup() },
  }
}

describe('BridgeHub', () => {
  it('审查 bridge 按契约代理 external 模板、补充要求、词库与素材，并维护 pending 标记', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    vi.mocked(engine.fetchInternal).mockImplementation(async (path) => {
      const value = path.startsWith('/external/review-templates?')
        ? { templates: [{ id: 'review-source-default', type: 'source', selected: true }] }
        : path.endsWith('/select')
          ? { selected: true, id: 'review-source-default', type: 'source' }
          : path.includes('/review-supplement')
            ? { supplement: '重点核对数字' }
            : path === '/external/lexicons'
              ? { lexicons: [{ id: 'lexicon-ad', name: '广告词', entryCount: 2, enabled: true }] }
              : path.endsWith('/files')
                ? { materials: [{ id: 'material-1', parseState: 'ready' }] }
                : { ok: true }
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const marked = response()
    await handler(request('POST', '/qingagent-bridge/review-turn', '127.0.0.1', {
      dshSessionId: 'dsh-a', engineSessionId: 'qing-a', type: 'source',
      templateId: 'review-source-default', templateName: '来源核查',
    }), marked as unknown as ServerResponse)
    expect(marked.status).toBe(200)
    const state = reviewTurnCoordinatorFor(engine)
    expect(state.activate('dsh-a', 8)).toMatchObject({
      type: 'source', turnId: 8, targetEngineSessionId: 'qing-a',
    })
    state.finish('dsh-a', 8)

    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/qingagent-bridge/review-templates?type=source'],
      ['POST', '/qingagent-bridge/review-templates/select', { type: 'source', templateId: 'review-source-default' }],
      ['GET', '/qingagent-bridge/review-supplement?dshSessionId=dsh-a&engineSessionId=qing-a&type=source&templateId=review-source-default'],
      ['PUT', '/qingagent-bridge/review-supplement?dshSessionId=dsh-a&engineSessionId=qing-a&type=source&templateId=review-source-default', { supplement: '重点核对数字' }],
      ['GET', '/qingagent-bridge/lexicons'],
      ['GET', '/qingagent-bridge/review-materials?dshSessionId=dsh-a&engineSessionId=qing-a'],
    ]
    for (const [method, url, body] of calls) {
      const res = response()
      await handler(request(method, url, '127.0.0.1', body), res as unknown as ServerResponse)
      expect(res.status).toBe(200)
    }
    expect(vi.mocked(engine.fetchInternal).mock.calls.map(([path]) => path)).toEqual([
      '/external/review-templates?type=source',
      '/external/review-templates/review-source-default/select',
      '/external/sessions/qing-a/review-supplement?type=source&templateId=review-source-default',
      '/external/sessions/qing-a/review-supplement?type=source&templateId=review-source-default',
      '/external/lexicons',
      '/external/sessions/qing-a/files',
    ])
    dispose()
  })

  it('telemetry route 只接受严格白名单，非法事件与任意字符串均拒绝且不外发', async () => {
    const { handler, telemetry, dispose } = fixture({})
    const accepted = response()
    await handler(request('POST', '/qingagent-bridge/telemetry', '127.0.0.1', {
      event: 'panel_opened', properties: { source: 'tool_card' },
    }), accepted as unknown as ServerResponse)
    expect(accepted.status).toBe(202)
    expect(telemetry.capture).toHaveBeenCalledWith('panel_opened', { source: 'tool_card' })

    vi.mocked(telemetry.capture).mockClear()
    for (const body of [
      { event: 'draft_created', properties: { words_bucket: 'secret' } },
      { event: 'feedback_clicked', properties: { target: 'bug', message: 'private text' } },
      { event: 'update_clicked', properties: { from_version: '/home/alice/token', to_version: '0.2.0' } },
      { event: 'doc_missing_shown', properties: { title: '不应外发' } },
    ]) {
      const rejected = response()
      await handler(
        request('POST', '/qingagent-bridge/telemetry', '127.0.0.1', body),
        rejected as unknown as ServerResponse,
      )
      expect(rejected.status).toBe(400)
    }
    expect(telemetry.capture).not.toHaveBeenCalled()
    dispose()
  })

  it('拒绝非回环地址', async () => {
    const { handler, dispose } = fixture({})
    const res = response()
    await handler(request('GET', '/qingagent-bridge/state?dshSessionId=dsh-a', '10.0.0.8'), res as unknown as ServerResponse)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'QingAgent bridge 仅允许本机访问。' })
    dispose()
  })

  it('/state 沿现有 engine 载荷透传客户端安装结果', async () => {
    const { handler, dispose } = fixture({})
    const res = response()
    await handler(request('GET', '/qingagent-bridge/state?dshSessionId=dsh-a'), res as unknown as ServerResponse)

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).engine).toMatchObject({
      state: 'online',
      clientInstalled: true,
      clientExecutablePath: 'D:\\Qingjian\\qingagent.exe',
    })
    dispose()
  })

  it('/state 只剔除 404 + SESSION_NOT_FOUND，其他读取失败保留为 offline', async () => {
    const binding = {
      docs: [
        { engineSessionId: 'qing-missing', title: '已删稿', createdAt: '2026-08-15T00:00:00.000Z' },
        { engineSessionId: 'qing-error-only', title: '字段误导稿', createdAt: '2026-08-15T00:01:00.000Z' },
        { engineSessionId: 'qing-offline', title: '暂时离线稿', createdAt: '2026-08-15T00:02:00.000Z' },
        { engineSessionId: 'qing-live', title: '仍在稿', createdAt: '2026-08-15T00:03:00.000Z' },
      ],
      activeEngineSessionId: 'qing-missing',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    vi.mocked(engine.fetchJson).mockImplementation(async (path) => {
      if (path.includes('qing-missing')) {
        throw new EngineHttpError(404, { error: '青简会话不存在', code: 'SESSION_NOT_FOUND' })
      }
      if (path.includes('qing-error-only')) {
        throw new EngineHttpError(404, { error: 'SESSION_NOT_FOUND' })
      }
      if (path.includes('qing-offline')) {
        throw new EngineHttpError(500, { error: '引擎暂时不可用', code: 'SESSION_NOT_FOUND' })
      }
      return {
        sessionId: 'qing-live', docVersion: 7, state: 'editing', agentBusy: false,
        markdown: '', qingml: '<p>正文</p>', title: '仍在稿',
      }
    })
    const res = response()

    await handler(
      request('GET', '/qingagent-bridge/state?dshSessionId=dsh-a'),
      res as unknown as ServerResponse,
    )

    const state = JSON.parse(res.body)
    expect(state.binding.docs).toHaveLength(4)
    expect(state.docs).toEqual([
      expect.objectContaining({ engineSessionId: 'qing-error-only', state: 'offline' }),
      expect.objectContaining({ engineSessionId: 'qing-offline', state: 'offline' }),
      expect.objectContaining({ engineSessionId: 'qing-live', state: 'editing', docVersion: 7 }),
    ])
    expect(state.activeDoc).toBeUndefined()
    dispose()
  })

  it('启动端点不解析客户端路径，只调用 host 无参启动器', async () => {
    const { handler, engine, dispose } = fixture({})
    const res = response()
    await handler(
      request('POST', '/qingagent-bridge/launch-client', '127.0.0.1', { path: 'C:\\evil.exe' }),
      res as unknown as ServerResponse,
    )

    expect(res.status).toBe(202)
    expect(JSON.parse(res.body)).toEqual({ launched: true })
    expect(engine.launchInstalledClient).toHaveBeenCalledWith()

    const rejected = response()
    await handler(
      request('POST', '/qingagent-bridge/launch-client?path=C%3A%5Cevil.exe'),
      rejected as unknown as ServerResponse,
    )
    expect(rejected.status).toBe(400)
    expect(engine.launchInstalledClient).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('双会话 SSE 事件严格隔离，连接 close 后释放订阅', async () => {
    const { hub, handler, dispose } = fixture({})
    const reqA = request('GET', '/qingagent-bridge/stream?dshSessionId=dsh-a')
    const reqB = request('GET', '/qingagent-bridge/stream?dshSessionId=dsh-b')
    const resA = response()
    const resB = response()
    await handler(reqA, resA as unknown as ServerResponse)
    await handler(reqB, resB as unknown as ServerResponse)

    hub.emit('dsh-a', {
      type: 'doc-committed',
      engineSessionId: 'qing-a',
      doc: {
        sessionId: 'qing-a', docVersion: 1, state: 'editing', agentBusy: false,
        markdown: '', qingml: '<p>正文</p>', title: '文稿',
      },
      blocks: 1,
      words: 2,
    })

    expect(resA.writes.join('')).toContain('event: doc-committed')
    expect(resB.writes.join('')).not.toContain('event: doc-committed')
    expect((hub as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(2)

    reqA.emit('close')
    expect((hub as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(1)
    expect(resA.ended).toBe(true)
    reqB.emit('close')
    expect((hub as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(0)
    dispose()
  })

  it('跨会话读取 /doc 返回 404，且不访问引擎', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const res = response()
    await handler(
      request('GET', '/qingagent-bridge/doc?dshSessionId=dsh-b&engineSessionId=qing-a'),
      res as unknown as ServerResponse,
    )
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: '文稿不属于当前 DSH 会话。' })
    expect(engine.fetchJson).not.toHaveBeenCalled()
    dispose()
  })

  it('/doc 与 PM 路由共用 authorizedEngineSessionId 授权并代理活跃绑定稿', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const res = response()

    await handler(
      request('GET', '/qingagent-bridge/doc?dshSessionId=dsh-a&engineSessionId=qing-a'),
      res as unknown as ServerResponse,
    )

    expect(res.status).toBe(200)
    expect(engine.fetchJson).toHaveBeenCalledWith('/sessions/qing-a/doc?format=qingml')
    dispose()
  })

  it('选段按 dsh 会话存取清，doc-committed 后也自动清除', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { hub, handler, dispose } = fixture({ 'dsh-a': binding })
    const selection = {
      dshSessionId: 'dsh-a',
      engineSessionId: 'qing-a',
      quote: '需要修改的原文',
      anchor: { blockId: 'block-1', from: 3, to: 11 },
    }

    const stored = response()
    await handler(
      request('POST', '/qingagent-bridge/selection', '127.0.0.1', selection),
      stored as unknown as ServerResponse,
    )
    expect(stored.status).toBe(200)
    expect(hub.getSelection('dsh-a')).toEqual(selection)

    const read = response()
    await handler(
      request('GET', '/qingagent-bridge/selection?dshSessionId=dsh-a'),
      read as unknown as ServerResponse,
    )
    expect(JSON.parse(read.body)).toEqual({ selection })

    const cleared = response()
    await handler(
      request('DELETE', '/qingagent-bridge/selection?dshSessionId=dsh-a'),
      cleared as unknown as ServerResponse,
    )
    expect(cleared.status).toBe(200)
    expect(hub.getSelection('dsh-a')).toBeUndefined()

    await handler(
      request('POST', '/qingagent-bridge/selection', '127.0.0.1', selection),
      response() as unknown as ServerResponse,
    )
    const streamRequest = request('GET', '/qingagent-bridge/stream?dshSessionId=dsh-a')
    const streamResponse = response()
    await handler(streamRequest, streamResponse as unknown as ServerResponse)
    hub.clearSelection('dsh-a')
    expect(hub.getSelection('dsh-a')).toBeUndefined()
    expect(streamResponse.writes.join('')).toContain('event: selection-changed')
    expect(streamResponse.writes.join('')).toContain('"selection":null')

    await handler(
      request('POST', '/qingagent-bridge/selection', '127.0.0.1', selection),
      response() as unknown as ServerResponse,
    )
    hub.emit('dsh-a', {
      type: 'doc-committed',
      engineSessionId: 'qing-a',
      doc: {
        sessionId: 'qing-a', docVersion: 2, state: 'editing', agentBusy: false,
        markdown: '', qingml: '<p>新稿</p>', title: 'A',
      },
      blocks: 1,
      words: 2,
    })
    expect(hub.getSelection('dsh-a')).toBeUndefined()
    streamRequest.emit('close')
    dispose()
  })

  it('PM 文档、审阅渲染模型与 verdict/commit 均按绑定会话代理到 external API', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const fetchJson = vi.mocked(engine.fetchJson)
    fetchJson.mockImplementation(async (path) => ({ path }))

    const pm = response()
    await handler(
      request('GET', '/qingagent-bridge/doc-pm?dshSessionId=dsh-a&engineSessionId=qing-a'),
      pm as unknown as ServerResponse,
    )
    expect(pm.status).toBe(200)
    expect(fetchJson).toHaveBeenCalledWith('/sessions/qing-a/doc?format=pm')

    fetchJson.mockResolvedValueOnce({
      sessionId: 'qing-a', docVersion: 2, state: 'editing', agentBusy: false,
      baseVersion: 2, suggestions: [], annotations: [{
        id: 'annotation-1', summary: '事实有误', note: '与材料不一致', origin: 'source-check',
        status: 'reviewing', anchors: [{ blockId: 'p-1', pmFrom: 1, pmTo: 3, quote: '正文' }],
      }],
    })
    const review = response()
    await handler(
      request('GET', '/qingagent-bridge/review-render-model?dshSessionId=dsh-a&engineSessionId=qing-a'),
      review as unknown as ServerResponse,
    )
    expect(fetchJson).toHaveBeenCalledWith('/sessions/qing-a/review?format=render-model')
    expect(JSON.parse(review.body)).toMatchObject({
      annotations: [{ id: 'annotation-1', status: 'reviewing' }],
    })

    const verdictBody = { expectedDocVersion: 3, patchId: 'p-1', verdict: 'rejected' }
    const verdict = response()
    await handler(
      request(
        'POST',
        '/qingagent-bridge/review-verdicts?dshSessionId=dsh-a&engineSessionId=qing-a',
        '127.0.0.1',
        verdictBody,
      ),
      verdict as unknown as ServerResponse,
    )
    expect(fetchJson).toHaveBeenCalledWith('/sessions/qing-a/review/verdicts', {
      method: 'POST', body: JSON.stringify(verdictBody),
    })

    const ignoreBody = { expectedDocVersion: 3, annotationIds: ['annotation-1'] }
    const ignore = response()
    await handler(
      request(
        'POST',
        '/qingagent-bridge/review-annotations-ignore?dshSessionId=dsh-a&engineSessionId=qing-a',
        '127.0.0.1',
        ignoreBody,
      ),
      ignore as unknown as ServerResponse,
    )
    expect(fetchJson).toHaveBeenCalledWith('/sessions/qing-a/review/annotations/ignore', {
      method: 'POST', body: JSON.stringify(ignoreBody),
    })

    const commitBody = { expectedDocVersion: 3, action: 'commit' }
    const commit = response()
    await handler(
      request(
        'POST',
        '/qingagent-bridge/review-commit?dshSessionId=dsh-a&engineSessionId=qing-a',
        '127.0.0.1',
        commitBody,
      ),
      commit as unknown as ServerResponse,
    )
    expect(fetchJson).toHaveBeenCalledWith('/sessions/qing-a/review/commit', {
      method: 'POST', body: JSON.stringify(commitBody),
    })
    dispose()
  })

  it('面板直写与审阅裁决成功后都通知同一份文稿状态缓存', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const documentChanged = vi.fn(async () => undefined)
    const { handler, hub, engine, dispose } = fixture(
      { 'dsh-a': binding },
      { documentChanged },
    )
    const emit = vi.spyOn(hub, 'emit')
    vi.mocked(engine.fetchJson).mockImplementation(async (path) => {
      if (path.endsWith('/review/verdicts')) {
        return { status: 'marked', docVersion: 3, patchIds: ['p-1'], verdict: 'accepted', reviewingCount: 0, seq: 1 }
      }
      if (path.endsWith('/review/commit')) {
        return {
          status: 'reviewed', docVersion: 4, acceptedCount: 1, rejectedCount: 0,
          remainingCount: 0, outcomeQueued: true,
          outcome: { acceptedCount: 1, rejectedCount: 0, hunks: [] }, seq: 2,
        }
      }
      if (path.endsWith('/doc')) {
        return { ok: true, clientMutationId: 'mutation-1', docVersion: 5, contentHash: 'hash-5', ts: 'now', charCount: 8 }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await handler(request(
      'POST',
      '/qingagent-bridge/review-verdicts?dshSessionId=dsh-a&engineSessionId=qing-a',
      '127.0.0.1',
      { expectedDocVersion: 3, patchId: 'p-1', verdict: 'accepted' },
    ), response() as unknown as ServerResponse)
    await handler(request(
      'POST',
      '/qingagent-bridge/review-commit?dshSessionId=dsh-a&engineSessionId=qing-a',
      '127.0.0.1',
      { expectedDocVersion: 3, action: 'commit' },
    ), response() as unknown as ServerResponse)
    await handler(request(
      'PUT',
      '/qingagent-bridge/doc-pm?dshSessionId=dsh-a&engineSessionId=qing-a',
      '127.0.0.1',
      {
        expectedDocumentSnapshot: 4,
        baseContentHash: 'hash-4',
        clientMutationId: 'mutation-1',
        doc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
      },
    ), response() as unknown as ServerResponse)

    expect(documentChanged).toHaveBeenCalledTimes(3)
    expect(documentChanged).toHaveBeenNthCalledWith(1, 'dsh-a', 'qing-a')
    expect(documentChanged).toHaveBeenNthCalledWith(2, 'dsh-a', 'qing-a')
    expect(documentChanged).toHaveBeenNthCalledWith(3, 'dsh-a', 'qing-a')
    expect(emit).toHaveBeenCalledWith('dsh-a', {
      type: 'turn-ended', engineSessionIds: ['qing-a'],
    })
    dispose()
  })

  it('文稿变化先收敛标题结算，删除通知会清掉对应扣留槽', async () => {
    const runtime = fixture({})
    const pendingTitles = {
      settlePendingTitle: vi.fn(async () => 'none'),
      clearDocument: vi.fn(),
    } as unknown as PendingTitleCoordinator
    const observer = createBridgeDocStateObserver(
      runtime.ctx,
      runtime.engine,
      runtime.bindings,
      new DocStateCache(),
      pendingTitles,
    )

    await observer.documentChanged('dsh-a', 'qing-a')
    await observer.documentDeleted?.('dsh-a', 'qing-a')

    expect(pendingTitles.settlePendingTitle).toHaveBeenCalledWith('dsh-a', 'qing-a')
    expect(pendingTitles.clearDocument).toHaveBeenCalledWith('dsh-a', 'qing-a')
    runtime.dispose()
  })

  it('review-commit 后只刷新 system context 权威摘要，不再另走 agent.inject', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: '旧标题', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    let delegate: BridgeDocStateObserver | undefined
    const forwardingObserver: BridgeDocStateObserver = {
      documentChanged: (...args) => delegate!.documentChanged(...args),
    }
    const runtime = fixture({ 'dsh-a': binding }, forwardingObserver)
    const inject = vi.fn()
    Object.assign(runtime.ctx, {
      agents: { list: () => [{ id: 'dsh-a', inject }] },
    })
    const cache = new DocStateCache()
    cache.update('dsh-a', {
      state: 'pendingReview', words: 99, blocks: 9, structure: '旧结构',
      title: '旧标题', docVersion: 3, patchCount: 1,
    })
    delegate = createBridgeDocStateObserver(runtime.ctx, runtime.engine, runtime.bindings, cache)
    vi.mocked(runtime.engine.fetchJson).mockImplementation(async (path) => {
      if (path.endsWith('/review/commit')) {
        return {
          status: 'reviewed', docVersion: 4, acceptedCount: 1, rejectedCount: 0,
          remainingCount: 0, outcomeQueued: true,
          outcome: { acceptedCount: 1, rejectedCount: 0, hunks: [] }, seq: 2,
        }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return {
          sessionId: 'qing-a', docVersion: 4, state: 'editing', agentBusy: false,
          markdown: '# 新章\n\n机密正文。',
          qingml: '<title>新标题</title><h1>新章</h1><p>机密正文。</p>',
          title: '新标题',
        } satisfies ExternalDoc
      }
      if (path.endsWith('/doc?format=pm')) {
        return {
          sessionId: 'qing-a', docVersion: 4, contentHash: 'hash-4', state: 'editing',
          agentBusy: false, title: '新标题', ts: 'now', charCount: 7,
          pmDoc: {
            type: 'doc', attrs: { schemaVersion: 1 }, content: [
              { type: 'heading', attrs: { blockId: 'h-1', level: 1 }, content: [{ type: 'text', text: '新章' }] },
              { type: 'paragraph', attrs: { blockId: 'p-1' }, content: [{ type: 'text', text: '机密正文。' }] },
            ],
          },
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await runtime.handler(request(
      'POST',
      '/qingagent-bridge/review-commit?dshSessionId=dsh-a&engineSessionId=qing-a',
      '127.0.0.1',
      { expectedDocVersion: 3, action: 'commit' },
    ), response() as unknown as ServerResponse)

    expect(inject).not.toHaveBeenCalled()
    const text = cache.contextText('dsh-a')
    expect(text).toContain('【文稿状态】已落库生效,无待审稿。')
    expect(text).toContain('《新标题》｜一个标题加 1 段正文｜约 7 字')
    expect(text).not.toMatch(/机密正文|pendingReview|docRef|blockId|qing-a/u)
    runtime.dispose()
  })

  it('直写完整透传 frozen baseline，并保留引擎 409 冲突响应', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const write = {
      expectedDocumentSnapshot: 7,
      baseContentHash: 'hash-7',
      clientMutationId: 'mutation-1',
      doc: { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
    }
    vi.mocked(engine.fetchJson).mockRejectedValueOnce(new EngineHttpError(409, {
      ok: false,
      clientMutationId: 'mutation-1',
      code: 'VERSION_CONFLICT',
      conflict: { expected: 7, actual: 8 },
      actualContentHash: 'hash-8',
    }))
    const res = response()
    await handler(
      request(
        'PUT',
        '/qingagent-bridge/doc-pm?dshSessionId=dsh-a&engineSessionId=qing-a',
        '127.0.0.1',
        write,
      ),
      res as unknown as ServerResponse,
    )

    expect(engine.fetchJson).toHaveBeenCalledWith('/sessions/qing-a/doc', {
      method: 'PUT', body: JSON.stringify(write),
    })
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false, code: 'VERSION_CONFLICT', conflict: { expected: 7, actual: 8 },
    })
    dispose()
  })

  it('资产上传按真实 JSON 契约写入 mock 引擎，并经会话资产端点代理读回', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const body = {
      filename: '插图.png',
      mimeType: 'image/png',
      base64: 'aW1n',
    }
    vi.mocked(engine.fetchJson).mockResolvedValueOnce({
      fileId: '550e8400-e29b-41d4-a716-446655440000',
      filename: '插图.png',
      mimeType: 'image/png',
      size: 3,
      src: '/api/v1/files/550e8400-e29b-41d4-a716-446655440000/%E6%8F%92%E5%9B%BE.png',
    })
    const res = response()

    await handler(
      request(
        'POST',
        '/qingagent-bridge/assets?dshSessionId=dsh-a&engineSessionId=qing-a',
        '127.0.0.1',
        body,
      ),
      res as unknown as ServerResponse,
    )

    expect(res.status).toBe(200)
    expect(engine.fetchJson).toHaveBeenCalledWith('/sessions/qing-a/assets', {
      method: 'POST', body: JSON.stringify(body),
    })
    const uploaded = JSON.parse(res.body) as { fileId: string; src: string }
    expect(uploaded).toMatchObject({ fileId: '550e8400-e29b-41d4-a716-446655440000' })

    const image = response()
    await handler(
      request('GET', `/qingagent-bridge/assets?dshSessionId=dsh-a&engineSessionId=qing-a&ref=${encodeURIComponent(uploaded.src)}`),
      image as unknown as ServerResponse,
    )
    expect(engine.fetchAsset).toHaveBeenCalledWith(
      '/sessions/qing-a/assets/550e8400-e29b-41d4-a716-446655440000',
      { method: 'GET' },
    )
    expect(image.body).toBe('image-bytes')
    dispose()
  })

  it('资产读取只接受引擎资产路径，并由宿主携 token 取回二进制', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, dispose } = fixture({ 'dsh-a': binding })
    const reference = '/api/v1/files/550e8400-e29b-41d4-a716-446655440000/%E6%8F%92%E5%9B%BE.png'
    const res = response()

    await handler(
      request('GET', `/qingagent-bridge/assets?dshSessionId=dsh-a&engineSessionId=qing-a&ref=${encodeURIComponent(reference)}`),
      res as unknown as ServerResponse,
    )

    expect(engine.fetchAsset).toHaveBeenCalledWith(
      '/sessions/qing-a/assets/550e8400-e29b-41d4-a716-446655440000',
      { method: 'GET' },
    )
    expect(res.status).toBe(200)
    expect(res.headers?.['Content-Type']).toBe('image/png')
    expect(res.body).toBe('image-bytes')

    const rejected = response()
    await handler(
      request('GET', '/qingagent-bridge/assets?dshSessionId=dsh-a&engineSessionId=qing-a&ref=https%3A%2F%2Fevil.example%2Fx'),
      rejected as unknown as ServerResponse,
    )
    expect(rejected.status).toBe(400)
    expect(engine.fetchAsset).toHaveBeenCalledOnce()
    dispose()
  })
})

describe('青简文库', () => {
  it('/library 返回引擎最近文稿并映射字段', async () => {
    const { handler, engine, dispose } = fixture({})
    ;(engine.fetchJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessions: [
        { id: 'qing-lib-1', title: '山顶邮局', state: 'editing', updatedAt: '2026-08-15T12:00:00.000Z' },
        { id: 'qing-lib-2', title: null, state: 'pendingReview', updatedAt: '2026-08-15T11:00:00.000Z' },
      ],
      total: 2, hasMore: false,
    })
    const res = response()
    await handler(
      request('GET', '/qingagent-bridge/library?dshSessionId=dsh-a&limit=10'),
      res as unknown as ServerResponse,
    )
    expect(res.status).toBe(200)
    expect((engine.fetchJson as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('/sessions?limit=10')
    expect(JSON.parse(res.body)).toEqual({
      library: [
        { engineSessionId: 'qing-lib-1', title: '山顶邮局', state: 'editing', updatedAt: '2026-08-15T12:00:00.000Z' },
        { engineSessionId: 'qing-lib-2', title: '未命名文稿', state: 'pendingReview', updatedAt: '2026-08-15T11:00:00.000Z' },
      ],
    })
    dispose()
  })

  it('/focus adopt 未绑定文稿:先探引擎存在再收养;已绑定走 setActive', async () => {
    const binding = {
      docs: [{ engineSessionId: 'qing-a', title: 'A', createdAt: '2026-08-15T00:00:00.000Z' }],
      activeEngineSessionId: 'qing-a',
    }
    const { handler, engine, bindings, dispose } = fixture({ 'dsh-a': binding })
    const res = response()
    await handler(
      request('POST', '/qingagent-bridge/focus', '127.0.0.1', {
        dshSessionId: 'dsh-a', engineSessionId: 'qing-new', adopt: true, title: '外部文稿',
      }),
      res as unknown as ServerResponse,
    )
    expect(res.status).toBe(200)
    expect((engine.fetchJson as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])
      .toBe('/sessions/qing-new/doc?lines=1')
    expect((bindings as unknown as { adoptDoc: ReturnType<typeof vi.fn> }).adoptDoc)
      .toHaveBeenCalledWith('dsh-a', 'qing-new', '外部文稿')

    // 已绑定 + adopt → 只切换,不重复收养、不探引擎
    ;(engine.fetchJson as ReturnType<typeof vi.fn>).mockClear()
    const res2 = response()
    await handler(
      request('POST', '/qingagent-bridge/focus', '127.0.0.1', {
        dshSessionId: 'dsh-a', engineSessionId: 'qing-a', adopt: true, title: 'A',
      }),
      res2 as unknown as ServerResponse,
    )
    expect(res2.status).toBe(200)
    expect((engine.fetchJson as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((bindings as unknown as { setActive: ReturnType<typeof vi.fn> }).setActive)
      .toHaveBeenCalledWith('dsh-a', 'qing-a')
    dispose()
  })
})
