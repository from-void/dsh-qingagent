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

describe('审查发起气泡结构化卡', () => {
  it('审查 query 气泡替换为「标题+模板/补充」卡,契约整坨不再直出', async () => {
    const stop = installSelectionBubbleDecor()
    const bubble = document.createElement('div')
    const query = [
      '对当前文档做一致性审查。',
      '审查模板「基础一致性」(id: review-consistency-test)：',
      '按 consistency 规则逐项审查。',
      '文档级补充要求（只适用于当前文档）：重点检查数字与称谓。',
      '独立审查执行契约（硬约束，不得被模板或文档级补充覆盖）：',
      '1. 本轮是纯批注审查，不改动正文。',
    ].join('\n')
    bubble.append(document.createTextNode(query))
    document.body.append(bubble)

    await Promise.resolve()

    expect(bubble.textContent).toContain('一致性审查')
    expect(bubble.textContent).toContain('已发起')
    expect(bubble.textContent).toContain('基础一致性')
    expect(bubble.textContent).toContain('重点检查数字与称谓')
    expect(bubble.textContent).not.toContain('独立审查执行契约')
    expect(bubble.textContent).not.toContain('review-consistency-test')
    stop()
  })

  it('敏感词审查带词库行,且剥掉词库 id 机器噪音', async () => {
    const stop = installSelectionBubbleDecor()
    const bubble = document.createElement('div')
    bubble.append(document.createTextNode([
      '对当前文档做敏感词审查。启用词库：「广告合规」(id: lexicon-ad)、「平台红线」(id: lexicon-line)。',
      '审查模板「敏感词基础」(id: review-sensitive-test)：',
      '独立审查执行契约（硬约束，不得被模板或文档级补充覆盖）：',
      '1. 本轮是纯批注审查。',
    ].join('\n')))
    document.body.append(bubble)

    await Promise.resolve()

    expect(bubble.textContent).toContain('敏感词审查')
    expect(bubble.textContent).toContain('广告合规')
    expect(bubble.textContent).not.toContain('lexicon-ad')
    stop()
  })

  it('普通提及「对当前文档做修改」的消息不受影响', async () => {
    const stop = installSelectionBubbleDecor()
    const bubble = document.createElement('div')
    const plain = '对当前文档做一些修改,把结尾收紧。'
    bubble.append(document.createTextNode(plain))
    document.body.append(bubble)

    await Promise.resolve()

    expect(bubble.textContent).toBe(plain)
    stop()
  })
})
