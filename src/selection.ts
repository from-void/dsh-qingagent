import type { QingSelection } from './contracts.js'

export function selectionSystemPrompt(selection: QingSelection | undefined): string {
  if (!selection) return ''
  return `用户在青简文稿 ${selection.engineSessionId} 中选中了这段文字:「${selection.quote}」(块 ${selection.anchor.blockId})。用户接下来的指令若是修改要求,请针对该选段处理,其余内容保持不动。`
}
