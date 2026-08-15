import type { ComponentType } from 'react'
import type { PmDoc } from '@qingagent/pm-schema'

/** declaration-only facade；运行时由 tsdown alias 直连青简源码。 */
export const DocumentSnapshotView: ComponentType<Record<string, unknown>>
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
