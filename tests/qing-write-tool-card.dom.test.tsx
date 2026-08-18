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

describe('Qing write/edit review tool card narratives', () => {
  it('通过真实 DOM 在摘要下方渲染待审叙述，生效态不渲染第二行', () => {
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
          title: '局部修改稿', status: 'review', reviewCount: 3, wholeDocReview: false,
        }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.firstElementChild?.children).toHaveLength(2)
      expect(host.querySelector('p')?.textContent)
        .toBe('改好了 3 处,都在右侧面板,逐条确认或驳回即可。')
      expect(host.firstElementChild?.firstElementChild?.textContent).toContain('《局部修改稿》 · 3 处待裁决')
      expect(host.firstElementChild?.firstElementChild?.textContent).not.toContain('逐条确认')
      expect(host.textContent).not.toMatch(/\bv\d+\b|ai-block-|qing_edit_draft|字数|块/)

      act(() => root.render(
        <QingEditToolCard {...props('edit-whole-review-card', {
          title: '整篇修改稿', status: 'review', reviewCount: 8, wholeDocReview: true,
        }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.querySelector('p')?.textContent).toBe('新版已写好,在右侧等你确认采用或退回。')

      act(() => root.render(
        <QingEditToolCard {...props('edit-committed-card', {
          title: '局部修改稿', status: 'committed', reviewCount: 0,
        }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.querySelector('p')).toBeNull()

      act(() => root.render(
        <QingWriteToolCard {...props('write-review-card', {
          title: '新稿', status: 'review', words: 688, patchCount: 2, wholeDocReview: false,
        }) as unknown as ComponentProps<typeof QingWriteToolCard>} />,
      ))
      expect(host.querySelector('p')?.textContent).toBe('新版已写好,在右侧等你确认采用或退回。')
      expect(host.firstElementChild?.firstElementChild?.textContent).toContain('《新稿》 · 2 处待裁决')
      expect(host.firstElementChild?.firstElementChild?.textContent).not.toContain('新版已写好')
      expect(host.textContent).not.toMatch(/约\s*688\s*字|\bv\d+\b|ai-block-|qing_write_draft|字数|块/)

      act(() => root.render(
        <QingWriteToolCard {...props('write-whole-review-card', {
          title: '整篇新稿', status: 'review', words: 688, patchCount: 9, wholeDocReview: true,
        }) as unknown as ComponentProps<typeof QingWriteToolCard>} />,
      ))
      expect(host.querySelector('p')?.textContent).toBe('新版已写好,在右侧等你确认采用或退回。')

      act(() => root.render(
        <QingWriteToolCard {...props('write-committed-card', {
          title: '新稿', status: 'committed', words: 688, patchCount: 0,
        }) as unknown as ComponentProps<typeof QingWriteToolCard>} />,
      ))
      expect(host.querySelector('p')).toBeNull()
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  })

  it('reviewCount 缺失或非法时使用无数字降级文案，且所有叙述不含未来承诺词', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const props = (sessionId: string, meta: Record<string, unknown>) => ({
      block: { kind: 'tool-result', isError: false, content: [], meta },
      useSession: (selector: (session: { sessionId: string }) => unknown) => selector({ sessionId }),
      qingLayout: { openDetails: vi.fn() },
    })
    const narratives: string[] = []

    try {
      for (const [sessionId, meta] of [
        ['missing-count', { title: '缺计数', status: 'review', wholeDocReview: false }],
        ['nan-count', { title: '坏计数', status: 'review', reviewCount: Number.NaN, wholeDocReview: false }],
      ] as const) {
        act(() => root.render(
          <QingEditToolCard {...props(sessionId, meta) as unknown as ComponentProps<typeof QingEditToolCard>} />,
        ))
        const narrative = host.querySelector('p')?.textContent ?? ''
        narratives.push(narrative)
        expect(narrative).toBe('改动已完成,都在右侧面板,逐条确认或驳回即可。')
        expect(host.textContent).not.toMatch(/undefined|NaN/)
      }

      act(() => root.render(
        <QingWriteToolCard {...props('whole-review', {
          title: '整篇稿', status: 'review', wholeDocReview: true,
        }) as unknown as ComponentProps<typeof QingWriteToolCard>} />,
      ))
      narratives.push(host.querySelector('p')?.textContent ?? '')

      for (const forbidden of ['再接着', '稍后', '接下来我']) {
        expect(narratives.join('\n')).not.toContain(forbidden)
      }
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  })
})
