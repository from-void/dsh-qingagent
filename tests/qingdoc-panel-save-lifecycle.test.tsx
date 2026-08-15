// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocWriteBaseline } from '@qingweb/pages/workspace/data/docWriteBaseline'
import type { PmDoc } from '../src/contracts.js'
import { panelStatus, QingDocPanel, type QingDocPanelProps } from '../src/client/QingDocPanel.js'

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
const toolbarHarness = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))

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

vi.mock('@qingweb/pages/workspace/components/DocToolbar', async () => {
  const React = await import('react')
  return {
    DocToolbar: (props: Record<string, unknown>) => {
      toolbarHarness.props = props
      return React.createElement('div', {
        'data-testid': 'mock-doc-toolbar',
        'data-active': String(props.active === true),
        'data-session-id': String(props.sessionId ?? ''),
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
  toolbarHarness.props = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('QingDocPanel 保存生命周期', () => {
  it('DocToolbar 严格跟随 canUseDocumentEditing：编辑态启用且使用资产桥会话', async () => {
    installBridgeFetch('dsh-toolbar', ['qing-toolbar'])
    renderPanel('dsh-toolbar')

    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="mock-doc-toolbar"]')?.getAttribute('data-active'),
    ).toBe('true'))
    expect(toolbarHarness.props?.containerSelector).toBe('[data-qingagent-doc-panel] .ws-right')
    expect(document.querySelector('[data-testid="mock-doc-toolbar"]')?.getAttribute('data-session-id'))
      .toContain('dsh-qingasset:')
  })

  it('DocToolbar 在 pendingReview 下保持挂载但 active=false', async () => {
    installBridgeFetch('dsh-toolbar-review', ['qing-toolbar'], { pendingReview: true })
    renderPanel('dsh-toolbar-review')

    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="mock-doc-toolbar"]')?.getAttribute('data-active'),
    ).toBe('false'))
    expect(toolbarHarness.props?.onAiModify).toBeTypeOf('function')
  })

  it('Ctrl+F 走青简 useWorkspaceFind 并挂出原生 DocFindBar', async () => {
    installBridgeFetch('dsh-find', ['qing-find'])
    renderPanel('dsh-find')
    await vi.waitFor(() => expect(toolbarHarness.props?.active).toBe(true))

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    })

    expect(document.querySelector('[data-wf="DocFindBar"]')).not.toBeNull()
    expect(document.querySelector<HTMLInputElement>('[aria-label="查找"]')).not.toBeNull()
  })

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
    await vi.waitFor(() => expect(
      document.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')?.textContent,
    ).toContain('qing-a'))

    viewHarness.pending = {
      doc: EDITED_PM,
      baseline: { expectedDocumentSnapshot: 0, baseContentHash: 'hash-0', baseHasSubstantiveContent: false },
    }
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')?.click()
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role="option"][aria-label^="qing-b"]')?.click()
    })

    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) =>
      init?.method === 'PUT' && String(init.body).includes('刚输入的正文'))).toHaveLength(1))
    const editedPuts = fetchMock.mock.calls.filter(([, init]) =>
      init?.method === 'PUT' && String(init.body).includes('刚输入的正文'))
    expect(editedPuts).toHaveLength(1)
    expect(String(editedPuts[0]?.[0])).toContain('engineSessionId=qing-a')
    expect(String(editedPuts[0]?.[0])).not.toContain('engineSessionId=qing-b')
  })

  it('文稿标题触发器恒显，并支持打开、Esc 与外点关闭', async () => {
    installBridgeFetch('dsh-switcher-close', ['唯一文稿'])
    renderPanel('dsh-switcher-close')
    const trigger = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')
      expect(candidate?.textContent).toContain('唯一文稿▾')
      return candidate!
    })

    await act(async () => { trigger.click() })
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="listbox"]')).toBeNull()

    await act(async () => { trigger.click() })
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('上下键移动文稿选项，回车调用既有 focus', async () => {
    const fetchMock = installBridgeFetch('dsh-switcher-keyboard', ['qing-a', 'qing-b'])
    renderPanel('dsh-switcher-keyboard')
    const trigger = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')
      expect(candidate?.textContent).toContain('qing-a')
      return candidate!
    })

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.querySelector('[role="option"][aria-label^="qing-b"]')?.getAttribute('data-focused'))
      .toBe('true')
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      url === '/qingagent-bridge/focus' && init?.method === 'POST' && String(init.body).includes('qing-b'),
    )).toBe(true))
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

  it('重复提交返回 409 但权威文稿已退出审阅时按成功收口', async () => {
    const fetchMock = installBridgeFetch('dsh-review-conflict-settled', ['qing-review'], {
      pendingReview: true,
      reviewCommitConflictSettled: true,
    })
    renderPanel('dsh-review-conflict-settled')

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(1))
    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent).toBe('修改已提交'))
    expect(document.querySelector('.qingdoc-toast')).toBeNull()
    expect(document.querySelector('[data-testid="mock-patch-nav"]')).toBeNull()
    expect(authoritativeDocReadCalls(fetchMock)).toBeGreaterThanOrEqual(1)
  })

  it('auto-commit 与手动提交并发共用同一把闸，只发送一次', async () => {
    let releaseCommit!: () => void
    const reviewCommitGate = new Promise<void>((resolve) => { releaseCommit = resolve })
    const fetchMock = installBridgeFetch('dsh-review-race', ['qing-review'], {
      pendingReview: true,
      reviewCommitGate,
    })
    renderPanel('dsh-review-race')

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(1))
    await act(async () => {
      const onCommit = patchNavHarness.props?.onCommit as (() => Promise<void>) | undefined
      await onCommit?.()
    })
    expect(reviewCommitCalls(fetchMock)).toBe(1)

    releaseCommit()
    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent).toBe('修改已提交'))
    expect(reviewCommitCalls(fetchMock)).toBe(1)
  })

  it('commit 回执后不等待权威刷新即可恢复编辑态并清空审阅 UI', async () => {
    let releaseRefresh!: () => void
    const postCommitPanelGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const fetchMock = installBridgeFetch('dsh-review-optimistic', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'reviewing',
      postCommitPanelGate,
    })
    renderPanel('dsh-review-optimistic')
    await vi.waitFor(() => expect(patchNavHarness.props).not.toBeNull())

    let commit: Promise<void> | undefined
    act(() => {
      commit = (patchNavHarness.props?.onCommit as (() => Promise<void>) | undefined)?.()
    })

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(1))
    await vi.waitFor(() => expect(
      document.querySelector('[data-qingagent-doc-panel]')?.getAttribute('data-qingdoc-mode'),
    ).toBe('editable'))
    expect(document.querySelector('[data-qingagent-doc-panel]')?.getAttribute('data-ws-state')).toBe('idle')
    expect(document.querySelector('[data-testid="mock-patch-nav"]')).toBeNull()
    expect(toolbarHarness.props?.active).toBe(true)

    releaseRefresh()
    await act(async () => { await commit })
  })

  it('commit 后首次权威读仍是空审阅态时 500ms 后自动重拉', async () => {
    const fetchMock = installBridgeFetch('dsh-review-stale-read', ['qing-review'], {
      pendingReview: true,
      stalePostCommitPanelReads: 1,
    })
    renderPanel('dsh-review-stale-read')

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(1))
    await vi.waitFor(() => expect(panelReadCalls(fetchMock)).toBeGreaterThanOrEqual(3), { timeout: 1_500 })
    await vi.waitFor(() => expect(
      document.querySelector('[data-qingagent-doc-panel]')?.getAttribute('data-qingdoc-mode'),
    ).toBe('editable'))
  })

  it('「在青简中打开」入口以 qingjian:// 深链拉起桌面客户端', async () => {
    installBridgeFetch('dsh-open-native', ['qing-native'])
    renderPanel('dsh-open-native')

    await vi.waitFor(() => expect(document.querySelector('.qingdoc-open')).not.toBeNull())
    expect(document.querySelector('.qingdoc-open')?.getAttribute('href'))
      .toBe('qingjian://open?engineSessionId=qing-native')
    // 深链不得开新标签页(协议由系统接管拉起客户端)。
    expect(document.querySelector('.qingdoc-open')?.getAttribute('target')).toBeNull()
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

describe('QingDocPanel 顶栏状态', () => {
  const base = {
    busy: false,
    blocks: 3,
    words: 128,
    pendingReview: false,
    reviewCount: 2,
    showSaving: false,
  }

  it('稳态静默，保存中超过 500ms 后才显示', () => {
    expect(panelStatus({ ...base, saveState: { kind: 'idle' } })).toBe('')
    expect(panelStatus({ ...base, saveState: { kind: 'saved', version: 4 } })).toBe('')
    expect(panelStatus({ ...base, saveState: { kind: 'saving' } })).toBe('')
    expect(panelStatus({ ...base, saveState: { kind: 'saving' }, showSaving: true })).toBe('保存中…')
  })

  it('只报告写作、审阅和保存异常', () => {
    expect(panelStatus({ ...base, busy: true, saveState: { kind: 'idle' } })).toBe('写作中 · 约128字')
    expect(panelStatus({ ...base, pendingReview: true, saveState: { kind: 'idle' } })).toBe('审阅中·2处')
    expect(panelStatus({ ...base, saveState: { kind: 'conflict', engineSessionId: 'qing-1', expected: 1, actual: 2, message: '' } }))
      .toBe('保存冲突·已暂停编辑')
    expect(panelStatus({ ...base, saveState: { kind: 'blocked', code: 'AGENT_BUSY', message: '' } }))
      .toBe('青简处理中')
    expect(panelStatus({ ...base, saveState: { kind: 'error', message: '', transient: true } }))
      .toBe('网络不稳·等待重存')
    expect(panelStatus({ ...base, saveState: { kind: 'error', message: '', transient: false } }))
      .toBe('保存失败')
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
    reviewCommitConflictSettled?: boolean
    reviewCommitGate?: Promise<void>
    reviewSuggestionStatus?: 'reviewing' | 'accepted' | 'rejected'
    mismatchVerdict?: boolean
    postCommitPanelGate?: Promise<void>
    stalePostCommitPanelReads?: number
  } = {},
) {
  vi.stubGlobal('EventSource', FakeEventSource)
  let serverPendingReview = options.pendingReview === true
  let reviewCommitted = false
  let stalePostCommitPanelReads = options.stalePostCommitPanelReads ?? 0
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
          state: serverPendingReview ? 'pendingReview' : 'empty',
          docVersion: serverPendingReview ? 3 : 0, agentBusy: false,
        })),
        activeDoc: {
          sessionId: engineSessionIds[0], docVersion: serverPendingReview ? 3 : 0,
          state: serverPendingReview ? 'pendingReview' : 'empty', agentBusy: false,
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
      if (reviewCommitted) await options.postCommitPanelGate
      const engineSessionId = new URL(url, 'http://local').searchParams.get('engineSessionId')!
      const stalePendingReview = reviewCommitted && stalePostCommitPanelReads > 0
      if (stalePendingReview) stalePostCommitPanelReads -= 1
      const pendingReview = serverPendingReview || stalePendingReview
      return Response.json({
        sessionId: engineSessionId, docVersion: pendingReview ? 3 : 4,
        contentHash: pendingReview ? 'hash-3' : 'hash-4',
        state: pendingReview ? 'pendingReview' : 'editing',
        agentBusy: false, title: engineSessionId, ts: 't0', pmDoc: EMPTY_PM,
      })
    }
    if (url.startsWith('/qingagent-bridge/doc?')) {
      const engineSessionId = new URL(url, 'http://local').searchParams.get('engineSessionId')!
      return Response.json({
        sessionId: engineSessionId, docVersion: serverPendingReview ? 3 : 4,
        state: serverPendingReview ? 'pendingReview' : 'editing', agentBusy: false,
        markdown: '', qingml: '', title: engineSessionId,
      })
    }
    if (url.startsWith('/qingagent-bridge/review-render-model?')) {
      return Response.json({
        sessionId: engineSessionIds[0], docVersion: 3, state: 'pendingReview', agentBusy: false,
        baseVersion: 3, previewDoc: EMPTY_PM,
        suggestions: reviewCommitted ? [] : [{
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
      await options.reviewCommitGate
      if (options.failReviewCommit) {
        return Response.json({ error: 'commit failed' }, { status: 502 })
      }
      serverPendingReview = false
      reviewCommitted = true
      if (options.reviewCommitConflictSettled) {
        return Response.json({ error: 'review already settled' }, { status: 409 })
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

function authoritativeDocReadCalls(fetchMock: ReturnType<typeof installBridgeFetch>): number {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).startsWith('/qingagent-bridge/doc?')).length
}
