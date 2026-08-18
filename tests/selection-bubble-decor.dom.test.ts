// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { installSelectionBubbleDecor } from '../src/client/selectionBubbleDecor.js'

afterEach(() => {
  document.body.replaceChildren()
})

describe('对话气泡用户语言净化', () => {
  it('问卷选项生成后确定性移除 vN，并把 vN 原文改为用户语言', async () => {
    const stop = installSelectionBubbleDecor()
    const options = document.createElement('div')
    options.innerHTML = [
      '<button>v1 原文</button>',
      '<button>保留 v2 版本</button>',
      '<div role="option">采用新写法</div>',
    ].join('')
    document.body.append(options)

    await Promise.resolve()

    const labels = [...options.querySelectorAll('button, [role="option"]')]
      .map((option) => option.textContent)
    expect(labels).toEqual(['改动前的原文', '保留 改动前的版本', '采用新写法'])
    expect(labels.join(' ')).not.toMatch(/v\d+/i)
    stop()
  })
})
