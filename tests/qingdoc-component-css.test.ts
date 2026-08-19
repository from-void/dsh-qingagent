import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const qingRoot = resolve(repoRoot, process.env.QING_ROOT ?? 'vendor/qingagent')
const componentRoot = resolve(qingRoot, 'apps/web/src/pages/workspace/components')
const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.css', '/index.ts', '/index.tsx']

function resolveImport(specifier: string, importer: string): string | null {
  let base: string
  if (specifier.startsWith('.')) base = resolve(dirname(importer), specifier)
  else if (specifier.startsWith('@qingweb/')) {
    base = resolve(qingRoot, 'apps/web/src', specifier.slice('@qingweb/'.length))
  } else if (specifier.startsWith('@qingagent/pm-schema')) {
    base = resolve(qingRoot, 'packages/pm-schema/src', specifier.slice('@qingagent/pm-schema'.length))
  } else if (specifier.startsWith('@qingagent/diagram-engine')) {
    base = resolve(qingRoot, 'packages/diagram-engine/src', specifier.slice('@qingagent/diagram-engine'.length))
  } else return null
  return extensions.map((suffix) => `${base}${suffix}`).find(existsSync) ?? null
}

function reachableComponentCss(): string[] {
  const modules = new Set<string>()
  const styles = new Set<string>()
  const collectStyle = (file: string) => {
    if (styles.has(file)) return
    styles.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/@import\s+["']([^"']+)["']/g)) {
      const imported = resolveImport(match[1]!, file)
      if (imported?.endsWith('.css')) collectStyle(imported)
    }
  }
  const walk = (file: string) => {
    if (modules.has(file)) return
    modules.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*\()?["']([^"']+)["']/g)) {
      const imported = resolveImport(match[1]!, file)
      if (!imported) continue
      if (extname(imported) === '.css') {
        if (imported.startsWith(`${componentRoot}/`)) collectStyle(imported)
      } else if (/\.[cm]?[jt]sx?$/.test(imported)) walk(imported)
    }
  }
  walk(resolve(repoRoot, 'src/client/QingDocPanel.tsx'))
  return [...styles].map((file) => relative(qingRoot, file)).sort()
}

describe('组件级 CSS 抽取清单', () => {
  it('覆盖 QingDocPanel 实际可达的全部 workspace component CSS 及其 @import', () => {
    const generator = readFileSync('scripts/extract-qingdoc-css.mjs', 'utf8')
    const generated = readFileSync('src/qingdoc/qingdoc.css', 'utf8')
    const reachable = reachableComponentCss()

    expect(reachable).toEqual([
      'apps/web/src/pages/workspace/components/DiagramView.css',
      'apps/web/src/pages/workspace/components/DrawioEditorOverlay.css',
      'apps/web/src/pages/workspace/components/ImageView.css',
      'apps/web/src/pages/workspace/components/MediaBlockToolbar.css',
      'apps/web/src/pages/workspace/components/MediaZoomFullscreen.css',
      'apps/web/src/pages/workspace/components/diagram/graphDiagram.css',
      'apps/web/src/pages/workspace/components/diagramEditorChrome.css',
    ])
    for (const file of reachable) {
      expect(generator).toContain(`['${file}',`)
      expect(generated).toContain(`source: ${file}:`)
    }
  })

  it('drawio 挂在 body 直属 host，生成样式为它保留 portal 作用域与最高全屏层', () => {
    const launcher = readFileSync(
      resolve(componentRoot, 'drawioEditorLauncher.tsx'),
      'utf8',
    )
    const generated = readFileSync('src/qingdoc/qingdoc.css', 'utf8')
    const conversationBundle = readFileSync(
      'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
      'utf8',
    )
    const layoutBundle = readFileSync(
      'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js',
      'utf8',
    )
    const bundlerBridge = readFileSync('tsdown.config.ts', 'utf8')

    expect(launcher).toContain('document.body.appendChild(host)')
    expect(launcher).toContain('host.dataset.drawioEditorHost = "true"')
    expect(bundlerBridge).not.toContain("id.endsWith('/drawioEditorLauncher.tsx')")
    expect(bundlerBridge).not.toContain("id.endsWith('/diagram/GraphDiagramView.tsx')")
    expect(bundlerBridge).not.toContain("id.endsWith('/MediaZoomFullscreen.tsx')")
    // 当前 dsh 真机层级:输入自身 z-index:auto，sticky composer=7，Tab=1，layout overlay=20。
    expect(conversationBundle).toMatch(/\.uV2eYG_input\{[^}]*position:absolute/)
    expect(conversationBundle).toMatch(/\.wSkVaW_tabs\{z-index:1;/)
    expect(conversationBundle).toMatch(/\.wSkVaW_root\[data-phase=active\] \.wSkVaW_composerSeat\{z-index:7;/)
    expect(layoutBundle).toMatch(/\.pI_x6G_overlayLayer\{z-index:20;/)
    expect(generated).toMatch(
      /\[data-drawio-editor-host="true"\] \.drawio-editor-overlay,[\s\S]*?position: fixed;[\s\S]*?z-index: 2147483100;/,
    )
    expect(generated).toContain('source: packages/ui-kit/src/tokens.css:4-48 (component portals)')
  })
})
