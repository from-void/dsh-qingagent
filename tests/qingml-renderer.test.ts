// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderQingml } from '../src/client/qingml-renderer.js'

describe('QingML 白名单渲染', () => {
  it('剥除脚本、事件属性和危险链接，同时保留安全正文', () => {
    const result = renderQingml([
      '<title>安全标题</title>',
      '<p onclick="alert(1)">前<a href="javascript:alert(2)">坏链接</a><a href="https://example.com">好链接</a>后</p>',
      '<script>alert(3)</script><unknown><b>可见内容</b></unknown>',
      '<img src="data:text/html,bad" onerror="alert(4)" alt="插图">',
    ].join(''))

    expect(result.title).toBe('安全标题')
    expect(result.html).toContain('安全标题')
    expect(result.html).toContain('<b>可见内容</b>')
    expect(result.html).toContain('href="https://example.com"')
    expect(result.html).not.toMatch(/script|onclick|onerror|javascript:|data:text/i)
  })

  it('转换任务、提示框、分栏、图表占位和脚注', () => {
    const result = renderQingml([
      '<tasks><task checked="true">完成项</task><task>待办项</task></tasks>',
      '<callout emoji="💡" tone="success">提示内容</callout>',
      '<columns><column ratio="2"><p>左栏</p></column><column ratio="1"><p>右栏</p></column></columns>',
      '<mermaid>graph TD; A--&gt;B</mermaid>',
      '<p>一句话<footnote id="n1">脚注正文</footnote></p>',
    ].join(''))

    expect(result.html).toContain('class="qing-tasks"')
    expect(result.html).toContain('type="checkbox"')
    expect(result.html).toContain('checked=""')
    expect(result.html).toContain('qing-callout-success')
    expect(result.html).toContain('flex-grow: 2')
    expect(result.html).toContain('Mermaid 图')
    expect(result.html).toContain('id="qing-note-n1"')
    expect(result.footnotes).toBe(1)
  })
})
