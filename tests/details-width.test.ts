// @vitest-environment jsdom
// jsdom 25.0.1 自带 MutationObserver，但没有布局；getBoundingClientRect 恒为 0，
// 因此本文件禁止用它做像素正面断言，只在降级用例确认量法被调用及 280px 兜底。

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampDetailsWidth,
  defaultDetailsWidth,
  installDetailsColumnWidth,
  QING_DETAILS_WIDTH_STORAGE_KEY,
} from '../src/client/detailsWidth.js'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('青简 details 列宽', () => {
  it('默认遵循 clamp(560px,46vw,920px)，拖拽硬限 420px–70vw', () => {
    expect(defaultDetailsWidth(1_600)).toBe(736)
    expect(defaultDetailsWidth(900)).toBe(560)
    expect(clampDetailsWidth(200, 1_000)).toBe(420)
    expect(clampDetailsWidth(900, 1_000)).toBe(700)
  })

  it('初始即折叠时首次同步宿主行内第一轨，卸载后清除接管', () => {
    window.localStorage.setItem(QING_DETAILS_WIDTH_STORAGE_KEY, '640')
    const fixture = detailsFixture('56px minmax(0px, 1fr) 360px')

    const dispose = installDetailsColumnWidth(fixture.root)
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('56px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('640px')
    dispose()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('')
    fixture.frame.remove()
  })

  it('MutationObserver 镜像五轨首轨 56px，再随三轨宿主值展开回 280px', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_600 })
    const fixture = detailsFixture('280px minmax(0px, 1fr) 552px')
    const dispose = installDetailsColumnWidth(fixture.root)
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')
    let observerCallbacks = 0
    const observerProbe = new MutationObserver(() => { observerCallbacks += 1 })
    observerProbe.observe(fixture.frame, { attributes: true, attributeFilter: ['style'] })

    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('280px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('607px')

    fixture.frame.style.gridTemplateColumns = '56px minmax(0px, 1fr) 0px 0px 0px'
    await settleMutationObservers()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('56px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('710px')
    expect(observerCallbacks).toBeGreaterThan(0)
    expect(observerCallbacks).toBeLessThanOrEqual(2)

    observerCallbacks = 0
    fixture.frame.style.gridTemplateColumns = '280px minmax(0px, 1fr) 552px'
    await settleMutationObservers()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('280px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('607px')
    expect(observerCallbacks).toBeGreaterThan(0)
    expect(observerCallbacks).toBeLessThanOrEqual(2)
    expect(window.localStorage.getItem(QING_DETAILS_WIDTH_STORAGE_KEY)).toBeNull()
    expect(storageWrite).not.toHaveBeenCalled()
    observerProbe.disconnect()
    dispose()
    fixture.frame.remove()
  })

  it('有存储偏好时 observer 只按宿主首轨后的可用宽度 clamp，不改写 localStorage', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_600 })
    window.localStorage.setItem(QING_DETAILS_WIDTH_STORAGE_KEY, '800')
    const fixture = detailsFixture('400px minmax(0px, 1fr) 552px')
    const dispose = installDetailsColumnWidth(fixture.root)
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')

    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('800px')
    fixture.frame.style.gridTemplateColumns = '600px minmax(0px, 1fr) 552px'
    await settleMutationObservers()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('600px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('700px')

    fixture.frame.style.gridTemplateColumns = '400px minmax(0px, 1fr) 552px'
    await settleMutationObservers()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('400px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('800px')
    expect(window.localStorage.getItem(QING_DETAILS_WIDTH_STORAGE_KEY)).toBe('800')
    expect(storageWrite).not.toHaveBeenCalled()
    dispose()
    fixture.frame.remove()
  })

  it('行内首轨缺失或不可解析时不抛错，退回量法与 280px 兜底', () => {
    for (const gridTemplateColumns of [null, 'auto minmax(0px, 1fr) 360px']) {
      const fixture = detailsFixture(gridTemplateColumns)
      const measureSidebar = vi.spyOn(fixture.sidebar, 'getBoundingClientRect')
      let dispose: () => void = () => undefined

      expect(() => { dispose = installDetailsColumnWidth(fixture.root) }).not.toThrow()
      expect(measureSidebar).toHaveBeenCalled()
      expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('280px')
      dispose()
      fixture.frame.remove()
    }
  })

  it('observer 自写最多追加一次回调，仅 details 变化零写入，dispose 后不再同步', async () => {
    const fixture = detailsFixture('280px minmax(0px, 1fr) 360px')
    const dispose = installDetailsColumnWidth(fixture.root)
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')
    const frameWrite = vi.spyOn(fixture.frame.style, 'setProperty')
    let observerCallbacks = 0
    const observerProbe = new MutationObserver(() => { observerCallbacks += 1 })
    observerProbe.observe(fixture.frame, { attributes: true, attributeFilter: ['style'] })

    fixture.frame.style.gridTemplateColumns = '56px minmax(0px, 1fr) 360px'
    await settleMutationObservers()
    expect(observerCallbacks).toBeGreaterThan(0)
    expect(observerCallbacks).toBeLessThanOrEqual(2)
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('56px')

    observerCallbacks = 0
    fixture.frame.style.setProperty('--qing-details-width', '610px')
    frameWrite.mockClear()
    await settleMutationObservers()
    expect(observerCallbacks).toBe(1)
    expect(frameWrite).not.toHaveBeenCalled()
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('610px')
    expect(storageWrite).not.toHaveBeenCalled()

    observerProbe.disconnect()
    dispose()
    await settleMutationObservers()
    frameWrite.mockClear()
    fixture.frame.style.gridTemplateColumns = '280px minmax(0px, 1fr) 360px'
    await settleMutationObservers()
    expect(frameWrite).not.toHaveBeenCalled()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('')
    expect(storageWrite).not.toHaveBeenCalled()
    fixture.frame.remove()
  })

  it('pointer 拖拽按序列调宽并持久化 localStorage', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_200 })
    window.localStorage.setItem(QING_DETAILS_WIDTH_STORAGE_KEY, '640')
    const fixture = detailsFixture()
    const dispose = installDetailsColumnWidth(fixture.root)

    fixture.handle.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 500, pointerId: 7 }))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 460, pointerId: 7 }))
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 460, pointerId: 7 }))

    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('680px')
    expect(window.localStorage.getItem(QING_DETAILS_WIDTH_STORAGE_KEY)).toBe('680')
    expect(fixture.root.dataset.qingDetailsResizing).toBeUndefined()
    dispose()
    fixture.frame.remove()
  })

  it('分隔把手暴露当前值，并支持键盘左右调宽', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_200 })
    window.localStorage.setItem(QING_DETAILS_WIDTH_STORAGE_KEY, '640')
    const fixture = detailsFixture()
    const dispose = installDetailsColumnWidth(fixture.root)

    expect(fixture.handle.getAttribute('aria-valuenow')).toBe('640')
    expect(fixture.handle.getAttribute('aria-valuemax')).toBe('773')
    fixture.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('650px')
    expect(fixture.handle.getAttribute('aria-valuenow')).toBe('650')
    expect(window.localStorage.getItem(QING_DETAILS_WIDTH_STORAGE_KEY)).toBe('650')
    fixture.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('610px')
    dispose()
    fixture.frame.remove()
  })

  it('锁定已安装 DSH AppFrame 的 frame/detailsCol/centerCol/handle DOM 契约', async () => {
    const [layoutClient, qingCss] = await Promise.all([
      readFile(resolve('node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'), 'utf8'),
      readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8'),
    ])

    for (const classKey of ['frame', 'detailsCol', 'centerCol', 'handle']) {
      expect(layoutClient).toContain(`"${classKey}"`)
    }
    expect(layoutClient).toContain('side: "details"')
    expect(layoutClient).toContain('"data-side": props.side')
    expect(qingCss).toContain('[class*="frame"]:has(> [class*="detailsCol"] [data-qingagent-doc-panel])')
    expect(qingCss).toContain('> [class*="handle"][data-side="details"]')
  })
})

function detailsFixture(gridTemplateColumns: string | null = '96px minmax(0px, 1fr) 360px') {
    const frame = document.createElement('div')
    frame.className = 'fixture_frame'
    if (gridTemplateColumns !== null) frame.style.gridTemplateColumns = gridTemplateColumns
    const sidebar = document.createElement('div')
    sidebar.className = 'fixture_sidebarCol'
    const center = document.createElement('div')
    center.className = 'fixture_centerCol'
    const details = document.createElement('div')
    details.className = 'fixture_detailsCol'
    const root = document.createElement('section')
    root.dataset.qingagentDocPanel = ''
    const handle = document.createElement('div')
    handle.dataset.qingDetailsResizer = ''
    root.append(handle)
    details.append(root)
    frame.append(sidebar, center, details)
    document.body.append(frame)
    return {
      frame,
      sidebar,
      root,
      handle,
    }
}

function settleMutationObservers(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
}

function pointerEvent(
  type: string,
  init: MouseEventInit & { pointerId: number },
): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, ...init })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId })
  return event as unknown as PointerEvent
}
