import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  InputTriggerSource,
  ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  CHIP_LABEL_PREVIEW_LENGTH,
  unweaveAtomicLabel,
  weaveAtomicLabel,
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

/** 批注 chip 底层 label 只留修改方向本体(10 字截断):图标与「批注:」前缀由呈现层
 *  覆盖文本提供,底层越短 chip 越紧凑(用户裁定宽度自适应)。完整指令保存在 ref 中。 */
export function annotationReferenceLabel(instruction: string): string {
  const summary = instruction.replace(/\s+/g, ' ').trim()
  const body = summary
    .replace(/^按批注修改[:\uFF1A]/u, '')
    .replace(/[（(]原文[:\uFF1A]『[\s\S]*』[)）]\s*$/u, '')
    .trim()
  const direction = /^[\s\S]{1,60}?——([\s\S]+)$/u.exec(body)?.[1]?.trim() ?? body
  return previewLabel(direction)
}

const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'] as const

/** 多枚批注 chip 的投影文本必须互不为前缀:尾缀「·N」不行(@X 仍是 @X·2 的前缀),
 *  setDraft 的 diff 依旧歧义,替换某枚时会把相邻 occurrence 吞掉(评测 r2 席3 两轮实证)。
 *  改为序号前置——首字符即分叉,任意两枚互不为前缀;序号取未被占用的最小圈号。 */
export function dedupeAnnotationLabel(label: string, takenLabels: readonly string[]): string {
  const taken = new Set(takenLabels.map((existing) => unweaveAtomicLabel(existing).charAt(0)))
  const circled = CIRCLED_NUMBERS.find((mark) => !taken.has(mark)) ?? `#${takenLabels.length + 1}`
  return `${circled}${label}`
}

function createAnnotationReference(instruction: string, takenLabels: readonly string[]): ReferenceInsert {
  return {
    source: QING_ANNOTATION_REFERENCE_SOURCE,
    ref: instruction,
    label: weaveAtomicLabel(dedupeAnnotationLabel(annotationReferenceLabel(instruction), takenLabels)),
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
  const takenLabels = (snapshot.occurrences ?? []).map((occurrence) => occurrence.label)
  return actx.bail(actx, 'slash/input-insert-reference', {
    reference: createAnnotationReference(instruction, takenLabels),
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
    // end 不吞尾随空格:删除 [start,end) 后残留的空格让宿主 diff 的公共前缀在此断开——
    // 两枚投影都以 @ 开头,若把空格一并删掉,diff 前缀会吃掉后一枚的 @、把编辑窗口右移一位,
    // 后一枚 occurrence 被判进编辑区间而死亡(评测 r2 席3 三轮实证的串绑真凶)。
    end: projectionEnd,
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

  const expectedSurvivors = snapshot.occurrences
    .filter((candidate) => candidate.occurrenceId !== occurrenceId)
  input.setDraft(
    snapshot.draft.slice(0, projection.start) + snapshot.draft.slice(projection.end),
  )
  repairLostOccurrences(actx, expectedSurvivors)
  tidyWhitespaceOnlyDraft(actx)
  return true
}

/** 保底不变式:一次删除/替换只允许目标 occurrence 消亡。宿主 diff 若误伤相邻 occurrence,
 *  用死者的 source/ref/label 在其投影文本原位重建,载荷零丢失。 */
function repairLostOccurrences(
  actx: ClientContext,
  expectedSurvivors: readonly InputState['occurrences'][number][],
): void {
  const input = actx.conversation.input.for(actx)
  for (const survivor of expectedSurvivors) {
    const now = input.state.getSnapshot()
    if (now.occurrences.some((candidate) => candidate.occurrenceId === survivor.occurrenceId)) continue
    // 投影文本仍在草稿里(diff 只判了 occurrence 死亡,文本未删)时按文本位置原位重建。
    const projection = `@${survivor.label}`
    const at = now.draft.indexOf(projection)
    if (at < 0) continue
    input.setDraft(now.draft.slice(0, at) + now.draft.slice(at + projection.length))
    const cleared = input.state.getSnapshot()
    actx.bail(actx, 'slash/input-insert-reference', {
      reference: {
        source: survivor.source,
        ref: survivor.ref,
        label: survivor.label,
        clipboardText: survivor.clipboardText,
      },
      span: { start: Math.min(at, cleared.draft.length), end: Math.min(at, cleared.draft.length), draftRev: cleared.draftRev },
    })
  }
}

/** 移除/替换后草稿只剩空白时收干净(此时已无 occurrence,setDraft 无误伤面)。 */
function tidyWhitespaceOnlyDraft(actx: ClientContext): void {
  const input = actx.conversation.input.for(actx)
  const now = input.state.getSnapshot()
  if (now.phase === 'plain' && now.draft.length > 0 && now.draft.trim() === '' && now.occurrences.length === 0) {
    input.setDraft('')
  }
}

function replacementReference(
  source: string,
  newRef: string,
  takenLabels: readonly string[],
): ReferenceInsert | undefined {
  if (source === QING_ANNOTATION_REFERENCE_SOURCE) {
    return createAnnotationReference(newRef, takenLabels)
  }
  if (source === QING_SELECTION_REFERENCE_SOURCE) {
    return {
      source,
      ref: newRef,
      label: weaveAtomicLabel(dedupeAnnotationLabel(selectionReferenceLabel(newRef), takenLabels)),
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
  // 去重池排除被替换者自身:其余 occurrence 的 label 都不得与新 label 撞车(投影唯一性)。
  const takenLabels = before.occurrences
    .filter((candidate) => candidate.occurrenceId !== occurrenceId)
    .map((candidate) => candidate.label)
  const reference = replacementReference(occurrence.source, newRef, takenLabels)
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
  if (inserted) {
    repairLostOccurrences(actx, before.occurrences.filter(
      (candidate) => candidate.occurrenceId !== occurrenceId))
    return true
  }

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


const SELECTION_REMINT_PATTERN = /\[选段\]《[^《》]*》(?:第\d+段)?:「[^「」]*」/u
// 真源 buildAnnotationInstruction 的稳定尾缀「(原文:『…』)」界定指令边界;无该尾缀的少数指令不重铸。
const ANNOTATION_REMINT_PATTERN = /按批注修改[:\uFF1A][\s\S]*?[（(]原文[:\uFF1A]『[^』]*』[)）]/u

/** 刷新恢复的草稿把未发送 chip 退化成了投影全文纯文本(宿主草稿持久化只存 clipboard 投影)。
 *  识别两种形态并重铸回 occurrence chip:选段引用与批注指令。幂等:chip 镜像投影是 @label,
 *  不匹配这两个模式。返回重铸数量。 */
/** 匹配是否落在任一现有 occurrence 的投影区间内(已铸 chip 的截断 label 含「按批注修改」
 *  触发词,正则会从 label 内部起匹配、把相邻指令咬成一条——评测 r3 席3 双批注复制粘贴实证)。 */
function overlapsExistingProjection(state: InputState, start: number, end: number): boolean {
  for (const occurrence of state.occurrences ?? []) {
    const projection = findOccurrenceProjection(state, occurrence.occurrenceId)
    if (projection && start < projection.end + 1 && end > projection.start) return true
  }
  return false
}

function nextRemintMatch(state: InputState): RegExpExecArray | undefined {
  // 全局逐位扫描:跳过与现有投影重叠的伪命中,取两模式中最靠前的干净命中。
  const candidates: RegExpExecArray[] = []
  for (const source of [SELECTION_REMINT_PATTERN, ANNOTATION_REMINT_PATTERN]) {
    const scanner = new RegExp(source.source, 'gu')
    for (;;) {
      const match = scanner.exec(state.draft)
      if (!match) break
      if (!overlapsExistingProjection(state, match.index, match.index + match[0].length)) {
        candidates.push(match)
        break
      }
      scanner.lastIndex = match.index + 1
    }
  }
  return candidates.sort((a, b) => a.index - b.index)[0]
}

export function remintDraftReferences(actx: ClientContext): number {
  const input = actx.conversation.input.for(actx)
  let reminted = 0
  for (let guard = 0; guard < 12; guard += 1) {
    const state = input.state.getSnapshot()
    if (state.phase !== 'plain') return reminted
    const match = nextRemintMatch(state)
    if (!match) return reminted
    const text = match[0]
    const isSelection = match[0].startsWith('[选段]')
    const takenLabels = (state.occurrences ?? []).map((occurrence) => occurrence.label)
    const reference: ReferenceInsert = isSelection
      ? {
          source: QING_SELECTION_REFERENCE_SOURCE,
          ref: text,
          label: selectionReferenceLabel(/「([^「」]*)」/u.exec(text)?.[1] ?? text),
          clipboardText: text,
        }
      : {
          source: QING_ANNOTATION_REFERENCE_SOURCE,
          ref: text,
          label: dedupeAnnotationLabel(annotationReferenceLabel(text), takenLabels),
          clipboardText: text,
        }
    input.setDraft(state.draft.slice(0, match.index) + state.draft.slice(match.index + text.length))
    const cleared = input.state.getSnapshot()
    const at = Math.min(match.index, cleared.draft.length)
    const ok = actx.bail(actx, 'slash/input-insert-reference', {
      reference,
      span: { start: at, end: at, draftRev: cleared.draftRev },
    }) === true
    if (!ok) {
      input.setDraft(cleared.draft.slice(0, at) + text + cleared.draft.slice(at))
      return reminted
    }
    reminted += 1
  }
  return reminted
}
