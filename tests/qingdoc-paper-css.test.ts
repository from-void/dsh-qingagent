import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const qingRoot = '/home/jimmy/proj/qingagent/wt/dsh-bridge'
const execFileAsync = promisify(execFile)

describe('青简纸面移植契约', () => {
  it('§3.2 全部源行段与作用域生成结果保持一致', async () => {
    await expect(execFileAsync(process.execPath, ['scripts/extract-qingdoc-css.mjs', '--check']))
      .resolves.toMatchObject({ stderr: '' })
  })

  it('固定 800px、52/64 padding、宋体、直角和暖纸，并只作用于面板根', async () => {
    const [css, panelSource] = await Promise.all([
      readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8'),
      readFile(resolve('src/client/QingDocPanel.tsx'), 'utf8'),
    ])
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')

    expect(panelSource).toContain("'--ws-paper-column-width': '800px'")
    expect(panelSource).toContain('id="view-workspace"')
    expect(panelSource).toContain('tabIndex={0}')
    expect(panelSource).toContain('new MutationObserver')
    expect(css).toContain('青简 wt/dsh-bridge@dc1a0baf')
    expect(css).not.toContain('.qingdoc-mode-switch')
    expect(css).not.toContain('.qingdoc-toast')
    expect(panelSource).not.toContain('className="qingdoc-toast"')
    expect(panelSource).toContain('qingjian://open?engineSessionId=')
    expect(css).toMatch(/:is\(\[data-qingagent-doc-panel\], #qingagent-doc-panel-specificity\) > \.patch-nav \{[\s\S]*?position: fixed !important;/)
    expect(css).toContain('var(--doc-left, 0px)')
    expect(css).toContain('var(--doc-right, 100%)')
    expect(css).toContain('padding-bottom: 156px !important;')
    expect(css).toContain('--bg-paper-deep: #efe7d6;')
    expect(css).toContain('--font-zh-serif: "Noto Serif SC"')
    expect(css).toContain('--r: 0;')
    expect(css).toContain('padding: 52px 64px !important;')
    expect(declarations).not.toMatch(/(^|})\s*(?:body|html|:root|#view-workspace)\b/)
    expect(declarations).not.toMatch(/\.(?:ws-left|ws-chat|ws-back-home|ws-doc-topbar)\b/)
  })

  it('装饰字体和印章与青简主仓字节一致', async () => {
    const pairs = [
      [
        'src/qingdoc/assets/yanshi-colophon-subset.woff2',
        `${qingRoot}/apps/web/src/assets/yanshi-colophon-subset.woff2`,
      ],
      [
        'src/qingdoc/assets/seal-kongshengmiaoyou.png',
        `${qingRoot}/apps/web/public/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png`,
      ],
    ]

    for (const [local, upstream] of pairs) {
      expect(await readFile(resolve(local!))).toEqual(await readFile(upstream!))
    }
  })

  it('顶栏作为面板首行通栏嵌入，纸面在下方独立滚动', async () => {
    const [css, generator, panelSource] = await Promise.all([
      readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8'),
      readFile(resolve('scripts/extract-qingdoc-css.mjs'), 'utf8'),
      readFile(resolve('src/client/QingDocPanel.tsx'), 'utf8'),
    ])
    const headerRule = css.match(/\[data-qingagent-doc-panel\] \.qingdoc-stage-controls \{([\s\S]*?)\n\}/)?.[1]

    expect(headerRule).toBeDefined()
    expect(headerRule).toContain('flex: 0 0 auto;')
    expect(headerRule).toContain('width: 100%;')
    expect(headerRule).toContain('min-height: 52px;')
    expect(headerRule).toContain('border-radius: 0;')
    expect(headerRule).toContain('box-shadow: none;')
    expect(headerRule).not.toMatch(/position:\s*(?:absolute|fixed)|left:|right:|transform:|backdrop-filter:/)
    expect(generator).not.toContain('width: min(860px, calc(100% - 28px))')
    expect(panelSource).toContain("'--ws-paper-top-offset': '0px'")
    expect(css).toMatch(/:is\(\[data-qingagent-doc-panel\], #qingagent-doc-panel-specificity\) \.ws-right \{[\s\S]*?overflow-y: auto;/)
  })

  it('文稿切换器使用自定义 listbox 与 dsh 语义色', async () => {
    const [css, panelSource] = await Promise.all([
      readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8'),
      readFile(resolve('src/client/QingDocPanel.tsx'), 'utf8'),
    ])
    const switcherStyles = css.slice(
      css.indexOf('[data-qingagent-doc-panel] .qingdoc-doc-switcher'),
      css.indexOf('[data-qingagent-doc-panel] .qingdoc-status'),
    )

    expect(panelSource).not.toContain('<select')
    expect(panelSource).toContain('aria-haspopup="listbox"')
    expect(panelSource).toContain('aria-expanded={open}')
    expect(panelSource).toContain('role="option"')
    expect(css).not.toContain('.qingdoc-doc-select')
    // 触发器嵌在青简深色墨条里,必须用固定暖纸色(dsh 浅色令牌会深字压深底);下拉菜单浮在 dsh 层上,仍须全用 dsh 语义色。
    const triggerStyles = switcherStyles.slice(0, switcherStyles.indexOf('.qingdoc-doc-menu'))
    const menuStyles = switcherStyles.slice(switcherStyles.indexOf('.qingdoc-doc-menu'))
    expect(triggerStyles).toContain('color: #ece3d0')
    expect(triggerStyles).not.toMatch(/var\(\s*--dsw-alias-/)
    expect(menuStyles).not.toMatch(/#[\da-f]{3,8}\b|rgba?\s*\(/i)
    const variables = [...menuStyles.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1])
    expect(variables.length).toBeGreaterThan(0)
    expect(variables.every((variable) => variable?.startsWith('--dsw-alias-'))).toBe(true)
  })

  it('workspace scope 保留青简 #view-workspace 的 ID 权重', async () => {
    const [css, generator] = await Promise.all([
      readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8'),
      readFile(resolve('scripts/extract-qingdoc-css.mjs'), 'utf8'),
    ])

    expect(generator).toContain('const workspaceRoot = `:is(${panelRoot}, #qingagent-doc-panel-specificity)`')
    expect(css).toContain(':is([data-qingagent-doc-panel], #qingagent-doc-panel-specificity) :is(.wf-doc,.doc-typography) table {')
    expect(css).toContain(':is([data-qingagent-doc-panel], #qingagent-doc-panel-specificity) :is(.wf-doc,.doc-typography) td {')
  })

  it('纸面 docfns/菜单/去AI味弹窗只使用钉准的青简源样式，运行时补回滤镜与关键帧', async () => {
    const [css, generator, panelSource, runtimeCss] = await Promise.all([
      readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8'),
      readFile(resolve('scripts/extract-qingdoc-css.mjs'), 'utf8'),
      readFile(resolve('src/client/QingDocPanel.tsx'), 'utf8'),
      readFile(resolve('src/client/runtimeCss.ts'), 'utf8'),
    ])

    expect(generator).toContain("['apps/web/src/pages/workspace/workspace.css', [[169, 169]")
    expect(generator).toContain("['apps/web/src/app.css', [[1, 15], [293, 515]]]")
    expect(generator).toContain('[1527, 1667]')
    expect(generator).toContain('[1863, 2071]')
    expect(generator).toContain('[2093, 2151]')
    expect(generator).toContain('[2558, 2682]')
    expect(css).toContain('source: apps/web/src/pages/workspace/workspace-ink-skin.css:1863-2071')
    expect(css).toContain('.ws-docfns {')
    expect(css).toContain('.ws-docfn-btn {')
    expect(css).toContain('[data-wf="ReviewMenu"]')
    expect(css).toContain('.ws-export-menu {')
    expect(css).toContain('.ws-deai-template.is-selected')
    expect(css).toContain('.annotation-hover-card {')
    expect(css).toContain('.annotation-anchor-active[data-annotation-severity="error"]')
    expect(css).toContain('.annotation-anchor-accepted {')
    expect(panelSource).toContain('data-wf="WorkspaceDocFunctions"')
    expect(panelSource).toContain('<DeaiReviewModal')
    expect(panelSource).not.toContain('QingDocActionMenus')
    expect(css).not.toContain('.qingdoc-action-btn')
    expect(css).not.toContain('.qingdoc-review-dialog')
    expect(runtimeCss).toContain('[data-qingagent-doc-panel] .ws-export-menu')
    expect(runtimeCss).toContain('@keyframes ws-export-pop')
    expect(runtimeCss).toContain('@keyframes ws-export-spin')
    expect(runtimeCss).toContain('@keyframes wdr-swap-in')
    expect(runtimeCss).toContain('@keyframes ws-folder-modal-overlay-in')
    expect(runtimeCss).toContain('@keyframes ws-folder-modal-panel-out')
  })
})
