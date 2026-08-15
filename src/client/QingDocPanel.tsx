import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import {
  DocumentSnapshotView,
  type DocumentSnapshotViewHandle,
} from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import { PatchNav } from '@qingweb/pages/workspace/components/PatchNav'
import {
  appliedDocWriteBaseline,
  EMPTY_PM_DOC,
  type DocWriteBaseline,
} from '@qingweb/pages/workspace/data/docWriteBaseline'
import { pmDocToViewDocumentSnapshot } from '@qingweb/pages/workspace/data/protocol'
import type { PmDoc } from '@qingagent/pm-schema'
import { DocumentSaveCoordinator, type DocumentSaveState } from './documentSaveCoordinator.js'
import { createQingmlCompileThrottle, type QingmlCompileThrottle } from './streamingDocument.js'
import { buildReviewPresentationModel } from './reviewPresentation.js'
import { installDetailsColumnWidth } from './detailsWidth.js'
import { decideIncomingPanelDocument } from './incomingPanelDocument.js'
import { qingClientStore } from './store.js'
import '../qingdoc/qingdoc.css'

interface InjectedProps {
  qingLayout: ILayout
}

export type QingDocPanelProps = PropsRuntime<'details'> & InjectedProps

const EMPTY_PATCH_IDS = new Set<string>()

export function QingDocPanel(props: QingDocPanelProps) {
  const sessionId = String(props.useSession((session) => session.sessionId))
  const snapshot = useSyncExternalStore(
    (listener) => qingClientStore.subscribe(sessionId, listener),
    () => qingClientStore.getSnapshot(sessionId),
  )
  const [toast, setToast] = useState<string | null>(null)
  const [streamingPmDoc, setStreamingPmDoc] = useState<PmDoc | null>(null)
  const [activeReviewTargetId, setActiveReviewTargetId] = useState<string | null>(null)
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [reviewSettlementRetryPending, setReviewSettlementRetryPending] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const docViewRef = useRef<DocumentSnapshotViewHandle | null>(null)
  const lastDocViewHandleRef = useRef<DocumentSnapshotViewHandle | null>(null)
  const editorEngineSessionIdRef = useRef<string | null>(null)
  const saveCoordinatorRef = useRef<DocumentSaveCoordinator | null>(null)
  const compileThrottleRef = useRef<QingmlCompileThrottle | null>(null)
  const autoCommitKeyRef = useRef<string | null>(null)
  const reviewSubmittingRef = useRef(false)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  useEffect(
    () => qingClientStore.retain(sessionId, () => props.qingLayout.openDetails()),
    [sessionId, props.qingLayout],
  )

  useLayoutEffect(() => {
    const root = rootRef.current
    return root ? installDetailsColumnWidth(root) : undefined
  }, [])

  const docs = snapshot.state?.docs ?? []
  const activeEngineSessionId = snapshot.activeEngineSessionId
    ?? snapshot.state?.binding.activeEngineSessionId
  const activeBound = docs.find((doc) => doc.engineSessionId === activeEngineSessionId)
  const observedVersion = snapshot.activeDoc?.docVersion ?? activeBound?.docVersion
  const observedState = snapshot.activeDoc?.state ?? activeBound?.state

  const setDocViewHandle = useCallback((handle: DocumentSnapshotViewHandle | null) => {
    docViewRef.current = handle
    if (handle) lastDocViewHandleRef.current = handle
  }, [])

  const flushPendingDocSave = useCallback(async () => {
    await (docViewRef.current ?? lastDocViewHandleRef.current)?.flushPendingDocSave()
  }, [])

  const previousActiveEngineSessionIdRef = useRef<string | undefined>(activeEngineSessionId)
  useEffect(() => {
    const previous = previousActiveEngineSessionIdRef.current
    previousActiveEngineSessionIdRef.current = activeEngineSessionId
    if (!previous || previous === activeEngineSessionId) return
    void flushPendingDocSave().catch((error) => {
      console.error('[qingagent-panel] switch flush failed', error)
      setToast('保存失败 · 已保留当前文稿')
    })
  }, [activeEngineSessionId, flushPendingDocSave])

  useEffect(() => {
    if (!activeEngineSessionId) return
    void qingClientStore.refreshPanel(sessionId, activeEngineSessionId).catch(() => undefined)
  }, [activeEngineSessionId, observedState, observedVersion, sessionId])

  useEffect(() => {
    compileThrottleRef.current?.cancel()
    setStreamingPmDoc(null)
    if (!activeEngineSessionId) return
    const throttle = createQingmlCompileThrottle({
      onCompiled: setStreamingPmDoc,
      onError: (error) => {
        console.warn('[qingagent-panel] QingML 增量编译跳过一帧', error)
      },
    })
    compileThrottleRef.current = throttle
    return () => {
      throttle.cancel()
      if (compileThrottleRef.current === throttle) compileThrottleRef.current = null
    }
  }, [activeEngineSessionId])

  useEffect(() => {
    const throttle = compileThrottleRef.current
    if (!snapshot.streaming) {
      throttle?.cancel()
      setStreamingPmDoc(null)
      return
    }
    if (snapshot.qingml) throttle?.push(snapshot.qingml)
  }, [snapshot.qingml, snapshot.streaming])

  useEffect(() => {
    const coordinator = new DocumentSaveCoordinator({
      send: (engineSessionId, request) => qingClientStore.replaceDocument(sessionId, engineSessionId, request),
      onCommitted: (engineSessionId, doc, response) => {
        qingClientStore.applySavedDocument(sessionId, engineSessionId, doc, response)
      },
      onStateChange: (state) => {
        qingClientStore.setSaveState(sessionId, state)
        if (state.kind === 'conflict') setToast('文档已被更新 · 已暂停编辑')
        const engineSessionId = editorEngineSessionIdRef.current
        if (state.kind === 'blocked' && engineSessionId) {
          void qingClientStore.refreshPanel(sessionId, engineSessionId).catch(() => undefined)
        }
      },
    })
    saveCoordinatorRef.current = coordinator
    const retryOnline = () => coordinator.retryOnline()
    window.addEventListener('online', retryOnline)
    return () => {
      window.removeEventListener('online', retryOnline)
      const pendingFlush = (docViewRef.current ?? lastDocViewHandleRef.current)
        ?.flushPendingDocSave() ?? Promise.resolve()
      void pendingFlush.catch((error) => {
        console.error('[qingagent-panel] unmount flush failed', error)
      }).finally(() => {
        coordinator.dispose()
        if (saveCoordinatorRef.current === coordinator) saveCoordinatorRef.current = null
      })
    }
  }, [sessionId])

  useEffect(() => qingClientStore.registerPanelRefreshGuard(sessionId, {
    beforeApply: async (engineSessionId, incomingPanelDoc) => {
      const currentSnapshot = snapshotRef.current
      if (currentSnapshot.saveState?.kind === 'conflict') return false
      const mountedEngineSessionId = editorEngineSessionIdRef.current
      if (!mountedEngineSessionId || mountedEngineSessionId !== engineSessionId) {
        await flushPendingDocSave()
        return true
      }
      const handle = docViewRef.current ?? lastDocViewHandleRef.current
      if (!handle || !incomingPanelDoc.pmDoc) return true
      let decision
      try {
        decision = await decideIncomingPanelDocument({
          handle,
          panelDoc: incomingPanelDoc,
          activity: () => saveCoordinatorRef.current?.getWriteActivity(engineSessionId) ?? {
            pendingDocWrite: false,
            queuedDocWrite: false,
          },
          reviewActive: currentSnapshot.panelDoc?.state === 'pendingReview',
          reviewBaseVersion: currentSnapshot.reviewModel?.baseVersion,
          afterFlush: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
        })
      } catch (error) {
        console.warn('[qingagent-panel] local save failed before authoritative refresh', error)
        return false
      }
      if (decision.kind === 'apply') return true
      if (decision.kind === 'reconcile') return false
      if (decision.kind === 'conflict') {
        const expected = currentSnapshot.panelDoc?.docVersion ?? 0
        const actual = incomingPanelDoc.docVersion
        const message = `保存冲突：文稿已从 v${expected} 更新到 v${actual}，已暂停编辑以保护两边内容。`
        saveCoordinatorRef.current?.rememberKnownVersion(
          engineSessionId,
          appliedDocWriteBaseline({
            version: incomingPanelDoc.docVersion,
            pmDoc: incomingPanelDoc.pmDoc,
            contentHash: incomingPanelDoc.contentHash,
          }),
          'streamConflict',
        )
        qingClientStore.setSaveState(sessionId, { kind: 'conflict', expected, actual, message })
        setToast('文档已被更新 · 已暂停编辑')
        return false
      }
      return false
    },
    afterApply: (engineSessionId, panelDoc) => {
      if (!panelDoc.pmDoc) return
      saveCoordinatorRef.current?.rememberKnownVersion(
        engineSessionId,
        appliedDocWriteBaseline({
          version: panelDoc.docVersion,
          pmDoc: panelDoc.pmDoc,
          contentHash: panelDoc.contentHash,
        }),
        'streamApply',
      )
    },
  }), [flushPendingDocSave, sessionId])

  useEffect(() => {
    const handleToast = (event: Event) => setToast((event as CustomEvent<string>).detail)
    window.addEventListener('qingagent:panel-toast', handleToast)
    return () => window.removeEventListener('qingagent:panel-toast', handleToast)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const measurePaper = useCallback(() => {
    const root = rootRef.current
    const paper = root?.querySelector<HTMLElement>('.wf-doc')
      ?? root?.querySelector<HTMLElement>('.ws-paper-shell')
    if (!root || !paper) return
    const rect = paper.getBoundingClientRect()
    root.style.setProperty('--doc-left', `${rect.left}px`)
    root.style.setProperty('--doc-right', `${rect.right}px`)
  }, [])

  useEffect(() => {
    // 纸面挂载/换文档/进出审阅都可能改变 .wf-doc 的水平位置而 root 尺寸不变,
    // 所以除 root 外还要观察纸面本身,并在状态变化后双帧重测(等布局稳定)。
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(measurePaper))
    const root = rootRef.current
    const paper = root?.querySelector<HTMLElement>('.wf-doc')
      ?? root?.querySelector<HTMLElement>('.ws-paper-shell')
    const observer = root && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measurePaper)
      : null
    if (root) observer?.observe(root)
    if (paper) observer?.observe(paper)
    window.addEventListener('resize', measurePaper)
    return () => {
      cancelAnimationFrame(raf1)
      observer?.disconnect()
      window.removeEventListener('resize', measurePaper)
    }
  }, [measurePaper, snapshot.panelDoc, snapshot.reviewModel, snapshot.streaming, activeEngineSessionId])

  const panelDoc = snapshot.panelEngineSessionId === activeEngineSessionId
    ? snapshot.panelDoc
    : undefined
  if (panelDoc && activeEngineSessionId) editorEngineSessionIdRef.current = activeEngineSessionId
  const pendingReview = panelDoc?.state === 'pendingReview'
  const busy = snapshot.streaming || panelDoc?.agentBusy === true || activeBound?.agentBusy === true
  const saveState = snapshot.saveState ?? ({ kind: 'idle' } satisfies DocumentSaveState)
  const saveLocked = saveState.kind === 'conflict' || saveState.kind === 'blocked'
  const interactiveEditable = Boolean(
    panelDoc &&
    !busy &&
    !pendingReview &&
    !saveLocked &&
    (panelDoc.state === 'editing' || panelDoc.state === 'empty'),
  )
  const reviewPresentation = useMemo(
    () => panelDoc && snapshot.reviewModel
      ? buildReviewPresentationModel(panelDoc, snapshot.reviewModel)
      : null,
    [panelDoc, snapshot.reviewModel],
  )
  const surfacePmDoc = streamingPmDoc ?? panelDoc?.pmDoc ?? EMPTY_PM_DOC
  const surfaceVersion = pendingReview
    ? snapshot.reviewModel?.baseVersion ?? panelDoc?.docVersion ?? 0
    : panelDoc?.docVersion ?? 0
  const surfaceDoc = useMemo(
    () => reviewPresentation?.doc
      ?? pmDocToViewDocumentSnapshot(surfacePmDoc, surfaceVersion, panelDoc?.ts ?? ''),
    [panelDoc?.ts, reviewPresentation?.doc, surfacePmDoc, surfaceVersion],
  )

  const handleEditorChange = useCallback((doc: PmDoc, baseline?: DocWriteBaseline) => {
    const engineSessionId = editorEngineSessionIdRef.current
    if (!baseline || !engineSessionId || !saveCoordinatorRef.current) return Promise.resolve()
    return saveCoordinatorRef.current.enqueue(engineSessionId, doc, baseline)
  }, [])

  const handleFocusDocument = useCallback(async (engineSessionId: string) => {
    try {
      await flushPendingDocSave()
      await qingClientStore.focus(sessionId, engineSessionId)
    } catch (error) {
      console.error('[qingagent-panel] focus flush failed', error)
      setToast('保存失败 · 未切换文稿')
    }
  }, [flushPendingDocSave, sessionId])

  const handleClose = useCallback(async () => {
    try {
      await flushPendingDocSave()
      props.qingLayout.closeDetails()
    } catch (error) {
      console.error('[qingagent-panel] close flush failed', error)
      setToast('保存失败 · 文稿面板保持打开')
    }
  }, [flushPendingDocSave, props.qingLayout])

  const visibleReviewTargets = reviewPresentation?.visibleReviewTargets ?? []
  const visibleReviewTargetIds = useMemo(
    () => visibleReviewTargets.map((target) => target.id),
    [visibleReviewTargets],
  )
  useEffect(() => {
    if (!pendingReview || visibleReviewTargetIds.length === 0) {
      setActiveReviewTargetId(null)
      return
    }
    if (activeReviewTargetId && visibleReviewTargetIds.includes(activeReviewTargetId)) return
    setActiveReviewTargetId(visibleReviewTargetIds[0] ?? null)
  }, [activeReviewTargetId, pendingReview, visibleReviewTargetIds])

  const jumpReview = useCallback((direction: -1 | 1) => {
    if (!visibleReviewTargetIds.length) return
    const current = activeReviewTargetId ? visibleReviewTargetIds.indexOf(activeReviewTargetId) : -1
    const next = direction > 0
      ? visibleReviewTargetIds[Math.min(current + 1, visibleReviewTargetIds.length - 1)]
      : visibleReviewTargetIds[Math.max(0, current < 0 ? 0 : current - 1)]
    if (!next) return
    setActiveReviewTargetId(next)
    const root = rootRef.current
    const element = root?.querySelector(reviewTargetSelector(next))
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeReviewTargetId, visibleReviewTargetIds])

  const handleReviewVerdict = useCallback(async (
    patchId: string,
    verdict: 'accepted' | 'rejected',
  ) => {
    if (!activeEngineSessionId || !panelDoc) return
    if (reviewSubmittingRef.current) {
      setToast('操作处理中 · 请稍候')
      return
    }
    reviewSubmittingRef.current = true
    setReviewSubmitting(true)
    try {
      const response = await qingClientStore.reviewVerdict(sessionId, activeEngineSessionId, {
        expectedDocVersion: panelDoc.docVersion,
        patchId,
        verdict,
      })
      const suggestions = snapshotRef.current.reviewModel?.suggestions ?? []
      const expectedReviewingCount = suggestions.filter((suggestion) =>
        suggestion.status === 'reviewing' && suggestion.id !== patchId).length
      const responseMatchesLocal = response.patchIds.length === 1 &&
        response.patchIds[0] === patchId &&
        response.reviewingCount === expectedReviewingCount
      qingClientStore.applyReviewVerdict(
        sessionId,
        activeEngineSessionId,
        response.patchIds,
        verdict,
      )
      if (!responseMatchesLocal) {
        void qingClientStore.refreshPanel(sessionId, activeEngineSessionId).catch(() => undefined)
      }
      setToast(verdict === 'accepted' ? '已保留这处改动' : '已取消这处改动')
    } catch (error) {
      console.error('[qingagent-panel] review verdict failed', error)
      setToast('操作失败 · 请重试')
      void qingClientStore.refreshPanel(sessionId, activeEngineSessionId).catch(() => undefined)
    } finally {
      reviewSubmittingRef.current = false
      setReviewSubmitting(false)
    }
  }, [activeEngineSessionId, panelDoc, sessionId])

  const handleReviewCommit = useCallback(async (
    action: 'commit' | 'accept_all' | 'reject_all',
  ) => {
    if (!activeEngineSessionId || !panelDoc) return
    if (reviewSubmittingRef.current) {
      setToast('操作处理中 · 请稍候')
      return
    }
    reviewSubmittingRef.current = true
    setReviewSubmitting(true)
    if (action === 'commit') setReviewSettlementRetryPending(false)
    try {
      await qingClientStore.reviewCommit(sessionId, activeEngineSessionId, {
        expectedDocVersion: panelDoc.docVersion,
        action,
      })
      setToast(action === 'reject_all' ? '已放弃本轮修改' : '修改已提交')
      setReviewSettlementRetryPending(false)
      await Promise.all([
        qingClientStore.refreshDoc(sessionId, activeEngineSessionId),
        qingClientStore.refreshPanel(sessionId, activeEngineSessionId),
      ])
    } catch (error) {
      console.error('[qingagent-panel] review commit failed', error)
      if (action === 'commit') setReviewSettlementRetryPending(true)
      setToast('提交失败 · 候选已保留，请重试')
      void qingClientStore.refreshPanel(sessionId, activeEngineSessionId).catch(() => undefined)
    } finally {
      reviewSubmittingRef.current = false
      setReviewSubmitting(false)
    }
  }, [activeEngineSessionId, panelDoc, sessionId])

  const reviewStatusKey = snapshot.reviewModel?.suggestions
    .map((suggestion) => `${suggestion.id}:${suggestion.status}`)
    .join('|') ?? ''
  useEffect(() => {
    const suggestions = snapshot.reviewModel?.suggestions ?? []
    if (!pendingReview || suggestions.length === 0) {
      autoCommitKeyRef.current = null
      setReviewSettlementRetryPending(false)
      return
    }
    if (reviewSubmitting || suggestions.some((suggestion) => suggestion.status === 'reviewing')) return
    const key = `${activeEngineSessionId ?? ''}:${panelDoc?.docVersion ?? -1}:${reviewStatusKey}`
    if (autoCommitKeyRef.current === key) return
    autoCommitKeyRef.current = key
    void handleReviewCommit('commit')
  }, [
    activeEngineSessionId,
    handleReviewCommit,
    panelDoc?.docVersion,
    pendingReview,
    reviewStatusKey,
    reviewSubmitting,
    snapshot.reviewModel?.suggestions,
  ])

  const remainingReviewCount = snapshot.reviewModel?.suggestions
    .filter((suggestion) => suggestion.status === 'reviewing').length ?? 0
  const unrenderableReviewOnly = remainingReviewCount > 0 &&
    visibleReviewTargets.length === 0
  const reviewCount = reviewPresentation
    ? remainingReviewCount
    : snapshot.reviewCount ?? 0
  const title = panelDoc?.title || snapshot.activeDoc?.title || activeBound?.title || '未命名文稿'
  const status = panelStatus({
    busy,
    blocks: snapshot.blocks,
    words: snapshot.words,
    pendingReview,
    reviewCount,
    saveState,
    version: panelDoc?.docVersion,
    loading: snapshot.panelLoading === true && !panelDoc,
  })
  const engineUrl = snapshot.state?.engine.engineUrl ?? 'http://127.0.0.1:8080'
  const openUrl = activeEngineSessionId
    ? `${engineUrl.replace(/\/$/, '')}/#/workspace?session=${encodeURIComponent(activeEngineSessionId)}`
    : engineUrl
  const contentKind = pendingReview ? 'pendingReview' : panelDoc?.state === 'empty' ? 'empty' : 'editable'

  const rootStyle = {
    '--ws-paper-body-padding-inline': '40px',
    '--ws-paper-chat-column-width': '400px',
    '--ws-paper-column-gap': '48px',
    '--ws-paper-column-width': '800px',
    '--ws-paper-top-offset': '52px',
    '--ws-paper-radius': '0',
  } as CSSProperties

  return (
    <section
      ref={rootRef}
      id="view-workspace"
      data-qingagent-doc-panel
      data-view="workspace"
      data-wf="WorkspacePage"
      data-content={contentKind}
      data-tool={busy ? 'agentBusy' : 'none'}
      data-ws-state={busy ? 'streaming' : 'idle'}
      data-qingdoc-mode={interactiveEditable ? 'editable' : 'readonly'}
      data-save-state={saveState.kind}
      style={rootStyle}
      aria-label="青简文档"
    >
      <div
        className="qingdoc-details-resizer"
        data-qing-details-resizer
        role="separator"
        aria-label="调整青简文档栏宽度"
        aria-orientation="vertical"
      />
      <header className="qingdoc-stage-controls">
        <div className="qingdoc-heading">
          <span className="qingdoc-brand">青简</span>
          <strong className="qingdoc-stage-title" title={title}>{title}</strong>
          <span className="qingdoc-status" data-kind={saveState.kind}>{status}</span>
        </div>
        <div className="qingdoc-host-actions">
          {docs.length > 1 ? (
            <select
              className="qingdoc-doc-select"
              aria-label="切换青简文稿"
              value={activeEngineSessionId ?? ''}
              onChange={(event) => void handleFocusDocument(event.currentTarget.value)}
            >
              {docs.map((doc) => (
                <option key={doc.engineSessionId} value={doc.engineSessionId}>{doc.title}</option>
              ))}
            </select>
          ) : null}
          <a className="qingdoc-open" href={openUrl} target="_blank" rel="noopener noreferrer">在青简中打开 ↗</a>
          <button
            className="qingdoc-close"
            type="button"
            onClick={() => { void handleClose() }}
            aria-label="关闭青简文档"
          >×</button>
        </div>
      </header>
      <div className="ws-body">
        <main className="ws-right">
          <div className="ws-paper-shell" data-wf="WorkspacePaperShell" aria-hidden="true" />
          <div className="ws-document-content" data-wf="WorkspaceHydrationDocumentContent">
            {pendingReview && snapshot.reviewModel?.suggestions.length ? (
              <PatchNav
                remainingCount={remainingReviewCount}
                totalCount={visibleReviewTargets.length}
                activePatchIndex={activeReviewTargetId
                  ? visibleReviewTargetIds.indexOf(activeReviewTargetId)
                  : -1}
                isSubmitting={reviewSubmitting}
                retryOnly={reviewSettlementRetryPending}
                unrenderableOnly={unrenderableReviewOnly}
                onJumpPrev={() => jumpReview(-1)}
                onJumpNext={() => jumpReview(1)}
                onRejectAll={() => { void handleReviewCommit('reject_all') }}
                onCommit={() => handleReviewCommit('commit')}
              />
            ) : null}
            <DocumentSnapshotView
              ref={setDocViewHandle}
              doc={surfaceDoc}
              docId={activeEngineSessionId ? `dsh:${activeEngineSessionId}` : `dsh:${sessionId}:empty`}
              editable
              interactiveEditable={interactiveEditable}
              deferBlockIdNormalization={pendingReview}
              showPatches={pendingReview && Boolean(reviewPresentation?.applied.length)}
              acceptedPatches={reviewPresentation?.acceptedIds ?? EMPTY_PATCH_IDS}
              rejectedPatches={reviewPresentation?.rejectedIds ?? EMPTY_PATCH_IDS}
              onPatchVerdict={(patchId: string, verdict: 'accepted' | 'rejected') => {
                void handleReviewVerdict(patchId, verdict)
              }}
              patchMeta={reviewPresentation?.patchMeta}
              activePatchId={reviewPresentation?.visibleReviewTargets.find(
                (target) => target.id === activeReviewTargetId,
              )?.patchId ?? null}
              reviewSuggestions={reviewPresentation?.suggestions}
              reviewOverlayInputs={reviewPresentation?.overlayInputs}
              reviewBlockPatches={reviewPresentation?.blockPatchInputs}
              reviewAppliedPatches={reviewPresentation?.applied}
              reviewTargets={reviewPresentation?.reviewTargets}
              activeReviewTargetId={activeReviewTargetId}
              onEditorChange={interactiveEditable ? handleEditorChange : undefined}
              onToast={setToast}
            />
          </div>
        </main>
      </div>
      {toast ? <div className="qingdoc-toast" role="status">{toast}</div> : null}
    </section>
  )
}

function reviewTargetSelector(targetId: string): string {
  const escape = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape
    : (value: string) => value.replace(/["\\]/g, '\\$&')
  return `[data-review-target-id="${escape(targetId)}"],[data-patch-id="${escape(targetId)}"]:not(.wf-patch-del)`
}

function panelStatus(input: {
  busy: boolean
  blocks: number
  words: number
  pendingReview: boolean
  reviewCount: number
  saveState: DocumentSaveState
  version?: number
  loading: boolean
}): string {
  if (input.pendingReview) return `审阅中 · ${input.reviewCount} 处`
  if (input.busy) return `写作中 · ${input.blocks} 块 · 约 ${input.words} 字`
  if (input.saveState.kind === 'saving') return '保存中…'
  if (input.saveState.kind === 'conflict') return '保存冲突 · 已暂停编辑'
  if (input.saveState.kind === 'blocked') {
    return input.saveState.code === 'AGENT_BUSY' ? '青简处理中 · 已暂停编辑' : '审阅中 · 已暂停编辑'
  }
  if (input.saveState.kind === 'error') return input.saveState.transient ? '网络不稳 · 等待重存' : '保存失败'
  if (input.loading) return '正在读取文稿…'
  if (input.version !== undefined) return `已保存 v${input.version}`
  return '准备写作'
}
