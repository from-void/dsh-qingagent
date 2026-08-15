import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const qingRoot = '/home/jimmy/proj/qingagent/wt/dsh-bridge'

describe('青简纸面移植契约', () => {
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
    expect(css).toMatch(/\[data-qingagent-doc-panel\] > \.patch-nav \{[\s\S]*?position: absolute !important;/)
    expect(css).toContain('--panel-doc-left')
    expect(css).toContain('--panel-doc-right')
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
    expect(css).toMatch(/\[data-qingagent-doc-panel\] \.ws-right \{[\s\S]*?overflow-y: auto;/)
  })
})
