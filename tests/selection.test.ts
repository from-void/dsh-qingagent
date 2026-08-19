import { describe, expect, it } from 'vitest'
import { selectionSystemPrompt } from '../src/selection.js'

describe('青简选段 system prompt', () => {
  it('没有选段时不注入动态段', () => {
    expect(selectionSystemPrompt(undefined)).toBe('')
  })

  it('存在选段时只注入引文语义，不把内部文稿或内容 ID 交给模型', () => {
    const prompt = selectionSystemPrompt({
      dshSessionId: 'dsh-1',
      engineSessionId: 'qing-7',
      quote: '春风又绿江南岸',
      anchor: { blockId: 'block-9', from: 12, to: 20 },
    })
    expect(prompt).toBe('用户在当前青简文稿中选中了这段文字:「春风又绿江南岸」。用户接下来的指令若是修改要求,请以这段引文定位并处理,其余内容保持不动。')
    expect(prompt).not.toMatch(/qing-7|block-9|块/u)
  })
})
