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
    const deaiAddendum = '\n去AI味补充硬约束:每一处批注都必须给出 suggestion——一句结合上下文改写后的通顺整句,能直接替换原句;anchors[].find 必须是与 suggestion 对应的完整原句。禁止只指出问题不给改写。'
    const genericAddendum = '\n修改意见硬约束:凡问题存在明确可行的改法,必须在该批注的 suggestion 字段给出结合上下文改写后的通顺整句(可直接替换原句),且 anchors[].find 是与之对应的完整原句;只有无法在不改变原意的前提下安全改写时才允许省略 suggestion。在聊天里声称给了修改意见、批注里却没有 suggestion,视为未完成。'
    const expected = type === 'source'
      ? `${expectedBase.replace(independentContract, `\n${sourceGuide}${independentContract}`)}${genericAddendum}`
      : type === 'deai'
        ? `${expectedBase}${deaiAddendum}`
        : `${expectedBase}${genericAddendum}`
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
