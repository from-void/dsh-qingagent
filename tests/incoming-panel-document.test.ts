import { describe, expect, it, vi } from 'vitest'
import type { DocumentSnapshotViewHandle } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import {
  appliedDocWriteBaseline,
  createKnownDocVersionLedger,
} from '@qingweb/pages/workspace/data/docWriteBaseline'
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
      agentBusy: false, title: 'Agent 稿', ts: 't2', charCount: 8, pmDoc: incomingPm,
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

  it('pendingDocWrite defer 在 flush 前把 incoming 版本登记进账本', async () => {
    let pendingDocWrite = true
    const ledger = createKnownDocVersionLedger()
    const panelDoc = {
      sessionId: 'qing-1', docVersion: 9, contentHash: 'hash-9', state: 'editing',
      agentBusy: false, title: 'Agent 稿', ts: 't9', charCount: 8, pmDoc: incomingPm,
    } satisfies ExternalPmDocReadResponse
    const flushPendingDocSave = vi.fn(async () => {
      expect(ledger.get(9)).toMatchObject({ origin: 'streamConflict' })
      pendingDocWrite = false
    })
    const handle = {
      getInnerHtml: () => '已有正文',
      hasLocalDocumentChanges: () => false,
      compareIncomingDocument: () => 'equivalent',
      flushPendingDocSave,
    } as unknown as DocumentSnapshotViewHandle

    const decision = await decideIncomingPanelDocument({
      handle,
      panelDoc,
      activity: () => ({ pendingDocWrite, queuedDocWrite: false }),
      reviewActive: false,
      onDeferred: (incoming) => {
        ledger.remember(appliedDocWriteBaseline({
          version: incoming.docVersion,
          pmDoc: incoming.pmDoc!,
          contentHash: incoming.contentHash,
        }), 'streamConflict')
      },
    })

    expect(flushPendingDocSave).toHaveBeenCalledTimes(1)
    expect(decision).toEqual({ kind: 'apply' })
    expect(ledger.get(9)).toEqual({
      baseline: {
        expectedDocumentSnapshot: 9,
        baseContentHash: 'hash-9',
        baseHasSubstantiveContent: true,
      },
      origin: 'streamConflict',
    })
  })
})
