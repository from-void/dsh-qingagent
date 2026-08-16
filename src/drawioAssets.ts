import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DRAWIO_ROUTE_PATH = '/drawio'

/**
 * 青简产品仓已经把 draw.io v31.0.2 裁成离线、同源运行时；插件只通过宿主桥只读发布，
 * 不再引入第二份 vendor，也不会回退到 embed.diagrams.net。
 * 资产位置:QING_ROOT(或 QINGAGENT_DRAWIO_ROOT 直指资产目录)可覆盖,
 * 默认取 vendor/qingagent submodule(相对本模块 lib/ 上一级)。
 */
export const DEFAULT_DRAWIO_VENDOR_ROOT =
  process.env.QINGAGENT_DRAWIO_ROOT
  ?? (process.env.QING_ROOT
    ? resolve(process.env.QING_ROOT, 'apps/web/public/drawio')
    : fileURLToPath(new URL('../vendor/qingagent/apps/web/public/drawio', import.meta.url)))

export const DRAWIO_DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export async function serveDrawioAsset(
  request: IncomingMessage,
  response: ServerResponse,
  vendorRoot = DEFAULT_DRAWIO_VENDOR_ROOT,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }

  let relativePath: string
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== DRAWIO_ROUTE_PATH && !url.pathname.startsWith(`${DRAWIO_ROUTE_PATH}/`)) {
      writeAssetError(response, 404, 'drawio asset not found')
      return
    }
    const encodedPath = url.pathname === DRAWIO_ROUTE_PATH || url.pathname === `${DRAWIO_ROUTE_PATH}/`
      ? 'index.html'
      : url.pathname.slice(`${DRAWIO_ROUTE_PATH}/`.length)
    relativePath = decodeURIComponent(encodedPath)
  } catch {
    writeAssetError(response, 400, 'drawio asset path is malformed')
    return
  }

  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\')) {
    writeAssetError(response, 404, 'drawio asset not found')
    return
  }
  const root = resolve(vendorRoot)
  const filename = resolve(root, relativePath)
  const rootedRelative = relative(root, filename)
  if (rootedRelative.startsWith('..') || isAbsolute(rootedRelative)) {
    writeAssetError(response, 404, 'drawio asset not found')
    return
  }

  try {
    const info = await stat(filename)
    if (!info.isFile()) {
      writeAssetError(response, 404, 'drawio asset not found')
      return
    }
    const headers: Record<string, string | number> = {
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': info.size,
      'Content-Type': drawioMimeType(filename),
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    }
    if (extname(filename).toLowerCase() === '.html') {
      headers['Content-Security-Policy'] = DRAWIO_DOCUMENT_CSP
      headers['X-Frame-Options'] = 'SAMEORIGIN'
    }
    response.writeHead(200, headers)
    response.end(request.method === 'HEAD' ? undefined : await readFile(filename))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      writeAssetError(response, 404, 'drawio asset not found')
      return
    }
    throw error
  }
}

function drawioMimeType(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.txt': return 'text/plain; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.gif': return 'image/gif'
    case '.ico': return 'image/x-icon'
    case '.woff': return 'font/woff'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}

function writeAssetError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(message)
}
