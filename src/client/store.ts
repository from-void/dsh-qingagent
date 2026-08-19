import type {
  BridgeEvent,
  BridgeState,
  ExternalAnnotationIgnoreRequest,
  ExternalAnnotationIgnoreResponse,
  ExternalDoc,
  ExternalDocReplaceRequest,
  ExternalDocReplaceResponse,
  ExternalErrorResponse,
  ExternalPmDocReadResponse,
  ExternalReviewCommitPanelRequest,
  ExternalReviewCommitResponse,
  ExternalReviewRenderModelResponse,
  ExternalReviewVerdictRequest,
  ExternalReviewVerdictResponse,
  PmDoc,
  QingSelection,
  QingSelectionAnchor,
} from '../contracts.js'
import { appliedDocWriteBaseline } from '@qingweb/pages/workspace/data/docWriteBaseline'
import { countDocVisibleChars } from '@qingagent/pm-schema'
import type { DocumentSaveState } from './documentSaveCoordinator.js'
import { compileQingmlDocument } from '../qingmlCompile.js'

export interface QingClientSnapshot {
  state?: BridgeState
  activeEngineSessionId?: string
  activeDoc?: ExternalDoc
  blocks: number
  words: number
  bindingCount: number
  reviewCount?: number
  /** 直写落库后的一次性纸面逐字入场请求。 */
  revealRequest?: { engineSessionId: string; docVersion: number; nonce: number }
  panelEngineSessionId?: string
  panelDoc?: ExternalPmDocReadResponse
  reviewModel?: ExternalReviewRenderModelResponse
  panelLoading?: boolean
  /** external 明确确认不存在的文稿集合；按文稿 ID 持久排除，读回成功时逐篇恢复。 */
  docMissing?: { engineSessionIds: string[] }
  /** 「重载」等显式放弃本地内容的操作递增它,面板据此强制重挂编辑器。 */
  panelReloadNonce?: number
  saveState?: DocumentSaveState
  /** 冲突态按文稿分槽持久保存;saveState 单槽只承载瞬态,避免另一稿保存成功把冲突顶掉(评测 t14)。 */
  conflicts?: Record<string, { expected: number; actual: number; message: string }>
  /** 冲突稿本地内容快照(切走前抓取,切回恢复;评测 P11「切换往返丢内容落 v0 空白」,K3 定案)。 */
  conflictStash?: Record<string, PmDoc>
  selection?: QingSelection
  error?: string
}

export type CurrentReviewState = 'pending' | 'settled' | 'unknown'

const ACTIVE_REVIEW_STATUSES = new Set(['reviewing', 'accepted', 'rejected'])

function matchesLoadedPanel(
  snapshot: QingClientSnapshot,
  engineSessionId: string | undefined,
): boolean {
  return Boolean(
    engineSessionId &&
    snapshot.panelEngineSessionId === engineSessionId &&
    snapshot.panelDoc,
  )
}

function isActivePatchSuggestion(suggestion: ExternalReviewRenderModelResponse['suggestions'][number]): boolean {
  return suggestion.kind !== 'annotation' && ACTIVE_REVIEW_STATUSES.has(suggestion.status)
}

/**
 * 工具卡只把 meta 冻结的 patchIds 与当前 render-model 精确对表；文稿相同但批次
 * 不同不能推断旧卡结局。逐条表态但尚未 commit 的 accepted/rejected 仍属待审。
 */
export function currentReviewStateFor(
  snapshot: QingClientSnapshot,
  engineSessionId: string | undefined,
  patchIds: readonly string[] | undefined,
): CurrentReviewState {
  if (!matchesLoadedPanel(snapshot, engineSessionId) || !patchIds?.length) return 'unknown'
  const hasBatchPatch = Boolean(snapshot.reviewModel?.suggestions.some((suggestion) =>
    isActivePatchSuggestion(suggestion) && patchIds.includes(suggestion.id)))
  if (hasBatchPatch) return 'pending'
  return snapshot.panelDoc?.state === 'pendingReview' ? 'unknown' : 'settled'
}

/** 面板描述当前文稿而非历史工具事件，因此继续按当前 PM/render-model 判定。 */
export function currentPanelReviewStateFor(
  snapshot: QingClientSnapshot,
  engineSessionId: string | undefined,
): CurrentReviewState {
  if (!matchesLoadedPanel(snapshot, engineSessionId)) return 'unknown'
  const hasPatchReview = Boolean(snapshot.reviewModel?.suggestions.some(isActivePatchSuggestion))
  return snapshot.panelDoc?.state === 'pendingReview' || hasPatchReview ? 'pending' : 'settled'
}

interface SessionEntry {
  sessionId: string
  snapshot: QingClientSnapshot
  listeners: Set<() => void>
  source?: EventSource
  refs: number
  /** 用户点 × 显式关闭面板;新内容事件或「查看」重开时清除。关闭位跟随会话(localStorage 持久化+跨 tab 同步)。 */
  panelClosed?: boolean
  openers: Set<() => void>
  loading?: Promise<void>
  panelLoadToken: number
  panelRefreshGuard?: PanelRefreshGuard
  revealNonce: number
  busyFallbackTimer?: ReturnType<typeof setTimeout>
  busyFallbackEngineSessionId?: string
  busyFallbackAttemptedEngineSessionId?: string
}

export interface QingLibraryDoc {
  engineSessionId: string
  title: string
  state: string
  updatedAt: string
}

export interface PanelRefreshGuard {
  beforeApply(engineSessionId: string, panelDoc: ExternalPmDocReadResponse): Promise<boolean>
  afterApply?(engineSessionId: string, panelDoc: ExternalPmDocReadResponse): void
}

const EMPTY: QingClientSnapshot = {
  blocks: 0,
  words: 0,
  bindingCount: 0,
}

const PANEL_CLOSED_KEY_PREFIX = 'qingagent.panelClosed.'
const BRIDGE_RECONNECTING_ERROR = '与青简桥的实时连接暂时中断，浏览器会自动重连。'
export const PANEL_BUSY_REFRESH_DELAY_MS = 90_000

function readStoredPanelClosed(sessionId: string): boolean {
  try {
    return window.localStorage.getItem(PANEL_CLOSED_KEY_PREFIX + sessionId) === '1'
  } catch {
    return false
  }
}

function writeStoredPanelClosed(sessionId: string, closed: boolean): void {
  try {
    if (closed) window.localStorage.setItem(PANEL_CLOSED_KEY_PREFIX + sessionId, '1')
    else window.localStorage.removeItem(PANEL_CLOSED_KEY_PREFIX + sessionId)
  } catch {
    // 存储不可用时退化为纯内存关闭位。
  }
}

export class QingClientStore {
  private readonly entries = new Map<string, SessionEntry>()

  constructor() {
    // P21:关闭位跟随会话——别的 tab 关/开面板经 storage 事件同步过来,防跨 tab 自动重开。
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (!event.key?.startsWith(PANEL_CLOSED_KEY_PREFIX)) return
        const sessionId = event.key.slice(PANEL_CLOSED_KEY_PREFIX.length)
        const entry = this.entries.get(sessionId)
        if (!entry) return
        const closed = event.newValue === '1'
        if (Boolean(entry.panelClosed) === closed) return
        entry.panelClosed = closed || undefined
        this.update(entry, entry.snapshot)
      })
    }
  }

  getSnapshot(sessionId: string): QingClientSnapshot {
    return this.entries.get(sessionId)?.snapshot ?? EMPTY
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const entry = this.entry(sessionId)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  hasPanelContent(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    if (entry?.panelClosed) return false
    const snapshot = this.getSnapshot(sessionId)
    return snapshot.bindingCount > 0
      || (snapshot.state !== undefined && snapshot.state.engine.state !== 'online')
  }

  /** × 关闭:dsh 详情列显隐由插槽注册决定,layout.closeDetails 对它无效;这里置关闭位驱动注销。 */
  closePanel(sessionId: string): void {
    const entry = this.entry(sessionId)
    entry.panelClosed = true
    writeStoredPanelClosed(sessionId, true)
    this.update(entry, entry.snapshot)
  }

  /** P11:切走冲突/脏稿前抓本地内容快照,切回时优先恢复而非重拉。 */
  stashConflictDoc(sessionId: string, engineSessionId: string, doc: PmDoc): void {
    const entry = this.entry(sessionId)
    this.update(entry, {
      ...entry.snapshot,
      conflictStash: { ...entry.snapshot.conflictStash, [engineSessionId]: doc },
    })
  }

  /** 「查看」等显式重开入口。 */
  reopenPanel(sessionId: string): void {
    const entry = this.entry(sessionId)
    if (!entry.panelClosed) return
    entry.panelClosed = false
    writeStoredPanelClosed(sessionId, false)
    this.update(entry, entry.snapshot)
  }

  finishReveal(sessionId: string, nonce: number): void {
    const entry = this.entry(sessionId)
    const revealRequest = entry.snapshot.revealRequest
    if (revealRequest?.nonce !== nonce) return
    this.update(entry, { ...entry.snapshot, revealRequest: undefined })
    // reveal 只播放已落库内容；播放完仍须重拉一次，不能把播放开始时的 busy 缓存当终态。
    void this.refreshPanel(sessionId, revealRequest.engineSessionId).catch(() => undefined)
  }

  retain(sessionId: string, openDetails?: () => void): () => void {
    const entry = this.entry(sessionId)
    entry.refs += 1
    if (openDetails) entry.openers.add(openDetails)
    if (!entry.source) this.connect(sessionId, entry)
    this.syncBusyFallback(entry)
    void this.loadState(sessionId, entry)
    return () => {
      entry.refs = Math.max(0, entry.refs - 1)
      if (openDetails) entry.openers.delete(openDetails)
      if (entry.refs === 0) {
        entry.source?.close()
        entry.source = undefined
        this.clearBusyFallback(entry, true)
      }
    }
  }

  registerPanelRefreshGuard(sessionId: string, guard: PanelRefreshGuard): () => void {
    const entry = this.entry(sessionId)
    entry.panelRefreshGuard = guard
    return () => {
      if (entry.panelRefreshGuard === guard) entry.panelRefreshGuard = undefined
    }
  }

  async focus(
    sessionId: string,
    engineSessionId: string,
    options?: { adopt?: boolean; title?: string },
  ): Promise<void> {
    const response = await fetch('/qingagent-bridge/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dshSessionId: sessionId,
        engineSessionId,
        ...(options?.adopt ? { adopt: true, title: options.title } : {}),
      }),
    })
    if (!response.ok) throw new Error(await responseError(response))
    const entry = this.entry(sessionId)
    this.update(entry, {
      ...entry.snapshot,
      activeEngineSessionId: engineSessionId,
      panelEngineSessionId: undefined,
      panelDoc: undefined,
      reviewModel: undefined,
      revealRequest: undefined,
      panelLoading: true,
    })
    void this.refreshPanel(sessionId, engineSessionId)
  }

  /** 导出当前文稿:走桥接代理引擎导出接口,返回文件字节与降级说明。 */
  async exportDoc(
    sessionId: string,
    engineSessionId: string,
    format: string,
  ): Promise<{ blob: Blob; degradations?: string }> {
    const query = new URLSearchParams({ dshSessionId: sessionId, engineSessionId, format })
    const response = await fetch(`/qingagent-bridge/export?${query}`)
    if (response.status === 409) throw new Error('还没有可导出的内容')
    if (!response.ok) throw new Error(await responseError(response))
    return {
      blob: await response.blob(),
      degradations: response.headers.get('X-Qingagent-Export-Degradations') ?? undefined,
    }
  }

  /** 青简文库:引擎最近更新的文稿列表(含其他会话的),下拉「最近文稿」分组用。 */
  async loadLibrary(sessionId: string, limit = 25): Promise<QingLibraryDoc[]> {
    const query = new URLSearchParams({ dshSessionId: sessionId, limit: String(limit) })
    const result = await bridgeJson<{ library: QingLibraryDoc[] }>(`/qingagent-bridge/library?${query}`)
    return result.library
  }

  async setSelection(
    sessionId: string,
    engineSessionId: string,
    quote: string,
    anchor: QingSelectionAnchor,
  ): Promise<QingSelection> {
    const result = await bridgeJson<{ selection: QingSelection }>('/qingagent-bridge/selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dshSessionId: sessionId, engineSessionId, quote, anchor }),
    })
    const entry = this.entry(sessionId)
    this.update(entry, { ...entry.snapshot, selection: result.selection })
    return result.selection
  }

  async clearSelection(sessionId: string): Promise<void> {
    const entry = this.entry(sessionId)
    this.update(entry, { ...entry.snapshot, selection: undefined })
    const query = new URLSearchParams({ dshSessionId: sessionId })
    await bridgeJson<{ ok: true }>(`/qingagent-bridge/selection?${query}`, { method: 'DELETE' })
  }

  async refreshDoc(sessionId: string, engineSessionId: string): Promise<ExternalDoc> {
    const entry = this.entry(sessionId)
    const query = new URLSearchParams({ dshSessionId: sessionId, engineSessionId })
    const response = await fetch(`/qingagent-bridge/doc?${query}`)
    if (!response.ok) throw new Error(await responseError(response))
    const doc = await response.json() as ExternalDoc
    this.update(entry, {
      ...entry.snapshot,
      activeEngineSessionId: engineSessionId,
      activeDoc: doc,
      reviewCount: doc.state === 'pendingReview' ? entry.snapshot.reviewCount : undefined,
      error: undefined,
    })
    return doc
  }

  async refreshPanel(
    sessionId: string,
    engineSessionId: string,
    options?: { bypassGuard?: boolean },
  ): Promise<void> {
    const entry = this.entry(sessionId)
    const token = ++entry.panelLoadToken
    const switching = entry.snapshot.panelEngineSessionId !== engineSessionId
    this.update(entry, {
      ...entry.snapshot,
      activeEngineSessionId: engineSessionId,
      ...(switching ? { panelDoc: undefined, reviewModel: undefined } : {}),
      panelLoading: true,
      error: undefined,
    })
    try {
      const panelDoc = await bridgeJson<ExternalPmDocReadResponse>(
        panelUrl('/qingagent-bridge/doc-pm', sessionId, engineSessionId),
      )
      const reviewModelRequest = bridgeJson<ExternalReviewRenderModelResponse>(
        panelUrl('/qingagent-bridge/review-render-model', sessionId, engineSessionId),
      )
      // 批注不进入 pendingReview；编辑态也必须读 render-model。旧引擎或旧测试桥没有该
      // 能力时仅把批注视为空，不能连带阻断正文 PM 的加载。
      const reviewModel = panelDoc.state === 'pendingReview'
        ? await reviewModelRequest
        : await reviewModelRequest
            .then((model) => Array.isArray(model.suggestions) ? model : undefined)
            .catch(() => undefined)
      if (entry.panelLoadToken !== token) return
      // 冲突封锁按文稿隔离:只有当前刷新的正是冲突稿才跳过应用,换稿刷新照常。
      if (entry.snapshot.conflicts?.[engineSessionId]) {
        this.update(entry, {
          ...entry.snapshot,
          panelLoading: false,
          docMissing: removeMissingPanelDoc(entry.snapshot.docMissing, engineSessionId),
          error: undefined,
        })
        return
      }
      const shouldApply = options?.bypassGuard
        ? true
        : await (entry.panelRefreshGuard?.beforeApply(engineSessionId, panelDoc)
          ?? Promise.resolve(true))
      if (entry.panelLoadToken !== token) return
      if (!shouldApply) {
        this.update(entry, {
          ...entry.snapshot,
          panelLoading: false,
          docMissing: removeMissingPanelDoc(entry.snapshot.docMissing, engineSessionId),
          error: undefined,
        })
        return
      }
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: engineSessionId,
        panelEngineSessionId: engineSessionId,
        panelDoc,
        reviewModel,
        state: applyPanelDocToBridgeState(entry.snapshot.state, engineSessionId, panelDoc),
        activeDoc: applyPanelDocToActiveDoc(entry.snapshot.activeDoc, engineSessionId, panelDoc),
        blocks: panelDoc.pmDoc?.content?.length ?? entry.snapshot.blocks,
        words: panelDoc.charCount
          ?? (panelDoc.pmDoc ? countDocVisibleChars(panelDoc.pmDoc) : entry.snapshot.words),
        panelLoading: false,
        reviewCount: reviewModel
          ? reviewModel.suggestions.filter((suggestion) => suggestion.status === 'reviewing').length
          : undefined,
        saveState: refreshSaveState(entry.snapshot.saveState),
        docMissing: removeMissingPanelDoc(entry.snapshot.docMissing, engineSessionId),
        error: undefined,
      })
      entry.panelRefreshGuard?.afterApply?.(engineSessionId, panelDoc)
    } catch (error) {
      if (entry.panelLoadToken !== token) return
      if (isMissingPanelDocError(error)) {
        this.update(entry, {
          ...entry.snapshot,
          activeDoc: entry.snapshot.activeDoc?.sessionId === engineSessionId
            ? undefined
            : entry.snapshot.activeDoc,
          panelEngineSessionId: engineSessionId,
          panelDoc: undefined,
          reviewModel: undefined,
          reviewCount: undefined,
          panelLoading: false,
          docMissing: addMissingPanelDoc(entry.snapshot.docMissing, engineSessionId),
          error: undefined,
        })
      } else {
        this.update(entry, {
          ...entry.snapshot,
          panelLoading: false,
          error: BRIDGE_RECONNECTING_ERROR,
        })
      }
      throw error
    }
  }

  replaceDocument(
    sessionId: string,
    engineSessionId: string,
    request: ExternalDocReplaceRequest,
  ): Promise<ExternalDocReplaceResponse> {
    return bridgeJson(panelUrl('/qingagent-bridge/doc-pm', sessionId, engineSessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  reviewVerdict(
    sessionId: string,
    engineSessionId: string,
    request: ExternalReviewVerdictRequest,
  ): Promise<ExternalReviewVerdictResponse> {
    return bridgeJson(panelUrl('/qingagent-bridge/review-verdicts', sessionId, engineSessionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  reviewCommit(
    sessionId: string,
    engineSessionId: string,
    request: ExternalReviewCommitPanelRequest,
  ): Promise<ExternalReviewCommitResponse> {
    return bridgeJson(panelUrl('/qingagent-bridge/review-commit', sessionId, engineSessionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  setSaveState(sessionId: string, state: DocumentSaveState): void {
    const entry = this.entry(sessionId)
    const conflicts = state.kind === 'conflict'
      ? {
          ...entry.snapshot.conflicts,
          [state.engineSessionId]: { expected: state.expected, actual: state.actual, message: state.message },
        }
      : entry.snapshot.conflicts
    this.update(entry, { ...entry.snapshot, saveState: state, conflicts })
  }

  /** 青简同款「重载」出路:用户明确同意放弃本地未保存内容,拉服务器权威版本继续编辑。
   *  绕过刷新守卫(守卫的职责是保护本地未保存内容,重载正是对它的显式放弃),
   *  并递增 reloadNonce 强制编辑器重挂,确保纸面内容切到服务器版本。 */
  async resolveConflictByReload(sessionId: string, engineSessionId: string): Promise<void> {
    const entry = this.entry(sessionId)
    const conflicts = { ...entry.snapshot.conflicts }
    delete conflicts[engineSessionId]
    const conflictStash = { ...entry.snapshot.conflictStash }
    delete conflictStash[engineSessionId]
    this.update(entry, {
      ...entry.snapshot,
      saveState: { kind: 'idle' },
      conflicts,
      conflictStash,
      panelReloadNonce: (entry.snapshot.panelReloadNonce ?? 0) + 1,
    })
    await this.refreshPanel(sessionId, engineSessionId, { bypassGuard: true })
  }

  applySavedDocument(
    sessionId: string,
    engineSessionId: string,
    doc: PmDoc,
    response: Extract<ExternalDocReplaceResponse, { ok: true }>,
  ): void {
    const entry = this.entry(sessionId)
    if (entry.snapshot.panelEngineSessionId !== engineSessionId || !entry.snapshot.panelDoc) return
    const panelDoc: ExternalPmDocReadResponse = {
      ...entry.snapshot.panelDoc,
      docVersion: response.docVersion,
      contentHash: response.contentHash,
      ts: response.ts,
      state: 'editing',
      agentBusy: false,
      pmDoc: doc,
    }
    this.update(entry, {
      ...entry.snapshot,
      panelDoc,
      reviewModel: undefined,
      reviewCount: undefined,
    })
  }

  applyReviewVerdict(
    sessionId: string,
    engineSessionId: string,
    patchIds: readonly string[],
    verdict: 'accepted' | 'rejected',
  ): void {
    const entry = this.entry(sessionId)
    const model = entry.snapshot.reviewModel
    if (entry.snapshot.panelEngineSessionId !== engineSessionId || !model) return
    const reviewModel: ExternalReviewRenderModelResponse = {
      ...model,
      suggestions: model.suggestions.map((suggestion) =>
        patchIds.includes(suggestion.id) ? { ...suggestion, status: verdict } : suggestion),
    }
    this.update(entry, {
      ...entry.snapshot,
      reviewModel,
      reviewCount: reviewModel.suggestions.filter((suggestion) => suggestion.status === 'reviewing').length,
    })
  }

  async ignoreAnnotation(
    sessionId: string,
    engineSessionId: string,
    expectedDocVersion: number,
    annotationId: string,
  ): Promise<void> {
    const entry = this.entry(sessionId)
    const previous = entry.snapshot.reviewModel
    if (entry.snapshot.panelEngineSessionId !== engineSessionId || !previous?.annotations) return
    const reviewModel: ExternalReviewRenderModelResponse = {
      ...previous,
      annotations: previous.annotations.map((annotation) =>
        annotation.id === annotationId ? { ...annotation, status: 'ignored' } : annotation),
    }
    this.update(entry, { ...entry.snapshot, reviewModel })
    try {
      const body: ExternalAnnotationIgnoreRequest = {
        expectedDocVersion,
        annotationIds: [annotationId],
      }
      await bridgeJson<ExternalAnnotationIgnoreResponse>(
        panelUrl('/qingagent-bridge/review-annotations-ignore', sessionId, engineSessionId),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
    } catch (error) {
      if (entry.snapshot.reviewModel === reviewModel) {
        this.update(entry, { ...entry.snapshot, reviewModel: previous })
      }
      throw error
    }
  }

  applyReviewCommit(
    sessionId: string,
    engineSessionId: string,
    docVersion: number,
  ): void {
    const entry = this.entry(sessionId)
    if (entry.snapshot.panelEngineSessionId !== engineSessionId || !entry.snapshot.panelDoc) return
    const activeDoc = entry.snapshot.activeEngineSessionId === engineSessionId && entry.snapshot.activeDoc
      ? {
          ...entry.snapshot.activeDoc,
          docVersion,
          state: 'editing' as const,
          agentBusy: false,
        }
      : entry.snapshot.activeDoc
    this.update(entry, {
      ...entry.snapshot,
      activeDoc,
      panelDoc: {
        ...entry.snapshot.panelDoc,
        docVersion,
        state: 'editing',
        agentBusy: false,
      },
      reviewModel: undefined,
      reviewCount: undefined,
      saveState: refreshSaveState(entry.snapshot.saveState),
      error: undefined,
    })
  }

  private entry(sessionId: string): SessionEntry {
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = {
        sessionId,
        snapshot: EMPTY,
        listeners: new Set(),
        refs: 0,
        openers: new Set(),
        panelLoadToken: 0,
        revealNonce: 0,
        panelClosed: readStoredPanelClosed(sessionId) || undefined,
      }
      this.entries.set(sessionId, entry)
    }
    return entry
  }

  private connect(sessionId: string, entry: SessionEntry): void {
    const query = new URLSearchParams({ dshSessionId: sessionId })
    const source = new EventSource(`/qingagent-bridge/stream?${query}`)
    entry.source = source
    const eventNames: BridgeEvent['type'][] = [
      'doc-committed',
      'doc-review-pending',
      'binding-changed',
      'focus-changed',
      'turn-ended',
      'selection-changed',
      'engine-status',
    ]
    for (const name of eventNames) {
      source.addEventListener(name, (event) => {
        try {
          this.handleEvent(sessionId, entry, JSON.parse((event as MessageEvent).data) as BridgeEvent)
        } catch (error) {
          this.update(entry, { ...entry.snapshot, error: readableError(error) })
        }
      })
    }
    source.onerror = () => {
      this.update(entry, { ...entry.snapshot, error: BRIDGE_RECONNECTING_ERROR })
    }
  }

  private handleEvent(sessionId: string, entry: SessionEntry, event: BridgeEvent): void {
    if (event.type === 'doc-committed') {
      this.noteTurnActivity(entry, event.engineSessionId)
      const hadSelection = entry.snapshot.selection !== undefined
      const optimisticPanelDoc = committedPanelDoc(entry.snapshot, event.engineSessionId, event.doc)
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: event.engineSessionId,
        activeDoc: event.doc,
        blocks: event.blocks,
        words: event.words,
        reviewCount: undefined,
        revealRequest: event.revealWholeDraft
          ? {
              engineSessionId: event.engineSessionId,
              docVersion: event.doc.docVersion,
              nonce: ++entry.revealNonce,
            }
          : undefined,
        selection: undefined,
        error: undefined,
      })
      if (hadSelection) {
        const query = new URLSearchParams({ dshSessionId: sessionId })
        void bridgeJson(`/qingagent-bridge/selection?${query}`, { method: 'DELETE' }).catch(() => undefined)
      }
      this.open(entry)
      void this.loadState(sessionId, entry)
      // 事件已有完整 QingML/PM 时先推进 panelDoc 版本域，再后台读回 external canonical；
      // dirty guard 对乐观帧与随后 refresh 使用同一条保护链。
      const optimisticApply = optimisticPanelDoc
        ? this.applyCommittedPanelDoc(entry, event.engineSessionId, optimisticPanelDoc)
        : Promise.resolve()
      void optimisticApply.catch(() => undefined).finally(() => {
        void this.refreshPanel(sessionId, event.engineSessionId).catch(() => undefined)
      })
      return
    }
    if (event.type === 'doc-review-pending') {
      this.noteTurnActivity(entry, event.engineSessionId)
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: event.engineSessionId,
        activeDoc: event.doc,
        blocks: event.blocks,
        words: event.words,
        reviewCount: event.count,
        revealRequest: undefined,
        error: undefined,
      })
      this.open(entry)
      void this.loadState(sessionId, entry)
      // 进入审阅态同样重拉 PM 面板(含 review render-model),装饰层才有数据。
      void this.refreshPanel(sessionId, event.engineSessionId).catch(() => undefined)
      return
    }
    if (event.type === 'turn-ended') {
      const activeEngineSessionId = entry.snapshot.activeEngineSessionId
        ?? entry.snapshot.state?.binding.activeEngineSessionId
      if (activeEngineSessionId && event.engineSessionIds.includes(activeEngineSessionId)) {
        void this.refreshPanel(sessionId, activeEngineSessionId).catch(() => undefined)
      }
      return
    }
    if (event.type === 'focus-changed') {
      if (entry.snapshot.revealRequest?.engineSessionId !== event.engineSessionId) {
        this.update(entry, { ...entry.snapshot, revealRequest: undefined })
      }
      void this.refreshDoc(sessionId, event.engineSessionId).catch((error) => {
        this.update(entry, { ...entry.snapshot, error: readableError(error) })
      })
      void this.refreshPanel(sessionId, event.engineSessionId).catch(() => undefined)
      return
    }
    if (event.type === 'selection-changed') {
      this.update(entry, { ...entry.snapshot, selection: event.selection ?? undefined })
      return
    }
    if (event.type === 'binding-changed') {
      // 绑定文档数增加=有新稿加入,可唤回关闭的面板;数量不变的绑定重放属被动事件。
      const bindingGrew = event.binding.docs.length > entry.snapshot.bindingCount
      this.update(entry, {
        ...entry.snapshot,
        state: entry.snapshot.state ? { ...entry.snapshot.state, binding: event.binding } : undefined,
        bindingCount: event.binding.docs.length,
        activeEngineSessionId: event.binding.activeEngineSessionId,
      })
      if (event.binding.docs.length) this.open(entry, bindingGrew)
      void this.loadState(sessionId, entry)
      return
    }
    if (event.type === 'engine-status' && entry.snapshot.state) {
      const recovered = entry.snapshot.state.engine.state !== 'online' && event.engine.state === 'online'
      this.update(entry, { ...entry.snapshot, state: { ...entry.snapshot.state, engine: event.engine } })
      if (recovered) void this.loadState(sessionId, entry)
    }
  }

  private async loadState(sessionId: string, entry: SessionEntry): Promise<void> {
    if (entry.loading) return entry.loading
    entry.loading = (async () => {
      try {
        const query = new URLSearchParams({ dshSessionId: sessionId })
        const response = await fetch(`/qingagent-bridge/state?${query}`)
        if (!response.ok) throw new Error(await responseError(response))
        const state = await response.json() as BridgeState
        const activeEngineSessionId = state.binding.activeEngineSessionId
        this.update(entry, {
          ...entry.snapshot,
          state,
          bindingCount: state.binding.docs.length,
          activeEngineSessionId,
          activeDoc: state.activeDoc,
          selection: state.selection,
          ...(entry.snapshot.revealRequest?.engineSessionId === activeEngineSessionId
            ? {}
            : { revealRequest: undefined }),
          ...(entry.snapshot.panelEngineSessionId === activeEngineSessionId
            ? {}
            : { panelEngineSessionId: undefined, panelDoc: undefined, reviewModel: undefined }),
          error: undefined,
        })
        if (state.binding.docs.length) this.open(entry, false)
      } catch (error) {
        this.update(entry, { ...entry.snapshot, error: readableError(error) })
      } finally {
        entry.loading = undefined
      }
    })()
    return entry.loading
  }

  private async applyCommittedPanelDoc(
    entry: SessionEntry,
    engineSessionId: string,
    panelDoc: ExternalPmDocReadResponse,
  ): Promise<void> {
    if (
      entry.snapshot.panelEngineSessionId !== engineSessionId ||
      hasDocConflict(entry.snapshot, engineSessionId)
    ) return
    const shouldApply = await (entry.panelRefreshGuard?.beforeApply(engineSessionId, panelDoc)
      ?? Promise.resolve(true))
    if (
      !shouldApply ||
      entry.snapshot.panelEngineSessionId !== engineSessionId ||
      hasDocConflict(entry.snapshot, engineSessionId)
    ) return
    this.update(entry, {
      ...entry.snapshot,
      panelDoc,
      reviewModel: undefined,
      reviewCount: undefined,
      error: undefined,
    })
    entry.panelRefreshGuard?.afterApply?.(engineSessionId, panelDoc)
  }

  private update(entry: SessionEntry, snapshot: QingClientSnapshot): void {
    entry.snapshot = snapshot
    for (const listener of entry.listeners) listener()
    this.syncBusyFallback(entry)
  }

  private noteTurnActivity(entry: SessionEntry, engineSessionId: string): void {
    if (busyPanelEngineSessionId(entry.snapshot) !== engineSessionId) return
    this.clearBusyFallback(entry, true)
    this.syncBusyFallback(entry)
  }

  private syncBusyFallback(entry: SessionEntry): void {
    const engineSessionId = entry.refs > 0 ? busyPanelEngineSessionId(entry.snapshot) : undefined
    if (!engineSessionId) {
      this.clearBusyFallback(entry, true)
      return
    }
    if (entry.busyFallbackEngineSessionId !== engineSessionId) {
      this.clearBusyFallback(entry, true)
      entry.busyFallbackEngineSessionId = engineSessionId
    }
    if (
      entry.busyFallbackTimer
      || entry.busyFallbackAttemptedEngineSessionId === engineSessionId
    ) return
    entry.busyFallbackTimer = setTimeout(() => {
      entry.busyFallbackTimer = undefined
      if (entry.refs === 0 || busyPanelEngineSessionId(entry.snapshot) !== engineSessionId) {
        this.syncBusyFallback(entry)
        return
      }
      entry.busyFallbackAttemptedEngineSessionId = engineSessionId
      void this.refreshPanel(entry.sessionId, engineSessionId).catch(() => undefined)
    }, PANEL_BUSY_REFRESH_DELAY_MS)
    entry.busyFallbackTimer.unref?.()
  }

  private clearBusyFallback(entry: SessionEntry, resetAttempt: boolean): void {
    if (entry.busyFallbackTimer) clearTimeout(entry.busyFallbackTimer)
    entry.busyFallbackTimer = undefined
    entry.busyFallbackEngineSessionId = undefined
    if (resetAttempt) entry.busyFallbackAttemptedEngineSessionId = undefined
  }

  private open(entry: SessionEntry, reclaim = true): void {
    // 只有真·新内容事件(落库/进审)允许唤回被 × 关闭的面板;
    // 被动加载(loadState 重放/绑定快照)不清关闭位,否则 tab 切换重连即自动重开(P21)。
    if (entry.panelClosed) {
      if (!reclaim) return
      entry.panelClosed = false
      writeStoredPanelClosed(entry.sessionId, false)
      this.update(entry, entry.snapshot)
    }
    for (const opener of entry.openers) opener()
  }
}

export class BridgeHttpError extends Error {
  constructor(readonly status: number, readonly body: ExternalErrorResponse | Record<string, unknown>) {
    super(errorMessage(status, body))
    this.name = 'BridgeHttpError'
  }
}

async function bridgeJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => undefined) as T | ExternalErrorResponse | undefined
  if (!response.ok) {
    throw new BridgeHttpError(response.status, isRecord(body) ? body : { error: `HTTP ${response.status}` })
  }
  return body as T
}

function panelUrl(path: string, dshSessionId: string, engineSessionId: string): string {
  const query = new URLSearchParams({ dshSessionId, engineSessionId })
  return `${path}?${query}`
}

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined
  return body?.error ?? `HTTP ${response.status}`
}

function errorMessage(status: number, body: ExternalErrorResponse | Record<string, unknown>): string {
  const error = typeof body.error === 'string' ? body.error : `HTTP ${status}`
  const nextStep = typeof body.nextStep === 'string' ? body.nextStep : ''
  return nextStep ? `${error}（${nextStep}）` : error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMissingPanelDocError(error: unknown): error is BridgeHttpError {
  return error instanceof BridgeHttpError
    && error.status === 404
    && error.body.code === 'SESSION_NOT_FOUND'
}

function addMissingPanelDoc(
  missing: QingClientSnapshot['docMissing'],
  engineSessionId: string,
): NonNullable<QingClientSnapshot['docMissing']> {
  const engineSessionIds = missing?.engineSessionIds ?? []
  return engineSessionIds.includes(engineSessionId)
    ? { engineSessionIds }
    : { engineSessionIds: [...engineSessionIds, engineSessionId] }
}

function removeMissingPanelDoc(
  missing: QingClientSnapshot['docMissing'],
  engineSessionId: string,
): QingClientSnapshot['docMissing'] {
  const engineSessionIds = missing?.engineSessionIds.filter((id) => id !== engineSessionId) ?? []
  return engineSessionIds.length ? { engineSessionIds } : undefined
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function refreshSaveState(state: DocumentSaveState | undefined): DocumentSaveState {
  return state?.kind === 'conflict' ? state : { kind: 'idle' }
}

function hasConflictSaveState(state: DocumentSaveState | undefined, engineSessionId?: string): boolean {
  if (state?.kind !== 'conflict') return false
  return engineSessionId === undefined || state.engineSessionId === engineSessionId
}

function hasDocConflict(snapshot: QingClientSnapshot, engineSessionId: string): boolean {
  return Boolean(snapshot.conflicts?.[engineSessionId])
}

function busyPanelEngineSessionId(snapshot: QingClientSnapshot): string | undefined {
  const engineSessionId = snapshot.activeEngineSessionId
    ?? snapshot.state?.binding.activeEngineSessionId
  if (!engineSessionId) return undefined
  const panelBusy = snapshot.panelEngineSessionId === engineSessionId
    && snapshot.panelDoc?.agentBusy === true
  const activeDocBusy = snapshot.activeDoc?.sessionId === engineSessionId
    && snapshot.activeDoc.agentBusy === true
  const boundBusy = snapshot.state?.docs.some((doc) =>
    doc.engineSessionId === engineSessionId && doc.agentBusy === true) === true
  return panelBusy || activeDocBusy || boundBusy ? engineSessionId : undefined
}

function applyPanelDocToBridgeState(
  state: BridgeState | undefined,
  engineSessionId: string,
  panelDoc: ExternalPmDocReadResponse,
): BridgeState | undefined {
  if (!state) return undefined
  return {
    ...state,
    docs: state.docs.map((doc) => doc.engineSessionId === engineSessionId
      ? {
          ...doc,
          state: panelDoc.state,
          docVersion: panelDoc.docVersion,
          agentBusy: panelDoc.agentBusy,
        }
      : doc),
  }
}

function applyPanelDocToActiveDoc(
  activeDoc: ExternalDoc | undefined,
  engineSessionId: string,
  panelDoc: ExternalPmDocReadResponse,
): ExternalDoc | undefined {
  if (activeDoc?.sessionId !== engineSessionId) return activeDoc
  return {
    ...activeDoc,
    docVersion: panelDoc.docVersion,
    state: panelDoc.state,
    agentBusy: panelDoc.agentBusy,
    title: panelDoc.title,
    charCount: panelDoc.charCount ?? activeDoc.charCount,
    ...(panelDoc.pmDoc ? { pmDoc: panelDoc.pmDoc } : {}),
    contentHash: panelDoc.contentHash,
    ts: panelDoc.ts,
  }
}

function committedPanelDoc(
  snapshot: QingClientSnapshot,
  engineSessionId: string,
  doc: ExternalDoc,
): ExternalPmDocReadResponse | null {
  const current = snapshot.panelEngineSessionId === engineSessionId ? snapshot.panelDoc : undefined
  if (!current || doc.docVersion < current.docVersion) return null
  let pmDoc: PmDoc
  try {
    pmDoc = doc.pmDoc ?? compileQingmlDocument(doc.qingml)
  } catch {
    return null
  }
  return {
    sessionId: doc.sessionId,
    docVersion: doc.docVersion,
    contentHash: doc.contentHash ?? appliedDocWriteBaseline({
      version: doc.docVersion,
      pmDoc,
    }).baseContentHash,
    state: doc.state,
    agentBusy: doc.agentBusy,
    title: doc.title,
    ts: doc.ts ?? current.ts,
    charCount: doc.charCount ?? current.charCount,
    pmDoc,
  }
}

export const qingClientStore = new QingClientStore()
