import type {
  DocSuggestion,
  ExternalAssetUploadJsonRequest as QingExternalAssetUploadJsonRequest,
  ExternalAssetUploadResponse as QingExternalAssetUploadResponse,
  ExternalDocReplaceRequest as QingExternalDocReplaceRequest,
  ExternalDocReplaceResponse as QingExternalDocReplaceResponse,
  ExternalPmDocReadResponse as QingExternalPmDocReadResponse,
  ExternalReviewRenderModelResponse as QingExternalReviewRenderModelResponse,
  PmDoc,
} from '@qingagent/contract-ts'

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
  /** 新版桥事件可直接携带 canonical PM；旧版仅有 qingml 时客户端会本地编译。 */
  pmDoc?: PmDoc
  contentHash?: string
  ts?: string
}

/** external PM / 直写 / 审阅模型直接复用青简公开 wire 类型。 */
export type ExternalPmDocReadResponse = QingExternalPmDocReadResponse
export type ExternalDocReplaceRequest = QingExternalDocReplaceRequest
export type ExternalDocReplaceResponse = QingExternalDocReplaceResponse
export type ExternalReviewRenderModelResponse = QingExternalReviewRenderModelResponse
export type ExternalAssetUploadJsonRequest = QingExternalAssetUploadJsonRequest
export type ExternalAssetUploadResponse = QingExternalAssetUploadResponse

export interface ExternalReviewVerdictRequest {
  expectedDocVersion: number
  patchId: string
  verdict: 'accepted' | 'rejected'
}

export interface ExternalReviewVerdictResponse {
  status: 'marked'
  docVersion: number
  patchIds: string[]
  verdict: 'accepted' | 'rejected'
  reviewingCount: number
  seq: number | null
}

export interface ExternalReviewCommitPanelRequest {
  expectedDocVersion: number
  action: 'commit' | 'accept_all' | 'reject_all'
}

export interface ExternalErrorResponse {
  error: string
  code?: string
  nextStep?: string
  expected?: number
  actual?: number
  seq?: number
}

/** 让客户端窄层不必重新声明青简 wire 节点。 */
export type { DocSuggestion, PmDoc }

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
  selection?: QingSelection
  engine: EngineStatusSnapshot
}

export interface QingSelectionAnchor {
  blockId: string
  from: number
  to: number
}

export interface QingSelection {
  dshSessionId: string
  engineSessionId: string
  quote: string
  anchor: QingSelectionAnchor
}

export interface DraftMetrics {
  blocks: number
  words: number
}

export type BridgeEvent =
  | { type: 'draft-started'; engineSessionId: string; generation: string }
  | ({ type: 'draft-chunk'; engineSessionId: string; generation: string; chunkQingml: string; accumulatedBlocks: string[]; title: string } & DraftMetrics)
  | { type: 'draft-failed'; engineSessionId: string; generation: string; message: string }
  | ({ type: 'doc-committed'; engineSessionId: string; doc: ExternalDoc; generation?: string } & DraftMetrics)
  | ({ type: 'doc-review-pending'; engineSessionId: string; doc: ExternalDoc; count: number; generation?: string } & DraftMetrics)
  | { type: 'binding-changed'; binding: SessionBinding }
  | { type: 'focus-changed'; engineSessionId: string }
  | { type: 'selection-changed'; selection: QingSelection | null }
  | { type: 'engine-status'; engine: EngineStatusSnapshot }

export interface ExternalSessionCreateResponse {
  sessionId: string
  seq: number | null
}

export interface ExternalDocReadResponse {
  sessionId: string
  docVersion: number
  state: QingDocumentState
  agentBusy: boolean
  markdown: string
  markdownWithLineNumbers?: string
  qingml?: string
  title: string | null
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

export type ExternalEditProposalOp =
  | { kind: 'strReplace'; old: string; new: string; nth?: number }
  | { kind: 'insertAfterLine'; line: number; markdown: string }
  | { kind: 'appendSection'; markdown: string }

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
