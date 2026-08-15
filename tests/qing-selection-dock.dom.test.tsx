// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { QingSelectionDock } from '../src/client/QingSelectionDock.js'
import { qingClientStore } from '../src/client/store.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('青简选段 input dock chip', () => {
  it('渲染前 20 字预览，点击 × 调用 DELETE 并消失', async () => {
    const sessionId = 'dsh-chip-dom'
    const quote = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸多余'
    const selection = {
      dshSessionId: sessionId,
      engineSessionId: 'qing-chip',
      quote,
      anchor: { blockId: 'block-chip', from: 1, to: 23 },
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({
        selection: JSON.parse(String(init.body)),
      })
      if (init?.method === 'DELETE') return Response.json({ ok: true })
      throw new Error(`unexpected request ${String(_input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await qingClientStore.setSelection(
      sessionId,
      selection.engineSessionId,
      quote,
      selection.anchor,
    )

    act(() => {
      root.render(<QingSelectionDock {...({ sessionId } as PropsRuntime<'conversation.input.dock'>)} />)
    })
    expect(host.querySelector('[data-qingagent-selection-chip]')?.textContent)
      .toContain('✎ 选段:「一二三四五六七八九十甲乙丙丁戊己庚辛壬癸…」')

    await act(async () => {
      await qingClientStore.setSelection(
        sessionId,
        selection.engineSessionId,
        '新选段',
        { blockId: 'block-next', from: 30, to: 33 },
      )
    })
    expect(host.querySelector('[data-qingagent-selection-chip]')?.textContent)
      .toContain('✎ 选段:「新选段」')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="清除青简选段"]')?.click()
      await Promise.resolve()
    })

    expect(host.querySelector('[data-qingagent-selection-chip]')).toBeNull()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/qingagent-bridge/selection?dshSessionId=dsh-chip-dom',
      { method: 'DELETE' },
    )
  })
})
