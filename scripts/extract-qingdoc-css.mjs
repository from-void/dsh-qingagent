import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const qingRoot = '/home/jimmy/proj/qingagent/wt/dsh-bridge'
const panelRoot = '[data-qingagent-doc-panel]'
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
  ['apps/web/src/app.css', [[1, 15]]],
  ['apps/web/src/pages/workspace/workspace.css', [[197, 214], [304, 386], [1299, 3662]]],
  ['apps/web/src/pages/workspace/workspace-ink-skin.css', [[20, 60], [119, 204], [592, 682], [1111, 1220], [1669, 1802], [3178, 3493]]],
  ['apps/web/src/pages/workspace/workspace-responsive.css', [[1, 30]]],
]

const hostGlue = `/* dsh 面板薄胶水：只建立青简纸面所需的唯一根与原 DOM 骨架。 */
${panelRoot} {
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
    .replace(/:root((?:\[[^\]]+\])*)[\t ]+body((?:\[[^\]]+\])*)[\t ]+#view-workspace/g, (_, rootAttrs, bodyAttrs) => `${panelRoot}${rootAttrs}${bodyAttrs}`)
    .replace(/body((?:\[[^\]]+\])+)[\t ]+#view-workspace/g, (_, attrs) => `${panelRoot}${attrs}`)
    .replace(/:root((?:\[[^\]]+\])+)[\t ]+#view-workspace/g, (_, attrs) => `${panelRoot}${attrs}`)
    .replaceAll('#view-workspace', panelRoot)
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
  if (selector.startsWith(panelRoot) || selector.startsWith('@')) return selector
  return `${panelRoot} ${selector}`
}

function scopeStylesheet(source) {
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
      result += `${leading}${prelude} {${scopeStylesheet(body)}}`
    } else if (prelude.startsWith('@')) {
      result += `${leading}${prelude} {${body}}`
    } else {
      const selectors = splitSelectors(prelude).map(scopeSelector).filter(Boolean)
      if (selectors.length > 0) result += `${leading}${selectors.join(',\n')} {${body}}`
      else result += leading
    }
    cursor = close + 1
  }
  return result
}

const extracted = []
for (const [relativePath, ranges] of sources) {
  const absolutePath = resolve(qingRoot, relativePath)
  const source = await readFile(absolutePath, 'utf8')
  for (const [start, end] of ranges) {
    extracted.push(`/* source: ${relativePath}:${start}-${end} */\n${lineRange(source, start, end)}`)
  }
}

const output = [
  '/* 由 scripts/extract-qingdoc-css.mjs 从青简 wt/dsh-bridge@dc1a0baf 机械提取；声明值不改。 */',
  hostGlue,
  scopeStylesheet(extracted.join('\n\n')),
  '',
].join('\n').replace(/[ \t]+$/gm, '')

await writeFile(resolve('src/qingdoc/qingdoc.css'), output)
