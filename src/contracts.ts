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

export type EngineState = 'online' | 'offline' | 'starting' | 'handshake-failed'
export type EngineStatusReason =
  | 'instance-missing'
  | 'instance-invalid'
  | 'instance-process-exited'
  | 'connection-refused'
  | 'connection-timeout'
  | 'unauthorized'
  | 'health-http-error'
  | 'health-response-invalid'
  | 'version-mismatch'
  | 'protocol-incompatible'
export type QingDocumentState = 'empty' | 'editing' | 'pendingReview'

export interface EngineStatusSnapshot {
  state: EngineState
  engineUrl: string
  /** host 按系统注册锚点探测；旧 bridge 载荷缺失时客户端按 false 兼容。 */
  clientInstalled?: boolean
  /** 仅由 host 检测器写入；bridge 启动端点不接受客户端回传此路径。 */
  clientExecutablePath?: string
  version?: string
  message?: string
  reason?: EngineStatusReason
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
  /** external v2 wire；旧事件未携带时由当前 PM 面板值承接。 */
  charCount?: number
  /** 新版桥事件可直接携带 canonical PM；旧版仅有 qingml 时客户端会本地编译。 */
  pmDoc?: PmDoc
  contentHash?: string
  ts?: string
}

/** external PM / 直写 / 审阅模型直接复用青简公开 wire 类型。 */
type OptionalCharCount<T> = T extends { charCount: number }
  ? Omit<T, 'charCount'> & { charCount?: number }
  : T

export type ExternalPmDocReadResponse = OptionalCharCount<QingExternalPmDocReadResponse>
export type ExternalDocReplaceRequest = QingExternalDocReplaceRequest
export type ExternalDocReplaceResponse = OptionalCharCount<QingExternalDocReplaceResponse>
/**
 * 当前青简公开契约携带 wholeDocument/previewDoc/editedDoc；部分引擎版本还会直接给出
 * changeRatio。后者保持可选，缺失时由客户端按青简产品侧同式派生。
 */
export type ExternalReviewRenderModelResponse = QingExternalReviewRenderModelResponse & {
  changeRatio?: number
  /** 新版 external render-model 直接携带批注；旧引擎缺失时客户端按空数组兼容。 */
  annotations?: ExternalAnnotation[]
}
/** ExternalApi.ts 已声明但 contract-ts/index.ts 尚未公开导出的批注 wire DTO。 */
export interface ExternalAnnotation {
  id: string
  summary: string
  note: string
  origin: string
  suggestion?: string
  severity?: 'error' | 'warn' | 'info'
  status: 'reviewing' | 'accepted' | 'ignored'
  anchors: Array<{
    blockId: string
    pmFrom: number
    pmTo: number
    quote: string
    prefix?: string
    suffix?: string
    /** 新版引擎若选择保留内部 hash，客户端原样沿用。 */
    textHash?: string
  }>
}
export interface ExternalAnnotationIgnoreRequest {
  expectedDocVersion: number
  annotationIds: string[]
  turnId?: string
}
export interface ExternalAnnotationIgnoreResponse {
  status: 'ignored'
  annotationIds: string[]
  remainingAnnotationCount: number
  seq: number | null
}
export type ExternalAssetUploadJsonRequest = QingExternalAssetUploadJsonRequest
export type ExternalAssetUploadResponse = QingExternalAssetUploadResponse

export interface ExternalReviewVerdictRequest {
  expectedDocVersion: number
  patchId: string
  verdict: 'accepted' | 'rejected'
  turnId?: string
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
  turnId?: string
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
  | ({ type: 'doc-committed'; engineSessionId: string; doc: ExternalDoc } & DraftMetrics)
  | ({ type: 'doc-review-pending'; engineSessionId: string; doc: ExternalDoc; count: number } & DraftMetrics)
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

// TODO(vendor 4e6a1dd4):vendor bump 至含 4e6a1dd4 后收敛回 @qingagent/contract-ts 契约引用。
export const DRAFT_MARK_COLORS = [
  'ink', 'gray', 'slate', 'brown', 'red', 'orange', 'amber', 'yellow',
  'lime', 'green', 'sage', 'mint', 'teal', 'cyan', 'sky', 'blue',
  'indigo', 'violet', 'purple', 'magenta', 'pink', 'rose', 'sand', 'lavender',
] as const

export type DraftMarkColor = (typeof DRAFT_MARK_COLORS)[number]

export type DraftTextMark =
  | { type: 'bold' | 'italic' | 'strike' | 'underline' | 'code' }
  | { type: 'highlight'; color: DraftMarkColor }
  | { type: 'textColor'; color: DraftMarkColor }
  | { type: 'link'; href: string; title?: string | null }

export type ExternalEditProposalOp =
  | { kind: 'strReplace'; old: string; new: string; nth?: number; all?: boolean }
  | {
      kind: 'markText'
      find: string
      mark: DraftTextMark
      op: 'add' | 'remove'
      all?: boolean
      isRegex?: boolean
      withinRef?: string
    }
  | { kind: 'insertAfterLine'; line: number; markdown: string }
  | { kind: 'appendSection'; markdown: string }
  | { kind: 'setTitle'; title: string }
  | { kind: 'deleteBlock'; blockId: string }
  | { kind: 'deleteListItem'; blockId: string }
  | { kind: 'insertAfterBlock'; blockId: string; markdown: string }

export interface ExternalReviewCommitRequest {
  expectedDocVersion: number
  action: 'accept_all' | 'reject_all'
  turnId?: string
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
