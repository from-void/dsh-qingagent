// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeEvent, BridgeState } from '../src/contracts.js'
import { apply } from '../src/client/index.js'

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
    const services = { slots, layout: {}, sessions: { list } }
    const ctx = {
      get: (name: keyof typeof services) => services[name],
    } as unknown as Context

    apply(ctx)
    expect(slots.register).toHaveBeenCalledWith({
      name: 'conversation.input.dock',
      id: 'qingagent-selection',
      order: -10,
    }, expect.any(Function))
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    expect(activeDetails.size).toBe(0)

    const source = FakeEventSource.instances[0]!
    source.emit({ type: 'draft-started', engineSessionId: 'qing-m1', generation: 'draft-m1' })
    source.emit({
      type: 'draft-chunk', engineSessionId: 'qing-m1', generation: 'draft-m1', chunkQingml: '<p>半篇</p>',
      accumulatedBlocks: ['<p>半篇</p>'], title: '测试稿', blocks: 1, words: 2,
    })
    expect(activeDetails.size).toBe(1)

    source.emit({ type: 'draft-failed', engineSessionId: 'qing-m1', generation: 'draft-m1', message: '已中止' })
    expect(activeDetails.size).toBe(0)

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
    expect(source.closed).toBe(true)
  })
})
