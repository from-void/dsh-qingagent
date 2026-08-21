// @vitest-environment jsdom

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InsertReferenceRequest,
  ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { describe, expect, it, vi } from 'vitest'
import type { QingSelection } from '../src/contracts.js'
import {
  insertSelectionReference,
  qingSelectionReferenceSource,
  selectionReferenceText,
} from '../src/client/selectionReference.js'

interface MockOccurrence {
  offset: number
  reference: ReferenceInsert
}

describe('青简选段 inline reference chip', () => {
  it('用当前 draftRev 的末尾零宽 span 插入 N 枚 chip，并在提交时展开完整锚点引文', async () => {
    let draft = '请分别润色：'
    let draftRev = 7
    const occurrences: MockOccurrence[] = []
    const payloads: InsertReferenceRequest[] = []
    const inputState = {
      getSnapshot: () => ({ draft, draftRev }),
    }
    const bail = vi.fn((subject, event: string, request: InsertReferenceRequest) => {
      expect(subject).toBe(actx)
      expect(event).toBe('slash/input-insert-reference')
      payloads.push(request)

      // dsh InputMachine.replaceSpanWithChip 的测试替身：把 span 换成 U+FFFC，
      // 尾部没有空格时追加分隔空格，并记录 occurrence。
      expect(request.span.draftRev).toBe(draftRev)
      expect(request.span.start).toBe(request.span.end)
      const tail = draft.slice(request.span.end)
      const inserted = `\uFFFC${tail.length === 0 || tail[0] !== ' ' ? ' ' : ''}`
      occurrences.push({ offset: request.span.start, reference: request.reference })
      draft = draft.slice(0, request.span.start) + inserted + tail
      draftRev += 1
      return true
    })
    const actx = {
      bail,
      conversation: {
        input: {
          for: (candidate: unknown) => {
            expect(candidate).toBe(actx)
            return { state: inputState }
          },
        },
      },
    } as unknown as ClientContext

    const selections: QingSelection[] = [
      {
        dshSessionId: 'dsh-chip',
        engineSessionId: 'qing-doc',
        quote: '春风又绿江南岸',
        anchor: { blockId: 'block-9', from: 12, to: 20 },
      },
      {
        dshSessionId: 'dsh-chip',
        engineSessionId: 'qing-doc',
        quote: '明月何时照我还',
        anchor: { blockId: 'block-12', from: 31, to: 39 },
      },
    ]

    expect(insertSelectionReference(actx, selections[0]!, '泊船瓜洲')).toBe(true)
    expect(insertSelectionReference(actx, selections[1]!, '泊船瓜洲')).toBe(true)

    expect(payloads).toHaveLength(2)
    expect(payloads[0]).toMatchObject({
      span: { start: 6, end: 6, draftRev: 7 },
      reference: {
        source: 'qingagent-selection',
        label: '春风又绿江南岸',
      },
    })
    expect(payloads[1]?.span).toEqual({ start: 8, end: 8, draftRev: 8 })
    expect(draft.match(/\uFFFC/g)).toHaveLength(2)

    const codec = qingSelectionReferenceSource.codec!
    const parts = await Promise.all(occurrences.map(async (occurrence) => ({
      offset: occurrence.offset,
      text: await codec.serialize(occurrence.reference.ref, new AbortController().signal),
    })))
    let submitted = ''
    let cursor = 0
    for (const part of parts) {
      submitted += draft.slice(cursor, part.offset) + part.text
      cursor = part.offset + 1
    }
    submitted += draft.slice(cursor)

    expect(submitted).toBe(
      `请分别润色：${selectionReferenceText(selections[0]!, '泊船瓜洲')} `
      + `${selectionReferenceText(selections[1]!, '泊船瓜洲')} `,
    )
    expect(payloads[0]?.reference.clipboardText).toBe(payloads[0]?.reference.ref)
    expect(payloads[1]?.reference.clipboardText).toBe(payloads[1]?.reference.ref)
  })
})

describe('resolveSelectionTitle 切稿竞态', () => {
  it('activeDoc 尚是刚切出的稿时,不得借用其标题(以 activeDoc.sessionId 为准)', async () => {
    const { resolveSelectionTitle } = await import('../src/client/selectionReference.js')
    // 切稿 A→B→A 窗口期:activeEngineSessionId 已回 A,activeDoc 还是 B 的
    const snapshot = {
      activeDoc: { sessionId: 'doc-b', title: '刚切出的席2稿' },
      state: { binding: { docs: [
        { engineSessionId: 'doc-a', title: '主稿' },
        { engineSessionId: 'doc-b', title: '刚切出的席2稿' },
      ] } },
    }
    expect(resolveSelectionTitle(snapshot, 'doc-a')).toBe('主稿')
    expect(resolveSelectionTitle(snapshot, 'doc-b')).toBe('刚切出的席2稿')
    expect(resolveSelectionTitle({ ...snapshot, state: undefined }, 'doc-a')).toBeUndefined()
  })
})

describe('blockContainsId 嵌套块段号', () => {
  it('列表项/表格单元格等嵌套 blockId 按包含它的顶层块计序', async () => {
    const { blockContainsId } = await import('../src/client/selectionReference.js')
    const doc = [
      { attrs: { blockId: 'p1' } },
      { attrs: { blockId: 'ul1' }, content: [
        { attrs: { blockId: 'li1' }, content: [{ attrs: { blockId: 'li1p' } }] },
        { attrs: { blockId: 'li2' } },
      ] },
      { attrs: { blockId: 'p2' } },
    ]
    expect(doc.findIndex((b) => blockContainsId(b, 'li1p'))).toBe(1)
    expect(doc.findIndex((b) => blockContainsId(b, 'p2'))).toBe(2)
    expect(doc.findIndex((b) => blockContainsId(b, 'nope'))).toBe(-1)
  })
})
