import { describe, expect, it } from 'vitest'
import { aiDocumentSchema, aiIrToPm, qingmlParse } from '@qingagent/pm-schema'
import {
  QINGML_BLOCK_MATH_EXAMPLE,
  QINGML_FOOTNOTE_EXAMPLE,
  QINGML_INLINE_MATH_EXAMPLE,
  QINGML_NESTED_BULLET_LIST_EXAMPLE,
  QINGML_NESTED_TASK_LIST_EXAMPLE,
  QINGML_SYSTEM,
  completeTopLevelBlocks,
  countWords,
  findQingmlSourceSyntaxLeaks,
  outlineOf,
} from '../src/qingml.js'

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

  it('嵌套列表正面样例本身是完整 QingML 顶层块', () => {
    for (const example of [QINGML_NESTED_BULLET_LIST_EXAMPLE, QINGML_NESTED_TASK_LIST_EXAMPLE]) {
      expect(completeTopLevelBlocks(example)).toEqual({ blocks: [example], completeLength: example.length })
      expect(QINGML_SYSTEM).toContain(example)
    }
    expect(QINGML_SYSTEM).toContain('列表的层级靠嵌套表达,不靠标题')
    expect(QINGML_SYSTEM).toContain('用户要「大类下面再列具体的」「分几类、每类带几项」时,必须用这种嵌套列表,不要用「小标题+平级列表」')
  })

  it('脚注与行内/块级公式正面样例均通过权威解析器和 AI-IR 校验器', () => {
    const examples = [QINGML_FOOTNOTE_EXAMPLE, QINGML_INLINE_MATH_EXAMPLE, QINGML_BLOCK_MATH_EXAMPLE]
    for (const example of examples) {
      const parsed = qingmlParse(example)
      expect(parsed.warnings.filter((warning) => warning.severity === 'bad-block')).toEqual([])
      expect(aiDocumentSchema.safeParse({ blocks: parsed.blocks }).success).toBe(true)
      expect(completeTopLevelBlocks(example)).toEqual({ blocks: [example], completeLength: example.length })
      expect(QINGML_SYSTEM).toContain(example)
    }

    const footnotePm = aiIrToPm({ blocks: qingmlParse(QINGML_FOOTNOTE_EXAMPLE).blocks })
    expect(footnotePm.content[0]).toMatchObject({
      type: 'paragraph',
      content: expect.arrayContaining([
        { type: 'footnoteReference', attrs: { id: 'source_1', note: '《资料甲》，第 12 页。' } },
      ]),
    })
    const inlineMathPm = aiIrToPm({ blocks: qingmlParse(QINGML_INLINE_MATH_EXAMPLE).blocks })
    expect(inlineMathPm.content[0]).toMatchObject({
      type: 'paragraph',
      content: expect.arrayContaining([{ type: 'inlineMath', attrs: { latex: 'E=mc^2' } }]),
    })
    expect(qingmlParse(QINGML_BLOCK_MATH_EXAMPLE).blocks).toEqual([
      { type: 'blockMath', latex: String.raw`\int_0^1 x^2\,dx=\frac{1}{3}` },
    ])
  })

  it('系统提示硬性禁止 Markdown/GFM 脚注和公式源语法', () => {
    expect(QINGML_SYSTEM).toContain('【源语法纪律】')
    expect(QINGML_SYSTEM).toContain('严禁写 [^x]、[^x]: …')
    expect(QINGML_SYSTEM).toContain('严禁写 $…$、$$…$$')
    expect(QINGML_SYSTEM).toContain('要脚注就用 <footnote id="x">注文</footnote>')
    expect(QINGML_SYSTEM).toContain('要行内公式就用 <math>…</math>')
    expect(QINGML_SYSTEM).toContain('要块级公式就用 <math-block>…</math-block>')
  })

  it('识别正文文本节点中的 GFM 脚注引用与定义', () => {
    expect(findQingmlSourceSyntaxLeaks('<p>结论见来源[^1]。</p>')).toContain('footnote-reference')
    expect(findQingmlSourceSyntaxLeaks('<p>[^source1]: 《资料甲》</p>')).toContain('footnote-definition')
  })

  it('不误伤代码块、原生脚注/公式或普通方括号引用', () => {
    const valid = [
      '<pre lang="md">正文[^1]\n[^source1]: 来源</pre>',
      QINGML_FOOTNOTE_EXAMPLE,
      QINGML_INLINE_MATH_EXAMPLE,
      QINGML_BLOCK_MATH_EXAMPLE,
      '<p>详见附录[1]，以及变量 x。</p>',
    ]
    for (const qingml of valid) expect(findQingmlSourceSyntaxLeaks(qingml)).toEqual([])
  })

  it('生成标题层级、节首句和中英文字数', () => {
    const qingml = '<title>测试稿</title><h1>第一章</h1><p>这是首句。还有一句。</p><h2>English</h2><p>Hello world.</p>'
    const outline = outlineOf(qingml)
    expect(outline.title).toBe('测试稿')
    expect(outline.blocks).toBe(4)
    expect(outline.structure).toBe('一个标题、1 个小标题和 2 段正文')
    expect(outline.headings[0]).toMatchObject({ level: 1, text: '第一章', firstSentence: '这是首句。' })
    expect(countWords(qingml)).toBeGreaterThan(10)
  })

  it('用用户语言概括标题与正文段落', () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `<p>第 ${index + 1} 段。</p>`).join('')
    expect(outlineOf(`<title>测试稿</title><h1>测试稿</h1>${paragraphs}`).structure)
      .toBe('一个标题加 6 段正文')
  })

  it('清单和表格各按一个顶层内容计数，嵌套清单不重复', () => {
    const qingml = [
      '<title>混合稿</title>',
      '<ul><li>甲<ul><li>乙</li></ul></li></ul>',
      '<table><tr><th>列</th></tr><tr><td>值</td></tr></table>',
    ].join('')
    const structure = outlineOf(qingml).structure
    expect(structure).toBe('1 个清单加 1 张表格')
    expect(structure).not.toContain('段')
  })

  it('纯清单稿不虚构正文段落', () => {
    const structure = outlineOf('<title>清单稿</title><tasks><task checked="false">事项</task></tasks>').structure
    expect(structure).toBe('1 个清单')
    expect(structure).not.toContain('段')
  })
})
