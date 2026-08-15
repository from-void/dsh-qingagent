import type { ExternalDocReplaceRequest, ExternalDocReplaceResponse, PmDoc } from '../contracts.js'
import {
  createKnownDocVersionLedger,
  resolveDocWriteConflict,
  type DocWriteBaseline,
  type KnownDocVersionLedger,
  type KnownDocVersionOrigin,
} from '@qingweb/pages/workspace/data/docWriteBaseline'
import { classifyDocSaveError, TRANSIENT_DOC_SAVE_TOAST } from '@qingweb/pages/workspace/data/docSaveError'
import { createClientMutationId, pmDocHasSubstantiveContent } from '@qingweb/pages/workspace/data/pageExitSave'

export type DocumentSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; version: number }
  | { kind: 'conflict'; engineSessionId: string; expected: number; actual: number; message: string }
  | { kind: 'blocked'; code: 'AGENT_BUSY' | 'REVIEW_PENDING'; message: string }
  | { kind: 'error'; message: string; transient: boolean }

interface PendingWrite {
  engineSessionId: string
  doc: PmDoc
  baseline: DocWriteBaseline
  mutationId: string
  replayDepth: number
  replayedVersions: Set<number>
  waiters: Array<{ resolve: () => void; reject: (error: Error) => void }>
}

export interface DocumentSaveCoordinatorOptions {
  send: (engineSessionId: string, request: ExternalDocReplaceRequest) => Promise<ExternalDocReplaceResponse>
  onCommitted: (
    engineSessionId: string,
    doc: PmDoc,
    response: Extract<ExternalDocReplaceResponse, { ok: true }>,
  ) => void
  onStateChange?: (state: DocumentSaveState) => void
  createMutationId?: () => string
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
}

export interface SaveHttpErrorBody {
  code?: string
  error?: string
  nextStep?: string
  ok?: boolean
  clientMutationId?: string
  conflict?: { expected?: number; actual?: number }
  actualContentHash?: string
}

/**
 * 青简 updateDoc 的 latest-only 单飞协调器。400ms trailing 与首笔 baseline 冻结仍由
 * DocumentSnapshotView 原实现负责；这里接管直写、同 payload 瞬态重试、成功后队列 rebase。
 */
export class DocumentSaveCoordinator {
  private current: PendingWrite | null = null
  private queued: PendingWrite | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failedTransient: PendingWrite | null = null
  private disposed = false
  private state: DocumentSaveState = { kind: 'idle' }
  private readonly knownVersionsByDocument = new Map<string, KnownDocVersionLedger>()
  private readonly createMutationId: () => string
  private readonly schedule: NonNullable<DocumentSaveCoordinatorOptions['schedule']>
  private readonly cancelSchedule: NonNullable<DocumentSaveCoordinatorOptions['cancelSchedule']>

  constructor(private readonly options: DocumentSaveCoordinatorOptions) {
    this.createMutationId = options.createMutationId ?? createClientMutationId
    this.schedule = options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds))
    this.cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer))
  }

  getState(): DocumentSaveState { return this.state }

  getWriteActivity(engineSessionId: string): {
    pendingDocWrite: boolean
    queuedDocWrite: boolean
  } {
    return {
      pendingDocWrite: this.current?.engineSessionId === engineSessionId,
      queuedDocWrite: this.queued?.engineSessionId === engineSessionId,
    }
  }

  rememberKnownVersion(
    engineSessionId: string,
    baseline: DocWriteBaseline,
    origin: KnownDocVersionOrigin,
  ): void {
    this.versionLedger(engineSessionId).remember(baseline, origin)
  }

  enqueue(engineSessionId: string, doc: PmDoc, baseline: DocWriteBaseline): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('保存协调器已释放'))
    const promise = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject }
      if (this.current) {
        if (this.queued) {
          this.queued.doc = doc
          this.queued.baseline = baseline
          this.queued.waiters.push(waiter)
        } else {
          this.queued = this.pending(engineSessionId, doc, baseline, [waiter])
        }
        return
      }
      this.current = this.pending(engineSessionId, doc, baseline, [waiter])
      this.publish({ kind: 'saving' })
      this.sendCurrent(0)
    })
    return promise
  }

  /** 浏览器 online 事件调用；只重发最后一次耗尽瞬态重试的最新全文。 */
  retryOnline(): void {
    if (this.disposed || this.current || !this.failedTransient) return
    this.current = this.failedTransient
    this.failedTransient = null
    this.current.mutationId = this.createMutationId()
    this.publish({ kind: 'saving' })
    this.sendCurrent(0)
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) this.cancelSchedule(this.retryTimer)
    this.retryTimer = null
    const error = new Error('保存已因文稿切换而取消')
    this.rejectWrite(this.current, error)
    this.rejectWrite(this.queued, error)
    this.current = null
    this.queued = null
    this.failedTransient = null
  }

  private pending(
    engineSessionId: string,
    doc: PmDoc,
    baseline: DocWriteBaseline,
    waiters: PendingWrite['waiters'],
  ): PendingWrite {
    return {
      engineSessionId,
      doc,
      baseline,
      mutationId: this.createMutationId(),
      replayDepth: 0,
      replayedVersions: new Set(),
      waiters,
    }
  }

  private sendCurrent(attempt: number): void {
    const write = this.current
    if (!write || this.disposed) return
    const request: ExternalDocReplaceRequest = {
      expectedDocumentSnapshot: write.baseline.expectedDocumentSnapshot,
      baseContentHash: write.baseline.baseContentHash,
      clientMutationId: write.mutationId,
      doc: write.doc,
    }
    this.options.send(write.engineSessionId, request).then(
      (response) => this.handleResponse(write, response),
      (error) => this.handleError(write, error, attempt),
    )
  }

  private handleResponse(write: PendingWrite, response: ExternalDocReplaceResponse): void {
    if (this.disposed || this.current !== write) return
    if (!response.ok) {
      this.handleConflict(write, response.conflict.expected, response.conflict.actual)
      return
    }
    const baseline: DocWriteBaseline = {
      expectedDocumentSnapshot: response.docVersion,
      baseContentHash: response.contentHash,
      baseHasSubstantiveContent: pmDocHasSubstantiveContent(write.doc),
    }
    this.rememberKnownVersion(write.engineSessionId, baseline, 'selfWrite')
    this.options.onCommitted(write.engineSessionId, write.doc, response)
    this.resolveWrite(write)
    this.current = null
    this.failedTransient = null

    if (this.queued) {
      const next = this.queued
      this.queued = null
      if (next.engineSessionId === write.engineSessionId) next.baseline = baseline
      this.current = next
      this.publish({ kind: 'saving' })
      this.retryTimer = this.schedule(() => {
        this.retryTimer = null
        this.sendCurrent(0)
      }, 0)
      return
    }
    this.publish({ kind: 'saved', version: response.docVersion })
  }

  private handleError(write: PendingWrite, error: unknown, attempt: number): void {
    if (this.disposed || this.current !== write) return
    const body = errorBody(error)
    if (body?.code === 'VERSION_CONFLICT' && body.conflict) {
      this.handleConflict(
        write,
        numberOr(body.conflict.expected, write.baseline.expectedDocumentSnapshot),
        numberOr(body.conflict.actual, write.baseline.expectedDocumentSnapshot),
      )
      return
    }
    if (body?.code === 'AGENT_BUSY' || body?.code === 'REVIEW_PENDING') {
      const code = body.code
      const message = code === 'AGENT_BUSY'
        ? '青简正在处理文稿，已暂停手动编辑。'
        : '文稿已进入审阅，已暂停手动编辑。'
      this.failCurrent(new Error(message), { kind: 'blocked', code, message })
      return
    }

    const transient = classifyDocSaveError(error) === 'transient'
    if (transient && attempt < 2) {
      this.retryTimer = this.schedule(() => {
        this.retryTimer = null
        if (!this.disposed && this.current === write) this.sendCurrent(attempt + 1)
      }, 300 * (attempt + 1))
      return
    }
    const message = transient
      ? TRANSIENT_DOC_SAVE_TOAST
      : body?.error || (error instanceof Error ? `保存请求失败：${error.message}` : '保存请求失败，请重试。')
    if (transient) {
      this.failedTransient = this.queued ?? write
      if (this.queued) this.failedTransient.waiters.push(...write.waiters)
    }
    this.failCurrent(new Error(message), { kind: 'error', message, transient })
  }

  private handleConflict(write: PendingWrite, expected: number, actual: number): void {
    const resolution = resolveDocWriteConflict({
      conflict: {
        expectedDocumentSnapshot: expected,
        actualDocumentSnapshot: actual,
      },
      isLatestOwnMutation: this.current === write,
      hasSubmittedDoc: true,
      knownActualVersion: this.versionLedger(write.engineSessionId).get(actual),
      replayedAgainstActual: write.replayedVersions.has(actual),
      replayDepth: write.replayDepth,
    })
    if (resolution.kind === 'silentReplay') {
      write.replayedVersions.add(actual)
      write.replayDepth += 1
      write.baseline = resolution.baseline
      write.mutationId = this.createMutationId()
      this.retryTimer = this.schedule(() => {
        this.retryTimer = null
        if (!this.disposed && this.current === write) this.sendCurrent(0)
      }, 0)
      return
    }
    const message = `保存冲突：文稿已从 v${expected} 更新到 v${actual}，已暂停编辑以保护两边内容。`
    this.failCurrent(new Error(message), {
      kind: 'conflict',
      engineSessionId: write.engineSessionId,
      expected,
      actual,
      message,
    })
  }

  private failCurrent(error: Error, state: DocumentSaveState): void {
    const current = this.current
    this.current = null
    this.rejectWrite(current, error)
    this.rejectWrite(this.queued, error)
    this.queued = null
    this.publish(state)
  }

  private versionLedger(engineSessionId: string): KnownDocVersionLedger {
    let ledger = this.knownVersionsByDocument.get(engineSessionId)
    if (!ledger) {
      ledger = createKnownDocVersionLedger()
      this.knownVersionsByDocument.set(engineSessionId, ledger)
    }
    return ledger
  }

  private publish(state: DocumentSaveState): void {
    this.state = state
    this.options.onStateChange?.(state)
  }

  private resolveWrite(write: PendingWrite | null): void {
    for (const waiter of write?.waiters.splice(0) ?? []) waiter.resolve()
  }

  private rejectWrite(write: PendingWrite | null, error: Error): void {
    for (const waiter of write?.waiters.splice(0) ?? []) waiter.reject(error)
  }
}

function errorBody(error: unknown): SaveHttpErrorBody | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as { body?: unknown }
  return candidate.body && typeof candidate.body === 'object'
    ? candidate.body as SaveHttpErrorBody
    : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
