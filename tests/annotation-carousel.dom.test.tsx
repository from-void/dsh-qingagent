// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import { DocumentSnapshotView } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import { pmDocToViewDocumentSnapshot } from '@qingweb/pages/workspace/data/protocol'
import type { ExternalAnnotation, PmDoc } from '../src/contracts.js'
import { QingAnnotationCarousel } from '../src/client/annotationCarousel.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PM_DOC = {
  type: 'doc',
  attrs: { schemaVersion: 1 },
  content: [{
    type: 'paragraph',
    attrs: { blockId: 'p' },
    content: [{ type: 'text', text: '甲组乙组' }],
  }],
} as PmDoc

const SNAPSHOT = pmDocToViewDocumentSnapshot(PM_DOC, 4, '2026-08-16T00:00:00.000Z')

const ANNOTATIONS: ExternalAnnotation[] = [
  {
    id: 'annotation-1',
    summary: '事实有误',
    note: '时间与材料不一致',
    origin: 'source-check',
    suggestion: '改为四月发布',
    severity: 'error',
    status: 'reviewing',
    anchors: [{ blockId: 'p', pmFrom: 1, pmTo: 3, quote: '甲组' }],
  },
  {
    id: 'annotation-2',
    summary: '表述重复',
    note: '与上一段语义重复',
    origin: 'consistency',
    suggestion: '删去重复句',
    severity: 'warn',
    status: 'reviewing',
    anchors: [{ blockId: 'p', pmFrom: 3, pmTo: 5, quote: '乙组' }],
  },
]

let host: HTMLElement
let root: Root

beforeEach(() => {
  const rect = () => ({
    top: 100, left: 100, right: 300, bottom: 140, width: 200, height: 40,
    x: 100, y: 100, toJSON: () => ({}),
  })
  Element.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Element.prototype.getBoundingClientRect = rect as unknown as () => DOMRect
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = rect as unknown as () => DOMRect
  document.elementFromPoint = () => null
  document.elementsFromPoint = () => []
  host = document.createElement('section')
  host.dataset.qingagentDocPanel = ''
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function Harness(props: { annotations: readonly ExternalAnnotation[] }) {
  const [editor, setEditor] = useState<Editor | null>(null)
  return (
    <>
      <DocumentSnapshotView
        doc={SNAPSHOT}
        docId="dsh:annotation-test"
        editable
        interactiveEditable={false}
        showPatches={false}
        acceptedPatches={new Set()}
        rejectedPatches={new Set()}
        {...{ annotations: props.annotations }}
        onEditorReady={setEditor}
      />
      <QingAnnotationCarousel
        annotations={props.annotations}
        editor={editor}
        onAccept={() => true}
        onIgnore={() => undefined}
      />
    </>
  )
}

async function renderHarness(annotations: readonly ExternalAnnotation[]): Promise<void> {
  await act(async () => {
    root.render(<Harness annotations={annotations} />)
  })
  await vi.waitFor(() => expect(host.querySelector('.wf-doc.ProseMirror')).not.toBeNull())
}

async function openFromClick(anchor: HTMLElement): Promise<HTMLElement> {
  await act(async () => {
    // 浏览器中的点击先让指针进入锚点；产品组件以 mouseover 识别锚点，click 负责用户确认。
    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    anchor.click()
  })
  return vi.waitFor(() => {
    const card = host.querySelector<HTMLElement>('.annotation-hover-card')
    expect(card).not.toBeNull()
    return card!
  })
}

describe('插件批注锚与青简轮播接线', () => {
  it('有 annotations 时在真实 DocumentSnapshotView 正文挂出产品锚点 attrs', async () => {
    await renderHarness(ANNOTATIONS)

    await vi.waitFor(() => expect(host.querySelectorAll('.annotation-anchor-active')).toHaveLength(2))
    expect(host.querySelector('[data-annotation-group="annotation-1"]')).not.toBeNull()
    expect(host.querySelector('[data-annotation-group="annotation-1"]')?.getAttribute('data-annotation-groups'))
      .toBe('annotation-1')
    expect(host.querySelector('[data-annotation-group="annotation-1"]')?.getAttribute('data-annotation-severity'))
      .toBe('error')
  })

  it('点击批注锚显示青简 AnnotationCarousel', async () => {
    await renderHarness(ANNOTATIONS.slice(0, 1))
    const anchor = await vi.waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-annotation-group="annotation-1"]')
      expect(value).not.toBeNull()
      return value!
    })

    const card = await openFromClick(anchor)

    expect(card.dataset.groupId).toBe('annotation-1')
    expect(card.textContent).toContain('事实有误')
    expect(card.textContent).toContain('1/1')
  })

  it('多条批注可用产品轮播按钮逐条切换', async () => {
    await renderHarness(ANNOTATIONS)
    const anchor = await vi.waitFor(() => {
      const value = host.querySelector<HTMLElement>('[data-annotation-group="annotation-1"]')
      expect(value).not.toBeNull()
      return value!
    })
    const card = await openFromClick(anchor)

    await act(async () => {
      card.querySelector<HTMLButtonElement>('[aria-label="下一处批注"]')?.click()
    })

    expect(card.dataset.groupId).toBe('annotation-2')
    expect(card.textContent).toContain('表述重复')
    expect(card.textContent).toContain('2/2')
  })

  it('无 annotations 时不渲染锚点或轮播卡', async () => {
    await renderHarness([])

    expect(host.querySelector('[data-annotation-group]')).toBeNull()
    expect(host.querySelector('.annotation-hover-card')).toBeNull()
  })
})
