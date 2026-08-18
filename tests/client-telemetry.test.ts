// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  capturePanelTelemetry,
  beginPanelMount,
  endPanelMount,
  markPanelOpenSource,
  panelPatchesBucket,
} from '../src/client/telemetry.js'

afterEach(() => vi.unstubAllGlobals())

describe('面板遥测中继', () => {
  it('只向同源 bridge 发送定义好的载荷，不直接访问外网', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ accepted: true }, { status: 202 })
    ))
    vi.stubGlobal('fetch', fetchMock)

    capturePanelTelemetry('feedback_clicked', { target: 'bug' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/qingagent-bridge/telemetry')
    expect(JSON.parse(String(init?.body))).toEqual({
      event: 'feedback_clicked', properties: { target: 'bug' },
    })
  })

  it('记录一次面板打开来源并覆盖计数边界', () => {
    markPanelOpenSource('dsh-1', 'tool_card')
    expect(beginPanelMount('dsh-1')).toBe('tool_card')
    markPanelOpenSource('dsh-1', 'auto')
    endPanelMount('dsh-1')
    expect(beginPanelMount('dsh-1')).toBe('manual')
    endPanelMount('dsh-1')
    expect([1, 2, 5, 6, 20, 21].map(panelPatchesBucket))
      .toEqual(['1', '2-5', '2-5', '6-20', '6-20', '>20'])
  })
})
