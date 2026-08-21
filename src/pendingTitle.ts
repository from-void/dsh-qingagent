import { randomUUID } from 'node:crypto'
import type { BindingStore } from './bindings.js'
import type { ExternalDoc, ExternalProposalResponse } from './contracts.js'
import { isMissingSessionError, type EngineService } from './engine.js'
import { outlineOf } from './qingml.js'

export interface PendingTitle {
  dshSessionId: string
  engineSessionId: string
  title: string
}

export type PendingTitleSettlement = 'none' | 'pending-review' | 'discarded' | 'applied'

function pendingTitleKey(dshSessionId: string, engineSessionId: string): string {
  return `${dshSessionId}\u0000${engineSessionId}`
}

function titleWithoutWhitespace(title: string): string {
  return title.replace(/\s+/gu, '')
}

function effectiveH1(doc: ExternalDoc): string | undefined {
  return outlineOf(doc.qingml).headings.find((heading) => heading.level === 1)?.text
}

/**
 * 同批正文改名的运行时扣留槽。一稿只保留最新标题；标题必须等正文退出审阅态后，
 * 再按生效 H1 对齐补发。回合结束不清理，因为面板裁决通常晚于写作回合。
 */
export class PendingTitleCoordinator {
  private readonly pending = new Map<string, PendingTitle>()
  private readonly settling = new Map<string, Promise<PendingTitleSettlement>>()
  private readonly revisions = new Map<string, number>()
  private disposedRevision = 0

  constructor(
    private readonly engine: EngineService,
    private readonly bindings: BindingStore,
  ) {}

  deferTitle(dshSessionId: string, engineSessionId: string, title: string): void {
    const trimmed = title.trim()
    if (!trimmed) return
    const key = pendingTitleKey(dshSessionId, engineSessionId)
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    this.pending.set(key, {
      dshSessionId,
      engineSessionId,
      title: trimmed,
    })
  }

  hasPendingTitle(dshSessionId: string, engineSessionId: string): boolean {
    return this.pending.has(pendingTitleKey(dshSessionId, engineSessionId))
  }

  clearDocument(dshSessionId: string, engineSessionId: string): void {
    const key = pendingTitleKey(dshSessionId, engineSessionId)
    this.pending.delete(key)
    if (this.settling.has(key)) this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    else this.revisions.delete(key)
  }

  clearSession(dshSessionId: string): void {
    const prefix = `${dshSessionId}\u0000`
    const keys = new Set([...this.pending.keys(), ...this.settling.keys()])
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue
      this.pending.delete(key)
      if (this.settling.has(key)) this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
      else this.revisions.delete(key)
    }
  }

  dispose(): void {
    this.disposedRevision += 1
    this.pending.clear()
    this.settling.clear()
    this.revisions.clear()
  }

  /** 幂等、可重入：并发刷新复用同一结算 Promise，补发前先取走槽位避免双发。 */
  settlePendingTitle(
    dshSessionId: string,
    engineSessionId: string,
    turnId?: string,
  ): Promise<PendingTitleSettlement> {
    const key = pendingTitleKey(dshSessionId, engineSessionId)
    const active = this.settling.get(key)
    if (active) return active
    const settlement = this.settle(key, dshSessionId, engineSessionId, turnId)
    this.settling.set(key, settlement)
    const finish = () => {
      if (this.settling.get(key) === settlement) this.settling.delete(key)
      if (!this.pending.has(key) && !this.settling.has(key)) this.revisions.delete(key)
    }
    settlement.then(finish, finish)
    return settlement
  }

  private async settle(
    key: string,
    dshSessionId: string,
    engineSessionId: string,
    turnId?: string,
  ): Promise<PendingTitleSettlement> {
    const pending = this.pending.get(key)
    if (!pending) return 'none'
    const revision = this.revisions.get(key) ?? 0
    const disposedRevision = this.disposedRevision

    let doc: ExternalDoc
    try {
      doc = await this.engine.fetchJson<ExternalDoc>(
        `/sessions/${encodeURIComponent(engineSessionId)}/doc?format=qingml`,
      )
    } catch (error) {
      if (isMissingSessionError(error)) {
        if (this.pending.get(key) === pending) this.pending.delete(key)
        return 'discarded'
      }
      throw error
    }
    if (doc.state === 'pendingReview') return 'pending-review'

    const h1 = effectiveH1(doc)
    if (!h1 || titleWithoutWhitespace(h1) !== titleWithoutWhitespace(pending.title)) {
      if (this.pending.get(key) === pending) this.pending.delete(key)
      return 'discarded'
    }
    // 读取期间若有更新的标题覆盖本槽，旧结算不得抢发。
    if (this.pending.get(key) !== pending || this.revisions.get(key) !== revision) return 'none'
    this.pending.delete(key)

    let proposal: ExternalProposalResponse
    try {
      proposal = await this.engine.fetchJson<ExternalProposalResponse>(
        `/sessions/${encodeURIComponent(engineSessionId)}/proposals`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedDocVersion: doc.docVersion,
            clientMutationId: `dsh-title-${randomUUID()}`,
            ...(turnId ? { turnId } : {}),
            ops: [{ kind: 'setTitle', title: pending.title }],
          }),
        },
      )
    } catch (error) {
      // 请求未成功时保留重试机会；若期间发生覆盖、整稿重写、删除或 dispose，
      // 旧请求不得把已经清掉的槽位复活。
      if (
        this.disposedRevision === disposedRevision
        && this.revisions.get(key) === revision
        && !this.pending.has(key)
      ) {
        this.pending.set(key, pending)
      }
      throw error
    }
    if (proposal.status !== 'committed') {
      throw new Error('标题补发未直接生效。')
    }
    // setTitle 通道会按引擎规则截断过长标题且不推进正文版本；回读真实稿名，
    // 避免会话树缓存使用补发前的未截断输入。
    let settledTitle = pending.title
    try {
      const titledDoc = await this.engine.fetchJson<ExternalDoc>(
        `/sessions/${encodeURIComponent(engineSessionId)}/doc?format=qingml`,
      )
      settledTitle = titledDoc.title?.trim() || settledTitle
    } catch {
      // setTitle 已由引擎确认 committed；仅回读失败时仍先同步输入值，后续状态刷新会纠正截断差异。
    }
    await this.bindings.updateTitle(
      dshSessionId,
      engineSessionId,
      settledTitle,
    )
    return 'applied'
  }
}
