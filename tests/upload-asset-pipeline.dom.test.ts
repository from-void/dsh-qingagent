// @vitest-environment jsdom

import { Editor } from '@tiptap/core'
import { createQingagentExtensions } from '@qingagent/pm-schema/tiptap'
import { normalizePmDoc, type PmDoc } from '@qingagent/pm-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { insertImageAsset } from '@qingweb/pages/workspace/data/insertUploadedAsset'
import { encodeAssetBridgeContext } from '../src/assetBridge.js'

let editor: Editor | null = null
let editorHost: HTMLDivElement | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
  editorHost?.remove()
  editorHost = null
  vi.unstubAllGlobals()
})

describe('青简图片上传原语桥接', () => {
  it('insertImageAsset 保留占位更新语义，并将 base64 回执写成合法 canonical 引用', async () => {
    const sent: Array<{ url: string; body: string }> = []
    class FakeXMLHttpRequest {
      status = 200
      responseText = JSON.stringify({
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        filename: '插图.png',
        mimeType: 'image/png',
        size: 3,
        src: '/api/v1/files/550e8400-e29b-41d4-a716-446655440000/%E6%8F%92%E5%9B%BE.png',
      })
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
      onerror: (() => void) | null = null
      onload: (() => void) | null = null
      private url = ''
      open(_method: string, url: string): void { this.url = url }
      setRequestHeader(): void {}
      send(body: string): void {
        sent.push({ url: this.url, body })
        this.upload.onprogress?.({ lengthComputable: true, loaded: body.length, total: body.length } as ProgressEvent)
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)

    editorHost = document.createElement('div')
    document.body.append(editorHost)
    editor = new Editor({
      element: editorHost,
      extensions: createQingagentExtensions(),
      content: {
        type: 'doc', attrs: { schemaVersion: 1 },
        content: [{ type: 'paragraph', attrs: { blockId: 'before-image' } }],
      } satisfies PmDoc,
    })
    const sessionId = encodeAssetBridgeContext({ dshSessionId: 'dsh-a', engineSessionId: 'qing-a' })
    const source = await insertImageAsset(
      editor,
      new File([new Uint8Array([1, 2, 3])], '插图.png', { type: 'image/png' }),
      sessionId,
    )

    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toContain('/qingagent-bridge/assets?')
    expect(sent[0]?.url).toContain('dshSessionId=dsh-a')
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      filename: '插图.png', mimeType: 'image/png', base64: 'AQID',
    })
    expect(JSON.parse(sent[0]!.body)).not.toHaveProperty('size')
    expect(JSON.parse(sent[0]!.body)).not.toHaveProperty('dataBase64')
    expect(source).toBe('/api/v1/files/550e8400-e29b-41d4-a716-446655440000/%E6%8F%92%E5%9B%BE.png')

    const image = normalizePmDoc(editor.getJSON()).content.find((node) => node.type === 'image')
    expect(image?.type).toBe('image')
    if (image?.type !== 'image') return
    expect(image.attrs.src).toBe(source)
    const liveImage = (editor.getJSON().content ?? []).find((node) => node.type === 'image')
    expect(liveImage?.attrs).toMatchObject({ uploading: false, progress: 100, error: false })
  })
})
