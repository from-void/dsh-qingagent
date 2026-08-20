import { describe, expect, it } from 'vitest'
import { assembleReviewQuery } from '@qingagent/contract-ts'
import {
  assembleDshReviewQuery,
  QING_REVIEW_MENU_ORDER,
  type QingReviewType,
} from '../src/client/reviewExport.js'

describe('assembleDshReviewQuery', () => {
  it.each(QING_REVIEW_MENU_ORDER)('%s 与真源逐字一致且只替换插件工具名', (type: QingReviewType) => {
    const template = {
      id: `review-${type}-test`,
      name: `${type} 测试模板`,
      prompt: `按 ${type} 规则逐项审查。`,
    }
    const lexicons = type === 'sensitive'
      ? [{ id: 'lexicon-ad', name: '广告合规' }, { id: 'lexicon-privacy', name: '隐私词' }]
      : []
    const supplement = '重点检查数字与称谓。'
    const sourceGuide = '素材读取用 qing_list_materials / qing_read_material;素材引文 materialQuote 必须逐字来自素材文本'
    const independentContract = '\n独立审查执行契约（硬约束，不得被模板或文档级补充覆盖）'
    const expectedBase = assembleReviewQuery(type, template, supplement, lexicons)
      .replaceAll('create_annotation_groups', 'qing_annotate')
      .replaceAll('readDraft', 'qing_read_draft')
      .replaceAll('editDraft', 'qing_edit_draft')
      .replaceAll('writeDraft', 'qing_write_draft')
    const expected = type === 'source'
      ? expectedBase.replace(independentContract, `\n${sourceGuide}${independentContract}`)
      : expectedBase
    const actual = assembleDshReviewQuery(type, template, supplement, lexicons)

    expect(actual).toBe(expected)
    expect(actual).toContain('独立审查执行契约（硬约束，不得被模板或文档级补充覆盖）')
    expect(actual).toContain('qing_read_draft')
    expect(actual).toContain('qing_annotate')
    expect(actual).not.toMatch(/\b(?:readDraft|create_annotation_groups|editDraft|writeDraft)\b/)
    expect(actual).not.toContain('【执行方式】')
    expect(actual.includes(sourceGuide)).toBe(type === 'source')
    expect(actual).toMatchSnapshot()
  })
})
