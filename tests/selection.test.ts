import { describe, expect, it } from 'vitest'
import { selectionSystemPrompt } from '../src/selection.js'

describe('青简选段 system prompt', () => {
  it('没有选段时不注入动态段', () => {
    expect(selectionSystemPrompt(undefined)).toBe('')
  })

  it('存在选段时注入文稿、引文与块锚点', () => {
    expect(selectionSystemPrompt({
      dshSessionId: 'dsh-1',
      engineSessionId: 'qing-7',
      quote: '春风又绿江南岸',
      anchor: { blockId: 'block-9', from: 12, to: 20 },
    })).toBe('用户在青简文稿 qing-7 中选中了这段文字:「春风又绿江南岸」(块 block-9)。用户接下来的指令若是修改要求,请针对该选段处理,其余内容保持不动。')
  })
})
