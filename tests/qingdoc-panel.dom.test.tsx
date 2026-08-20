// @vitest-environment jsdom

import { act } from 'react'
import { readFile } from 'node:fs/promises'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentSnapshotView } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import type { DocWriteBaseline } from '@qingweb/pages/workspace/data/docWriteBaseline'
import type { PmDoc } from '@qingagent/pm-schema'
import type { Editor } from '@tiptap/react'
import { QINGDOC_FIXTURE_SNAPSHOT } from '../src/qingdoc/fixture.js'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg><g/></svg>' })),
  },
}))

function polyfillLayout(): void {
  const emptyRect = () => ({
    top: 0, left: 0, right: 800, bottom: 1200, width: 800, height: 1200,
    x: 0, y: 0, toJSON: () => ({}),
  })
  Element.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Element.prototype.getBoundingClientRect = emptyRect as unknown as () => DOMRect
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = emptyRect as unknown as () => DOMRect
  document.elementFromPoint = () => null
  document.elementsFromPoint = () => []
}

polyfillLayout()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
let paperStyle: HTMLStyleElement
let panelStyle: HTMLStyleElement

beforeEach(async () => {
  paperStyle = document.createElement('style')
  paperStyle.textContent = await readFile('src/qingdoc/qingdoc.css', 'utf8')
  document.head.append(paperStyle)
  panelStyle = document.createElement('style')
  panelStyle.textContent = await readFile('src/client/QingDocPanel.css', 'utf8')
  document.head.append(panelStyle)
  host = document.createElement('section')
  host.dataset.qingagentDocPanel = ''
  host.innerHTML = `
    <div class="ws-body">
      <main class="ws-right">
        <div class="ws-paper-shell" aria-hidden="true"></div>
        <div class="ws-document-content" id="mount"></div>
      </main>
    </div>
  `
  document.body.append(host)
  root = createRoot(host.querySelector('#mount')!)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  paperStyle.remove()
  panelStyle.remove()
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function flushEditor(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })
}

function renderFixture(interactiveEditable: boolean): void {
  act(() => {
    root.render(
      <DocumentSnapshotView
        doc={QINGDOC_FIXTURE_SNAPSHOT}
        docId="dsh-fixture:dom-test"
        editable
        interactiveEditable={interactiveEditable}
        showPatches={false}
        acceptedPatches={new Set()}
        rejectedPatches={new Set()}
      />,
    )
  })
}

const LONG_PM_DOC = {
  type: 'doc',
  attrs: { schemaVersion: 1 },
  content: [
    {
      type: 'heading',
      attrs: { blockId: 'long-0', level: 1 },
      content: [{ type: 'text', text: '长文第 1 块：纸面布局回归标题' }],
    },
    ...Array.from({ length: 13 }, (_, index) => ({
      type: 'paragraph' as const,
      attrs: { blockId: `long-${index + 1}` },
      content: [{ type: 'text' as const, text: `长文第 ${index + 2} 块：用于验证纸面自然高度与外层滚动归属。` }],
    })),
  ],
} satisfies PmDoc

const SHORT_PM_DOC = {
  type: 'doc',
  attrs: { schemaVersion: 1 },
  content: Array.from({ length: 2 }, (_, index) => ({
    type: 'paragraph',
    attrs: { blockId: `short-${index}` },
    content: [{ type: 'text', text: `短文第 ${index + 1} 块` }],
  })),
} satisfies PmDoc

function renderPmDoc(pmDoc: PmDoc, wrapper?: 'review'): void {
  const view = (
    <DocumentSnapshotView
      doc={{ version: 1, ts: '2026-08-20T00:00:00.000Z', sections: [], pmDoc }}
      docId="dsh-layout:dom-test"
      editable
      interactiveEditable={false}
      showPatches={false}
      acceptedPatches={new Set()}
      rejectedPatches={new Set()}
    />
  )
  act(() => root.render(wrapper === 'review' ? <div className="wdr-swap">{view}</div> : view))
}

function setMeasuredHeight(element: HTMLElement, height: number): void {
  element.getBoundingClientRect = () => DOMRect.fromRect({ width: 468, height })
}

function setScrollMetrics(element: HTMLElement, clientHeight: number, scrollHeight: number): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
  })
}

function hasNonClippingPaperLayout(rootElement: HTMLElement): boolean {
  const paperShell = rootElement.querySelector<HTMLElement>('.ws-paper-shell')!
  const proseMirror = rootElement.querySelector<HTMLElement>('.ProseMirror')!
  if (paperShell.getBoundingClientRect().height >= proseMirror.getBoundingClientRect().height) return true

  let ancestor = proseMirror.parentElement
  while (ancestor && rootElement.contains(ancestor)) {
    const overflowY = getComputedStyle(ancestor).overflowY
    if (
      (overflowY === 'auto' || overflowY === 'scroll')
      && ancestor.scrollHeight > ancestor.clientHeight
    ) return true
    ancestor = ancestor.parentElement
  }
  return false
}

describe('青简 DocumentSnapshotView fixture', () => {
  it('面板根建立独立 stacking context，内部浮层不越过 dsh 兄弟层', () => {
    expect(getComputedStyle(host).isolation).toBe('isolate')
    const patchNav = document.createElement('nav')
    patchNav.className = 'patch-nav'
    host.append(patchNav)
    expect(getComputedStyle(patchNav).position).toBe('fixed')
  })

  it('编辑与只读复用同一 .wf-doc.ProseMirror，并保真挂出结构 NodeView', async () => {
    renderFixture(true)
    await flushEditor()

    const editablePaper = host.querySelector<HTMLElement>('.wf-doc.ProseMirror')
    expect(editablePaper).not.toBeNull()
    expect(editablePaper?.getAttribute('contenteditable')).toBe('true')
    expect(editablePaper?.querySelector('table')).not.toBeNull()
    expect(editablePaper?.querySelector('[data-bg-color="rose"]')).not.toBeNull()
    expect(editablePaper?.querySelector('.pm-callout')).not.toBeNull()
    expect(editablePaper?.querySelector('.pm-column-list')).not.toBeNull()
    expect(editablePaper?.querySelectorAll('.pm-column')).toHaveLength(2)
    expect(editablePaper?.querySelector('pre code')).not.toBeNull()

    const rightmostCell = editablePaper!.querySelector<HTMLTableCellElement>('tbody tr:last-child td:last-child')!
    const bottomCell = editablePaper!.querySelector<HTMLTableCellElement>('tbody tr:last-child td:first-child')!
    expect(getComputedStyle(rightmostCell).borderRightStyle).not.toBe('none')
    expect(getComputedStyle(bottomCell).borderBottomStyle).not.toBe('none')

    renderFixture(false)
    await flushEditor()

    const readonlyPaper = host.querySelector<HTMLElement>('.wf-doc.ProseMirror')
    expect(readonlyPaper).toBe(editablePaper)
    expect(readonlyPaper?.getAttribute('contenteditable')).toBe('false')
    expect(host.querySelectorAll('.wf-doc.ProseMirror')).toHaveLength(1)
  })

  it('长文超过一屏时包装层不收缩，纸面由 .ws-right 承担纵向滚动', async () => {
    host.dataset.wsState = 'revealing'
    renderPmDoc(LONG_PM_DOC)
    await flushEditor()

    const proseMirror = host.querySelector<HTMLElement>('.wf-doc.ProseMirror')!
    const presentationShell = host.querySelector<HTMLElement>('.native-presentation-shell')!
    const scrollContainer = host.querySelector<HTMLElement>('.ws-right')!
    const paperShell = host.querySelector<HTMLElement>('.ws-paper-shell')!
    expect(proseMirror.children.length).toBeGreaterThan(10)
    expect(getComputedStyle(presentationShell).flexShrink).toBe('0')
    expect(getComputedStyle(scrollContainer).overflowY).toBe('auto')

    // 固化 0.1.35 真机量级：纸壳一屏 668px，正文 2107px；修复后外层必须
    // 把完整正文计入 scrollHeight，而不是让可见溢出在祖先处被裁掉。
    setMeasuredHeight(paperShell, 668)
    setMeasuredHeight(proseMirror, 2107)
    setScrollMetrics(scrollContainer, 668, 2107)
    expect(hasNonClippingPaperLayout(host)).toBe(true)
  })

  it('短文与整篇审阅包装同样不会形成“纸矮于正文且不可滚”的组合', async () => {
    renderPmDoc(SHORT_PM_DOC)
    await flushEditor()

    const proseMirror = host.querySelector<HTMLElement>('.wf-doc.ProseMirror')!
    const paperShell = host.querySelector<HTMLElement>('.ws-paper-shell')!
    const scrollContainer = host.querySelector<HTMLElement>('.ws-right')!
    setMeasuredHeight(paperShell, 668)
    setMeasuredHeight(proseMirror, 420)
    setScrollMetrics(scrollContainer, 668, 668)
    expect(hasNonClippingPaperLayout(host)).toBe(true)

    renderPmDoc(LONG_PM_DOC, 'review')
    await flushEditor()
    const reviewWrapper = host.querySelector<HTMLElement>('.wdr-swap')!
    expect(getComputedStyle(reviewWrapper).flexShrink).toBe('0')
    expect(host.querySelectorAll('.wf-doc.ProseMirror > *').length).toBeGreaterThan(10)
  })

  it('本地快打字按 400ms trailing 合并，baseline 冻结在第一笔事务发生时', async () => {
    let editor: Editor | null = null
    const onEditorChange = vi.fn(async (_doc: PmDoc, _baseline?: DocWriteBaseline) => undefined)
    act(() => {
      root.render(
        <DocumentSnapshotView
          doc={QINGDOC_FIXTURE_SNAPSHOT}
          docId="dsh-real:debounce"
          editable
          interactiveEditable
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={(next) => { editor = next }}
          onEditorChange={onEditorChange}
        />,
      )
    })
    await flushEditor()
    expect(editor).not.toBeNull()
    vi.useFakeTimers()

    act(() => {
      editor!.commands.setContent({
        type: 'doc', attrs: { schemaVersion: 1 },
        content: [{ type: 'paragraph', attrs: { blockId: 'fast' }, content: [{ type: 'text', text: '第一笔' }] }],
      })
      editor!.commands.insertContent('，第二笔')
    })
    await vi.advanceTimersByTimeAsync(399)
    expect(onEditorChange).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(onEditorChange).toHaveBeenCalledTimes(1)
    const [savedDoc, frozenBaseline] = onEditorChange.mock.calls[0]!
    expect(JSON.stringify(savedDoc)).toContain('第二笔')
    expect(frozenBaseline).toMatchObject({ expectedDocumentSnapshot: 1 })
  })
})
