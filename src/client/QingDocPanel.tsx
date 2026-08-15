import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { Editor } from '@tiptap/react'
import type { BridgeDocument } from '../contracts.js'
import {
  DocumentSnapshotView,
  type DocumentSnapshotViewHandle,
} from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import { DocFindBar } from '@qingweb/pages/workspace/components/DocFindBar'
import { DocToolbar } from '@qingweb/pages/workspace/components/DocToolbar'
import { PatchNav } from '@qingweb/pages/workspace/components/PatchNav'
import type { AiModifyTarget } from '@qingweb/pages/workspace/data/aiModifyTarget'
import type { DocDimensions } from '@qingweb/pages/workspace/data/docDimensions'
import {
  appliedDocWriteBaseline,
  EMPTY_PM_DOC,
  type DocWriteBaseline,
} from '@qingweb/pages/workspace/data/docWriteBaseline'
import { pmDocToViewDocumentSnapshot } from '@qingweb/pages/workspace/data/protocol'
import { canUseDocumentEditing } from '@qingweb/pages/workspace/data/reviewActions'
import { useWorkspaceFind } from '@qingweb/pages/workspace/hooks/useWorkspaceFind'
import type { PmDoc } from '@qingagent/pm-schema'
import {
  encodeAssetBridgeContext,
  type AssetBridgeContext,
} from '../assetBridge.js'
import { AssetBridgeProvider } from '../qingdoc/AssetBridgeProvider.js'
import { DocumentSaveCoordinator, type DocumentSaveState } from './documentSaveCoordinator.js'
import { createQingmlCompileThrottle, type QingmlCompileThrottle } from './streamingDocument.js'
import { buildReviewPresentationModel } from './reviewPresentation.js'
import { installDetailsColumnWidth } from './detailsWidth.js'
import { decideIncomingPanelDocument } from './incomingPanelDocument.js'
import { QINGJIAN_ICON_DATA_URI } from './qingjianIcon.js'
import { BridgeHttpError, qingClientStore } from './store.js'
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
  const [showSavingStatus, setShowSavingStatus] = useState(false)
  const [streamingPmDoc, setStreamingPmDoc] = useState<PmDoc | null>(null)
  const [activeReviewTargetId, setActiveReviewTargetId] = useState<string | null>(null)
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [reviewSettlementRetryPending, setReviewSettlementRetryPending] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const docViewRef = useRef<DocumentSnapshotViewHandle | null>(null)
  const lastDocViewHandleRef = useRef<DocumentSnapshotViewHandle | null>(null)
  const tiptapEditorRef = useRef<Editor | null>(null)
  const [tiptapEditor, setTiptapEditor] = useState<Editor | null>(null)
  const editorEngineSessionIdRef = useRef<string | null>(null)
  const saveCoordinatorRef = useRef<DocumentSaveCoordinator | null>(null)
  const compileThrottleRef = useRef<QingmlCompileThrottle | null>(null)
  const autoCommitKeyRef = useRef<string | null>(null)
  const reviewSubmittingRef = useRef(false)
  const reviewSettlementRetryPendingRef = useRef(false)
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

  const handleEditorReady = useCallback((editor: Editor | null) => {
    tiptapEditorRef.current = editor
    setTiptapEditor(editor)
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
      // 冲突态只封锁冲突那一篇;切到别的文稿必须照常刷新,否则跨稿传染成白纸。
      if (
        currentSnapshot.saveState?.kind === 'conflict'
        && currentSnapshot.saveState.engineSessionId === engineSessionId
      ) return false
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
        qingClientStore.setSaveState(sessionId, {
          kind: 'conflict',
          engineSessionId,
          expected,
          actual,
          message,
        })
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
    const mutationObserver = root && !root.querySelector('.wf-doc') && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          const renderedPaper = root.querySelector<HTMLElement>('.wf-doc')
          if (!renderedPaper) return
          observer?.observe(renderedPaper)
          measurePaper()
          mutationObserver?.disconnect()
        })
      : null
    if (root) mutationObserver?.observe(root, { childList: true, subtree: true })
    window.addEventListener('resize', measurePaper)
    // 位置漂移哨兵:dsh 三栏布局里聊天栏/侧栏变化会平移面板而不改任何元素尺寸,
    // ResizeObserver/resize 全部失聪,--doc-left/right 变陈旧,审阅条/查找条按过期
    // 坐标越出纸面。定期对比纸面真实矩形,漂移即重测。
    const driftTimer = window.setInterval(() => {
      const currentRoot = rootRef.current
      const currentPaper = currentRoot?.querySelector<HTMLElement>('.wf-doc')
        ?? currentRoot?.querySelector<HTMLElement>('.ws-paper-shell')
      if (!currentRoot || !currentPaper) return
      const rect = currentPaper.getBoundingClientRect()
      const cachedLeft = Number.parseFloat(currentRoot.style.getPropertyValue('--doc-left'))
      const cachedRight = Number.parseFloat(currentRoot.style.getPropertyValue('--doc-right'))
      if (!Number.isFinite(cachedLeft) || Math.abs(cachedLeft - rect.left) > 0.5
        || !Number.isFinite(cachedRight) || Math.abs(cachedRight - rect.right) > 0.5) {
        measurePaper()
      }
    }, 400)
    return () => {
      cancelAnimationFrame(raf1)
      observer?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', measurePaper)
      window.clearInterval(driftTimer)
    }
  }, [measurePaper, snapshot.panelDoc, snapshot.reviewModel, snapshot.streaming, activeEngineSessionId])

  const panelDoc = snapshot.panelEngineSessionId === activeEngineSessionId
    ? snapshot.panelDoc
    : undefined
  if (panelDoc && activeEngineSessionId) editorEngineSessionIdRef.current = activeEngineSessionId
  // 审阅展示只认 PM 面板域；activeDoc/activeBound 是旧状态通道，可能晚于 commit 回执。
  const pendingReview = Boolean(panelDoc && (
    panelDoc.state === 'pendingReview' || snapshot.reviewModel !== undefined
  ))
  const busy = snapshot.streaming || panelDoc?.agentBusy === true || activeBound?.agentBusy === true
  // 冲突态按文稿隔离:别的文稿的冲突不影响当前稿的编辑与状态显示。
  const rawSaveState = snapshot.saveState ?? ({ kind: 'idle' } satisfies DocumentSaveState)
  const saveState: DocumentSaveState =
    rawSaveState.kind === 'conflict' && rawSaveState.engineSessionId !== activeEngineSessionId
      ? { kind: 'idle' }
      : rawSaveState
  useEffect(() => {
    if (saveState.kind !== 'saving') {
      setShowSavingStatus(false)
      return
    }
    const timer = window.setTimeout(() => setShowSavingStatus(true), 500)
    return () => window.clearTimeout(timer)
  }, [saveState.kind])
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
  const assetContext = useMemo<AssetBridgeContext | null>(
    () => activeEngineSessionId ? { dshSessionId: sessionId, engineSessionId: activeEngineSessionId } : null,
    [activeEngineSessionId, sessionId],
  )
  const assetSessionId = useMemo(
    () => assetContext ? encodeAssetBridgeContext(assetContext) : undefined,
    [assetContext],
  )
  const handleEditorChange = useCallback((doc: PmDoc, baseline?: DocWriteBaseline) => {
    const engineSessionId = editorEngineSessionIdRef.current
    if (!baseline || !engineSessionId || !saveCoordinatorRef.current) return Promise.resolve()
    return saveCoordinatorRef.current.enqueue(engineSessionId, doc, baseline)
  }, [])

  const handleAiModify = useCallback(async (target: AiModifyTarget): Promise<boolean> => {
    const editor = tiptapEditorRef.current
    if (
      !activeEngineSessionId ||
      !editor ||
      target.from === undefined ||
      target.to === undefined ||
      target.to <= target.from
    ) {
      setToast('请先选中要修改的文字')
      return false
    }
    const quote = editor.state.doc.textBetween(target.from, target.to, '\n', '').trim()
    if (!quote) {
      setToast('请先选中要修改的文字')
      return false
    }
    try {
      await flushPendingDocSave()
      await qingClientStore.setSelection(sessionId, activeEngineSessionId, quote, {
        blockId: target.blockId,
        from: target.from,
        to: target.to,
      })
      setToast('选段已加入输入框')
      return true
    } catch (error) {
      console.error('[qingagent-panel] selection bridge failed', error)
      setToast('选段加入失败 · 请重试')
      return false
    }
  }, [activeEngineSessionId, flushPendingDocSave, sessionId])

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

  const reviewStatusKey = snapshot.reviewModel?.suggestions
    .map((suggestion) => `${suggestion.id}:${suggestion.status}`)
    .join('|') ?? ''
  const reviewCommitKey = `${activeEngineSessionId ?? ''}:${panelDoc?.docVersion ?? -1}:${reviewStatusKey}`

  const handleReviewCommit = useCallback(async (
    action: 'commit' | 'accept_all' | 'reject_all',
    source: 'manual' | 'auto' = 'manual',
  ) => {
    if (!activeEngineSessionId || !panelDoc) return
    if (action === 'commit' && autoCommitKeyRef.current === reviewCommitKey) {
      if (source === 'auto' || !reviewSettlementRetryPendingRef.current) return
    }
    if (reviewSubmittingRef.current) {
      setToast('操作处理中 · 请稍候')
      return
    }
    if (action === 'commit') {
      autoCommitKeyRef.current = reviewCommitKey
      reviewSettlementRetryPendingRef.current = false
      setReviewSettlementRetryPending(false)
    }
    reviewSubmittingRef.current = true
    setReviewSubmitting(true)
    const settleAsSuccess = async (docVersion: number, refreshDoc: boolean) => {
      qingClientStore.applyReviewCommit(sessionId, activeEngineSessionId, docVersion)
      reviewSettlementRetryPendingRef.current = false
      setReviewSettlementRetryPending(false)
      setToast(action === 'reject_all' ? '已放弃本轮修改' : '修改已提交')
      const refreshPanel = async () => {
        await qingClientStore.refreshPanel(sessionId, activeEngineSessionId)
        const refreshed = qingClientStore.getSnapshot(sessionId)
        if (
          refreshed.panelEngineSessionId === activeEngineSessionId &&
          refreshed.panelDoc?.state === 'pendingReview' &&
          refreshed.reviewModel?.suggestions.length === 0
        ) {
          await wait(500)
          await qingClientStore.refreshPanel(sessionId, activeEngineSessionId)
        }
      }
      const refreshes = [refreshPanel()]
      if (refreshDoc) refreshes.push(qingClientStore.refreshDoc(sessionId, activeEngineSessionId).then(() => undefined))
      const results = await Promise.allSettled(refreshes)
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn('[qingagent-panel] review settlement refresh failed', result.reason)
        }
      }
    }
    try {
      const response = await qingClientStore.reviewCommit(sessionId, activeEngineSessionId, {
        expectedDocVersion: panelDoc.docVersion,
        action,
      })
      await settleAsSuccess(response.docVersion, true)
    } catch (error) {
      if (error instanceof BridgeHttpError && error.status === 409) {
        try {
          const authoritativeDoc = await qingClientStore.refreshDoc(sessionId, activeEngineSessionId)
          if (authoritativeDoc.state !== 'pendingReview') {
            await settleAsSuccess(authoritativeDoc.docVersion, false)
            return
          }
        } catch (probeError) {
          console.warn('[qingagent-panel] review commit conflict probe failed', probeError)
        }
      }
      console.error('[qingagent-panel] review commit failed', error)
      if (action === 'commit') {
        reviewSettlementRetryPendingRef.current = true
        setReviewSettlementRetryPending(true)
      }
      setToast('提交失败 · 候选已保留，请重试')
      void qingClientStore.refreshPanel(sessionId, activeEngineSessionId).catch(() => undefined)
    } finally {
      reviewSubmittingRef.current = false
      setReviewSubmitting(false)
    }
  }, [activeEngineSessionId, panelDoc, reviewCommitKey, sessionId])

  useEffect(() => {
    const suggestions = snapshot.reviewModel?.suggestions ?? []
    if (!pendingReview) {
      reviewSettlementRetryPendingRef.current = false
      setReviewSettlementRetryPending(false)
      return
    }
    if (suggestions.length === 0) return
    if (reviewSubmitting || suggestions.some((suggestion) => suggestion.status === 'reviewing')) return
    void handleReviewCommit('commit', 'auto')
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
  const statusLabel = panelStatus({
    busy,
    blocks: snapshot.blocks,
    words: snapshot.words,
    pendingReview,
    reviewCount,
    saveState,
    showSaving: showSavingStatus,
  })
  const openUrl = activeEngineSessionId
    ? `qingjian://open?engineSessionId=${encodeURIComponent(activeEngineSessionId)}`
    : undefined
  const contentKind = pendingReview ? 'pendingReview' : panelDoc?.state === 'empty' ? 'empty' : 'editable'

  const docDimensions = useMemo<DocDimensions>(() => ({
    content: { kind: contentKind === 'editable' ? 'editing' : contentKind },
    agentBusy: busy,
    overlay: null,
    editor: busy || saveLocked
      ? 'locked'
      : pendingReview
        ? 'pendingReview'
        : panelDoc?.state === 'editing'
          ? 'editable'
          : 'empty',
  }), [busy, contentKind, panelDoc?.state, pendingReview, saveLocked])
  const documentEditingActive = canUseDocumentEditing(docDimensions, null, null)
  const {
    findInitialQuery,
    findMode,
    findOpen,
    setFindInitialQuery,
    setFindOpen,
  } = useWorkspaceFind({
    dim: docDimensions,
    viewingVersion: null,
    presentationRun: null,
    editorRef: tiptapEditorRef,
  })

  const rootStyle = {
    '--ws-paper-body-padding-inline': '40px',
    '--ws-paper-chat-column-width': '400px',
    '--ws-paper-column-gap': '48px',
    '--ws-paper-column-width': '800px',
    '--ws-paper-top-offset': '0px',
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
        tabIndex={0}
        aria-label="调整青简文档栏宽度"
        aria-orientation="vertical"
        aria-valuemin={420}
      />
      <header className="qingdoc-stage-controls">
        <div className="qingdoc-heading">
          <span className="qingdoc-brand">青简</span>
          <QingDocSwitcher
            docs={docs}
            activeEngineSessionId={activeEngineSessionId}
            title={title}
            activeBusy={busy}
            activePendingReview={pendingReview}
            onSelect={handleFocusDocument}
          />
          <span className="qingdoc-status" data-kind={saveState.kind} role="status">{toast ?? statusLabel}</span>
          {saveState.kind === 'conflict' && activeEngineSessionId ? (
            <button
              type="button"
              className="qingdoc-conflict-reload"
              title="文档已被更新，重载服务器版本后继续编辑"
              onClick={() => { void qingClientStore.resolveConflictByReload(sessionId, activeEngineSessionId) }}
            >重载</button>
          ) : null}
        </div>
        <div className="qingdoc-host-actions">
          {activeEngineSessionId ? (
            <a
              className="qingdoc-open"
              href={`qingjian://open?engineSessionId=${encodeURIComponent(activeEngineSessionId)}`}
            >在青简<img className="qingdoc-open-icon" src={QINGJIAN_ICON_DATA_URI} alt="" />中打开 ↗</a>
          ) : null}
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
            <AssetBridgeProvider context={assetContext}>
              <DocumentSnapshotView
                key={`${assetSessionId ?? 'empty'}:${snapshot.panelReloadNonce ?? 0}`}
                ref={setDocViewHandle}
                doc={surfaceDoc}
                docId={assetSessionId ?? `dsh:${sessionId}:empty`}
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
                onEditorReady={handleEditorReady}
                onEditorChange={interactiveEditable ? handleEditorChange : undefined}
                onAiModify={handleAiModify}
                onToast={setToast}
              />
            </AssetBridgeProvider>
            {findOpen && findMode !== 'hidden' ? (
              <DocFindBar
                editor={tiptapEditor}
                mode={findMode}
                docVersion={surfaceVersion}
                initialQuery={findInitialQuery}
                scrollContainerSelector="[data-qingagent-doc-panel] .ws-right"
                onClose={() => {
                  setFindOpen(false)
                  setFindInitialQuery('')
                }}
                onToast={setToast}
              />
            ) : null}
            <DocToolbar
              active={documentEditingActive}
              editor={tiptapEditor}
              containerSelector="[data-qingagent-doc-panel] .ws-right"
              onAiModify={handleAiModify}
              onToast={setToast}
              sessionId={assetSessionId}
            />
          </div>
        </main>
      </div>
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
    </section>
  )
}

interface QingDocSwitcherProps {
  docs: BridgeDocument[]
  activeEngineSessionId?: string
  title: string
  activeBusy: boolean
  activePendingReview: boolean
  onSelect: (engineSessionId: string) => Promise<void>
}

function QingDocSwitcher(props: QingDocSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const activeIndex = Math.max(0, props.docs.findIndex(
    (doc) => doc.engineSessionId === props.activeEngineSessionId,
  ))

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const handleOutsidePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('mousedown', handleOutsidePointer)
    return () => document.removeEventListener('mousedown', handleOutsidePointer)
  }, [close, open])

  useEffect(() => {
    if (open) setFocusedIndex(activeIndex)
  }, [activeIndex, open])

  const selectAt = useCallback((index: number) => {
    const doc = props.docs[index]
    if (!doc) return
    close(true)
    if (doc.engineSessionId !== props.activeEngineSessionId) void props.onSelect(doc.engineSessionId)
  }, [close, props])

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!props.docs.length) return
      if (!open) {
        setOpen(true)
        setFocusedIndex(activeIndex)
        return
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setFocusedIndex((index) => (index + delta + props.docs.length) % props.docs.length)
      return
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault()
      selectAt(focusedIndex)
    }
  }

  return (
    <div ref={rootRef} className="qingdoc-doc-switcher" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        className="qingdoc-doc-trigger"
        type="button"
        aria-label="切换青简文稿"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <strong className="qingdoc-stage-title" title={props.title}>{props.title}</strong>
        <span className="qingdoc-doc-chevron" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div id={listboxId} className="qingdoc-doc-menu" role="listbox" aria-label="本会话文稿">
          {props.docs.map((doc, index) => {
            const current = doc.engineSessionId === props.activeEngineSessionId
            const status = documentActivity(doc, current, props.activeBusy, props.activePendingReview)
            return (
              <button
                key={doc.engineSessionId}
                className="qingdoc-doc-option"
                type="button"
                role="option"
                aria-selected={current}
                aria-label={`${doc.title}${status === 'writing' ? '，写作中' : status === 'reviewing' ? '，审阅中' : ''}`}
                data-focused={focusedIndex === index ? 'true' : undefined}
                onMouseEnter={() => setFocusedIndex(index)}
                onClick={() => selectAt(index)}
              >
                <span className="qingdoc-doc-mark" aria-hidden="true">
                  {current ? (
                    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                      <path d="M2.5 6.5 L5 9 L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </span>
                <span className="qingdoc-doc-option-title">{doc.title}</span>
                {status !== 'idle' ? (
                  <span className="qingdoc-doc-state-label" aria-hidden="true">
                    {status === 'writing' ? '写作中' : '审阅中'}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function documentActivity(
  doc: BridgeDocument,
  current: boolean,
  activeBusy: boolean,
  activePendingReview: boolean,
): 'idle' | 'writing' | 'reviewing' {
  if (doc.state === 'pendingReview' || (current && activePendingReview)) return 'reviewing'
  if (doc.agentBusy === true || (current && activeBusy)) return 'writing'
  return 'idle'
}

function reviewTargetSelector(targetId: string): string {
  const escape = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape
    : (value: string) => value.replace(/["\\]/g, '\\$&')
  return `[data-review-target-id="${escape(targetId)}"],[data-patch-id="${escape(targetId)}"]:not(.wf-patch-del)`
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function panelStatus(input: {
  busy: boolean
  blocks: number
  words: number
  pendingReview: boolean
  reviewCount: number
  saveState: DocumentSaveState
  showSaving: boolean
}): string {
  if (input.pendingReview) return `审阅中·${input.reviewCount}处`
  // 「块」是内部概念不暴露给用户;没有字数时只说「写作中」,不出现「约 0 字」。
  if (input.busy) return input.words > 0 ? `写作中 · 约${input.words}字` : '写作中'
  if (input.saveState.kind === 'saving') return input.showSaving ? '保存中…' : ''
  if (input.saveState.kind === 'conflict') return '保存冲突·已暂停编辑'
  if (input.saveState.kind === 'blocked') {
    return input.saveState.code === 'AGENT_BUSY' ? '青简处理中' : `审阅中·${input.reviewCount}处`
  }
  if (input.saveState.kind === 'error') return input.saveState.transient ? '网络不稳·等待重存' : '保存失败'
  return ''
}
