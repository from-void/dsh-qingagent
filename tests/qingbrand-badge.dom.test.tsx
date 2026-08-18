// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QingBrandBadge } from '../src/client/QingBrandBadge.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  window.localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('青简顶栏品牌卡', () => {
  it('常驻展示并排反馈入口，有未读更新时显示角标并打开更新浮层', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      current: '0.1.19', latest: '0.1.20', hasUpdate: true,
    })))
    renderBadge()

    const trigger = await vi.waitFor(() => {
      const element = host?.querySelector<HTMLButtonElement>('.qingbrand-trigger')
      expect(element).not.toBeNull()
      expect(host?.querySelector('.qingbrand-new')?.textContent).toBe('new')
      return element!
    })
    act(() => host!.querySelector('.qingbrand-badge')?.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    ))

    const links = host!.querySelectorAll<HTMLAnchorElement>('.qingbrand-feedback-links a')
    // 每个入口 = 名称 + 一句说明它做什么(去掉了通栏标题:标题只占位不给信息)。
    expect([...links].map((link) => link.querySelector('.qingbrand-item-label')?.textContent))
      .toEqual(['报 Bug', '提需求'])
    expect([...links].map((link) => link.querySelector('.qingbrand-item-hint')?.textContent))
      .toEqual(['用起来不对劲，去 GitHub 提一条', '想要什么功能，去需求广场说'])
    expect([...links].map((link) => link.target)).toEqual(['_blank', '_blank'])
    expect([...links].map((link) => link.rel)).toEqual(['noreferrer', 'noreferrer'])

    const updateButton = host!.querySelector<HTMLButtonElement>('.qingbrand-update-trigger')!
    expect(updateButton.getAttribute('aria-expanded')).toBe('false')
    act(() => updateButton.click())

    expect(window.localStorage.getItem('dsh-qingagent.update-seen.v1.0.1.20')).toBe('1')
    expect(host!.querySelector('.qingbrand-new')).toBeNull()
    expect(host!.querySelector('[role="dialog"]')?.textContent).toContain('运行后需重启 DSH 生效')
    expect(updateButton.getAttribute('aria-expanded')).toBe('true')
    expect(updateButton.getAttribute('aria-controls')).toBe(host!.querySelector('[role="dialog"]')?.id)

    const copyButton = [...host!.querySelectorAll<HTMLButtonElement>('.qingbrand-command-row button')]
      .find((button) => button.textContent === '复制')!
    await act(async () => { copyButton.click(); await Promise.resolve() })
    expect(writeText).toHaveBeenCalledWith('npx @deepseek-ai/dsh plugin --profile web add dsh-qingagent@latest')
    expect(host!.querySelector('.qingbrand-copy-status')?.textContent).toBe('已复制')

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host!.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(updateButton)
    expect(updateButton.getAttribute('aria-expanded')).toBe('false')

    act(() => updateButton.click())
    expect(host!.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(host!.querySelector('[role="dialog"]')).toBeNull()
    expect(host!.querySelector('.qingbrand-hover-card')).toBeNull()
  })

  it('更新检查失败静默为无更新，反馈入口仍可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    renderBadge()
    const trigger = host!.querySelector<HTMLButtonElement>('.qingbrand-trigger')!
    act(() => trigger.focus())

    await vi.waitFor(() => expect(host!.querySelectorAll('.qingbrand-feedback-links a')).toHaveLength(2))
    expect(host!.querySelector('.qingbrand-new')).toBeNull()
    expect(host!.querySelector('.qingbrand-update-trigger')).toBeNull()
  })

  it('剪贴板失败时选中更新指令作为兜底，已见版本不再显示角标', async () => {
    window.localStorage.setItem('dsh-qingagent.update-seen.v1.0.1.20', '1')
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) },
    })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      current: '0.1.19', latest: '0.1.20', hasUpdate: true,
    })))
    renderBadge()

    const trigger = host!.querySelector<HTMLButtonElement>('.qingbrand-trigger')!
    act(() => trigger.focus())
    const updateButton = await vi.waitFor(() => {
      const element = host!.querySelector<HTMLButtonElement>('.qingbrand-update-trigger')
      expect(element).not.toBeNull()
      expect(host!.querySelector('.qingbrand-new')).toBeNull()
      return element!
    })
    act(() => updateButton.click())
    const input = host!.querySelector<HTMLInputElement>('.qingbrand-command-row input')!
    const copyButton = host!.querySelector<HTMLButtonElement>('.qingbrand-command-row button')!
    await act(async () => { copyButton.click(); await Promise.resolve(); await Promise.resolve() })

    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(host!.querySelector('.qingbrand-copy-status')?.textContent).toContain('已选中指令')
  })
})

function renderBadge(): void {
  host = document.createElement('section')
  host.dataset.qingagentDocPanel = ''
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(<QingBrandBadge />))
}
