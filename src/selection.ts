import type { QingSelection } from './contracts.js'

export function selectionSystemPrompt(selection: QingSelection | undefined): string {
  if (!selection) return ''
  return `用户在当前青简文稿中选中了这段文字:「${selection.quote}」。用户接下来的指令若是修改要求,请以这段引文定位并处理,其余内容保持不动。`
}
