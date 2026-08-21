// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHIP_PANEL_HIDE_DELAY,
  CHIP_PANEL_SHOW_DELAY,
  installChipPresentation,
  type ChipPresentationDeps,
  type InputOccurrence,
  type InputState,
} from '../src/client/chipPresentation.js'

/** 宿主镜像层 fixture:hash 类名可换,结构对齐 SPEC 真机实测。 */
function mountComposer(hash = 'uV2eYG') {
  const textarea = document.createElement('textarea')
  const backdrop = document.createElement('div')
  backdrop.className = `${hash}_backdrop`
  backdrop.style.pointerEvents = 'none'
  document.body.append(textarea, backdrop)
  return { textarea, backdrop }
}

function appendChip(backdrop: HTMLElement, hash: string, label: string) {
  const chip = document.createElement('span')
  chip.className = `${hash}_chip`
  chip.append('@', document.createElement('span'))
  chip.lastElementChild!.textContent = label
  backdrop.appendChild(chip)
  return chip
}

function stubRect(el: Element, rect: { left: number; top: number; right: number; bottom: number }) {
  el.getBoundingClientRect = () => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  }) as DOMRect
}

function occurrence(partial: Partial<InputOccurrence> & Pick<InputOccurrence, 'occurrenceId' | 'offset' | 'source'>): InputOccurrence {
  return {
    ref: `ref-${partial.occurrenceId}`,
    label: `label-${partial.occurrenceId}`,
    clipboardText: `ref-${partial.occurrenceId}`,
    ...partial,
  }
}

interface Harness {
  deps: ChipPresentationDeps
  state: { current: InputState | undefined }
  listeners: (() => void)[]
  removeOccurrence: ReturnType<typeof vi.fn<(id: number) => boolean>>
  replaceOccurrenceRef: ReturnType<typeof vi.fn<(id: number, ref: string) => boolean>>
  onToast: ReturnType<typeof vi.fn<(text: string) => void>>
  emitState(): void
}

function makeDeps(occurrences: InputOccurrence[] = []): Harness {
  const state: { current: InputState | undefined } = {
    current: { draft: '', draftRev: 0, phase: 'plain', occurrences },
  }
  const listeners: (() => void)[] = []
  const removeOccurrence = vi.fn<(id: number) => boolean>(() => true)
  const replaceOccurrenceRef = vi.fn<(id: number, ref: string) => boolean>(() => true)
  const onToast = vi.fn<(text: string) => void>()
  const deps: ChipPresentationDeps = {
    getInputState: () => state.current,
    subscribeInputState: (listener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    removeOccurrence,
    replaceOccurrenceRef,
    onToast,
  }
  return { deps, state, listeners, removeOccurrence, replaceOccurrenceRef, onToast, emitState: () => listeners.forEach((l) => l()) }
}

const panel = () => document.querySelector<HTMLElement>('[data-qing-chip-panel]')
const badge = () => document.querySelector<HTMLElement>('[data-qing-chip-badge]')

function hover(textarea: HTMLTextAreaElement, x: number, y: number) {
  textarea.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }))
}

/** MutationObserver 回调走 microtask(jsdom),等两拍让它 flush;假计时器下也安全。 */
const flushObserver = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

let uninstall: (() => void) | undefined

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

describe('chip 打标', () => {
  it('按 DOM 顺序与 occurrences(offset 升序)配对,只给本插件两来源打标', () => {
    const { backdrop } = mountComposer()
    const foreignChip = appendChip(backdrop, 'uV2eYG', '宿主提及')
    const selectionChip = appendChip(backdrop, 'uV2eYG', '春风又绿江…')
    const annotationChip = appendChip(backdrop, 'uV2eYG', '按批注修改:…')
    const harness = makeDeps([
      occurrence({ occurrenceId: 1, offset: 0, source: 'host-mention' }),
      occurrence({ occurrenceId: 2, offset: 6, source: 'qingagent-selection' }),
      occurrence({ occurrenceId: 3, offset: 20, source: 'qingagent-annotation' }),
    ])

    uninstall = installChipPresentation(harness.deps)

    expect(foreignChip.hasAttribute('data-qing-chip')).toBe(false)
    expect(selectionChip.getAttribute('data-qing-chip')).toBe('selection')
    expect(selectionChip.getAttribute('data-qing-occ')).toBe('2')
    expect(annotationChip.getAttribute('data-qing-chip')).toBe('annotation')
    expect(annotationChip.getAttribute('data-qing-occ')).toBe('3')
  })

  it('排除 chipLabel/chipIcon/chipInvalid 修饰类,兼容 hash 类名变体', () => {
    const { backdrop } = mountComposer('a9Xb21')
    const chip = appendChip(backdrop, 'a9Xb21', '选段一')
    const inner = document.createElement('span')
    inner.className = 'a9Xb21_chipLabel'
    chip.appendChild(inner)
    const harness = makeDeps([
      occurrence({ occurrenceId: 7, offset: 0, source: 'qingagent-selection' }),
    ])

    uninstall = installChipPresentation(harness.deps)

    expect(chip.getAttribute('data-qing-occ')).toBe('7')
    expect(inner.hasAttribute('data-qing-chip')).toBe(false)
  })

  it('打标幂等可重入:state 订阅重复触发后属性不变', () => {
    const { backdrop } = mountComposer()
    const chip = appendChip(backdrop, 'uV2eYG', '选段一')
    const harness = makeDeps([
      occurrence({ occurrenceId: 5, offset: 0, source: 'qingagent-selection' }),
    ])
    uninstall = installChipPresentation(harness.deps)

    harness.emitState()
    harness.emitState()

    expect(chip.getAttribute('data-qing-chip')).toBe('selection')
    expect(chip.getAttribute('data-qing-occ')).toBe('5')
  })

  it('两种投影形态的 chip 集合变化后由 MutationObserver 重打标(增/删 chip)', async () => {
    const { backdrop } = mountComposer()
    // 形态一:U+FFFC 单字符投影;形态二:`@`+label 多字符文本——打标只看 DOM 顺序,与投影文本无关。
    const chipA = appendChip(backdrop, 'uV2eYG', '￼')
    const harness = makeDeps([
      occurrence({ occurrenceId: 1, offset: 0, source: 'qingagent-selection' }),
      occurrence({ occurrenceId: 2, offset: 2, source: 'qingagent-annotation' }),
    ])
    uninstall = installChipPresentation(harness.deps)
    expect(chipA.getAttribute('data-qing-occ')).toBe('1')

    // 宿主重渲:追加第二枚 chip。
    const chipB = appendChip(backdrop, 'uV2eYG', '按批注修改:…')
    await flushObserver()
    expect(chipB.getAttribute('data-qing-chip')).toBe('annotation')
    expect(chipB.getAttribute('data-qing-occ')).toBe('2')

    // 宿主重渲:移除第一枚 chip,旧标应转移给剩余 chip。
    chipA.remove()
    await flushObserver()
    expect(chipB.getAttribute('data-qing-chip')).toBe('selection')
    expect(chipB.getAttribute('data-qing-occ')).toBe('1')
  })
})

describe('hover 面板与 ✕ 角标', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  function mountHoveredChip(source = 'qingagent-selection') {
    const { textarea, backdrop } = mountComposer()
    const chip = appendChip(backdrop, 'uV2eYG', '选段一')
    stubRect(chip, { left: 100, top: 100, right: 200, bottom: 120 })
    const harness = makeDeps([
      occurrence({ occurrenceId: 9, offset: 0, source }),
    ])
    uninstall = installChipPresentation(harness.deps)
    hover(textarea, 150, 110)
    return { textarea, chip, harness }
  }

  it('命中后 80ms 开面板,离开 350ms 关闭(假计时器)', () => {
    const { textarea } = mountHoveredChip()
    expect(panel()!.style.display).toBe('none')
    expect(badge()!.style.display).toBe('block')

    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)
    expect(panel()!.style.display).toBe('block')
    expect(panel()!.textContent).toContain('选段内容')

    // 移出 chip:350ms 内不关,超时关闭。
    hover(textarea, 10, 10)
    vi.advanceTimersByTime(CHIP_PANEL_HIDE_DELAY - 1)
    expect(panel()!.style.display).toBe('block')
    vi.advanceTimersByTime(1)
    expect(panel()!.style.display).toBe('none')
    expect(badge()!.style.display).toBe('none')
  })

  it('鼠标进入面板不打断展示,面板视为 hover 延续', () => {
    mountHoveredChip()
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)
    expect(panel()!.style.display).toBe('block')

    panel()!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0, clientY: 0 }))
    vi.advanceTimersByTime(CHIP_PANEL_HIDE_DELAY * 2)
    expect(panel()!.style.display).toBe('block')
  })

  it('选段面板:标题+文稿名+完整 ref 只读文本;无文稿名则省略', () => {
    const { harness } = mountHoveredChip()
    harness.deps.getDocTitle = () => '泊船瓜洲'
    harness.state.current!.occurrences![0]!.ref = '[选段]《泊船瓜洲》:「春风又绿江南岸」'
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)

    expect(panel()!.textContent).toContain('选段内容')
    expect(panel()!.textContent).toContain('《泊船瓜洲》')
    // 面板正文只展示引文全文(文稿名已在 header),避免 [选段] 包装被气泡装饰器二次装饰。
    expect(panel()!.textContent).toContain('春风又绿江南岸')
    expect(panel()!.textContent).not.toContain('[选段]')
    expect(panel()!.querySelector('textarea')).toBeNull()
    expect(panel()!.textContent).toContain('移除')
    expect(panel()!.textContent).not.toContain('确认')
  })

  it('批注面板结构化:原文只读、输入框只留修改方向;「确认」按真源格式重组', () => {
    const { harness } = mountHoveredChip('qingagent-annotation')
    harness.state.current!.occurrences![0]!.ref = '按批注修改：删除房号（原文：『晨光路19号801室』）'
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)

    expect(panel()!.textContent).toContain('批注修改')
    expect(panel()!.textContent).toContain('原文')
    expect(panel()!.textContent).toContain('晨光路19号801室')
    const editArea = panel()!.querySelector('textarea')!
    expect(editArea.value).toBe('删除房号')
    editArea.value = '改为「家住本社区」'

    const buttons = [...panel()!.querySelectorAll('button')]
    buttons.find((b) => b.textContent === '确认')!.click()
    expect(harness.replaceOccurrenceRef).toHaveBeenCalledWith(
      9, '按批注修改：改为「家住本社区」（原文：『晨光路19号801室』）')
    expect(panel()!.style.display).toBe('none')
  })

  it('批注面板:无原文尾缀的指令整段作为修改方向', () => {
    const { harness } = mountHoveredChip('qingagent-annotation')
    harness.state.current!.occurrences![0]!.ref = '按批注修改:把时间改成四月'
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)

    const editArea = panel()!.querySelector('textarea')!
    expect(editArea.value).toBe('把时间改成四月')
    editArea.value = '改成五月'
    ;[...panel()!.querySelectorAll('button')].find((b) => b.textContent === '确认')!.click()
    expect(harness.replaceOccurrenceRef).toHaveBeenCalledWith(9, '按批注修改：改成五月')
  })

  it('确认失败:不关面板并 toast 冻结文案', () => {
    const { harness } = mountHoveredChip('qingagent-annotation')
    harness.replaceOccurrenceRef.mockReturnValue(false)
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)

    ;[...panel()!.querySelectorAll('button')].find((b) => b.textContent === '确认')!.click()
    expect(harness.onToast).toHaveBeenCalledWith('输入框当前不可用,请稍后重试')
    expect(panel()!.style.display).toBe('block')
  })

  it('面板「移除」按钮调 removeOccurrence;失败 toast', () => {
    const { harness } = mountHoveredChip()
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)
    ;[...panel()!.querySelectorAll('button')].find((b) => b.textContent === '移除')!.click()
    expect(harness.removeOccurrence).toHaveBeenCalledWith(9)
    expect(panel()!.style.display).toBe('none')

    // 失败路径:toast 且不回撤。
    hover(document.querySelector('textarea')!, 150, 110)
    harness.removeOccurrence.mockReturnValue(false)
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)
    ;[...panel()!.querySelectorAll('button')].find((b) => b.textContent === '移除')!.click()
    expect(harness.onToast).toHaveBeenCalledWith('输入框当前不可用,请稍后重试')
  })

  it('✕ 角标 mousedown 拦截默认行为并调 removeOccurrence', () => {
    const { harness } = mountHoveredChip()
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    badge()!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(harness.removeOccurrence).toHaveBeenCalledWith(9)
  })

  it('面板定位:chip 上方 8px,贴近视口顶部时翻转到下方', () => {
    const { chip, textarea } = mountHoveredChip()
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)
    // jsdom offsetHeight=0:top = 100 - 0 - 8 = 92。
    expect(panel()!.style.top).toBe('92px')

    // 换个贴顶的 chip:翻转到底边+8。
    uninstall?.()
    uninstall = undefined
    stubRect(chip, { left: 100, top: 5, right: 200, bottom: 25 })
    const harness = makeDeps([
      occurrence({ occurrenceId: 9, offset: 0, source: 'qingagent-selection' }),
    ])
    uninstall = installChipPresentation(harness.deps)
    hover(textarea, 150, 15)
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY)
    expect(panel()!.style.top).toBe('33px')
  })
})

describe('卸载', () => {
  it('清干净样式、浮层、observer、监听器与打标;可重复安装', async () => {
    vi.useFakeTimers()
    const { textarea, backdrop } = mountComposer()
    const chip = appendChip(backdrop, 'uV2eYG', '选段一')
    stubRect(chip, { left: 100, top: 100, right: 200, bottom: 120 })
    const harness = makeDeps([
      occurrence({ occurrenceId: 9, offset: 0, source: 'qingagent-selection' }),
    ])
    const off = installChipPresentation(harness.deps)
    expect(document.getElementById('qingagent-chip-presentation-style')).not.toBeNull()
    expect(chip.getAttribute('data-qing-chip')).toBe('selection')

    off()

    expect(document.getElementById('qingagent-chip-presentation-style')).toBeNull()
    expect(panel()).toBeNull()
    expect(badge()).toBeNull()
    expect(chip.hasAttribute('data-qing-chip')).toBe(false)
    expect(harness.listeners).toHaveLength(0)

    // 监听器已拆:hover 不再出角标。
    hover(textarea, 150, 110)
    vi.advanceTimersByTime(CHIP_PANEL_SHOW_DELAY * 2)
    expect(document.querySelector('[data-qing-chip-badge]')).toBeNull()

    // observer 已断:改 DOM 不再重打标。
    appendChip(backdrop, 'uV2eYG', '选段二')
    await flushObserver()
    expect(document.querySelector('[data-qing-chip]')).toBeNull()

    // 可重复安装:occurrences 只有 1 条,只有首枚 chip 被打标。
    uninstall = installChipPresentation(harness.deps)
    expect(document.querySelectorAll('[data-qing-chip]')).toHaveLength(1)
  })
})
