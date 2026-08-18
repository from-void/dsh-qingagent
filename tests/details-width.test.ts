// @vitest-environment jsdom

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

  it('读取持久化宽度并写到 AppFrame 变量，卸载后清除接管', () => {
    window.localStorage.setItem(QING_DETAILS_WIDTH_STORAGE_KEY, '640')
    const fixture = detailsFixture()

    const dispose = installDetailsColumnWidth(fixture.root)
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('96px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('640px')
    dispose()
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('')
    fixture.frame.remove()
  })

  it('无存储偏好时由 ResizeObserver 驱动侧栏与默认面板宽度联动，且不写 localStorage', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_600 })
    const resizeObserver = installResizeObserverStub()
    const fixture = detailsFixture(640, 400)
    const dispose = installDetailsColumnWidth(fixture.root)
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')

    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('400px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('560px')
    expect(fixture.handle.getAttribute('aria-valuemax')).toBe('840')

    fixture.setSidebarWidth(100)
    resizeObserver.trigger()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('100px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('690px')
    expect(fixture.handle.getAttribute('aria-valuenow')).toBe('690')
    expect(fixture.handle.getAttribute('aria-valuemax')).toBe('1050')

    fixture.setSidebarWidth(400)
    resizeObserver.trigger()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('400px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('560px')
    expect(window.localStorage.getItem(QING_DETAILS_WIDTH_STORAGE_KEY)).toBeNull()
    expect(storageWrite).not.toHaveBeenCalled()
    dispose()
    fixture.frame.remove()
  })

  it('有存储偏好时 ResizeObserver 只按可用宽度 clamp，折叠展开不改写 localStorage', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_600 })
    window.localStorage.setItem(QING_DETAILS_WIDTH_STORAGE_KEY, '800')
    const resizeObserver = installResizeObserverStub()
    const fixture = detailsFixture(800, 400)
    const dispose = installDetailsColumnWidth(fixture.root)
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')

    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('800px')
    fixture.setSidebarWidth(600)
    resizeObserver.trigger()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('600px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('700px')

    fixture.setSidebarWidth(400)
    resizeObserver.trigger()
    expect(fixture.frame.style.getPropertyValue('--qing-sidebar-width')).toBe('400px')
    expect(fixture.frame.style.getPropertyValue('--qing-details-width')).toBe('800px')
    expect(window.localStorage.getItem(QING_DETAILS_WIDTH_STORAGE_KEY)).toBe('800')
    expect(storageWrite).not.toHaveBeenCalled()
    dispose()
    fixture.frame.remove()
  })

  it('pointer 拖拽按序列调宽并持久化 localStorage', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_200 })
    window.localStorage.setItem(QING_DETAILS_WIDTH_STORAGE_KEY, '640')
    const fixture = detailsFixture(640)
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
    const fixture = detailsFixture(640)
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

function detailsFixture(detailsWidth = 640, initialSidebarWidth = 96) {
    const frame = document.createElement('div')
    frame.className = 'fixture_frame'
    const sidebar = document.createElement('div')
    sidebar.className = 'fixture_sidebarCol'
    let sidebarWidth = initialSidebarWidth
    sidebar.getBoundingClientRect = () => ({ width: sidebarWidth } as DOMRect)
    const center = document.createElement('div')
    center.className = 'fixture_centerCol'
    const details = document.createElement('div')
    details.className = 'fixture_detailsCol'
    details.getBoundingClientRect = () => ({ width: detailsWidth } as DOMRect)
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
      root,
      handle,
      setSidebarWidth: (width: number) => { sidebarWidth = width },
    }
}

function installResizeObserverStub() {
  const callbacks: ResizeObserverCallback[] = []
  class ResizeObserverStub {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback)
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  return {
    trigger: () => {
      for (const callback of callbacks) callback([], {} as ResizeObserver)
    },
  }
}

function pointerEvent(
  type: string,
  init: MouseEventInit & { pointerId: number },
): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, ...init })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId })
  return event as unknown as PointerEvent
}
