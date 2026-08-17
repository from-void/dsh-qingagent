import { describe, expect, it } from 'vitest'
import { QINGML_SYSTEM, completeTopLevelBlocks, countWords, outlineOf } from '../src/qingml.js'

describe('QingML 流边界与摘要', () => {
  it('要求元数据标题与正文纸面大标题双写且文字一致', () => {
    expect(QINGML_SYSTEM).toContain('文档标题写进最前的 <title>')
    expect(QINGML_SYSTEM).toContain('同时在正文开头写一个文字完全一致的 <h1> 作为纸面大标题')
    expect(QINGML_SYSTEM).toContain('其余 h2-h6 用于章节层级')
    expect(QINGML_SYSTEM).not.toContain('可选的 <title>')
  })

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
