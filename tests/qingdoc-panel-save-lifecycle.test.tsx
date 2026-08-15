// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocWriteBaseline } from '@qingweb/pages/workspace/data/docWriteBaseline'
import type { PmDoc } from '../src/contracts.js'
import { QingDocPanel, type QingDocPanelProps } from '../src/client/QingDocPanel.js'

const viewHarness = vi.hoisted(() => ({
  pending: null as { doc: PmDoc; baseline: {
    expectedDocumentSnapshot: number
    baseContentHash: string
    baseHasSubstantiveContent: boolean
  } } | null,
}))

vi.mock('@qingweb/pages/workspace/components/DocumentSnapshotView', async () => {
  const React = await import('react')
  return {
    DocumentSnapshotView: React.forwardRef(function MockDocumentSnapshotView(
      props: { onEditorChange?: (doc: PmDoc, baseline?: DocWriteBaseline) => Promise<void> },
      ref: React.ForwardedRef<unknown>,
    ) {
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

vi.mock('@qingweb/pages/workspace/components/PatchNav', () => ({
  PatchNav: () => null,
}))

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

function installBridgeFetch(dshSessionId: string, engineSessionIds: string[]) {
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
          state: 'empty', docVersion: 0, agentBusy: false,
        })),
        activeDoc: {
          sessionId: engineSessionIds[0], docVersion: 0, state: 'empty', agentBusy: false,
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
        sessionId: engineSessionId, docVersion: 0, contentHash: 'hash-0', state: 'empty',
        agentBusy: false, title: engineSessionId, ts: 't0', pmDoc: EMPTY_PM,
      })
    }
    if (url === '/qingagent-bridge/focus' && init?.method === 'POST') return Response.json({ ok: true })
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
