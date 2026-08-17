import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { BindingStore } from '../src/bindings.js'
import type { BridgeHub } from '../src/bridge.js'
import { DRAFT_MARK_COLORS, type BridgeEvent, type EngineStatusSnapshot, type ExternalDoc } from '../src/contracts.js'
import { EngineHttpError, type EngineService } from '../src/engine.js'
import { QINGJIAN_DOWNLOAD_URL } from '../src/onboarding.js'
import { registerTools } from '../src/tools.js'

const DRAFT_ONE = '<title>测试稿</title><h1>开篇</h1><p>第一版正文。</p>'
const DRAFT_TWO = '<title>测试稿</title><h1>开篇</h1><p>修正后的正文。</p>'
const EMPTY_DRAFT = '<title>测试稿</title><h1>测试稿</h1>'

function doc(overrides: Partial<ExternalDoc> = {}): ExternalDoc {
  return {
    sessionId: 'qing-1',
    docVersion: 0,
    state: 'empty',
    agentBusy: false,
    markdown: '',
    qingml: '',
    title: null,
    ...overrides,
  }
}

function exec(
  signal = new AbortController().signal,
  rootCallId = 'call-1',
  name = 'qing_write_draft',
): ToolRunContext {
  return {
    callId: rootCallId,
    rootCallId,
    name,
    arguments: {},
    signal,
    token: Symbol('tool'),
    agent: { id: 'dsh-1', options: { provider: 'fake', model: 'fake-model' } },
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
  } as unknown as ToolRunContext
}

function harness(
  outputs: string[],
  fetchJson: (path: string, init?: RequestInit) => Promise<unknown>,
  engineStatus: EngineStatusSnapshot = { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
) {
  const tools = new Map<string, ToolDefinition>()
  const listeners = new Map<string, (...args: any[]) => any>()
  const requests: unknown[] = []
  const events: Array<{ sessionId: string; event: BridgeEvent }> = []
  const stream = vi.fn((request: unknown) => {
    requests.push(request)
    const output = outputs.shift() ?? ''
    return (async function* () {
      yield { type: 'text-delta', text: output }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })
  const ctx = {
    effect: (setup: () => () => void) => {
      const dispose = setup()
      return Object.assign(() => Promise.resolve(dispose()), { then: undefined })
    },
    tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    llm: { stream },
    on: vi.fn((name: string, listener: (...args: any[]) => any) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    }),
  } as unknown as Context
  const active = { engineSessionId: 'qing-1', title: '测试稿', createdAt: '2026-08-15T00:00:00.000Z' }
  const bindings = {
    hasDoc: (sessionId: string, engineSessionId: string) => sessionId === 'dsh-1' && engineSessionId === 'qing-1',
    listDocs: () => [active],
    getBinding: () => ({ docs: [active], activeEngineSessionId: active.engineSessionId }),
    getActive: () => active,
    createDoc: vi.fn(async () => active),
    setActive: vi.fn(async () => active),
    updateTitle: vi.fn(async (_sessionId: string, _engineSessionId: string, title: string) => { active.title = title }),
  } as unknown as BindingStore
  const engine = {
    ensureReady: vi.fn(async () => engineStatus),
    status: vi.fn(async () => engineStatus),
    fetchJson: vi.fn(fetchJson),
  } as unknown as EngineService
  const bridge = {
    emit: vi.fn((sessionId: string, event: BridgeEvent) => events.push({ sessionId, event })),
    clearSelection: vi.fn(),
  } as unknown as BridgeHub
  registerTools({ ctx, engine, bindings, bridge })
  return { tools, listeners, requests, events, stream, bindings, engine, bridge }
}

describe('qing_* 未连接结构化报错', () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['qing_write_draft', { brief: '写一篇测试稿' }],
    ['qing_edit_draft', { ops: [{ kind: 'setTitle', title: '新标题' }] }],
    ['qing_review_commit', { action: 'accept_all' }],
    ['qing_read_draft', {}],
    ['qing_list_docs', {}],
    ['qing_focus_doc', { docRef: 'qing-1' }],
  ]

  it.each(calls)('%s 在完全未检测到时返回统一安装/启动引导', async (name, args) => {
    const fixture = harness([], async () => { throw new Error('不应访问引擎') }, {
      state: 'offline',
      engineUrl: 'http://127.0.0.1:49123',
      reason: 'instance-missing',
      message: '未找到实例文件',
    })

    await expect(fixture.tools.get(name)!.execute(args, exec(undefined, 'offline-call', name)))
      .rejects.toThrow([
        '【未连接青简】未检测到可用的青简引擎。',
        '请先安装并启动青简；插件会自动连接，无需重启 DSH。',
        `下载青简：${QINGJIAN_DOWNLOAD_URL}`,
      ].join('\n'))
    expect(fixture.engine.fetchJson).not.toHaveBeenCalled()
  })

  it.each(calls)('%s 在握手失败时保留具体原因', async (name, args) => {
    const fixture = harness([], async () => { throw new Error('不应访问引擎') }, {
      state: 'handshake-failed',
      engineUrl: 'http://127.0.0.1:49123',
      reason: 'protocol-incompatible',
      message: 'attachProtocolVersion 不兼容：青简为 2，插件需要 1。',
    })

    await expect(fixture.tools.get(name)!.execute(args, exec(undefined, 'handshake-call', name)))
      .rejects.toThrow([
        '【未连接青简】检测到青简引擎，但握手失败。',
        '具体原因：attachProtocolVersion 不兼容：青简为 2，插件需要 1。',
        '请修复或更新青简并保持运行；插件会自动重连，无需重启 DSH。',
        `下载青简：${QINGJIAN_DOWNLOAD_URL}`,
      ].join('\n'))
    expect(fixture.engine.fetchJson).not.toHaveBeenCalled()
  })
})

function candidateDoc(heading: string, paragraph: string) {
  return {
    type: 'doc',
    attrs: { schemaVersion: 1 },
    content: [
      { type: 'heading', attrs: { blockId: 'heading-1', level: 1 }, content: [{ type: 'text', text: heading }] },
      { type: 'paragraph', attrs: { blockId: 'paragraph-1' }, content: [{ type: 'text', text: paragraph }] },
    ],
  }
}

describe('qing_write_draft', () => {
  it('消费侧模型流、提交并以引擎读回的 official 文稿返回', async () => {
    let proposed = false
    const fixture = harness([DRAFT_ONE], async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed ? doc({ docVersion: 1, state: 'editing', qingml: DRAFT_ONE, title: '测试稿' }) : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        expect(JSON.parse(String(init?.body))).toMatchObject({ expectedDocVersion: 0, ops: [{ kind: 'qingmlDraft', qingml: DRAFT_ONE }] })
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const result = await fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇测试稿' }, exec())

    expect(result).toMatchObject({ status: 'committed', engineSessionId: 'qing-1', title: '测试稿', blocks: 2 })
    expect(fixture.stream).toHaveBeenCalledOnce()
    expect(fixture.events.at(-1)?.event.type).toBe('doc-committed')
  })

  it('首次只有标题时换 generation 纠正一次,并用第二次 generation 发送终态', async () => {
    let proposed = false
    const fixture = harness([EMPTY_DRAFT, DRAFT_TWO], async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed ? doc({ docVersion: 1, state: 'editing', qingml: DRAFT_TWO, title: '测试稿' }) : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        expect(JSON.parse(String(init?.body))).toMatchObject({
          expectedDocVersion: 0,
          ops: [{ kind: 'qingmlDraft', qingml: DRAFT_TWO }],
        })
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇测试稿' }, exec()))
      .resolves.toMatchObject({ status: 'committed', blocks: 2 })

    expect(fixture.stream).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(fixture.requests[1])).toContain('上一次只产出了标题、缺少正文')
    expect(JSON.stringify(fixture.requests[1])).not.toContain('上一次 QingML 被青简拒绝')
    const draftStarts = fixture.events
      .filter(({ event }) => event.type === 'draft-started')
      .map(({ event }) => event.type === 'draft-started' ? event.generation : '')
    expect(draftStarts).toEqual([expect.any(String), expect.any(String)])
    expect(draftStarts[1]).not.toBe(draftStarts[0])
    expect(fixture.events.filter(({ event }) =>
      event.type === 'draft-started' || event.type === 'doc-committed').map(({ event }) => event.type))
      .toEqual(['draft-started', 'draft-started', 'doc-committed'])
    expect(fixture.events.find(({ event }) => event.type === 'doc-committed')?.event)
      .toMatchObject({ generation: draftStarts[1] })
  })

  it('连续两次只有标题时报错且绝不提案落库', async () => {
    let proposals = 0
    const fixture = harness([EMPTY_DRAFT, EMPTY_DRAFT], async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc()
      if (path.endsWith('/proposals')) {
        proposals += 1
        throw new Error('不应提交空壳提案')
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇测试稿' }, exec()))
      .rejects.toThrow('侧模型修正后仍只返回标题,缺少正文块,未提交文稿')
    expect(fixture.stream).toHaveBeenCalledTimes(2)
    expect(proposals).toBe(0)
    const draftStarts = fixture.events
      .filter(({ event }) => event.type === 'draft-started')
      .map(({ event }) => event.type === 'draft-started' ? event.generation : '')
    expect(fixture.events.find(({ event }) => event.type === 'draft-failed')?.event)
      .toMatchObject({ generation: draftStarts[1] })
  })

  it('400 diagnostic 恰好纠错一次，第二次 prompt 含修正段', async () => {
    let proposals = 0
    const fixture = harness([DRAFT_ONE, DRAFT_TWO], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposals ? doc({ docVersion: 1, state: 'editing', qingml: DRAFT_TWO, title: '测试稿' }) : doc()
      }
      if (path.endsWith('/proposals')) {
        proposals += 1
        if (proposals === 1) throw new EngineHttpError(400, { diagnostic: { failureKind: 'bad_structure' } })
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇测试稿' }, exec())

    expect(fixture.stream).toHaveBeenCalledTimes(2)
    expect(proposals).toBe(2)
    expect(JSON.stringify(fixture.requests[1])).toContain('上一次 QingML 被青简拒绝')
    expect(JSON.stringify(fixture.requests[1])).toContain('bad_structure')
  })

  it('第二次提交仍失败时上浮，并只广播一次 draft-failed', async () => {
    let proposals = 0
    const fixture = harness([DRAFT_ONE, DRAFT_TWO], async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc()
      if (path.endsWith('/proposals')) {
        proposals += 1
        if (proposals === 1) throw new EngineHttpError(400, { diagnostic: { failureKind: 'bad_structure' } })
        throw new EngineHttpError(400, { error: '修正稿仍不合法' })
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇测试稿' }, exec()))
      .rejects.toThrow('修正稿仍不合法')
    expect(fixture.events.filter(({ event }) => event.type === 'draft-failed')).toHaveLength(1)
  })

  it('侧模型流 abort 时广播 draft-failed', async () => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc()
      throw new Error(`不应调用 ${path}`)
    })
    fixture.stream.mockImplementationOnce(() => (async function* () {
      yield { type: 'text-delta', text: '<p>未完成</p>' }
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '用户已中止' } } }
    })())

    await expect(fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇测试稿' }, exec()))
      .rejects.toThrow('用户已中止')
    expect(fixture.events.filter(({ event }) => event.type === 'draft-failed')).toEqual([
      { sessionId: 'dsh-1', event: expect.objectContaining({ type: 'draft-failed', engineSessionId: 'qing-1', message: 'QingML 生成失败：用户已中止' }) },
    ])
  })

  it('pendingReview 在生成前直接拦截', async () => {
    const fixture = harness([DRAFT_ONE], async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc({ state: 'pendingReview', docVersion: 3 })
      throw new Error(`不应调用 ${path}`)
    })

    await expect(fixture.tools.get('qing_write_draft')!.execute({ brief: '覆盖重写', docRef: 'qing-1' }, exec()))
      .rejects.toThrow('文稿正在审阅中。待审内容可能是你此前轮次提交的,也可能来自其他会话——不要断言归属。先用 ask_user 向用户说明存在待审稿,经用户明确授权后才可处置;不得代为提交或放弃。')
    expect(fixture.stream).not.toHaveBeenCalled()
  })

  it('proposal 进入 review 后读取候选指标并强制结束当前回合', async () => {
    let proposed = false
    const fixture = harness([DRAFT_ONE], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed
          ? doc({ docVersion: 1, state: 'pendingReview', qingml: '<h1>旧标题</h1><p>旧正文。</p>', title: '测试稿' })
          : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        return { status: 'review', patchIds: ['patch-1'], count: 1 }
      }
      if (path.endsWith('/review?format=render-model')) {
        return {
          sessionId: 'qing-1', docVersion: 1, state: 'pendingReview', agentBusy: false,
          baseVersion: 1, suggestions: [], editedDoc: candidateDoc('候选标题', '候选正文。'),
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const context = exec()

    const result = await fixture.tools.get('qing_write_draft')!.execute({ brief: '整篇重写' }, context)

    expect(result).toMatchObject({ status: 'review', blocks: 2, outline: ['候选标题'] })
    expect(context.concludeTurn).toHaveBeenCalledOnce()
    const generationEvents = fixture.events.filter(({ event }) =>
      event.type === 'draft-started' || event.type === 'draft-chunk' || event.type === 'doc-review-pending')
    expect(generationEvents.map(({ event }) => 'generation' in event ? event.generation : undefined))
      .toEqual([expect.any(String), expect.any(String), expect.any(String)])
    expect(new Set(generationEvents.map(({ event }) => 'generation' in event ? event.generation : undefined)).size).toBe(1)
    expect(fixture.tools.get('qing_write_draft')!.output?.render({}, result as never)).toEqual([{
      type: 'text',
      text: '【文稿状态】审阅中·1 处待用户裁决(基线 v1)。\n改动已提交审阅，右侧面板等待用户逐处裁决。本回合结束——不要重写、不要读稿复核、不要自动裁决',
    }])
  })

  it('失败也清理 host 选段，并在失败卡提取首行原因摘要', async () => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc({ state: 'pendingReview', docVersion: 3 })
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_write_draft')!.execute({ brief: '覆盖重写', docRef: 'qing-1' }, exec()))
      .rejects.toThrow('ask_user')

    expect(fixture.bridge.clearSelection).toHaveBeenCalledWith('dsh-1')
    expect(fixture.tools.get('qing_write_draft')!.presentResult?.({ brief: '覆盖重写' }, {
      isError: true,
      content: [{ type: 'text', text: 'Error: 文稿正在审阅中。\n请先处理。' }],
    })).toEqual({
      card: 'generic',
      title: '青简写作未完成',
      content: [{ type: 'text', text: '未完成 · 文稿审阅中' }],
    })
  })
})

describe('qing_review_commit', () => {
  it('按读到的版本提交全部裁决，读回 official 并广播 doc-committed', async () => {
    let reads = 0
    const official = doc({ docVersion: 4, state: 'editing', qingml: DRAFT_TWO, title: '测试稿' })
    const fixture = harness([], async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        reads += 1
        return reads === 1 ? doc({ docVersion: 3, state: 'pendingReview', qingml: DRAFT_ONE, title: '测试稿' }) : official
      }
      if (path.endsWith('/review/commit')) {
        expect(JSON.parse(String(init?.body))).toEqual({ expectedDocVersion: 3, action: 'accept_all' })
        return {
          status: 'reviewed', docVersion: 4, acceptedCount: 2, rejectedCount: 0,
          remainingCount: 0, outcomeQueued: true,
          outcome: { acceptedCount: 2, rejectedCount: 0, hunks: [] }, seq: 9,
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const result = await fixture.tools.get('qing_review_commit')!.execute({ action: 'accept_all' }, exec())

    expect(result).toMatchObject({ status: 'reviewed', acceptedCount: 2, rejectedCount: 0 })
    expect(fixture.events.at(-1)).toMatchObject({
      sessionId: 'dsh-1',
      event: { type: 'doc-committed', engineSessionId: 'qing-1', doc: official },
    })
  })

  it('非 pendingReview 返回无待审变更且不发 POST', async () => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc({ state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
      throw new Error(`不应调用 ${path}`)
    })

    await expect(fixture.tools.get('qing_review_commit')!.execute({ action: 'reject_all' }, exec()))
      .resolves.toMatchObject({
        status: 'no_pending_review',
        message: expect.stringContaining('【文稿状态】已落库生效 v0,当前无待审稿'),
      })
  })

  it('同一 agent 回合第二次调用在访问引擎前硬拦截', async () => {
    let reads = 0
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        reads += 1
        return reads === 1
          ? doc({ docVersion: 3, state: 'pendingReview', qingml: DRAFT_ONE, title: '测试稿' })
          : doc({ docVersion: 4, state: 'editing', qingml: DRAFT_TWO, title: '测试稿' })
      }
      if (path.endsWith('/review/commit')) {
        return {
          status: 'reviewed', docVersion: 4, acceptedCount: 0, rejectedCount: 1,
          remainingCount: 0, outcomeQueued: true,
          outcome: { acceptedCount: 0, rejectedCount: 1, hunks: [] }, seq: 10,
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const tool = fixture.tools.get('qing_review_commit')!
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 7 }, async () => ({ kind: 'enter', messages: [] }))

    await tool.execute({ action: 'reject_all' }, exec(undefined, 'first-root', 'qing_review_commit'))
    const fetchesAfterFirst = vi.mocked(fixture.engine.fetchJson).mock.calls.length
    await expect(tool.execute({ action: 'accept_all' }, exec(undefined, 'second-root', 'qing_review_commit')))
      .rejects.toThrow('本回合已裁决过一次，禁止连环裁决；等待用户指示')

    expect(vi.mocked(fixture.engine.fetchJson).mock.calls).toHaveLength(fetchesAfterFirst)
    await preStep({ agent: { id: 'dsh-1' }, turn: 8 }, async () => ({ kind: 'enter', messages: [] }))
    await expect(tool.execute({ action: 'accept_all' }, exec(undefined, 'third-root', 'qing_review_commit')))
      .resolves.toMatchObject({ status: 'no_pending_review' })
    expect(tool.description).toContain('ask_user')
    expect(tool.description).toContain('先调 qing_list_docs 确认文稿仍在审阅中')
    expect(tool.description).toContain('直接改不用问')
  })
})

describe('qing_read_draft', () => {
  it('pendingReview 默认返回 editedDoc 候选，mode:base 明确返回已提交基线', async () => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({
          docVersion: 3,
          state: 'pendingReview',
          qingml: '<h1>基线标题</h1><p>基线正文。</p>',
          title: '基线标题',
        })
      }
      if (path.endsWith('/review?format=render-model')) {
        return {
          sessionId: 'qing-1', docVersion: 3, state: 'pendingReview', agentBusy: false,
          baseVersion: 3, suggestions: [], editedDoc: candidateDoc('候选标题', '候选正文。'),
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const tool = fixture.tools.get('qing_read_draft')!

    const candidate = await tool.execute({ mode: 'full' }, exec(undefined, 'read-candidate', 'qing_read_draft'))
    const base = await tool.execute({ mode: 'base' }, exec(undefined, 'read-base', 'qing_read_draft'))

    expect(candidate).toMatchObject({ mode: 'full', blocks: 2 })
    expect((candidate as { content: string }).content).toContain('以下为待审候选（尚未生效）；已提交基线请传 mode:"base"。')
    expect((candidate as { content: string }).content).toContain('<h1>候选标题</h1><p>候选正文。</p>')
    expect((candidate as { content: string }).content).not.toContain('基线正文')
    expect((base as { content: string }).content).toContain('以下为已提交基线（不含待审候选）。')
    expect((base as { content: string }).content).toContain('<p>基线正文。</p>')
  })

  it('mode:lines 返回引擎的 Markdown 行号语料', async () => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 1, state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
      }
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 1, state: 'editing', agentBusy: false,
          markdown: '# 开篇\n\n第一版正文。', markdownWithLineNumbers: '   1 | # 开篇\n   2 | \n   3 | 第一版正文。', title: '测试稿',
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const result = await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'lines' },
      exec(undefined, 'read-lines', 'qing_read_draft'),
    )

    expect((result as { content: string }).content.startsWith('注意:strReplace 的 old 用纯文本,不要带行首 ## - 等标记。\n')).toBe(true)
    expect((result as { content: string }).content).toContain('   3 | 第一版正文。')
  })
})

describe('qing_edit_draft', () => {
  it('描述要求改标题时同批同步稿名和纸面大标题', () => {
    const fixture = harness([], async () => { throw new Error('不应访问引擎') })
    const tool = fixture.tools.get('qing_edit_draft')!
    expect(tool.description).toContain('正文首个大标题块用 strReplace 改')
    expect(tool.description).toContain('两者必须在同一次 ops 里一起提交,文字保持一致')
    expect(tool.description).toContain('正文没有大标题块时,用 insertAfterLine 在文首补一个与稿名一致的「# 标题」一级标题')
    expect(JSON.stringify(tool.parameters)).toContain('改标题时必须在同一次 ops 里一起提交正文标题同步操作')
  })

  it('schema 接受全部合法 markText 标记与受控色板，拒绝任意 CSS 色值', () => {
    const fixture = harness([], async () => { throw new Error('不应访问引擎') })
    const schema = fixture.tools.get('qing_edit_draft')!.parameters
    const marks = [
      { type: 'bold' },
      { type: 'italic' },
      { type: 'strike' },
      { type: 'underline' },
      { type: 'code' },
      { type: 'link', href: 'https://example.com', title: '来源' },
      { type: 'link', href: '#source', title: null },
      ...DRAFT_MARK_COLORS.flatMap((color) => [
        { type: 'highlight', color },
        { type: 'textColor', color },
      ]),
    ]

    for (const mark of marks) {
      expect(validateJsonSchemaValue(schema, {
        ops: [{ kind: 'markText', find: '目标文本', mark, op: 'add' }],
      }), JSON.stringify(mark)).toEqual([])
    }
    expect(validateJsonSchemaValue(schema, {
      ops: [{ kind: 'markText', find: '目标文本', mark: { type: 'highlight', color: '#ff0' }, op: 'add' }],
    })).not.toEqual([])
  })

  it('markText 原样进入 proposals 请求且不携带 opId', async () => {
    const op = {
      kind: 'markText' as const,
      find: '重点句',
      mark: { type: 'highlight' as const, color: 'amber' as const },
      op: 'add' as const,
      all: true,
      isRegex: false,
      withinRef: 'paragraph-1',
    }
    let proposalBody: Record<string, unknown> | undefined
    const fixture = harness([], async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '重点句', markdownWithLineNumbers: '   1 | 重点句', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalBody = JSON.parse(String(init?.body))
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<p><mark>重点句</mark></p>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await fixture.tools.get('qing_edit_draft')!.execute(
      { ops: [op] },
      exec(undefined, 'edit-mark-text', 'qing_edit_draft'),
    )

    expect(proposalBody).toMatchObject({ expectedDocVersion: 2, ops: [op] })
    expect(proposalBody).toHaveProperty('clientMutationId', expect.any(String))
    expect(proposalBody).not.toHaveProperty('opId')
  })

  it('markText 的引擎 400 可自纠文案完整透传', async () => {
    const correction = '文本未命中或未唯一命中,请缩小 withinRef 或设 all:true；注:代码块内文本不参与行内标记'
    let proposals = 0
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '重复文本\n\n重复文本', markdownWithLineNumbers: '   1 | 重复文本\n   2 | \n   3 | 重复文本', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposals += 1
        throw new EngineHttpError(400, { error: correction, code: 'VALIDATION' })
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'markText', find: '重复文本', mark: { type: 'bold' }, op: 'add' }],
    }, exec(undefined, 'edit-mark-error', 'qing_edit_draft'))).rejects.toThrow(correction)
    expect(proposals).toBe(1)
  })

  it('strReplace 原样未命中时规范化 Markdown 前缀与包裹标记后重试一次', async () => {
    const proposalBodies: Array<{ expectedDocVersion: number; ops: unknown[] }> = []
    const fixture = harness([], async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '## 第三步:香料别堆砌', markdownWithLineNumbers: '   1 | ## 第三步:香料别堆砌', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalBodies.push(JSON.parse(String(init?.body)))
        if (proposalBodies.length === 1) {
          throw new EngineHttpError(400, { error: '未命中,请重读文档', code: 'VALIDATION' })
        }
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<h2>第三步:少量点香</h2>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const result = await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '## **第三步:香料别堆砌**', new: '## __第三步:少量点香__' }],
    }, exec(undefined, 'edit-normalized', 'qing_edit_draft'))

    expect(result).toMatchObject({ status: 'committed', reviewCount: 0 })
    expect(proposalBodies).toHaveLength(2)
    expect(proposalBodies[0]).toMatchObject({
      expectedDocVersion: 2,
      ops: [{ kind: 'strReplace', old: '## **第三步:香料别堆砌**', new: '## __第三步:少量点香__' }],
    })
    expect(proposalBodies[1]).toMatchObject({
      expectedDocVersion: 2,
      ops: [{ kind: 'strReplace', old: '第三步:香料别堆砌', new: '第三步:少量点香' }],
    })
  })

  it('多条 strReplace 在同一次 proposals 请求中按原数组透传', async () => {
    const ops = [
      { kind: 'strReplace' as const, old: '第一处旧文', new: '第一处新文' },
      { kind: 'strReplace' as const, old: '第二处旧文', new: '第二处新文', nth: 1 },
    ]
    let proposals = 0
    const fixture = harness([], async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 4, state: 'editing', agentBusy: false,
          markdown: '第一处旧文\n\n第二处旧文', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposals += 1
        expect(JSON.parse(String(init?.body))).toMatchObject({ expectedDocVersion: 4, ops })
        return { status: 'committed', docVersion: 5 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 5, state: 'editing', qingml: '<p>第一处新文</p><p>第二处新文</p>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await fixture.tools.get('qing_edit_draft')!.execute(
      { ops },
      exec(undefined, 'edit-multi-op', 'qing_edit_draft'),
    )

    expect(proposals).toBe(1)
  })

  it('原样与规范化后的 strReplace 都未命中时提示 old 使用纯文本', async () => {
    let proposals = 0
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '## 现有标题', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposals += 1
        throw new EngineHttpError(400, { error: '未命中,请重读文档', code: 'VALIDATION' })
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_edit_draft')!.execute(
      { ops: [{ kind: 'strReplace', old: '## 不存在标题', new: '## 新标题' }] },
      exec(undefined, 'edit-no-match', 'qing_edit_draft'),
    )).rejects.toThrow('old 必须是纯文本内容,不要带 ## 等 markdown 标记')
    expect(proposals).toBe(2)
  })

  it('直接映射三类局部 op，review 后结束回合并清选段', async () => {
    let proposed = false
    const ops = [
      { kind: 'strReplace' as const, old: '旧标题', new: '新标题', nth: 1 },
      { kind: 'insertAfterLine' as const, line: 2, markdown: '插入段。' },
      { kind: 'appendSection' as const, markdown: '## 新节\n\n新节正文。' },
    ]
    const fixture = harness([], async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '# 旧标题\n\n旧正文。', markdownWithLineNumbers: '   1 | # 旧标题\n   2 | \n   3 | 旧正文。', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        expect(JSON.parse(String(init?.body))).toMatchObject({ expectedDocVersion: 2, ops })
        return { status: 'review', patchIds: ['p-1', 'p-2', 'p-3'], count: 3 }
      }
      if (path.endsWith('/doc?format=qingml') && proposed) {
        return doc({ docVersion: 2, state: 'pendingReview', qingml: '<h1>旧标题</h1><p>旧正文。</p>', title: '测试稿' })
      }
      if (path.endsWith('/review?format=render-model')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'pendingReview', agentBusy: false,
          baseVersion: 2, suggestions: [], editedDoc: candidateDoc('新标题', '局部候选正文。'),
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const context = exec(undefined, 'edit-review', 'qing_edit_draft')

    const result = await fixture.tools.get('qing_edit_draft')!.execute({ ops }, context)

    expect(result).toMatchObject({
      status: 'review', reviewCount: 3,
      message: expect.stringContaining('改动已提交审阅，右侧面板等待用户逐处裁决'),
    })
    expect(context.concludeTurn).toHaveBeenCalledOnce()
    expect(fixture.bridge.clearSelection).toHaveBeenCalledWith('dsh-1')
    expect(fixture.events.at(-1)?.event).toMatchObject({ type: 'doc-review-pending', count: 3, blocks: 2 })
    expect(vi.mocked(fixture.engine.fetchJson).mock.calls.map(([path]) => path)).toEqual([
      '/sessions/qing-1/doc?lines=1',
      '/sessions/qing-1/proposals',
      '/sessions/qing-1/doc?format=qingml',
      '/sessions/qing-1/review?format=render-model',
    ])
  })

  it('审阅态拒绝新编辑且失败路径仍清选段', async () => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'pendingReview', agentBusy: false,
          markdown: '# 旧标题', markdownWithLineNumbers: '   1 | # 旧标题', title: '测试稿',
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_edit_draft')!.execute(
      { ops: [{ kind: 'strReplace', old: '旧', new: '新' }] },
      exec(undefined, 'edit-rejected', 'qing_edit_draft'),
    )).rejects.toThrow('ask_user')
    expect(fixture.bridge.clearSelection).toHaveBeenCalledWith('dsh-1')
  })
})

describe('qing_list_docs', () => {
  it('createdAt 同时存在于 schema 与执行结果', async () => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc({ state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
      throw new Error(`unexpected path: ${path}`)
    })
    const tool = fixture.tools.get('qing_list_docs')!

    const result = await tool.execute({}, exec(undefined, 'list-docs', 'qing_list_docs'))

    expect(result).toMatchObject({
      docs: [{ createdAt: '2026-08-15T00:00:00.000Z', engineSessionId: 'qing-1' }],
    })
    const schema = tool.output?.schema as { properties?: { docs?: { items?: { properties?: Record<string, unknown> } } } }
    expect(schema.properties?.docs?.items?.properties).toHaveProperty('createdAt')
    expect(schema.properties?.docs?.items?.properties).toHaveProperty('docVersion')
  })

  it.each([
    ['pendingReview', 3, '【文稿状态】审阅中·待用户裁决(基线 v3)。', '审阅中(待用户裁决)'],
    ['editing', 4, '【文稿状态】已落库生效 v4,无待审稿。', '已落库生效'],
  ] as const)('session render 将 %s 映射为中文状态并为聚焦稿输出权威状态行', async (state, docVersion, stateLine, stateLabel) => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ state, docVersion, qingml: DRAFT_ONE, title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const tool = fixture.tools.get('qing_list_docs')!

    const result = await tool.execute({}, exec(undefined, `list-${state}`, 'qing_list_docs'))

    expect(tool.output?.render({}, result as never)).toEqual([{
      type: 'text',
      text: `青简引擎：online\n${stateLine}\n→ 测试稿｜${stateLabel}｜qing-1`,
    }])
  })

  it('render 覆盖 empty/offline/unavailable 的中文状态词', () => {
    const fixture = harness([], async () => { throw new Error('不应访问引擎') })
    const tool = fixture.tools.get('qing_list_docs')!
    const rendered = tool.output?.render({ scope: 'library' }, {
      engine: 'online',
      docs: [
        { engineSessionId: 'empty-1', title: '空稿', active: false, state: 'empty', createdAt: '2026-08-15T00:00:00.000Z' },
        { engineSessionId: 'offline-1', title: '离线稿', active: false, state: 'offline', createdAt: '2026-08-15T00:00:00.000Z' },
        { engineSessionId: 'unavailable-1', title: '异常稿', active: false, state: 'unavailable', createdAt: '2026-08-15T00:00:00.000Z' },
      ],
    } as never)

    expect(rendered).toEqual([{
      type: 'text',
      text: [
        '青简引擎：online',
        '  空稿｜空文稿｜empty-1',
        '  离线稿｜引擎离线｜offline-1',
        '  异常稿｜暂不可读｜unavailable-1',
      ].join('\n'),
    }])
  })
})

describe('qing_focus_doc', () => {
  it('切换已绑定文稿后返回并渲染目标稿权威状态行', async () => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ state: 'pendingReview', docVersion: 7, qingml: DRAFT_ONE, title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const tool = fixture.tools.get('qing_focus_doc')!

    const result = await tool.execute({ docRef: 'qing-1' }, exec(undefined, 'focus-doc', 'qing_focus_doc'))

    expect(result).toMatchObject({ state: 'pendingReview', docVersion: 7 })
    expect(tool.output?.render({ docRef: 'qing-1' }, result as never)).toEqual([{
      type: 'text',
      text: '【文稿状态】审阅中·待用户裁决(基线 v7)。\n右侧预览已切换到《测试稿》（qing-1）。',
    }])
  })
})

describe('局部 op 原始标签防线', () => {
  it('strReplace new 含 QingML 标签被拒绝且不发提案', async () => {
    let proposalCalls = 0
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '逃出来', markdownWithLineNumbers: '   1 | 逃出来', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) { proposalCalls += 1; return { status: 'committed', docVersion: 3 } }
      throw new Error(`unexpected path: ${path}`)
    })
    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '逃出来', new: '<mark color="yellow">逃出来</mark>' }],
    }, exec(undefined, 'edit-rawtag', 'qing_edit_draft'))).rejects.toThrow(/QingML\/HTML 标签/)
    expect(proposalCalls).toBe(0)
  })

  it('insertAfterLine markdown 含 color 标签同样拒绝', async () => {
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '正文', markdownWithLineNumbers: '   1 | 正文', title: '测试稿',
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'insertAfterLine', line: 1, markdown: '<color name="red">警示</color>' }],
    }, exec(undefined, 'edit-rawtag2', 'qing_edit_draft'))).rejects.toThrow(/QingML\/HTML 标签/)
  })

  it('纯文本数学小于号不误伤(a<b 且 3 < 5)', async () => {
    let proposalCalls = 0
    const fixture = harness([], async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '对比', markdownWithLineNumbers: '   1 | 对比', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) { proposalCalls += 1; return { status: 'committed', docVersion: 3 } }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<p>对比:a<b 且 3 < 5</p>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    })
    await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '对比', new: '对比:a<b 且 3 < 5' }],
    }, exec(undefined, 'edit-lt', 'qing_edit_draft'))
    expect(proposalCalls).toBe(1)
  })
})
