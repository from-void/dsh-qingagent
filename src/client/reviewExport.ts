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
  return type === 'source'
    ? query.replace(
        INDEPENDENT_REVIEW_CONTRACT,
        `\n${SOURCE_MATERIAL_TOOL_GUIDE}${INDEPENDENT_REVIEW_CONTRACT}`,
      )
    : query
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
