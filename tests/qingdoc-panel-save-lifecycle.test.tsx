// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocWriteBaseline } from '@qingweb/pages/workspace/data/docWriteBaseline'
import type { PmDoc } from '../src/contracts.js'
import { QingDocPanel, type QingDocPanelProps } from '../src/client/QingDocPanel.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const viewHarness = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  pending: null as { doc: PmDoc; baseline: {
    expectedDocumentSnapshot: number
    baseContentHash: string
    baseHasSubstantiveContent: boolean
  } } | null,
}))
const patchNavHarness = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))

vi.mock('@qingweb/pages/workspace/components/DocumentSnapshotView', async () => {
  const React = await import('react')
  return {
    DocumentSnapshotView: React.forwardRef(function MockDocumentSnapshotView(
      props: {
        onEditorChange?: (doc: PmDoc, baseline?: DocWriteBaseline) => Promise<void>
        onPatchVerdict?: (patchId: string, verdict: 'accepted' | 'rejected') => void
      },
      ref: React.ForwardedRef<unknown>,
    ) {
      viewHarness.props = props as unknown as Record<string, unknown>
      React.useImperativeHandle(ref, () => ({
        getInnerHtml: () => '',
        getLastPresentationRun: () => null,
        hasLocalDocumentChanges: () => viewHarness.pending !== null,
        canSafelyApplyIncomingDocument: () => false,
        compareIncomingDocument: () => viewHarness.pending ? 'different' : 'equivalent',
        flushPendingDocSave: async () => {
          const pending = viewHarness.pending
          viewHarness.pending = null
          if (pending) await props.onEditorChange?.(pending.doc, pending.baseline)
        },
      }), [props.onEditorChange])
      return React.createElement('article', { 'data-testid': 'mock-document-view' })
    }),
  }
})

vi.mock('@qingweb/pages/workspace/components/PatchNav', async () => {
  const React = await import('react')
  return {
    PatchNav: (props: Record<string, unknown>) => {
      patchNavHarness.props = props
      return React.createElement('button', {
        'data-testid': 'mock-patch-nav',
        'data-retry-only': String(props.retryOnly === true),
        onClick: props.onCommit as () => void,
      })
    },
  }
})

class FakeEventSource {
  onerror: (() => void) | null = null
  addEventListener(): void {}
  close(): void {}
}

const EMPTY_PM = { type: 'doc', attrs: { schemaVersion: 1 }, content: [] } as PmDoc
const EDITED_PM = {
  type: 'doc', attrs: { schemaVersion: 1 },
  content: [{ type: 'paragraph', attrs: { blockId: 'typed' }, content: [{ type: 'text', text: '刚输入的正文' }] }],
} as PmDoc

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  viewHarness.pending = null
  viewHarness.props = null
  patchNavHarness.props = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('QingDocPanel 保存生命周期', () => {
  it('输入后立即卸载会先 flush，并把 PUT 发给当前文稿', async () => {
    const fetchMock = installBridgeFetch('dsh-unmount', ['qing-a'])
    renderPanel('dsh-unmount')
    await vi.waitFor(() => expect(document.querySelector('[data-testid="mock-document-view"]')).not.toBeNull())
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/qingagent-bridge/doc-pm?'))).toBe(true))

    viewHarness.pending = {
      doc: EDITED_PM,
      baseline: { expectedDocumentSnapshot: 0, baseContentHash: 'hash-0', baseHasSubstantiveContent: false },
    }
    act(() => root?.unmount())
    root = null

    await vi.waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(String(put?.[0])).toContain('engineSessionId=qing-a')
      expect(String(put?.[1]?.body)).toContain('刚输入的正文')
    })
  })

  it('切换文稿会先 flush 旧 timer，旧正文不得写入新文稿', async () => {
    const fetchMock = installBridgeFetch('dsh-switch', ['qing-a', 'qing-b'])
    renderPanel('dsh-switch')
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('.qingdoc-doc-select')).not.toBeNull())

    viewHarness.pending = {
      doc: EDITED_PM,
      baseline: { expectedDocumentSnapshot: 0, baseContentHash: 'hash-0', baseHasSubstantiveContent: false },
    }
    const select = document.querySelector<HTMLSelectElement>('.qingdoc-doc-select')!
    await act(async () => {
      select.value = 'qing-b'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const editedPuts = fetchMock.mock.calls.filter(([, init]) =>
      init?.method === 'PUT' && String(init.body).includes('刚输入的正文'))
    expect(editedPuts).toHaveLength(1)
    expect(String(editedPuts[0]?.[0])).toContain('engineSessionId=qing-a')
    expect(String(editedPuts[0]?.[0])).not.toContain('engineSessionId=qing-b')
  })

  it('自动提交失败后进入 retryOnly，且不会继续自动重发', async () => {
    const fetchMock = installBridgeFetch('dsh-review-retry', ['qing-review'], {
      pendingReview: true,
      failReviewCommit: true,
    })
    renderPanel('dsh-review-retry')

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(1))
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="mock-patch-nav"]')?.getAttribute('data-retry-only'),
    ).toBe('true'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(reviewCommitCalls(fetchMock)).toBe(1)
  })

  it('verdict 回执 patchIds/reviewingCount 与本地不符时补拉权威面板', async () => {
    const fetchMock = installBridgeFetch('dsh-verdict-refresh', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'reviewing',
      mismatchVerdict: true,
    })
    renderPanel('dsh-verdict-refresh')
    await vi.waitFor(() => expect(patchNavHarness.props).not.toBeNull())
    expect(viewHarness.props?.onPatchVerdict).toBeTypeOf('function')
    expect(patchNavHarness.props).toMatchObject({
      remainingCount: 1,
      totalCount: 0,
      unrenderableOnly: true,
    })
    const before = panelReadCalls(fetchMock)

    await act(async () => {
      const onPatchVerdict = viewHarness.props?.onPatchVerdict as
        | ((patchId: string, verdict: 'accepted' | 'rejected') => void)
        | undefined
      onPatchVerdict?.('patch-reviewed', 'accepted')
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    })

    await vi.waitFor(() => expect(panelReadCalls(fetchMock)).toBeGreaterThan(before))
  })
})

function renderPanel(sessionId: string): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const props = {
    useSession: (selector: (session: { sessionId: string }) => unknown) => selector({ sessionId }),
    qingLayout: { openDetails: vi.fn(), closeDetails: vi.fn() },
  } as unknown as QingDocPanelProps
  act(() => root?.render(<QingDocPanel {...props} />))
}

function installBridgeFetch(
  dshSessionId: string,
  engineSessionIds: string[],
  options: {
    pendingReview?: boolean
    failReviewCommit?: boolean
    reviewSuggestionStatus?: 'reviewing' | 'accepted' | 'rejected'
    mismatchVerdict?: boolean
  } = {},
) {
  vi.stubGlobal('EventSource', FakeEventSource)
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/qingagent-bridge/state?')) {
      return Response.json({
        dshSessionId,
        binding: {
          docs: engineSessionIds.map((engineSessionId) => ({
            engineSessionId, title: engineSessionId, createdAt: '2026-08-15T00:00:00.000Z',
          })),
          activeEngineSessionId: engineSessionIds[0],
        },
        docs: engineSessionIds.map((engineSessionId) => ({
          engineSessionId, title: engineSessionId, createdAt: '2026-08-15T00:00:00.000Z',
          state: options.pendingReview ? 'pendingReview' : 'empty',
          docVersion: options.pendingReview ? 3 : 0, agentBusy: false,
        })),
        activeDoc: {
          sessionId: engineSessionIds[0], docVersion: options.pendingReview ? 3 : 0,
          state: options.pendingReview ? 'pendingReview' : 'empty', agentBusy: false,
          markdown: '', qingml: '', title: engineSessionIds[0],
        },
        engine: { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
      })
    }
    if (url.startsWith('/qingagent-bridge/doc-pm?') && init?.method === 'PUT') {
      return Response.json({
        ok: true, clientMutationId: 'saved-1', docVersion: 1, contentHash: 'hash-1', ts: 't1',
      })
    }
    if (url.startsWith('/qingagent-bridge/doc-pm?')) {
      const engineSessionId = new URL(url, 'http://local').searchParams.get('engineSessionId')!
      return Response.json({
        sessionId: engineSessionId, docVersion: options.pendingReview ? 3 : 0,
        contentHash: options.pendingReview ? 'hash-3' : 'hash-0',
        state: options.pendingReview ? 'pendingReview' : 'empty',
        agentBusy: false, title: engineSessionId, ts: 't0', pmDoc: EMPTY_PM,
      })
    }
    if (url.startsWith('/qingagent-bridge/review-render-model?')) {
      return Response.json({
        sessionId: engineSessionIds[0], docVersion: 3, state: 'pendingReview', agentBusy: false,
        baseVersion: 3, previewDoc: EMPTY_PM,
        suggestions: [{
          id: 'patch-reviewed', reviewBatchId: 'batch-1', groupMode: 'independent',
          docId: engineSessionIds[0], baseVersion: 3, baseSchemaVersion: 1,
          status: options.reviewSuggestionStatus ?? 'accepted',
          anchor: { blockId: 'missing', pmFrom: 1, pmTo: 1, quote: '', textHash: 'hash' },
          patch: { kind: 'prosemirror_steps', steps: [] },
          preview: { insertText: '落稿' }, summary: '测试候选',
        }],
      })
    }
    if (url.startsWith('/qingagent-bridge/review-commit?') && init?.method === 'POST') {
      if (options.failReviewCommit) {
        return Response.json({ error: 'commit failed' }, { status: 502 })
      }
      return Response.json({
        status: 'reviewed', docVersion: 4, acceptedCount: 1, rejectedCount: 0,
        remainingCount: 0, outcomeQueued: false,
        outcome: { acceptedCount: 1, rejectedCount: 0, hunks: [] }, seq: null,
      })
    }
    if (url.startsWith('/qingagent-bridge/review-verdicts?') && init?.method === 'POST') {
      return Response.json({
        status: 'marked', docVersion: 3,
        patchIds: options.mismatchVerdict ? ['server-patch'] : ['patch-reviewed'],
        verdict: 'accepted', reviewingCount: options.mismatchVerdict ? 7 : 0, seq: null,
      })
    }
    if (url === '/qingagent-bridge/focus' && init?.method === 'POST') return Response.json({ ok: true })
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function reviewCommitCalls(fetchMock: ReturnType<typeof installBridgeFetch>): number {
  return fetchMock.mock.calls.filter(([url, init]) =>
    String(url).startsWith('/qingagent-bridge/review-commit?') && init?.method === 'POST').length
}

function panelReadCalls(fetchMock: ReturnType<typeof installBridgeFetch>): number {
  return fetchMock.mock.calls.filter(([url, init]) =>
    String(url).startsWith('/qingagent-bridge/doc-pm?') && init?.method !== 'PUT').length
}
