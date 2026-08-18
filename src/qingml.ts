/**
 * 给侧模型的契约必须与 feat/external-qingml 的解析器保持同一白名单。
 * 这里故意写成静态系统提示，避免把青简 token、旧正文或宿主提示泄露给浏览器。
 */
export const QINGML_NESTED_BULLET_LIST_EXAMPLE = '<ul><li>大类甲<ul><li>具体项一</li><li>具体项二</li></ul></li><li>大类乙</li></ul>'

export const QINGML_NESTED_TASK_LIST_EXAMPLE = '<tasks><task>父任务<tasks><task>子任务</task></tasks></task></tasks>'

export const QINGML_SYSTEM = `你是青简写作侧模型。只输出一份完整 QingML 文档，不要解释，不要 Markdown 围栏；第一个非空字符必须是 <。

文档是无根标签流。文档标题写进最前的 <title>,同时在正文开头写一个文字完全一致的 <h1> 作为纸面大标题;其余 h2-h6 用于章节层级。<title> 只能出现一次;正文至少一个顶层块。文本中的 & 和 < 必须分别写成 &amp; 与 &lt;。

顶层/块标签白名单：
- h1..h6（align、anchor）、p（align）、ul/li、ol（style）/li、tasks/task（checked）
- blockquote、hr、pre（lang）、table/tr/th/td（bg；colspan/rowspan 只能是正整数）
- callout（emoji、tone）、columns/column（ratio，至少两列）、mermaid、drawio、math-block
- img（src、alt、title、width、height）、file（id、filename）、pennote

行内标签白名单：b/strong、i/em、u、s/del、code、a（href、title）、mark（color）、color（val）、math、br、footnote（id）。

结构约束：列表项放在相应列表中；列表的层级靠嵌套表达,不靠标题:<li> 内放一个子 <ul>/<ol> 即下一级,<task> 内放子 <tasks> 即子任务。嵌套项目列表正面样例:${QINGML_NESTED_BULLET_LIST_EXAMPLE}。嵌套任务清单正面样例:${QINGML_NESTED_TASK_LIST_EXAMPLE}。用户要「大类下面再列具体的」「分几类、每类带几项」时,必须用这种嵌套列表,不要用「小标题+平级列表」——标题是章节切分,不是列表层级；表格只含 tr，tr 只含 th/td；单元格可含块；callout、blockquote、pennote 内只放行内内容；pre、mermaid、drawio、math-block 内是原样文本，不能再嵌标签；columns 至少两个 column；footnote id 匹配 [A-Za-z0-9_-]{1,64} 且内容为纯文本。

内容要求：严格保持 <title> 与正文开头 <h1> 的标题文字完全一致,再写清楚的章节层级和正文；忠实满足简报，不编造事实。禁止 script/style、on* 属性、未知标签、javascript: 链接。`

export interface CompleteBlocks {
  blocks: string[]
  completeLength: number
}

const VOID_TAGS = new Set(['hr', 'br', 'img', 'file', 'footnote'])

/**
 * 找出当前流中已经闭合的顶层块。解析只负责流式边界，不替代引擎的权威 QingML 校验。
 */
export function completeTopLevelBlocks(input: string): CompleteBlocks {
  const blocks: string[] = []
  const stack: string[] = []
  let blockStart = -1
  let cursor = 0
  let completeLength = 0
  while (cursor < input.length) {
    const opening = input.indexOf('<', cursor)
    if (opening < 0) break
    const closing = input.indexOf('>', opening + 1)
    if (closing < 0) break
    const raw = input.slice(opening + 1, closing).trim()
    cursor = closing + 1
    if (!raw || raw.startsWith('!') || raw.startsWith('?')) continue
    const isClosing = raw.startsWith('/')
    const name = raw.replace(/^\//, '').match(/^[A-Za-z][\w-]*/)?.[0]?.toLowerCase()
    if (!name) continue
    if (!isClosing) {
      if (stack.length === 0) blockStart = opening
      const selfClosing = raw.endsWith('/') || VOID_TAGS.has(name)
      if (!selfClosing) stack.push(name)
      if (selfClosing && stack.length === 0 && blockStart >= 0) {
        blocks.push(input.slice(blockStart, cursor))
        completeLength = cursor
        blockStart = -1
      }
      continue
    }
    const index = stack.lastIndexOf(name)
    if (index < 0) continue
    stack.length = index
    if (stack.length === 0 && blockStart >= 0) {
      blocks.push(input.slice(blockStart, cursor))
      completeLength = cursor
      blockStart = -1
    }
  }
  return { blocks, completeLength }
}

export function stripQingml(text: string): string {
  return text
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 中日韩字符按字计，拉丁/数字连续串按词计，用于 UI 进度而非计费。 */
export function countWords(qingml: string): number {
  const text = stripQingml(qingml)
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  const latin = text.match(/[\p{Letter}\p{Number}]+/gu)?.filter((word) => !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(word)).length ?? 0
  return cjk + latin
}

export function extractTitle(qingml: string, fallback = '未命名文稿'): string {
  const match = qingml.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)
  return match ? stripQingml(match[1] ?? '').slice(0, 120) || fallback : fallback
}

export interface DraftOutline {
  title: string
  headings: Array<{ level: number; text: string; firstSentence?: string }>
  words: number
  blocks: number
}

export function outlineOf(qingml: string, title?: string | null): DraftOutline {
  const complete = completeTopLevelBlocks(qingml).blocks
  const headings: DraftOutline['headings'] = []
  for (let index = 0; index < complete.length; index += 1) {
    const block = complete[index] ?? ''
    const heading = block.match(/^<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>$/i)
    if (!heading) continue
    let firstSentence: string | undefined
    for (const following of complete.slice(index + 1)) {
      if (/^<h[1-6](?:\s|>)/i.test(following)) break
      const plain = stripQingml(following)
      if (plain) {
        firstSentence = plain.split(/(?<=[。！？.!?])\s*/u)[0]?.slice(0, 160)
        break
      }
    }
    headings.push({ level: Number(heading[1]), text: stripQingml(heading[2] ?? ''), ...(firstSentence ? { firstSentence } : {}) })
  }
  return {
    title: title?.trim() || extractTitle(qingml),
    headings,
    words: countWords(qingml),
    blocks: complete.filter((block) => !/^<title(?:\s|>)/i.test(block)).length,
  }
}

export function makeDraftPrompt(input: { brief: string; title?: string; style?: string; correction?: string }): string {
  return [
    `写作简报：\n${input.brief.trim()}`,
    input.title?.trim() ? `指定标题：${input.title.trim()}` : '',
    input.style?.trim() ? `文风要求：${input.style.trim()}` : '',
    input.correction ?? '',
  ].filter(Boolean).join('\n\n')
}

export function correctionPrompt(previous: string, diagnostic: unknown): string {
  return `上一次 QingML 被青简拒绝。请根据下列脱敏诊断重写整份文档，只输出修正后的完整 QingML。\n诊断：${JSON.stringify(diagnostic)}\n\n上一次输出：\n${previous}`
}
