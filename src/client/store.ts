import type {
  BridgeEvent,
  BridgeState,
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
import type { DocumentSaveState } from './documentSaveCoordinator.js'
import { compileQingmlDocument } from './streamingDocument.js'

export interface QingClientSnapshot {
  state?: BridgeState
  activeEngineSessionId?: string
  activeDoc?: ExternalDoc
  qingml: string
  streaming: boolean
  blocks: number
  words: number
  bindingCount: number
  reviewCount?: number
  draftFailure?: string
  panelEngineSessionId?: string
  panelDoc?: ExternalPmDocReadResponse
  reviewModel?: ExternalReviewRenderModelResponse
  panelLoading?: boolean
  /** 「重载」等显式放弃本地内容的操作递增它,面板据此强制重挂编辑器。 */
  panelReloadNonce?: number
  saveState?: DocumentSaveState
  selection?: QingSelection
  error?: string
}

interface SessionEntry {
  snapshot: QingClientSnapshot
  listeners: Set<() => void>
  source?: EventSource
  refs: number
  openers: Set<() => void>
  loading?: Promise<void>
  panelLoadToken: number
  panelRefreshGuard?: PanelRefreshGuard
  activeDraftGeneration?: string
}

export interface PanelRefreshGuard {
  beforeApply(engineSessionId: string, panelDoc: ExternalPmDocReadResponse): Promise<boolean>
  afterApply?(engineSessionId: string, panelDoc: ExternalPmDocReadResponse): void
}

const EMPTY: QingClientSnapshot = {
  qingml: '',
  streaming: false,
  blocks: 0,
  words: 0,
  bindingCount: 0,
}

export class QingClientStore {
  private readonly entries = new Map<string, SessionEntry>()

  getSnapshot(sessionId: string): QingClientSnapshot {
    return this.entries.get(sessionId)?.snapshot ?? EMPTY
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const entry = this.entry(sessionId)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  hasPanelContent(sessionId: string): boolean {
    const snapshot = this.getSnapshot(sessionId)
    return snapshot.streaming || snapshot.bindingCount > 0
  }

  retain(sessionId: string, openDetails?: () => void): () => void {
    const entry = this.entry(sessionId)
    entry.refs += 1
    if (openDetails) entry.openers.add(openDetails)
    if (!entry.source) this.connect(sessionId, entry)
    void this.loadState(sessionId, entry)
    return () => {
      entry.refs = Math.max(0, entry.refs - 1)
      if (openDetails) entry.openers.delete(openDetails)
      if (entry.refs === 0) {
        entry.source?.close()
        entry.source = undefined
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

  async focus(sessionId: string, engineSessionId: string): Promise<void> {
    const response = await fetch('/qingagent-bridge/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dshSessionId: sessionId, engineSessionId }),
    })
    if (!response.ok) throw new Error(await responseError(response))
    const entry = this.entry(sessionId)
    this.update(entry, {
      ...entry.snapshot,
      activeEngineSessionId: engineSessionId,
      panelEngineSessionId: undefined,
      panelDoc: undefined,
      reviewModel: undefined,
      panelLoading: true,
    })
    void this.refreshPanel(sessionId, engineSessionId)
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
    const keepStreaming = entry.snapshot.streaming &&
      entry.snapshot.activeEngineSessionId === engineSessionId &&
      entry.activeDraftGeneration !== undefined
    this.update(entry, {
      ...entry.snapshot,
      activeEngineSessionId: engineSessionId,
      activeDoc: doc,
      qingml: doc.qingml,
      streaming: keepStreaming,
      reviewCount: doc.state === 'pendingReview' ? entry.snapshot.reviewCount : undefined,
      draftFailure: undefined,
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
      const reviewModel = panelDoc.state === 'pendingReview'
        ? await bridgeJson<ExternalReviewRenderModelResponse>(
            panelUrl('/qingagent-bridge/review-render-model', sessionId, engineSessionId),
          )
        : undefined
      if (entry.panelLoadToken !== token) return
      // 冲突封锁按文稿隔离:只有当前刷新的正是冲突稿才跳过应用,换稿刷新照常。
      if (
        entry.snapshot.saveState?.kind === 'conflict'
        && entry.snapshot.saveState.engineSessionId === engineSessionId
      ) {
        this.update(entry, {
          ...entry.snapshot,
          panelLoading: false,
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
          error: undefined,
        })
        return
      }
      const keepStreaming = entry.snapshot.streaming &&
        entry.activeDraftGeneration !== undefined &&
        entry.snapshot.activeEngineSessionId === engineSessionId
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: engineSessionId,
        panelEngineSessionId: engineSessionId,
        panelDoc,
        reviewModel,
        panelLoading: false,
        // 面板读回不能解除生成锁；只有当前 generation 的终态事件可以结束写作态。
        streaming: keepStreaming,
        reviewCount: reviewModel
          ? reviewModel.suggestions.filter((suggestion) => suggestion.status === 'reviewing').length
          : undefined,
        saveState: refreshSaveState(entry.snapshot.saveState),
        error: undefined,
      })
      entry.panelRefreshGuard?.afterApply?.(engineSessionId, panelDoc)
    } catch (error) {
      if (entry.panelLoadToken !== token) return
      this.update(entry, {
        ...entry.snapshot,
        panelLoading: false,
        error: readableError(error),
      })
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
    this.update(entry, { ...entry.snapshot, saveState: state })
  }

  /** 青简同款「重载」出路:用户明确同意放弃本地未保存内容,拉服务器权威版本继续编辑。
   *  绕过刷新守卫(守卫的职责是保护本地未保存内容,重载正是对它的显式放弃),
   *  并递增 reloadNonce 强制编辑器重挂,确保纸面内容切到服务器版本。 */
  async resolveConflictByReload(sessionId: string, engineSessionId: string): Promise<void> {
    const entry = this.entry(sessionId)
    this.update(entry, {
      ...entry.snapshot,
      saveState: { kind: 'idle' },
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

  applyReviewCommit(
    sessionId: string,
    engineSessionId: string,
    docVersion: number,
  ): void {
    const entry = this.entry(sessionId)
    if (entry.snapshot.panelEngineSessionId !== engineSessionId || !entry.snapshot.panelDoc) return
    entry.activeDraftGeneration = undefined
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
      streaming: false,
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
        snapshot: EMPTY,
        listeners: new Set(),
        refs: 0,
        openers: new Set(),
        panelLoadToken: 0,
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
      'draft-started',
      'draft-chunk',
      'draft-failed',
      'doc-committed',
      'doc-review-pending',
      'binding-changed',
      'focus-changed',
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
      this.update(entry, { ...entry.snapshot, error: '与青简桥的实时连接暂时中断，浏览器会自动重连。' })
    }
  }

  private handleEvent(sessionId: string, entry: SessionEntry, event: BridgeEvent): void {
    if (event.type === 'draft-started') {
      entry.activeDraftGeneration = event.generation
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: event.engineSessionId,
        streaming: true,
        blocks: 0,
        words: 0,
        reviewCount: undefined,
        draftFailure: undefined,
        error: undefined,
      })
      this.open(entry)
      return
    }
    if (event.type === 'draft-chunk') {
      if (entry.activeDraftGeneration !== event.generation) return
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: event.engineSessionId,
        qingml: event.accumulatedBlocks.join(''),
        streaming: true,
        blocks: event.blocks,
        words: event.words,
        reviewCount: undefined,
        draftFailure: undefined,
        error: undefined,
      })
      this.open(entry)
      return
    }
    if (event.type === 'draft-failed') {
      if (entry.activeDraftGeneration !== event.generation) return
      entry.activeDraftGeneration = undefined
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: event.engineSessionId,
        streaming: false,
        draftFailure: event.message,
        error: undefined,
      })
      this.open(entry)
      return
    }
    if (event.type === 'doc-committed') {
      if (event.generation !== undefined && entry.activeDraftGeneration !== event.generation) return
      entry.activeDraftGeneration = undefined
      const hadSelection = entry.snapshot.selection !== undefined
      const optimisticPanelDoc = committedPanelDoc(entry.snapshot, event.engineSessionId, event.doc)
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: event.engineSessionId,
        activeDoc: event.doc,
        qingml: event.doc.qingml,
        streaming: false,
        blocks: event.blocks,
        words: event.words,
        reviewCount: undefined,
        draftFailure: undefined,
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
      if (event.generation !== undefined && entry.activeDraftGeneration !== event.generation) return
      entry.activeDraftGeneration = undefined
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: event.engineSessionId,
        activeDoc: event.doc,
        streaming: false,
        blocks: event.blocks,
        words: event.words,
        reviewCount: event.count,
        draftFailure: undefined,
        error: undefined,
      })
      this.open(entry)
      void this.loadState(sessionId, entry, true)
      // 进入审阅态同样重拉 PM 面板(含 review render-model),装饰层才有数据。
      void this.refreshPanel(sessionId, event.engineSessionId).catch(() => undefined)
      return
    }
    if (event.type === 'focus-changed') {
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
      this.update(entry, {
        ...entry.snapshot,
        state: entry.snapshot.state ? { ...entry.snapshot.state, binding: event.binding } : undefined,
        bindingCount: event.binding.docs.length,
        activeEngineSessionId: event.binding.activeEngineSessionId,
      })
      if (event.binding.docs.length) this.open(entry)
      void this.loadState(sessionId, entry, entry.snapshot.streaming)
      return
    }
    if (event.type === 'engine-status' && entry.snapshot.state) {
      this.update(entry, { ...entry.snapshot, state: { ...entry.snapshot.state, engine: event.engine } })
    }
  }

  private async loadState(sessionId: string, entry: SessionEntry, preserveDraft = false): Promise<void> {
    if (entry.loading) return entry.loading
    entry.loading = (async () => {
      try {
        const query = new URLSearchParams({ dshSessionId: sessionId })
        const response = await fetch(`/qingagent-bridge/state?${query}`)
        if (!response.ok) throw new Error(await responseError(response))
        const state = await response.json() as BridgeState
        const activeEngineSessionId = state.binding.activeEngineSessionId
        // state 拉取可能与第一块并发；以落地瞬间的 live snapshot 为准，不能让较慢的空文档响应抹掉写作流。
        const sameActiveDoc = entry.snapshot.activeEngineSessionId === activeEngineSessionId
        const keepStreaming = entry.snapshot.streaming && sameActiveDoc
        const keepDraft = (preserveDraft && sameActiveDoc) || keepStreaming
        this.update(entry, {
          ...entry.snapshot,
          state,
          bindingCount: state.binding.docs.length,
          activeEngineSessionId,
          activeDoc: state.activeDoc,
          selection: state.selection,
          qingml: keepDraft ? entry.snapshot.qingml : state.activeDoc?.qingml ?? '',
          streaming: keepStreaming,
          ...(entry.snapshot.panelEngineSessionId === activeEngineSessionId
            ? {}
            : { panelEngineSessionId: undefined, panelDoc: undefined, reviewModel: undefined }),
          error: undefined,
        })
        if (state.binding.docs.length) this.open(entry)
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
      hasConflictSaveState(entry.snapshot.saveState, engineSessionId)
    ) return
    const shouldApply = await (entry.panelRefreshGuard?.beforeApply(engineSessionId, panelDoc)
      ?? Promise.resolve(true))
    if (
      !shouldApply ||
      entry.snapshot.panelEngineSessionId !== engineSessionId ||
      hasConflictSaveState(entry.snapshot.saveState, engineSessionId)
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
  }

  private open(entry: SessionEntry): void {
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
    pmDoc,
  }
}

export const qingClientStore = new QingClientStore()
