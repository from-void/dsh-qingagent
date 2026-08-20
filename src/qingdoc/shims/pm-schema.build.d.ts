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

export type ReviewType =
  | 'sensitive'
  | 'deai'
  | 'source'
  | 'consistency'
  | 'privacy'
  | 'format'
  | 'role'
  | 'custom'

export interface ReviewTemplateItem {
  id: string
  type: ReviewType
  name: string
  prompt: string
  builtin: boolean
  createdAt: string
  updatedAt: string
}

export interface LexiconResourceSummary {
  id: string
  name: string
  entryCount: number
  description: string
  enabled: boolean
}

export function assembleReviewQuery(
  type: ReviewType,
  template: Pick<ReviewTemplateItem, 'id' | 'name' | 'prompt'>,
  supplement: string,
  lexicons?: ReadonlyArray<{ id: string; name: string }>,
): string

export type AiRunMark =
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'strikeThrough' | 'code' | 'math' }
  | { type: 'link'; href: string; title?: string | null }
  | { type: 'textColor' | 'highlight'; color: string }

export interface AiTextRun {
  text: string
  marks?: AiRunMark[]
}

export type AiRun =
  | AiTextRun
  | { type: 'footnote'; id?: string; note: string }

export interface AiListItem {
  runs: AiRun[]
  children?: AiBlock[]
}

export interface AiTaskListItem extends AiListItem {
  checked?: boolean
}

export interface AiTableCell {
  blocks: AiBlock[]
  header?: boolean
  backgroundColor?: string
  colspan?: number
  rowspan?: number
}

export type AiBlock =
  | { blockId?: string; type: 'paragraph'; runs: AiRun[]; textAlign?: string }
  | { blockId?: string; type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; anchor?: string | null; runs: AiRun[]; textAlign?: string }
  | { blockId?: string; type: 'penNote'; runs: AiRun[] }
  | { blockId?: string; type: 'blockquote' | 'callout'; runs?: AiRun[]; blocks?: AiBlock[]; emoji?: string | null; tone?: string | null }
  | { blockId?: string; type: 'bulletList'; items: AiListItem[] }
  | { blockId?: string; type: 'orderedList'; items: AiListItem[]; start?: number | null; listStyle?: string | null }
  | { blockId?: string; type: 'taskList'; items: AiTaskListItem[] }
  | { blockId?: string; type: 'table'; rows: Array<{ cells: AiTableCell[]; header?: boolean }> }
  | { blockId?: string; type: 'columnList'; columns: Array<{ blocks: AiBlock[]; widthRatio?: number | null }> }
  | { blockId?: string; type: 'codeBlock'; language?: string | null; text: string }
  | { blockId?: string; type: 'horizontalRule' }
  | { blockId?: string; type: 'image'; src: string; alt?: string | null; title?: string | null; caption?: string | null; width?: number | null; height?: number | null; align?: string | null }
  | { blockId?: string; type: 'fileAttachment'; fileId: string; filename: string; mimeType: string; size: number }
  | { blockId?: string; type: 'blockMath'; latex: string }
  | { blockId?: string; type: 'diagram'; lang: string; source: string; svg?: string | null }

export function qingmlParse(text: string): {
  title: string | null
  blocks: AiBlock[]
  warnings: Array<Record<string, unknown>>
}
export function aiIrToPm(input: { blocks: AiBlock[] }): PmDoc
export function pmToAiIr(doc: PmDoc): { blocks: AiBlock[] }
export function aiBlocksToQingml(blocks: ReadonlyArray<AiBlock>): string
export function countVisibleChars(text: string): number
export function countDocVisibleChars(doc: PmDoc): number
export interface PmMarkdownBlockLineSpan {
  blockIndex: number
  blockId: string
  blockType: string
  startLine: number
  contentEndLine: number
  endLine: number
}
export function pmToMarkdownWithLineMap(doc: PmDoc): {
  markdown: string
  blocks: PmMarkdownBlockLineSpan[]
}

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

export interface ExternalReviewAnchor {
  blockId: string
  pmFrom: number
  pmTo: number
  quote: string
  prefix?: string
  suffix?: string
}

export interface ExternalAnnotation {
  id: string
  summary: string
  note: string
  origin: string
  suggestion?: string
  severity?: 'error' | 'warn' | 'info'
  status: 'reviewing' | 'accepted' | 'ignored'
  anchors: ExternalReviewAnchor[]
}

export interface AnnotationGroup extends ExternalAnnotation {
  anchors: Array<ExternalReviewAnchor & { textHash: string }>
}

export interface ExternalPmDocReadResponse {
  sessionId: string
  docVersion: number
  contentHash: string
  state: 'empty' | 'editing' | 'pendingReview'
  agentBusy: boolean
  title: string | null
  ts: string
  charCount: number
  pmDoc: PmDoc | null
}

export interface ExternalDocReplaceRequest {
  expectedDocumentSnapshot: number
  baseContentHash: string
  clientMutationId: string
  doc: PmDoc
}

export type ExternalDocReplaceResponse =
  | { ok: true; clientMutationId: string; docVersion: number; contentHash: string; ts: string; charCount: number }
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
  annotations?: ExternalAnnotation[]
}

export interface ExternalAnnotationIgnoreRequest {
  expectedDocVersion: number
  annotationIds: string[]
}

export interface ExternalAnnotationIgnoreResponse {
  status: 'ignored'
  annotationIds: string[]
  remainingAnnotationCount: number
  seq: number | null
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
