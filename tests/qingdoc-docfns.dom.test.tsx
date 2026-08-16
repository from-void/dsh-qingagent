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

  it('八类 ReviewMenu 原生菜单齐全，普通类型经 assembleDshReviewQuery 发回当前 dsh 会话', async () => {
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
    expect(onSendMessage).toHaveBeenCalledTimes(1)
    expect(onSendMessage.mock.calls[0]?.[0]).toBe('dsh-docfns')
    expect(onSendMessage.mock.calls[0]?.[1]).toContain('对当前文稿做来源核查(仅对照已关联素材)。')
    expect(onSendMessage.mock.calls[0]?.[1]).toContain('qing_read_draft')
    expect(host.querySelector('[data-wf="ReviewMenu"]')).toBeNull()
  })

  it('去AI味使用产品 DeaiReviewModal，所选模板规则与补充说明同路发送', async () => {
    const onSendMessage = vi.fn(async (_dshSessionId: string, _text: string) => undefined)
    renderFunctions({ onSendMessage })

    act(() => reviewButton().click())
    await act(async () => {
      menuItem('去AI味').click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(host.querySelector('[data-wf="DeaiReviewModal"]')).not.toBeNull())
    expect(host.querySelectorAll('.ws-deai-template')).toHaveLength(3)

    const deepRadio = [...host.querySelectorAll<HTMLInputElement>('input[name="deai-template"]')]
      .find((input) => input.closest('.ws-deai-template')?.textContent?.includes('深度重写'))!
    act(() => deepRadio.click())
    const supplement = host.querySelector<HTMLTextAreaElement>('.ws-deai-supplement textarea')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(supplement, '保留品牌口号')
      supplement.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const confirm = [...host.querySelectorAll<HTMLButtonElement>('.ws-lexicon-actions button')]
      .find((button) => button.textContent === '开始处理')!
    await act(async () => {
      confirm.click()
      await Promise.resolve()
    })

    expect(onSendMessage).toHaveBeenCalledTimes(1)
    const query = onSendMessage.mock.calls[0]?.[1] ?? ''
    expect(query).toContain('审查模板「深度重写」')
    expect(query).toContain('按 24 类 AI 写作痕迹逐段检查并重写')
    expect(query).toContain('本次补充要求:保留品牌口号')
    expect(host.querySelector('[data-wf="DeaiReviewModal"]')).toBeNull()
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
