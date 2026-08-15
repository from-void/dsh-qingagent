import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { DocumentSnapshotView } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import { PatchNav } from '@qingweb/pages/workspace/components/PatchNav'
import { EMPTY_PM_DOC, type DocWriteBaseline } from '@qingweb/pages/workspace/data/docWriteBaseline'
import { pmDocToViewDocumentSnapshot } from '@qingweb/pages/workspace/data/protocol'
import type { PmDoc } from '@qingagent/pm-schema'
import { DocumentSaveCoordinator, type DocumentSaveState } from './documentSaveCoordinator.js'
import { createQingmlCompileThrottle, type QingmlCompileThrottle } from './streamingDocument.js'
import { buildReviewPresentationModel } from './reviewPresentation.js'
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
  const rootRef = useRef<HTMLElement>(null)
  const saveCoordinatorRef = useRef<DocumentSaveCoordinator | null>(null)
  const compileThrottleRef = useRef<QingmlCompileThrottle | null>(null)
  const autoCommitKeyRef = useRef<string | null>(null)

  useEffect(
    () => qingClientStore.retain(sessionId, () => props.qingLayout.openDetails()),
    [sessionId, props.qingLayout],
  )

  const docs = snapshot.state?.docs ?? []
  const activeEngineSessionId = snapshot.activeEngineSessionId
    ?? snapshot.state?.binding.activeEngineSessionId
  const activeBound = docs.find((doc) => doc.engineSessionId === activeEngineSessionId)
  const observedVersion = snapshot.activeDoc?.docVersion ?? activeBound?.docVersion
  const observedState = snapshot.activeDoc?.state ?? activeBound?.state

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
    saveCoordinatorRef.current?.dispose()
    saveCoordinatorRef.current = null
    if (!activeEngineSessionId) return
    const coordinator = new DocumentSaveCoordinator({
      send: (request) => qingClientStore.replaceDocument(sessionId, activeEngineSessionId, request),
      onCommitted: (doc, response) => {
        qingClientStore.applySavedDocument(sessionId, activeEngineSessionId, doc, response)
      },
      onStateChange: (state) => {
        qingClientStore.setSaveState(sessionId, state)
        if (state.kind === 'blocked') {
          void qingClientStore.refreshPanel(sessionId, activeEngineSessionId).catch(() => undefined)
        }
      },
    })
    saveCoordinatorRef.current = coordinator
    const retryOnline = () => coordinator.retryOnline()
    window.addEventListener('online', retryOnline)
    return () => {
      window.removeEventListener('online', retryOnline)
      coordinator.dispose()
      if (saveCoordinatorRef.current === coordinator) saveCoordinatorRef.current = null
    }
  }, [activeEngineSessionId, sessionId])

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
    measurePaper()
    const root = rootRef.current
    const observer = root && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measurePaper)
      : null
    if (root) observer?.observe(root)
    window.addEventListener('resize', measurePaper)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measurePaper)
    }
  }, [measurePaper])

  const panelDoc = snapshot.panelEngineSessionId === activeEngineSessionId
    ? snapshot.panelDoc
    : undefined
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
    if (!baseline || !saveCoordinatorRef.current) return Promise.resolve()
    return saveCoordinatorRef.current.enqueue(doc, baseline)
  }, [])

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
    if (!activeEngineSessionId || !panelDoc || reviewSubmitting) return
    setReviewSubmitting(true)
    try {
      await qingClientStore.reviewVerdict(sessionId, activeEngineSessionId, {
        expectedDocVersion: panelDoc.docVersion,
        patchId,
        verdict,
      })
      qingClientStore.applyReviewVerdict(sessionId, activeEngineSessionId, patchId, verdict)
      setToast(verdict === 'accepted' ? '已保留这处改动' : '已取消这处改动')
    } catch (error) {
      console.error('[qingagent-panel] review verdict failed', error)
      setToast('操作失败 · 请重试')
      void qingClientStore.refreshPanel(sessionId, activeEngineSessionId).catch(() => undefined)
    } finally {
      setReviewSubmitting(false)
    }
  }, [activeEngineSessionId, panelDoc, reviewSubmitting, sessionId])

  const handleReviewCommit = useCallback(async (
    action: 'commit' | 'accept_all' | 'reject_all',
  ) => {
    if (!activeEngineSessionId || !panelDoc || reviewSubmitting) return
    setReviewSubmitting(true)
    try {
      await qingClientStore.reviewCommit(sessionId, activeEngineSessionId, {
        expectedDocVersion: panelDoc.docVersion,
        action,
      })
      setToast(action === 'reject_all' ? '已放弃本轮修改' : '修改已提交')
      await Promise.all([
        qingClientStore.refreshDoc(sessionId, activeEngineSessionId),
        qingClientStore.refreshPanel(sessionId, activeEngineSessionId),
      ])
    } catch (error) {
      console.error('[qingagent-panel] review commit failed', error)
      autoCommitKeyRef.current = null
      setToast('提交失败 · 候选已保留，请重试')
      void qingClientStore.refreshPanel(sessionId, activeEngineSessionId).catch(() => undefined)
    } finally {
      setReviewSubmitting(false)
    }
  }, [activeEngineSessionId, panelDoc, reviewSubmitting, sessionId])

  const reviewStatusKey = snapshot.reviewModel?.suggestions
    .map((suggestion) => `${suggestion.id}:${suggestion.status}`)
    .join('|') ?? ''
  useEffect(() => {
    const suggestions = snapshot.reviewModel?.suggestions ?? []
    if (!pendingReview || suggestions.length === 0) {
      autoCommitKeyRef.current = null
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

  const reviewCount = reviewPresentation
    ? visibleReviewTargets.length
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
              onChange={(event) => void qingClientStore.focus(sessionId, event.currentTarget.value)}
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
            onClick={() => props.qingLayout.closeDetails()}
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
                remainingCount={visibleReviewTargets.length}
                totalCount={visibleReviewTargets.length}
                activePatchIndex={activeReviewTargetId
                  ? visibleReviewTargetIds.indexOf(activeReviewTargetId)
                  : -1}
                isSubmitting={reviewSubmitting}
                unrenderableOnly={visibleReviewTargets.length === 0}
                onJumpPrev={() => jumpReview(-1)}
                onJumpNext={() => jumpReview(1)}
                onRejectAll={() => { void handleReviewCommit('reject_all') }}
                onCommit={() => handleReviewCommit('commit')}
              />
            ) : null}
            <DocumentSnapshotView
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
