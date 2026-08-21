/**
 * 发送气泡里的选段样式化:宿主 user 气泡渲染无插件槽位,这里用 MutationObserver 把
 * 消息文本中的「[选段]《标题》:「引文」」段替换为 chip 视觉(贴 composer chip 的蓝底胶囊),
 * 完整引文走 title 悬浮。只改文本节点、幂等、随插件卸载断开——不触碰宿主代码。
 * 兼容旧格式(带文稿/块/范围机器字段)以装饰历史消息。
 */
const SELECTION_RE = /\[选段\](?: 出自)?《([^》]{1,120})》(第\d+段)?(?:（[^）]{0,200}）)?[:：]\s*「([\s\S]{1,500}?)」/g

const DECORATED = 'data-qingagent-selection-decorated'

function clip(text: string, max: number): string {
  const plain = text.replace(/\s+/g, ' ').trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

function buildChip(title: string, quote: string, ordinal?: string): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.setAttribute(DECORATED, '1')
  // 「第N段」是重复引文的消歧定位,气泡装饰后必须保留在 title/展示里,不能丢。
  chip.title = `《${title}》${ordinal ?? ''}:「${quote}」`
  chip.style.cssText = [
    'display:inline-flex', 'align-items:center', 'gap:4px', 'max-width:100%',
    'padding:1px 8px', 'margin:0 2px', 'border-radius:6px',
    'background:#6187d838', 'color:var(--dsw-alias-label-primary, inherit)',
    'font-size:0.92em', 'line-height:1.5', 'vertical-align:baseline',
    'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
  ].join(';')
  const mark = document.createElement('span')
  mark.textContent = '选段'
  mark.style.cssText = 'opacity:.65;font-size:.9em;flex:none'
  const body = document.createElement('span')
  body.textContent = `「${clip(quote, 18)}」`
  body.style.cssText = 'overflow:hidden;text-overflow:ellipsis'
  chip.append(mark, body)
  return chip
}


/** 审核结果回流消息(【审核结果】开头)的结构化排版:标题行+计数徽记+逐条被拒行(直角,贴用户审美)。 */
const REVIEW_HEAD_RE = /^【审核结果】本轮审阅我已处理[:：]采纳 (\d+) 处[,，]拒绝 (\d+) 处。(.*)$/

function decorateReviewOutcomeNode(node: Text): boolean {
  const lines = node.data.split('\n')
  const head = REVIEW_HEAD_RE.exec(lines[0] ?? '')
  if (!head) return false
  const wrap = document.createElement('span')
  wrap.setAttribute(DECORATED, '1')
  wrap.style.cssText = 'display:block'
  const header = document.createElement('span')
  header.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:600'
  const title = document.createElement('span')
  title.textContent = '审核结果'
  const stat = (text: string, color: string) => {
    const el = document.createElement('span')
    el.textContent = text
    el.style.cssText = `font-weight:400;font-size:.9em;padding:0 6px;border:1px solid ${color};color:${color}`
    return el
  }
  header.append(title, stat(`采纳 ${head[1]}`, 'rgba(63,125,88,.9)'), stat(`拒绝 ${head[2]}`, 'rgba(176,84,64,.9)'))
  wrap.append(header)
  const note = (head[3] ?? '').trim()
  if (note) {
    const sub = document.createElement('span')
    sub.textContent = note
    sub.style.cssText = 'display:block;margin-top:2px;font-size:.9em;opacity:.72'
    wrap.append(sub)
  }
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const row = document.createElement('span')
    row.textContent = line.replace(/^\d+\.\s*/, '')
    row.style.cssText = 'display:block;margin-top:4px;padding-left:8px;border-left:2px solid rgba(176,84,64,.55);font-size:.94em'
    wrap.append(row)
  }
  node.replaceWith(wrap)
  return true
}

/** 审查发起 query(assembleDshReviewQuery 输出)的结构化卡:贴客户端发起审查的
 *  ActionCard(标题行+「模板/补充」标签行,直角),完整契约文字不再整坨刷屏。
 *  只做「已发起」这一事件快照,不引入会随全局状态漂移的进行中/已完成文案。 */
const REVIEW_LAUNCH_HEAD_RE = /^对当前文档做([^。\n]{1,24}(?:审查|核查))。/u

function decorateReviewLaunchNode(node: Text): boolean {
  const text = node.data
  const head = REVIEW_LAUNCH_HEAD_RE.exec(text)
  if (!head || !text.includes('独立审查执行契约')) return false
  const template = /审查模板「([^」]{1,60})」/u.exec(text)?.[1]
  const supplement = /文档级补充要求（只适用于当前文档）：([\s\S]*?)\n独立审查执行契约/u.exec(text)?.[1]
  const lexicons = /启用词库：([^\n]{1,240})/u.exec(text)?.[1]
    ?.replace(/\(id: [^)]+\)/gu, '').replace(/\s{2,}/gu, ' ').trim()

  const wrap = document.createElement('span')
  wrap.setAttribute(DECORATED, '1')
  wrap.style.cssText = [
    'display:block', 'padding:8px 10px', 'border-radius:0',
    'border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
    'background:var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
  ].join(';')
  const header = document.createElement('span')
  header.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:600'
  const title = document.createElement('span')
  title.textContent = head[1]!
  const badge = document.createElement('span')
  badge.textContent = '已发起'
  badge.style.cssText = 'margin-left:auto;font-weight:400;font-size:.9em;opacity:.6'
  header.append(title, badge)
  wrap.append(header)
  const row = (label: string, value: string) => {
    const line = document.createElement('span')
    line.style.cssText = 'display:flex;gap:8px;margin-top:4px;font-size:.94em'
    const key = document.createElement('span')
    key.textContent = label
    key.style.cssText = 'opacity:.6;flex:none'
    const val = document.createElement('span')
    val.textContent = clip(value, 60)
    val.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    line.append(key, val)
    return line
  }
  if (template) wrap.append(row('模板', template))
  if (lexicons) wrap.append(row('词库', lexicons))
  if (supplement?.trim()) wrap.append(row('补充', supplement))
  node.replaceWith(wrap)
  return true
}

/** 排除面:输入框、镜像层、纸面、chip 面板与已装饰区。文本节点直达路径(addedNodes 为
 *  Text / characterData 变更)也必须过这道门——React 受控更新 mirror 文本走的正是这两条,
 *  漏检会 replaceWith 掉 React 管理的节点,后续 reconcile removeChild 直接崩 composer。 */
function isDecorExcluded(node: Text): boolean {
  const parent = node.parentElement
  return !parent || parent.closest(
    `[${DECORATED}], textarea, [data-qingagent-doc-panel], [data-qing-chip-panel], [class*="mirror"], [class*="backdrop"]`,
  ) !== null
}

function decorateTextNode(node: Text): void {
  if (isDecorExcluded(node)) return
  const option = node.parentElement?.closest('button, [role="option"], [role="radio"]')
  if (option && /\bv\d+\b/i.test(node.data)) {
    node.data = node.data
      .replace(/\bv\d+\s*原文/giu, '改动前的原文')
      .replace(/\bv\d+\s*版本/giu, '改动前的版本')
      .replace(/\bv\d+\b/giu, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }
  if (decorateReviewOutcomeNode(node)) return
  if (decorateReviewLaunchNode(node)) return
  const text = node.data
  SELECTION_RE.lastIndex = 0
  if (!SELECTION_RE.test(text)) return
  SELECTION_RE.lastIndex = 0
  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const match of text.matchAll(SELECTION_RE)) {
    const index = match.index ?? 0
    if (index > cursor) fragment.append(text.slice(cursor, index))
    fragment.append(buildChip(match[1]!, match[3]!, match[2]))
    cursor = index + match[0].length
  }
  if (cursor < text.length) fragment.append(text.slice(cursor))
  node.replaceWith(fragment)
}

function decorateWithin(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    decorateTextNode(root as Text)
    return
  }
  if (!(root instanceof Element)) return
  if (root.closest(`[${DECORATED}]`)) return
  // 只碰对话消息区文本;输入框(textarea/镜像层)与纸面绝不装饰。
  if (root.closest('textarea, [data-qingagent-doc-panel], [data-qing-chip-panel]')) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent || parent.closest(`[${DECORATED}], textarea, [data-qingagent-doc-panel], [data-qing-chip-panel], [class*="mirror"], [class*="backdrop"]`)) {
        return NodeFilter.FILTER_REJECT
      }
      const data = (node as Text).data
      return data.includes('[选段]') || data.startsWith('【审核结果】') || data.startsWith('对当前文档做') || /\bv\d+\b/i.test(data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP
    },
  })
  const hits: Text[] = []
  while (walker.nextNode()) hits.push(walker.currentNode as Text)
  for (const hit of hits) decorateTextNode(hit)
}

export function installSelectionBubbleDecor(): () => void {
  if (typeof document === 'undefined') return () => {}
  decorateWithin(document.body)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) decorateWithin(node)
      if (mutation.type === 'characterData' && mutation.target.nodeType === Node.TEXT_NODE) {
        decorateTextNode(mutation.target as Text)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}
