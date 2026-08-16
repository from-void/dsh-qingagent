import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InputTriggerSource,
  ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { QingSelection } from '../contracts.js'

export const QING_SELECTION_REFERENCE_SOURCE = 'qingagent-selection'

// 宿主 chip 是定宽单字符单元(U+FFFC 专用字体),label 绝对居中 overflow:hidden 硬裁,
// 视觉预算约 6 个汉字——前缀会挤掉正文,label 只放引文头 5 字+省略号,完整内容走 hover title。
const PREVIEW_LENGTH = 5

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
  const plain = quote.replace(/\s+/g, ' ').trim()
  return plain.length > PREVIEW_LENGTH ? `${plain.slice(0, PREVIEW_LENGTH)}…` : plain
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
  const reference = createSelectionReference(selection, title)
  // 幂等守卫:bridge 状态重放/多路订阅可能对同一选段重复触发(用户实测双 chip);
  // 草稿里已有同 source+ref 的 occurrence 即视为已插入成功,由调用方清 ingress。
  if (snapshot.occurrences?.some((occurrence) =>
    occurrence.source === QING_SELECTION_REFERENCE_SOURCE && occurrence.ref === reference.ref)) {
    return true
  }
  const offset = snapshot.draft.length
  return actx.bail(actx, 'slash/input-insert-reference', {
    reference,
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

/**
 * chip hover 展示原始内容:宿主 chipLabel 定宽硬裁无 tooltip,这里以委托监听为可见 chip
 * 补 title(浏览器原生悬浮)。chip DOM 顺序与 InputState.occurrences 的 offset 顺序一致,
 * 按序配对;只给本插件来源的 occurrence 写 title(内容=完整锚点引文)。
 * 返回卸载函数,随会话作用域清理。
 */
export function installSelectionChipHoverTitles(
  getOccurrences: () => readonly { source: string; ref: string }[] | undefined,
): () => void {
  if (typeof document === 'undefined') return () => {}
  const onOver = (event: MouseEvent) => {
    const target = event.target as Element | null
    const label = target?.closest?.('[class*="chipLabel"]') as HTMLElement | null
    if (!label || label.title) return
    const container = label.closest('[class*="backdrop"]') ?? label.parentElement?.parentElement
    if (!container) return
    const labels = [...container.querySelectorAll('[class*="chipLabel"]')]
    const index = labels.indexOf(label)
    if (index < 0) return
    const occurrence = getOccurrences()?.[index]
    if (occurrence?.source === QING_SELECTION_REFERENCE_SOURCE) label.title = occurrence.ref
  }
  document.addEventListener('mouseover', onOver, { capture: true, passive: true })
  return () => document.removeEventListener('mouseover', onOver, { capture: true })
}
