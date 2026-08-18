// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QingEditToolCard } from '../src/client/QingToolCard.js'
import { failureSummary, QingWriteToolCard } from '../src/client/QingWriteToolCard.js'
import { qingClientStore } from '../src/client/store.js'

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

const pmDoc = {
  type: 'doc',
  attrs: { schemaVersion: 1 },
  content: [{
    type: 'paragraph', attrs: { blockId: 'p-1' }, content: [{ type: 'text', text: '待审正文' }],
  }],
}

async function loadPendingReviewSnapshot(
  sessionId: string,
  engineSessionId: string,
  suggestionIds: readonly string[] = [`patch-${engineSessionId}`],
): Promise<void> {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/qingagent-bridge/doc-pm?')) {
      return Promise.resolve(Response.json({
        sessionId: engineSessionId,
        docVersion: 1,
        contentHash: `hash-${engineSessionId}`,
        state: 'pendingReview',
        agentBusy: false,
        title: '待审稿',
        ts: '2026-08-18T00:00:00.000Z',
        pmDoc,
      }))
    }
    if (url.startsWith('/qingagent-bridge/review-render-model?')) {
      return Promise.resolve(Response.json({
        sessionId: engineSessionId,
        docVersion: 1,
        state: 'pendingReview',
        agentBusy: false,
        baseVersion: 1,
        previewDoc: pmDoc,
        suggestions: suggestionIds.map((id) => ({ id, kind: 'replace', status: 'reviewing' })),
      }))
    }
    if (url.startsWith('/qingagent-bridge/state?')) {
      // 卡片 retain 会后台拉会话状态；让它保持在途，避免覆盖本测试显式装配的面板快照。
      return new Promise<Response>(() => {})
    }
    return Promise.reject(new Error(`unexpected ${url}`))
  }))
  await qingClientStore.refreshPanel(sessionId, engineSessionId)
}

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
  it('同一条 review meta 随当前 snapshot 结算，移除摘要与叙述里的控件指引', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const sessionId = 'edit-review-card'
    const engineSessionId = 'qing-edit-review'
    await loadPendingReviewSnapshot(sessionId, engineSessionId)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const qingLayout = { openDetails: vi.fn() }
    const props = (sessionId: string, meta: Record<string, unknown>) => ({
      block: { kind: 'tool-result', isError: false, content: [], meta },
      useSession: (selector: (session: { sessionId: string }) => unknown) => selector({ sessionId }),
      qingLayout,
    })
    const reviewMeta = {
      engineSessionId,
      title: '局部修改稿',
      status: 'review',
      reviewCount: 3,
      wholeDocReview: false,
      patchIds: [`patch-${engineSessionId}`],
    }

    try {
      act(() => root.render(
        <QingEditToolCard {...props(sessionId, reviewMeta) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.firstElementChild?.children).toHaveLength(2)
      expect(host.querySelector('p')?.textContent)
        .toBe('改好了 3 处,都在右侧面板,逐条确认或驳回即可。')
      expect(host.firstElementChild?.firstElementChild?.textContent)
        .toContain('《局部修改稿》 · 3 处待裁决 · 请在右侧逐处确认')
      expect(host.textContent).not.toMatch(/\bv\d+\b|ai-block-|qing_edit_draft|字数|块/)

      act(() => qingClientStore.applyReviewVerdict(
        sessionId,
        engineSessionId,
        [`patch-${engineSessionId}`],
        'accepted',
      ))
      expect(host.querySelector('p')?.textContent)
        .toBe('改好了 3 处,都在右侧面板,逐条确认或驳回即可。')
      expect(host.textContent).toContain('3 处待裁决')

      act(() => qingClientStore.applyReviewCommit(sessionId, engineSessionId, 2))
      expect(host.querySelector('p')?.textContent).toBe('当时改了 3 处,已处理完。')
      expect(host.firstElementChild?.firstElementChild?.textContent)
        .toContain('《局部修改稿》 · 3 处修改')
      for (const forbidden of ['逐条确认', '驳回', '在右侧', '已采纳', '已驳回']) {
        expect(host.textContent).not.toContain(forbidden)
      }
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  })

  it('待审 snapshot 下整稿与逐处模式保留指引，非 review meta 不渲染第二行', async () => {
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
      await loadPendingReviewSnapshot('edit-whole-review-card', 'qing-edit-whole')
      act(() => root.render(
        <QingEditToolCard {...props('edit-whole-review-card', {
          engineSessionId: 'qing-edit-whole',
          title: '整篇修改稿', status: 'review', reviewCount: 8, wholeDocReview: true,
          patchIds: ['patch-qing-edit-whole'],
        }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.querySelector('p')?.textContent).toBe('新版已写好,在右侧等你确认采用或退回。')
      expect(host.firstElementChild?.firstElementChild?.textContent)
        .toContain('请在右侧确认是否应用新版')

      act(() => root.render(
        <QingEditToolCard {...props('edit-committed-card', {
          title: '局部修改稿', status: 'committed', reviewCount: 0,
        }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.querySelector('p')).toBeNull()

      await loadPendingReviewSnapshot('write-review-card', 'qing-write-review')
      act(() => root.render(
        <QingWriteToolCard {...props('write-review-card', {
          engineSessionId: 'qing-write-review',
          title: '新稿', status: 'review', words: 688, patchCount: 2, wholeDocReview: false,
          patchIds: ['patch-qing-write-review'],
        }) as unknown as ComponentProps<typeof QingWriteToolCard>} />,
      ))
      expect(host.querySelector('p')?.textContent).toBe('新版已写好,在右侧等你确认采用或退回。')
      expect(host.firstElementChild?.firstElementChild?.textContent)
        .toContain('《新稿》 · 2 处待裁决 · 请在右侧逐处确认')
      expect(host.firstElementChild?.firstElementChild?.textContent).not.toContain('新版已写好')
      expect(host.textContent).not.toMatch(/约\s*688\s*字|\bv\d+\b|ai-block-|qing_write_draft|字数|块/)

      await loadPendingReviewSnapshot('write-whole-review-card', 'qing-write-whole')
      act(() => root.render(
        <QingWriteToolCard {...props('write-whole-review-card', {
          engineSessionId: 'qing-write-whole',
          title: '整篇新稿', status: 'review', words: 688, patchCount: 9, wholeDocReview: true,
          patchIds: ['patch-qing-write-whole'],
        }) as unknown as ComponentProps<typeof QingWriteToolCard>} />,
      ))
      expect(host.querySelector('p')?.textContent).toBe('新版已写好,在右侧等你确认采用或退回。')
      expect(host.firstElementChild?.firstElementChild?.textContent)
        .toContain('请在右侧确认是否应用新版')

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

  it('reviewCount 缺失或非法时使用无数字降级文案，且所有叙述不含未来承诺词', async () => {
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
      for (const [sessionId, engineSessionId, meta] of [
        ['missing-count', 'qing-missing-count', { title: '缺计数', status: 'review', wholeDocReview: false }],
        ['nan-count', 'qing-nan-count', { title: '坏计数', status: 'review', reviewCount: Number.NaN, wholeDocReview: false }],
      ] as const) {
        await loadPendingReviewSnapshot(sessionId, engineSessionId)
        act(() => root.render(
          <QingEditToolCard {...props(sessionId, {
            ...meta, engineSessionId, patchIds: [`patch-${engineSessionId}`],
          }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
        ))
        const narrative = host.querySelector('p')?.textContent ?? ''
        narratives.push(narrative)
        expect(narrative).toBe('改动已完成,都在右侧面板,逐条确认或驳回即可。')
        expect(host.textContent).not.toMatch(/undefined|NaN/)
      }

      await loadPendingReviewSnapshot('whole-review', 'qing-whole-review')
      act(() => root.render(
        <QingWriteToolCard {...props('whole-review', {
          engineSessionId: 'qing-whole-review', title: '整篇稿', status: 'review', wholeDocReview: true,
          patchIds: ['patch-qing-whole-review'],
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

  it('旧卡缺少 patchIds 时即使同稿待审也降级为历史事实', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const sessionId = 'legacy-review-card'
    const engineSessionId = 'qing-legacy-review'
    await loadPendingReviewSnapshot(sessionId, engineSessionId)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const props = {
      block: {
        kind: 'tool-result', isError: false, content: [],
        meta: {
          engineSessionId, title: '旧卡片', status: 'review', reviewCount: 2, wholeDocReview: false,
        },
      },
      useSession: (selector: (session: { sessionId: string }) => unknown) => selector({ sessionId }),
      qingLayout: { openDetails: vi.fn() },
    }

    try {
      act(() => root.render(
        <QingEditToolCard {...props as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.querySelector('p')?.textContent).toBe('当时改了 2 处。')
      expect(host.textContent).not.toMatch(/逐条确认|驳回|在右侧|已采纳|已驳回|已处理完/)
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  })

  it('同一 docVersion 的新批次待审时只给匹配 patchIds 的卡显示指路语', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const sessionId = 'same-version-review-batches'
    const engineSessionId = 'qing-same-version'
    await loadPendingReviewSnapshot(sessionId, engineSessionId, ['patch-b1'])
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const props = (meta: Record<string, unknown>) => ({
      block: { kind: 'tool-result', isError: false, content: [], meta },
      useSession: (selector: (session: { sessionId: string }) => unknown) => selector({ sessionId }),
      qingLayout: { openDetails: vi.fn() },
    })

    try {
      act(() => root.render(
        <QingEditToolCard {...props({
          engineSessionId,
          title: '批次 A',
          status: 'review',
          reviewCount: 2,
          wholeDocReview: false,
          patchIds: ['patch-a1', 'patch-a2'],
          docVersion: 1,
        }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.querySelector('p')?.textContent).toBe('当时改了 2 处。')
      expect(host.textContent).not.toMatch(/逐条确认|待裁决|在右侧/)

      act(() => root.render(
        <QingEditToolCard {...props({
          engineSessionId,
          title: '批次 B',
          status: 'review',
          reviewCount: 1,
          wholeDocReview: false,
          patchIds: ['patch-b1'],
          docVersion: 1,
        }) as unknown as ComponentProps<typeof QingEditToolCard>} />,
      ))
      expect(host.querySelector('p')?.textContent)
        .toBe('改好了 1 处,都在右侧面板,逐条确认或驳回即可。')
      expect(host.firstElementChild?.firstElementChild?.textContent)
        .toContain('《批次 B》 · 1 处待裁决 · 请在右侧逐处确认')
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  })
})
