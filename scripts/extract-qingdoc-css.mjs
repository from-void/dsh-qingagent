import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// 青简仓位置:默认用 vendor/qingagent submodule(钉 commit,与下方行号钉扎配套);
// 本地开发可用环境变量 QING_ROOT 指向任意青简工作树。
const qingRoot = process.env.QING_ROOT ?? new URL('../vendor/qingagent', import.meta.url).pathname
const panelRoot = '[data-qingagent-doc-panel]'
// :is() takes the specificity of its strongest arm. The never-matching ID arm
// keeps #view-workspace's original ID specificity while the attribute arm keeps
// the plugin isolated from the host page.
const workspaceRoot = `:is(${panelRoot}, #qingagent-doc-panel-specificity)`
const portalBodyRoot = `body:has(${panelRoot})`
const bodyPortalRoots = [
  '.media-zoom-fullscreen',
  '.graph-diagram-editor',
  '.graph-diagram-viewer',
  '.graph-diagram-pan-tip',
  '.diagram-editor-chrome',
]
const bodyPortalContainers = ':is(.media-zoom-fullscreen, .graph-diagram-editor, .graph-diagram-viewer)'
const componentPortalTokenRoots = `[data-drawio-editor-host="true"],
${portalBodyRoot} > :is(.media-zoom-fullscreen, .graph-diagram-editor, .graph-diagram-viewer, .graph-diagram-pan-tip)`
const bannedSelectors = [
  '.web-page-frame--workspace',
  '.ws-left',
  '.ws-chat',
  '.ws-input-',
  '.ws-back-home',
  '.ws-doc-topbar',
]

const sources = [
  ['packages/ui-kit/src/tokens.css', [[4, 48]]],
  // 清单写到 35；基线第 36 行才是 .font-mono 的闭合花括号，随段补齐以保持合法 CSS。
  ['packages/ui-kit/src/base.css', [[5, 36]]],
  ['packages/ui-kit/src/components.css', [[181, 274]]],
  ['apps/web/src/app.css', [[1, 15], [293, 515]]],
  ['apps/web/src/pages/workspace/workspace.css', [[169, 169], [197, 214], [294, 376], [1120, 1157], [1289, 3652]]],
  ['apps/web/src/pages/workspace/workspace-ink-skin.css', [[20, 60], [119, 204], [592, 682], [1111, 1220], [1527, 1667], [1669, 1802], [1863, 2071], [2093, 2151], [2558, 2682], [3193, 3508]]],
  ['apps/web/src/pages/workspace/workspace-responsive.css', [[1, 30]]],
  // DocumentSnapshotView 的可达组件 CSS。与上方产品样式一样逐文件/逐行钉扎；
  // 这些文件含图片/图表工具栏、全屏预览与 drawio/图表 portal，漏掉会继承 dsh 字号和层级。
  ['apps/web/src/pages/workspace/components/MediaBlockToolbar.css', [[1, 64]], 'component'],
  ['apps/web/src/pages/workspace/components/ImageView.css', [[1, 128]], 'component'],
  ['apps/web/src/pages/workspace/components/MediaZoomFullscreen.css', [[1, 130]], 'component'],
  ['apps/web/src/pages/workspace/components/DiagramView.css', [[1, 379]], 'component'],
  ['apps/web/src/pages/workspace/components/DrawioEditorOverlay.css', [[1, 106]], 'component'],
  ['apps/web/src/pages/workspace/components/diagramEditorChrome.css', [[1, 96]], 'component'],
  ['apps/web/src/pages/workspace/components/diagram/graphDiagram.css', [[1, 1441]], 'component'],
]

// 尾部几何覆写:必须排在机械提取的产品规则之后,同特异度靠后取胜。
const geometryOverrides = `/* 纸内功能区几何换算:产品 top 64 = 纸上留白 52 + 纸内缩 12,right 18 以
   「滚动容器宽=纸宽」为前提;插件纸上留白为 0 且容器弹性全宽,尾部宿主适配
   逐件居中纸面以对半分配富余,换算为:顶=纸内缩 12,右=纸右缘往内 18。 */
${workspaceRoot} .ws-docfns {
  top: 12px;
  right: max(18px, calc((100% - min(var(--ws-paper-column-width), 100%)) / 2 + 18px));
}
`

const hostGlue = `/* dsh 面板薄胶水：只建立青简纸面所需的唯一根与原 DOM 骨架。 */
${panelRoot} {
  isolation: isolate;
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
${panelRoot} .ws-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
  position: relative;
}
${panelRoot} .ws-document-content { display: contents; }
${panelRoot} .ws-document-content > * { position: relative; z-index: 1; }
${panelRoot} .qingdoc-stage-controls {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 52px;
  box-sizing: border-box;
  padding: 10px 12px;
  color: rgba(236, 227, 208, .76);
  border: 0;
  border-bottom: 1px solid rgba(184, 169, 140, .28);
  border-radius: 0;
  background: rgba(8, 11, 15, .96);
  box-shadow: none;
  font: 13px/1.4 var(--font-zh-serif);
}
${panelRoot} .qingdoc-stage-title { white-space: nowrap; }
${panelRoot} .qingdoc-close {
  min-height: 28px;
  padding: 0 8px;
  color: rgba(236, 227, 208, .64);
  border: 1px solid rgba(184, 169, 140, .22);
  border-radius: 0;
  background: transparent;
  cursor: pointer;
}
${panelRoot} .qingdoc-close { width: 28px; padding: 0; font-size: 17px; }
${panelRoot} .qingdoc-open:hover,
${panelRoot} .qingdoc-close:hover {
  color: #ece3d0;
  border-color: rgba(236, 227, 208, .5);
  background: rgba(236, 227, 208, .08);
}
`

function lineRange(source, start, end) {
  return source.split('\n').slice(start - 1, end).join('\n').replace(/[ \t]+$/gm, '')
}

function matchingBrace(source, openIndex) {
  let depth = 0
  let quote = null
  let comment = false
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (comment) {
      if (char === '*' && next === '/') {
        comment = false
        index += 1
      }
      continue
    }
    if (!quote && char === '/' && next === '*') {
      comment = true
      index += 1
      continue
    }
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}' && --depth === 0) return index
  }
  throw new Error(`CSS 花括号不平衡：${source.slice(openIndex, openIndex + 80)}`)
}

function findRuleOpen(source, start) {
  let quote = null
  let comment = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (comment) {
      if (char === '*' && next === '/') {
        comment = false
        index += 1
      }
      continue
    }
    if (!quote && char === '/' && next === '*') {
      comment = true
      index += 1
      continue
    }
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '{') return index
  }
  return -1
}

function splitSelectors(prelude) {
  const selectors = []
  let start = 0
  let parens = 0
  let brackets = 0
  for (let index = 0; index < prelude.length; index += 1) {
    const char = prelude[index]
    if (char === '(') parens += 1
    else if (char === ')') parens -= 1
    else if (char === '[') brackets += 1
    else if (char === ']') brackets -= 1
    else if (char === ',' && parens === 0 && brackets === 0) {
      selectors.push(prelude.slice(start, index).trim())
      start = index + 1
    }
  }
  selectors.push(prelude.slice(start).trim())
  return selectors
}

function scopeSelector(rawSelector) {
  if (bannedSelectors.some((needle) => rawSelector.includes(needle))) return null
  let selector = rawSelector
    .replace(/:root((?:\[[^\]]+\])*)[\t ]+body((?:\[[^\]]+\])*)[\t ]+#view-workspace/g, (_, rootAttrs, bodyAttrs) => `:is(${panelRoot}${rootAttrs}${bodyAttrs}, #qingagent-doc-panel-specificity)`)
    .replace(/body((?:\[[^\]]+\])+)[\t ]+#view-workspace/g, (_, attrs) => `:is(${panelRoot}${attrs}, #qingagent-doc-panel-specificity)`)
    .replace(/:root((?:\[[^\]]+\])+)[\t ]+#view-workspace/g, (_, attrs) => `:is(${panelRoot}${attrs}, #qingagent-doc-panel-specificity)`)
    .replaceAll('#view-workspace', workspaceRoot)
    .replace(/^:root\b/, panelRoot)
    .replace(/^body\b/, panelRoot)
    .replace(/^html\b/, panelRoot)
  while (/\[data-qingagent-doc-panel\]((?:\[[^\]]+\])*)\s+\[data-qingagent-doc-panel\]((?:\[[^\]]+\])*)/.test(selector)) {
    selector = selector.replace(
      /\[data-qingagent-doc-panel\]((?:\[[^\]]+\])*)\s+\[data-qingagent-doc-panel\]((?:\[[^\]]+\])*)/g,
      (_, firstAttrs, secondAttrs) => `${panelRoot}${firstAttrs}${secondAttrs}`,
    )
  }
  selector = selector.replace(
    /^(\[data-qingagent-doc-panel\](?:\[[^\]]+\])*)\s+body\b/,
    '$1',
  )
  if (selector === '*') return `${panelRoot}, ${panelRoot} *`
  // `body[data-content=…] #view-workspace` 会被上面改写成 `:is([data-qingagent-doc-panel][data-content=…], #…)`,
  // 它带了状态属性,字面上不等于 workspaceRoot。若不在这里认作「已限定」,下面会再前缀一层 panelRoot,
  // 变成「面板套面板」的后代选择器而永不命中(实测废掉 56 条状态规则,含 pendingReview 的删除块隐藏)。
  if (selector.startsWith(`:is(${panelRoot}`)) return selector
  if (selector.startsWith(panelRoot) || selector.startsWith(workspaceRoot) || selector.startsWith('@')) return selector
  return `${panelRoot} ${selector}`
}

function startsWithPortalRoot(selector) {
  return bodyPortalRoots.some((root) => {
    if (!selector.startsWith(root)) return false
    const next = selector[root.length]
    return next === undefined || '.:#[ >+~'.includes(next)
  })
}

function scopeComponentSelector(rawSelector) {
  const panelSelector = scopeSelector(rawSelector)
  if (!panelSelector) return null
  const selectors = [panelSelector]
  // drawio launcher 为组件创建唯一 body 直属 host；用该属性收口，既覆盖 portal，
  // 又不会把同名组件类泄漏到 dsh 宿主。
  selectors.push(`[data-drawio-editor-host="true"] ${rawSelector}`)
  // 图片全屏与 graph 编辑器直接 portal 到 body，没有独立 host。仅在青简面板挂载时
  // 放行其根/后代选择器，避免组件样式因 panel 前缀而永远无法命中。
  selectors.push(startsWithPortalRoot(rawSelector)
    ? `${portalBodyRoot} > ${rawSelector}`
    : `${portalBodyRoot} > ${bodyPortalContainers} ${rawSelector}`)
  return selectors.join(',\n')
}

function scopeStylesheet(source, { component = false } = {}) {
  let result = ''
  let cursor = 0
  while (cursor < source.length) {
    const open = findRuleOpen(source, cursor)
    if (open < 0) return result + source.slice(cursor)
    const close = matchingBrace(source, open)
    const rawPrelude = source.slice(cursor, open)
    const leading = rawPrelude.match(/^(?:\s|\/\*[\s\S]*?\*\/)+/)?.[0] ?? ''
    const prelude = rawPrelude.slice(leading.length).trim()
    const body = source.slice(open + 1, close)
    if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@container') || prelude.startsWith('@layer')) {
      result += `${leading}${prelude} {${scopeStylesheet(body, { component })}}`
    } else if (prelude.startsWith('@')) {
      result += `${leading}${prelude} {${body}}`
    } else {
      const scope = component ? scopeComponentSelector : scopeSelector
      const selectors = splitSelectors(prelude).map(scope).filter(Boolean)
      if (selectors.length > 0) result += `${leading}${selectors.join(',\n')} {${body}}`
      else result += leading
    }
    cursor = close + 1
  }
  return result
}

const extracted = []
const extractedComponents = []
for (const [relativePath, ranges, kind] of sources) {
  const absolutePath = resolve(qingRoot, relativePath)
  const source = await readFile(absolutePath, 'utf8')
  for (const [start, end] of ranges) {
    const target = kind === 'component' ? extractedComponents : extracted
    target.push(`/* source: ${relativePath}:${start}-${end} */\n${lineRange(source, start, end)}`)
  }
}

// Portal 不继承面板根上的设计令牌。复用同一份钉扎 token 行段，只改作用域根，
// 声明值保持与客户端完全一致。
const tokenSource = await readFile(resolve(qingRoot, 'packages/ui-kit/src/tokens.css'), 'utf8')
const componentPortalTokens = `/* source: packages/ui-kit/src/tokens.css:4-48 (component portals) */\n${lineRange(tokenSource, 4, 48).replace(/^:root\b/, componentPortalTokenRoots)}`

let output = [
  '/* 由 scripts/extract-qingdoc-css.mjs 从青简 wt/dsh-bridge@dc1a0baf 机械提取；声明值不改。 */',
  hostGlue,
  scopeStylesheet(extracted.join('\n\n')),
  componentPortalTokens,
  scopeStylesheet(extractedComponents.join('\n\n'), { component: true }),
  geometryOverrides,
  '',
].join('\n').replace(/[ \t]+$/gm, '')

function replaceLast(source, search, replacement) {
  const index = source.lastIndexOf(search)
  if (index < 0) throw new Error(`找不到待替换的生成片段：${search}`)
  return source.slice(0, index) + replacement + source.slice(index + search.length)
}

// Preserve the dsh host adaptations that intentionally sit on top of the
// mechanically scoped Qingjian source. Keeping them here makes extraction
// deterministic and allows --check to audit every copied range.
const detailsGlue = `
/* dsh AppFrame 的内建 preference 把 details 钳在 300–520；青简纸面打开时由同一个
   CSS 变量接管第三轨，center 保持 minmax(0,1fr) 弹性收缩。整条 !important 简写也会
   一并接管第一轨，所以第一轨变量必须镜像 AppFrame 行内值；不改 React store，卸载即复原。 */
[class*="detailsCol"]:has(${panelRoot}) {
  width: var(--qing-details-width, clamp(560px, 46vw, 920px)) !important;
  min-width: 0 !important;
}
[class*="frame"]:has(> [class*="detailsCol"] ${panelRoot}) {
  grid-template-columns:
    var(--qing-sidebar-width, 280px)
    minmax(0, 1fr)
    var(--qing-details-width, clamp(560px, 46vw, 920px)) !important;
}
[class*="frame"]:has(> [class*="detailsCol"] ${panelRoot})
  > [class*="centerCol"] {
  min-width: 0 !important;
  width: auto !important;
  flex: 1 1 auto !important;
}
[class*="frame"]:has(> [class*="detailsCol"] ${panelRoot})
  > [class*="handle"][data-side="details"] {
  display: none !important;
}
${panelRoot} .qingdoc-details-resizer {
  position: absolute;
  z-index: 100300;
  top: 0;
  bottom: 0;
  left: 0;
  width: 5px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
${panelRoot} .qingdoc-details-resizer::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 1px;
  background: rgba(181, 154, 99, 0);
  transition: background .15s ease;
}
${panelRoot} .qingdoc-details-resizer:hover::after,
${panelRoot}[data-qing-details-resizing="1"] .qingdoc-details-resizer::after {
  background: rgba(181, 154, 99, .68);
}
`

const controlsGlue = `${panelRoot} .qingdoc-heading,
${panelRoot} .qingdoc-host-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
${panelRoot} .qingdoc-heading { flex: 1 1 auto; }
${panelRoot} .qingdoc-host-actions { flex: 0 1 auto; }
${panelRoot} .qingdoc-brand {
  color: #cfb477;
  letter-spacing: .12em;
  white-space: nowrap;
}
${panelRoot} .qingdoc-doc-switcher {
  position: relative;
  min-width: 0;
  max-width: 260px;
}
${panelRoot} .qingdoc-doc-trigger {
  min-width: 0;
  max-width: 100%;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 5px;
  /* 墨条永远是深底,标题色必须固定用青简暖纸色,不跟随 dsh 明暗令牌(浅色模式下深字压深底会看不见) */
  color: #ece3d0;
  border: 0;
  border-radius: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
${panelRoot} .qingdoc-doc-trigger:hover,
${panelRoot} .qingdoc-doc-trigger[aria-expanded="true"] {
  background: rgba(236, 227, 208, .08);
}
${panelRoot} .qingdoc-doc-trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(236, 227, 208, .34);
}
${panelRoot} .qingdoc-stage-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
${panelRoot} .qingdoc-doc-chevron {
  flex: 0 0 auto;
  color: rgba(236, 227, 208, .55);
  transition: transform .12s ease;
}
${panelRoot} .qingdoc-doc-trigger[aria-expanded="true"] .qingdoc-doc-chevron {
  transform: rotate(180deg);
}
${panelRoot} .qingdoc-doc-menu {
  position: absolute;
  z-index: 100400;
  top: calc(100% + 6px);
  left: 0;
  width: max(240px, 100%);
  max-width: min(360px, calc(100vw - 32px));
  max-height: 280px;
  box-sizing: border-box;
  padding: 5px;
  overflow-y: auto;
  /* 青简风(用户拍板 2026-08-16:产品无圆角):暖纸底+褐线直角+墨字,弃 dsh 令牌 */
  color: #5c5346;
  border: 1px solid rgba(120, 90, 50, .28);
  border-radius: 0;
  background: #faf6ec;
  box-shadow: 0 12px 28px rgba(40, 28, 12, .22);
}
${panelRoot} .qingdoc-doc-option {
  width: 100%;
  min-height: 34px;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  color: #5c5346;
  border: 0;
  border-radius: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
${panelRoot} .qingdoc-doc-option:hover,
${panelRoot} .qingdoc-doc-option[data-focused="true"] {
  color: #2f2a22;
  background: rgba(120, 90, 50, .10);
}
${panelRoot} .qingdoc-doc-option[aria-selected="true"] {
  color: #a8823f;
}
${panelRoot} .qingdoc-doc-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #a8823f;
}
${panelRoot} .qingdoc-doc-option-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
${panelRoot} .qingdoc-doc-state-label {
  flex: 0 0 auto;
  font-size: 11px;
  color: #8a7f6e;
  white-space: nowrap;
}
${panelRoot} .qingdoc-doc-group-label {
  padding: 6px 8px 3px;
  font-size: 11px;
  color: #8a7f6e;
  white-space: nowrap;
  user-select: none;
}
${panelRoot} .qingdoc-doc-group-label:not(:first-child) {
  margin-top: 3px;
  border-top: 1px solid rgba(120, 90, 50, .16);
  padding-top: 8px;
}
${panelRoot} .qingdoc-status {
  min-width: 0;
  color: rgba(236, 227, 208, .58);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
${panelRoot} .qingdoc-status[data-kind="conflict"],
${panelRoot} .qingdoc-status[data-kind="blocked"],
${panelRoot} .qingdoc-status[data-kind="error"] { color: #e6bd86; }
${panelRoot} .qingdoc-open {
  min-height: 28px;
  box-sizing: border-box;
  color: rgba(236, 227, 208, .66);
  border: 1px solid rgba(184, 169, 140, .22);
  border-radius: 0;
  background: transparent;
  font: inherit;
}
${panelRoot} .qingdoc-open {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  text-decoration: none;
  white-space: nowrap;
}
${panelRoot} .qingdoc-conflict-reload {
  min-height: 24px;
  margin-left: 8px;
  padding: 0 10px;
  color: #e6bd86;
  border: 1px solid rgba(230, 189, 134, .45);
  border-radius: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
${panelRoot} .qingdoc-conflict-reload:hover {
  background: rgba(230, 189, 134, .12);
}
/* 审阅条毛玻璃:注入管线会把 var() 形式的 backdrop-filter 剥掉,这里以显式值重申(面板 JS 另有内联兜底)。 */
${workspaceRoot} .patch-nav:not(.is-confirming) {
  backdrop-filter: blur(18px) saturate(1.3);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
}
/* 纸面滚动条:青简原版 6px 淡拇指在宣纸上近乎隐形,按用户要求加宽提对比。 */
${workspaceRoot} .ws-right::-webkit-scrollbar { width: 10px; }
${workspaceRoot} .ws-right::-webkit-scrollbar-thumb {
  background: rgba(120, 90, 50, .38);
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
${workspaceRoot} .ws-right::-webkit-scrollbar-thumb:hover { background: rgba(120, 90, 50, .6); background-clip: padding-box; }
${panelRoot} .qingdoc-open-icon {
  width: 15px;
  height: 15px;
  margin: 0 7px;
  border-radius: 4px;
  /* 图标自带深蓝方章底,在墨条上须描一圈暖纸边才看得清 */
  box-shadow: 0 0 0 1px rgba(236, 227, 208, .45);
  flex: 0 0 auto;
}
${panelRoot} .qingdoc-open-arrow {
  flex: 0 0 auto;
  margin-left: 5px;
  opacity: .8;
}`

const patchNavGlue = `/* PatchNav portal 到面板根直属子节点；保持 fixed 与青简的视口定位几何。
   面板根的 isolation 只限定层级，不应改变 fixed 的 containing block。 */
${workspaceRoot} > .patch-nav {
  position: fixed !important;
  left: max(12px, calc(var(--doc-left, 0px) + 64px));
  right: max(12px, calc(100vw - var(--doc-right, 100%) + 64px));
  top: auto !important;
  bottom: var(--ws-float-bar-bottom);
}`

output = output
  .replace(`${panelRoot} .ws-body {`, `${detailsGlue}${panelRoot} .ws-body {`)
  .replace(`${panelRoot} .qingdoc-stage-title { white-space: nowrap; }`, controlsGlue)
  .replace('--ws-paper-min-height: calc(100vh - var(--ws-paper-top-offset));', '--ws-paper-min-height: 100%;')
output = replaceLast(
  output,
  `${workspaceRoot} .patch-nav .pn-label {`,
  `${patchNavGlue}\n${workspaceRoot} .patch-nav .pn-label {`,
)

// 宿主适配:顶栏与纸面之间露出深色间隔(用户拍板)。青简源里 .ws-right 的
// padding-top 间隔靠透明背景露出玄青桌面;提取版曾整列刷纸色导致纸贴顶栏。
output += `
/* dsh 宿主适配:列背景透明,顶部 36px 间隔露出面板深色底,纸张自身保持奶白。 */
:is([data-qingagent-doc-panel], #qingagent-doc-panel-specificity) .ws-right {
  background: transparent;
  /* 青简桌面是 400/800 双定宽列,纸列宽以整窗 100vw 计;dsh 里纸列=整个详情面板,
     必须回归弹性,否则列窄于 800 时纸面连同滚动条一起溢出被裁(用户实测「没有滚动条」)。 */
  /* !important:产品侧同选择器规则(ink-skin:141-146)本身带 !important 固定 800,
     不带就永远输,窄列时纸面被 overflow:hidden 静默裁切(2026-08-16 #34 实测)。 */
  flex: 1 1 auto !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
}
:is([data-qingagent-doc-panel], #qingagent-doc-panel-specificity) .wf-doc,
:is([data-qingagent-doc-panel], #qingagent-doc-panel-specificity) .ws-paper-shell,
:is([data-qingagent-doc-panel], #qingagent-doc-panel-specificity) .ws-paper-surface {
  max-width: min(800px, 100%);
  /* shell 是绝对定位且源规则只钉了 left:0;双向 offset + auto margin 才居中。
     对 relative 的另两者 right:0 不产生位移;逐件 auto margin 不改变其它 flex 子项。 */
  right: 0;
  margin-inline: auto;
}
`

const target = resolve('src/qingdoc/qingdoc.css')
if (process.argv.includes('--check')) {
  const actual = await readFile(target, 'utf8')
  if (actual !== output) throw new Error('qingdoc.css 与青简源行段/作用域生成结果不一致，请运行 npm run extract:qingdoc-css')
} else {
  await writeFile(target, output)
}
