// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { createQingagentExtensions } from '@qingagent/pm-schema/tiptap'
import { normalizePmDoc, type PmDoc } from '@qingagent/pm-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocToolbar } from '@qingweb/pages/workspace/components/DocToolbar'
import type { AiModifyTarget } from '@qingweb/pages/workspace/data/aiModifyTarget'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let editorHost: HTMLDivElement
let editor: Editor
let onAiModify: (target: AiModifyTarget) => Promise<boolean>

beforeEach(() => {
  const rect = () => DOMRect.fromRect({ x: 80, y: 80, width: 160, height: 24 })
  Element.prototype.getBoundingClientRect = rect
  Element.prototype.getClientRects = () => Object.assign([rect()], { item: (index: number) => index === 0 ? rect() : null }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = rect
  Range.prototype.getClientRects = () => Object.assign([rect()], { item: (index: number) => index === 0 ? rect() : null }) as unknown as DOMRectList
  HTMLElement.prototype.scrollIntoView = vi.fn()

  editorHost = document.createElement('div')
  host = document.createElement('div')
  document.body.append(editorHost, host)
  editor = new Editor({
    element: editorHost,
    extensions: createQingagentExtensions(),
    content: {
      type: 'doc',
      attrs: { schemaVersion: 1 },
      content: [{
        type: 'paragraph',
        attrs: { blockId: 'toolbar-text' },
        content: [{ type: 'text', text: '青简工具栏正文' }],
      }],
    } satisfies PmDoc,
  })
  vi.spyOn(editor.view as unknown as { scrollToSelection: () => void }, 'scrollToSelection')
    .mockImplementation(() => undefined)
  onAiModify = vi.fn(async () => true)
  root = createRoot(host)
  act(() => {
    root.render(
      <DocToolbar
        active
        editor={editor}
        containerSelector="body"
        onAiModify={onAiModify}
      />,
    )
  })
})

afterEach(() => {
  act(() => root.unmount())
  editor.destroy()
  host.remove()
  editorHost.remove()
  vi.restoreAllMocks()
})

describe('青简原生 DocToolbar 关键路径', () => {
  it('“修改选中文字”传出引文所在 blockId 与 PM range', async () => {
    await selectText(1, 5)

    await act(async () => findButton('修改选中文字').click())

    expect(onAiModify).toHaveBeenCalledWith({
      label: '青简工具',
      suffix: '批注',
      blockId: 'toolbar-text',
      from: 1,
      to: 5,
    })
  })

  it('选中文字出现浮动工具栏，点击加粗写入 bold mark', async () => {
    await selectText(1, 5)

    const toolbar = document.querySelector<HTMLElement>('[data-wf="DocToolbar"]')
    expect(toolbar).not.toBeNull()
    expect(toolbar?.classList.contains('on')).toBe(true)

    await act(async () => findButton('加粗').click())

    const paragraph = normalizePmDoc(editor.getJSON()).content[0]
    expect(paragraph?.type).toBe('paragraph')
    const markedText = paragraph?.type === 'paragraph' ? paragraph.content?.[0] : undefined
    expect(markedText?.type === 'text' ? markedText.marks : []).toContainEqual({ type: 'bold' })
  })

  it('插入菜单使用原生 TableSizePicker 按指定尺寸插表格', async () => {
    await selectText(1, 3)

    await act(async () => findButton('插入').click())
    await act(async () => findButton('插入表格').click())
    const sizeCell = document.querySelector<HTMLButtonElement>('[data-row="2"][data-col="3"]')
    expect(sizeCell).not.toBeNull()
    await act(async () => sizeCell?.click())

    const table = normalizePmDoc(editor.getJSON()).content.find((node) => node.type === 'table')
    expect(table?.type).toBe('table')
    if (table?.type !== 'table') return
    expect(table.content).toHaveLength(2)
    expect(table.content.every((row) => row.content.length === 3)).toBe(true)
  })

  it('青简 History 扩展的 undo/redo 可逆恢复正文', () => {
    const before = normalizePmDoc(editor.getJSON())
    act(() => {
      editor.commands.setTextSelection(7)
      editor.commands.insertContent('新增')
    })
    const after = normalizePmDoc(editor.getJSON())
    expect(after).not.toEqual(before)

    act(() => { expect(editor.commands.undo()).toBe(true) })
    expect(normalizePmDoc(editor.getJSON())).toEqual(before)
    act(() => { expect(editor.commands.redo()).toBe(true) })
    expect(normalizePmDoc(editor.getJSON())).toEqual(after)
  })
})

async function selectText(from: number, to: number): Promise<void> {
  await act(async () => {
    editor.commands.setTextSelection({ from, to })
    editor.view.focus()
    const range = window.getSelection()?.getRangeAt(0)
    if (!range) throw new Error('浏览器文本选区未建立')
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => DOMRect.fromRect({ x: 120, y: 80, width: 64, height: 18 }),
    })
    document.dispatchEvent(new Event('selectionchange'))
    await Promise.resolve()
  })
}

function findButton(label: string): HTMLButtonElement {
  const candidates = document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]')
  const button = Array.from(candidates).find((candidate) =>
    candidate.textContent?.includes(label) ||
    candidate.getAttribute('aria-label')?.includes(label) ||
    candidate.getAttribute('title')?.includes(label))
  if (!button) throw new Error(`找不到工具栏按钮：${label}`)
  return button
}
