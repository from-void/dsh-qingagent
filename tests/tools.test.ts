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

function exec(signal = new AbortController().signal): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'qing_write_draft',
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
  } as unknown as Context
  const active = { engineSessionId: 'qing-1', title: '测试稿', createdAt: '2026-08-15T00:00:00.000Z' }
  const bindings = {
    hasDoc: (sessionId: string, engineSessionId: string) => sessionId === 'dsh-1' && engineSessionId === 'qing-1',
    listDocs: () => [active],
    getActive: () => active,
    createDoc: vi.fn(async () => active),
    setActive: vi.fn(async () => active),
    updateTitle: vi.fn(async (_sessionId: string, _engineSessionId: string, title: string) => { active.title = title }),
  } as unknown as BindingStore
  const engine = {
    ensureReady: vi.fn(async () => ({ state: 'online', engineUrl: 'http://127.0.0.1:8080' })),
    fetchJson: vi.fn(fetchJson),
  } as unknown as EngineService
  const bridge = {
    emit: vi.fn((sessionId: string, event: BridgeEvent) => events.push({ sessionId, event })),
  } as unknown as BridgeHub
  registerTools({ ctx, engine, bindings, bridge })
  return { tools, requests, events, stream, bindings, engine }
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
      { sessionId: 'dsh-1', event: { type: 'draft-failed', engineSessionId: 'qing-1', message: 'QingML 生成失败：用户已中止' } },
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
})
