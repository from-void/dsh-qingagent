import type { ComponentType, ForwardRefExoticComponent, RefAttributes } from 'react'
import type { DocSuggestion, PmDoc } from '@qingagent/contract-ts'

/** declaration-only facade；运行时由 tsdown alias 直连青简源码。 */
export interface DocumentSnapshotViewHandle {
  getInnerHtml(): string
  getLastPresentationRun(): unknown
  hasLocalDocumentChanges(): boolean
  canSafelyApplyIncomingDocument(doc: PmDoc): boolean
  compareIncomingDocument(doc: PmDoc): 'equivalent' | 'different' | 'unavailable'
  flushPendingDocSave(): Promise<void>
}
export const DocumentSnapshotView: ForwardRefExoticComponent<
  Record<string, unknown> & RefAttributes<DocumentSnapshotViewHandle>
>
export interface PatchNavProps {
  remainingCount: number
  totalCount: number
  activePatchIndex: number
  isSubmitting?: boolean
  retryOnly?: boolean
  unrenderableOnly?: boolean
  onJumpPrev: () => void
  onJumpNext: () => void
  onRejectAll: () => void
  onCommit: () => void | Promise<void>
}
export const PatchNav: ComponentType<PatchNavProps>
export interface DocWriteBaseline {
  expectedDocumentSnapshot: number
  baseContentHash: string
  baseHasSubstantiveContent: boolean
}
export type KnownDocVersionOrigin = 'selfWrite' | 'streamApply' | 'streamConflict'
export interface KnownDocVersion {
  baseline: DocWriteBaseline
  origin: KnownDocVersionOrigin
}
export interface KnownDocVersionLedger {
  remember(baseline: DocWriteBaseline, origin: KnownDocVersionOrigin): void
  get(version: number): KnownDocVersion | null
  clear(): void
  readonly size: number
}
export function createKnownDocVersionLedger(capacity?: number): KnownDocVersionLedger
export function appliedDocWriteBaseline(input: {
  version: number
  pmDoc: PmDoc
  contentHash?: string
}): DocWriteBaseline
export function resolveDocWriteConflict(input: {
  conflict: { expectedDocumentSnapshot: number; actualDocumentSnapshot: number } | null
  isLatestOwnMutation: boolean
  hasSubmittedDoc: boolean
  knownActualVersion: KnownDocVersion | null
  replayedAgainstActual: boolean
  replayDepth: number
  maxReplayDepth?: number
}): { kind: 'silentReplay'; baseline: DocWriteBaseline } | { kind: 'surface' }
export const EMPTY_PM_DOC: PmDoc
export function pmDocToViewDocumentSnapshot(
  doc: PmDoc,
  version: number,
  ts?: string,
): { version: number; ts: string; sections: unknown[]; pmDoc: PmDoc }
export function classifyDocSaveError(error: unknown): 'transient' | 'fatal'
export const TRANSIENT_DOC_SAVE_TOAST: string
export function createClientMutationId(): string
export function pmDocHasSubstantiveContent(doc: PmDoc): boolean
export type DocumentFrameDecision =
  | { kind: 'apply' }
  | { kind: 'reconcile'; reason: string }
  | { kind: 'defer'; reason: string }
  | { kind: 'conflict'; reason: string }
export function decideBroadcastDocumentFrame(input: {
  frame: unknown
  editorDirty: boolean
  pendingDocWrite: boolean
  queuedDocWrite: boolean
  scheduledDocWrite: boolean
  incomingDocumentMatchesEditor?: boolean
  incomingDocumentComparisonUnavailable?: boolean
  reviewActive?: boolean
  reviewBaseVersion?: number | null
  afterDeferredDrain?: boolean
}): DocumentFrameDecision

export interface ViewDocumentSnapshot {
  version: number
  ts: string
  sections: unknown[]
  pmDoc?: PmDoc
}
export interface PatchOverlayInput {
  id: string
  [key: string]: unknown
}
export interface BlockPatchInput {
  patchId: string
  [key: string]: unknown
}
export interface AppliedPatch {
  id: string
  reviewBatchId: string
  groupMode: 'atomic' | 'independent'
  before: string
  after: string
  kind: string
  index: number
  [key: string]: unknown
}
export interface ReviewTarget {
  id: string
  patchId: string
  index: number
  kind: string
  path?: string
}
export interface PatchMeta {
  before: string
  after: string
  index: number
  [key: string]: unknown
}
export function suggestionToPatchOverlay(
  doc: ViewDocumentSnapshot | null,
  suggestion: DocSuggestion,
  order?: number,
): PatchOverlayInput | null
export function suggestionToBlockPatchInputs(
  suggestion: DocSuggestion,
  order?: number,
): BlockPatchInput[]
export function derivePatchPresentation(
  doc: ViewDocumentSnapshot,
  patches: ReadonlyArray<PatchOverlayInput>,
  blockPatches?: ReadonlyArray<BlockPatchInput>,
): {
  applied: AppliedPatch[]
  reviewTargets: ReviewTarget[]
  groups: unknown[]
  appliedGroupIds: Set<string>
  appliedIds: Set<string>
  droppedIds: string[]
  conflictIds: string[]
}
export function buildPatchMeta(applied: readonly AppliedPatch[]): Map<string, PatchMeta>
