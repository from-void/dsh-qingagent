import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const qingRoot = '/home/jimmy/proj/qingagent/main'

describe('青简纸面移植契约', () => {
  it('固定 800px、52/64 padding、宋体、直角和暖纸，并只作用于面板根', async () => {
    const [css, panelSource] = await Promise.all([
      readFile(resolve('src/qingdoc/qingdoc.css'), 'utf8'),
      readFile(resolve('src/client/QingDocPanel.tsx'), 'utf8'),
    ])
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')

    expect(panelSource).toContain("'--ws-paper-column-width': '800px'")
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
})
