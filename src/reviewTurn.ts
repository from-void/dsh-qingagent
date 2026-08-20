export const REVIEW_TURN_EDIT_ERROR = '当前是审查回合,只能生成批注(qing_annotate),不能改动正文'

export type ReviewTurnType =
  | 'sensitive'
  | 'deai'
  | 'source'
  | 'consistency'
  | 'privacy'
  | 'format'
  | 'role'
  | 'custom'

export interface PendingReviewTurn {
  type: ReviewTurnType
  templateId: string
  templateName: string
}

export interface ActiveReviewTurn extends PendingReviewTurn {
  turnId: number
}

const REVIEW_TYPES = new Set<ReviewTurnType>([
  'sensitive',
  'deai',
  'source',
  'consistency',
  'privacy',
  'format',
  'role',
  'custom',
])

export function parseReviewTurn(input: unknown): PendingReviewTurn {
  if (!input || typeof input !== 'object') throw new Error('审查回合参数无效。')
  const value = input as Record<string, unknown>
  if (typeof value.type !== 'string' || !REVIEW_TYPES.has(value.type as ReviewTurnType)) {
    throw new Error('审查类型无效。')
  }
  if (typeof value.templateId !== 'string' || !value.templateId.trim()) {
    throw new Error('templateId 必须是非空字符串。')
  }
  if (typeof value.templateName !== 'string' || !value.templateName.trim()) {
    throw new Error('templateName 必须是非空字符串。')
  }
  return {
    type: value.type as ReviewTurnType,
    templateId: value.templateId,
    templateName: value.templateName,
  }
}

export class ReviewTurnCoordinator {
  private readonly pending = new Map<string, PendingReviewTurn>()
  private readonly active = new Map<string, ActiveReviewTurn>()

  markPending(dshSessionId: string, review: PendingReviewTurn): void {
    this.pending.set(dshSessionId, review)
  }

  cancelPending(dshSessionId: string): void {
    this.pending.delete(dshSessionId)
  }

  activate(dshSessionId: string, turnId: number): ActiveReviewTurn | undefined {
    const pending = this.pending.get(dshSessionId)
    if (!pending) return undefined
    this.pending.delete(dshSessionId)
    const active = { ...pending, turnId }
    this.active.set(dshSessionId, active)
    return active
  }

  getActive(dshSessionId: string): ActiveReviewTurn | undefined {
    return this.active.get(dshSessionId)
  }

  assertAnnotationOnly(dshSessionId: string): void {
    if (this.active.has(dshSessionId)) throw new Error(REVIEW_TURN_EDIT_ERROR)
  }

  finish(dshSessionId: string, turnId?: number): boolean {
    const active = this.active.get(dshSessionId)
    if (!active || (turnId !== undefined && active.turnId !== turnId)) return false
    this.active.delete(dshSessionId)
    return true
  }

  dispose(dshSessionId: string): void {
    this.pending.delete(dshSessionId)
    this.active.delete(dshSessionId)
  }
}

const coordinators = new WeakMap<object, ReviewTurnCoordinator>()

export function reviewTurnCoordinatorFor(owner: object): ReviewTurnCoordinator {
  const existing = coordinators.get(owner)
  if (existing) return existing
  const created = new ReviewTurnCoordinator()
  coordinators.set(owner, created)
  return created
}
