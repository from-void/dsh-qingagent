import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InputTriggerSource,
  ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { QingSelection } from '../contracts.js'

export const QING_SELECTION_REFERENCE_SOURCE = 'qingagent-selection'

const PREVIEW_LENGTH = 20

/**
 * 模型侧的选段表示。ref 自身携带文稿、块与字符范围，不能依赖 bridge 中稍后会清掉的
 * 单槽 selection，也不能依赖只供复制/持久化的 clipboardText。
 */
export function selectionReferenceText(selection: QingSelection, title?: string | null): string {
  const documentTitle = title?.trim() || selection.engineSessionId
  const { blockId, from, to } = selection.anchor
  return `[选段] 出自《${documentTitle}》（文稿 ${selection.engineSessionId}，块 ${blockId}，范围 ${from}-${to}）：「${selection.quote}」`
}

export function selectionReferenceLabel(quote: string): string {
  const preview = quote.length > PREVIEW_LENGTH
    ? `${quote.slice(0, PREVIEW_LENGTH)}…`
    : quote
  return `选段：「${preview}」`
}

export function createSelectionReference(
  selection: QingSelection,
  title?: string | null,
): ReferenceInsert {
  const ref = selectionReferenceText(selection, title)
  return {
    source: QING_SELECTION_REFERENCE_SOURCE,
    ref,
    label: selectionReferenceLabel(selection.quote),
    // 草稿持久化、复制与 owner 暂时不可用时也保留完整选段语义。
    clipboardText: ref,
  }
}

/**
 * 选段不是 slash token，使用当前草稿末尾的合法零宽 TokenSpan。事件的同步 true 回值
 * 表示 composer 已通过 phase + draftRev CAS 并实际插入 occurrence。
 */
export function insertSelectionReference(
  actx: ClientContext,
  selection: QingSelection,
  title?: string | null,
): boolean {
  const snapshot = actx.conversation.input.for(actx).state.getSnapshot()
  const offset = snapshot.draft.length
  return actx.bail(actx, 'slash/input-insert-reference', {
    reference: createSelectionReference(selection, title),
    span: {
      start: offset,
      end: offset,
      draftRev: snapshot.draftRev,
    },
  }) === true
}

/**
 * occurrence 提交时由 composer 按 source/ref 路由到这里；ref 已经是模型需要看到的
 * 完整锚点引文，serializer 只做恒等展开。
 */
export const qingSelectionReferenceSource: InputTriggerSource = {
  trigger: '@',
  name: QING_SELECTION_REFERENCE_SOURCE,
  order: Number.MAX_SAFE_INTEGER,
  candidates: async () => [],
  onPick: () => undefined,
  codec: {
    clipboardText: (ref) => ref,
    serialize: async (ref) => ref,
  },
}
