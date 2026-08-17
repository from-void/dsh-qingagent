// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QingEditToolCard } from '../src/client/QingToolCard.js'
import { failureSummary, QingWriteToolCard } from '../src/client/QingWriteToolCard.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeEventSource {
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  addEventListener(): void {}
  close(): void {}
}

const stylesheet = readFileSync(
  resolve('src/client/QingWriteToolCard.module.css'),
  'utf8',
)

afterEach(() => {
  document.head.replaceChildren()
  vi.unstubAllGlobals()
})

describe('QingWriteToolCard theme styles', () => {
  it('从失败 result content 首行提取用户可读摘要', () => {
    expect(failureSummary([{ type: 'text', text: 'Error: 文稿正在审阅中（请先裁决）\n详情' }]))
      .toBe('文稿审阅中')
    expect(failureSummary([{ type: 'text', text: 'Error: 青简正在处理其他任务（AGENT_BUSY）' }]))
      .toBe('引擎忙')
  })

  it('uses only dsh semantic variables instead of literal colors', () => {
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)

    expect(document.styleSheets[0]?.cssRules.length).toBeGreaterThan(0)
    expect(stylesheet).not.toMatch(/#[\da-f]{3,8}\b|rgba?\s*\(/i)

    const themeColors = [...stylesheet.matchAll(
      /^\s*(?:color|background(?:-color)?|border-color|outline-color|box-shadow)\s*:\s*([^;]+);/gm,
    )].map((match) => match[1]?.trim())
    expect(themeColors.length).toBeGreaterThan(0)
    expect(themeColors.every((value) => value === 'transparent' || /^var\(--dsw-[\w-]+\)$/.test(value ?? ''))).toBe(true)

    const variables = [...stylesheet.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1])
    expect(variables.length).toBeGreaterThan(0)
    expect(variables.every((variable) => variable?.startsWith('--dsw-'))).toBe(true)
  })
})

describe('Qing write/edit review tool card summaries', () => {
  it('通过 keyed 卡片渲染链路给出逐处确认指引，生效态不显示该指引', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const qingLayout = { openDetails: vi.fn() }
    const props = (sessionId: string, meta: Record<string, unknown>) => ({
      block: { kind: 'tool-result', isError: false, content: [], meta },
      useSession: (selector: (session: { sessionId: string }) => unknown) => selector({ sessionId }),
      qingLayout,
    })

    try {
      act(() => root.render(
        <QingEditToolCard {...props('edit-review-card', {
          title: '局部修改稿', status: 'review', reviewCount: 3,
        }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.textContent).toContain('《局部修改稿》 · 3 处待裁决 · 请在右侧逐处确认')
      expect(host.textContent).not.toMatch(/\bv\d+\b|ai-block-|qing_edit_draft|字数|块/)

      act(() => root.render(
        <QingEditToolCard {...props('edit-committed-card', {
          title: '局部修改稿', status: 'committed', reviewCount: 0,
        }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.textContent).not.toContain('请在右侧逐处确认')

      act(() => root.render(
        <QingWriteToolCard {...props('write-review-card', {
          title: '新稿', status: 'review', words: 688, patchCount: 2,
        }) as unknown as ComponentProps<typeof QingWriteToolCard>} />,
      ))
      expect(host.textContent).toContain('《新稿》 · 2 处待裁决 · 请在右侧逐处确认')
      expect(host.textContent).not.toMatch(/约\s*688\s*字|\bv\d+\b|ai-block-|qing_write_draft|字数|块/)

      act(() => root.render(
        <QingWriteToolCard {...props('write-committed-card', {
          title: '新稿', status: 'committed', words: 688, patchCount: 0,
        }) as unknown as ComponentProps<typeof QingWriteToolCard>} />,
      ))
      expect(host.textContent).not.toContain('请在右侧逐处确认')
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  })
})
