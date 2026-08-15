import { describe, expect, it, vi } from 'vitest'
import type { ExternalDocReplaceRequest, ExternalDocReplaceResponse, PmDoc } from '../src/contracts.js'
import { DocumentSaveCoordinator } from '../src/client/documentSaveCoordinator.js'

function pm(text: string): PmDoc {
  return {
    type: 'doc',
    attrs: { schemaVersion: 1 },
    content: [{ type: 'paragraph', attrs: { blockId: `p-${text}` }, content: [{ type: 'text', text }] }],
  } as PmDoc
}

function baseline(version: number) {
  return {
    expectedDocumentSnapshot: version,
    baseContentHash: `hash-${version}`,
    baseHasSubstantiveContent: version > 0,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('DocumentSaveCoordinator', () => {
  it('严格单飞，并把在途期间的多笔全文合并为 latest-only 一笔', async () => {
    vi.useFakeTimers()
    const first = deferred<ExternalDocReplaceResponse>()
    const second = deferred<ExternalDocReplaceResponse>()
    const send = vi.fn((_request: ExternalDocReplaceRequest): Promise<ExternalDocReplaceResponse> => first.promise)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    let mutation = 0
    const committed: string[] = []
    const coordinator = new DocumentSaveCoordinator({
      send: (_engineSessionId, request) => send(request),
      createMutationId: () => `m-${++mutation}`,
      onCommitted: (_engineSessionId, doc) => committed.push(((doc.content[0] as { content: Array<{ text: string }> }).content[0]?.text) ?? ''),
    })

    const one = coordinator.enqueue('qing-1', pm('一'), baseline(4))
    const two = coordinator.enqueue('qing-1', pm('二'), baseline(4))
    const three = coordinator.enqueue('qing-1', pm('三'), baseline(4))
    expect(send).toHaveBeenCalledTimes(1)

    first.resolve({ ok: true, clientMutationId: 'm-1', docVersion: 5, contentHash: 'hash-5', ts: 't5' })
    await one
    await vi.runOnlyPendingTimersAsync()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      expectedDocumentSnapshot: 5,
      baseContentHash: 'hash-5',
      clientMutationId: 'm-2',
      doc: pm('三'),
    })

    second.resolve({ ok: true, clientMutationId: 'm-2', docVersion: 6, contentHash: 'hash-6', ts: 't6' })
    await Promise.all([two, three])
    expect(committed).toEqual(['一', '三'])
    vi.useRealTimers()
  })

  it('未知 actual 版本冲突如实 surface，且不会拿旧全文静默重发', async () => {
    const states: string[] = []
    const send = vi.fn(async (_request: ExternalDocReplaceRequest) => {
      throw {
        body: {
          code: 'VERSION_CONFLICT',
          conflict: { expected: 7, actual: 9 },
          actualContentHash: 'hash-9',
        },
      }
    })
    const coordinator = new DocumentSaveCoordinator({
      send: (_engineSessionId, request) => send(request),
      onCommitted: vi.fn(),
      onStateChange: (state) => states.push(state.kind),
    })

    await expect(coordinator.enqueue('qing-1', pm('本地改动'), baseline(7))).rejects.toThrow('保存冲突')
    expect(send).toHaveBeenCalledTimes(1)
    expect(coordinator.getState()).toMatchObject({ kind: 'conflict', expected: 7, actual: 9 })
    expect(states).toEqual(['saving', 'conflict'])
  })

  it('瞬态失败额外重试两次，三次发送复用同一 mutation 与 frozen baseline', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async (_request: ExternalDocReplaceRequest) => { throw new TypeError('Failed to fetch') })
    let mutation = 0
    const coordinator = new DocumentSaveCoordinator({
      send: (_engineSessionId, request) => send(request),
      createMutationId: () => `retry-${++mutation}`,
      onCommitted: vi.fn(),
    })

    const saving = coordinator.enqueue('qing-1', pm('重试'), baseline(2))
    const rejected = expect(saving).rejects.toThrow('网络不稳')
    await vi.runAllTimersAsync()
    await rejected
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ clientMutationId: 'retry-1', expectedDocumentSnapshot: 2, baseContentHash: 'hash-2' }),
      expect.objectContaining({ clientMutationId: 'retry-1', expectedDocumentSnapshot: 2, baseContentHash: 'hash-2' }),
      expect.objectContaining({ clientMutationId: 'retry-1', expectedDocumentSnapshot: 2, baseContentHash: 'hash-2' }),
    ])
    vi.useRealTimers()
  })

  it('跨文稿排队时冻结 engineSessionId，且不拿甲文回执重绑乙文 baseline', async () => {
    vi.useFakeTimers()
    const first = deferred<ExternalDocReplaceResponse>()
    const send = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        ok: true, clientMutationId: 'm-2', docVersion: 1, contentHash: 'hash-b1', ts: 'tb1',
      })
    let mutation = 0
    const coordinator = new DocumentSaveCoordinator({
      send,
      createMutationId: () => `m-${++mutation}`,
      onCommitted: vi.fn(),
    })

    const one = coordinator.enqueue('qing-a', pm('甲'), baseline(4))
    const two = coordinator.enqueue('qing-b', pm('乙'), baseline(0))
    first.resolve({ ok: true, clientMutationId: 'm-1', docVersion: 5, contentHash: 'hash-a5', ts: 'ta5' })
    await one
    await vi.runOnlyPendingTimersAsync()
    await two

    expect(send.mock.calls[0]?.[0]).toBe('qing-a')
    expect(send.mock.calls[1]?.[0]).toBe('qing-b')
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      expectedDocumentSnapshot: 0,
      baseContentHash: 'hash-0',
      doc: pm('乙'),
    })
    vi.useRealTimers()
  })
})
