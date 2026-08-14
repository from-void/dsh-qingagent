import { describe, expect, it } from 'vitest'
import { completeTopLevelBlocks, countWords, outlineOf } from '../src/qingml.js'

describe('QingML 流边界与摘要', () => {
  it('只发布已经闭合的顶层块', () => {
    const partial = '<title>题</title><h1>章</h1><p>未完成'
    expect(completeTopLevelBlocks(partial).blocks).toEqual(['<title>题</title>', '<h1>章</h1>'])
    expect(completeTopLevelBlocks(`${partial}</p>`).blocks).toHaveLength(3)
  })

  it('生成标题层级、节首句和中英文字数', () => {
    const qingml = '<title>测试稿</title><h1>第一章</h1><p>这是首句。还有一句。</p><h2>English</h2><p>Hello world.</p>'
    const outline = outlineOf(qingml)
    expect(outline.title).toBe('测试稿')
    expect(outline.blocks).toBe(4)
    expect(outline.headings[0]).toMatchObject({ level: 1, text: '第一章', firstSentence: '这是首句。' })
    expect(countWords(qingml)).toBeGreaterThan(10)
  })
})
