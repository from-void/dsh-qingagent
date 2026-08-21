import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InsertReferenceRequest } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { describe, expect, it, vi } from 'vitest'
import {
  annotationReferenceLabel,
  findOccurrenceProjection,
  insertAnnotationReference,
  type InputState,
  QING_ANNOTATION_REFERENCE_SOURCE,
  qingAnnotationReferenceSource,
  removeOccurrenceFromDraft,
  replaceOccurrenceRef,
} from '../src/client/annotationReference.js'
import {
  CHIP_LABEL_PREVIEW_LENGTH,
  QING_SELECTION_REFERENCE_SOURCE,
} from '../src/client/selectionReference.js'

type Occurrence = InputState['occurrences'][number]

function occurrence(
  occurrenceId: number,
  offset: number,
  label: string,
  options: Partial<Occurrence> = {},
): Occurrence {
  return {
    occurrenceId,
    source: QING_ANNOTATION_REFERENCE_SOURCE,
    ref: `完整指令-${occurrenceId}`,
    offset,
    label,
    clipboardText: `完整指令-${occurrenceId}`,
    ...options,
  }
}

function inputState(
  draft: string,
  occurrences: readonly Occurrence[],
  phase: InputState['phase'] = 'plain',
  draftRev = 10,
): InputState {
  return {
    draft,
    draftRev,
    phase,
    occurrences,
    imageIds: [],
    queue: [],
  }
}

function contextHarness(
  initial: InputState,
  onBail: (request: InsertReferenceRequest, call: number) => true | undefined = () => true,
) {
  let state = initial
  let bailCalls = 0
  const setDraft = vi.fn((draft: string) => {
    state = { ...state, draft, draftRev: state.draftRev + 1 }
  })
  const bail = vi.fn((subject, event: string, request: InsertReferenceRequest) => {
    expect(subject).toBe(actx)
    expect(event).toBe('slash/input-insert-reference')
    bailCalls += 1
    return onBail(request, bailCalls)
  })
  const actx = {
    bail,
    conversation: {
      input: {
        for: (subject: unknown) => {
          expect(subject).toBe(actx)
          return {
            state: { getSnapshot: () => state },
            setDraft,
          }
        },
      },
    },
  } as unknown as ClientContext
  return {
    actx,
    bail,
    getState: () => state,
    setDraft,
    updateState: (next: InputState) => { state = next },
  }
}

describe('批注 reference 标签与 source', () => {
  it('选区与批注共享 12 字预览预算,批注标签只取修改方向(用户裁定「批注:{方向}」)', () => {
    expect(CHIP_LABEL_PREVIEW_LENGTH).toBe(12)
    expect(annotationReferenceLabel('  修改\n语气  ')).toBe('批注：修改 语气')
    expect(annotationReferenceLabel('按批注修改：预算无上限——补上单月上限与审批人并说明流程（原文：『按实际发生结算。』）'))
      .toBe('批注：补上单月上限与审批人并说…')
    expect(annotationReferenceLabel('请把这一段文字改得更加准确一些'))
      .toBe('批注：请把这一段文字改得更加准…')
  })

  it('source 使用 @ 触发并把完整 ref 恒等展开', async () => {
    expect(qingAnnotationReferenceSource).toMatchObject({
      trigger: '@',
      name: QING_ANNOTATION_REFERENCE_SOURCE,
    })
    const codec = qingAnnotationReferenceSource.codec!
    expect(codec.clipboardText('完整修改指令')).toBe('完整修改指令')
    await expect(codec.serialize('完整修改指令', new AbortController().signal))
      .resolves.toBe('完整修改指令')
  })

  it('在草稿末尾插入完整指令，且不对相同 ref 做幂等去重', () => {
    const harness = contextHarness(inputState('请', [], 'plain', 7))

    expect(insertAnnotationReference(harness.actx, '改准事实')).toBe(true)
    expect(insertAnnotationReference(harness.actx, '改准事实')).toBe(true)
    expect(harness.bail).toHaveBeenCalledTimes(2)
    expect(harness.bail.mock.calls[0]?.[2]).toEqual({
      reference: {
        source: QING_ANNOTATION_REFERENCE_SOURCE,
        ref: '改准事实',
        label: '①批注：改准事实',
        clipboardText: '改准事实',
      },
      span: { start: 1, end: 1, draftRev: 7 },
    })
  })
})

describe('occurrence 投影数学', () => {
  it('精确定位首尾及相邻的 U+FFFC 单字符投影', () => {
    const state = inputState('\uFFFC\uFFFC', [
      occurrence(1, 0, '首个'),
      occurrence(2, 1, '末个'),
    ])

    expect(findOccurrenceProjection(state, 1)).toEqual({ start: 0, end: 1 })
    expect(findOccurrenceProjection(state, 2)).toEqual({ start: 1, end: 2 })
  })

  it('精确定位相邻 @label 多字符投影，且不吞尾随空格', () => {
    const firstLabel = '[甲].*?+$^(){}|\\'
    const secondLabel = '末个?[]'
    const firstProjection = `@${firstLabel}`
    const secondProjection = `@${secondLabel}`
    const draft = `${firstProjection}${secondProjection}  `
    const state = inputState(draft, [
      occurrence(3, 0, firstLabel),
      occurrence(4, firstProjection.length, secondLabel),
    ])

    expect(findOccurrenceProjection(state, 3)).toEqual({
      start: 0,
      end: firstProjection.length,
    })
    expect(findOccurrenceProjection(state, 4)).toEqual({
      start: firstProjection.length,
      // 不吞尾随空格:删除后残留空格是 diff 前缀破缺防线。
      end: firstProjection.length + secondProjection.length,
    })
  })

  it('offset 处不匹配时返回 undefined，绝不搜索别处的相同 label', () => {
    const label = '特殊.*[内容]'
    const draft = `前文 @${label} `
    const state = inputState(draft, [occurrence(5, 0, label)])

    expect(findOccurrenceProjection(state, 5)).toBeUndefined()
    expect(findOccurrenceProjection(state, 999)).toBeUndefined()
  })
})

describe('occurrence 草稿操作', () => {
  it.each([
    // U+FFFC 单字符投影本就无尾随空格;@label 形态保留尾随空格(diff 前缀破缺防线)。
    ['U+FFFC', '头\uFFFC尾', occurrence(10, 1, '旧标签'), '头尾'],
    ['@label', '头@旧[标].*? 尾', occurrence(10, 1, '旧[标].*?'), '头 尾'],
  ])('removeOccurrenceFromDraft 删除 %s 精确投影', (_shape, draft, target, expected) => {
    const harness = contextHarness(inputState(draft, [target]))

    expect(removeOccurrenceFromDraft(harness.actx, 10)).toBe(true)
    expect(harness.setDraft).toHaveBeenCalledOnce()
    expect(harness.getState().draft).toBe(expected)
  })

  it.each(['adjudicating', 'claimed', 'submitting'] as const)(
    'phase=%s 时拒绝删除和替换且不碰草稿',
    (phase) => {
      const target = occurrence(11, 0, '旧标签')
      const removeHarness = contextHarness(inputState('\uFFFC', [target], phase))
      const replaceHarness = contextHarness(inputState('\uFFFC', [target], phase))

      expect(removeOccurrenceFromDraft(removeHarness.actx, 11)).toBe(false)
      expect(replaceOccurrenceRef(replaceHarness.actx, 11, '新指令')).toBe(false)
      expect(removeHarness.setDraft).not.toHaveBeenCalled()
      expect(replaceHarness.setDraft).not.toHaveBeenCalled()
      expect(replaceHarness.bail).not.toHaveBeenCalled()
    },
  )

  it('定位失败时删除和替换都返回 false，绝不猜测删除字符', () => {
    const target = occurrence(12, 0, '正确标签')
    const removeHarness = contextHarness(inputState('@错误标签 ', [target]))
    const replaceHarness = contextHarness(inputState('@错误标签 ', [target]))

    expect(removeOccurrenceFromDraft(removeHarness.actx, 12)).toBe(false)
    expect(replaceOccurrenceRef(replaceHarness.actx, 12, '新指令')).toBe(false)
    expect(removeHarness.setDraft).not.toHaveBeenCalled()
    expect(replaceHarness.setDraft).not.toHaveBeenCalled()
  })

  it.each([
    ['U+FFFC', '前\uFFFC后', occurrence(20, 1, '旧标签'), '前后'],
    ['@label', '前@旧标签 后', occurrence(20, 1, '旧标签'), '前 后'],
  ])('replaceOccurrenceRef 原位替换 %s 投影并使用删除后的 draftRev', (_shape, draft, target, afterDelete) => {
    const harness = contextHarness(inputState(draft, [target], 'plain', 30))

    expect(replaceOccurrenceRef(harness.actx, 20, '请改为新事实')).toBe(true)
    expect(harness.setDraft).toHaveBeenCalledWith(afterDelete)
    expect(harness.bail).toHaveBeenCalledOnce()
    expect(harness.bail.mock.calls[0]?.[2]).toEqual({
      reference: {
        source: QING_ANNOTATION_REFERENCE_SOURCE,
        ref: '请改为新事实',
        label: '①批注：请改为新事实',
        clipboardText: '请改为新事实',
      },
      span: { start: 1, end: 1, draftRev: 31 },
    })
  })

  it('按 selection source 重算新 label，未知 source 则安全拒绝', () => {
    const selection = occurrence(21, 0, '旧选段', {
      source: QING_SELECTION_REFERENCE_SOURCE,
    })
    const selectionHarness = contextHarness(inputState('\uFFFC', [selection]))

    expect(replaceOccurrenceRef(
      selectionHarness.actx,
      21,
      '一二三四五六七八九十一二三四五六',
    )).toBe(true)
    expect(selectionHarness.bail.mock.calls[0]?.[2].reference.label)
      .toBe('①选段：一二三四五六七八九十一二…')

    const foreign = occurrence(22, 0, '外部', { source: 'foreign-source' })
    const foreignHarness = contextHarness(inputState('\uFFFC', [foreign]))
    expect(replaceOccurrenceRef(foreignHarness.actx, 22, '不可替换')).toBe(false)
    expect(foreignHarness.setDraft).not.toHaveBeenCalled()
    expect(foreignHarness.bail).not.toHaveBeenCalled()
  })

  it('新 reference 插入失败时用原 occurrence 回滚草稿', () => {
    const target = occurrence(23, 1, '旧标签', {
      ref: '旧完整指令',
      clipboardText: '旧完整指令',
    })
    let harness: ReturnType<typeof contextHarness>
    harness = contextHarness(
      inputState('前@旧标签 后', [target], 'plain', 50),
      (request, call) => {
        if (call === 1) return undefined
        const current = harness.getState()
        const projection = `@${request.reference.label} `
        harness.updateState({
          ...current,
          draft: current.draft.slice(0, request.span.start)
            + projection
            + current.draft.slice(request.span.end),
          draftRev: current.draftRev + 1,
        })
        return true
      },
    )

    expect(replaceOccurrenceRef(harness.actx, 23, '新指令')).toBe(false)
    expect(harness.bail).toHaveBeenCalledTimes(2)
    // 删除保留尾随空格,回滚重插的投影自带一个空格 → 双空格是预期残留(载荷安全优先)。
    expect(harness.bail.mock.calls[1]?.[2].reference).toEqual({
      source: QING_ANNOTATION_REFERENCE_SOURCE,
      ref: '旧完整指令',
      label: '旧标签',
      clipboardText: '旧完整指令',
    })
    expect(harness.getState().draft).toBe('前@旧标签  后')
  })
})


describe('dedupeAnnotationLabel', () => {
  it('序号前置,任意两枚 label 首字符即分叉(互不为前缀)', async () => {
    const { dedupeAnnotationLabel } = await import('../src/client/annotationReference.js')
    const first = dedupeAnnotationLabel('按批注修改:活动时间…', [])
    expect(first).toBe('①按批注修改:活动时间…')
    const second = dedupeAnnotationLabel('按批注修改:活动时间…', [first])
    expect(second).toBe('②按批注修改:活动时间…')
    // 互不为前缀:首字符不同
    expect(second.startsWith(first)).toBe(false)
    expect(first.startsWith(second)).toBe(false)
    const third = dedupeAnnotationLabel('别的指令', [first, second])
    expect(third.charAt(0)).toBe('③')
  })
})
