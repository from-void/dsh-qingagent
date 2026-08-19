import { describe, expect, it } from 'vitest'
import type { PmDoc } from '../src/contracts.js'
import { planDocumentReveal } from '../src/client/documentReveal.js'
import {
  DEFAULT_REVEAL_CHARS_PER_TICK,
  DEFAULT_REVEAL_CONCURRENCY,
  DEFAULT_REVEAL_STEP_DELAY_MS,
  DEFAULT_REVEAL_TAIL_HOLD_MS,
  planRevealTypewriter,
  revealNewPartLen,
} from '../src/client/revealTypewriter.js'

describe('纸面 reveal 调度', () => {
  it('保持钉扎客户端的并发打字头语义与默认参数', () => {
    expect({
      concurrency: DEFAULT_REVEAL_CONCURRENCY,
      delay: DEFAULT_REVEAL_STEP_DELAY_MS,
      chars: DEFAULT_REVEAL_CHARS_PER_TICK,
      tail: DEFAULT_REVEAL_TAIL_HOLD_MS,
    }).toEqual({ concurrency: 5, delay: 20, chars: 1, tail: 390 })
    expect(revealNewPartLen('甲', '甲🙂')).toBe(1)

    const frames = planRevealTypewriter(['a', 'b'], (id) => id === 'a' ? 2 : 1, 1, 1)
    expect(frames).toEqual([
      { revealed: ['a'], typed: [['a', 0]], cursors: [{ id: 'a', lane: 1 }] },
      { revealed: ['a'], typed: [['a', 1]], cursors: [{ id: 'a', lane: 1 }] },
      { revealed: ['a', 'b'], typed: [['a', 2], ['b', 0]], cursors: [{ id: 'b', lane: 1 }] },
      { revealed: ['a', 'b'], typed: [['a', 2], ['b', 1]], cursors: [] },
    ])
  })

  it('把完整 PM 文档规划为逐字帧，新字符产出 native charEnters 等价范围', () => {
    const doc = {
      type: 'doc',
      attrs: { schemaVersion: 1 },
      content: [
        { type: 'paragraph', attrs: { blockId: 'a' }, content: [{ type: 'text', text: '甲乙' }] },
        { type: 'paragraph', attrs: { blockId: 'b' }, content: [{ type: 'text', text: '丙' }] },
      ],
    } as PmDoc

    const frames = planDocumentReveal(doc, 1, 1)
    expect(frames).toHaveLength(4)
    expect(frames[0]?.pmDoc.content).toEqual([
      { type: 'paragraph', attrs: { blockId: 'a' }, content: [] },
    ])
    expect(frames[1]?.charEnters).toEqual([{ from: 1, to: 2 }])
    expect(frames[2]?.charEnters).toEqual([{ from: 2, to: 3 }])
    expect(frames.at(-1)?.pmDoc).toEqual(doc)
    expect(frames.at(-1)?.charEnters).toEqual([{ from: 5, to: 6 }])
  })
})
