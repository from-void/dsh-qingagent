// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeEvent, BridgeState, QingSelection } from '../src/contracts.js'
import { apply } from '../src/client/index.js'
import type { InsertReferenceRequest, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) { FakeEventSource.instances.push(this) }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event)
    const listeners = this.listeners.get(name) ?? []
    listeners.push(callback as (event: MessageEvent) => void)
    this.listeners.set(name, listeners)
  }

  emit(event: BridgeEvent): void {
    const message = new MessageEvent(event.type, { data: JSON.stringify(event) })
    for (const listener of this.listeners.get(event.type) ?? []) listener(message)
  }

  close(): void { this.closed = true }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
})

describe('client details 动态占槽', () => {
  it('仅在当前会话有生成流时注册，失败归零后让位，卸载时清理订阅', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const emptyState: BridgeState = {
      dshSessionId: 'dsh-m1', binding: { docs: [] }, docs: [],
      engine: { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(emptyState)))

    const activeDetails = new Set<symbol>()
    let detailsLifecycle: (() => void) | undefined
    const slots = {
      inject: vi.fn((name: string, setup: () => () => void) => {
        const dispose = setup()
        if (name === 'details') detailsLifecycle = dispose
        return dispose
      }),
      register: vi.fn((options: { name: string }) => {
        const token = Symbol(options.name)
        if (options.name === 'details') activeDetails.add(token)
        return () => activeDetails.delete(token)
      }),
    }
    const list = {
      getSnapshot: () => ({ current: 'dsh-m1' }),
      subscribe: vi.fn(() => () => undefined),
    }
    const unregisterSource = vi.fn()
    const inputTriggers = { registerSource: vi.fn(() => unregisterSource) }
    const effectDisposers: Array<() => void> = []
    const services = { slots, layout: {}, sessions: { list }, inputTriggers }
    const ctx = {
      get: (name: keyof typeof services) => services[name],
      effect: (setup: () => () => void) => {
        const dispose = setup()
        effectDisposers.push(dispose)
        return dispose
      },
    } as unknown as Context

    apply(ctx)
    expect(inputTriggers.registerSource).toHaveBeenCalledWith(expect.objectContaining({
      name: 'qingagent-selection',
      codec: expect.any(Object),
    }))
    expect(slots.register).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'conversation.input.dock' }),
      expect.any(Function),
    )
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    expect(activeDetails.size).toBe(0)

    const source = FakeEventSource.instances[0]!
    source.emit({
      type: 'binding-changed',
      binding: {
        docs: [{ engineSessionId: 'qing-m1', title: '测试稿', createdAt: '2026-08-15T00:00:00.000Z' }],
        activeEngineSessionId: 'qing-m1',
      },
    })
    expect(activeDetails.size).toBe(1)
    source.emit({ type: 'binding-changed', binding: { docs: [] } })
    expect(activeDetails.size).toBe(0)

    detailsLifecycle?.()
    for (const dispose of effectDisposers) dispose()
    expect(unregisterSource).toHaveBeenCalledOnce()
    expect(source.closed).toBe(true)
  })

  it('把 bridge 连续到达的选段送进会话作用域事件，并在成功后清理 ingress 单槽', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const sessionId = 'dsh-selection-events'
    const initialState: BridgeState = {
      dshSessionId: sessionId,
      binding: {
        docs: [{
          engineSessionId: 'qing-selection-doc',
          title: '泊船瓜洲',
          createdAt: '2026-08-16T00:00:00.000Z',
        }],
        activeEngineSessionId: 'qing-selection-doc',
      },
      docs: [],
      activeDoc: {
        sessionId: 'qing-selection-doc',
        docVersion: 1,
        state: 'editing',
        agentBusy: false,
        markdown: '春风又绿江南岸。明月何时照我还。',
        qingml: '<p>春风又绿江南岸。明月何时照我还。</p>',
        title: '泊船瓜洲',
      },
      engine: { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === 'DELETE' ? Response.json({ ok: true }) : Response.json(initialState)
    ))
    vi.stubGlobal('fetch', fetchMock)

    let draft = '请分别润色：'
    let draftRev = 11
    const inputListeners = new Set<() => void>()
    const payloads: InsertReferenceRequest[] = []
    const scopedCtx = {
      conversation: {
        input: {
          for: () => ({
            state: {
              getSnapshot: () => ({ draft, draftRev }),
              subscribe: (listener: () => void) => {
                inputListeners.add(listener)
                return () => inputListeners.delete(listener)
              },
            },
          }),
        },
      },
      bail: (_subject: unknown, event: string, request: InsertReferenceRequest) => {
        expect(event).toBe('slash/input-insert-reference')
        payloads.push(request)
        const tail = draft.slice(request.span.end)
        draft = draft.slice(0, request.span.start)
          + `\uFFFC${tail.length === 0 || tail[0] !== ' ' ? ' ' : ''}`
          + tail
        draftRev += 1
        for (const listener of inputListeners) listener()
        return true
      },
    }
    const scopeDispose = vi.fn()
    let detailsLifecycle: (() => void) | undefined
    const slots = {
      inject: vi.fn((name: string, setup: () => () => void) => {
        const dispose = setup()
        if (name === 'details') detailsLifecycle = dispose
        return dispose
      }),
      register: vi.fn(() => () => undefined),
    }
    const list = {
      getSnapshot: () => ({
        current: sessionId,
        byId: { [sessionId]: { displayTitle: '泊船瓜洲' } },
      }),
      subscribe: () => () => undefined,
    }
    let registeredSource: InputTriggerSource | undefined
    const effectDisposers: Array<() => void> = []
    const services = {
      slots,
      layout: {},
      sessions: { list },
      inputTriggers: {
        registerSource: (source: InputTriggerSource) => {
          registeredSource = source
          return () => undefined
        },
      },
    }
    const ctx = {
      get: (name: keyof typeof services) => services[name],
      effect: (setup: () => () => void) => {
        const dispose = setup()
        effectDisposers.push(dispose)
        return dispose
      },
      __createScope: () => ({ ctx: scopedCtx, fiber: { dispose: scopeDispose } }),
    } as unknown as Context

    apply(ctx)
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const source = FakeEventSource.instances[0]!
    const selections: QingSelection[] = [
      {
        dshSessionId: sessionId,
        engineSessionId: 'qing-selection-doc',
        quote: '春风又绿江南岸',
        anchor: { blockId: 'block-9', from: 12, to: 20 },
      },
      {
        dshSessionId: sessionId,
        engineSessionId: 'qing-selection-doc',
        quote: '明月何时照我还',
        anchor: { blockId: 'block-12', from: 31, to: 39 },
      },
    ]

    source.emit({ type: 'selection-changed', selection: selections[0]! })
    await vi.waitFor(() => expect(payloads).toHaveLength(1))
    source.emit({ type: 'selection-changed', selection: selections[1]! })
    await vi.waitFor(() => expect(payloads).toHaveLength(2))

    expect(payloads.map((payload) => payload.span)).toEqual([
      { start: 6, end: 6, draftRev: 11 },
      { start: 8, end: 8, draftRev: 12 },
    ])
    expect(payloads[0]?.reference.ref).toContain('[选段]《泊船瓜洲》')
    expect(payloads[1]?.reference.ref).toContain('「')
    expect(fetchMock).toHaveBeenCalledWith(
      `/qingagent-bridge/selection?dshSessionId=${sessionId}`,
      { method: 'DELETE' },
    )
    expect(registeredSource?.codec).toBeDefined()
    expect(await registeredSource!.codec!.serialize(
      payloads[0]!.reference.ref,
      new AbortController().signal,
    )).toBe(payloads[0]!.reference.ref)

    detailsLifecycle?.()
    for (const dispose of effectDisposers) dispose()
    expect(scopeDispose).toHaveBeenCalledOnce()
  })
})
