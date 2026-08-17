import { describe, expect, it } from 'vitest'
import { QINGAGENT_SYSTEM_PROMPT } from '../src/system-prompt.js'

describe('QINGAGENT_SYSTEM_PROMPT', () => {
  it('以最近工具状态为权威并要求新指令先刷新审阅态', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('文稿状态以最近一次 qing 工具返回的【文稿状态】行(或 qing_list_docs 的状态列)为准')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('先调用一次 qing_list_docs 刷新文稿状态权威态')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('严禁不调工具就宣称文稿处于审阅态')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('若结算后没有收到该消息,即为全部采纳')
  })

  it('保持待审归属中性并覆盖编辑、汇报、字数和落款纪律', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('待审内容可能是你此前轮次提交的,也可能来自其他会话——不要断言归属')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('不得说成自己的修改')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【编辑作用域纪律】')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【叙述一致性红线】')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【结构摘要自检纪律】')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('字数待裁决落库后核对')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('这是自动落款,随字数与保存时间自动更新,属固定装饰不可编辑')
  })

  it('目标不唯一时先澄清且只在用户明确全局词时批量执行', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('目标定位不唯一时(多处命中、指代含糊、「那段/那块」无法唯一确定)必须先用原生 ask_user 让用户选')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('严禁把模糊的单数指代自行提升为「按关键词全局处理」')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('只有用户明确说了「所有/凡是/都/全部」等全局词时才按批量执行')
  })

  it('面向用户隐藏工具、参数、版本与原始错误等内部术语', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【用户语言纪律】')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('禁止出现工具名(qing_write_draft/qing_edit_draft/qing_list_docs 等)')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('块 ID(ai-block-…)、vN 版本号、pendingReview 等内部枚举、HTTP 状态码与原始报错')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('qing 工具返回里的 vN 版本号、块 ID、【文稿状态】行、REVIEW_PENDING 等,是给你判断用的内部状态,不是给用户看的措辞')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('✗「已直接落库生效(v1)」→✓「已经写好了,右侧就能看到」')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('工具失败时只说用户能做什么,不转述原始错误')
    expect(QINGAGENT_SYSTEM_PROMPT.indexOf('【用户语言纪律】'))
      .toBeLessThan(QINGAGENT_SYSTEM_PROMPT.indexOf('【局部修改纪律】'))
  })

  it('区分工具块数与纸面自然段数', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('工具返回的「块」包含标题、列表、表格等非段落结构,不等于自然段')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('向用户描述篇幅结构时按纸面实际形态说(几段正文、几节、几个清单),不得把块数直译成段数')
  })

  it('改标题时同步稿名和纸面大标题并覆盖无大标题分支', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('用 strReplace 改正文首个大标题块')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('两者必须在同一次 ops 里一起提交且文字保持一致')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('正文没有大标题块时,用 insertAfterLine 在文首补一个与稿名一致的「# 标题」一级标题')
  })

  it('现状提问会刷新旧审阅态且免读仅限刚提交编辑的本回合', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('新的修改指令或任何关于文稿现状的提问(当前状态/结构/字数/改了什么/还剩什么没处理)时')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('免读只适用于本回合内刚提交过编辑这一种情形')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('新回合若要判断/汇报文稿状态、结构、字数,或要动手编辑,而上下文里存在可能已过期的审阅态线索,就先刷新权威状态再决定读不读')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('任何新回合开始时一律先刷新')
  })

  it('每轮以中文用户话收尾并保留提交审阅的结果卡例外', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('每一轮的最后都必须有一句面向用户的中文话,说清这轮做了什么、下一步要他做什么')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不允许以工具调用作为一轮的结尾,也不允许停在冒号或半句话上')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('只说定性结论(如「改好了/已提交待你确认」),不要报字数、块数、章节数')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('例外:提交审阅的那一轮由结果卡直接向用户说明,不受本条约束')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不要为此把话硬塞在工具调用之前')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('返回 review 后，本次工具调用已经结束：不要重写、不要读稿复核、不要自动裁决')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('返回 review 后，本回合已经结束')
  })

  it('要求正式回复与深度思考都使用中文和用户语言', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('始终使用中文与用户交流,包括深度思考(reasoning/thinking)的内容也必须使用中文')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('思考里指代文稿对象时也尽量用用户语言')
  })

  it('不编造落款开关或其他不存在的界面入口', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不要建议用户去某个设置或开关里关掉它——没有这样的入口')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不得向用户指路不存在的按钮、菜单或设置项')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不确定界面上有没有某个入口时,只说这件事做不到,不要猜路径')
  })
})
