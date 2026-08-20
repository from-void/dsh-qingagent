/**
 * 输入区镜像层 chip 的呈现与交互层(席 K):打标、样式注入、hover 面板、✕ 移除角标。
 * 是 installSelectionChipHoverTitles 的全面升级替代(旧函数由整合层下线,本文件不改它)。
 *
 * 布局零影响铁律:镜像层与 textarea 逐字符对齐,任何占布局/改文字度量的样式都会让
 * 输入框排版错位——注入样式只准用 background / box-shadow(spread 模拟描边)/ color /
 * border-radius;面板与角标都是 document.body 下 position:fixed 的单例浮层,不入镜像层。
 */

/**
 * 宿主 InputState 的结构子集。类型包(@deepseek-ai/* 0.1.0-rc.6)未导出该类型,
 * 字段按 SPEC 真机实测定义;occurrences 按 offset 升序。整合层传入的真实快照
 * 只要结构上含这些字段即可(TypeScript 结构类型)。
 */
export interface InputOccurrence {
  occurrenceId: number
  source: string
  ref: string
  offset: number
  label: string
  clipboardText: string
  invalid?: boolean
}

export interface InputState {
  draft: string
  draftRev: number
  phase?: string
  occurrences?: InputOccurrence[]
}

export interface ChipPresentationDeps {
  /** 当前会话 InputState 快照;无会话时 undefined */
  getInputState(): InputState | undefined
  /** 订阅 input state 变化;返回退订函数 */
  subscribeInputState(listener: () => void): () => void
  /** 整合层会接到席 C 的原语;席 K 只调用 */
  removeOccurrence(occurrenceId: number): boolean
  replaceOccurrenceRef(occurrenceId: number, newRef: string): boolean
  onToast(text: string): void
  /** 面板标题旁展示的文稿名解析(选区 chip 用);拿不到给 undefined */
  getDocTitle?(): string | undefined
}

/** 本插件的两类 chip 来源(与席 C 的 source 常量一致,本文件自洽不跨席 import)。 */
const SELECTION_SOURCE = 'qingagent-selection'
const ANNOTATION_SOURCE = 'qingagent-annotation'

/** 打标属性与浮层 id:宿主重绘丢标是常态,打标幂等、可重入。 */
const CHIP_ATTR = 'data-qing-chip'
const OCC_ATTR = 'data-qing-occ'
const PANEL_ATTR = 'data-qing-chip-panel'
const BADGE_ATTR = 'data-qing-chip-badge'
const STYLE_ID = 'qingagent-chip-presentation-style'

/** hover 面板时序:命中后 80ms 显示;离开(chip 与浮层都不含鼠标)350ms 关闭。 */
export const CHIP_PANEL_SHOW_DELAY = 80
export const CHIP_PANEL_HIDE_DELAY = 350

/** 文案冻结(SPEC):不得自造别的。 */
const TOAST_INPUT_UNAVAILABLE = '输入框当前不可用,请稍后重试'

/** 镜像层内 chip 元素的修饰类(子元素/状态类),配对时须排除。 */
const CHIP_MODIFIER_CLASSES = ['chipLabel', 'chipIcon', 'chipInvalid']

/** 收集镜像层 chip 元素,按 DOM 顺序(与 occurrences 的 offset 升序一一对应)。 */
function collectChipElements(): HTMLElement[] {
  const chips: HTMLElement[] = []
  for (const backdrop of document.querySelectorAll('[class*="backdrop"]')) {
    for (const el of backdrop.querySelectorAll('[class*="chip"]')) {
      if (!(el instanceof HTMLElement)) continue
      // className 是构建 hash 前缀,只能子串排除修饰类。
      if (CHIP_MODIFIER_CLASSES.some((modifier) => el.className.includes(modifier))) continue
      chips.push(el)
    }
  }
  return chips
}

function occurrenceKind(occurrence: InputOccurrence): 'selection' | 'annotation' | undefined {
  if (occurrence.source === SELECTION_SOURCE) return 'selection'
  if (occurrence.source === ANNOTATION_SOURCE) return 'annotation'
  return undefined
}

/**
 * 安装打标+样式+hover 面板+移除交互;返回卸载函数(移除样式、面板 DOM、监听器)。
 * 可重复安装/卸载:所有副作用都在卸载函数里清干净。
 */
export function installChipPresentation(deps: ChipPresentationDeps): () => void {
  if (typeof document === 'undefined') return () => {}

  // ---------------------------------------------------------------- 样式注入
  // 只允许不占布局的属性:background / box-shadow(spread 描边)/ color / border-radius。
  // 裸 `@` 是草稿真实字符,保持原样,绝不动它。
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    `[${CHIP_ATTR}="selection"]{`,
    'background:rgba(200,169,106,.16);',
    'box-shadow:0 0 0 1px rgba(200,169,106,.40);',
    'color:#ece4d4;',
    'border-radius:0;',
    '}',
    `[${CHIP_ATTR}="annotation"]{`,
    'background:rgba(176,84,30,.16);',
    'box-shadow:0 0 0 1px rgba(176,84,30,.45);',
    'border-radius:0;',
    '}',
  ].join('')
  document.head.appendChild(style)

  // ---------------------------------------------------------------- 打标
  // 差量打标:只改需要改的属性,本身零变更时幂等(否则 MutationObserver 会自激)。
  const retag = () => {
    const occurrences = (deps.getInputState()?.occurrences ?? [])
      .slice()
      .sort((a, b) => a.offset - b.offset)
    const chips = collectChipElements()
    const desired = new Map<HTMLElement, { kind: 'selection' | 'annotation'; occurrenceId: number }>()
    const count = Math.min(chips.length, occurrences.length)
    for (let index = 0; index < count; index += 1) {
      const kind = occurrenceKind(occurrences[index]!)
      if (kind) {
        desired.set(chips[index]!, { kind, occurrenceId: occurrences[index]!.occurrenceId })
      }
    }
    for (const el of document.querySelectorAll(`[${CHIP_ATTR}]`)) {
      if (!(el instanceof HTMLElement)) continue
      const want = desired.get(el)
      if (!want
        || el.getAttribute(CHIP_ATTR) !== want.kind
        || el.getAttribute(OCC_ATTR) !== String(want.occurrenceId)) {
        el.removeAttribute(CHIP_ATTR)
        el.removeAttribute(OCC_ATTR)
      }
    }
    for (const [el, want] of desired) {
      if (el.getAttribute(CHIP_ATTR) !== want.kind) el.setAttribute(CHIP_ATTR, want.kind)
      if (el.getAttribute(OCC_ATTR) !== String(want.occurrenceId)) {
        el.setAttribute(OCC_ATTR, String(want.occurrenceId))
      }
    }
    // 宿主重渲可能把 hover 中的 chip 换掉:旧节点已不在文档里就收浮层。
    if (hoverChip && !hoverChip.isConnected) hideOverlays()
  }

  // ---------------------------------------------------------------- 浮层单例
  const panel = document.createElement('div')
  panel.setAttribute(PANEL_ATTR, '1')
  panel.style.cssText = [
    'position:fixed', 'z-index:100600', 'display:none', 'width:360px', 'box-sizing:border-box',
    'padding:12px', 'border-radius:0',
    'background:#2e2a24', 'color:#ece4d4',
    'box-shadow:0 8px 24px rgba(0,0,0,.45)',
    'font-size:12px', 'line-height:18px',
  ].join(';')

  const badge = document.createElement('div')
  badge.setAttribute(BADGE_ATTR, '1')
  badge.textContent = '✕'
  badge.style.cssText = [
    'position:fixed', 'z-index:100601', 'display:none',
    'width:16px', 'height:16px', 'border-radius:0',
    'background:#b3541e', 'color:#ece4d4',
    'font-size:11px', 'line-height:16px', 'text-align:center',
    'cursor:pointer', 'user-select:none',
    'box-shadow:0 2px 8px rgba(0,0,0,.4)',
  ].join(';')

  const panelButton = (text: string, primary: boolean): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.style.cssText = [
      'padding:4px 14px', 'border-radius:0', 'cursor:pointer', 'font-size:12px', 'line-height:18px',
      primary
        ? 'border:1px solid #b3541e;background:#b3541e;color:#ece4d4'
        : 'border:1px solid rgba(236,228,212,.35);background:transparent;color:#ece4d4',
    ].join(';')
    return button
  }

  // ---------------------------------------------------------------- hover 状态机
  let hoverChip: HTMLElement | null = null
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const clearTimers = () => {
    if (showTimer !== undefined) { clearTimeout(showTimer); showTimer = undefined }
    if (hideTimer !== undefined) { clearTimeout(hideTimer); hideTimer = undefined }
  }

  function hideOverlays() {
    clearTimers()
    hoverChip = null
    panel.style.display = 'none'
    badge.style.display = 'none'
  }

  /** 命中 chip 变化(含初次命中):立即上 ✕ 角标,80ms 后开面板。 */
  function scheduleShow(chip: HTMLElement) {
    if (showTimer !== undefined) clearTimeout(showTimer)
    showTimer = setTimeout(() => {
      showTimer = undefined
      if (hoverChip !== chip || !chip.isConnected) return
      showPanel(chip)
    }, CHIP_PANEL_SHOW_DELAY)
  }

  function scheduleHide() {
    if (hideTimer !== undefined) return
    hideTimer = setTimeout(() => {
      hideTimer = undefined
      hideOverlays()
    }, CHIP_PANEL_HIDE_DELAY)
  }

  function positionBadge(rect: DOMRect) {
    badge.style.display = 'block'
    // 角标骑在 chip 右上角:中心对齐右上顶点。
    badge.style.left = `${Math.round(rect.right - 8)}px`
    badge.style.top = `${Math.round(rect.top - 8)}px`
  }

  function showPanel(chip: HTMLElement) {
    const occurrenceId = Number(chip.getAttribute(OCC_ATTR))
    const occurrence = deps.getInputState()?.occurrences
      ?.find((candidate) => candidate.occurrenceId === occurrenceId)
    const kind = chip.getAttribute(CHIP_ATTR)
    if (!occurrence || (kind !== 'selection' && kind !== 'annotation')) return

    panel.textContent = ''
    const header = document.createElement('div')
    header.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-bottom:8px;font-weight:600'
    const title = document.createElement('span')
    title.textContent = kind === 'selection' ? '选段内容' : '完整修改指令'
    header.appendChild(title)
    if (kind === 'selection') {
      const docTitle = deps.getDocTitle?.()?.trim()
      if (docTitle) {
        const doc = document.createElement('span')
        doc.textContent = `《${docTitle}》`
        doc.style.cssText = 'font-weight:400;opacity:.65'
        header.appendChild(doc)
      }
    }
    panel.appendChild(header)

    let editArea: HTMLTextAreaElement | undefined
    if (kind === 'selection') {
      const body = document.createElement('div')
      // ref 形如「[选段]《文稿名》:「引文」」;面板 header 已展示文稿名,正文只放引文全文。
      const quoteMatch = /「([\s\S]*)」\s*$/.exec(occurrence.ref)
      body.textContent = quoteMatch?.[1] ?? occurrence.ref
      body.style.cssText = [
        'max-height:200px', 'overflow:auto', 'margin-bottom:10px',
        'white-space:pre-wrap', 'word-break:break-word', 'opacity:.9',
      ].join(';')
      panel.appendChild(body)
    } else {
      editArea = document.createElement('textarea')
      editArea.value = occurrence.ref
      editArea.style.cssText = [
        'display:block', 'width:100%', 'height:96px', 'box-sizing:border-box', 'margin-bottom:10px',
        'padding:6px 8px', 'border-radius:0', 'resize:vertical',
        'border:1px solid rgba(236,228,212,.25)', 'background:rgba(0,0,0,.25)', 'color:#ece4d4',
        'font-size:12px', 'line-height:18px',
      ].join(';')
      panel.appendChild(editArea)
    }

    const footer = document.createElement('div')
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
    const removeButton = panelButton('移除', false)
    removeButton.addEventListener('click', () => {
      if (deps.removeOccurrence(occurrence.occurrenceId)) hideOverlays()
      else deps.onToast(TOAST_INPUT_UNAVAILABLE)
    })
    footer.appendChild(removeButton)
    if (kind === 'annotation') {
      const confirmButton = panelButton('确认', true)
      confirmButton.addEventListener('click', () => {
        if (deps.replaceOccurrenceRef(occurrence.occurrenceId, editArea?.value ?? occurrence.ref)) {
          hideOverlays()
        } else {
          deps.onToast(TOAST_INPUT_UNAVAILABLE)
        }
      })
      footer.appendChild(confirmButton)
    }
    panel.appendChild(footer)

    // 定位:chip 上方 8px,视口顶部放不下则翻转到下方;水平钳在视口内。
    const rect = chip.getBoundingClientRect()
    panel.style.display = 'block'
    const width = panel.offsetWidth || 360
    const height = panel.offsetHeight || 0
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
    let top = rect.top - height - 8
    if (top < 8) top = rect.bottom + 8
    if (height > 0 && top + height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - height - 8)
    }
    panel.style.top = `${top}px`
  }

  /** mousemove 坐标命中:镜像层 pointer-events:none,事件全落在 textarea 上。 */
  const hitChip = (event: MouseEvent): HTMLElement | null => {
    for (const el of document.querySelectorAll(`[${CHIP_ATTR}]`)) {
      const rect = el.getBoundingClientRect()
      if (event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        return el as HTMLElement
      }
    }
    return null
  }

  const onMouseMove = (event: MouseEvent) => {
    const target = event.target as Element | null
    // 鼠标在面板/角标上:浮层保持,不计离开。
    if (target?.closest?.(`[${PANEL_ATTR}], [${BADGE_ATTR}]`)) {
      if (hideTimer !== undefined) { clearTimeout(hideTimer); hideTimer = undefined }
      return
    }
    if (!target?.closest?.('textarea')) {
      if (hoverChip) scheduleHide()
      return
    }
    const chip = hitChip(event)
    if (!chip) {
      if (hoverChip) scheduleHide()
      return
    }
    if (hideTimer !== undefined) { clearTimeout(hideTimer); hideTimer = undefined }
    positionBadge(chip.getBoundingClientRect())
    if (chip !== hoverChip) {
      hoverChip = chip
      scheduleShow(chip)
    }
  }

  // ✕ 角标:mousedown 拦截(阻止落焦到 textarea 的默认行为),removeOccurrence 失败走 toast。
  const onBadgeMouseDown = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!hoverChip) return
    const occurrenceId = Number(hoverChip.getAttribute(OCC_ATTR))
    if (deps.removeOccurrence(occurrenceId)) hideOverlays()
    else deps.onToast(TOAST_INPUT_UNAVAILABLE)
  }
  badge.addEventListener('mousedown', onBadgeMouseDown)

  // 点击空白处立即收浮层(不挡正常输入:仅关闭,不拦截事件)。
  const onMouseDown = (event: MouseEvent) => {
    const target = event.target as Element | null
    if (target?.closest?.(`[${PANEL_ATTR}], [${BADGE_ATTR}]`)) return
    if (hoverChip) hideOverlays()
  }

  // ---------------------------------------------------------------- 装配与卸载
  document.body.append(panel, badge)
  document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true })
  document.addEventListener('mousedown', onMouseDown, { capture: true })
  const unsubscribeInputState = deps.subscribeInputState(retag)
  const observer = new MutationObserver((mutations) => {
    // 浮层自身的增删不触发重打标(打标是差量的,理论上不会自激,这里再省一轮)。
    for (const mutation of mutations) {
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes]
      const onlyOverlays = nodes.length > 0 && nodes.every((node) =>
        node instanceof Element && Boolean(node.closest(`[${PANEL_ATTR}], [${BADGE_ATTR}]`)))
      if (!onlyOverlays) {
        retag()
        return
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  retag()

  return () => {
    observer.disconnect()
    unsubscribeInputState()
    document.removeEventListener('mousemove', onMouseMove, { capture: true })
    document.removeEventListener('mousedown', onMouseDown, { capture: true })
    clearTimers()
    panel.remove()
    badge.remove()
    style.remove()
    hoverChip = null
    for (const el of document.querySelectorAll(`[${CHIP_ATTR}]`)) {
      el.removeAttribute(CHIP_ATTR)
      el.removeAttribute(OCC_ATTR)
    }
  }
}
