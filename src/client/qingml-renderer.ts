export interface RenderedQingml {
  html: string
  title: string | null
  footnotes: number
}

const STANDARD_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'hr', 'pre',
  'table', 'tr', 'th', 'td', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'a', 'br', 'img',
])
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template'])
const CUSTOM_TAGS = new Set([
  'qing-title', 'tasks', 'task', 'callout', 'columns', 'column', 'mark', 'color', 'math',
  'math-block', 'mermaid', 'drawio', 'file', 'pennote', 'footnote',
])
const ALIGN = new Set(['left', 'center', 'right', 'justify'])
const TONES = new Set(['info', 'success', 'warning', 'danger', 'neutral'])

interface SanitizeContext {
  doc: Document
  notes: Map<string, { note: string; index: number }>
  title: string | null
}

/** DOMParser 只解析；输出树由白名单逐节点重建，源节点和属性不会直接进入 innerHTML。 */
export function renderQingml(qingml: string, parser: DOMParser = new DOMParser()): RenderedQingml {
  const normalized = qingml
    .replace(/<title(?=\s|>)/gi, '<qing-title')
    .replace(/<\/title\s*>/gi, '</qing-title>')
  const parsed = parser.parseFromString(`<qing-root>${normalized}</qing-root>`, 'text/html')
  const source = parsed.querySelector('qing-root')
  const output = parsed.createElement('div')
  const context: SanitizeContext = { doc: parsed, notes: new Map(), title: null }
  if (source) appendChildren(source, output, context)
  if (context.notes.size) output.append(buildFootnotes(context))
  return { html: output.innerHTML, title: context.title, footnotes: context.notes.size }
}

function appendChildren(source: Node, target: Node, context: SanitizeContext): void {
  for (const child of [...source.childNodes]) {
    const clean = sanitizeNode(child, context)
    if (clean) target.appendChild(clean)
  }
}

function sanitizeNode(node: Node, context: SanitizeContext): Node | null {
  if (node.nodeType === node.TEXT_NODE) return context.doc.createTextNode(node.textContent ?? '')
  if (node.nodeType !== node.ELEMENT_NODE) return null
  const source = node as Element
  const tag = source.tagName.toLowerCase()
  if (DROP_WITH_CONTENT.has(tag)) return null
  if (!STANDARD_TAGS.has(tag) && !CUSTOM_TAGS.has(tag)) {
    const fragment = context.doc.createDocumentFragment()
    appendChildren(source, fragment, context)
    return fragment
  }

  if (tag === 'qing-title') {
    const heading = context.doc.createElement('h1')
    heading.className = 'qing-document-title'
    appendChildren(source, heading, context)
    context.title ??= heading.textContent?.trim() || null
    return heading
  }
  if (tag === 'tasks') return customContainer(source, context, 'ul', 'qing-tasks')
  if (tag === 'task') return buildTask(source, context)
  if (tag === 'callout') return buildCallout(source, context)
  if (tag === 'columns') return customContainer(source, context, 'div', 'qing-columns')
  if (tag === 'column') return buildColumn(source, context)
  if (tag === 'mark') return buildColorSpan(source, context, 'qing-mark', 'background-color', 'color')
  if (tag === 'color') return buildColorSpan(source, context, 'qing-color', 'color', 'val')
  if (tag === 'math') return customContainer(source, context, 'span', 'qing-math')
  if (tag === 'math-block' || tag === 'mermaid' || tag === 'drawio') return buildCodePlaceholder(source, context, tag)
  if (tag === 'file') return buildFile(source, context)
  if (tag === 'pennote') return customContainer(source, context, 'aside', 'qing-pennote')
  if (tag === 'footnote') return buildFootnoteReference(source, context)

  const clean = context.doc.createElement(tag)
  copySafeAttributes(source, clean, tag)
  // 原样文本块即使收到坏输入也不能把其中的“标签形文本”重新解释成 DOM。
  if (tag === 'pre') clean.textContent = source.textContent ?? ''
  else appendChildren(source, clean, context)
  return clean
}

function customContainer(source: Element, context: SanitizeContext, tag: string, className: string): Element {
  const clean = context.doc.createElement(tag)
  clean.className = className
  appendChildren(source, clean, context)
  return clean
}

function buildTask(source: Element, context: SanitizeContext): Element {
  const item = context.doc.createElement('li')
  item.className = 'qing-task'
  const input = context.doc.createElement('input')
  input.type = 'checkbox'
  input.disabled = true
  input.checked = source.getAttribute('checked') === 'true' || source.hasAttribute('checked') && source.getAttribute('checked') === ''
  if (input.checked) input.setAttribute('checked', '')
  input.setAttribute('aria-label', input.checked ? '已完成' : '未完成')
  item.append(input)
  const body = context.doc.createElement('span')
  appendChildren(source, body, context)
  item.append(body)
  return item
}

function buildCallout(source: Element, context: SanitizeContext): Element {
  const callout = context.doc.createElement('aside')
  const tone = source.getAttribute('tone')?.toLowerCase() ?? 'info'
  callout.className = `qing-callout qing-callout-${TONES.has(tone) ? tone : 'info'}`
  const emoji = source.getAttribute('emoji')?.trim()
  if (emoji) {
    const icon = context.doc.createElement('span')
    icon.className = 'qing-callout-emoji'
    icon.textContent = [...emoji].slice(0, 4).join('')
    icon.setAttribute('aria-hidden', 'true')
    callout.append(icon)
  }
  const content = context.doc.createElement('div')
  appendChildren(source, content, context)
  callout.append(content)
  return callout
}

function buildColumn(source: Element, context: SanitizeContext): Element {
  const column = context.doc.createElement('section')
  column.className = 'qing-column'
  const ratio = Number(source.getAttribute('ratio'))
  if (Number.isFinite(ratio) && ratio > 0 && ratio <= 100) column.style.flexGrow = String(ratio)
  appendChildren(source, column, context)
  return column
}

function buildColorSpan(
  source: Element,
  context: SanitizeContext,
  className: string,
  property: 'color' | 'background-color',
  attribute: string,
): Element {
  const span = context.doc.createElement('span')
  span.className = className
  const color = source.getAttribute(attribute)
  if (color && safeColor(color)) span.style.setProperty(property, color)
  appendChildren(source, span, context)
  return span
}

function buildCodePlaceholder(source: Element, context: SanitizeContext, kind: string): Element {
  const figure = context.doc.createElement('figure')
  figure.className = `qing-code-placeholder qing-${kind}`
  const caption = context.doc.createElement('figcaption')
  caption.textContent = kind === 'math-block' ? '数学公式' : kind === 'mermaid' ? 'Mermaid 图' : 'Draw.io 图'
  const pre = context.doc.createElement('pre')
  pre.textContent = source.textContent ?? ''
  figure.append(caption, pre)
  return figure
}

function buildFile(source: Element, context: SanitizeContext): Element {
  const file = context.doc.createElement('span')
  file.className = 'qing-file'
  file.textContent = `附件 · ${source.getAttribute('filename')?.trim() || source.getAttribute('id')?.trim() || '未命名'}`
  return file
}

function buildFootnoteReference(source: Element, context: SanitizeContext): Node {
  const rawId = source.getAttribute('id')?.trim() ?? ''
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(rawId)) return context.doc.createTextNode(source.textContent ?? '')
  const note = source.textContent?.trim() ?? ''
  let entry = context.notes.get(rawId)
  if (!entry) {
    entry = { note, index: context.notes.size + 1 }
    context.notes.set(rawId, entry)
  }
  const sup = context.doc.createElement('sup')
  sup.className = 'qing-footnote-ref'
  const anchor = context.doc.createElement('a')
  anchor.href = `#qing-note-${rawId}`
  anchor.textContent = `[${entry.index}]`
  anchor.setAttribute('aria-label', `脚注：${entry.note}`)
  sup.append(anchor)
  return sup
}

function buildFootnotes(context: SanitizeContext): Element {
  const section = context.doc.createElement('section')
  section.className = 'qing-footnotes'
  const heading = context.doc.createElement('h2')
  heading.textContent = '脚注'
  const list = context.doc.createElement('ol')
  for (const [id, entry] of context.notes) {
    const item = context.doc.createElement('li')
    item.id = `qing-note-${id}`
    item.textContent = entry.note
    list.append(item)
  }
  section.append(heading, list)
  return section
}

function copySafeAttributes(source: Element, target: Element, tag: string): void {
  if (/^h[1-6]$/.test(tag) || tag === 'p') {
    const align = source.getAttribute('align')?.toLowerCase()
    if (align && ALIGN.has(align)) target.setAttribute('data-align', align)
    const anchor = source.getAttribute('anchor')
    if (anchor && /^[A-Za-z0-9_-]{1,64}$/.test(anchor)) target.id = `qing-anchor-${anchor}`
  }
  if (tag === 'ol') {
    const style = source.getAttribute('style')
    if (style && /^[A-Za-z0-9_-]{1,24}$/.test(style)) target.setAttribute('data-list-style', style)
  }
  if (tag === 'pre') {
    const lang = source.getAttribute('lang')
    if (lang && /^[A-Za-z0-9_+#.-]{1,32}$/.test(lang)) target.setAttribute('data-lang', lang)
  }
  if (tag === 'th' || tag === 'td') {
    for (const attr of ['colspan', 'rowspan'] as const) {
      const span = Number(source.getAttribute(attr))
      if (Number.isInteger(span) && span > 0 && span <= 100) target.setAttribute(attr, String(span))
    }
    const bg = source.getAttribute('bg')
    if (bg && safeColor(bg)) (target as HTMLElement).style.backgroundColor = bg
  }
  if (tag === 'a') {
    const href = source.getAttribute('href')
    if (href && safeHref(href)) {
      target.setAttribute('href', href)
      if (/^https?:/i.test(href)) {
        target.setAttribute('target', '_blank')
        target.setAttribute('rel', 'noopener noreferrer')
      }
    }
    const title = source.getAttribute('title')
    if (title) target.setAttribute('title', title.slice(0, 240))
  }
  if (tag === 'img') {
    const src = source.getAttribute('src')
    if (src && safeImageSource(src)) target.setAttribute('src', src)
    const alt = source.getAttribute('alt')
    const title = source.getAttribute('title')
    if (alt) target.setAttribute('alt', alt.slice(0, 500))
    if (title) target.setAttribute('title', title.slice(0, 240))
    for (const attr of ['width', 'height'] as const) {
      const size = Number(source.getAttribute(attr))
      if (Number.isInteger(size) && size > 0 && size <= 8192) target.setAttribute(attr, String(size))
    }
    target.setAttribute('loading', 'lazy')
  }
}

function safeHref(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('#') || (trimmed.startsWith('/') && !trimmed.startsWith('//')) || /^(https?:|mailto:)/i.test(trimmed)
}

function safeImageSource(value: string): boolean {
  const trimmed = value.trim()
  return (trimmed.startsWith('/') && !trimmed.startsWith('//')) || /^https?:/i.test(trimmed)
}

function safeColor(value: string): boolean {
  const trimmed = value.trim()
  return /^(#[0-9a-f]{3,8}|[a-z]{1,20}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/i.test(trimmed)
}
