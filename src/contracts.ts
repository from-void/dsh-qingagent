export type EngineState = 'online' | 'offline' | 'starting'
export type QingDocumentState = 'empty' | 'editing' | 'pendingReview'

export interface EngineStatusSnapshot {
  state: EngineState
  engineUrl: string
  version?: string
  message?: string
}

export interface BoundDocument {
  engineSessionId: string
  title: string
  createdAt: string
}

export interface SessionBinding {
  docs: BoundDocument[]
  activeEngineSessionId?: string
}

export interface ExternalDoc {
  sessionId: string
  docVersion: number
  state: QingDocumentState
  agentBusy: boolean
  markdown: string
  qingml: string
  title: string | null
}

export interface BridgeDocument extends BoundDocument {
  state: QingDocumentState | 'offline'
  docVersion: number | null
  agentBusy?: boolean
}

export interface BridgeState {
  dshSessionId: string
  binding: SessionBinding
  docs: BridgeDocument[]
  activeDoc?: ExternalDoc
  engine: EngineStatusSnapshot
}

export interface DraftMetrics {
  blocks: number
  words: number
}

export type BridgeEvent =
  | ({ type: 'draft-chunk'; engineSessionId: string; chunkQingml: string; accumulatedBlocks: string[]; title: string } & DraftMetrics)
  | { type: 'draft-failed'; engineSessionId: string; message: string }
  | ({ type: 'doc-committed'; engineSessionId: string; doc: ExternalDoc } & DraftMetrics)
  | ({ type: 'doc-review-pending'; engineSessionId: string; doc: ExternalDoc; count: number } & DraftMetrics)
  | { type: 'binding-changed'; binding: SessionBinding }
  | { type: 'focus-changed'; engineSessionId: string }
  | { type: 'engine-status'; engine: EngineStatusSnapshot }

export interface ExternalSessionCreateResponse {
  sessionId: string
  seq: number | null
}

export interface ExternalValidationDiagnostic {
  failureKind: string
  warningKinds: string[]
  tagSkeleton: string
  errorLocations: Array<{
    kind: string
    startOffset?: number
    endOffset?: number
    path?: Array<string | number>
  }>
}

export type ExternalProposalResponse =
  | { status: 'committed'; docVersion: number; seq?: number }
  | { status: 'review'; patchIds: string[]; count: number; seq?: number }

export interface ExternalReviewCommitRequest {
  expectedDocVersion: number
  action: 'accept_all' | 'reject_all'
}

export interface ExternalReviewOutcomeHunk {
  verdict: 'accepted' | 'rejected'
  blockSummary: string
  beforeText: string
  afterText: string
}

export interface ExternalReviewOutcome {
  acceptedCount: number
  rejectedCount: number
  hunks: ExternalReviewOutcomeHunk[]
}

export interface ExternalReviewCommitResponse {
  status: 'reviewed'
  docVersion: number
  acceptedCount: number
  rejectedCount: number
  remainingCount: number
  outcomeQueued: boolean
  outcome: ExternalReviewOutcome
  seq: number | null
}

export interface SideModelConfig {
  provider: string
  model: string
}
