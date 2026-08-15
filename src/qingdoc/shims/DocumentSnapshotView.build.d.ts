import type { ComponentType } from 'react'
import type { DocSuggestion, PmDoc } from '@qingagent/contract-ts'

/** declaration-only facade；运行时由 tsdown alias 直连青简源码。 */
export const DocumentSnapshotView: ComponentType<Record<string, unknown>>
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
