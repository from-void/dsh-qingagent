// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

const generatedCss = readFileSync('src/qingdoc/qingdoc.css', 'utf8')
const panelCss = readFileSync('src/client/QingDocPanel.css', 'utf8')
const runtimeCssSource = readFileSync('src/client/runtimeCss.ts', 'utf8')

beforeAll(() => {
  const style = document.createElement('style')
  style.textContent = `${generatedCss}\n${panelCss}`
  document.head.append(style)
})

beforeEach(() => {
  document.body.replaceChildren()
})

function panelRoot(children: string): HTMLElement {
  document.body.innerHTML = `<section data-qingagent-doc-panel style="
    --ws-paper-column-width:800px;
    --ws-paper-min-height:100%;
    --ws-paper-radius:0;
  ">${children}</section>`
  return document.querySelector<HTMLElement>('[data-qingagent-doc-panel]')!
}

function setRect(element: Element, rect: { left: number; top: number; width: number; height: number }): DOMRect {
  const measured = DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
  element.getBoundingClientRect = () => measured
  return measured
}

function contains(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

describe('B9 面板层级与几何 DOM 契约', () => {
  it.each([600, 970, 1400])('P84: %ipx 面板的滚动条贴住纸面，审查/导出锚仍在纸内', (panelWidth) => {
    const root = panelRoot(`
      <div class="ws-body">
        <main class="ws-right">
          <div class="ws-paper-shell"></div>
          <div class="ws-docfns"></div>
        </main>
      </div>
    `)
    const scroll = root.querySelector<HTMLElement>('.ws-right')!
    const paper = root.querySelector<HTMLElement>('.ws-paper-shell')!
    const docFns = root.querySelector<HTMLElement>('.ws-docfns')!
    const scrollMax = Number(panelCss.match(/\.ws-right \{[\s\S]*?max-width:\s*(\d+)px !important/)?.[1])
    const scrollbarWidth = Number(runtimeCssSource.match(/\.ws-right::\-webkit-scrollbar \{ width: (\d+)px/)?.[1])
    const bodyPaddingInline = 40
    const available = panelWidth - bodyPaddingInline * 2
    const scrollWidth = Math.min(scrollMax, available)
    const scrollLeft = (panelWidth - scrollWidth) / 2
    const scrollRect = setRect(scroll, { left: scrollLeft, top: 52, width: scrollWidth, height: 748 })
    // scrollbar-gutter:stable both-edges 在纸两侧各保留一条实际滚动槽。
    const paperRect = setRect(paper, {
      left: scrollRect.left + scrollbarWidth,
      top: scrollRect.top,
      width: scrollRect.width - scrollbarWidth * 2,
      height: scrollRect.height,
    })
    const docFnsRight = scrollRect.right - 18
    setRect(docFns, { left: docFnsRight - 96, top: paperRect.top + 12, width: 96, height: 30 })

    expect(getComputedStyle(scroll).maxWidth).toBe('800px')
    expect(getComputedStyle(scroll).marginInline).toBe('auto')
    expect(getComputedStyle(paper).marginInline).toBe('0')
    expect(scroll.getBoundingClientRect().right - paper.getBoundingClientRect().right)
      .toBeLessThanOrEqual(scrollbarWidth + 2)
    expect(docFns.getBoundingClientRect().right).toBeLessThanOrEqual(paper.getBoundingClientRect().right)
    expect(docFns.getBoundingClientRect().left).toBeGreaterThanOrEqual(paper.getBoundingClientRect().left)
  })

  it('P85:顶栏计算层级高于生成 CSS 中全部 1000xx 正文浮层', () => {
    const root = panelRoot(`
      <header class="qingdoc-stage-controls">青简</header>
      <div class="doc-toolbar"></div>
      <div class="block-handle-menu"></div>
      <div class="table-size-picker"></div>
    `)
    const header = root.querySelector<HTMLElement>('.qingdoc-stage-controls')!
    const generatedLayerValues = [...generatedCss.matchAll(/z-index:\s*(1000\d+)/g)]
      .map((match) => Number(match[1]))
    const generatedMax = Math.max(...generatedLayerValues)

    expect(generatedMax).toBe(100070)
    expect(getComputedStyle(header).position).toBe('relative')
    expect(Number(getComputedStyle(header).zIndex)).toBeGreaterThan(generatedMax)
  })

  it('P86:body portal 的 drawio 浮层恢复 fixed 全屏层并压过 dsh 输入/Tab chrome', () => {
    panelRoot('<div class="ws-body"></div>')
    const composer = document.createElement('div')
    composer.className = 'wSkVaW_composerSeat'
    composer.style.cssText = 'position:sticky;z-index:7'
    composer.innerHTML = '<textarea class="uV2eYG_input"></textarea>'
    const tabs = document.createElement('div')
    tabs.className = 'wSkVaW_tabs'
    tabs.style.cssText = 'position:relative;z-index:1'
    const layoutOverlay = document.createElement('div')
    layoutOverlay.className = 'pI_x6G_overlayLayer'
    layoutOverlay.style.cssText = 'position:absolute;z-index:20'
    const host = document.createElement('div')
    host.dataset.drawioEditorHost = 'true'
    host.innerHTML = '<div class="drawio-editor-overlay diagram-editor-chrome"></div>'
    document.body.append(composer, tabs, layoutOverlay, host)
    const overlay = host.querySelector<HTMLElement>('.drawio-editor-overlay')!
    const hostChromeMax = Math.max(
      Number(getComputedStyle(composer).zIndex),
      Number(getComputedStyle(tabs).zIndex),
      Number(getComputedStyle(layoutOverlay).zIndex),
    )

    expect(host.parentElement).toBe(document.body)
    expect(getComputedStyle(overlay).position).toBe('fixed')
    expect(getComputedStyle(overlay).inset).toBe('0')
    expect(Number(getComputedStyle(overlay).zIndex)).toBe(2147483100)
    expect(Number(getComputedStyle(overlay).zIndex)).toBeGreaterThan(hostChromeMax)
    expect(getComputedStyle(host).getPropertyValue('--bg-paper-deep').trim()).toBe('#efe7d6')
  })

  it('P87:媒体工具和图表操作按钮使用客户端声明的计算字号', () => {
    const root = panelRoot(`
      <button class="pm-image-tool">居中</button>
      <button class="pm-diagram-view-btn">可视化编辑</button>
      <div class="pm-diagram-empty">图表为空</div>
    `)

    expect(getComputedStyle(root.querySelector('.pm-image-tool')!).fontSize).toBe('12px')
    expect(getComputedStyle(root.querySelector('.pm-diagram-view-btn')!).fontSize).toBe('12px')
    expect(getComputedStyle(root.querySelector('.pm-diagram-empty')!).fontSize).toBe('13px')
  })

  it('P88:加载态与常态纸壳四角重合，并使用同一无外投影声明', () => {
    const root = panelRoot(`
      <main class="ws-right">
        <div class="ws-paper-shell"></div>
        <div class="ws-document-content">
          <div class="doc-empty qing-empty" data-wf="QingLoading"></div>
        </div>
      </main>
    `)
    const shell = root.querySelector<HTMLElement>('.ws-paper-shell')!
    const loading = root.querySelector<HTMLElement>('.qing-empty')!
    const sharedRect = { left: 95, top: 88, width: 780, height: 712 }
    const shellRect = setRect(shell, sharedRect)
    const loadingRect = setRect(loading, sharedRect)
    const corners = [
      [shellRect.left + 1, shellRect.top + 1],
      [shellRect.right - 1, shellRect.top + 1],
      [shellRect.left + 1, shellRect.bottom - 1],
      [shellRect.right - 1, shellRect.bottom - 1],
    ]

    expect(loadingRect).toMatchObject({
      left: shellRect.left,
      top: shellRect.top,
      right: shellRect.right,
      bottom: shellRect.bottom,
    })
    expect(corners.every(([x, y]) => contains(loadingRect, x!, y!))).toBe(true)
    expect(getComputedStyle(loading).boxShadow).toBe(getComputedStyle(shell).boxShadow)
    expect(getComputedStyle(loading).boxShadow).toBe('none')
    expect(getComputedStyle(loading).borderRadius).toMatch(/^0(?:px)?$/)
    expect(getComputedStyle(loading).backgroundColor).toBe('rgb(239, 231, 214)')
  })
})
