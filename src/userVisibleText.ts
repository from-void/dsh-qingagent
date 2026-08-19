/** 新鲜度闸门给模型的稳定错误；客户端据此隐藏仅用于自恢复的失败卡。 */
export const FRESH_DRAFT_REQUIRED_ERROR = '请先调用 qing_read_draft 读取当前文稿，再基于最新内容修改。'

/** 工具已经自修一次但模型随后仍可重试的篇幅/结构错误。 */
export const SELF_HEALABLE_DRAFT_FAILURE_PREFIX = '自动修正后仍未满足明确要求'

/**
 * 工具呈现、状态摘要与 toast 的统一用户文案出口。
 * 旧记录或引擎错误仍可能带内部定位信息；所有真正展示给用户的摘要在这里去内部术语。
 */
export function sanitizeUserVisibleText(text: string): string {
  return text
    .replace(/ai-block[-_:][A-Za-z0-9_-]+/gi, '对应位置')
    .replace(/(?:paragraph|heading|section|table|diagram|image|code|quote|list)[-_:][A-Za-z0-9_-]+/gi, '对应位置')
    .replace(/block[-_:][A-Za-z0-9_-]+/gi, '对应位置')
    .replace(/[A-Za-z0-9_-]*blockId[A-Za-z0-9_-]*/gi, '内容位置')
    .replace(/块\s*ID/gi, '内容位置')
    .replace(/块结构/g, '内容结构')
    .replace(/块清单/g, '内容清单')
    .replace(/块数/g, '内容项数')
    .replace(/(\d+|[一二三四五六七八九十百千万两]+)\s*个?块/g, '$1 项内容')
    .replace(/块/g, '内容项')
}

export function toolContentText(content: readonly unknown[]): string {
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const value = block as { type?: unknown; text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n')
}

export function isFreshnessGateFailure(content: readonly unknown[]): boolean {
  return toolContentText(content).includes(FRESH_DRAFT_REQUIRED_ERROR)
}

export function isSelfHealableDraftFailure(content: readonly unknown[]): boolean {
  return toolContentText(content).includes(SELF_HEALABLE_DRAFT_FAILURE_PREFIX)
}
