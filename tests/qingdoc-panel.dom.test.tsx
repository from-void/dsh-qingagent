// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentSnapshotView } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
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

beforeEach(() => {
  host = document.createElement('section')
  host.dataset.qingagentDocPanel = ''
  host.innerHTML = '<div class="ws-right"><div id="mount"></div></div>'
  document.body.append(host)
  root = createRoot(host.querySelector('#mount')!)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.localStorage.clear()
  vi.restoreAllMocks()
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

describe('青简 DocumentSnapshotView fixture', () => {
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

    renderFixture(false)
    await flushEditor()

    const readonlyPaper = host.querySelector<HTMLElement>('.wf-doc.ProseMirror')
    expect(readonlyPaper).toBe(editablePaper)
    expect(readonlyPaper?.getAttribute('contenteditable')).toBe('false')
    expect(host.querySelectorAll('.wf-doc.ProseMirror')).toHaveLength(1)
  })
})
