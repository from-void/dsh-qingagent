// 审查与导出的纯数据/组装层。
// 类型清单与文案搬运自青简 ReviewLaunchModal.tsx 的 REVIEW_META(纯数据,原样拷贝以免拖入 ui-kit 依赖);
// 起手模板与角色种子经 @qingweb 源别名直接引用青简真源。
import { REVIEW_STARTER_PRESETS } from '@qingweb/pages/workspace/components/launchModal/starterPresets'

// 角色审查首选种子(contract-ts 桶未导出该常量,按 ReviewRoleSeeds.ts 原样拷贝首条;青简侧有文案锁测试)。
const ROLE_REVIEW_FIRST_SEED = {
  id: 'review-role-investor',
  name: '投资人视角',
  prompt: '你是要决定是否投资的机构投资人，用尽调的眼光审这篇材料：①每个增长和规模数据，口径清楚吗？可验证吗？②商业模式的关键假设写明白了吗？哪些假设最脆弱？③竞争与风险是否只字不提或一笔带过？挑最影响判断的3-5处，说明投资人会怎么追问，建议怎么补。',
} as const

export type QingReviewType =
  | 'sensitive' | 'deai' | 'source' | 'consistency' | 'privacy' | 'format' | 'role' | 'custom'

export const QING_REVIEW_META: Record<QingReviewType, {
  title: string
  action: string
  subtitle: string
  supplementPlaceholder: string
}> = {
  sensitive: {
    title: '敏感词审查',
    action: '开始审查',
    subtitle: '扫描全文,标记并建议替换',
    supplementPlaceholder: '这次审查要特别注意什么,例如:行业黑话不算敏感词,重点看宣传用语',
  },
  deai: {
    title: '去AI味',
    action: '开始处理',
    subtitle: '识别机器腔,把文字改得更像人写的',
    supplementPlaceholder: '这次处理要特别注意什么,例如:保留第一人称口吻,案例部分别改',
  },
  source: {
    title: '来源核查(仅对照已关联素材)',
    action: '开始核查',
    subtitle: '以当前会话素材为依据,不联网',
    supplementPlaceholder: '这次核查要特别注意什么,例如:重点核对数据和引述,标题不用查',
  },
  consistency: {
    title: '一致性审查',
    action: '开始审查',
    subtitle: '检查全文时间线、数字与称谓是否自洽',
    supplementPlaceholder: '这次审查要特别注意什么,例如:重点核对时间线,产品名以正文第一次出现为准',
  },
  privacy: {
    title: '隐私泄露审查',
    action: '开始审查',
    subtitle: '发布前检查个人与内部信息泄露',
    supplementPlaceholder: '这次审查要特别注意什么,例如:客户名可以保留,内部项目代号要脱敏',
  },
  format: {
    title: '格式规范审查',
    action: '开始审查',
    subtitle: '检查标题层级、标点与数字格式',
    supplementPlaceholder: '这次审查要特别注意什么,例如:数字统一用阿拉伯数字',
  },
  role: {
    title: '角色审查',
    action: '开始审查',
    subtitle: '换一双眼睛读这篇文稿',
    supplementPlaceholder: '这次审查要特别注意什么,例如:重点看数据口径',
  },
  custom: {
    title: '自定义审查',
    action: '开始审查',
    subtitle: '用你自己的要求审这篇文稿',
    supplementPlaceholder: '写下这次审查的具体要求,例如:检查所有小标题是否押韵',
  },
}

export const QING_REVIEW_MENU_ORDER: readonly QingReviewType[] = [
  'sensitive', 'deai', 'source', 'consistency', 'privacy', 'format', 'role', 'custom',
]

/** dsh 闭环执行契约:插件尚未移植青简批注通道,审查产出以清单回复 + 审阅面板提案落地。 */
const DSH_REVIEW_EXECUTION_CONTRACT = [
  '【执行方式】先用 qing_read_draft 通读右侧面板当前聚焦的文稿,再执行审查。',
  '发现的问题逐条列出:引用原文位置、说明问题、给出建议。',
  '需要落实修改时,用 qing_edit_draft 把改法一次性提交进审阅面板,由我逐处裁决;不要整篇重写,不要代替我提交或放弃审阅。',
].join('\n')

export function assembleDshReviewQuery(type: QingReviewType, supplement: string): string {
  const meta = QING_REVIEW_META[type]
  const starter = type === 'role'
    ? ROLE_REVIEW_FIRST_SEED
    : REVIEW_STARTER_PRESETS[type]?.[0]
  const task = type === 'custom'
    ? '对当前文稿做自定义审查。'
    : `对当前文稿做${meta.title}。`
  const templateText = type === 'custom' || !starter
    ? ''
    : `\n审查模板「${starter.name}」:\n${starter.prompt.trim()}`
  const supplementText = supplement.trim()
    ? `\n本次补充要求:${supplement.trim()}`
    : ''
  return `${task}${templateText}${supplementText}\n${DSH_REVIEW_EXECUTION_CONTRACT}`
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
