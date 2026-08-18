export const QING_DETAILS_WIDTH_STORAGE_KEY = 'dsh-qingagent.details-width.v1'

export function clampDetailsWidth(width: number, viewportWidth: number): number {
  const maximum = Math.max(420, viewportWidth * 0.7)
  return Math.min(maximum, Math.max(420, width))
}

export function defaultDetailsWidth(viewportWidth: number): number {
  return clampDetailsWidth(Math.min(920, Math.max(560, viewportWidth * 0.46)), viewportWidth)
}

export function installDetailsColumnWidth(root: HTMLElement): () => void {
  const details = root.closest<HTMLElement>('[class*="detailsCol"]')
  const frame = details?.parentElement
  const sidebar = frame?.firstElementChild as HTMLElement | null
  const handle = root.querySelector<HTMLElement>('[data-qing-details-resizer]')
  const view = root.ownerDocument.defaultView
  if (!details || !frame || !sidebar || !handle || !view) return () => undefined

  const stored = readStoredWidth(view.localStorage)
  let preferredWidth = stored ?? defaultDetailsWidth(view.innerWidth)
  let sidebarWidth = 0
  let lastMirrored: string | null | undefined
  let startX = 0
  let startWidth = 0
  let dragging = false

  const syncSidebar = (track = parseInlineSidebarTrack(frame.style.gridTemplateColumns)) => {
    lastMirrored = track?.cssValue ?? null
    if (track) {
      sidebarWidth = track.pixels
    } else {
      const measured = sidebar.getBoundingClientRect().width
      sidebarWidth = Number.isFinite(measured) && measured > 0 ? Math.round(measured) : 280
    }
    setStyleProperty(frame.style, '--qing-sidebar-width', track?.cssValue ?? `${sidebarWidth}px`)
  }
  const availableWidth = () => Math.max(0, view.innerWidth - sidebarWidth)
  const applyPreferredWidth = () => {
    const width = clampDetailsWidth(preferredWidth, availableWidth())
    const cssWidth = `${Math.round(width)}px`
    setStyleProperty(frame.style, '--qing-details-width', cssWidth)
    setStyleProperty(root.style, '--qing-details-width', cssWidth)
    handle.setAttribute('aria-valuenow', String(Math.round(width)))
    handle.setAttribute('aria-valuemax', String(Math.round(Math.max(420, availableWidth() * 0.7))))
  }
  const handleResize = () => {
    syncSidebar()
    if (readStoredWidth(view.localStorage) === null) {
      preferredWidth = defaultDetailsWidth(availableWidth())
    }
    applyPreferredWidth()
  }
  const handleFrameStyleMutation = () => {
    const track = parseInlineSidebarTrack(frame.style.gridTemplateColumns)
    if ((track?.cssValue ?? null) === lastMirrored) return
    syncSidebar(track)
    if (readStoredWidth(view.localStorage) === null) {
      preferredWidth = defaultDetailsWidth(availableWidth())
    }
    applyPreferredWidth()
  }
  const pointerMove = (event: PointerEvent) => {
    if (!dragging) return
    preferredWidth = startWidth + startX - event.clientX
    applyPreferredWidth()
  }
  const finishDrag = (event: PointerEvent) => {
    if (!dragging) return
    dragging = false
    delete root.dataset.qingDetailsResizing
    handle.releasePointerCapture?.(event.pointerId)
    writeStoredWidth(view.localStorage, clampDetailsWidth(preferredWidth, view.innerWidth))
  }
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragging = true
    startX = event.clientX
    startWidth = details.getBoundingClientRect().width || clampDetailsWidth(preferredWidth, view.innerWidth)
    preferredWidth = startWidth
    root.dataset.qingDetailsResizing = '1'
    handle.setPointerCapture?.(event.pointerId)
  }
  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.shiftKey ? 40 : 10
    preferredWidth += event.key === 'ArrowLeft' ? step : -step
    applyPreferredWidth()
    writeStoredWidth(view.localStorage, clampDetailsWidth(preferredWidth, view.innerWidth))
  }

  handleResize()
  const observer = typeof view.MutationObserver !== 'undefined'
    ? new view.MutationObserver(handleFrameStyleMutation)
    : null
  observer?.observe(frame, { attributes: true, attributeFilter: ['style'] })
  handle.addEventListener('pointerdown', pointerDown)
  handle.addEventListener('keydown', keyDown)
  view.addEventListener('pointermove', pointerMove)
  view.addEventListener('pointerup', finishDrag)
  view.addEventListener('pointercancel', finishDrag)
  view.addEventListener('resize', handleResize)

  return () => {
    observer?.disconnect()
    handle.removeEventListener('pointerdown', pointerDown)
    handle.removeEventListener('keydown', keyDown)
    view.removeEventListener('pointermove', pointerMove)
    view.removeEventListener('pointerup', finishDrag)
    view.removeEventListener('pointercancel', finishDrag)
    view.removeEventListener('resize', handleResize)
    frame.style.removeProperty('--qing-details-width')
    frame.style.removeProperty('--qing-sidebar-width')
    root.style.removeProperty('--qing-details-width')
  }
}

function parseInlineSidebarTrack(gridTemplateColumns: string): { cssValue: string, pixels: number } | null {
  // DSH 写入的是 px 长度；只解析第一轨，后面无论三轨还是生态插件扩展出的更多轨都不参与判断。
  const match = /^\s*((?:\d+(?:\.\d+)?|\.\d+)px)(?=\s|$)/i.exec(gridTemplateColumns)
  if (!match) return null
  const pixels = Number(match[1].slice(0, -2))
  return Number.isFinite(pixels) ? { cssValue: match[1], pixels } : null
}

function setStyleProperty(style: CSSStyleDeclaration, property: string, value: string): void {
  if (style.getPropertyValue(property) !== value) style.setProperty(property, value)
}

function readStoredWidth(storage: Storage): number | null {
  try {
    const parsed = Number(storage.getItem(QING_DETAILS_WIDTH_STORAGE_KEY))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

function writeStoredWidth(storage: Storage, width: number): void {
  try {
    storage.setItem(QING_DETAILS_WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // 隐私模式 / 禁用存储时仍保留本次拖拽，不让持久化失败破坏布局。
  }
}
