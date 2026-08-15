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
  let startX = 0
  let startWidth = 0
  let dragging = false

  const syncSidebar = () => {
    frame.style.setProperty('--qing-sidebar-width', `${Math.round(sidebar.getBoundingClientRect().width)}px`)
  }
  const applyPreferredWidth = () => {
    const width = clampDetailsWidth(preferredWidth, view.innerWidth)
    frame.style.setProperty('--qing-details-width', `${Math.round(width)}px`)
    root.style.setProperty('--qing-details-width', `${Math.round(width)}px`)
  }
  const handleResize = () => {
    syncSidebar()
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

  syncSidebar()
  applyPreferredWidth()
  const observer = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(handleResize)
    : null
  observer?.observe(sidebar)
  handle.addEventListener('pointerdown', pointerDown)
  view.addEventListener('pointermove', pointerMove)
  view.addEventListener('pointerup', finishDrag)
  view.addEventListener('pointercancel', finishDrag)
  view.addEventListener('resize', handleResize)

  return () => {
    observer?.disconnect()
    handle.removeEventListener('pointerdown', pointerDown)
    view.removeEventListener('pointermove', pointerMove)
    view.removeEventListener('pointerup', finishDrag)
    view.removeEventListener('pointercancel', finishDrag)
    view.removeEventListener('resize', handleResize)
    frame.style.removeProperty('--qing-details-width')
    frame.style.removeProperty('--qing-sidebar-width')
    root.style.removeProperty('--qing-details-width')
  }
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
