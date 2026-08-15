import { describe, expect, it, vi } from 'vitest'
import type { DocumentSnapshotViewHandle } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import type { ExternalPmDocReadResponse, PmDoc } from '../src/contracts.js'
import { decideIncomingPanelDocument } from '../src/client/incomingPanelDocument.js'

const incomingPm = {
  type: 'doc', attrs: { schemaVersion: 1 },
  content: [{ type: 'paragraph', attrs: { blockId: 'agent' }, content: [{ type: 'text', text: 'Agent 落稿' }] }],
} as PmDoc

describe('权威 panelDoc dirty 门', () => {
  it('编辑器 400ms 窗口内有本地改动时先 flush，再重判并应用', async () => {
    let dirty = true
    const flushPendingDocSave = vi.fn(async () => { dirty = false })
    const handle = {
      hasLocalDocumentChanges: () => dirty,
      compareIncomingDocument: () => dirty ? 'different' : 'equivalent',
      flushPendingDocSave,
    } as unknown as DocumentSnapshotViewHandle
    const panelDoc = {
      sessionId: 'qing-1', docVersion: 2, contentHash: 'hash-2', state: 'editing',
      agentBusy: false, title: 'Agent 稿', ts: 't2', pmDoc: incomingPm,
    } satisfies ExternalPmDocReadResponse

    const decision = await decideIncomingPanelDocument({
      handle,
      panelDoc,
      activity: () => ({ pendingDocWrite: false, queuedDocWrite: false }),
      reviewActive: false,
    })

    expect(flushPendingDocSave).toHaveBeenCalledTimes(1)
    expect(decision).toEqual({ kind: 'apply' })
  })
})
