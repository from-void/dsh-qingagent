import { describe, expect, it } from 'vitest'
import {
  createKnownDocVersionLedger,
  resolveDocWriteConflict,
} from '@qingweb/pages/workspace/data/docWriteBaseline'

describe('docWriteBaseline 本会话来稿账本', () => {
  it('actual 版本只登记未 apply 时仍走 silentReplay，不 surface', () => {
    const ledger = createKnownDocVersionLedger()
    const incomingBaseline = {
      expectedDocumentSnapshot: 12,
      baseContentHash: 'hash-12',
      baseHasSubstantiveContent: true,
    }
    ledger.remember(incomingBaseline, 'streamConflict')

    expect(resolveDocWriteConflict({
      conflict: {
        expectedDocumentSnapshot: 10,
        actualDocumentSnapshot: 12,
      },
      isLatestOwnMutation: true,
      hasSubmittedDoc: true,
      knownActualVersion: ledger.get(12),
      replayedAgainstActual: false,
      replayDepth: 0,
    })).toEqual({ kind: 'silentReplay', baseline: incomingBaseline })
  })
})
