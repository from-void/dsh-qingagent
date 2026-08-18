import type { DocumentSnapshotViewHandle } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import {
  decideBroadcastDocumentFrame,
  type DocumentFrameDecision,
} from '@qingweb/pages/workspace/data/docWriteResultOwnership'
import { pmDocHasSubstantiveContent } from '@qingweb/pages/workspace/data/pageExitSave'
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
  /** defer 必须先登记本会话来稿版本，再 drain 保存；否则 drain 中的 409 无法识别自产版本。 */
  onDeferred?: (panelDoc: ExternalPmDocReadResponse) => void
  afterFlush?: () => Promise<void>
}): Promise<DocumentFrameDecision> {
  const frame = panelDocGenerationFrame(input.panelDoc)
  // P1 首稿宽容(K3 定案):来稿有实质内容而编辑器可见文本为空(脚手架自愈的假 dirty
  // 不应算用户内容)时直接应用,不进 defer/conflict;用户真输入过内容则照旧走冲突保护。
  if (
    input.panelDoc.pmDoc &&
    pmDocHasSubstantiveContent(input.panelDoc.pmDoc) &&
    editorVisiblyEmpty(input.handle)
  ) {
    return { kind: 'apply' } as DocumentFrameDecision
  }
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
  input.onDeferred?.(input.panelDoc)
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


function editorVisiblyEmpty(handle: DocumentSnapshotViewHandle): boolean {
  try {
    const text = handle.getInnerHtml()
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .trim()
    return text.length === 0
  } catch {
    return false
  }
}
