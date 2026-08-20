import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InputTriggerSource,
  ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { QingSelection } from '../contracts.js'

export const QING_SELECTION_REFERENCE_SOURCE = 'qingagent-selection'

// 选区与批注共用同一段 chip label 预览预算，完整内容仍由 ref 与 hover 承载。
export const CHIP_LABEL_PREVIEW_LENGTH = 14

/**
 * 模型侧的选段表示。ref 自身携带文稿、块与字符范围，不能依赖 bridge 中稍后会清掉的
 * 单槽 selection，也不能依赖只供复制/持久化的 clipboardText。
 */
export function selectionReferenceText(selection: QingSelection, title?: string | null): string {
  // 展开文本会原样出现在发送气泡里:不带 UUID/块 ID/字符范围等机器噪音(用户实测嫌丑)。
  // agent 定位选段靠引文逐字匹配(strReplace 内容锚点)+当前聚焦稿,标识符本就用不上。
  const documentTitle = title?.trim() || '当前文稿'
  return `[选段]《${documentTitle}》:「${selection.quote}」`
}

export function selectionReferenceLabel(quote: string): string {
  const plain = quote.replace(/\s+/g, ' ').trim()
  return plain.length > CHIP_LABEL_PREVIEW_LENGTH
    ? `${plain.slice(0, CHIP_LABEL_PREVIEW_LENGTH)}…`
    : plain
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
  // chip 画在 pointer-events:none 的 backdrop 镜像层,鼠标事件全落在上层透明 textarea——
  // 用 mousemove 坐标命中,命中即显示自绘悬浮条(原生 title 有 ~1s 延迟,用户等不到)。
  const TIP_ID = 'qingagent-selection-tip'
  const ensureTip = (): HTMLDivElement => {
    let tip = document.getElementById(TIP_ID) as HTMLDivElement | null
    if (!tip) {
      tip = document.createElement('div')
      tip.id = TIP_ID
      tip.style.cssText = [
        'position:fixed', 'z-index:100500', 'display:none', 'pointer-events:none',
        'max-width:380px', 'padding:6px 10px', 'border-radius:8px',
        'background:var(--dsw-alias-bg-layer-3, #26282c)',
        'color:var(--dsw-alias-label-primary, #e8e8ea)',
        'border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))',
        'box-shadow:var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.35))',
        'font-size:12px', 'line-height:18px', 'white-space:pre-wrap', 'word-break:break-word',
      ].join(';')
      document.body.appendChild(tip)
    }
    return tip
  }
  const hideTip = () => {
    const tip = document.getElementById(TIP_ID)
    if (tip) tip.style.display = 'none'
  }
  let raf = 0
  const onMove = (event: MouseEvent) => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const input = (event.target as Element | null)?.closest?.('textarea')
      if (!input) return hideTip()
      const scope = input.closest('[class*="card"]') ?? input.parentElement?.parentElement
      const labels = scope ? [...scope.querySelectorAll('[class*="chipLabel"]')] : []
      let hit = -1
      let hitRect: DOMRect | undefined
      for (let index = 0; index < labels.length; index += 1) {
        const rect = labels[index]!.getBoundingClientRect()
        if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
          hit = index
          hitRect = rect
          break
        }
      }
      const occurrence = hit >= 0 ? getOccurrences()?.[hit] : undefined
      if (!occurrence || occurrence.source !== QING_SELECTION_REFERENCE_SOURCE || !hitRect) return hideTip()
      const tip = ensureTip()
      tip.textContent = occurrence.ref
      tip.style.display = 'block'
      // 先摆再量:置于 chip 上方,水平钳在视口内。
      const width = Math.min(380, tip.offsetWidth || 380)
      tip.style.left = `${Math.max(8, Math.min(hitRect.left, window.innerWidth - width - 8))}px`
      tip.style.top = `${Math.max(8, hitRect.top - tip.offsetHeight - 8)}px`
    })
  }
  const onLeave = () => hideTip()
  document.addEventListener('mousemove', onMove, { capture: true, passive: true })
  document.addEventListener('mousedown', onLeave, { capture: true, passive: true })
  return () => {
    if (raf) cancelAnimationFrame(raf)
    document.removeEventListener('mousemove', onMove, { capture: true })
    document.removeEventListener('mousedown', onLeave, { capture: true })
    document.getElementById(TIP_ID)?.remove()
  }
}
