// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocWriteBaseline } from '@qingweb/pages/workspace/data/docWriteBaseline'
import type {
  BridgeEvent,
  DocSuggestion,
  ExternalPmDocReadResponse,
  ExternalReviewOutcome,
  ExternalReviewRenderModelResponse,
  PmDoc,
} from '../src/contracts.js'
import {
  computeExternalReviewChangeRatio,
  panelStatus,
  QingDocPanel,
  type QingDocPanelProps,
} from '../src/client/QingDocPanel.js'
import { qingClientStore } from '../src/client/store.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const viewHarness = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  innerHtml: '',
  semanticDirty: false,
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
        getInnerHtml: () => viewHarness.innerHtml,
        getLastPresentationRun: () => null,
        hasLocalDocumentChanges: () => viewHarness.semanticDirty,
        canSafelyApplyIncomingDocument: () => false,
        compareIncomingDocument: () => viewHarness.semanticDirty ? 'different' : 'equivalent',
        flushPendingDocSave: async () => {
          const pending = viewHarness.pending
          viewHarness.pending = null
          if (pending) await props.onEditorChange?.(pending.doc, pending.baseline)
        },
      }), [props.onEditorChange])
      return React.createElement(
        'div',
        { className: 'ws-paper-surface' },
        React.createElement('div', { className: 'ws-editor-glow', 'aria-hidden': 'true' }),
        React.createElement(
          'article',
          {
            'data-testid': 'mock-document-view',
            'data-doc-json': JSON.stringify((props as unknown as { doc?: unknown }).doc ?? null),
          },
          React.createElement('div', { className: 'pm-diagram-view', 'data-testid': 'mock-drawio-preview' }),
        ),
      )
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
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
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
  close(): void {}
}

const EMPTY_PM = { type: 'doc', attrs: { schemaVersion: 1 }, content: [] } as PmDoc
const EDITED_PM = {
  type: 'doc', attrs: { schemaVersion: 1 },
  content: [{ type: 'paragraph', attrs: { blockId: 'typed' }, content: [{ type: 'text', text: '刚输入的正文' }] }],
} as PmDoc
const WHOLE_BASE_PM = {
  type: 'doc', attrs: { schemaVersion: 1 },
  content: [{ type: 'paragraph', attrs: { blockId: 'whole-base' }, content: [{ type: 'text', text: '旧版全文' }] }],
} as PmDoc
const WHOLE_EDITED_PM = {
  type: 'doc', attrs: { schemaVersion: 1 },
  content: [{ type: 'paragraph', attrs: { blockId: 'whole-edited' }, content: [{ type: 'text', text: '新版全文' }] }],
} as PmDoc
const TOOL_FIRST_PM = {
  type: 'doc', attrs: { schemaVersion: 1 },
  content: [{ type: 'paragraph', attrs: { blockId: 'tool-first' }, content: [{ type: 'text', text: '工具第一稿' }] }],
} as PmDoc
const TOOL_SECOND_PM = {
  type: 'doc', attrs: { schemaVersion: 1 },
  content: [{ type: 'paragraph', attrs: { blockId: 'tool-second' }, content: [{ type: 'text', text: '工具第二稿' }] }],
} as PmDoc

function reviewSuggestion(
  status: 'reviewing' | 'accepted' | 'rejected' = 'reviewing',
  beforeText = '',
  afterText = '落稿',
  id = 'patch-reviewed',
): DocSuggestion {
  return {
    id, reviewBatchId: 'batch-1', groupMode: 'independent',
    docId: 'qing-review', baseVersion: 3, baseSchemaVersion: 1, status,
    anchor: { blockId: 'missing', pmFrom: 1, pmTo: 1, quote: '', textHash: 'hash' },
    patch: { kind: 'prosemirror_steps', steps: [] },
    preview: { deleteText: beforeText, insertText: afterText }, summary: '测试候选',
  }
}

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  viewHarness.pending = null
  viewHarness.innerHtml = ''
  viewHarness.semanticDirty = false
  viewHarness.props = null
  patchNavHarness.props = null
  toolbarHarness.props = null
  FakeEventSource.instances = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('QingDocPanel 保存生命周期', () => {
  it('空稿写作中挂载 QingLoading 推理态，不保留空文档 glow', async () => {
    installBridgeFetch('dsh-empty-busy', ['qing-empty-busy'], { agentBusy: true })
    renderPanel('dsh-empty-busy')

    const loading = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLElement>('[data-wf="QingLoading"]')
      expect(candidate).not.toBeNull()
      return candidate!
    })
    expect(loading.classList.contains('is-static')).toBe(false)
    expect(document.querySelector('[data-testid="mock-document-view"]')).toBeNull()
    expect(document.querySelector('.ws-editor-glow')).toBeNull()
  })

  it('有稿写作中不挂 QingLoading，保留现有纸面 glow 态', async () => {
    installBridgeFetch('dsh-content-busy', ['qing-content-busy'], {
      agentBusy: true,
      panelPm: EDITED_PM,
    })
    renderPanel('dsh-content-busy')

    await vi.waitFor(() => expect(
      document.querySelector('[data-qingagent-doc-panel]')?.getAttribute('data-tool'),
    ).toBe('agentBusy'))
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="mock-document-view"]'),
    ).not.toBeNull())
    expect(document.querySelector('[data-wf="QingLoading"]')).toBeNull()
    expect(document.querySelector('.ws-paper-surface > .ws-editor-glow')).not.toBeNull()
  })

  it('空稿闲置时不挂 QingLoading', async () => {
    installBridgeFetch('dsh-empty-idle', ['qing-empty-idle'])
    renderPanel('dsh-empty-idle')

    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="mock-document-view"]'),
    ).not.toBeNull())
    expect(document.querySelector('[data-wf="QingLoading"]')).toBeNull()
    expect(document.querySelector('[data-qingagent-doc-panel]')?.getAttribute('data-tool')).toBe('none')
  })

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

  it('审阅态双击 drawio 只提示，不打开 overlay 或进入本地保存事务', async () => {
    installBridgeFetch('dsh-drawio-review', ['qing-drawio'], {
      pendingReview: true,
      reviewSuggestionStatus: 'reviewing',
    })
    renderPanel('dsh-drawio-review')
    await vi.waitFor(() => expect(
      document.querySelector('[data-qingagent-doc-panel]')?.getAttribute('data-qingdoc-mode'),
    ).toBe('readonly'))
    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent)
      .toBe('审阅中·1处'))
    const preview = document.querySelector<HTMLElement>('[data-testid="mock-drawio-preview"]')!

    await act(async () => {
      preview.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    })

    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent)
      .toBe('文稿正在审阅，请先完成审阅再编辑 drawio 图'))
    expect(document.querySelector('.drawio-editor-overlay')).toBeNull()
    expect(viewHarness.props?.onEditorChange).toBeUndefined()
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
    viewHarness.semanticDirty = true
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
    viewHarness.semanticDirty = true
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

  it('防抖保存已在途时收到 doc-committed，先登记 incoming 并把旧基线静默重放到新版本', async () => {
    const bridge = installToolWriteBridgeFetch('dsh-p78-inflight', {
      initialVersion: 1,
      initialPm: WHOLE_BASE_PM,
      conflictFirstPut: true,
    })
    viewHarness.innerHtml = '旧版全文'
    renderPanel('dsh-p78-inflight')
    const onEditorChange = await vi.waitFor(() => {
      const callback = viewHarness.props?.onEditorChange
      expect(callback).toBeTypeOf('function')
      return callback as (doc: PmDoc, baseline: DocWriteBaseline) => Promise<void>
    })

    // 先让一笔旧基线保存进入网络；随后语义恢复干净，模拟 trailingNode 脚手架回声。
    viewHarness.semanticDirty = true
    const saving = onEditorChange(WHOLE_BASE_PM, {
      expectedDocumentSnapshot: 1,
      baseContentHash: 'hash-1',
      baseHasSubstantiveContent: true,
    })
    await vi.waitFor(() => expect(bridge.putRequests()).toHaveLength(1))
    viewHarness.semanticDirty = false

    act(() => bridge.commitTool(TOOL_FIRST_PM, '工具第一稿'))
    bridge.releaseFirstPutConflict()
    await act(async () => { await saving })

    await vi.waitFor(() => expect(bridge.putRequests()).toHaveLength(2))
    expect(bridge.putRequests().map((request) => request.expectedDocumentSnapshot)).toEqual([1, 2])
    await vi.waitFor(() => expect(
      document.querySelector('[data-qingagent-doc-panel]')?.getAttribute('data-save-state'),
    ).not.toBe('conflict'))
    expect(document.querySelector('.qingdoc-conflict-reload')).toBeNull()
  })

  it('连续两次工具写稿且用户零输入，脚手架事务不发保存且顶栏始终非冲突', async () => {
    const bridge = installToolWriteBridgeFetch('dsh-p78-two-tools')
    renderPanel('dsh-p78-two-tools')
    const onEditorChange = await vi.waitFor(() => {
      const callback = viewHarness.props?.onEditorChange
      expect(callback).toBeTypeOf('function')
      return callback as (doc: PmDoc, baseline: DocWriteBaseline) => Promise<void>
    })

    viewHarness.semanticDirty = false
    await act(async () => {
      await onEditorChange(EMPTY_PM, {
        expectedDocumentSnapshot: 0,
        baseContentHash: 'hash-0',
        baseHasSubstantiveContent: false,
      })
    })
    act(() => bridge.commitTool(TOOL_FIRST_PM, '工具第一稿'))
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="mock-document-view"]')?.getAttribute('data-doc-json'),
    ).toContain('工具第一稿'))

    viewHarness.innerHtml = '工具第一稿'
    await act(async () => {
      await onEditorChange(TOOL_FIRST_PM, {
        expectedDocumentSnapshot: 1,
        baseContentHash: 'hash-1',
        baseHasSubstantiveContent: true,
      })
    })
    act(() => bridge.commitTool(TOOL_SECOND_PM, '工具第二稿'))

    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="mock-document-view"]')?.getAttribute('data-doc-json'),
    ).toContain('工具第二稿'))
    expect(bridge.putRequests()).toHaveLength(0)
    expect(document.querySelector('[data-qingagent-doc-panel]')?.getAttribute('data-save-state'))
      .not.toBe('conflict')
    expect(document.querySelector('.qingdoc-status')?.textContent).not.toContain('保存冲突')
    expect(document.querySelector('.qingdoc-conflict-reload')).toBeNull()
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
      reviewCommitFailureStatus: 500,
    })
    renderPanel('dsh-review-retry')

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(1))
    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent)
      .toBe('提交失败 · 候选已保留，请重试'))
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="mock-patch-nav"]')?.getAttribute('data-retry-only'),
    ).toBe('true'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(reviewCommitCalls(fetchMock)).toBe(1)
    expect(authoritativeDocReadCalls(fetchMock)).toBe(0)
  })

  it('全采纳结算也把权威计数回流到当前 DSH 对话', async () => {
    const qingSendMessage = vi.fn(async (_dshSessionId: string, _text: string) => undefined)
    installBridgeFetch('dsh-review-accepted-outcome', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'accepted',
      reviewOutcome: { acceptedCount: 1, rejectedCount: 0, hunks: [] },
    })
    renderPanel('dsh-review-accepted-outcome', qingSendMessage)

    await vi.waitFor(() => expect(qingSendMessage).toHaveBeenCalledOnce())
    expect(qingSendMessage).toHaveBeenCalledWith(
      'dsh-review-accepted-outcome',
      '【审核结果】本轮审阅我已处理:采纳 1 处,拒绝 0 处。全部改动均已采纳。',
    )
  })

  it('拒绝结算回流服务端给出的完整具体内容，不用本地预览也不截断', async () => {
    const qingSendMessage = vi.fn(async (_dshSessionId: string, _text: string) => undefined)
    const beforeText = '这是服务端确认应当保留的完整原文，长度明显超过四十个字符，用于证明结算回流不会再截断具体内容。'
    const afterText = '这是服务端确认已被拒绝的完整改文，长度同样超过四十个字符，用于证明载荷来自权威结算结果。'
    installBridgeFetch('dsh-review-rejected-outcome', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'rejected',
      reviewBeforeText: '本地预览旧文',
      reviewAfterText: '本地预览改文',
      reviewOutcome: {
        acceptedCount: 0,
        rejectedCount: 1,
        hunks: [{
          verdict: 'rejected',
          blockSummary: '第二节的结论段',
          beforeText,
          afterText,
        }],
      },
    })
    renderPanel('dsh-review-rejected-outcome', qingSendMessage)

    await vi.waitFor(() => expect(qingSendMessage).toHaveBeenCalledOnce())
    const message = qingSendMessage.mock.calls[0]?.[1] ?? ''
    expect(message).toContain('采纳 0 处,拒绝 1 处')
    expect(message).toContain(`拒绝「${afterText}」,保留原文「${beforeText}」`)
    expect(message).not.toContain('本地预览')
    expect(message).not.toContain('…')
  })

  it('首次 409 且仍待审、批次同一时用权威版本重试一次并成功', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchMock = installBridgeFetch('dsh-review-conflict-retry', ['qing-review'], {
      pendingReview: true,
      reviewCommitConflictPending: 'once',
    })
    renderPanel('dsh-review-conflict-retry')

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(2))
    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent).toBe('修改已提交'))
    expect(reviewCommitExpectedVersions(fetchMock)).toEqual([3, 4])
    expect(info).toHaveBeenCalledWith(
      '[qingagent-panel] review commit conflict retrying with authoritative version',
      { action: 'commit', docVersion: 4 },
    )
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
    expect(reviewRenderModelCalls(fetchMock)).toBeGreaterThanOrEqual(2)
    expect(authoritativeDocReadCalls(fetchMock)).toBe(0)
  })

  it('409 重试仍冲突时最多请求两次并保留候选', async () => {
    const fetchMock = installBridgeFetch('dsh-review-conflict-twice', ['qing-review'], {
      pendingReview: true,
      reviewCommitConflictPending: 'always',
    })
    renderPanel('dsh-review-conflict-twice')

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(2))
    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent)
      .toBe('提交失败 · 候选已保留，请重试'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(reviewCommitCalls(fetchMock)).toBe(2)
  })

  it('409 探测发现建议 ID 集合变化时不重试', async () => {
    const fetchMock = installBridgeFetch('dsh-review-conflict-new-batch', ['qing-review'], {
      pendingReview: true,
      reviewCommitConflictPending: 'once',
      conflictAddsSuggestion: true,
    })
    renderPanel('dsh-review-conflict-new-batch')

    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent)
      .toBe('提交失败 · 候选已保留，请重试'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(reviewCommitCalls(fetchMock)).toBe(1)
    expect(reviewRenderModelCalls(fetchMock)).toBeGreaterThanOrEqual(2)
  })

  it('409 重试在途时提交重入仍被忙态闸门拦住', async () => {
    let releaseRetry!: () => void
    const reviewCommitRetryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
    const fetchMock = installBridgeFetch('dsh-review-conflict-busy', ['qing-review'], {
      pendingReview: true,
      reviewCommitConflictPending: 'once',
      reviewCommitRetryGate,
    })
    renderPanel('dsh-review-conflict-busy')

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(2))
    await act(async () => {
      await (patchNavHarness.props?.onCommit as (() => Promise<void>) | undefined)?.()
    })
    expect(reviewCommitCalls(fetchMock)).toBe(2)

    releaseRetry()
    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent).toBe('修改已提交'))
    expect(reviewCommitCalls(fetchMock)).toBe(2)
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

describe('QingDocPanel 整篇审阅', () => {
  it('按青简输入侧公式派生 changeRatio，达到 0.7 阈值时切到整篇审并可切换新旧全文', async () => {
    const ratio = computeExternalReviewChangeRatio(
      {
        sessionId: 'qing-review', docVersion: 3, contentHash: 'hash-3',
        state: 'pendingReview', agentBusy: false, title: '整篇审', ts: 't0', charCount: 4, pmDoc: WHOLE_BASE_PM,
      } satisfies ExternalPmDocReadResponse,
      {
        sessionId: 'qing-review', docVersion: 3, state: 'pendingReview', agentBusy: false,
        baseVersion: 3, previewDoc: WHOLE_BASE_PM, editedDoc: WHOLE_EDITED_PM,
        suggestions: [reviewSuggestion('reviewing', '旧版全文', '新版全文')],
      } satisfies ExternalReviewRenderModelResponse,
    )
    expect(ratio).toBe(1)

    installBridgeFetch('dsh-whole-threshold', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'reviewing',
      changeRatio: 0.7,
      reviewBasePm: WHOLE_BASE_PM,
      reviewEditedPm: WHOLE_EDITED_PM,
    })
    renderPanel('dsh-whole-threshold')

    await vi.waitFor(() => expect(document.querySelector('[data-wf="WholeDocReviewNav"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="mock-patch-nav"]')).toBeNull()
    expect(document.querySelector('.wdr-swap')).not.toBeNull()
    expect(document.querySelector('[data-testid="mock-document-view"]')?.getAttribute('data-doc-json'))
      .toContain('新版全文')
    expect(viewHarness.props).toMatchObject({
      interactiveEditable: false,
      deferBlockIdNormalization: true,
      showPatches: false,
      activePatchId: null,
    })

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')?.click()
    })
    await vi.waitFor(() => expect(
      document.querySelector('[data-testid="mock-document-view"]')?.getAttribute('data-doc-json'),
    ).toContain('旧版全文'))
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('旧版')
  })

  it('应用新版复用 reviewCommit 并发送 accept_all', async () => {
    const fetchMock = installBridgeFetch('dsh-whole-apply', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'reviewing',
      wholeDocument: true,
      reviewBasePm: WHOLE_BASE_PM,
      reviewEditedPm: WHOLE_EDITED_PM,
    })
    renderPanel('dsh-whole-apply')
    const apply = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[data-wf="WholeDocReviewNav"] button')]
        .find((candidate) => candidate.textContent === '应用新版')
      expect(button).toBeDefined()
      return button!
    })

    await act(async () => { apply.click() })
    await vi.waitFor(() => expect(reviewCommitActions(fetchMock)).toContain('accept_all'))
  })

  it('引擎未返回 changeRatio 时使用 suggestion 前后文本派生并进入整篇审', async () => {
    installBridgeFetch('dsh-whole-derived-ratio', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'reviewing',
      reviewBasePm: WHOLE_BASE_PM,
      reviewEditedPm: WHOLE_EDITED_PM,
      reviewBeforeText: '旧版全文',
      reviewAfterText: '新版全文',
    })
    renderPanel('dsh-whole-derived-ratio')

    await vi.waitFor(() => expect(document.querySelector('[data-wf="WholeDocReviewNav"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="mock-patch-nav"]')).toBeNull()
  })

  it('退回旧版先走产品确认层，确认后复用 reviewCommit 并发送 reject_all', async () => {
    const fetchMock = installBridgeFetch('dsh-whole-revert', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'reviewing',
      wholeDocument: true,
      reviewBasePm: WHOLE_BASE_PM,
      reviewEditedPm: WHOLE_EDITED_PM,
    })
    renderPanel('dsh-whole-revert')
    const revert = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[data-wf="WholeDocReviewNav"] button')]
        .find((candidate) => candidate.textContent === '退回旧版')
      expect(button).toBeDefined()
      return button!
    })

    await act(async () => { revert.click() })
    const confirm = await vi.waitFor(() => {
      const dialog = document.querySelector<HTMLElement>('[data-wf="GlobalConfirm"]')
      expect(dialog?.textContent).toContain('退回旧版会放弃本轮全部修改。')
      return dialog!.querySelector<HTMLButtonElement>('.ws-folder-modal-danger')!
    })
    await act(async () => { confirm.click() })
    await vi.waitFor(() => expect(reviewCommitActions(fetchMock)).toContain('reject_all'))
  })

  it('退回旧版遇首次 409 时同样按权威版本重试一次', async () => {
    const fetchMock = installBridgeFetch('dsh-whole-revert-conflict', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'reviewing',
      wholeDocument: true,
      reviewBasePm: WHOLE_BASE_PM,
      reviewEditedPm: WHOLE_EDITED_PM,
      reviewCommitConflictPending: 'once',
    })
    renderPanel('dsh-whole-revert-conflict')
    const revert = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[data-wf="WholeDocReviewNav"] button')]
        .find((candidate) => candidate.textContent === '退回旧版')
      expect(button).toBeDefined()
      return button!
    })

    await act(async () => { revert.click() })
    const confirm = await vi.waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-wf="GlobalConfirm"]')
        ?.querySelector<HTMLButtonElement>('.ws-folder-modal-danger')
      expect(button).not.toBeNull()
      return button!
    })
    await act(async () => { confirm.click() })

    await vi.waitFor(() => expect(reviewCommitCalls(fetchMock)).toBe(2))
    await vi.waitFor(() => expect(document.querySelector('.qingdoc-status')?.textContent).toBe('已放弃本轮修改'))
    expect(reviewCommitActions(fetchMock)).toEqual(['reject_all', 'reject_all'])
    expect(reviewCommitExpectedVersions(fetchMock)).toEqual([3, 4])
  })

  it('changeRatio 低于 0.7 时仍走逐处 PatchNav', async () => {
    installBridgeFetch('dsh-inline-threshold', ['qing-review'], {
      pendingReview: true,
      reviewSuggestionStatus: 'reviewing',
      changeRatio: 0.69,
      reviewBasePm: WHOLE_BASE_PM,
      reviewEditedPm: WHOLE_EDITED_PM,
    })
    renderPanel('dsh-inline-threshold')

    await vi.waitFor(() => expect(document.querySelector('[data-testid="mock-patch-nav"]')).not.toBeNull())
    expect(document.querySelector('[data-wf="WholeDocReviewNav"]')).toBeNull()
    expect(document.querySelector('.wdr-swap')).toBeNull()
  })
})

describe('QingDocPanel 文稿缺失状态', () => {
  it('以钦定占位显示缺失稿，持久剔除多篇 missing，并在读回后恢复标题与入口', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const missingIds = new Set(['qing-missing'])
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/qingagent-bridge/state?')) {
        return Response.json({
          dshSessionId: 'dsh-doc-missing',
          binding: {
            docs: [
              { engineSessionId: 'qing-missing', title: '昨日旧稿', createdAt: '2026-08-15T00:00:00.000Z' },
              { engineSessionId: 'qing-live', title: '可用文稿', createdAt: '2026-08-15T00:01:00.000Z' },
            ],
            activeEngineSessionId: 'qing-missing',
          },
          // 模拟删除探测前留在客户端的旧快照，锁住整条标题 fallback 都必须失效。
          docs: [
            {
              engineSessionId: 'qing-missing', title: '昨日旧稿', createdAt: '2026-08-15T00:00:00.000Z',
              state: 'editing', docVersion: 3,
            },
            {
              engineSessionId: 'qing-live', title: '可用文稿', createdAt: '2026-08-15T00:01:00.000Z',
              state: 'editing', docVersion: 2,
            },
          ],
          activeDoc: {
            sessionId: 'qing-missing', docVersion: 3, state: 'editing', agentBusy: false,
            markdown: '旧正文', qingml: '<p>旧正文</p>', title: '昨日旧稿',
          },
          engine: { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
        })
      }
      if (url.startsWith('/qingagent-bridge/doc-pm?')) {
        const engineSessionId = new URL(url, 'http://local').searchParams.get('engineSessionId')!
        if (missingIds.has(engineSessionId)) {
          return Response.json(
            { error: '青简会话不存在', code: 'SESSION_NOT_FOUND', nextStep: '不要重试原引用' },
            { status: 404 },
          )
        }
        return Response.json({
          sessionId: engineSessionId, docVersion: engineSessionId === 'qing-missing' ? 4 : 2,
          contentHash: 'hash-readable', state: 'editing', agentBusy: false,
          title: engineSessionId === 'qing-missing' ? '恢复文稿' : '可用文稿', ts: 't2', pmDoc: EDITED_PM,
        })
      }
      if (url.startsWith('/qingagent-bridge/review-render-model?')) {
        const engineSessionId = new URL(url, 'http://local').searchParams.get('engineSessionId')!
        return Response.json({
          sessionId: engineSessionId, docVersion: engineSessionId === 'qing-missing' ? 4 : 2,
          state: 'editing', agentBusy: false,
          baseVersion: 2, suggestions: [],
        })
      }
      if (url.startsWith('/qingagent-bridge/library?')) {
        return Response.json({
          library: [
            { engineSessionId: 'qing-missing', title: '昨日旧稿', state: 'editing', updatedAt: '2026-08-15T02:00:00.000Z' },
            { engineSessionId: 'qing-live', title: '可用文稿', state: 'editing', updatedAt: '2026-08-15T03:00:00.000Z' },
          ],
        })
      }
      if (url === '/qingagent-bridge/focus' && init?.method === 'POST') {
        return Response.json({ ok: true })
      }
      throw new Error(`unexpected ${url}`)
    }))
    renderPanel('dsh-doc-missing')

    const missing = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLElement>('.qingdoc-doc-missing')
      expect(candidate?.textContent).toBe('该文档已删除')
      return candidate!
    })
    const panel = missing.closest<HTMLElement>('[data-qingagent-doc-panel]')!
    expect(panel.getAttribute('data-content')).toBe('docMissing')
    expect(panel.hasAttribute('data-save-state')).toBe(false)
    expect(panel.querySelector('.qingdoc-stage-title')?.textContent).toBe('该文档已删除')
    expect(panel.querySelector('.qingdoc-doc-trigger')?.textContent).toContain('该文档已删除')
    expect(panel.querySelector('.qingdoc-status')).toBeNull()
    expect(panel.querySelector('.qingdoc-open')).toBeNull()
    expect(panel.querySelector('[data-wf="WorkspaceDocFunctions"]')).toBeNull()
    expect(panel.querySelector('[data-testid="mock-document-view"]')).toBeNull()
    expect(panel.querySelector('[data-testid="mock-doc-toolbar"]')).toBeNull()
    for (const internalWord of ['昨日旧稿', 'HTTP 404', 'SESSION_NOT_FOUND', 'docRef', 'qing-missing']) {
      expect(panel.outerHTML).not.toContain(internalWord)
    }
    expect(panel.textContent).not.toMatch(/保存|约\d+字/)

    await act(async () => {
      panel.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')?.click()
    })
    const available = await vi.waitFor(() => {
      const option = [...panel.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((candidate) => candidate.textContent?.includes('可用文稿'))
      expect(option).toBeDefined()
      return option!
    })
    expect(panel.querySelector('.qingdoc-doc-menu')?.textContent).not.toContain('昨日旧稿')

    await act(async () => { available.click() })
    await vi.waitFor(() => {
      expect(panel.getAttribute('data-content')).toBe('editable')
      expect(panel.querySelector('[data-testid="mock-document-view"]')).not.toBeNull()
    })

    await act(async () => {
      panel.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')?.click()
    })
    await vi.waitFor(() => expect(panel.querySelector('.qingdoc-doc-menu')).not.toBeNull())
    expect(panel.querySelector('.qingdoc-doc-menu')?.textContent).not.toContain('昨日旧稿')
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')?.click()
    })

    missingIds.add('qing-live')
    await act(async () => {
      await qingClientStore.refreshPanel('dsh-doc-missing', 'qing-live').catch(() => undefined)
    })
    await vi.waitFor(() => expect(panel.getAttribute('data-content')).toBe('docMissing'))
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')?.click()
    })
    await vi.waitFor(() => expect(panel.querySelector('.qingdoc-doc-menu')).not.toBeNull())
    expect(panel.querySelector('.qingdoc-doc-menu')?.textContent).not.toContain('昨日旧稿')
    expect(panel.querySelector('.qingdoc-doc-menu')?.textContent).not.toContain('可用文稿')
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')?.click()
    })

    missingIds.delete('qing-missing')
    await act(async () => {
      await qingClientStore.refreshPanel('dsh-doc-missing', 'qing-missing')
    })
    await vi.waitFor(() => {
      expect(panel.getAttribute('data-content')).toBe('editable')
      expect(panel.querySelector('.qingdoc-stage-title')?.textContent).toBe('恢复文稿')
    })
    expect(panel.querySelector('.qingdoc-doc-trigger')?.textContent).toContain('恢复文稿')
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('.qingdoc-doc-trigger')?.click()
    })
    await vi.waitFor(() => expect(panel.querySelector('.qingdoc-doc-menu')?.textContent).toContain('昨日旧稿'))
    expect(panel.querySelector('.qingdoc-doc-menu')?.textContent).not.toContain('可用文稿')
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

function renderPanel(
  sessionId: string,
  qingSendMessage?: (dshSessionId: string, text: string) => Promise<void>,
): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const props = {
    useSession: (selector: (session: { sessionId: string }) => unknown) => selector({ sessionId }),
    qingLayout: { openDetails: vi.fn(), closeDetails: vi.fn() },
    ...(qingSendMessage ? { qingSendMessage } : {}),
  } as unknown as QingDocPanelProps
  act(() => root?.render(<QingDocPanel {...props} />))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function installToolWriteBridgeFetch(
  dshSessionId: string,
  options: {
    initialVersion?: number
    initialPm?: PmDoc
    conflictFirstPut?: boolean
  } = {},
) {
  vi.stubGlobal('EventSource', FakeEventSource)
  let serverVersion = options.initialVersion ?? 0
  let serverPm = options.initialPm ?? EMPTY_PM
  let serverText = serverVersion > 0 ? '旧版全文' : ''
  const firstPutConflictGate = deferred<void>()
  const requests: Array<{
    expectedDocumentSnapshot: number
    baseContentHash: string
    clientMutationId: string
    doc: PmDoc
  }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/qingagent-bridge/state?')) {
      return Response.json({
        dshSessionId,
        binding: {
          docs: [{ engineSessionId: 'qing-1', title: '测试稿', createdAt: '2026-08-15T00:00:00.000Z' }],
          activeEngineSessionId: 'qing-1',
        },
        docs: [{
          engineSessionId: 'qing-1', title: '测试稿', createdAt: '2026-08-15T00:00:00.000Z',
          state: serverVersion > 0 ? 'editing' : 'empty', docVersion: serverVersion, agentBusy: false,
        }],
        activeDoc: {
          sessionId: 'qing-1', docVersion: serverVersion,
          state: serverVersion > 0 ? 'editing' : 'empty', agentBusy: false,
          markdown: serverText, qingml: serverText ? `<p>${serverText}</p>` : '', title: '测试稿',
        },
        engine: { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
      })
    }
    if (url.startsWith('/qingagent-bridge/doc-pm?') && init?.method === 'PUT') {
      const request = JSON.parse(String(init.body)) as typeof requests[number]
      requests.push(request)
      if (options.conflictFirstPut && requests.length === 1) {
        await firstPutConflictGate.promise
        return Response.json({
          code: 'VERSION_CONFLICT',
          error: 'doc version conflict',
          conflict: { expected: request.expectedDocumentSnapshot, actual: serverVersion },
          actualContentHash: `hash-${serverVersion}`,
        }, { status: 409 })
      }
      serverVersion += 1
      serverPm = request.doc
      return Response.json({
        ok: true,
        clientMutationId: request.clientMutationId,
        docVersion: serverVersion,
        contentHash: `hash-${serverVersion}`,
        ts: `t${serverVersion}`,
        charCount: serverText.length,
      })
    }
    if (url.startsWith('/qingagent-bridge/doc-pm?')) {
      return Response.json({
        sessionId: 'qing-1', docVersion: serverVersion, contentHash: `hash-${serverVersion}`,
        state: serverVersion > 0 ? 'editing' : 'empty', agentBusy: false,
        title: '测试稿', ts: `t${serverVersion}`, charCount: serverText.length, pmDoc: serverPm,
      })
    }
    if (url.startsWith('/qingagent-bridge/review-render-model?')) {
      return Response.json({
        sessionId: 'qing-1', docVersion: serverVersion, state: 'editing', agentBusy: false,
        baseVersion: serverVersion, suggestions: [],
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  return {
    fetchMock,
    putRequests: () => requests,
    releaseFirstPutConflict: () => firstPutConflictGate.resolve(),
    commitTool(pmDoc: PmDoc, text: string) {
      serverVersion += 1
      serverPm = pmDoc
      serverText = text
      const source = FakeEventSource.instances.at(-1)
      if (!source) throw new Error('EventSource 尚未连接')
      source.emit({
        type: 'doc-committed', engineSessionId: 'qing-1',
        doc: {
          sessionId: 'qing-1', docVersion: serverVersion, state: 'editing', agentBusy: false,
          markdown: text, qingml: `<p>${text}</p>`, title: '测试稿', pmDoc,
          contentHash: `hash-${serverVersion}`, ts: `t${serverVersion}`,
        },
        blocks: 1, words: text.length,
      })
    },
  }
}

function installBridgeFetch(
  dshSessionId: string,
  engineSessionIds: string[],
  options: {
    agentBusy?: boolean
    panelPm?: PmDoc
    pendingReview?: boolean
    failReviewCommit?: boolean
    reviewCommitFailureStatus?: number
    reviewCommitConflictSettled?: boolean
    reviewCommitConflictPending?: 'once' | 'always'
    conflictAddsSuggestion?: boolean
    reviewCommitGate?: Promise<void>
    reviewCommitRetryGate?: Promise<void>
    reviewSuggestionStatus?: 'reviewing' | 'accepted' | 'rejected'
    mismatchVerdict?: boolean
    postCommitPanelGate?: Promise<void>
    stalePostCommitPanelReads?: number
    changeRatio?: number
    wholeDocument?: boolean
    reviewBasePm?: PmDoc
    reviewEditedPm?: PmDoc
    reviewBeforeText?: string
    reviewAfterText?: string
    reviewOutcome?: ExternalReviewOutcome
  } = {},
) {
  vi.stubGlobal('EventSource', FakeEventSource)
  let serverPendingReview = options.pendingReview === true
  let reviewCommitted = false
  let serverDocVersion = serverPendingReview ? 3 : 0
  let reviewCommitAttempts = 0
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
          docVersion: serverDocVersion, agentBusy: options.agentBusy === true,
        })),
        activeDoc: {
          sessionId: engineSessionIds[0], docVersion: serverDocVersion,
          state: serverPendingReview ? 'pendingReview' : 'empty', agentBusy: options.agentBusy === true,
          markdown: '', qingml: '', title: engineSessionIds[0],
        },
        engine: { state: 'online', engineUrl: 'http://127.0.0.1:8080' },
      })
    }
    if (url.startsWith('/qingagent-bridge/doc-pm?') && init?.method === 'PUT') {
      return Response.json({
        ok: true, clientMutationId: 'saved-1', docVersion: 1, contentHash: 'hash-1', ts: 't1', charCount: 0,
      })
    }
    if (url.startsWith('/qingagent-bridge/doc-pm?')) {
      if (reviewCommitted) await options.postCommitPanelGate
      const engineSessionId = new URL(url, 'http://local').searchParams.get('engineSessionId')!
      const stalePendingReview = reviewCommitted && stalePostCommitPanelReads > 0
      if (stalePendingReview) stalePostCommitPanelReads -= 1
      const pendingReview = serverPendingReview || stalePendingReview
      return Response.json({
        sessionId: engineSessionId, docVersion: serverDocVersion,
        contentHash: `hash-${serverDocVersion}`,
        state: pendingReview ? 'pendingReview' : 'editing',
        agentBusy: options.agentBusy === true, title: engineSessionId, ts: 't0', charCount: 0,
        pmDoc: options.panelPm ?? options.reviewBasePm ?? EMPTY_PM,
      })
    }
    if (url.startsWith('/qingagent-bridge/doc?')) {
      const engineSessionId = new URL(url, 'http://local').searchParams.get('engineSessionId')!
      return Response.json({
        sessionId: engineSessionId, docVersion: serverDocVersion,
        state: serverPendingReview ? 'pendingReview' : 'editing', agentBusy: options.agentBusy === true,
        markdown: '', qingml: '', title: engineSessionId,
      })
    }
    if (url.startsWith('/qingagent-bridge/review-render-model?')) {
      const suggestionIds = options.conflictAddsSuggestion && reviewCommitAttempts > 0
        ? ['patch-reviewed', 'patch-late']
        : ['patch-reviewed']
      return Response.json({
        sessionId: engineSessionIds[0], docVersion: serverDocVersion,
        state: serverPendingReview ? 'pendingReview' : 'editing', agentBusy: false,
        baseVersion: 3, previewDoc: options.reviewBasePm ?? EMPTY_PM,
        ...(options.reviewEditedPm ? { editedDoc: options.reviewEditedPm } : {}),
        ...(options.changeRatio === undefined ? {} : { changeRatio: options.changeRatio }),
        ...(options.wholeDocument ? { wholeDocument: true } : {}),
        suggestions: reviewCommitted ? [] : suggestionIds.map((id) => reviewSuggestion(
          options.reviewSuggestionStatus ?? 'accepted',
          options.reviewBeforeText,
          options.reviewAfterText,
          id,
        )),
      })
    }
    if (url.startsWith('/qingagent-bridge/review-commit?') && init?.method === 'POST') {
      reviewCommitAttempts += 1
      await options.reviewCommitGate
      if (reviewCommitAttempts === 2) await options.reviewCommitRetryGate
      if (options.failReviewCommit) {
        return Response.json({ error: 'commit failed' }, { status: options.reviewCommitFailureStatus ?? 502 })
      }
      if (options.reviewCommitConflictSettled && reviewCommitAttempts === 1) {
        serverDocVersion += 1
        serverPendingReview = false
        reviewCommitted = true
        return Response.json({ error: 'review already settled' }, { status: 409 })
      }
      if (
        options.reviewCommitConflictPending &&
        (reviewCommitAttempts === 1 || options.reviewCommitConflictPending === 'always')
      ) {
        if (reviewCommitAttempts === 1) serverDocVersion += 1
        return Response.json({ error: 'doc version conflict' }, { status: 409 })
      }
      if (options.reviewCommitConflictPending === 'once') {
        const body = JSON.parse(String(init.body)) as { expectedDocVersion: number }
        if (body.expectedDocVersion !== serverDocVersion) {
          return Response.json({ error: 'doc version conflict' }, { status: 409 })
        }
      }
      serverPendingReview = false
      reviewCommitted = true
      serverDocVersion += 1
      const outcome = options.reviewOutcome ?? { acceptedCount: 1, rejectedCount: 0, hunks: [] }
      return Response.json({
        status: 'reviewed', docVersion: serverDocVersion,
        acceptedCount: outcome.acceptedCount, rejectedCount: outcome.rejectedCount,
        remainingCount: 0, outcomeQueued: false,
        outcome, seq: null,
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

function reviewCommitActions(fetchMock: ReturnType<typeof installBridgeFetch>): string[] {
  return fetchMock.mock.calls
    .filter(([url, init]) =>
      String(url).startsWith('/qingagent-bridge/review-commit?') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as { action: string })
    .map((body) => body.action)
}

function reviewCommitExpectedVersions(fetchMock: ReturnType<typeof installBridgeFetch>): number[] {
  return fetchMock.mock.calls
    .filter(([url, init]) =>
      String(url).startsWith('/qingagent-bridge/review-commit?') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as { expectedDocVersion: number })
    .map((body) => body.expectedDocVersion)
}

function reviewRenderModelCalls(fetchMock: ReturnType<typeof installBridgeFetch>): number {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).startsWith('/qingagent-bridge/review-render-model?')).length
}

function panelReadCalls(fetchMock: ReturnType<typeof installBridgeFetch>): number {
  return fetchMock.mock.calls.filter(([url, init]) =>
    String(url).startsWith('/qingagent-bridge/doc-pm?') && init?.method !== 'PUT').length
}

function authoritativeDocReadCalls(fetchMock: ReturnType<typeof installBridgeFetch>): number {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).startsWith('/qingagent-bridge/doc?')).length
}
