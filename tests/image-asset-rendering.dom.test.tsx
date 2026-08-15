// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import type { PmDoc } from '@qingagent/pm-schema'
import { normalizePmDoc } from '@qingagent/pm-schema'
import { DocumentSnapshotView } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import { pmDocToViewDocumentSnapshot } from '@qingweb/pages/workspace/data/protocol'
import { AssetBridgeProvider } from '../src/qingdoc/AssetBridgeProvider.js'

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg/>' })) },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INTERNAL_SOURCE = '/api/v1/files/550e8400-e29b-41d4-a716-446655440000/%E6%8F%92%E5%9B%BE.png'
const IMAGE_DOC = {
  type: 'doc',
  attrs: { schemaVersion: 1 },
  content: [{
    type: 'image',
    attrs: {
      blockId: 'asset-image',
      src: INTERNAL_SOURCE,
      alt: '插图',
      title: null,
      caption: null,
      width: null,
      height: null,
      align: 'center',
    },
  }],
} as PmDoc

let root: Root
let host: HTMLDivElement
let editor: Editor | null

beforeEach(() => {
  const rect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 })
  Element.prototype.getBoundingClientRect = rect
  Range.prototype.getBoundingClientRect = rect
  Element.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  host = document.createElement('div')
  host.dataset.qingagentDocPanel = ''
  document.body.append(host)
  root = createRoot(host)
  editor = null
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('引擎图片 DOM 代理', () => {
  it('ImageView 只改 img 加载 URL，TipTap canonical attrs.src 保持内部路径', async () => {
    await act(async () => {
      root.render(
        <AssetBridgeProvider context={{ dshSessionId: 'dsh-a', engineSessionId: 'qing-a' }}>
          <DocumentSnapshotView
            doc={pmDocToViewDocumentSnapshot(IMAGE_DOC, 1, 't1')}
            docId="asset-rendering"
            editable
            interactiveEditable
            showPatches={false}
            acceptedPatches={new Set()}
            rejectedPatches={new Set()}
            onEditorReady={(next) => { editor = next }}
          />
        </AssetBridgeProvider>,
      )
      for (let index = 0; index < 6; index += 1) await Promise.resolve()
    })

    const image = host.querySelector<HTMLImageElement>('.pm-image img')
    expect(image?.getAttribute('src')).toContain('/qingagent-bridge/assets?')
    expect(image?.getAttribute('src')).toContain('dshSessionId=dsh-a')
    expect(image?.getAttribute('src')).not.toContain('token')

    const canonical = normalizePmDoc(editor!.getJSON())
    const imageNode = canonical.content.find((node) => node.type === 'image')
    expect(imageNode?.type === 'image' ? imageNode.attrs.src : null).toBe(INTERNAL_SOURCE)
  })
})
