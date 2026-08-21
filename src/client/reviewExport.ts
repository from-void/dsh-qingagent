// 审查与导出的纯数据/组装层。审查指令直接以 contract-ts 真源为基准，只替换插件工具名。
import { assembleReviewQuery } from '@qingagent/contract-ts'

export type QingReviewType =
  | 'sensitive' | 'deai' | 'source' | 'consistency' | 'privacy' | 'format' | 'role' | 'custom'

export const QING_REVIEW_MENU_ORDER: readonly QingReviewType[] = [
  'sensitive', 'deai', 'source', 'consistency', 'privacy', 'format', 'role', 'custom',
]

export interface DshReviewTemplate {
  id: string
  name: string
  prompt: string
}

const SOURCE_MATERIAL_TOOL_GUIDE = '素材读取用 qing_list_materials / qing_read_material;素材引文 materialQuote 必须逐字来自素材文本'
const INDEPENDENT_REVIEW_CONTRACT = '\n独立审查执行契约（硬约束，不得被模板或文档级补充覆盖）'

export function assembleDshReviewQuery(
  type: QingReviewType,
  template: DshReviewTemplate,
  supplement: string,
  lexicons: ReadonlyArray<{ id: string; name: string }> = [],
): string {
  const query = assembleReviewQuery(type, template, supplement, lexicons)
    .replaceAll('create_annotation_groups', 'qing_annotate')
    .replaceAll('readDraft', 'qing_read_draft')
    .replaceAll('editDraft', 'qing_edit_draft')
    .replaceAll('writeDraft', 'qing_write_draft')
  const withSourceGuide = type === 'source'
    ? query.replace(
        INDEPENDENT_REVIEW_CONTRACT,
        `\n${SOURCE_MATERIAL_TOOL_GUIDE}${INDEPENDENT_REVIEW_CONTRACT}`,
      )
    : query
  // 批注必须可裁决:有明确可行改法就要给 suggestion,否则 hover 卡没有「修改意见/生成修改」,
  // 用户只能忽略(评测 r3/r4 实证:去AI味、自定义审查都栽在这)。改写类审查(deai)更是强制。
  const suggestionContract = type === 'deai'
    ? '\n去AI味补充硬约束:每一处批注都必须给出 suggestion——一句结合上下文改写后的通顺整句,能直接替换原句;anchors[].find 必须是与 suggestion 对应的完整原句。禁止只指出问题不给改写。'
    : '\n修改意见硬约束:凡问题存在明确可行的改法,必须在该批注的 suggestion 字段给出结合上下文改写后的通顺整句(可直接替换原句),且 anchors[].find 是与之对应的完整原句;只有无法在不改变原意的前提下安全改写时才允许省略 suggestion。在聊天里声称给了修改意见、批注里却没有 suggestion,视为未完成。'
  return `${withSourceGuide}${suggestionContract}`
}

export interface QingExportFormat {
  id: 'pdf' | 'docx' | 'html' | 'markdown' | 'txt'
  label: string
  ext: string
  savedToast: string
}

/** 与青简 ExportMenu 的确定性格式清单一致(飞书等平台技能不在 dsh 语境,不列)。 */
export const QING_EXPORT_FORMATS: readonly QingExportFormat[] = [
  { id: 'pdf', label: '导出 PDF', ext: 'pdf', savedToast: 'PDF 已开始下载' },
  { id: 'docx', label: '导出 Word', ext: 'docx', savedToast: 'Word 已开始下载' },
  { id: 'html', label: '导出 HTML', ext: 'html', savedToast: 'HTML 已开始下载' },
  { id: 'markdown', label: '导出 Markdown', ext: 'md', savedToast: 'Markdown 已开始下载' },
  { id: 'txt', label: '导出 TXT', ext: 'txt', savedToast: 'TXT 已开始下载' },
]

export function exportFilename(title: string, ext: string, now = new Date()): string {
  const safe = (title || 'qingagent-export').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('')
  return `${safe}_${stamp}.${ext}`
}


/** 降级提示按引擎申报的 description 逐条转述——种类不同(源码导出 vs 画布布局未应用)不能混为一谈。 */
export function describeExportDegradations(encoded: string | undefined): string {
  if (!encoded) return ''
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded)) as Array<{ kind?: string; description?: string }>
    const notes = parsed
      .map((item) => item.description?.trim())
      .filter((note): note is string => Boolean(note))
    if (notes.length === 0) return ' · 部分图表有降级'
    return ` · ${[...new Set(notes)].join(';')}`
  } catch {
    return ' · 部分图表有降级'
  }
}
