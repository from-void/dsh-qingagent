// @vitest-environment jsdom

import { act } from 'react'
import { readFile } from 'node:fs/promises'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QingConnectionGuide } from '../src/client/QingConnectionGuide.js'
import { QINGJIAN_DOWNLOAD_URL } from '../src/onboarding.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('青简未连接引导卡', () => {
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
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('未检测到时展示三步、统一下载地址与自动连接说明', () => {
    act(() => root.render(<QingConnectionGuide status={{
      state: 'offline', engineUrl: 'http://127.0.0.1:49123', reason: 'instance-missing', clientInstalled: false,
    }} />))

    expect(host.textContent).toContain('尚未连接青简')
    expect([...host.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '①下载并安装青简',
      '②启动一次青简',
      '③插件将自动连接',
    ])
    const link = host.querySelector<HTMLAnchorElement>('a')
    expect(link?.href).toBe(new URL(QINGJIAN_DOWNLOAD_URL).href)
    expect(host.textContent).toContain('本引导会自动消失')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('已安装但未启动时改为两步启动引导，优先 qingjian 深链并延迟请求 host 兜底', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => Response.json({ launched: true }, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    act(() => root.render(<QingConnectionGuide status={{
      state: 'offline',
      engineUrl: 'http://127.0.0.1:49123',
      reason: 'instance-missing',
      clientInstalled: true,
      clientExecutablePath: 'D:\\Portable\\qingagent.exe',
    }} />))

    expect(host.textContent).toContain('青简已安装,尚未启动')
    expect([...host.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '①启动青简',
      '②插件将自动连接',
    ])
    const link = host.querySelector<HTMLAnchorElement>('a')
    expect(link?.textContent).toBe('启动青简')
    expect(link?.getAttribute('href')).toBe('qingjian://')
    expect(link?.getAttribute('target')).toBeNull()
    expect(host.textContent).toContain('若未响应,请从开始菜单/应用程序启动')
    expect(host.textContent).not.toContain('下载并安装青简')
    link?.addEventListener('click', (event) => event.preventDefault())
    act(() => { link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200) })
    expect(fetchMock).toHaveBeenCalledWith('/qingagent-bridge/launch-client', { method: 'POST' })
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('D:\\Portable\\qingagent.exe')
  })

  it('握手失败时明确展示具体原因', () => {
    act(() => root.render(<QingConnectionGuide status={{
      state: 'handshake-failed',
      engineUrl: 'http://127.0.0.1:49123',
      reason: 'unauthorized',
      clientInstalled: true,
      message: '青简拒绝了实例令牌（HTTP 401），instance.json 可能已经过期。',
    }} />))

    expect(host.textContent).toContain('检测到青简，但握手失败')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('HTTP 401')
    expect(host.textContent).not.toContain('尚未连接青简')
    expect([...host.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '①下载并安装青简',
      '②启动一次青简',
      '③插件将自动连接',
    ])
    expect(host.querySelector<HTMLAnchorElement>('a')?.href).toBe(new URL(QINGJIAN_DOWNLOAD_URL).href)
  })

  it('样式只使用青简暖纸色板，且所有圆角均为 0', async () => {
    const css = await readFile('src/client/QingConnectionGuide.module.css', 'utf8')
    expect(css).toContain('#faf6ec')
    expect(css).toContain('#2f2a22')
    expect(css).toContain('#5c5346')
    expect(css).toContain('rgba(120, 90, 50, .28)')
    expect(css).toContain('#a8823f')
    expect(css).not.toMatch(/--dsw-/)
    expect([...css.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1]?.trim()))
      .toEqual(expect.arrayContaining(['0']))
    expect([...css.matchAll(/border-radius:\s*([^;]+);/g)].every((match) => match[1]?.trim() === '0'))
      .toBe(true)
  })
})
