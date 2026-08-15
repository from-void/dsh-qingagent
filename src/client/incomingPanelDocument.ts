import type { DocumentSnapshotViewHandle } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import {
  decideBroadcastDocumentFrame,
  type DocumentFrameDecision,
} from '@qingweb/pages/workspace/data/docWriteResultOwnership'
import type { ExternalPmDocReadResponse } from '../contracts.js'

export interface DocumentWriteActivity {
  pendingDocWrite: boolean
  queuedDocWrite: boolean
}

export async function decideIncomingPanelDocument(input: {
  handle: DocumentSnapshotViewHandle
  panelDoc: ExternalPmDocReadResponse
  activity: () => DocumentWriteActivity
  reviewActive: boolean
  reviewBaseVersion?: number | null
  afterFlush?: () => Promise<void>
}): Promise<DocumentFrameDecision> {
  const frame = panelDocGenerationFrame(input.panelDoc)
  const decide = (afterDeferredDrain: boolean) => {
    const activity = input.activity()
    const comparison = input.panelDoc.pmDoc
      ? input.handle.compareIncomingDocument(input.panelDoc.pmDoc)
      : 'unavailable'
    return decideBroadcastDocumentFrame({
      frame,
      editorDirty: input.handle.hasLocalDocumentChanges(),
      pendingDocWrite: activity.pendingDocWrite,
      queuedDocWrite: activity.queuedDocWrite,
      scheduledDocWrite: false,
      incomingDocumentMatchesEditor: comparison === 'equivalent',
      incomingDocumentComparisonUnavailable: comparison === 'unavailable',
      reviewActive: input.reviewActive,
      reviewBaseVersion: input.reviewBaseVersion,
      afterDeferredDrain,
    })
  }

  let decision = decide(false)
  if (decision.kind !== 'defer') return decision
  await input.handle.flushPendingDocSave()
  await input.afterFlush?.()
  decision = decide(true)
  return decision
}

function panelDocGenerationFrame(panelDoc: ExternalPmDocReadResponse) {
  return {
    kind: 'docGenerationEvent',
    data: {
      kind: 'generation_finished',
      data: {
        generationId: `dsh-panel-refresh:${panelDoc.sessionId}:${panelDoc.docVersion}`,
        seq: 1,
        prevSeq: null,
        doc: panelDoc.pmDoc ?? { type: 'doc', attrs: { schemaVersion: 1 }, content: [] },
        finalVersion: panelDoc.docVersion,
        contentHash: panelDoc.contentHash,
      },
    },
  } as const
}
