// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  clampDetailsWidth,
  defaultDetailsWidth,
  installDetailsColumnWidth,
  QING_DETAILS_WIDTH_STORAGE_KEY,
} from '../src/client/detailsWidth.js'

afterEach(() => window.localStorage.clear())

describe('青简 details 列宽', () => {
  it('默认遵循 clamp(560px,46vw,920px)，拖拽硬限 420px–70vw', () => {
    expect(defaultDetailsWidth(1_600)).toBe(736)
    expect(defaultDetailsWidth(900)).toBe(560)
    expect(clampDetailsWidth(200, 1_000)).toBe(420)
    expect(clampDetailsWidth(900, 1_000)).toBe(700)
  })

  it('读取持久化宽度并写到 AppFrame 变量，卸载后清除接管', () => {
    window.localStorage.setItem(QING_DETAILS_WIDTH_STORAGE_KEY, '640')
    const frame = document.createElement('div')
    frame.className = 'fixture_frame'
    const sidebar = document.createElement('div')
    sidebar.className = 'fixture_sidebarCol'
    sidebar.getBoundingClientRect = () => ({ width: 96 } as DOMRect)
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

    const dispose = installDetailsColumnWidth(root)
    expect(frame.style.getPropertyValue('--qing-sidebar-width')).toBe('96px')
    expect(frame.style.getPropertyValue('--qing-details-width')).toBe('640px')
    dispose()
    expect(frame.style.getPropertyValue('--qing-details-width')).toBe('')
    frame.remove()
  })
})
