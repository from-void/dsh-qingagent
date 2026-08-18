import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { countDocVisibleChars, type PmDoc } from '@qingagent/pm-schema'
import type { BindingStore } from '../src/bindings.js'
import type { BridgeHub } from '../src/bridge.js'
import { DRAFT_MARK_COLORS, type BridgeEvent, type EngineStatusSnapshot, type ExternalDoc } from '../src/contracts.js'
import { EngineHttpError, type EngineService } from '../src/engine.js'
import { QINGJIAN_DOWNLOAD_URL } from '../src/onboarding.js'
import { registerTools } from '../src/tools.js'
import type { TelemetryCapture } from '../src/telemetry.js'

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
  expect(message).not.toContain('仍要用一句话')
  expect(message).toContain('收尾说明由工具卡向用户展示')
  expect(message).toContain('本回合不再产生任何输出')
  for (const instruction of ['不要重写', '不要读稿复核', '不要自动裁决']) {
    expect(message).toContain(instruction)
  }
}

function harness(
  outputs: string[],
  fetchJson: (path: string, init?: RequestInit) => Promise<unknown>,
  engineStatus: EngineStatusSnapshot = ONLINE_ENGINE,
  pmDoc: PmDoc = candidateDoc('开篇', '第一版正文。'),
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
    fetchJson: vi.fn((path: string, init?: RequestInit) =>
      path.endsWith('/doc?format=pm') ? Promise.resolve({ pmDoc }) : fetchJson(path, init)),
  } as unknown as EngineService
  const bridge = {
    emit: vi.fn((sessionId: string, event: BridgeEvent) => events.push({ sessionId, event })),
    clearSelection: vi.fn(),
  } as unknown as BridgeHub
  const telemetry = { capture: vi.fn(async () => undefined) } as unknown as TelemetryCapture
  registerTools({ ctx, engine, bindings, bridge, telemetry })
  return { tools, listeners, requests, events, stream, bindings, engine, bridge, telemetry }
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

describe('qing_write_draft', () => {
  it('首稿成功后同回合建立 freshness，允许紧接一次局部补足', async () => {
    let writeCommitted = false
    let editCommitted = false
    const fixture = harness([DRAFT_ONE], async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        if (editCommitted) return doc({ docVersion: 2, state: 'editing', qingml: DRAFT_TWO, title: '测试稿' })
        if (writeCommitted) return doc({ docVersion: 1, state: 'editing', qingml: DRAFT_ONE, title: '测试稿' })
        return doc()
      }
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 1, state: 'editing', agentBusy: false,
          markdown: '# 开篇\n\n第一版正文。', title: '测试稿',
        }
      }
      if (path.endsWith('/proposals')) {
        const body = JSON.parse(String(init?.body)) as { ops: Array<{ kind: string }> }
        if (body.ops[0]?.kind === 'qingmlDraft') {
          writeCommitted = true
          return { status: 'committed', docVersion: 1 }
        }
        editCommitted = true
        return { status: 'committed', docVersion: 2 }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const preStep = fixture.listeners.get('agent/pre-step')!
    await preStep({ agent: { id: 'dsh-1' }, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
    await expect(fixture.tools.get('qing_write_draft')!.execute(
      { brief: '重写已有稿', docRef: 'qing-1' },
      exec(undefined, 'stale-rewrite', 'qing_write_draft'),
    )).rejects.toThrow('qing_read_draft')

    const writeExec = exec(undefined, 'fresh-write', 'qing_write_draft')
    const written = await fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇短稿' }, writeExec)
    expect(written).toMatchObject({ status: 'committed', words: expect.any(Number) })
    expect(writeExec.agent?.inject).toHaveBeenCalled()

    await expect(fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '第一版正文。', new: '修正后的正文。' }],
    }, exec(undefined, 'fresh-edit', 'qing_edit_draft'))).resolves.toMatchObject({
      status: 'committed', docVersion: 2,
    })
  })

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

    expect(result).toMatchObject({
      status: 'committed', engineSessionId: 'qing-1', title: '测试稿', blocks: 2,
      structure: '一个标题加 1 段正文',
    })
    expect(fixture.stream).toHaveBeenCalledOnce()
    expect(fixture.events.at(-1)?.event.type).toBe('doc-committed')
    expect(fixture.telemetry.capture).toHaveBeenCalledWith('draft_created', {
      words_bucket: '1-200', blocks_bucket: '1-5', retried: false,
    })
  })

  it('committed 返回按 PmDoc 统计含标点的可见字符数', async () => {
    const qingml = '<p>你好，世界！</p>'
    const pmDoc = paragraphDoc('你好，世界！')
    let proposed = false
    const fixture = harness([qingml], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed
          ? doc({ docVersion: 1, state: 'editing', qingml, title: '标点稿' })
          : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, pmDoc)

    const result = await fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇标点稿' }, exec())

    expect(countDocVisibleChars(pmDoc)).toBe(6)
    expect(result).toMatchObject({ words: 6, docVersion: 1 })
    const rendered = fixture.tools.get('qing_write_draft')!.output?.render({}, result as never)
    expect(JSON.stringify(rendered)).not.toMatch(/v\d+/)
  })

  it('写稿结果渲染纸面结构事实，不向用户裸报块数', async () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `<p>第 ${index + 1} 段。</p>`).join('')
    const qingml = `<title>结构稿</title><h1>结构稿</h1>${paragraphs}<ul><li>事项</li></ul><table><tr><th>列</th></tr><tr><td>值</td></tr></table>`
    let proposed = false
    const fixture = harness([qingml], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed ? doc({ docVersion: 1, state: 'editing', qingml, title: '结构稿' }) : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const result = await fixture.tools.get('qing_write_draft')!.execute({ brief: '写结构稿' }, exec())
    const rendered = fixture.tools.get('qing_write_draft')!.output?.render({}, result as never)

    expect(result).toMatchObject({ structure: '一个标题、6 段正文、1 个清单和 1 张表格' })
    expect(JSON.stringify(rendered)).toContain('内容构成：一个标题、6 段正文、1 个清单和 1 张表格')
    expect(JSON.stringify(rendered)).not.toMatch(/\d+\s*块/)
  })

  it('显式 outline 通过独立通道原样进入侧模型请求', async () => {
    let proposed = false
    const fixture = harness([DRAFT_ONE], async (path) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed ? doc({ docVersion: 1, state: 'editing', qingml: DRAFT_ONE, title: '测试稿' }) : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await fixture.tools.get('qing_write_draft')!.execute({
      brief: '按指定章节写作',
      outline: ['现状', '方案', '风险'],
    }, exec())

    const request = JSON.stringify(fixture.requests[0])
    expect(request).toContain('指定提纲（严格按此顺序和标题写作，不得增删、改名或调序）')
    expect(request).toContain('- 现状\\n- 方案\\n- 风险')
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
    expect(fixture.telemetry.capture).toHaveBeenCalledWith(
      'draft_created',
      expect.objectContaining({ retried: true }),
    )
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

  it('源写法在落库前确定性转换，结构事实如实返回且不触发整篇重生', async () => {
    let proposed = false
    const fixture = harness([SOURCE_SYNTAX_DRAFT], async (path, init) => {
      if (path.endsWith('/doc?format=qingml')) {
        return proposed ? doc({ docVersion: 1, state: 'editing', qingml: CONVERTED_SOURCE_SYNTAX_DRAFT, title: '测试稿' }) : doc()
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        expect(JSON.parse(String(init?.body))).toMatchObject({
          ops: [{ kind: 'qingmlDraft', qingml: CONVERTED_SOURCE_SYNTAX_DRAFT }],
        })
        return { status: 'committed', docVersion: 1 }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇带脚注的测试稿' }, exec()))
      .resolves.toMatchObject({
        status: 'committed',
        footnotes: 1,
        formulas: 2,
        automaticConversions: 3,
      })
    expect(fixture.stream).toHaveBeenCalledOnce()
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.engine.fetchJson).toHaveBeenCalledWith(expect.stringContaining('/proposals'), expect.anything())
    const result = await fixture.tools.get('qing_write_draft')!.output?.render({}, {
      title: '测试稿', blocks: 3, words: 10, status: 'committed', engineSessionId: 'qing-1', docVersion: 1,
      structure: '一个标题加 1 段正文', wholeDocReview: false, outline: ['开篇'],
      footnotes: 1, formulas: 2, automaticConversions: 3,
    } as never)
    expect(JSON.stringify(result)).toContain('本稿含 1 处脚注、2 个公式，其中 3 处已自动整理为正确格式')
  })

  it('脚注引用没有对应定义时直接拒绝且不触发整篇重生', async () => {
    let proposals = 0
    const fixture = harness([UNRESOLVED_FOOTNOTE_DRAFT], async (path) => {
      if (path.endsWith('/doc?format=qingml')) return doc()
      if (path.endsWith('/proposals')) proposals += 1
      throw new Error(`unexpected path: ${path}`)
    })

    await expect(fixture.tools.get('qing_write_draft')!.execute({ brief: '写一篇带脚注的测试稿' }, exec()))
      .rejects.toThrow('文稿中仍有无法识别的脚注或公式写法，未提交文稿')
    expect(fixture.stream).toHaveBeenCalledOnce()
    expect(proposals).toBe(0)
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
      .rejects.toThrow('这次修改没有生效。请重新读取文稿，换用清晰、稳定的内容位置后再试。')
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
    const reviewPmDoc = candidateDoc('候选标题', '候选正文。')
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
          baseVersion: 1, suggestions: [], wholeDocument: true,
          editedDoc: reviewPmDoc,
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const context = exec()

    const result = await fixture.tools.get('qing_write_draft')!.execute({ brief: '整篇重写' }, context)

    expect(result).toMatchObject({
      status: 'review',
      blocks: 2,
      words: countDocVisibleChars(reviewPmDoc),
      docVersion: 1,
      outline: ['候选标题'],
      patchIds: ['patch-1'],
    })
    expect(context.concludeTurn).toHaveBeenCalledOnce()
    const generationEvents = fixture.events.filter(({ event }) =>
      event.type === 'draft-started' || event.type === 'draft-chunk' || event.type === 'doc-review-pending')
    expect(generationEvents.map(({ event }) => 'generation' in event ? event.generation : undefined))
      .toEqual([expect.any(String), expect.any(String), expect.any(String)])
    expect(new Set(generationEvents.map(({ event }) => 'generation' in event ? event.generation : undefined)).size).toBe(1)
    expect(fixture.tools.get('qing_write_draft')!.output?.render({}, result as never)).toEqual([{
      type: 'text',
      text: '【文稿状态】审阅中·1 处待用户裁决。\n内容构成：一个标题加 1 段正文。\n本稿含 0 处脚注、0 个公式，其中 0 处已自动整理为正确格式。\n改动已提交审阅，右侧面板等待用户裁决。本次工具调用结束——不要重写、不要读稿复核、不要自动裁决；收尾说明由工具卡向用户展示，本回合不再产生任何输出。',
    }])
    const rendered = fixture.tools.get('qing_write_draft')!.output?.render({}, result as never)
    expectReviewEndMessage((rendered?.[0] as { text: string }).text)
    expect(fixture.tools.get('qing_write_draft')!.output?.presentationMeta?.({}, result as never))
      .toMatchObject({
        status: 'review', patchCount: 1, patchIds: ['patch-1'], wholeDocReview: true,
      })
    expect(fixture.tools.get('qing_write_draft')!.output?.schema).toMatchObject({
      properties: { patchIds: { type: 'array', items: { type: 'string' } } },
    })
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
    const fixture = harness([], async (path) => {
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
    const reviewPmDoc = candidateDoc('候选标题', '候选正文。')
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
    const fixture = harness([], async (path) => {
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
  it('本回合未读稿硬拦截，任一 read mode 成功后放行且下一回合重新变陈旧', async () => {
    let edited = false
    const fixture = harness([], async (path) => {
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

  it('描述要求改标题时同批同步稿名和纸面大标题', () => {
    const fixture = harness([], async () => { throw new Error('不应访问引擎') })
    const tool = fixture.tools.get('qing_edit_draft')!
    expect(tool.description).toContain('若正文有与旧稿名相同的大标题块')
    expect(tool.description).toContain('两者必须在同一次 ops 里一起提交,文字保持一致')
    expect(tool.description).toContain('正文没有与旧稿名相同的大标题块时,允许只用 setTitle')
    expect(JSON.stringify(tool.parameters)).toContain('不存在时允许只改稿名')
  })

  it('纸面开头标题与旧稿名一致时，setTitle 缺少正文同步修改会在提交前拒绝', async () => {
    let proposals = 0
    const fixture = harness([], async (path) => {
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
    const fixture = harness([], async (path) => {
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
    const fixture = harness([], async (path, init) => {
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

  it('稿名与纸面标题在同批同步修改时通过确定性闸门', async () => {
    let proposed = false
    const ops = [
      { kind: 'setTitle' as const, title: '新标题' },
      { kind: 'strReplace' as const, old: '旧标题', new: '新标题', nth: 1 },
    ]
    const fixture = harness([], async (path, init) => {
      if (path.endsWith('/doc?lines=1')) {
        return {
          sessionId: 'qing-1', docVersion: 2, state: 'editing', agentBusy: false,
          markdown: '# 旧标题\n\n正文', title: '旧标题',
        }
      }
      if (path.endsWith('/proposals')) {
        proposed = true
        expect(JSON.parse(String(init?.body))).toMatchObject({ expectedDocVersion: 2, ops })
        return { status: 'committed', docVersion: 3 }
      }
      if (path.endsWith('/doc?format=qingml') && proposed) {
        return doc({ docVersion: 3, state: 'editing', qingml: '<h1>新标题</h1><p>正文</p>', title: '新标题' })
      }
      throw new Error(`unexpected path: ${path}`)
    }, ONLINE_ENGINE, candidateDoc('旧标题', '正文'))

    await expect(fixture.tools.get('qing_edit_draft')!.execute({ ops }, exec(undefined, 'edit-title-sync', 'qing_edit_draft')))
      .resolves.toMatchObject({ status: 'committed', title: '新标题' })
  })

  it('描述明确同批行号逐 op 推进、多行块与块级锚点约束', () => {
    const fixture = harness([], async () => { throw new Error('不应访问引擎') })
    const description = fixture.tools.get('qing_edit_draft')!.description
    expect(description).toContain('同一批 ops 里一旦有插入或删除,其后所有行号都会整体偏移')
    expect(description).toContain('改用 insertAfterBlock 这类块级锚点(不受行号偏移影响),或留到下一回合重读后再改')
    expect(description).toContain('命中待办清单、表格、嵌套列表这类多行块时,优先用 insertAfterBlock 等项级/块级 op')
    expect(description).toContain('例外:指向多行块的最后一行是合法的,语义是插到整块之后(不是块内)')
    expect(description).toContain('想在清单尾部追加子项时别用它,那会插到清单外面')
  })

  it('描述与 schema 仅为用户明确的全局意图开放 all:true', () => {
    const fixture = harness([], async () => { throw new Error('不应访问引擎') })
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
    const fixture = harness([], async (path, init) => {
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
    const fixture = harness([], async (path, init) => {
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
    const fixture = harness([], async (path) => {
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
    const fixture = harness([], async (path) => {
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
    const fixture = harness([], async (path) => {
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
    const fixture = harness([], async (path) => {
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

  it('同批任一 strReplace 多处命中且无 nth 时全部拒绝', async () => {
    let proposalCalls = 0
    const fixture = harness([], async (path) => {
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
    const fixture = harness([], async (path) => {
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
    const fixture = harness([], async (path, init) => {
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
    const fixture = harness([], async (path) => {
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
        { kind: 'deleteBlock', blockId: 'paragraph-1' },
        { kind: 'insertAfterLine', line: 3, markdown: '不应提交' },
      ],
    }, exec(undefined, 'edit-delete-before-line', 'qing_edit_draft')))
      .rejects.toThrow('这批修改先增删了内容，后面的旧行号会失效')
    expect(proposalCalls).toBe(0)
  })

  it('行落在多行内容内部时预检拒绝并给出干净的可行动错误', async () => {
    const pmDoc = paragraphDoc('第一行\n第二行')
    let proposalCalls = 0
    const fixture = harness([], async (path) => {
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
    const fixture = harness([], async (path) => {
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

  it('markText 的引擎错误改写成用户可行动措辞', async () => {
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
    }, exec(undefined, 'edit-mark-error', 'qing_edit_draft'))).rejects.toThrow('没有找到唯一的目标文字。请重新读取文稿，缩小目标范围后再试。')
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
    const fixture = harness([], async (path, init) => {
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
    }, ONLINE_ENGINE, candidateDoc('旧标题', '旧正文。'))
    const context = exec(undefined, 'edit-review', 'qing_edit_draft')

    const result = await fixture.tools.get('qing_edit_draft')!.execute({ ops }, context)

    expect(result).toMatchObject({
      status: 'review', reviewCount: 3, docVersion: 2, patchIds: ['p-1', 'p-2', 'p-3'],
      message: expect.stringContaining('改动已提交审阅，右侧面板等待用户裁决'),
    })
    expect((result as { message: string }).message).not.toMatch(/v\d+/)
    expect(fixture.tools.get('qing_edit_draft')!.output?.presentationMeta?.({}, result as never))
      .toMatchObject({ status: 'review', patchIds: ['p-1', 'p-2', 'p-3'] })
    expect(fixture.tools.get('qing_edit_draft')!.output?.schema).toMatchObject({
      properties: { patchIds: { type: 'array', items: { type: 'string' } } },
    })
    expectReviewEndMessage((result as { message: string }).message)
    expect(context.concludeTurn).toHaveBeenCalledOnce()
    expect(fixture.bridge.clearSelection).toHaveBeenCalledWith('dsh-1')
    expect(fixture.events.at(-1)?.event).toMatchObject({ type: 'doc-review-pending', count: 3, blocks: 2 })
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
    ['pendingReview', 3, '【文稿状态】审阅中·待用户裁决。', '审阅中(待用户裁决)'],
    ['editing', 4, '【文稿状态】已落库生效,无待审稿。', '已落库生效'],
  ] as const)('session render 将 %s 映射为中文状态并为聚焦稿输出权威状态行', async (state, docVersion, stateLine, stateLabel) => {
    const fixture = harness([], async (path) => {
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
    }, ONLINE_ENGINE, paragraphDoc('对比'))
    await fixture.tools.get('qing_edit_draft')!.execute({
      ops: [{ kind: 'strReplace', old: '对比', new: '对比:a<b 且 3 < 5' }],
    }, exec(undefined, 'edit-lt', 'qing_edit_draft'))
    expect(proposalCalls).toBe(1)
  })
})
