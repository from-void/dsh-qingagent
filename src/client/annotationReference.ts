import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  InputTriggerSource,
  ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  CHIP_LABEL_PREVIEW_LENGTH,
  QING_SELECTION_REFERENCE_SOURCE,
  selectionReferenceLabel,
} from './selectionReference.js'

export const QING_ANNOTATION_REFERENCE_SOURCE = 'qingagent-annotation'

type SessionInput = ReturnType<IConversation['input']['for']>
export type InputState = ReturnType<SessionInput['state']['getSnapshot']>

function previewLabel(text: string): string {
  const plain = text.replace(/\s+/g, ' ').trim()
  return plain.length > CHIP_LABEL_PREVIEW_LENGTH
    ? `${plain.slice(0, CHIP_LABEL_PREVIEW_LENGTH)}…`
    : plain
}

/** 批注 chip 只展示短摘要，完整修改指令保存在 ref 中。 */
export function annotationReferenceLabel(instruction: string): string {
  const summary = instruction.replace(/\s+/g, ' ').trim()
  return previewLabel(`按批注修改:${summary}`)
}

function createAnnotationReference(instruction: string): ReferenceInsert {
  return {
    source: QING_ANNOTATION_REFERENCE_SOURCE,
    ref: instruction,
    label: annotationReferenceLabel(instruction),
    clipboardText: instruction,
  }
}

/** 在当前草稿末尾追加一枚批注 chip；同一指令可按用户操作重复追加。 */
export function insertAnnotationReference(
  actx: ClientContext,
  instruction: string,
): boolean {
  const snapshot = actx.conversation.input.for(actx).state.getSnapshot()
  const offset = snapshot.draft.length
  return actx.bail(actx, 'slash/input-insert-reference', {
    reference: createAnnotationReference(instruction),
    span: {
      start: offset,
      end: offset,
      draftRev: snapshot.draftRev,
    },
  }) === true
}

/** 批注 occurrence 提交时将完整修改指令原样展开。 */
export const qingAnnotationReferenceSource: InputTriggerSource = {
  trigger: '@',
  name: QING_ANNOTATION_REFERENCE_SOURCE,
  order: Number.MAX_SAFE_INTEGER,
  candidates: async () => [],
  onPick: () => undefined,
  codec: {
    clipboardText: (ref) => ref,
    serialize: async (ref) => ref,
  },
}

/**
 * 宿主版本可能把 occurrence 投影成单个 U+FFFC，也可能投影成 @label 文本；
 * 只接受 offset 处的精确形态，避免错删用户正文。
 */
export function findOccurrenceProjection(
  state: InputState,
  occurrenceId: number,
): { start: number; end: number } | undefined {
  const occurrence = state.occurrences.find((candidate) =>
    candidate.occurrenceId === occurrenceId)
  if (!occurrence) return undefined

  const start = occurrence.offset
  if (!Number.isSafeInteger(start) || start < 0 || start >= state.draft.length) return undefined
  if (state.draft[start] === '\uFFFC') return { start, end: start + 1 }

  const projection = `@${occurrence.label}`
  if (!state.draft.startsWith(projection, start)) return undefined
  const projectionEnd = start + projection.length
  return {
    start,
    end: projectionEnd + (state.draft[projectionEnd] === ' ' ? 1 : 0),
  }
}

/** 仅在普通输入阶段删除已精确定位的 occurrence 投影。 */
export function removeOccurrenceFromDraft(
  actx: ClientContext,
  occurrenceId: number,
): boolean {
  const input = actx.conversation.input.for(actx)
  const snapshot = input.state.getSnapshot()
  if (snapshot.phase !== 'plain') return false
  const projection = findOccurrenceProjection(snapshot, occurrenceId)
  if (!projection) return false

  input.setDraft(
    snapshot.draft.slice(0, projection.start) + snapshot.draft.slice(projection.end),
  )
  return true
}

function replacementReference(
  source: string,
  newRef: string,
): ReferenceInsert | undefined {
  if (source === QING_ANNOTATION_REFERENCE_SOURCE) {
    return createAnnotationReference(newRef)
  }
  if (source === QING_SELECTION_REFERENCE_SOURCE) {
    return {
      source,
      ref: newRef,
      label: selectionReferenceLabel(newRef),
      clipboardText: newRef,
    }
  }
  return undefined
}

/**
 * 原位替换 occurrence。先删除旧投影，再用删除后的 draftRev 插入新引用；插入失败时
 * 优先通过旧 reference 重建 occurrence，若宿主拒绝重建则至少恢复原草稿文本。
 */
export function replaceOccurrenceRef(
  actx: ClientContext,
  occurrenceId: number,
  newRef: string,
): boolean {
  const input = actx.conversation.input.for(actx)
  const before = input.state.getSnapshot()
  if (before.phase !== 'plain') return false

  const occurrence = before.occurrences.find((candidate) =>
    candidate.occurrenceId === occurrenceId)
  const projection = findOccurrenceProjection(before, occurrenceId)
  if (!occurrence || !projection) return false
  const reference = replacementReference(occurrence.source, newRef)
  if (!reference) return false

  const withoutOccurrence = before.draft.slice(0, projection.start)
    + before.draft.slice(projection.end)
  input.setDraft(withoutOccurrence)
  const afterDelete = input.state.getSnapshot()
  if (afterDelete.phase !== 'plain' || afterDelete.draft !== withoutOccurrence) {
    return false
  }

  const inserted = actx.bail(actx, 'slash/input-insert-reference', {
    reference,
    span: {
      start: projection.start,
      end: projection.start,
      draftRev: afterDelete.draftRev,
    },
  }) === true
  if (inserted) return true

  const rollbackState = input.state.getSnapshot()
  if (rollbackState.phase === 'plain' && rollbackState.draft === withoutOccurrence) {
    const restored = actx.bail(actx, 'slash/input-insert-reference', {
      reference: {
        source: occurrence.source,
        ref: occurrence.ref,
        label: occurrence.label,
        clipboardText: occurrence.clipboardText,
      },
      span: {
        start: projection.start,
        end: projection.start,
        draftRev: rollbackState.draftRev,
      },
    }) === true
    if (!restored) input.setDraft(before.draft)
  }
  return false
}
