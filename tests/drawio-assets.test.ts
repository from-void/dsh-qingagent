import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { DRAWIO_EMBED_PATH } from '@qingweb/pages/workspace/components/drawioEmbedProtocol'
import { describe, expect, it, vi } from 'vitest'
import type { BindingStore } from '../src/bindings.js'
import { BridgeHub } from '../src/bridge.js'
import {
  DEFAULT_DRAWIO_VENDOR_ROOT,
  DRAWIO_DOCUMENT_CSP,
  serveDrawioAsset,
} from '../src/drawioAssets.js'
import type { EngineService } from '../src/engine.js'

interface CapturedResponse {
  status?: number
  headers?: Record<string, unknown>
  body: string
  writeHead(status: number, headers?: Record<string, unknown>): CapturedResponse
  end(chunk?: unknown): CapturedResponse
}

function request(url: string, remoteAddress = '127.0.0.1'): IncomingMessage & EventEmitter {
  return Object.assign(new EventEmitter(), {
    method: 'GET',
    url,
    socket: { remoteAddress },
  }) as IncomingMessage & EventEmitter
}

function response(): CapturedResponse {
  return {
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; return this },
    end(chunk) {
      if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      return this
    },
  }
}

describe('drawio 同源静态运行时与 CSP', () => {
  it('产品 iframe 固定命中同源 /drawio，宿主可实际读出离线入口', async () => {
    const pageUrl = new URL(DRAWIO_EMBED_PATH, 'http://127.0.0.1:3000/workspace')
    expect(pageUrl.origin).toBe('http://127.0.0.1:3000')
    expect(pageUrl.pathname).toBe('/drawio/index.html')
    expect(pageUrl.searchParams.get('offline')).toBe('1')
    expect(DRAWIO_EMBED_PATH).not.toMatch(/embed\.diagrams\.net|^https?:/)

    const res = response()
    await serveDrawioAsset(
      request(DRAWIO_EMBED_PATH),
      res as unknown as ServerResponse,
      DEFAULT_DRAWIO_VENDOR_ROOT,
    )

    expect(res.status).toBe(200)
    expect(res.headers?.['Content-Type']).toBe('text/html; charset=utf-8')
    expect(res.headers?.['Content-Security-Policy']).toBe(DRAWIO_DOCUMENT_CSP)
    expect(res.headers?.['X-Frame-Options']).toBe('SAMEORIGIN')
    expect(res.body).toContain("default-src 'self'")
    expect(res.body).toContain('<script src="js/bootstrap.js"></script>')
    expect(res.body).not.toContain('embed.diagrams.net')
  })

  it('BridgeHub 注册 /drawio prefix，只允许回环请求且拒绝目录穿越', async () => {
    const routes: Array<{
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    }> = []
    const ctx = {
      webServer: {
        register: vi.fn((route) => { routes.push(route); return vi.fn() }),
      },
      effect: vi.fn(),
    } as unknown as Context
    const hub = new BridgeHub(
      ctx,
      {} as EngineService,
      {} as BindingStore,
      DEFAULT_DRAWIO_VENDOR_ROOT,
    )
    hub.mount()
    const route = routes.find((candidate) => candidate.path === '/drawio')
    expect(route).toBeDefined()

    const remote = response()
    await route?.handler(request('/drawio/index.html', '10.0.0.8'), remote as unknown as ServerResponse)
    expect(remote.status).toBe(403)

    const traversal = response()
    await route?.handler(
      request('/drawio/%2e%2e%2fpackage.json'),
      traversal as unknown as ServerResponse,
    )
    expect(traversal.status).toBe(404)
  })
})
