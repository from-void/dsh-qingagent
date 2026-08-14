// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeEvent, BridgeState, ExternalDoc } from '../src/contracts.js'
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
  it('abort/failure 后退出 streaming，后续 loadState 不复活僵死流并保留失败注记', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const fetchMock = vi.fn(async () => Response.json(bridgeState()))
    vi.stubGlobal('fetch', fetchMock)
    const store = new QingClientStore()
    const release = store.retain('dsh-1')

    await vi.waitFor(() => expect(store.getSnapshot('dsh-1').state).toBeDefined())
    expect(store.hasPanelContent('dsh-1')).toBe(true)
    const source = FakeEventSource.instances[0]!
    source.emit({
      type: 'draft-chunk', engineSessionId: 'qing-1', chunkQingml: '<p>半篇',
      accumulatedBlocks: ['<p>半篇</p>'], title: '测试稿', blocks: 1, words: 2,
    })
    expect(store.getSnapshot('dsh-1').streaming).toBe(true)

    source.emit({ type: 'binding-changed', binding: bridgeState().binding })
    source.emit({ type: 'draft-failed', engineSessionId: 'qing-1', message: 'QingML 生成失败：用户已中止' })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.getSnapshot('dsh-1').streaming).toBe(false))
    expect(store.getSnapshot('dsh-1').draftFailure).toBe('QingML 生成失败：用户已中止')
    release()
    expect(source.closed).toBe(true)
  })
})
