// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QingDocFunctions, type QingDocFunctionsProps } from '../src/client/QingDocPanel.js'
import { qingClientStore } from '../src/client/store.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root

const baseProps: QingDocFunctionsProps = {
  sessionId: 'dsh-docfns',
  engineSessionId: 'qing-docfns',
  title: '纸面入口测试',
  reviewDisabledReason: null,
  exportDisabledReason: null,
  onFlushSave: async () => undefined,
  onToast: () => undefined,
  onSendMessage: async () => undefined,
}

beforeEach(() => {
  host = document.createElement('div')
  host.dataset.qingagentDocPanel = ''
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderFunctions(overrides: Partial<QingDocFunctionsProps> = {}): void {
  act(() => root.render(<QingDocFunctions {...baseProps} {...overrides} />))
}

function reviewButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('.ws-docfn-btn:not(.ws-doc-btn)')!
}

function exportButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('.ws-doc-btn.ws-docfn-btn')!
}

function menuItem(label: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => item.textContent === label)!
}

function stubReviewBridge(materialReady = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const type = url.searchParams.get('type') ?? 'custom'
    const template = {
      id: `review-${type}-default`,
      type,
      name: type === 'deai' ? '自然表达' : `${type} 标准模板`,
      prompt: type === 'deai' ? '逐段识别机器腔并生成批注建议。' : `按 ${type} 规则逐项检查。`,
      builtin: true,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      selected: true,
    }
    let body: unknown = { ok: true }
    if (url.pathname.endsWith('/review-materials')) body = {
      materials: [{ id: 'material-1', parseState: materialReady ? 'ready' : 'processing' }],
    }
    else if (url.pathname.endsWith('/review-templates') && (init?.method ?? 'GET') === 'GET') body = { templates: [template] }
    else if (url.pathname.endsWith('/review-supplement')) {
      body = init?.method === 'PUT' ? JSON.parse(String(init.body)) : { supplement: '' }
    } else if (url.pathname.endsWith('/lexicons')) body = { lexicons: [
      { id: 'lexicon-ad', name: '广告合规', entryCount: 12, enabled: true },
      { id: 'lexicon-medical', name: '医疗宣传', entryCount: 8, enabled: true },
    ] }
    else if (url.pathname.endsWith('/review-templates/select')) body = { selected: true, id: template.id, type }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('青简纸面审查/导出入口', () => {
  it('按 .ws-docfns 产品结构渲染，并以 title/aria-disabled 表达空稿禁用原因', () => {
    renderFunctions({
      reviewDisabledReason: '还没有可审查的内容',
      exportDisabledReason: '还没有可导出的内容',
    })

    expect(host.querySelector('[data-wf="WorkspaceDocFunctions"].ws-docfns')).not.toBeNull()
    expect(host.querySelectorAll('.ws-export-anchor')).toHaveLength(2)
    expect(reviewButton().classList).toContain('is-disabled')
    expect(reviewButton().title).toBe('还没有可审查的内容')
    expect(reviewButton().getAttribute('aria-disabled')).toBe('true')
    expect(exportButton().classList).toContain('is-disabled')
    expect(exportButton().title).toBe('还没有可导出的内容')
    expect(exportButton().getAttribute('aria-disabled')).toBe('true')

    act(() => reviewButton().click())
    act(() => exportButton().click())
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('待审稿沿用产品原因文案，两个入口均不可展开', () => {
    renderFunctions({
      reviewDisabledReason: '文档有待处理的修改，请先处理后再审查',
      exportDisabledReason: '有待处理的修改：请先采纳或撤销正文中的候选（或点「放弃全部」），再导出',
    })

    expect(reviewButton().title).toBe('文档有待处理的修改，请先处理后再审查')
    expect(exportButton().title).toContain('有待处理的修改')
    expect(reviewButton().getAttribute('aria-expanded')).toBe('false')
    expect(exportButton().getAttribute('aria-expanded')).toBe('false')
  })

  it('ReviewMenu/ExportMenu 互斥开合，并支持按钮复点与 Escape 关闭', () => {
    renderFunctions()

    act(() => reviewButton().click())
    expect(host.querySelector('[data-wf="ReviewMenu"]')).not.toBeNull()
    expect(reviewButton().getAttribute('aria-expanded')).toBe('true')

    act(() => exportButton().click())
    expect(host.querySelector('[data-wf="ReviewMenu"]')).toBeNull()
    expect(host.querySelector('[data-wf="ExportMenu"]')).not.toBeNull()
    expect(exportButton().getAttribute('aria-expanded')).toBe('true')

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(host.querySelector('[data-wf="ExportMenu"]')).toBeNull()
    expect(exportButton().getAttribute('aria-expanded')).toBe('false')

    act(() => reviewButton().click())
    act(() => reviewButton().click())
    expect(host.querySelector('[data-wf="ReviewMenu"]')).toBeNull()
  })

  it('八类 ReviewMenu 原生菜单齐全，来源核查经统一配置、素材预检与打标后发回当前会话', async () => {
    const fetchMock = stubReviewBridge()
    const onSendMessage = vi.fn(async (_dshSessionId: string, _text: string) => undefined)
    renderFunctions({ onSendMessage })

    act(() => reviewButton().click())
    expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
      '来源核查', '一致性审查', '敏感词审查', '隐私泄露审查',
      '去AI味', '格式规范审查', '角色审查', '自定义审查',
    ])

    await act(async () => {
      menuItem('来源核查').click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(document.querySelector('[data-wf="ReviewLaunchModal"]')).not.toBeNull())
    // 弹窗打开后切到另一稿，确认请求仍必须携带弹窗发起瞬间的目标稿。
    renderFunctions({
      engineSessionId: 'qing-switched-after-modal',
      title: '后来切换的稿',
      onSendMessage,
    })
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.ws-launch-actions button')]
      .find((button) => button.textContent === '开始核查')!
    await vi.waitFor(() => expect(confirm.disabled).toBe(false))
    await act(async () => {
      confirm.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(1))
    expect(onSendMessage).toHaveBeenCalledTimes(1)
    expect(onSendMessage.mock.calls[0]?.[0]).toBe('dsh-docfns')
    expect(onSendMessage.mock.calls[0]?.[1]).toContain('对当前文档做来源核查。')
    expect(onSendMessage.mock.calls[0]?.[1]).toContain('qing_read_draft')
    const reviewTurnCall = fetchMock.mock.calls.find(([input]) =>
      new URL(String(input), 'http://localhost').pathname === '/qingagent-bridge/review-turn')
    expect(JSON.parse(String(reviewTurnCall?.[1]?.body))).toMatchObject({
      dshSessionId: 'dsh-docfns',
      engineSessionId: 'qing-docfns',
    })
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input), 'http://localhost').pathname)
    expect(paths.filter((path) => path.endsWith('/review-materials'))).toHaveLength(2)
    expect(paths.indexOf('/qingagent-bridge/review-turn')).toBeLessThan(paths.length)
    expect(host.querySelector('[data-wf="ReviewMenu"]')).toBeNull()
  })

  it('去AI味使用统一 ReviewLaunchModal，模板与补充说明同路发送', async () => {
    stubReviewBridge()
    const onSendMessage = vi.fn(async (_dshSessionId: string, _text: string) => undefined)
    renderFunctions({ onSendMessage })

    act(() => reviewButton().click())
    await act(async () => {
      menuItem('去AI味').click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(document.querySelector('[data-wf="ReviewLaunchModal"]')).not.toBeNull())
    expect(host.querySelector('[data-wf="DeaiReviewModal"]')).toBeNull()
    const supplement = document.querySelector<HTMLTextAreaElement>('.ws-launch-supplement textarea')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(supplement, '保留品牌口号')
      supplement.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.ws-launch-actions button')]
      .find((button) => button.textContent === '开始处理')!
    await act(async () => {
      confirm.click()
      await Promise.resolve()
    })

    expect(onSendMessage).toHaveBeenCalledTimes(1)
    const query = onSendMessage.mock.calls[0]?.[1] ?? ''
    expect(query).toContain('审查模板「自然表达」')
    expect(query).toContain('逐段识别机器腔并生成批注建议')
    expect(query).toContain('文档级补充要求（只适用于当前文档）：保留品牌口号')
    expect(document.querySelector('[data-wf="ReviewLaunchModal"]')).toBeNull()
  })

  it('来源核查没有 ready 素材时显示真源阻断文案且不能发起', async () => {
    stubReviewBridge(false)
    const onSendMessage = vi.fn(async (_dshSessionId: string, _text: string) => undefined)
    renderFunctions({ onSendMessage })

    act(() => reviewButton().click())
    await act(async () => {
      menuItem('来源核查').click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('当前没有可对照素材，请先添加素材'))
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.ws-launch-actions button')]
      .find((button) => button.textContent === '开始核查')!
    expect(confirm.disabled).toBe(true)
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('敏感词词库多选只改当前弹窗，并把所选清单注入审查指令', async () => {
    const fetchMock = stubReviewBridge()
    const onSendMessage = vi.fn(async (_dshSessionId: string, _text: string) => undefined)
    renderFunctions({ onSendMessage })

    act(() => reviewButton().click())
    await act(async () => {
      menuItem('敏感词审查').click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('已启用 2 个词库'))
    act(() => document.querySelector<HTMLButtonElement>('.ws-launch-resource-row .ws-launch-link')!.click())
    const medical = document.querySelector<HTMLInputElement>('input[aria-label="启用医疗宣传"]')
      ?? [...document.querySelectorAll<HTMLInputElement>('.ws-lexicon-check input')][1]!
    act(() => medical.click())
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('.ws-launch-actions button')]
        .find((button) => button.textContent === '完成')!.click()
      await Promise.resolve()
    })
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('.ws-launch-actions button')]
        .find((button) => button.textContent === '开始审查')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(onSendMessage).toHaveBeenCalledOnce())
    const query = onSendMessage.mock.calls[0]?.[1] ?? ''
    expect(query).toContain('「广告合规」(id: lexicon-ad)')
    expect(query).not.toContain('「医疗宣传」(id: lexicon-medical)')
    expect(fetchMock.mock.calls.some(([input, init]) =>
      new URL(String(input), 'http://localhost').pathname.endsWith('/lexicons')
      && (init?.method ?? 'GET') !== 'GET')).toBe(false)
  })

  it('确定性导出仅列格式项，并在 flush 后调用 /qingagent-bridge 对应 store', async () => {
    const onFlushSave = vi.fn(async () => undefined)
    const onToast = vi.fn()
    const exportDoc = vi.spyOn(qingClientStore, 'exportDoc').mockResolvedValue({
      blob: new Blob(['markdown'], { type: 'text/markdown' }),
    })
    const createObjectURL = vi.fn(() => 'blob:dsh-export')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    renderFunctions({ onFlushSave, onToast })

    act(() => exportButton().click())
    expect([...host.querySelectorAll('[data-wf^="ExportFormat-"]')].map((item) => item.textContent)).toEqual([
      '导出 PDF', '导出 Word', '导出 HTML', '导出 Markdown', '导出 TXT',
    ])
    expect(host.textContent).not.toContain('飞书')

    await act(async () => {
      menuItem('导出 Markdown').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onFlushSave).toHaveBeenCalledOnce()
    expect(exportDoc).toHaveBeenCalledWith('dsh-docfns', 'qing-docfns', 'markdown')
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(onToast).toHaveBeenCalledWith('Markdown 已开始下载')
    expect(host.querySelector('[data-wf="ExportMenu"]')).toBeNull()
  })
})
