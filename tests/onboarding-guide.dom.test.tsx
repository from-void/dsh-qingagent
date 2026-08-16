// @vitest-environment jsdom

import { act } from 'react'
import { readFile } from 'node:fs/promises'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  })

  it('未检测到时展示三步、统一下载地址与自动连接说明', () => {
    act(() => root.render(<QingConnectionGuide status={{
      state: 'offline', engineUrl: 'http://127.0.0.1:49123', reason: 'instance-missing',
    }} />))

    expect(host.textContent).toContain('尚未连接青简')
    expect([...host.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '①下载并安装青简',
      '②启动一次青简',
      '③插件将自动连接',
    ])
    const link = host.querySelector<HTMLAnchorElement>('a')
    expect(link?.href).toBe(QINGJIAN_DOWNLOAD_URL)
    expect(host.textContent).toContain('本引导会自动消失')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('握手失败时明确展示具体原因', () => {
    act(() => root.render(<QingConnectionGuide status={{
      state: 'handshake-failed',
      engineUrl: 'http://127.0.0.1:49123',
      reason: 'unauthorized',
      message: '青简拒绝了实例令牌（HTTP 401），instance.json 可能已经过期。',
    }} />))

    expect(host.textContent).toContain('检测到青简，但握手失败')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('HTTP 401')
    expect(host.textContent).not.toContain('尚未连接青简')
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
