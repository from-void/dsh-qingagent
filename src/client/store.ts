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
} from '../contracts.js'
import type { DocumentSaveState } from './documentSaveCoordinator.js'

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
  saveState?: DocumentSaveState
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

  async refreshDoc(sessionId: string, engineSessionId: string): Promise<void> {
    const entry = this.entry(sessionId)
    const query = new URLSearchParams({ dshSessionId: sessionId, engineSessionId })
    const response = await fetch(`/qingagent-bridge/doc?${query}`)
    if (!response.ok) throw new Error(await responseError(response))
    const doc = await response.json() as ExternalDoc
    this.update(entry, {
      ...entry.snapshot,
      activeEngineSessionId: engineSessionId,
      activeDoc: doc,
      qingml: doc.qingml,
      streaming: false,
      reviewCount: doc.state === 'pendingReview' ? entry.snapshot.reviewCount : undefined,
      draftFailure: undefined,
      error: undefined,
    })
  }

  async refreshPanel(sessionId: string, engineSessionId: string): Promise<void> {
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
      this.update(entry, {
        ...entry.snapshot,
        activeEngineSessionId: engineSessionId,
        panelEngineSessionId: engineSessionId,
        panelDoc,
        reviewModel,
        panelLoading: false,
        // 面板权威刷新完成 = 生成流必然已结束;防御迟到的 draft-chunk(如坏块重试流的首块)
        // 把状态卡在「写作中」。
        streaming: false,
        reviewCount: reviewModel
          ? reviewModel.suggestions.filter((suggestion) => suggestion.status === 'reviewing').length
          : undefined,
        saveState: { kind: 'idle' },
        error: undefined,
      })
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
    patchId: string,
    verdict: 'accepted' | 'rejected',
  ): void {
    const entry = this.entry(sessionId)
    const model = entry.snapshot.reviewModel
    if (entry.snapshot.panelEngineSessionId !== engineSessionId || !model) return
    const reviewModel: ExternalReviewRenderModelResponse = {
      ...model,
      suggestions: model.suggestions.map((suggestion) =>
        suggestion.id === patchId ? { ...suggestion, status: verdict } : suggestion),
    }
    this.update(entry, {
      ...entry.snapshot,
      reviewModel,
      reviewCount: reviewModel.suggestions.filter((suggestion) => suggestion.status === 'reviewing').length,
    })
  }

  private entry(sessionId: string): SessionEntry {
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = { snapshot: EMPTY, listeners: new Set(), refs: 0, openers: new Set(), panelLoadToken: 0 }
      this.entries.set(sessionId, entry)
    }
    return entry
  }

  private connect(sessionId: string, entry: SessionEntry): void {
    const query = new URLSearchParams({ dshSessionId: sessionId })
    const source = new EventSource(`/qingagent-bridge/stream?${query}`)
    entry.source = source
    const eventNames: BridgeEvent['type'][] = [
      'draft-chunk',
      'draft-failed',
      'doc-committed',
      'doc-review-pending',
      'binding-changed',
      'focus-changed',
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
    if (event.type === 'draft-chunk') {
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
        error: undefined,
      })
      this.open(entry)
      void this.loadState(sessionId, entry)
      // 落稿后 PM 面板必须重拉权威文档,否则编辑器停留在流式残影/空态。
      void this.refreshPanel(sessionId, event.engineSessionId).catch(() => undefined)
      return
    }
    if (event.type === 'doc-review-pending') {
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

export const qingClientStore = new QingClientStore()
