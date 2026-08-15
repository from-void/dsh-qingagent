import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { BindingStore } from '../src/bindings.js'
import type { BridgeHub } from '../src/bridge.js'
import type { BridgeEvent, ExternalDoc } from '../src/contracts.js'
import { EngineHttpError, type EngineService } from '../src/engine.js'
import { registerTools } from '../src/tools.js'

const DRAFT_ONE = '<title>测试稿</title><h1>开篇</h1><p>第一版正文。</p>'
const DRAFT_TWO = '<title>测试稿</title><h1>开篇</h1><p>修正后的正文。</p>'

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

function harness(outputs: string[], fetchJson: (path: string, init?: RequestInit) => Promise<unknown>) {
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
    ensureReady: vi.fn(async () => ({ state: 'online', engineUrl: 'http://127.0.0.1:8080' })),
    status: vi.fn(async () => ({ state: 'online', engineUrl: 'http://127.0.0.1:8080' })),
    fetchJson: vi.fn(fetchJson),
  } as unknown as EngineService
  const bridge = {
    emit: vi.fn((sessionId: string, event: BridgeEvent) => events.push({ sessionId, event })),
    clearSelection: vi.fn(),
  } as unknown as BridgeHub
  registerTools({ ctx, engine, bindings, bridge })
  return { tools, listeners, requests, events, stream, bindings, engine, bridge }
}

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
      .rejects.toThrow('文稿正在审阅中')
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
      text: '改动已提交审阅，右侧面板等待用户逐处裁决。本回合结束——不要重写、不要读稿复核、不要自动裁决',
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
      .resolves.toMatchObject({ status: 'no_pending_review', message: '无待审变更' })
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
      message: '改动已提交审阅，右侧面板等待用户逐处裁决。本回合结束——不要重写、不要读稿复核、不要自动裁决',
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
  })
})
