// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DRAWIO_SOURCE,
  normalizePmDoc,
  type PmDoc,
} from '@qingagent/pm-schema'
import { NodeSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { DocumentSnapshotView } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import { pmDocToViewDocumentSnapshot } from '@qingweb/pages/workspace/data/protocol'

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg/>' })) },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CACHED_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>开始</text></svg>'
const DRAWIO_DOC = {
  type: 'doc',
  attrs: { schemaVersion: 1 },
  content: [{
    type: 'diagram',
    attrs: {
      blockId: 'drawio-integration',
      lang: 'drawio',
      source: DEFAULT_DRAWIO_SOURCE,
      svg: CACHED_SVG,
      height: null,
      width: null,
      align: 'center',
      overlay: null,
    },
  }],
} as PmDoc

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  const rect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 })
  Element.prototype.getBoundingClientRect = rect
  Range.prototype.getBoundingClientRect = rect
  Element.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  document.elementFromPoint = () => null
  document.elementsFromPoint = () => []
  host = document.createElement('div')
  host.dataset.qingagentDocPanel = ''
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  const close = document.querySelector<HTMLButtonElement>('.drawio-editor-overlay button[aria-label="关闭"]')
  if (close) await act(async () => close.click())
  act(() => root.unmount())
  document.querySelectorAll('[data-drawio-editor-host]').forEach((element) => element.remove())
  host.remove()
  vi.restoreAllMocks()
})

describe('dsh drawio 编辑闭环', () => {
  it('双击打开同源 overlay，完成 JSON 握手并把结果作为本地事务交给保存链', async () => {
    let editor: Editor | null = null
    const onEditorChange = vi.fn(async (_doc: PmDoc) => undefined)
    await act(async () => {
      root.render(
        <DocumentSnapshotView
          doc={pmDocToViewDocumentSnapshot(DRAWIO_DOC, 7, 't7')}
          docId="dsh-drawio:integration"
          editable
          interactiveEditable
          showPatches={false}
          acceptedPatches={new Set()}
          rejectedPatches={new Set()}
          onEditorReady={(next) => { editor = next }}
          onEditorChange={onEditorChange}
        />,
      )
      await flushMicrotasks()
    })
    expect(editor).not.toBeNull()

    act(() => {
      const current = editor as unknown as Editor
      current.view.dispatch(current.state.tr.setSelection(NodeSelection.create(current.state.doc, 0)))
    })
    const preview = await vi.waitFor(() => {
      const candidate = host.querySelector<HTMLElement>('.pm-diagram-view')
      expect(candidate).not.toBeNull()
      return candidate!
    })
    await act(async () => {
      preview.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 1 }))
      preview.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
      await flushMicrotasks()
    })

    const iframe = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLIFrameElement>('.drawio-editor-overlay__frame')
      expect(candidate).not.toBeNull()
      return candidate!
    })
    expect(iframe.getAttribute('src')).toMatch(/^\/drawio\/index\.html\?/)
    const frameWindow = iframe.contentWindow
    if (!frameWindow) throw new Error('drawio iframe contentWindow 缺失')
    const postMessage = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined)

    await emitDrawioMessage(frameWindow, { event: 'init' })
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(postMessage.mock.calls[0]?.[0]))).toMatchObject({
      action: 'load',
      xml: DEFAULT_DRAWIO_SOURCE,
      saveAndExit: true,
      autosave: true,
    })
    expect(postMessage.mock.calls[0]?.[1]).toBe(window.location.origin)

    const changedSource = DEFAULT_DRAWIO_SOURCE.replace('value="开始"', 'value="写回文稿"')
    await emitDrawioMessage(frameWindow, { event: 'save', xml: changedSource })
    expect(postedActions(postMessage)).toContain('snapshot')
    await emitDrawioMessage(frameWindow, {
      event: 'export',
      data: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg"><text>写回文稿</text></svg>',
      )}`,
      exit: false,
    })

    await vi.waitFor(() => expect(onEditorChange).toHaveBeenCalledTimes(1))
    const saved = normalizePmDoc(onEditorChange.mock.calls[0]?.[0])
    const diagram = saved.content.find((node) => node.type === 'diagram')
    expect(diagram?.type === 'diagram' ? diagram.attrs.source : '').toContain('写回文稿')
    expect(diagram?.type === 'diagram' ? diagram.attrs.svg : '').toContain('写回文稿')
    expect(editor!.state.selection).toBeInstanceOf(NodeSelection)
  })
})

async function emitDrawioMessage(
  source: Window,
  data: Record<string, unknown>,
): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify(data),
      origin: window.location.origin,
      source,
    }))
    await flushMicrotasks()
  })
}

function postedActions(postMessage: ReturnType<typeof vi.spyOn>): string[] {
  return (postMessage.mock.calls as unknown[][]).map((call) => (
    JSON.parse(String(call[0])) as { action?: string }
  ).action ?? '')
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}
