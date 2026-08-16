export interface PmDoc {
  type: 'doc'
  attrs: { schemaVersion: 1 }
  content: Array<Record<string, unknown>>
}

export interface StyleTemplateItem {
  id: string
  dtype: string
  slot: 'layout' | 'writing' | 'instruction'
  name: string
  detail: string
  prompt: string
  builtin: boolean
}

export function qingmlParse(text: string): {
  title: string | null
  blocks: Array<Record<string, unknown>>
  warnings: Array<Record<string, unknown>>
}
export function aiIrToPm(input: { blocks: Array<Record<string, unknown>> }): PmDoc
export function pmToAiIr(doc: PmDoc): { blocks: Array<Record<string, unknown>> }
export function aiBlocksToQingml(blocks: ReadonlyArray<Record<string, unknown>>): string
export function countVisibleChars(text: string): number
export function countDocVisibleChars(doc: PmDoc): number

export interface DocSuggestion {
  id: string
  batchId?: string
  reviewBatchId?: string
  groupMode?: 'atomic' | 'independent'
  docId: string
  baseVersion: number
  baseSchemaVersion: number
  status: 'reviewing' | 'accepted' | 'rejected' | 'committed' | 'conflict' | 'ignored'
  anchor: {
    blockId: string
    pmFrom: number
    pmTo: number
    quote: string
    prefix?: string
    suffix?: string
    textHash: string
  }
  patch: { kind: 'prosemirror_steps'; steps: Array<Record<string, unknown>> }
  preview: { deleteText: string; insertText: string }
  diffHunk?: { beforeText?: string; afterText?: string; [key: string]: unknown }
  summary: string
  conflict?: Record<string, unknown>
  kind?: 'revision' | 'annotation'
}

export interface ExternalPmDocReadResponse {
  sessionId: string
  docVersion: number
  contentHash: string
  state: 'empty' | 'editing' | 'pendingReview'
  agentBusy: boolean
  title: string | null
  ts: string
  pmDoc: PmDoc | null
}

export interface ExternalDocReplaceRequest {
  expectedDocumentSnapshot: number
  baseContentHash: string
  clientMutationId: string
  doc: PmDoc
}

export type ExternalDocReplaceResponse =
  | { ok: true; clientMutationId: string; docVersion: number; contentHash: string; ts: string }
  | {
      ok: false
      clientMutationId: string
      code: 'VERSION_CONFLICT'
      conflict: { expected: number; actual: number }
      actualContentHash: string
    }

export interface ExternalReviewRenderModelResponse {
  sessionId: string
  docVersion: number
  state: 'empty' | 'editing' | 'pendingReview'
  agentBusy: boolean
  baseVersion: number
  suggestions: DocSuggestion[]
  changeRatio?: number
  wholeDocument?: boolean
  previewDoc?: PmDoc
  editedDoc?: PmDoc
}

export interface ExternalAssetUploadJsonRequest {
  filename: string
  mimeType?: string
  base64: string
}

export interface ExternalAssetUploadResponse {
  fileId: string
  filename: string
  mimeType: string
  size: number
  src: string
}
