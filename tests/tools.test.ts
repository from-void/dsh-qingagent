import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { countDocVisibleChars, type PmDoc } from '@qingagent/pm-schema'
import type { BindingStore } from '../src/bindings.js'
import { TURN_SIGNAL_HEARTBEAT_MS, type BridgeHub } from '../src/bridge.js'
import { DRAFT_MARK_COLORS, type BridgeEvent, type EngineStatusSnapshot, type ExternalDoc } from '../src/contracts.js'
import { EngineHttpError, type EngineService } from '../src/engine.js'
import { QINGJIAN_DOWNLOAD_URL } from '../src/onboarding.js'
import { draftRequirementsOf, registerTools } from '../src/tools.js'
import { compileQingmlDocument } from '../src/qingmlCompile.js'
import type { TelemetryCapture } from '../src/telemetry.js'
import { REVIEW_TURN_EDIT_ERROR, reviewTurnCoordinatorFor } from '../src/reviewTurn.js'
import { PendingTitleCoordinator } from '../src/pendingTitle.js'

const DRAFT_ONE = '<title>测试稿</title><h1>开篇</h1><p>第一版正文。</p>'
const DRAFT_TWO = '<title>测试稿</title><h1>开篇</h1><p>修正后的正文。</p>'
const EMPTY_DRAFT = '<title>测试稿</title><h1>测试稿</h1>'
const SOURCE_SYNTAX_DRAFT = '<title>测试稿</title><h1>开篇</h1><p>第一版正文[^1]，参数为 $\\alpha$。</p><p>[^1]: 《资料甲》</p><p>$$E=mc^2$$</p>'
const CONVERTED_SOURCE_SYNTAX_DRAFT = '<title>测试稿</title><h1>开篇</h1><p>第一版正文<footnote id="1">《资料甲》</footnote>，参数为 <math>\\alpha</math>。</p><math-block>E=mc^2</math-block>'
const UNRESOLVED_FOOTNOTE_DRAFT = '<title>测试稿</title><h1>开篇</h1><p>第一版正文[^missing]。</p>'
const ONLINE_ENGINE: EngineStatusSnapshot = { state: 'online', engineUrl: 'http://127.0.0.1:8080' }

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
    agent: { id: 'dsh-1', options: { provider: 'fake', model: 'fake-model' }, inject: vi.fn() },
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
  } as unknown as ToolRunContext
}

function expectReviewEndMessage(message: string): void {
  expect(message).toContain('只补一句简短收尾')
  expect(message).toContain('不要再调用工具')
  for (const instruction of ['不要重写', '不要读稿复核', '不要自动裁决']) {
    expect(message).toContain(instruction)
  }
}

function harness(
  fetchJson: (path: string, init?: RequestInit) => Promise<unknown>,
  engineStatus: EngineStatusSnapshot = ONLINE_ENGINE,
  pmDoc: PmDoc = candidateDoc('开篇', '第一版正文。'),
  turnSignal: (path: string, init?: RequestInit) => Promise<unknown> = async (_path, init) => ({
    active: (JSON.parse(String(init?.body)) as { action: string }).action !== 'end',
  }),
  hasActive = true,
  bindingOptions?: {
    docs: Array<{ engineSessionId: string; title: string; createdAt: string }>
    activeEngineSessionId: string
  },
) {
  const tools = new Map<string, ToolDefinition>()
  const listeners = new Map<string, (...args: any[]) => any>()
  const events: Array<{ sessionId: string; event: BridgeEvent }> = []
  const ctx = {
    effect: (setup: () => () => void) => {
      const dispose = setup()
      return Object.assign(() => Promise.resolve(dispose()), { then: undefined })
    },
    tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    on: vi.fn((name: string, listener: (...args: any[]) => any) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    }),
  } as unknown as Context
  const boundDocs = bindingOptions?.docs ?? [
    { engineSessionId: 'qing-1', title: '测试稿', createdAt: '2026-08-15T00:00:00.000Z' },
  ]
  let activeEngineSessionId = bindingOptions?.activeEngineSessionId ?? boundDocs[0]!.engineSessionId
  const bindings = {
    hasDoc: (sessionId: string, engineSessionId: string) =>
      sessionId === 'dsh-1' && boundDocs.some((item) => item.engineSessionId === engineSessionId),
    listDocs: () => boundDocs,
    getBinding: () => ({ docs: boundDocs, activeEngineSessionId }),
    getActive: () => hasActive
      ? boundDocs.find((item) => item.engineSessionId === activeEngineSessionId)
      : undefined,
    createDoc: vi.fn(async () => boundDocs[0]!),
    setActive: vi.fn(async (_sessionId: string, engineSessionId: string) => {
      activeEngineSessionId = engineSessionId
      return boundDocs.find((item) => item.engineSessionId === engineSessionId)
    }),
    updateTitle: vi.fn(async (_sessionId: string, engineSessionId: string, title: string) => {
      const doc = boundDocs.find((item) => item.engineSessionId === engineSessionId)
      if (doc) doc.title = title
    }),
  } as unknown as BindingStore
  const engine = {
    ensureReady: vi.fn(async () => engineStatus),
    status: vi.fn(async () => engineStatus),
    fetchJson: vi.fn((path: string, init?: RequestInit) => {
      return path.endsWith('/doc?format=pm') ? Promise.resolve({ pmDoc }) : fetchJson(path, init)
    }),
    fetchTurnSignal: vi.fn((path: string, body: unknown) => turnSignal(path, {
      method: 'POST',
      body: JSON.stringify(body),
    })),
  } as unknown as EngineService
  const bridge = {
    emit: vi.fn((sessionId: string, event: BridgeEvent) => events.push({ sessionId, event })),
    clearSelection: vi.fn(),
  } as unknown as BridgeHub
  const telemetry = { capture: vi.fn(async () => undefined) } as unknown as TelemetryCapture
  const pendingTitles = new PendingTitleCoordinator(engine, bindings)
  registerTools({ ctx, engine, bindings, bridge, telemetry, pendingTitles })
  return {
    tools, listeners, events, bindings, engine, bridge, telemetry, pendingTitles,
    setActiveEngineSessionId: (engineSessionId: string) => { activeEngineSessionId = engineSessionId },
  }
}

function signalActions(engine: EngineService): Array<{ action: string; turnId: string }> {
  return vi.mocked(engine.fetchTurnSignal).mock.calls.map(([_path, body]) =>
    body as { action: string; turnId: string })
}

describe('agent 文稿回合租约', () => {
  const editableDoc = () => doc({ state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })

  it('纯聊天回合在 pre-step 预领当前绑定稿，回合结束配对 end', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return editableDoc()
      throw new Error(`unexpected path: ${path}`)
    })
    const preStep = fixture.listeners.get('agent/pre-step')!
    const stopping = fixture.listeners.get('agent/turn-stopping')!

    await preStep({ agent: { id: 'dsh-1' }, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
    await stopping({ agent: { id: 'dsh-1' }, turn: 1 })

    const actions = signalActions(fixture.engine)
    expect(actions.map(({ action }) => action)).toEqual(['begin', 'end'])
    expect(actions[1]!.turnId).toBe(actions[0]!.turnId)
    expect(fixture.events).toContainEqual({
      sessionId: 'dsh-1',
      event: { type: 'turn-ended', engineSessionIds: ['qing-1'] },
    })
  })

  it('qing_export:发桥事件让面板执行真下载;空稿与审阅中拒绝(评测 0822-r1)', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc({ state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
      throw new Error(`unexpected path: ${path}`)
    })
    const result = await fixture.tools.get('qing_export')!.execute(
      { format: 'pdf' },
      exec(undefined, 'export-1', 'qing_export'),
    )
    expect(result).toMatchObject({ format: 'pdf', title: '测试稿' })
    const event = fixture.events.find((item) => item.event.type === 'export-request')
    expect(event?.event).toMatchObject({ type: 'export-request', engineSessionId: 'qing-1', format: 'pdf' })
  })

  it('qing_export:空稿给可行动错误,不发事件', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc({ state: 'empty', qingml: '', title: '' })
      throw new Error(`unexpected path: ${path}`)
    })
    await expect(fixture.tools.get('qing_export')!.execute(
      { format: 'pdf' },
      exec(undefined, 'export-2', 'qing_export'),
    )).rejects.toThrow('还没有可导出的内容')
    expect(fixture.events.some((item) => item.event.type === 'export-request')).toBe(false)
  })

  it('abort 路径宿主不发 turn-stopping,status idle 兜底收口残留租约', async () => {
    // 评测 r4 实证:用户点停止后回合被 abort,turn-stopping 不发射,残留段心跳把文稿
    // 永久锁死(agentBusy 数小时不释放)。idle 状态边界必须兜底关段。
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return editableDoc()
      throw new Error(`unexpected path: ${path}`)
    })
    const preStep = fixture.listeners.get('agent/pre-step')!
    const status = fixture.listeners.get('agent/status')!

    await preStep({ agent: { id: 'dsh-1' }, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
    await status({ agent: { id: 'dsh-1' }, status: 'idle' })

    const actions = signalActions(fixture.engine)
    expect(actions.map(({ action }) => action)).toEqual(['begin', 'end'])
    expect(actions[1]!.turnId).toBe(actions[0]!.turnId)
  })

  it('没有预绑定目标时，显式纯读不申领租约', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return editableDoc()
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('开篇', '第一版正文。'), undefined, false)
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 11 }, async () => ({ kind: 'enter', messages: [] }))
    await fixture.tools.get('qing_read_draft')!.execute(
      { docRef: 'qing-1', mode: 'outline' },
      exec(undefined, 'lease-pure-read', 'qing_read_draft'),
    )
    await fixture.listeners.get('agent/turn-stopping')!({ agent: { id: 'dsh-1' }, turn: 11 })
    expect(signalActions(fixture.engine)).toEqual([])
  })

  it('pre-step 预领恰好一次，同回合纯读不额外申领', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return editableDoc()
      throw new Error(`unexpected path: ${path}`)
    })
    const preStep = fixture.listeners.get('agent/pre-step')!
    const stopping = fixture.listeners.get('agent/turn-stopping')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 2 }, async () => ({ kind: 'enter', messages: [] }))
    vi.mocked(fixture.engine.fetchJson).mockClear()

    const read = fixture.tools.get('qing_read_draft')!
    await read.execute({ mode: 'outline' }, exec(undefined, 'lease-read-1', 'qing_read_draft'))
    await read.execute({ mode: 'base' }, exec(undefined, 'lease-read-2', 'qing_read_draft'))

    expect(signalActions(fixture.engine)).toEqual([{ action: 'begin', turnId: expect.any(String) }])

    await stopping({ agent: { id: 'dsh-1' }, turn: 2 })
    await stopping({ agent: { id: 'dsh-1' }, turn: 2 })
    const actions = signalActions(fixture.engine)
    expect(actions.map(({ action }) => action)).toEqual(['begin', 'end'])
    expect(actions[1]!.turnId).toBe(actions[0]!.turnId)

  })

  it('agent/error 只标记段可疑，不把 step 级错误误建模为 end', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return editableDoc()
      throw new Error(`unexpected path: ${path}`)
    })
    const preStep = fixture.listeners.get('agent/pre-step')!
    const onError = fixture.listeners.get('agent/error')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 3 }, async () => ({ kind: 'enter', messages: [] }))
    vi.mocked(fixture.engine.fetchJson).mockClear()
    await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'outline' },
      exec(undefined, 'lease-error-read', 'qing_read_draft'),
    )

    await onError({ agent: { id: 'dsh-1' }, turn: 3, step: 1, error: new Error('boom') })
    await onError({ agent: { id: 'dsh-1' }, turn: 3, step: 1, error: new Error('boom') })
    expect(signalActions(fixture.engine).map(({ action }) => action)).toEqual(['begin'])
    await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'base' },
      exec(undefined, 'lease-error-continued', 'qing_read_draft'),
    )
    expect(signalActions(fixture.engine).map(({ action }) => action)).toEqual(['begin'])
  })

  it('begin 后按固定间隔 heartbeat，end 后立即停止', async () => {
    vi.useFakeTimers()
    try {
      const fixture = harness(async (path) => {
        if (path.endsWith('/doc?format=qingml')) return editableDoc()
        throw new Error(`unexpected path: ${path}`)
      })
      const preStep = fixture.listeners.get('agent/pre-step')!
      const stopping = fixture.listeners.get('agent/turn-stopping')!
      await preStep({ agent: { id: 'dsh-1' }, turn: 4 }, async () => ({ kind: 'enter', messages: [] }))
      vi.mocked(fixture.engine.fetchJson).mockClear()
      await fixture.tools.get('qing_read_draft')!.execute(
        { mode: 'outline' },
        exec(undefined, 'lease-heartbeat-read', 'qing_read_draft'),
      )

      await vi.advanceTimersByTimeAsync(TURN_SIGNAL_HEARTBEAT_MS - 1)
      expect(signalActions(fixture.engine).map(({ action }) => action)).toEqual(['begin'])
      await vi.advanceTimersByTimeAsync(1)
      expect(signalActions(fixture.engine).map(({ action }) => action)).toEqual(['begin', 'heartbeat'])

      await stopping({ agent: { id: 'dsh-1' }, turn: 4 })
      await vi.advanceTimersByTimeAsync(TURN_SIGNAL_HEARTBEAT_MS * 2)
      expect(signalActions(fixture.engine).map(({ action }) => action)).toEqual(['begin', 'heartbeat', 'end'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('旧引擎 turn-signal 路由 404 时纯读放行、写入 fail-closed 且不回传 turnId', async () => {
    let proposed = false
    let proposalBody: Record<string, unknown> | undefined
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({
          docVersion: proposed ? 3 : 2,
          state: 'editing',
          qingml: proposed ? DRAFT_TWO : DRAFT_ONE,
          title: '测试稿',
        })
      }
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '# 开篇\n\n第一版正文。', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalBody = JSON.parse(String(init?.body))
        proposed = true
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('开篇', '第一版正文。'), async () => {
      throw new EngineHttpError(404, { error: 'route not found' })
    })
    const preStep = fixture.listeners.get('agent/pre-step')!
    const stopping = fixture.listeners.get('agent/turn-stopping')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 5 }, async () => ({ kind: 'enter', messages: [] }))

    await expect(fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'outline' },
      exec(undefined, 'lease-404-read', 'qing_read_draft'),
    )).resolves.toMatchObject({ state: 'editing' })
    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '第一版正文。', new: '修正后的正文。' }],
    }, exec(undefined, 'lease-404-edit', 'qing_edit_draft'))).rejects.toThrow('当前引擎不支持编辑锁')
    await expect(stopping({ agent: { id: 'dsh-1' }, turn: 5 })).resolves.toBeUndefined()

    expect(proposalBody).toBeUndefined()
    expect(signalActions(fixture.engine).map(({ action }) => action)).toEqual(['begin'])
  })
})

describe('审查回合与 qing_annotate', () => {
  const editingDoc = (docVersion = 1) => doc({
    docVersion,
    state: 'editing',
    qingml: DRAFT_ONE,
    markdown: '# 开篇\n\n第一版正文。',
    title: '测试稿',
  })
  const groups = [{
    summary: '句式生硬',
    note: '这句话读起来不自然。',
    severity: 'warn' as const,
    suggestion: '修正后的正文。',
    anchors: [{ find: '第一版正文。' }],
  }]

  function markReview(fixture: ReturnType<typeof harness>, type = 'deai' as const): void {
    reviewTurnCoordinatorFor(fixture.engine).markPending('dsh-1', {
      type,
      templateId: 'review-deai-default',
      templateName: '自然表达',
      targetEngineSessionId: 'qing-1',
    })
  }

  it('打标后在 pre-step 激活，写工具按固定文案拒绝，stopping 清理终态', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return editingDoc()
      throw new Error(`unexpected path: ${path}`)
    })
    const state = reviewTurnCoordinatorFor(fixture.engine)
    markReview(fixture)

    await fixture.listeners.get('agent/pre-step')!(
      { agent: { id: 'dsh-1' }, turn: 61 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(state.getActive('dsh-1')).toMatchObject({ type: 'deai', turnId: 61 })
    await expect(fixture.tools.get('qing_write_draft')!.execute(
      { qingml: DRAFT_TWO },
      exec(undefined, 'review-write', 'qing_write_draft'),
    )).rejects.toThrow(REVIEW_TURN_EDIT_ERROR)
    await expect(fixture.tools.get('qing_edit_draft')!.execute(
      { ops: [{ kind: 'setTitle', title: '新标题' }] },
      exec(undefined, 'review-edit', 'qing_edit_draft'),
    )).rejects.toThrow(REVIEW_TURN_EDIT_ERROR)

    await fixture.listeners.get('agent/turn-stopping')!({ agent: { id: 'dsh-1' }, turn: 61 })
    expect(state.getActive('dsh-1')).toBeUndefined()
    expect(signalActions(fixture.engine).map(({ action }) => action)).toEqual(['begin', 'end'])
  })

  it('审查 agent/error 是终态并立即释放租约，普通回合语义不变', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return editingDoc()
      throw new Error(`unexpected path: ${path}`)
    })
    const state = reviewTurnCoordinatorFor(fixture.engine)
    markReview(fixture)
    await fixture.listeners.get('agent/pre-step')!(
      { agent: { id: 'dsh-1' }, turn: 62 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    await fixture.listeners.get('agent/error')!({ agent: { id: 'dsh-1' }, turn: 62, error: new Error('boom') })
    expect(state.getActive('dsh-1')).toBeUndefined()
    expect(signalActions(fixture.engine).map(({ action }) => action)).toEqual(['begin', 'end'])
  })

  it('本回合未读稿时拒绝生成批注，不访问批注写接口', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return editingDoc()
      throw new Error(`unexpected path: ${path}`)
    })
    markReview(fixture)
    await fixture.listeners.get('agent/pre-step')!(
      { agent: { id: 'dsh-1' }, turn: 63 },
      async () => ({ kind: 'enter', messages: [] }),
    )

    await expect(fixture.tools.get('qing_annotate')!.execute(
      { groups },
      exec(undefined, 'annotate-unread', 'qing_annotate'),
    )).rejects.toThrow('本审查回合的目标是《测试稿》')
    expect(vi.mocked(fixture.engine.fetchJson).mock.calls.some(([path]) => path.endsWith('/review/annotations'))).toBe(false)
  })

  it('打标目标不随活跃稿切换，省略 docRef 的读稿与批注始终命中打标稿', async () => {
    const annotationPaths: string[] = []
    const fixture = harness(async (path) => {
      if (path.includes('/sessions/qing-1/doc?format=qingml')) return editingDoc()
      if (path.includes('/sessions/qing-2/doc?format=qingml')) {
        return doc({
          sessionId: 'qing-2', docVersion: 4, state: 'editing',
          qingml: '<title>切换稿</title><h1>切换稿</h1><p>另一篇正文。</p>',
          title: '切换稿',
        })
      }
      if (path.includes('/sessions/qing-1/review/annotations')) {
        annotationPaths.push(path)
        return {
          status: 'created', docVersion: 1, groupCount: 1, anchorCount: 1, seq: 12,
          annotations: [{ id: 'annotation-1', summary: '句式生硬' }],
        }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('开篇', '第一版正文。'), undefined, true, {
      docs: [
        { engineSessionId: 'qing-1', title: '打标稿', createdAt: '2026-08-15T00:00:00.000Z' },
        { engineSessionId: 'qing-2', title: '切换稿', createdAt: '2026-08-15T00:01:00.000Z' },
      ],
      activeEngineSessionId: 'qing-1',
    })
    markReview(fixture)

    // 弹窗打标后、agent 真正激活前面板已切到另一稿：预申领仍必须命中打标稿。
    fixture.setActiveEngineSessionId('qing-2')
    await fixture.listeners.get('agent/pre-step')!(
      { agent: { id: 'dsh-1' }, turn: 67 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(vi.mocked(fixture.engine.fetchTurnSignal).mock.calls[0]?.[0]).toContain('/sessions/qing-1/')

    const read = await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'full' },
      exec(undefined, 'review-target-read', 'qing_read_draft'),
    )
    expect(read).toMatchObject({ engineSessionId: 'qing-1', title: '测试稿' })

    await expect(fixture.tools.get('qing_annotate')!.execute(
      { docRef: 'qing-2', groups },
      exec(undefined, 'review-wrong-target', 'qing_annotate'),
    )).rejects.toThrow('本审查回合的目标是《打标稿》')

    await expect(fixture.tools.get('qing_annotate')!.execute(
      { groups },
      exec(undefined, 'review-target-write', 'qing_annotate'),
    )).resolves.toMatchObject({ engineSessionId: 'qing-1', status: 'created' })
    expect(annotationPaths).toEqual(['/sessions/qing-1/review/annotations'])
  })

  it('预申领 BUSY_NATIVE 不阻断审查读取，落批注前重新申领成功', async () => {
    vi.useFakeTimers()
    try {
      let beginCalls = 0
      const fixture = harness(async (path) => {
        if (path.endsWith('/doc?format=qingml')) return editingDoc()
        if (path.endsWith('/review/annotations')) {
          return {
            status: 'created', docVersion: 1, groupCount: 1, anchorCount: 1, seq: 4,
            annotations: [{ id: 'annotation-1', summary: '句式生硬' }],
          }
        }
        throw new Error(`unexpected path: ${path}`)
      }, ONLINE_ENGINE, candidateDoc('开篇', '第一版正文。'), async (_path, init) => {
        const action = (JSON.parse(String(init?.body)) as { action: string }).action
        if (action === 'begin') {
          beginCalls += 1
          if (beginCalls <= 3) throw new EngineHttpError(409, { code: 'BUSY_NATIVE' })
        }
        return { active: action !== 'end' }
      })
      markReview(fixture)
      const entering = fixture.listeners.get('agent/pre-step')!(
        { agent: { id: 'dsh-1' }, turn: 66 },
        async () => ({ kind: 'enter', messages: [] }),
      )
      await vi.runAllTimersAsync()
      await entering
      await fixture.tools.get('qing_read_draft')!.execute(
        { mode: 'full' },
        exec(undefined, 'annotate-after-busy-read', 'qing_read_draft'),
      )
      await expect(fixture.tools.get('qing_annotate')!.execute(
        { groups },
        exec(undefined, 'annotate-after-busy', 'qing_annotate'),
      )).resolves.toMatchObject({ status: 'created', count: 1 })
      expect(beginCalls).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('VERSION_CONFLICT 自动重读、重建锚点并只重试一次，成功卡冻结数量与摘要', async () => {
    let currentVersion = 1
    const annotationBodies: Array<Record<string, unknown>> = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) return editingDoc(currentVersion)
      if (path.endsWith('/review/annotations')) {
        annotationBodies.push(JSON.parse(String(init?.body)))
        if (annotationBodies.length === 1) {
          currentVersion = 2
          throw new EngineHttpError(409, { code: 'VERSION_CONFLICT', expected: 1, actual: 2 })
        }
        return {
          status: 'created', docVersion: 2, groupCount: 1, anchorCount: 1, seq: 9,
          annotations: [{ id: 'annotation-1', summary: '句式生硬' }],
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    reviewTurnCoordinatorFor(fixture.engine).markPending('dsh-1', {
      type: 'sensitive', templateId: 'review-sensitive-default', templateName: '敏感词',
      targetEngineSessionId: 'qing-1',
    })
    await fixture.listeners.get('agent/pre-step')!(
      { agent: { id: 'dsh-1' }, turn: 64 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'full' },
      exec(undefined, 'annotate-read', 'qing_read_draft'),
    )
    const tool = fixture.tools.get('qing_annotate')!
    const result = await tool.execute(
      { groups },
      exec(undefined, 'annotate-write', 'qing_annotate'),
    ) as { count: number; summaries: string[] }

    expect(annotationBodies).toHaveLength(2)
    expect(annotationBodies.map((body) => body.expectedDocVersion)).toEqual([1, 2])
    expect(annotationBodies[0]).toMatchObject({
      groups: [{ origin: 'sensitive', anchors: [{ find: '第一版正文。' }] }],
    })
    expect(annotationBodies[1]).toMatchObject({
      groups: [{ origin: 'sensitive', anchors: [{ find: '第一版正文。' }] }],
    })
    expect(result).toEqual(expect.objectContaining({ count: 1, summaries: ['句式生硬'] }))
    const content = tool.output!.render({ groups } as never, result as never)
    const meta = tool.output!.presentationMeta!({ groups } as never, result as never)
    expect(content).toEqual([{ type: 'text', text: '审查批注已生成 · 1 处\n- 句式生硬' }])
    expect(tool.presentResult!({ groups } as never, { isError: false, content, meta })).toEqual({
      card: 'generic',
      title: '审查批注已生成 · 1 处',
      content: [{ type: 'text', text: '- 句式生硬' }],
    })
  })

  it('第二次 VERSION_CONFLICT 不再重试并原样交还引擎错误，失败卡保留事实', async () => {
    let currentVersion = 1
    let annotationCalls = 0
    const secondConflict = new EngineHttpError(409, {
      code: 'VERSION_CONFLICT', expected: 2, actual: 3, nextStep: 'read-latest',
    })
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return editingDoc(currentVersion)
      if (path.endsWith('/review/annotations')) {
        annotationCalls += 1
        if (annotationCalls === 1) {
          currentVersion = 2
          throw new EngineHttpError(409, { code: 'VERSION_CONFLICT', expected: 1, actual: 2 })
        }
        throw secondConflict
      }
      throw new Error(`unexpected path: ${path}`)
    })
    markReview(fixture)
    await fixture.listeners.get('agent/pre-step')!(
      { agent: { id: 'dsh-1' }, turn: 65 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'full' },
      exec(undefined, 'annotate-read-second-conflict', 'qing_read_draft'),
    )
    const tool = fixture.tools.get('qing_annotate')!
    const caught = await tool.execute(
      { groups },
      exec(undefined, 'annotate-second-conflict', 'qing_annotate'),
    ).catch((error: unknown) => error)
    expect(caught).toBe(secondConflict)
    expect(annotationCalls).toBe(2)
    const failureContent = [{ type: 'text' as const, text: 'Error: VERSION_CONFLICT expected 2 actual 3' }]
    expect(tool.presentResult!({ groups } as never, { isError: true, content: failureContent })).toEqual({
      card: 'generic', title: '审查批注生成失败', content: failureContent,
    })
  })
})

describe('素材读取工具', () => {
  it('映射素材清单并原样透传引擎的文本与截断元数据', async () => {
    const fixture = harness(async (path) => {
      if (path === '/sessions/qing-1/files') {
        return {
          sessionId: 'qing-1',
          materials: [
            { id: 'material-1', filename: '访谈.txt', parseState: 'ready', summary: '访谈摘要', wordCount: 12 },
            { id: 'material-2', filename: '附件.pdf', parseState: 'processing', summary: '' },
          ],
          folderSources: [],
        }
      }
      if (path === '/sessions/qing-1/files/material-1/text') {
        return {
          id: 'material-1', filename: '访谈.txt', mime: 'text/plain',
          text: '逐字素材文本。', byteLen: 4096, truncated: true,
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const listTool = fixture.tools.get('qing_list_materials')!
    const listed = await listTool.execute({}, exec(undefined, 'materials-list', 'qing_list_materials'))
    expect(listed).toEqual({
      materials: [
        { materialId: 'material-1', name: '访谈.txt', parseState: 'ready', summary: '访谈摘要' },
        { materialId: 'material-2', name: '附件.pdf', parseState: 'processing' },
      ],
    })
    expect(validateJsonSchemaValue(listTool.output!.schema, listed)).toEqual([])

    const readTool = fixture.tools.get('qing_read_material')!
    const read = await readTool.execute(
      { materialId: 'material-1' },
      exec(undefined, 'material-read', 'qing_read_material'),
    )
    expect(read).toEqual({
      materialId: 'material-1', name: '访谈.txt', mime: 'text/plain',
      text: '逐字素材文本。', byteLen: 4096, truncated: true,
    })
    expect(validateJsonSchemaValue(readTool.output!.schema, read)).toEqual([])
  })

  it('无素材时返回空清单', async () => {
    const fixture = harness(async (path) => {
      if (path === '/sessions/qing-1/files') return { sessionId: 'qing-1', materials: [], folderSources: [] }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_list_materials')!.execute(
      {},
      exec(undefined, 'materials-empty', 'qing_list_materials'),
    )).resolves.toEqual({ materials: [] })
  })

  it('素材 404 保留引擎错误，不伪造空文本', async () => {
    const missing = new EngineHttpError(404, { code: 'MATERIAL_NOT_FOUND', error: '素材不存在' })
    const fixture = harness(async (path) => {
      if (path.endsWith('/files/material-missing/text')) throw missing
      throw new Error(`unexpected path: ${path}`)
    })

    const caught = await fixture.tools.get('qing_read_material')!.execute(
      { materialId: 'material-missing' },
      exec(undefined, 'material-missing', 'qing_read_material'),
    ).catch((error: unknown) => error)
    expect(caught).toBe(missing)
  })

  it('审查回合内素材工具固定解析到打标稿，而非后来切换的活跃稿', async () => {
    const materialPaths: string[] = []
    const fixture = harness(async (path) => {
      if (path.includes('/doc?format=qingml')) return doc({ state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
      if (path.includes('/sessions/qing-1/files')) {
        materialPaths.push(path)
        if (path.endsWith('/text')) {
          return {
            id: 'material-1', filename: '目标素材.txt', mime: 'text/plain',
            text: '目标稿素材。', byteLen: 18, truncated: false,
          }
        }
        return {
          sessionId: 'qing-1',
          materials: [{ id: 'material-1', filename: '目标素材.txt', parseState: 'ready', summary: '' }],
          folderSources: [],
        }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('开篇', '第一版正文。'), undefined, true, {
      docs: [
        { engineSessionId: 'qing-1', title: '打标稿', createdAt: '2026-08-15T00:00:00.000Z' },
        { engineSessionId: 'qing-2', title: '切换稿', createdAt: '2026-08-15T00:01:00.000Z' },
      ],
      activeEngineSessionId: 'qing-2',
    })
    reviewTurnCoordinatorFor(fixture.engine).markPending('dsh-1', {
      type: 'source', templateId: 'review-source-default', templateName: '来源核查',
      targetEngineSessionId: 'qing-1',
    })
    await fixture.listeners.get('agent/pre-step')!(
      { agent: { id: 'dsh-1' }, turn: 68 },
      async () => ({ kind: 'enter', messages: [] }),
    )

    await fixture.tools.get('qing_list_materials')!.execute(
      {},
      exec(undefined, 'review-materials-list', 'qing_list_materials'),
    )
    await fixture.tools.get('qing_read_material')!.execute(
      { materialId: 'material-1' },
      exec(undefined, 'review-material-read', 'qing_read_material'),
    )
    expect(materialPaths).toEqual([
      '/sessions/qing-1/files',
      '/sessions/qing-1/files/material-1/text',
    ])
  })
})

describe('qing_* 未连接结构化报错', () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['qing_write_draft', { qingml: DRAFT_ONE }],
    ['qing_edit_draft', { ops: [{ kind: 'setTitle', title: '新标题' }] }],
    ['qing_review_commit', { action: 'accept_all' }],
    ['qing_read_draft', {}],
    ['qing_list_materials', {}],
    ['qing_read_material', { materialId: 'material-1' }],
    ['qing_list_docs', {}],
    ['qing_focus_doc', { docRef: 'qing-1' }],
  ]

  it.each(calls)('%s 在完全未检测到时返回统一安装/启动引导', async (name, args) => {
    const fixture = harness(async () => { throw new Error('不应访问引擎') }, {
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
    const fixture = harness(async () => { throw new Error('不应访问引擎') }, {
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

describe('工具用户呈现出口', () => {
  it('遍历全部工具的调用/失败呈现，不泄露内部定位术语或 ID', () => {
    const fixture = harness(async () => doc())
    const samples: Array<[string, Record<string, unknown>]> = [
      ['qing_write_draft', { qingml: DRAFT_ONE }],
      ['qing_edit_draft', { ops: [{ kind: 'strReplace', old: '旧', new: '新' }] }],
      ['qing_review_commit', { action: 'accept_all' }],
      ['qing_read_draft', { mode: 'outline' }],
      ['qing_list_docs', { scope: 'session' }],
      ['qing_focus_doc', { docRef: 'qing-1' }],
    ]
    for (const [name, args] of samples) {
      const tool = fixture.tools.get(name)!
      const presentation = [
        tool.presentCall?.(args as never),
        tool.presentResult?.(args as never, {
          isError: true,
          content: [{ type: 'text', text: 'Error: paragraph-block-9 的块 ID blockId_table-4 无效' }],
        }),
      ]
      expect(JSON.stringify(presentation)).not.toMatch(/块|blockId|ai-block|paragraph-block-9|table-4/i)
    }
  })
})

function candidateDoc(heading: string, paragraph: string): PmDoc {
  return {
    type: 'doc',
    attrs: { schemaVersion: 1 },
    content: [
      { type: 'heading', attrs: { blockId: 'heading-1', level: 1 }, content: [{ type: 'text', text: heading }] },
      { type: 'paragraph', attrs: { blockId: 'paragraph-1' }, content: [{ type: 'text', text: paragraph }] },
    ],
  } as PmDoc
}

function reviewSuggestion(
  id: string,
  status: 'reviewing' | 'accepted' | 'rejected' = 'reviewing',
) {
  return {
    id,
    kind: 'replace',
    status,
    anchor: {
      blockId: 'paragraph-1', pmFrom: 1, pmTo: 7,
      quote: '第一版正文。', textHash: `hash-${id}`,
    },
    preview: { deleteText: '第一版正文。', insertText: '候选正文。' },
  }
}

function paragraphDoc(...paragraphs: string[]): PmDoc {
  return {
    type: 'doc',
    attrs: { schemaVersion: 1 },
    content: paragraphs.map((text, index) => ({
      type: 'paragraph',
      attrs: { blockId: `paragraph-${index + 1}` },
      content: [{ type: 'text', text }],
    })),
  } as PmDoc
}

function tableDoc(): PmDoc {
  const cell = (type: 'tableHeader' | 'tableCell', text: string) => ({
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null },
    content: [{
      type: 'paragraph',
      attrs: { blockId: `cell-${text}` },
      content: [{ type: 'text', text }],
    }],
  })
  return {
    type: 'doc',
    attrs: { schemaVersion: 1 },
    content: [{
      type: 'table',
      attrs: { blockId: 'table-1' },
      content: [
        { type: 'tableRow', content: [cell('tableHeader', '事项'), cell('tableHeader', '状态')] },
        { type: 'tableRow', content: [cell('tableCell', '布置'), cell('tableCell', '待办')] },
      ],
    }],
  } as PmDoc
}

function mermaidDoc(source = 'flowchart TD\n  A --> B'): PmDoc {
  return {
    type: 'doc',
    attrs: { schemaVersion: 1 },
    content: [{
      type: 'diagram',
      attrs: { blockId: 'diagram-1', lang: 'mermaid', source, svg: null },
    }],
  } as PmDoc
}

describe('qing_write_draft', () => {
  it('主模型 QingML 全文经 qingmlDraft 单通道直写', async () => {
    let proposed = false
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed
          ? doc({ docVersion: 1, state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
          : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        expect(JSON.parse(String(init?.body))).toMatchObject({
          expectedDocVersion: 0,
          ops: [{ kind: 'qingmlDraft', qingml: DRAFT_ONE }],
        })
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const tool = fixture.tools.get('qing_write_draft')!
    expect(tool.parameters).toMatchObject({
      required: ['qingml'],
      properties: { qingml: { type: 'string' }, title: {}, requirements: {}, docRef: {} },
    })
    expect(Object.keys((tool.parameters as { properties: object }).properties))
      .toEqual(['qingml', 'title', 'requirements', 'docRef'])
    const result = await tool.execute(
      { qingml: DRAFT_ONE },
      exec(undefined, 'mainlink-write', 'qing_write_draft'),
    )

    expect(result).toMatchObject({
      status: 'committed',
      engineSessionId: 'qing-1',
      title: '测试稿',
      lengthStatus: 'not-requested',
      automaticConversions: 0,
    })
    expect(fixture.events.map(({ event }) => event.type)).toEqual(['doc-committed'])
    expect(fixture.events[0]?.event).toMatchObject({ revealWholeDraft: true })
  })

  it('已有稿仅在本回合读过 outline 时拒绝整稿改写', async () => {
    let proposals = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 2, state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
      }
      if (path.endsWith('/proposals')) {
        proposals += 1
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, compileQingmlDocument(DRAFT_ONE))
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 40 }, async () => ({ kind: 'enter', messages: [] }))

    await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'outline' },
      exec(undefined, 'outline-before-rewrite', 'qing_read_draft'),
    )
    await expect(fixture.tools.get('qing_write_draft')!.execute(
      { qingml: DRAFT_TWO, docRef: 'qing-1' },
      exec(undefined, 'rewrite-after-outline', 'qing_write_draft'),
    )).rejects.toThrow('mode:"full"')
    expect(proposals).toBe(0)
  })

  it.each(['full', 'base', 'lines'] as const)('已有稿在本回合读过 mode:%s 全文后允许整稿改写', async (mode) => {
    let proposed = false
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed
          ? doc({ docVersion: 3, state: 'editing', qingml: DRAFT_TWO, title: '测试稿' })
          : doc({ docVersion: 2, state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
      }
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '# 开篇\n\n第一版正文。',
          markdownWithLineNumbers: '   1 | # 开篇\n   2 | \n   3 | 第一版正文。',
          title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, compileQingmlDocument(DRAFT_TWO))
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 41 }, async () => ({ kind: 'enter', messages: [] }))

    await fixture.tools.get('qing_read_draft')!.execute(
      { mode },
      exec(undefined, `full-before-rewrite-${mode}`, 'qing_read_draft'),
    )
    await expect(fixture.tools.get('qing_write_draft')!.execute(
      { qingml: DRAFT_TWO, docRef: 'qing-1' },
      exec(undefined, `rewrite-after-${mode}`, 'qing_write_draft'),
    )).resolves.toMatchObject({ status: 'committed', docVersion: 3 })
  })

  it('字数不达标仍直接提交并继承首稿合同，第二稿未缩小差距时拒绝第三次', async () => {
    const qingml = '<title>测试稿</title><h1>测试稿</h1><p>短稿。</p>'
    const pmDoc = compileQingmlDocument(qingml)
    const actual = countDocVisibleChars(pmDoc)
    let version = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return version === 0
          ? doc()
          : doc({ docVersion: version, state: 'editing', qingml, title: '测试稿' })
      }
      if (path.endsWith('/proposals')) {
        version += 1
        return { status: 'committed', docVersion: version }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)
    const tool = fixture.tools.get('qing_write_draft')!
    const context = exec(undefined, 'length-retry', 'qing_write_draft')

    await expect(tool.execute({ qingml, requirements: '约 100 字' }, context))
      .resolves.toMatchObject({
        status: 'committed',
        lengthStatus: 'target-missed',
        lengthGap: actual - 100,
        words: actual,
      })
    await expect(tool.execute({ qingml, docRef: 'qing-1' }, context))
      .resolves.toMatchObject({
        status: 'committed',
        lengthStatus: 'target-missed',
        lengthGap: actual - 100,
      })
    await expect(tool.execute({ qingml, requirements: '约 100 字', docRef: 'qing-1' }, context))
      .rejects.toThrow('重交额度已用尽')
    expect(version).toBe(2)
  })

  it('前两稿偏差都超过 15% 且持续缩小时允许第二次重交，第三稿达标后停止', async () => {
    const drafts = [60, 75, 90].map((size) =>
      `<title>题</title><h1>题</h1><p>${'甲'.repeat(size)}</p>`)
    const pmDocs = drafts.map(compileQingmlDocument)
    const actuals = pmDocs.map(countDocVisibleChars)
    expect(Math.abs(actuals[0]! - 100) / 100).toBeGreaterThan(0.15)
    expect(Math.abs(actuals[1]! - 100) / 100).toBeGreaterThan(0.15)
    expect(Math.abs(actuals[1]! - 100)).toBeLessThan(Math.abs(actuals[0]! - 100))
    expect(Math.abs(actuals[2]! - 100) / 100).toBeLessThanOrEqual(0.1)

    let version = 0
    const fixture = harness(async () => { throw new Error('dynamic fetch mock not installed') })
    vi.mocked(fixture.engine.fetchJson).mockImplementation(async (path) => {
      if (path.endsWith('/doc?format=pm')) {
        return { pmDoc: pmDocs[Math.max(0, version - 1)] }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return version === 0
          ? doc()
          : doc({ docVersion: version, state: 'editing', qingml: drafts[version - 1], title: '题' })
      }
      if (path.endsWith('/proposals')) {
        version += 1
        return { status: 'committed', docVersion: version }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const tool = fixture.tools.get('qing_write_draft')!
    const context = exec(undefined, 'length-second-retry', 'qing_write_draft')

    await expect(tool.execute({ qingml: drafts[0], requirements: '约 100 字' }, context))
      .resolves.toMatchObject({ lengthStatus: 'target-missed', lengthGap: actuals[0]! - 100 })
    await expect(tool.execute({ qingml: drafts[1], docRef: 'qing-1' }, context))
      .resolves.toMatchObject({ lengthStatus: 'target-missed', lengthGap: actuals[1]! - 100 })
    await expect(tool.execute({ qingml: drafts[2], docRef: 'qing-1' }, context))
      .resolves.toMatchObject({ lengthStatus: 'met', lengthGap: actuals[2]! - 100 })
    await expect(tool.execute({ qingml: drafts[2], docRef: 'qing-1' }, context))
      .rejects.toThrow('重交额度已用尽')
    expect(version).toBe(3)
  })

  it('首稿没有 requirements 也无条件允许同回合同稿整稿重交一次', async () => {
    const qingml = '<title>测试稿</title><h1>测试稿</h1><p>无需字数合同。</p>'
    const pmDoc = compileQingmlDocument(qingml)
    let version = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return version === 0
          ? doc()
          : doc({ docVersion: version, state: 'editing', qingml, title: '测试稿' })
      }
      if (path.endsWith('/proposals')) {
        version += 1
        return { status: 'committed', docVersion: version }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc, undefined, false)
    const tool = fixture.tools.get('qing_write_draft')!
    const context = exec(undefined, 'unconditional-retry', 'qing_write_draft')
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 42 }, async () => ({ kind: 'enter', messages: [] }))

    await expect(tool.execute({ qingml }, context))
      .resolves.toMatchObject({ status: 'committed', lengthStatus: 'not-requested' })
    await expect(tool.execute({ qingml, docRef: 'qing-1' }, context))
      .resolves.toMatchObject({ status: 'committed', lengthStatus: 'not-requested' })
    await expect(tool.execute({ qingml, docRef: 'qing-1' }, context))
      .rejects.toThrow('重交额度已用尽')
    expect(version).toBe(2)
  })

  it('显式标题统一 title/h1，源写法确定性转换后再提交', async () => {
    const exactTitle = '用户指定标题'
    const submitted = '<title>旧标题</title><h1>旧标题</h1><p>正文[^1]，参数 $\\alpha$。</p><p>[^1]: 来源甲</p>'
    const stored = '<title>用户指定标题</title><h1>用户指定标题</h1><p>正文<footnote id="1">来源甲</footnote>，参数 <math>\\alpha</math>。</p>'
    let proposed = false
    const pmDoc = compileQingmlDocument(stored)
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed ? doc({ docVersion: 1, state: 'editing', qingml: stored, title: exactTitle }) : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        expect(JSON.parse(String(init?.body))).toMatchObject({
          ops: [{ kind: 'qingmlDraft', qingml: stored }],
        })
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)

    await expect(fixture.tools.get('qing_write_draft')!.execute(
      { qingml: submitted, title: exactTitle },
      exec(undefined, 'title-source-write', 'qing_write_draft'),
    )).resolves.toMatchObject({
      title: exactTitle,
      automaticConversions: 2,
      footnotes: 1,
      formulas: 1,
    })
  })

  it('正文缺失或不可转换的源语法在提案前拒绝', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc()
      throw new Error(`不应调用 ${path}`)
    })
    const tool = fixture.tools.get('qing_write_draft')!

    await expect(tool.execute(
      { qingml: EMPTY_DRAFT },
      exec(undefined, 'bodyless', 'qing_write_draft'),
    )).rejects.toThrow('只有标题、缺少正文')
    await expect(tool.execute(
      { qingml: UNRESOLVED_FOOTNOTE_DRAFT },
      exec(undefined, 'source-leak', 'qing_write_draft'),
    )).rejects.toThrow('无法识别的脚注或公式写法')
    expect(fixture.engine.fetchJson).not.toHaveBeenCalledWith(expect.stringContaining('/proposals'), expect.anything())
  })

  it('首稿正文首尾疑似混入字数指令时告警但不阻断提交', async () => {
    const qingml = '<title>测试稿</title><h1>测试稿</h1><p>字数要求：不超过 100 字。</p><p>正文。</p>'
    const pmDoc = compileQingmlDocument(qingml)
    let proposed = false
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed
          ? doc({ docVersion: 1, state: 'editing', qingml, title: '测试稿' })
          : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)

    await expect(fixture.tools.get('qing_write_draft')!.execute(
      { qingml, requirements: '不超过 100 字' },
      exec(undefined, 'instruction-leak-warning', 'qing_write_draft'),
    )).resolves.toMatchObject({
      status: 'committed',
      warning: expect.stringContaining('字数/格式要求属于写作指令'),
    })
  })

  it('pendingReview 在直写前拦截且失败也清理 host 选段', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc({ state: 'pendingReview', docVersion: 3 })
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_write_draft')!.execute(
      { qingml: DRAFT_ONE, docRef: 'qing-1' },
      exec(undefined, 'pending-write', 'qing_write_draft'),
    )).rejects.toThrow('ask_user')
    expect(fixture.bridge.clearSelection).toHaveBeenCalledWith('dsh-1')
  })

  it('proposal 进入 review 后读候选快照但保留最终中文收尾 step', async () => {
    let proposed = false
    const reviewPmDoc = candidateDoc('候选标题', '候选正文。')
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed
          ? doc({ docVersion: 1, state: 'pendingReview', qingml: DRAFT_ONE, title: '测试稿' })
          : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        return { status: 'review', patchIds: ['patch-1'], count: 1 }
      }
      if (path.endsWith('/review?format=render-model')) {
        return {
          sessionId: 'qing-1', docVersion: 1, state: 'pendingReview', agentBusy: false,
          baseVersion: 1, suggestions: [reviewSuggestion('patch-1')], wholeDocument: true,
          editedDoc: reviewPmDoc,
        }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, reviewPmDoc)
    const context = exec(undefined, 'review-write', 'qing_write_draft')

    const result = await fixture.tools.get('qing_write_draft')!.execute({ qingml: DRAFT_ONE }, context)
    expect(result).toMatchObject({
      status: 'review',
      patchCount: 1,
      patchIds: ['patch-1'],
      words: countDocVisibleChars(reviewPmDoc),
    })
    expect(context.concludeTurn).not.toHaveBeenCalled()
    expect(fixture.events.map(({ event }) => event.type)).toEqual(['doc-review-pending'])
    const rendered = fixture.tools.get('qing_write_draft')!.output?.render({}, result as never)
    expectReviewEndMessage((rendered?.[0] as { text: string }).text)
  })
})
describe('qing_review_commit', () => {
  it('按读到的版本提交全部裁决，读回 official 并广播 doc-committed', async () => {
    let reads = 0
    const official = doc({ docVersion: 4, state: 'editing', qingml: DRAFT_TWO, title: '测试稿' })
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        reads += 1
        return reads === 1 ? doc({ docVersion: 3, state: 'pendingReview', qingml: DRAFT_ONE, title: '测试稿' }) : official
      }
      if (path.endsWith('/review/commit')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedDocVersion: 3,
          action: 'accept_all',
          turnId: expect.any(String),
        })
        return {
          status: 'reviewed', docVersion: 4, acceptedCount: 2, rejectedCount: 0,
          remainingCount: 0, outcomeQueued: true,
          outcome: { acceptedCount: 2, rejectedCount: 0, hunks: [] }, seq: 9,
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const result = await fixture.tools.get('qing_review_commit')!.execute({ action: 'accept_all' }, exec())

    expect(result).toMatchObject({
      status: 'reviewed',
      docVersion: 4,
      acceptedCount: 2,
      rejectedCount: 0,
      message: expect.stringContaining('请继续完成已排队编辑'),
    })
    expect((result as { message: string }).message).not.toMatch(/v\d+/)
    expect(fixture.events.at(-1)).toMatchObject({
      sessionId: 'dsh-1',
      event: { type: 'doc-committed', engineSessionId: 'qing-1', doc: official },
    })
    expect(fixture.telemetry.capture).toHaveBeenCalledWith('review_settled', {
      action: 'commit', patches_bucket: '2-5', retried: false,
    })
  })

  it('非 pendingReview 返回无待审变更且不发 POST', async () => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc({ state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
      throw new Error(`不应调用 ${path}`)
    })

    const result = await fixture.tools.get('qing_review_commit')!.execute({ action: 'reject_all' }, exec())
    expect(result).toMatchObject({
      status: 'no_pending_review',
      message: expect.stringContaining('【文稿状态】已落库生效,当前无待审稿'),
      docVersion: 0,
    })
    expect((result as { message: string }).message).not.toMatch(/v\d+/)
  })

  it('同一 agent 回合第二次调用在访问引擎前硬拦截', async () => {
    let reads = 0
    const fixture = harness(async (path) => {
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
    const reviewPmDoc = candidateDoc('候选标题', '候选正文。')
    const fixture = harness(async (path) => {
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
          baseVersion: 3, suggestions: [], editedDoc: reviewPmDoc,
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const tool = fixture.tools.get('qing_read_draft')!

    const candidate = await tool.execute({ mode: 'full' }, exec(undefined, 'read-candidate', 'qing_read_draft'))
    const base = await tool.execute({ mode: 'base' }, exec(undefined, 'read-base', 'qing_read_draft'))

    expect(candidate).toMatchObject({
      mode: 'full',
      blocks: 2,
      words: countDocVisibleChars(reviewPmDoc),
      structure: '一个标题加 1 段正文',
      docVersion: 3,
    })
    expect((candidate as { content: string }).content).toContain('以下为待审候选（尚未生效）；已提交基线请传 mode:"base"。')
    expect((candidate as { content: string }).content).toContain('<h1>候选标题</h1><p>候选正文。</p>')
    expect((candidate as { content: string }).content).not.toContain('基线正文')
    expect((base as { content: string }).content).toContain('以下为已提交基线（不含待审候选）。')
    expect((base as { content: string }).content).toContain('<p>基线正文。</p>')
    expect(JSON.stringify(tool.output?.render({ mode: 'full' }, candidate as never))).not.toMatch(/v\d+/)
  })

  it('按 PmDoc 返回含标点的可见字符数并渲染用户语言结构', async () => {
    const pmDoc = paragraphDoc('你好，世界！')
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 6, state: 'editing', qingml: '<p>你好，世界！</p>', title: '标点稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)
    const tool = fixture.tools.get('qing_read_draft')!

    const result = await tool.execute({ mode: 'outline' }, exec(undefined, 'read-punctuation', 'qing_read_draft'))

    expect(countDocVisibleChars(pmDoc)).toBe(6)
    expect(result).toMatchObject({ words: 6, structure: '1 段正文', docVersion: 6 })
    const rendered = tool.output?.render({ mode: 'outline' }, result as never)
    expect(rendered).toEqual([{
      type: 'text',
      text: '【文稿状态】已落库生效,无待审稿。\n《标点稿》｜1 段正文｜约 6 字\n暂无标题层级。',
    }])
    expect(JSON.stringify(rendered)).not.toMatch(/v\d+/)
  })

  it('mode:lines 返回引擎的 Markdown 行号语料', async () => {
    const fixture = harness(async (path) => {
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

  it('所有读取模式都不泄露真实内容 ID 或裸内部术语，定位模式只返回机器 locator', async () => {
    const rawPmDoc = {
      type: 'doc', attrs: { schemaVersion: 1 }, content: [
        { type: 'heading', attrs: { blockId: 'ai-block-heading_9', level: 1 }, content: [{ type: 'text', text: '标题' }] },
        { type: 'paragraph', attrs: { blockId: 'block-paragraph_7' }, content: [{ type: 'text', text: '正文。' }] },
      ],
    } as PmDoc
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 8, state: 'editing', qingml: '<h1>标题</h1><p>正文。</p>', title: '定位测试' })
      }
      if (path.endsWith('/doc?lines=1')) {
        return { sessionId: 'qing-1', docVersion: 8, state: 'editing', agentBusy: false, markdown: '# 标题\n\n正文。', title: '定位测试' }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, rawPmDoc)
    const tool = fixture.tools.get('qing_read_draft')!

    for (const mode of ['outline', 'full', 'base', 'lines', 'blocks'] as const) {
      const result = await tool.execute({ mode }, exec(undefined, `read-safe-${mode}`, 'qing_read_draft'))
      const rendered = JSON.stringify(tool.output?.render({ mode }, result as never))
      expect(rendered).not.toMatch(/ai-block-|block-paragraph|blockId|块/u)
      if (mode === 'blocks') {
        expect(result).toMatchObject({ content: expect.stringContaining('locator=L1') })
        expect((result as { content: string }).content).toContain('locator=L2')
      }
    }
  })

  it('同回合同版本重复 full 读取只返回复用提示，大正文不再重复进入上下文', async () => {
    const body = '长正文。'.repeat(2_000)
    const qingml = `<title>长稿</title><h1>长稿</h1><p>${body}</p>`
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 12, state: 'editing', qingml, title: '长稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc(body))
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 21 }, async () => ({ kind: 'enter', messages: [] }))
    const tool = fixture.tools.get('qing_read_draft')!

    const first = await tool.execute({ mode: 'full' }, exec(undefined, 'read-full-first', 'qing_read_draft')) as { content: string }
    const second = await tool.execute({ mode: 'full' }, exec(undefined, 'read-full-second', 'qing_read_draft')) as { content: string }

    expect(first.content.length).toBeGreaterThan(8_000)
    expect(second.content).toBe('本回合已读取过相同版本的完整文稿；请沿用上一次结果，不要重复读取。')
    expect(second.content.length / first.content.length).toBeLessThan(0.01)
  })

  it('committed 写后显式以新 docVersion 覆盖快照并清 marks，作者再读不打引擎', async () => {
    let proposed = false
    let qingmlReads = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        qingmlReads += 1
        return proposed
          ? doc({ docVersion: 3, state: 'editing', qingml: DRAFT_TWO, title: '测试稿' })
          : doc({ docVersion: 2, state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('开篇', '修正后的正文。'))
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 30 }, async () => ({ kind: 'enter', messages: [] }))
    await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'full' },
      exec(undefined, 'snapshot-committed-before', 'qing_read_draft'),
    )
    await fixture.tools.get('qing_write_draft')!.execute(
      { qingml: DRAFT_TWO, docRef: 'qing-1' },
      exec(undefined, 'snapshot-committed-write', 'qing_write_draft'),
    )
    const readsAfterWrite = qingmlReads
    const first = await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'full' },
      exec(undefined, 'snapshot-committed-read', 'qing_read_draft'),
    ) as { content: string; docVersion: number }
    expect(first).toMatchObject({ content: DRAFT_TWO, docVersion: 3 })
    expect(qingmlReads).toBe(readsAfterWrite)
  })

  it('review 写后显式 invalidateSnapshot+清 marks，下次读取重拿候选而不复用旧稿', async () => {
    let proposed = false
    let qingmlReads = 0
    const reviewPmDoc = candidateDoc('候选标题', '候选正文。')
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        qingmlReads += 1
        return doc({
          docVersion: 2,
          state: proposed ? 'pendingReview' : 'editing',
          qingml: DRAFT_ONE,
          title: '测试稿',
        })
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        return { status: 'review', patchIds: ['patch-1'], count: 1 }
      }
      if (path.endsWith('/review?format=render-model')) {
        return { baseVersion: 2, suggestions: [reviewSuggestion('patch-1')], editedDoc: reviewPmDoc }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('开篇', '第一版正文。'))
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 31 }, async () => ({ kind: 'enter', messages: [] }))
    await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'full' },
      exec(undefined, 'snapshot-review-before', 'qing_read_draft'),
    )
    await fixture.tools.get('qing_write_draft')!.execute(
      { qingml: DRAFT_TWO, docRef: 'qing-1' },
      exec(undefined, 'snapshot-review-write', 'qing_write_draft'),
    )
    const readsAfterWrite = qingmlReads
    const read = await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'full' },
      exec(undefined, 'snapshot-review-read', 'qing_read_draft'),
    ) as { content: string }
    expect(qingmlReads).toBe(readsAfterWrite + 1)
    expect(read.content).toContain('候选正文')
  })
})

describe('qing_edit_draft', () => {
  it('本回合未读稿硬拦截，任一 read mode 成功后放行且下一回合重新变陈旧', async () => {
    let edited = false
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({
          docVersion: edited ? 3 : 2,
          state: 'editing',
          qingml: edited ? DRAFT_TWO : DRAFT_ONE,
          title: '测试稿',
        })
      }
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '# 开篇\n\n第一版正文。', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        edited = true
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 4 }, async () => ({ kind: 'enter', messages: [] }))
    const edit = fixture.tools.get('qing_edit_draft')!
    const callsBeforeGate = vi.mocked(fixture.engine.fetchJson).mock.calls.length

    const blocked = await edit.execute({
      ops: [{ kind: 'strReplace', old: '第一版正文。', new: '修正后的正文。' }],
    }, exec(undefined, 'stale-edit', 'qing_edit_draft')).catch((error: unknown) => error)
    expect(blocked).toBeInstanceOf(Error)
    expect((blocked as Error).message).toBe('请先调用 qing_read_draft 读取当前文稿，再基于最新内容修改。')
    expect((blocked as Error).message).not.toMatch(/pendingReview|docRef|blockId|HTTP/i)
    expect(vi.mocked(fixture.engine.fetchJson).mock.calls).toHaveLength(callsBeforeGate)

    await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'outline' },
      exec(undefined, 'fresh-read', 'qing_read_draft'),
    )
    await expect(edit.execute({
      ops: [{ kind: 'strReplace', old: '第一版正文。', new: '修正后的正文。' }],
    }, exec(undefined, 'allowed-edit', 'qing_edit_draft'))).resolves.toMatchObject({ status: 'committed' })

    await preStep({ agent: { id: 'dsh-1' }, turn: 5 }, async () => ({ kind: 'enter', messages: [] }))
    await expect(edit.execute({
      ops: [{ kind: 'strReplace', old: '修正后的正文。', new: '再次修改。' }],
    }, exec(undefined, 'next-turn-edit', 'qing_edit_draft'))).rejects.toThrow('qing_read_draft')
  })

  it('把 blocks 模式的短 locator 映射为引擎 ID，真实 ID 不进入读稿返回', async () => {
    let proposalBody: { ops: unknown[] } | undefined
    const pmDoc = candidateDoc('标题', '要删除的段落。')
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 2, state: 'editing', qingml: '<h1>标题</h1><p>要删除的段落。</p>', title: '测试稿' })
      }
      if (path.endsWith('/doc?lines=1')) {
        return { sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false, markdown: '# 标题\n\n要删除的段落。', title: '测试稿' }
      }
      if (path.endsWith('/proposals')) {
        proposalBody = JSON.parse(String(init?.body))
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 22 }, async () => ({ kind: 'enter', messages: [] }))

    const located = await fixture.tools.get('qing_read_draft')!.execute(
      { mode: 'blocks' },
      exec(undefined, 'read-locators', 'qing_read_draft'),
    ) as { content: string }
    expect(located.content).toContain('locator=L2')
    expect(located.content).not.toMatch(/heading-1|paragraph-1|blockId|块/u)

    await fixture.tools.get('qing_edit_draft')!.execute(
      { ops: [{ kind: 'deleteBlock', locator: 'L2' }] },
      exec(undefined, 'delete-by-locator', 'qing_edit_draft'),
    )
    expect(proposalBody?.ops).toEqual([{ kind: 'deleteBlock', blockId: 'paragraph-1' }])
    expect(JSON.stringify(fixture.tools.get('qing_edit_draft')!.parameters)).not.toContain('blockId')
  })

  it('描述要求同名纸面标题生效后自动跟随稿名，无同名标题才直改元数据', () => {
    const fixture = harness(async () => { throw new Error('不应访问引擎') })
    const tool = fixture.tools.get('qing_edit_draft')!
    expect(tool.description).toContain('正文有与旧稿名相同的纸面大标题,只需用 strReplace 改纸面标题')
    expect(tool.description).toContain('稿名会在修改生效后自动跟随')
    expect(tool.description).toContain('正文没有同名纸面大标题时才用 setTitle 直接改稿名')
    expect(JSON.stringify(tool.parameters)).toContain('有同名大标题时只用 strReplace')
  })

  it('纸面开头标题与旧稿名一致时，setTitle 缺少正文同步修改会在提交前拒绝', async () => {
    let proposals = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '# 旧标题\n\n正文', title: '旧标题',
        }
      }
      if (path.endsWith('/proposals')) proposals += 1
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('旧标题', '正文'))

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'setTitle', title: '新标题' }],
    }, exec(undefined, 'edit-title-gate', 'qing_edit_draft'))).rejects.toThrow(
      '稿名和纸面开头的标题需要一起修改。请在同一批修改中，把正文开头的「旧标题」也改成「新标题」。',
    )
    expect(proposals).toBe(0)
  })

  it('同名文字出现多处时，只有确实指向标题的替换才算完成联动', async () => {
    let proposals = 0
    const pmDoc = candidateDoc('旧标题', '正文也提到旧标题')
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '# 旧标题\n\n正文也提到旧标题', title: '旧标题',
        }
      }
      if (path.endsWith('/proposals')) proposals += 1
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [
        { kind: 'setTitle', title: '新标题' },
        { kind: 'strReplace', old: '旧标题', new: '新标题', nth: 2 },
      ],
    }, exec(undefined, 'edit-title-wrong-match', 'qing_edit_draft'))).rejects.toThrow(
      '稿名和纸面开头的标题需要一起修改',
    )
    expect(proposals).toBe(0)
  })

  it('正文没有标题时允许单独修改稿名', async () => {
    let proposed = false
    const body = paragraphDoc('正文')
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '正文', title: '旧标题',
        }
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        expect(JSON.parse(String(init?.body))).toMatchObject({
          expectedDocVersion: 2,
          ops: [{ kind: 'setTitle', title: '新标题' }],
        })
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml') && proposed) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<p>正文</p>', title: '新标题' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, body)

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'setTitle', title: '新标题' }],
    }, exec(undefined, 'edit-title-no-heading', 'qing_edit_draft'))).resolves.toMatchObject({
      status: 'committed', title: '新标题', structure: '1 段正文',
    })
  })

  it('兼容同批 setTitle+正文改名：提交时扣留 setTitle，只让正文进入审阅', async () => {
    let proposed = false
    const ops = [
      { kind: 'setTitle' as const, title: '新标题' },
      { kind: 'strReplace' as const, old: '旧标题', new: '新标题', nth: 1 },
    ]
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '# 旧标题\n\n正文', title: '旧标题',
        }
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        expect(JSON.parse(String(init?.body))).toMatchObject({
          expectedDocVersion: 2,
          ops: [{ kind: 'strReplace', old: '旧标题', new: '新标题', nth: 1 }],
        })
        return { status: 'review', patchIds: ['patch-title'], count: 1 }
      }
      if (path.endsWith('/doc?format=qingml') && proposed) {
        return doc({ docVersion: 2, state: 'pendingReview', qingml: '<h1>旧标题</h1><p>正文</p>', title: '旧标题' })
      }
      if (path.endsWith('/review?format=render-model')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'pendingReview', agentBusy: false,
          baseVersion: 2, suggestions: [reviewSuggestion('patch-title')],
          editedDoc: candidateDoc('新标题', '正文'),
        }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('旧标题', '正文'))

    await expect(fixture.tools.get('qing_edit_draft')!.execute({ ops }, exec(undefined, 'edit-title-sync', 'qing_edit_draft')))
      .resolves.toMatchObject({ status: 'review', title: '旧标题' })
    expect(fixture.pendingTitles.hasPendingTitle('dsh-1', 'qing-1')).toBe(true)
  })

  it('只改同名纸面 H1 时自动扣留目标，正文直落后补发稿名', async () => {
    let bodyCommitted = false
    let titleCommitted = false
    const proposalBodies: Array<{ ops: Array<Record<string, unknown>> }> = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '# 旧标题\n\n正文', title: '旧标题',
        }
      }
      if (path.endsWith('/proposals')) {
        const body = JSON.parse(String(init?.body)) as { ops: Array<Record<string, unknown>> }
        proposalBodies.push(body)
        if (body.ops.some((op) => op.kind === 'strReplace')) bodyCommitted = true
        if (body.ops.some((op) => op.kind === 'setTitle')) titleCommitted = true
        return { status: 'committed', docVersion: bodyCommitted ? 3 : 2 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({
          docVersion: bodyCommitted ? 3 : 2,
          state: 'editing',
          qingml: bodyCommitted ? '<h1>新标题</h1><p>正文</p>' : '<h1>旧标题</h1><p>正文</p>',
          title: titleCommitted ? '新标题' : '旧标题',
        })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('旧标题', '正文'))

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '旧标题', new: '新标题', nth: 1 }],
    }, exec(undefined, 'edit-title-auto-follow', 'qing_edit_draft'))).resolves.toMatchObject({
      status: 'committed', title: '新标题',
    })

    expect(proposalBodies.map((body) => body.ops)).toEqual([
      [{ kind: 'strReplace', old: '旧标题', new: '新标题', nth: 1 }],
      [{ kind: 'setTitle', title: '新标题' }],
    ])
    expect(fixture.pendingTitles.hasPendingTitle('dsh-1', 'qing-1')).toBe(false)
  })

  it('描述明确同批行号逐 op 推进、多行块与块级锚点约束', () => {
    const fixture = harness(async () => { throw new Error('不应访问引擎') })
    const description = fixture.tools.get('qing_edit_draft')!.description
    expect(description).toContain('同批先增删内容会令后续旧行号失效')
    expect(description).toContain('复杂清单或表格附近优先使用 mode:"blocks" 给出的 locator')
    expect(description).toContain('真实引擎标识由工具内部映射')
  })

  it('描述与 schema 仅为用户明确的全局意图开放 all:true', () => {
    const fixture = harness(async () => { throw new Error('不应访问引擎') })
    const tool = fixture.tools.get('qing_edit_draft')!
    expect(tool.description).toContain('只有用户明确表达「所有/全部/凡是/都」等全局意图时,才用单个 strReplace + all:true')
    expect(tool.description).toContain('all:true 不得与 nth 同时使用')
    expect(JSON.stringify(tool.parameters)).toContain('用户明确说「所有/全部/凡是/都」等全局范围时设为 true')
    expect(validateJsonSchemaValue(tool.parameters, {
      ops: [{ kind: 'strReplace', old: '旧词', new: '新词', all: true }],
    })).toEqual([])
  })

  it('strReplace all:true 将 5 处命中作为单项全量提交并返回计数事实', async () => {
    const old = '旧词'
    const newText = '新词'
    let proposalCalls = 0
    let proposalOps: unknown[] = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: Array.from({ length: 5 }, () => old).join('\n\n'), title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalCalls += 1
        proposalOps = (JSON.parse(String(init?.body)) as { ops: unknown[] }).ops
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: Array.from({ length: 5 }, () => `<p>${newText}</p>`).join(''), title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc(old, old, old, old, old))

    const result = await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old, new: newText, all: true }],
    }, exec(undefined, 'edit-all-five', 'qing_edit_draft'))

    expect(proposalCalls).toBe(1)
    expect(proposalOps).toEqual([5, 4, 3, 2, 1].map((nth) => ({
      kind: 'strReplace', old, new: newText, nth,
    })))
    expect(result).toMatchObject({
      affectedCount: 5,
      opResults: [{ opIndex: 1, affectedCount: 5 }],
      message: expect.stringContaining('第 1 项修改 5 处；本批共影响 5 处。'),
    })
    const countLine = (result as { message: string }).message.split('\n').find((line) => line.includes('本批共影响')) ?? ''
    expect(countLine).not.toMatch(/strReplace|nth|all|HTTP|\b400\b/i)
  })

  it('strReplace all:true 命中 1 处时正常提交且计数为 1', async () => {
    let proposalOps: unknown[] = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '唯一目标', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalOps = (JSON.parse(String(init?.body)) as { ops: unknown[] }).ops
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<p>新目标</p>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc('唯一目标'))

    const result = await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '唯一目标', new: '新目标', all: true }],
    }, exec(undefined, 'edit-all-one', 'qing_edit_draft'))

    expect(proposalOps).toEqual([{ kind: 'strReplace', old: '唯一目标', new: '新目标', nth: 1 }])
    expect(result).toMatchObject({ affectedCount: 1, opResults: [{ opIndex: 1, affectedCount: 1 }] })
  })

  it('strReplace all:true 与 nth 同传时用用户可理解的范围错误拒绝', async () => {
    let proposalCalls = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '重复目标\n\n重复目标', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalCalls += 1
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc('重复目标', '重复目标'))

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '重复目标', new: '新目标', all: true, nth: 1 }],
    }, exec(undefined, 'edit-all-conflict', 'qing_edit_draft')))
      .rejects.toThrow('不能同时选择全部替换和单处位置')
    expect(proposalCalls).toBe(0)
  })

  it('strReplace all:true 命中 0 处时沿用明确的未命中错误', async () => {
    let proposalCalls = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '现有正文', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalCalls += 1
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc('现有正文'))

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '不存在', new: '新目标', all: true }],
    }, exec(undefined, 'edit-all-zero', 'qing_edit_draft'))).rejects.toThrow('命中 0 处')
    expect(proposalCalls).toBe(0)
  })

  it('strReplace 命中 2 处且未指定 nth 时整批前置拒绝', async () => {
    let proposalCalls = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '重复目标\n\n重复目标', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalCalls += 1
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc('重复目标', '重复目标'))

    const promise = fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '重复目标', new: '新目标' }],
    }, exec(undefined, 'edit-ambiguous', 'qing_edit_draft'))

    await expect(promise).rejects.toThrow('命中 2 处，未指定 nth')
    await expect(promise).rejects.toThrow('先用原生 ask_user 让用户选')
    expect(proposalCalls).toBe(0)
    expect(vi.mocked(fixture.engine.fetchJson).mock.calls.map(([path]) => path)).toEqual([
      '/sessions/qing-1/doc?lines=1',
      '/sessions/qing-1/doc?format=pm',
    ])
  })

  it('strReplace 命中 1 处时正常调用提案引擎', async () => {
    let proposalCalls = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '唯一目标', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalCalls += 1
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<p>新目标</p>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc('唯一目标'))

    const result = await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '唯一目标', new: '新目标' }],
    }, exec(undefined, 'edit-unique', 'qing_edit_draft'))

    expect(proposalCalls).toBe(1)
    expect(result).toMatchObject({ affectedCount: 1, opResults: [{ opIndex: 1, affectedCount: 1 }] })
  })

  it('替换全文最后一句的后半截时自动扩成完整末句，避免旧句前半残留', async () => {
    const fullLastSentence = '全文最后一句的旧前半，它沉默地等着旧班车。'
    const replacement = '全文最后一句已经完整替换。'
    const current = `开场说明。${fullLastSentence}`
    let proposalOps: unknown[] = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: current, title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalOps = (JSON.parse(String(init?.body)) as { ops: unknown[] }).ops
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: `<p>开场说明。${replacement}</p>`, title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc(current))

    await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '它沉默地等着旧班车。', new: replacement }],
    }, exec(undefined, 'edit-final-sentence', 'qing_edit_draft'))

    expect(proposalOps).toEqual([{ kind: 'strReplace', old: fullLastSentence, new: replacement }])
  })

  it('跨段 Markdown 替换预先编译为稳定的插入加删除操作', async () => {
    const currentPm = paragraphDoc('第一段旧文。', '第二段旧文。', '尾段。')
    let proposalOps: unknown[] = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '第一段旧文。\n\n第二段旧文。\n\n尾段。', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalOps = (JSON.parse(String(init?.body)) as { ops: unknown[] }).ops
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<p>第一段新文。</p><p>第二段新文。</p><p>尾段。</p>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, currentPm)

    const result = await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{
        kind: 'strReplace',
        old: '第一段旧文。\n\n第二段旧文。',
        new: '第一段新文。\n\n第二段新文。',
      }],
    }, exec(undefined, 'edit-cross-paragraph', 'qing_edit_draft'))

    expect(proposalOps).toEqual([
      { kind: 'insertAfterBlock', blockId: 'paragraph-2', markdown: '第一段新文。\n\n第二段新文。' },
      { kind: 'deleteBlock', blockId: 'paragraph-1' },
      { kind: 'deleteBlock', blockId: 'paragraph-2' },
    ])
    expect(result).toMatchObject({ affectedCount: 1, opResults: [{ opIndex: 1, affectedCount: 1 }] })
  })

  it('整张 Markdown 表格替换预先编译为表格级插入加删除操作', async () => {
    const oldTable = '| 事项 | 状态 |\n| --- | --- |\n| 布置 | 待办 |'
    const newTable = '| 事项 | 状态 |\n| --- | --- |\n| 布置 | 完成 |'
    let proposalOps: unknown[] = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: oldTable, title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalOps = (JSON.parse(String(init?.body)) as { ops: unknown[] }).ops
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<table><tr><th>事项</th><th>状态</th></tr><tr><td>布置</td><td>完成</td></tr></table>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, tableDoc())

    await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: oldTable, new: newTable }],
    }, exec(undefined, 'edit-table-markdown', 'qing_edit_draft'))

    expect(proposalOps).toEqual([
      { kind: 'insertAfterBlock', blockId: 'table-1', markdown: newTable },
      { kind: 'deleteBlock', blockId: 'table-1' },
    ])
  })

  it('表格既有行用 strReplace 扩展时原子重建整表', async () => {
    const oldRow = '| 布置 | 待办 |'
    const expandedRows = `${oldRow}\n| 验收 | 完成 |`
    const expandedTable = '| 事项 | 状态 |\n| --- | --- |\n| 布置 | 待办 |\n| 验收 | 完成 |'
    let proposalOps: unknown[] = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '| 事项 | 状态 |\n| --- | --- |\n| 布置 | 待办 |', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalOps = (JSON.parse(String(init?.body)) as { ops: unknown[] }).ops
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({
          docVersion: 3,
          state: 'editing',
          qingml: '<table><tr><th>事项</th><th>状态</th></tr><tr><td>布置</td><td>待办</td></tr><tr><td>验收</td><td>完成</td></tr></table>',
          title: '测试稿',
        })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, tableDoc())

    await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: oldRow, new: expandedRows }],
    }, exec(undefined, 'edit-table-row-expand', 'qing_edit_draft'))

    expect(proposalOps).toEqual([
      { kind: 'insertAfterBlock', blockId: 'table-1', markdown: expandedTable },
      { kind: 'deleteBlock', blockId: 'table-1' },
    ])
  })

  it('插入或追加孤立表格行被拒，带表头分隔行的完整表格仍允许', async () => {
    let proposalCalls = 0
    const fullTable = '| 事项 | 状态 |\n| --- | --- |\n| 验收 | 完成 |'
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '现有正文。', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalCalls += 1
        expect(JSON.parse(String(init?.body))).toMatchObject({
          ops: [{ kind: 'appendSection', markdown: fullTable }],
        })
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<p>现有正文。</p><table><tr><th>事项</th><th>状态</th></tr><tr><td>验收</td><td>完成</td></tr></table>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc('现有正文。'))
    const tool = fixture.tools.get('qing_edit_draft')!

    await expect(tool.execute({
      ops: [{ kind: 'insertAfterLine', line: 1, markdown: '| 学习成本 | 中 |' }],
    }, exec(undefined, 'reject-orphan-table-line', 'qing_edit_draft'))).rejects.toThrow('孤立的 Markdown 表格行')
    await expect(tool.execute({
      ops: [{ kind: 'appendSection', markdown: '| 学习成本 | 中 |\n| 实施周期 | 短 |' }],
    }, exec(undefined, 'reject-orphan-table-section', 'qing_edit_draft'))).rejects.toThrow('完整表格必须包含表头分隔行')
    await expect(tool.execute({
      ops: [{ kind: 'appendSection', markdown: fullTable }],
    }, exec(undefined, 'allow-complete-table', 'qing_edit_draft'))).resolves.toMatchObject({ status: 'committed' })
    expect(proposalCalls).toBe(1)
  })

  it('Mermaid fenced 块用 strReplace 整块替换时转为稳定结构操作', async () => {
    const oldBlock = '```mermaid\nflowchart TD\n  A --> B\n```'
    const newBlock = '```mermaid\nflowchart TD\n  A --> C\n```'
    let proposalOps: unknown[] = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: oldBlock, title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalOps = (JSON.parse(String(init?.body)) as { ops: unknown[] }).ops
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<mermaid>flowchart TD\n  A --&gt; C</mermaid>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, mermaidDoc())

    await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: oldBlock, new: newBlock }],
    }, exec(undefined, 'edit-mermaid-block', 'qing_edit_draft'))

    expect(proposalOps).toEqual([
      { kind: 'insertAfterBlock', blockId: 'diagram-1', markdown: newBlock },
      { kind: 'deleteBlock', blockId: 'diagram-1' },
    ])
  })

  it('同批任一 strReplace 多处命中且无 nth 时全部拒绝', async () => {
    let proposalCalls = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '唯一目标\n\n重复目标\n\n重复目标', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalCalls += 1
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc('唯一目标', '重复目标', '重复目标'))

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [
        { kind: 'strReplace', old: '唯一目标', new: '新目标' },
        { kind: 'strReplace', old: '重复目标', new: '另一目标' },
      ],
    }, exec(undefined, 'edit-batch-ambiguous', 'qing_edit_draft'))).rejects.toThrow('第 2 个 strReplace 的 old 命中 2 处')
    expect(proposalCalls).toBe(0)
  })

  it('多处命中的前置错误不泄露原始内容、HTTP 状态码或块 ID', async () => {
    const raw = 'paragraph-block-9 HTTP 400'
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: `${raw}\n\n${raw}`, title: '测试稿',
        }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, paragraphDoc(raw, raw))
    const tool = fixture.tools.get('qing_edit_draft')!

    const promise = tool.execute({
      ops: [{ kind: 'strReplace', old: raw, new: '新目标' }],
    }, exec(undefined, 'edit-ambiguous-safe', 'qing_edit_draft'))
    const error = await promise.catch((reason: unknown) => reason)
    const message = error instanceof Error ? error.message : String(error)

    expect(message).toContain('命中 2 处')
    expect(message).not.toMatch(/paragraph|block-9|HTTP|400/i)
    const presentation = tool.presentResult?.({
      ops: [{ kind: 'strReplace', old: raw, new: '新目标' }],
    }, { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] })
    expect(JSON.stringify(presentation)).not.toMatch(/paragraph|block-9|HTTP|400/i)
  })

  it('同批多条按行插入在提交前按行号降序重排', async () => {
    const pmDoc = paragraphDoc('第一段', '第二段', '第三段')
    const ops = [
      { kind: 'insertAfterLine' as const, line: 2, markdown: '插在第一段后' },
      { kind: 'insertAfterLine' as const, line: 4, markdown: '插在第二段后' },
    ]
    let proposalOps: unknown[] = []
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '第一段\n\n第二段\n\n第三段', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalOps = (JSON.parse(String(init?.body)) as { ops: unknown[] }).ops
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<p>第一段</p><p>第二段</p><p>第三段</p>', title: '测试稿' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)

    await fixture.tools.get('qing_edit_draft')!.execute(
      { ops },
      exec(undefined, 'edit-line-order', 'qing_edit_draft'),
    )

    expect(proposalOps).toEqual([ops[1], ops[0]])
  })

  it('先删内容再按旧行号插入时预检拒绝且不提交引擎', async () => {
    let proposalCalls = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '第一段\n\n第二段', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalCalls += 1
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [
        { kind: 'deleteBlock', locator: 'L1' },
        { kind: 'insertAfterLine', line: 3, markdown: '不应提交' },
      ],
    }, exec(undefined, 'edit-delete-before-line', 'qing_edit_draft')))
      .rejects.toThrow('这批修改先增删了内容，后面的旧行号会失效')
    expect(proposalCalls).toBe(0)
  })

  it('行落在多行内容内部时预检拒绝并给出干净的可行动错误', async () => {
    const pmDoc = paragraphDoc('第一行\n第二行')
    let proposalCalls = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '第一行\n第二行', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        proposalCalls += 1
        return { status: 'committed', docVersion: 3 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)

    const promise = fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'insertAfterLine', line: 1, markdown: '不应提交' }],
    }, exec(undefined, 'edit-inside-multiline', 'qing_edit_draft'))

    await expect(promise).rejects.toThrow('所选位置位于一段多行内容的中间')
    await promise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toMatch(/paragraph|insertAfter|块 ID|400|第\s*\d+\s*行/i)
      expect(message).toContain('请改在这段内容的末尾之后')
    })
    expect(proposalCalls).toBe(0)
  })

  it('引擎定位错误在工具与失败卡边界都被清洗', async () => {
    const raw = '第 14 行位于多行 paragraph 块 paragraph-block-9 内部，不能使用 insertAfterLine；HTTP 400'
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '正文', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) throw new EngineHttpError(400, { error: raw, code: 'VALIDATION' })
      throw new Error(`unexpected path: ${path}`)
    })
    const tool = fixture.tools.get('qing_edit_draft')!

    const promise = tool.execute({
      ops: [{ kind: 'markText', find: '正文', mark: { type: 'bold' }, op: 'add' }],
    }, exec(undefined, 'edit-sanitize-engine-error', 'qing_edit_draft'))
    await expect(promise).rejects.toThrow('所选位置位于一段多行内容的中间')
    await promise.catch((error: unknown) => {
      expect(error instanceof Error ? error.message : String(error)).not.toMatch(/paragraph|insertAfter|块 ID|400|第\s*\d+\s*行/i)
    })

    const presentation = tool.presentResult?.({
      ops: [{ kind: 'markText', find: '正文', mark: { type: 'bold' }, op: 'add' }],
    }, {
      isError: true,
      content: [{ type: 'text', text: `Error: ${raw}` }],
    })
    expect(JSON.stringify(presentation)).not.toMatch(/paragraph|insertAfter|块 ID|400/i)
    expect(presentation).toMatchObject({
      content: [{ type: 'text', text: '未完成 · 修改位置需要重新确认，请重新读取文稿后再试' }],
    })
    const finalized = tool.finalizeContent?.(exec(undefined, 'edit-finalize', 'qing_edit_draft'), {
      isError: true,
      content: [{ type: 'text', text: `Error: ${raw}` }],
    } as never)
    expect(JSON.stringify(finalized)).toBe(JSON.stringify([
      { type: 'text', text: 'Error: 修改位置需要重新确认，请重新读取文稿后再试。' },
    ]))
    expect(JSON.stringify(finalized)).not.toMatch(/paragraph|insertAfter|block-9|HTTP|400|第\s*\d+\s*行/i)
  })

  it('schema 接受全部合法 markText 标记与受控色板，拒绝任意 CSS 色值', () => {
    const fixture = harness(async () => { throw new Error('不应访问引擎') })
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
      withinLocator: 'L2',
    }
    let proposalBody: Record<string, unknown> | undefined
    const fixture = harness(async (path, init) => {
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

    expect(proposalBody).toMatchObject({
      expectedDocVersion: 2,
      ops: [{
        kind: 'markText', find: '重点句', mark: { type: 'highlight', color: 'amber' },
        op: 'add', all: true, isRegex: false, withinRef: 'paragraph-1',
      }],
    })
    expect(proposalBody).toHaveProperty('clientMutationId', expect.any(String))
    expect(proposalBody).not.toHaveProperty('opId')
  })

  it('引擎 QingML 白名单拒绝转述结构错误,不再误报成定位错误', async () => {
    // 真机实证(评测 r4):引擎 VALIDATION 通用 nextStep 含「未命中」,曾被误映射成
    // 「没有找到唯一的目标文字」,模型照提示重读重试同一 payload 死循环。
    const fixture = harness(async (path, init) => {
      if (path === '/sessions' && init?.method === 'POST') return { sessionId: 'qing-new' }
      if (path.endsWith('/doc?format=qingml')) {
        return { sessionId: 'qing-new', docVersion: 0, state: 'empty', agentBusy: false, markdown: '', title: '' }
      }
      if (path.endsWith('/proposals')) {
        throw new EngineHttpError(400, {
          error: 'QingML 校验失败，请根据诊断修正后重试',
          code: 'VALIDATION',
          nextStep: '提案不合法(空文档只能 fullDraft/qingmlDraft / 已有文档禁 fullDraft / QingML 结构有害降级 / 未命中 / 超 50 处),按提示改',
          diagnostic: { failureKind: 'qingml_bad_block', warningKinds: ['inline-block-flattened'] },
        })
      }
      if (path.includes('/turn-signal')) return { active: true }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_write_draft')!.execute({
      qingml: '<h1>标题</h1><p>正文一段。</p>',
      title: '标题',
    }, exec(undefined, 'write-qingml-reject', 'qing_write_draft'))).rejects.toThrow('块级标签(<math-block>、<pre>、<mermaid> 等)必须独立成块')
  })

  it('markText 的引擎错误改写成用户可行动措辞', async () => {
    const correction = '文本未命中或未唯一命中,请缩小 withinRef 或设 all:true；注:代码块内文本不参与行内标记'
    let proposals = 0
    const fixture = harness(async (path) => {
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
    }, exec(undefined, 'edit-mark-error', 'qing_edit_draft'))).rejects.toThrow('没有找到唯一的目标文字。请重新读取文稿，缩小目标范围后再试。')
    expect(proposals).toBe(1)
  })

  it('strReplace 原样未命中时规范化 Markdown 前缀与包裹标记后重试一次', async () => {
    const proposalBodies: Array<{ expectedDocVersion: number; ops: unknown[] }> = []
    const fixture = harness(async (path, init) => {
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
    }, ONLINE_ENGINE, paragraphDoc('第三步:香料别堆砌'))

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
    const fixture = harness(async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 4, state: 'editing', agentBusy: false,
          markdown: '第一处旧文\n\n第二处旧文\n\n第二处旧文', title: '测试稿',
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
    }, ONLINE_ENGINE, paragraphDoc('第一处旧文', '第二处旧文', '第二处旧文'))

    const result = await fixture.tools.get('qing_edit_draft')!.execute(
      { ops },
      exec(undefined, 'edit-multi-op', 'qing_edit_draft'),
    )

    expect(proposals).toBe(1)
    expect(result).toMatchObject({
      affectedCount: 2,
      opResults: [
        { opIndex: 1, affectedCount: 1 },
        { opIndex: 2, affectedCount: 1 },
      ],
      message: expect.stringContaining('第 1 项修改 1 处，第 2 项修改 1 处；本批共影响 2 处。'),
    })
  })

  it('strReplace 命中 0 处时前置报错且不调用提案引擎', async () => {
    let proposals = 0
    const fixture = harness(async (path) => {
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
    )).rejects.toThrow('命中 0 处')
    expect(proposals).toBe(0)
    expect(fixture.telemetry.capture).toHaveBeenCalledWith('edit_rejected', { reason: 'zero_hit' })
  })

  it('直接映射三类局部 op，review 后结束回合并清选段', async () => {
    let proposed = false
    const ops = [
      { kind: 'strReplace' as const, old: '旧标题', new: '新标题', nth: 1 },
      { kind: 'insertAfterLine' as const, line: 2, markdown: '插入段。' },
      { kind: 'appendSection' as const, markdown: '## 新节\n\n新节正文。' },
    ]
    const fixture = harness(async (path, init) => {
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
    }, ONLINE_ENGINE, candidateDoc('旧标题', '旧正文。'))
    const context = exec(undefined, 'edit-review', 'qing_edit_draft')

    const result = await fixture.tools.get('qing_edit_draft')!.execute({ ops }, context)

    expect(result).toMatchObject({
      status: 'review', reviewCount: 0, docVersion: 2, patchIds: [],
      message: expect.stringContaining('改动已提交审阅，右侧面板等待用户裁决'),
    })
    expect((result as { message: string }).message).not.toMatch(/v\d+/)
    expect(fixture.tools.get('qing_edit_draft')!.output?.presentationMeta?.({}, result as never))
      .toMatchObject({ status: 'review', patchIds: [] })
    expect(fixture.tools.get('qing_edit_draft')!.output?.schema).toMatchObject({
      properties: { patchIds: { type: 'array', items: { type: 'string' } } },
    })
    expectReviewEndMessage((result as { message: string }).message)
    expect(context.concludeTurn).not.toHaveBeenCalled()
    expect(fixture.bridge.clearSelection).toHaveBeenCalledWith('dsh-1')
    expect(fixture.events.at(-1)?.event).toMatchObject({ type: 'doc-review-pending', count: 0, blocks: 2 })
    expect(fixture.telemetry.capture).toHaveBeenCalledWith('draft_edited', {
      ops_bucket: '2-5',
      op_kinds: ['strReplace', 'insertAfterLine', 'appendSection'],
      outcome: 'review',
    })
    expect(vi.mocked(fixture.engine.fetchJson).mock.calls.map(([path]) => path)).toEqual([
      '/sessions/qing-1/doc?lines=1',
      '/sessions/qing-1/doc?format=pm',
      '/sessions/qing-1/proposals',
      '/sessions/qing-1/doc?format=qingml',
      '/sessions/qing-1/review?format=render-model',
      '/sessions/qing-1/doc?format=pm',
    ])
  })

  it('审阅态拒绝新编辑且失败路径仍清选段', async () => {
    const fixture = harness(async (path) => {
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
    const fixture = harness(async (path) => {
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
    ['pendingReview', 3, '【文稿状态】审阅中·待用户裁决。', '审阅中(待用户裁决)'],
    ['editing', 4, '【文稿状态】已落库生效,无待审稿。', '已落库生效'],
  ] as const)('session render 将 %s 映射为中文状态并为聚焦稿输出权威状态行', async (state, docVersion, stateLine, stateLabel) => {
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ state, docVersion, qingml: DRAFT_ONE, title: '测试稿' })
      }
      if (state === 'pendingReview' && path.endsWith('/review?format=render-model')) {
        return {
          sessionId: 'qing-1', docVersion, state, agentBusy: false,
          baseVersion: docVersion, suggestions: [], editedDoc: candidateDoc('开篇', '第一版正文。'),
        }
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
    const fixture = harness(async () => { throw new Error('不应访问引擎') })
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
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return doc({ state: 'pendingReview', docVersion: 7, qingml: DRAFT_ONE, title: '测试稿' })
      }
      if (path.endsWith('/review?format=render-model')) {
        return {
          sessionId: 'qing-1', docVersion: 7, state: 'pendingReview', agentBusy: false,
          baseVersion: 7, suggestions: [], editedDoc: candidateDoc('开篇', '第一版正文。'),
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const tool = fixture.tools.get('qing_focus_doc')!

    const result = await tool.execute({ docRef: 'qing-1' }, exec(undefined, 'focus-doc', 'qing_focus_doc'))

    expect(result).toMatchObject({ state: 'pendingReview', docVersion: 7 })
    expect(tool.output?.render({ docRef: 'qing-1' }, result as never)).toEqual([{
      type: 'text',
      text: '【文稿状态】审阅中·待用户裁决。\n右侧预览已切换到《测试稿》（qing-1）。',
    }])
  })
})

describe('局部 op 原始标签防线', () => {
  it('strReplace new 含 QingML 标签被拒绝且不发提案', async () => {
    let proposalCalls = 0
    const fixture = harness(async (path) => {
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
    const fixture = harness(async (path) => {
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
    const fixture = harness(async (path) => {
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
    }, ONLINE_ENGINE, paragraphDoc('对比'))
    await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '对比', new: '对比:a<b 且 3 < 5' }],
    }, exec(undefined, 'edit-lt', 'qing_edit_draft'))
    expect(proposalCalls).toBe(1)
  })
})

// v1 真机回归:模型把「1200 字分四节」写成「每节约 300 字」,旧解析把它当全文目标推出 max=330,
// 与下限 1200 自相矛盾 → 写多少都不合格、自动重试 11 分钟未落稿。
describe('写稿字数需求解析', () => {
  const requirementsOf = (requirements: string) => draftRequirementsOf({ requirements })

  it('每节字数不得当作全文约束', () => {
    const r = requirementsOf('不少于 1200 字，分四个小节，每节约 300 字，每节带小标题。')
    expect(r.length?.min).toBe(1200)
    expect(r.length?.max).toBeUndefined()
  })

  it('显式下限存在时,「约 N 字」不得反过来收窄成上限', () => {
    const r = requirementsOf('不少于 1200 字，整体约 1500 字。')
    expect(r.length?.min).toBe(1200)
    expect(r.length?.max === undefined || r.length.max >= 1200).toBe(true)
  })

  it('「约 N 字」只作软目标,不产生硬性上下限', () => {
    const r = requirementsOf('写一篇约 800 字的散文。')
    expect(r.length?.target).toBe(800)
    expect(r.length?.targetKind).toBe('approx')
    expect(r.length?.min).toBeUndefined()
    expect(r.length?.max).toBeUndefined()
  })

  it('裸 N 字进 bare 软目标，不造硬边界', () => {
    const r = requirementsOf('写 800 字，语气简洁。')
    expect(r.length).toMatchObject({ target: 800, targetKind: 'bare' })
    expect(r.length?.min).toBeUndefined()
    expect(r.length?.max).toBeUndefined()
  })

  it('解析优先级为硬边界 > approx > bare，已消费与分项数字不参与', () => {
    const hard = requirementsOf('至少 1200 字，整体约 1500 字，每节 300 字。')
    expect(hard.length).toEqual({ min: 1200 })

    const approx = requirementsOf('整体约 900 字，备注又提到 600 字。')
    expect(approx.length).toMatchObject({ target: 900, targetKind: 'approx' })

    const perUnitOnly = requirementsOf('分四节，每节 300 字。')
    expect(perUnitOnly.length).toBeUndefined()
  })

  it('上下限自相矛盾时丢掉上限,不把矛盾交给重试', () => {
    const r = requirementsOf('不少于 1200 字，不超过 300 字。')
    expect(r.length?.min).toBe(1200)
    expect(r.length?.max).toBeUndefined()
  })
})

describe('写稿字数报告', () => {
  it('硬边界不阻止提交，区间内 gap 为 0，越界按最近边界报告', async () => {
    const qingml = '<title>题</title><h1>题</h1><p>甲，乙。丙！</p>'
    const pmDoc = compileQingmlDocument(qingml)
    const actual = countDocVisibleChars(pmDoc)
    let version = 0
    const fixture = harness(async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return version === 0 ? doc() : doc({ docVersion: version, state: 'editing', qingml, title: '题' })
      }
      if (path.endsWith('/proposals')) {
        version += 1
        return { status: 'committed', docVersion: version }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)

    await expect(fixture.tools.get('qing_write_draft')!.execute(
      { qingml, requirements: `至少 ${actual + 5} 字` },
      exec(undefined, 'hard-gap', 'qing_write_draft'),
    )).resolves.toMatchObject({
      status: 'committed',
      lengthStatus: 'unmet',
      lengthGap: -5,
      words: actual,
    })
    expect(version).toBe(1)
  })
})
