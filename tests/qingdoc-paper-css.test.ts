import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const qingRoot = process.env.QING_ROOT ?? resolve('vendor/qingagent')
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
    expect(css).toContain('source: apps/web/src/pages/workspace/workspace.css:1120-1157')
    expect(css).toContain('.qing-stage .qing-center')
    expect(css).toContain('.qing-tag-inner .qt-author')
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

  it('弹性纸列只逐件居中纸面，并保持 docfns 的纸右缘 inset 前提', async () => {
    const css = await readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8')
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const paperRule = declarations.match(
      /:is\(\[data-qingagent-doc-panel\], #qingagent-doc-panel-specificity\) \.wf-doc,\s*:is\(\[data-qingagent-doc-panel\], #qingagent-doc-panel-specificity\) \.ws-paper-shell,\s*:is\(\[data-qingagent-doc-panel\], #qingagent-doc-panel-specificity\) \.ws-paper-surface \{([^}]*)\}/,
    )?.[1]

    expect(paperRule).toBeDefined()
    expect(paperRule).toContain('max-width: min(800px, 100%);')
    expect(paperRule).toContain('right: 0;')
    expect(paperRule).toContain('margin-inline: auto;')
    expect(declarations.lastIndexOf('margin-inline: auto;')).toBeGreaterThan(
      declarations.indexOf('margin: 0;'),
    )
    expect(declarations).not.toMatch(/\.ws-right\s*\{[^}]*align-items\s*:\s*center/)
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
    // 触发器嵌在青简深色墨条里,必须用固定暖纸色;下拉菜单按青简风(用户拍板 2026-08-16:
    // 产品无圆角)——暖纸直角固定色板,禁用 dsh 语义令牌与任何圆角。
    const triggerStyles = switcherStyles.slice(0, switcherStyles.indexOf('.qingdoc-doc-menu'))
    const menuStyles = switcherStyles.slice(switcherStyles.indexOf('.qingdoc-doc-menu'))
    expect(triggerStyles).toContain('color: #ece3d0')
    expect(triggerStyles).not.toMatch(/var\(\s*--dsw-alias-/)
    expect(menuStyles).not.toMatch(/var\(\s*--dsw-alias-/)
    expect(menuStyles).toContain('background: #faf6ec')
    expect(menuStyles).toContain('color: #a8823f')
    const radii = [...menuStyles.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1]!.trim())
    expect(radii.length).toBeGreaterThan(0)
    expect(radii.every((radius) => radius === '0')).toBe(true)
  })

  it('docMissing 使用面板自有的直角暖纸样式，不污染生成 CSS', async () => {
    const [generatedCss, panelCss, panelSource] = await Promise.all([
      readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8'),
      readFile(resolve('src/client/QingDocPanel.css'), 'utf8'),
      readFile(resolve('src/client/QingDocPanel.tsx'), 'utf8'),
    ])
    const missingRule = panelCss.match(
      /\[data-qingagent-doc-panel\]\[data-content="docMissing"\] \.qingdoc-doc-missing \{([\s\S]*?)\n\}/,
    )?.[1]

    expect(panelSource).toContain("import './QingDocPanel.css'")
    expect(panelSource).toContain("? 'docMissing'")
    expect(generatedCss).not.toContain('.qingdoc-doc-missing')
    expect(missingRule).toBeDefined()
    expect(missingRule).toContain('border-radius: 0;')
    expect(missingRule).toContain('background: #faf6ec;')
    // 已删除是「状态屏」不是正文:图标 + 居中提示,色调用比纸深一档的棕黄,不用正文墨色。
    expect(missingRule).toContain('justify-content: center;')
    expect(panelCss).toContain('.qingdoc-doc-missing-icon')
    expect(panelCss).toContain('stroke: #b9a375;')
    expect(panelCss).toContain('color: #9c8757;')
    expect(panelCss).not.toMatch(/var\(\s*--dsw-/)
  })

  it('品牌 hover 卡与更新浮层只进面板 CSS，并保持直角固定色与两处 header 接线', async () => {
    const [generatedCss, panelCss, panelSource, brandSource] = await Promise.all([
      readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8'),
      readFile(resolve('src/client/QingDocPanel.css'), 'utf8'),
      readFile(resolve('src/client/QingDocPanel.tsx'), 'utf8'),
      readFile(resolve('src/client/QingBrandBadge.tsx'), 'utf8'),
    ])
    const badgeStyles = panelCss.slice(
      panelCss.indexOf('[data-qingagent-doc-panel] .qingbrand-badge'),
      panelCss.indexOf('@media (max-width: 700px)'),
    )
    const radii = [...badgeStyles.matchAll(/border-radius:\s*([^;]+);/g)]
      .map((match) => match[1]!.trim())

    expect(generatedCss).not.toContain('.qingbrand-')
    expect(badgeStyles).toContain('.qingbrand-hover-card')
    expect(badgeStyles).toContain('.qingbrand-update-popover')
    // 入口改为纵向堆叠(每格带说明文案,并排会挤);同时锁住 hover 宽限用的透明桥,
    // 没有它鼠标穿过间隙时卡片会当场消失、点不到里面的按钮。
    expect(badgeStyles).toContain('.qingbrand-badge::after')
    expect(badgeStyles).toContain('.qingbrand-item-hint')
    // 焦点框不得用朱红——会被误读成「出错了」。
    expect(badgeStyles).not.toMatch(/qingbrand-trigger:focus-visible \{[^}]*#c0392b/)
    expect(badgeStyles).toContain('width: 100%;')
    expect(badgeStyles).not.toMatch(/var\(\s*--dsw-/)
    expect(badgeStyles).not.toMatch(/\btransparent\b|\brgba?\(|\bhsla?\(/)
    expect(radii.length).toBeGreaterThan(0)
    expect(radii.every((radius) => radius === '0')).toBe(true)
    expect(panelSource.match(/<QingBrandBadge \/>/g)).toHaveLength(2)
    expect(brandSource).toContain('target="_blank" rel="noreferrer"')
    expect(brandSource).toContain('aria-expanded={updateOpen}')
    expect(brandSource).toContain('aria-controls={updateOpen ? updatePopoverId : undefined}')
    expect(brandSource).toContain('运行后需重启 DSH 生效')
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

describe('状态限定选择器不得自套(P73 回归)', () => {
  it('抽取产物里没有「面板套面板」的后代选择器,且 pendingReview 的删除块隐藏能命中', async () => {
    const css = await readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8')

    // `body[data-content=…] #view-workspace …` 改写后带状态属性,曾因不等于 workspaceRoot 而被
    // 再前缀一层 panelRoot,变成「面板根是另一个面板根的后代」——全页只有一个面板根,永不命中。
    // 实测废掉 56 条状态规则(17 条 pendingReview,含被删块的 display:none)。
    const selfNested = css.match(/\[data-qingagent-doc-panel\]\s+:is\(\[data-qingagent-doc-panel\]/g) ?? []
    expect(selfNested).toEqual([])

    // 正面锚:待审时被删的旧块必须能被隐藏(只留红删标记 widget + hover 看原文)。
    // 选择器须直接以 :is([data-qingagent-doc-panel][data-content="pendingReview"] 开头。
    expect(css).toMatch(
      /:is\(\[data-qingagent-doc-panel\]\[data-content="pendingReview"\], #qingagent-doc-panel-specificity\) \.wf-doc \.wf-blockmark\.delete \{\s*display: ?none/,
    )
  })
})
