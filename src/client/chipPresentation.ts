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
import { findOccurrenceProjection } from './annotationReference.js'

/** 打标属性与浮层 id:宿主重绘丢标是常态,打标幂等、可重入。 */
const CHIP_ATTR = 'data-qing-chip'
const OCC_ATTR = 'data-qing-occ'
/** 覆盖层显示文案(图标+「批注/选段:内容」):底层投影文字被透明化,::after 按此渲染。 */
const DISPLAY_ATTR = 'data-qing-display'
const PANEL_ATTR = 'data-qing-chip-panel'
const BADGE_ATTR = 'data-qing-chip-badge'
const STYLE_ID = 'qingagent-chip-presentation-style'

/** hover 面板时序:命中后 80ms 显示;离开(chip 与浮层都不含鼠标)350ms 关闭。 */
export const CHIP_PANEL_SHOW_DELAY = 80
export const CHIP_PANEL_HIDE_DELAY = 350

/** 文案冻结(SPEC):不得自造别的。 */
const TOAST_INPUT_UNAVAILABLE = '输入框当前不可用,请稍后重试'
const TOAST_CUT_COPIED = '已复制,请手动删除'

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

/** 「修改方向」初值只留改法本身:模型爱写「替换为:"…"」一类前缀与包裹引号,
 *  评测口径(与客户端一致)要求初值不含前缀、不带引号包裹;确定性剥除比约束模型可靠。 */
export function normalizeDirectionText(text: string): string {
  let value = text.trim()
  value = value.replace(/^(?:替换为|建议改为|改写为|修改为|改为)[:：]?\s*/u, '')
  const wrappers: Array<[string, string]> = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』'], ["'", "'"]]
  for (const [open, close] of wrappers) {
    if (value.length > 1 && value.startsWith(open) && value.endsWith(close)) {
      value = value.slice(open.length, value.length - close.length).trim()
      break
    }
  }
  return value || text.trim()
}

/** 覆盖层文案:批注=✎ 笔图标,选段=“中文弯双引号(用户裁定);内容取 ref 的完整
 *  引文/修改方向,超宽由 CSS ellipsis 兜底(宽度自适应,不预截断)。ref 解析不出时
 *  回落到底层 label(剥 dedupe 圈号)。 */
export function chipDisplayText(
  kind: 'selection' | 'annotation',
  label: string,
  ref?: string,
): string {
  const fallback = label.replace(/^[①-⑳]|^#\d+/u, '')
  if (kind === 'annotation') {
    const body = (ref ?? '').replace(/\s+/gu, ' ').trim()
      .replace(/^按批注修改[:\uFF1A]/u, '')
      .replace(/[（(]原文[:\uFF1A]『[\s\S]*』[)）]\s*$/u, '')
      .trim()
    const direction = /^[\s\S]{1,60}?——([\s\S]+)$/u.exec(body)?.[1]?.trim() ?? body
    return `✎ 批注：${direction || fallback}`
  }
  const quote = /[:\uFF1A]\s*「([\s\S]*)」\s*$/u.exec(ref ?? '')?.[1]?.replace(/\s+/gu, ' ').trim()
  return `\u201C选段：${quote || fallback}`
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
    // 用户裁定:选区 chip 是「带一定颜色的块」;文字色跟随宿主主题(写死浅字在亮色主题下看不清)。
    'background:rgba(200,169,106,.38);',
    'box-shadow:0 0 0 1px rgba(200,169,106,.75);',
    'color:var(--dsw-alias-label-primary, inherit);',
    'border-radius:0;',
    '}',
    `[${CHIP_ATTR}="annotation"]{`,
    'background:rgba(186,92,38,.38);',
    'box-shadow:0 0 0 1px rgba(186,92,38,.8);',
    'color:var(--dsw-alias-label-primary, inherit);',
    'border-radius:0;',
    '}',
    // 覆盖层显示(用户裁定:图标+「批注/选段:内容」12 号字):底层投影文字透明化,
    // ::after 绝对定位覆盖——与宿主 chipLabel 同机制,不占布局、不改底层字符度量。
    `[${CHIP_ATTR}][${DISPLAY_ATTR}]{`,
    'position:relative;',
    'color:transparent !important;',
    '}',
    `[${CHIP_ATTR}][${DISPLAY_ATTR}] *{`,
    'color:transparent !important;',
    '}',
    `[${CHIP_ATTR}][${DISPLAY_ATTR}]::after{`,
    `content:attr(${DISPLAY_ATTR});`,
    'position:absolute;', 'inset:0;', 'padding:0 20px 0 6px;', 'box-sizing:border-box;',
    'font-size:12px;',
    // 垂直居中用 flex(用户实测 line-height 继承对不齐);ellipsis 需要 block 容器,
    // 由内层 display:block + overflow 承担——flex 下直接给 ::after 生效于单行文本。
    'display:flex;', 'align-items:center;',
    'color:var(--dsw-alias-label-primary, #ece4d4);',
    'white-space:nowrap;', 'overflow:hidden;', 'text-overflow:ellipsis;',
    '}',
    // 划选扫过 chip 时,透明的底层投影字符会以选区样式显形放大(用户实测);
    // 选中反馈只保留整块背景,不显字。
    `[${CHIP_ATTR}][${DISPLAY_ATTR}]::selection{ color:transparent; }`,
    `[${CHIP_ATTR}][${DISPLAY_ATTR}] *::selection{ color:transparent; }`,
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
    // 宿主新版镜像层自带 data-occurrence(真机实证):有则精确配对,残缺投影/乱序时不会错标;
    // 旧版缺该属性时退回按 DOM 序与 offset 序对齐。
    const byHostOcc = new Map<string, HTMLElement>()
    for (const el of chips) {
      const hostOcc = el.getAttribute('data-occurrence')
      if (hostOcc !== null) byHostOcc.set(hostOcc, el)
    }
    if (byHostOcc.size > 0) {
      for (const occurrence of occurrences) {
        const el = byHostOcc.get(String(occurrence.occurrenceId))
        const kind = el ? occurrenceKind(occurrence) : undefined
        if (el && kind) desired.set(el, { kind, occurrenceId: occurrence.occurrenceId })
      }
    } else {
      const count = Math.min(chips.length, occurrences.length)
      for (let index = 0; index < count; index += 1) {
        const kind = occurrenceKind(occurrences[index]!)
        if (kind) {
          desired.set(chips[index]!, { kind, occurrenceId: occurrences[index]!.occurrenceId })
        }
      }
    }
    const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]))
    for (const el of document.querySelectorAll(`[${CHIP_ATTR}]`)) {
      if (!(el instanceof HTMLElement)) continue
      const want = desired.get(el)
      if (!want
        || el.getAttribute(CHIP_ATTR) !== want.kind
        || el.getAttribute(OCC_ATTR) !== String(want.occurrenceId)) {
        el.removeAttribute(CHIP_ATTR)
        el.removeAttribute(OCC_ATTR)
        el.removeAttribute(DISPLAY_ATTR)
      }
    }
    for (const [el, want] of desired) {
      if (el.getAttribute(CHIP_ATTR) !== want.kind) el.setAttribute(CHIP_ATTR, want.kind)
      if (el.getAttribute(OCC_ATTR) !== String(want.occurrenceId)) {
        el.setAttribute(OCC_ATTR, String(want.occurrenceId))
      }
      const source = occurrenceById.get(want.occurrenceId)
      const display = chipDisplayText(want.kind, source?.label ?? '', source?.ref)
      if (el.getAttribute(DISPLAY_ATTR) !== display) el.setAttribute(DISPLAY_ATTR, display)
    }
    // 宿主重渲可能把 hover 中的 chip 换掉:旧节点已不在文档里就收浮层。
    if (hoverChip && !hoverChip.isConnected) hideOverlays()
    scheduleWrapCheck()
  }

  // 投影字符流在行尾会被 overflow-wrap:anywhere 拆成两段(textarea 与镜像同规则,
  // 数据层就跨行);absolute 覆盖层只画在第一段上,第二段成透明空块(用户实测)。
  // 跨行的 chip 撤覆盖层退化为底层原样文字——宁可原样大字,不可空白。
  let wrapCheckQueued = false
  function scheduleWrapCheck(): void {
    if (wrapCheckQueued || typeof requestAnimationFrame !== 'function') return
    wrapCheckQueued = true
    requestAnimationFrame(() => {
      wrapCheckQueued = false
      for (const el of document.querySelectorAll(`[${CHIP_ATTR}][${DISPLAY_ATTR}]`)) {
        if (!(el instanceof HTMLElement)) continue
        if (el.getClientRects().length > 1) el.removeAttribute(DISPLAY_ATTR)
      }
    })
  }

  // ---------------------------------------------------------------- 浮层单例
  const panel = document.createElement('div')
  panel.setAttribute(PANEL_ATTR, '1')
  // 跟随宿主明暗主题(dsw 令牌;写死深色在浅色主题下是一坨黑块——用户实测点名)。
  panel.style.cssText = [
    'position:fixed', 'z-index:100600', 'display:none', 'width:360px', 'box-sizing:border-box',
    'padding:12px', 'border-radius:0',
    'background:var(--dsw-alias-bg-layer-3, #2e2a24)',
    'color:var(--dsw-alias-label-primary, #ece4d4)',
    'border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
    'box-shadow:var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.35))',
    'font-size:12px', 'line-height:18px',
  ].join(';')

  // 自绘瞬时提示:宿主 notify 的 notice 呈现依赖输入机状态,cut 降级等场景用户
  // 实测看不到(评测 r5 席3 4.5)——改为插件自绘,2.5 秒自动消失,主题令牌自适应。
  const toastEl = document.createElement('div')
  toastEl.setAttribute(PANEL_ATTR, '1')
  toastEl.style.cssText = [
    'position:fixed', 'z-index:100602', 'display:none', 'left:50%', 'bottom:96px',
    'transform:translateX(-50%)', 'max-width:70vw', 'padding:7px 14px', 'border-radius:0',
    'background:var(--dsw-alias-bg-layer-3, #2e2a24)',
    'color:var(--dsw-alias-label-primary, #ece4d4)',
    'border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
    'box-shadow:var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.35))',
    'font-size:12px', 'line-height:18px', 'white-space:nowrap', 'pointer-events:none',
  ].join(';')
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const showToast = (text: string) => {
    toastEl.textContent = text
    toastEl.style.display = 'block'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastEl.style.display = 'none' }, 2_500)
    // 宿主通道保留:输入机状态允许时 notice 同步出现,双保险不冲突。
    deps.onToast(text)
  }

  const badge = document.createElement('div')
  badge.setAttribute(BADGE_ATTR, '1')
  badge.textContent = '✕'
  badge.style.cssText = [
    'position:fixed', 'z-index:100601', 'display:none',
    'width:16px', 'height:16px', 'border-radius:0',
    'background:var(--dsw-alias-bg-layer-3, #26282c)',
    'color:var(--dsw-alias-label-secondary, #b9b3a8)',
    'border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
    'font-size:10px', 'line-height:14px', 'text-align:center',
    'cursor:pointer', 'user-select:none',
    'box-shadow:var(--dsw-shadow-lv2, 0 2px 8px rgba(0,0,0,.3))',
  ].join(';')

  const panelButton = (text: string, primary: boolean): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.style.cssText = [
      'padding:4px 14px', 'border-radius:0', 'cursor:pointer', 'font-size:12px', 'line-height:18px',
      primary
        ? 'border:1px solid #b3541e;background:#b3541e;color:#f5efdf'
        : 'border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary, #ece4d4)',
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
    // 用户裁定:✕ 不做浮动角标,贴在 chip 内部最右侧,垂直居中。
    badge.style.left = `${Math.round(rect.right - 18)}px`
    badge.style.top = `${Math.round(rect.top + (rect.height - 16) / 2)}px`
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
    title.textContent = kind === 'selection' ? '选段内容' : '批注修改'
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
      // 结构化(用户裁定):原文只读,输入框只留「修改方向」。
      // 指令真源格式:按批注修改:{方向}(原文:『{引文}』);引文缺省时整段视为方向。
      const parsed = /^按批注修改[:：]([\s\S]*?)(?:[（(]原文[:：]『([\s\S]*)』[)）])?\s*$/u.exec(occurrence.ref)
      const action = parsed?.[1]?.trim() ?? occurrence.ref
      const quote = parsed?.[2]
      // 真源 action = 「{问题摘要}——{改法}」:摘要只读展示,输入框只留改法(修改方向)。
      const dashSplit = /^([\s\S]{1,60}?)——([\s\S]*)$/u.exec(action)
      const summary = dashSplit?.[1]?.trim()
      const direction = normalizeDirectionText(dashSplit?.[2]?.trim() ?? action)
      const fieldLabel = (text: string): HTMLElement => {
        const label = document.createElement('div')
        label.textContent = text
        label.style.cssText = 'font-size:11px;opacity:.65;margin-bottom:4px'
        return label
      }
      if (summary) {
        panel.appendChild(fieldLabel('问题'))
        const summaryLine = document.createElement('div')
        summaryLine.textContent = summary
        summaryLine.style.cssText = 'margin-bottom:8px;font-weight:600'
        panel.appendChild(summaryLine)
      }
      if (quote) {
        panel.appendChild(fieldLabel('原文'))
        const quoteBlock = document.createElement('div')
        quoteBlock.textContent = quote
        quoteBlock.style.cssText = [
          'max-height:120px', 'overflow:auto', 'margin-bottom:10px', 'padding:6px 8px',
          'white-space:pre-wrap', 'word-break:break-word', 'opacity:.85',
          'border-left:2px solid rgba(186,92,38,.6)',
          'background:var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
        ].join(';')
        panel.appendChild(quoteBlock)
      }
      panel.appendChild(fieldLabel('修改方向'))
      editArea = document.createElement('textarea')
      editArea.value = direction
      editArea.style.cssText = [
        'width:100%', 'box-sizing:border-box', 'height:72px', 'resize:none',
        'padding:7px 8px', 'border-radius:0', 'margin-bottom:10px',
        'background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.06))',
        'color:var(--dsw-alias-label-primary, #ece4d4)',
        'border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
        'font-size:12px', 'line-height:18px', 'outline:none',
      ].join(';')
      panel.appendChild(editArea)
      // 确认时按真源格式重组完整指令(问题摘要与原文保持不动)。
      editArea.dataset.qingQuote = quote ?? ''
      editArea.dataset.qingSummary = summary ?? ''
    }

    const footer = document.createElement('div')
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
    const removeButton = panelButton('移除', false)
    removeButton.addEventListener('click', () => {
      if (deps.removeOccurrence(occurrence.occurrenceId)) hideOverlays()
      else showToast(TOAST_INPUT_UNAVAILABLE)
    })
    footer.appendChild(removeButton)
    if (kind === 'annotation') {
      const confirmButton = panelButton('确认', true)
      confirmButton.addEventListener('click', () => {
        const direction = editArea?.value?.trim() ?? ''
        const quote = editArea?.dataset.qingQuote
        const summary = editArea?.dataset.qingSummary
        const action = summary ? `${summary}——${direction}` : direction
        const rebuilt = direction
          ? `按批注修改：${action}${quote ? `（原文：『${quote}』）` : ''}`
          : occurrence.ref
        if (deps.replaceOccurrenceRef(occurrence.occurrenceId, rebuilt)) {
          hideOverlays()
        } else {
          showToast(TOAST_INPUT_UNAVAILABLE)
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
    else showToast(TOAST_INPUT_UNAVAILABLE)
  }
  badge.addEventListener('mousedown', onBadgeMouseDown)

  // 点击空白处立即收浮层(不挡正常输入:仅关闭,不拦截事件)。
  const onMouseDown = (event: MouseEvent) => {
    const target = event.target as Element | null
    if (target?.closest?.(`[${PANEL_ATTR}], [${BADGE_ATTR}]`)) return
    if (hoverChip) hideOverlays()
  }

  // ---------------------------------------------------------------- 装配与卸载
  document.body.append(panel, badge, toastEl)
  document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true })
  document.addEventListener('mousedown', onMouseDown, { capture: true })
  // ---------------------------------------------------------------- chip 原子化(用户裁定)
  // chip 是整体:光标不允许落进投影文本内部;Backspace/Delete 命中时整体删除,不许拆字。
  const ourProjections = (): Array<{ occurrenceId: number; start: number; end: number; clipboardText: string }> => {
    const state = deps.getInputState()
    if (!state) return []
    const result: Array<{ occurrenceId: number; start: number; end: number; clipboardText: string }> = []
    for (const occurrence of state.occurrences ?? []) {
      if (!occurrenceKind(occurrence)) continue
      const projection = findOccurrenceProjection(state as never, occurrence.occurrenceId)
      if (projection) result.push({
        occurrenceId: occurrence.occurrenceId,
        clipboardText: occurrence.clipboardText,
        ...projection,
      })
    }
    return result.sort((left, right) => left.start - right.start)
  }
  const composerOf = (target: EventTarget | null): HTMLTextAreaElement | null =>
    target instanceof HTMLTextAreaElement && !target.closest(`[${PANEL_ATTR}]`) ? target : null
  const onSelectionChange = () => {
    const textarea = composerOf(document.activeElement)
    if (!textarea || textarea.selectionStart !== textarea.selectionEnd) return
    const pos = textarea.selectionStart
    for (const projection of ourProjections()) {
      if (pos > projection.start && pos < projection.end) {
        const snap = pos - projection.start <= projection.end - pos ? projection.start : projection.end
        textarea.setSelectionRange(snap, snap)
        return
      }
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    const textarea = composerOf(event.target)
    if (!textarea || textarea.selectionStart !== textarea.selectionEnd) return
    const pos = textarea.selectionStart
    for (const projection of ourProjections()) {
      const hit = event.key === 'Backspace'
        ? pos > projection.start && pos <= projection.end
        : pos >= projection.start && pos < projection.end
      if (hit) {
        event.preventDefault()
        event.stopPropagation()
        if (!deps.removeOccurrence(projection.occurrenceId)) showToast(TOAST_INPUT_UNAVAILABLE)
        return
      }
    }
  }
  const onClipboard = (event: ClipboardEvent) => {
    const textarea = composerOf(event.target)
    const state = deps.getInputState()
    // occurrence offset 只对当前 InputState.draft 有效；宿主状态尚未追上 textarea 时
    // 放回原生复制，避免按旧坐标展开错误 occurrence。
    if (!textarea || !state || textarea.value !== state.draft || !event.clipboardData) return
    const selectionStart = textarea.selectionStart
    const selectionEnd = textarea.selectionEnd
    if (selectionStart === selectionEnd) return
    const intersecting = ourProjections().filter((projection) =>
      selectionStart < projection.end && selectionEnd > projection.start)
    if (intersecting.length === 0) return

    let cursor = selectionStart
    const parts: string[] = []
    for (const projection of intersecting) {
      const plainEnd = Math.min(selectionEnd, Math.max(cursor, projection.start))
      if (plainEnd > cursor) parts.push(state.draft.slice(cursor, plainEnd))
      parts.push(projection.clipboardText)
      cursor = Math.min(selectionEnd, Math.max(cursor, projection.end))
    }
    if (cursor < selectionEnd) parts.push(state.draft.slice(cursor, selectionEnd))
    event.clipboardData.setData('text/plain', parts.join(''))
    event.preventDefault()
    // 原生 cut 的删除会被 preventDefault 一并拦下；保守降级为复制，避免宿主 diff
    // 在跨 chip 选区里误伤相邻 occurrence 的完整载荷。
    if (event.type === 'cut') showToast(TOAST_CUT_COPIED)
  }
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('keydown', onKeyDown, { capture: true })
  document.addEventListener('copy', onClipboard, { capture: true })
  document.addEventListener('cut', onClipboard, { capture: true })

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
  // 输入框宽度变化会改变折行形态:变窄要退化、变宽要恢复覆盖层,都走幂等 retag。
  window.addEventListener('resize', retag)
  retag()

  return () => {
    observer.disconnect()
    window.removeEventListener('resize', retag)
    unsubscribeInputState()
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('keydown', onKeyDown, { capture: true })
    document.removeEventListener('copy', onClipboard, { capture: true })
    document.removeEventListener('cut', onClipboard, { capture: true })
    document.removeEventListener('mousemove', onMouseMove, { capture: true })
    document.removeEventListener('mousedown', onMouseDown, { capture: true })
    clearTimers()
    if (toastTimer) clearTimeout(toastTimer)
    panel.remove()
    badge.remove()
    toastEl.remove()
    style.remove()
    hoverChip = null
    for (const el of document.querySelectorAll(`[${CHIP_ATTR}]`)) {
      el.removeAttribute(CHIP_ATTR)
      el.removeAttribute(OCC_ATTR)
    }
  }
}
