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
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('字数等你确认后再核对')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('这是自动落款,随字数与保存时间自动更新,属固定装饰不可编辑')
  })

  it('目标不唯一时先澄清且只在用户明确全局词时批量执行', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('目标定位不唯一时(多处命中、指代含糊、「那段/那块」无法唯一确定)必须先用原生 ask_user 让用户选')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('严禁把模糊的单数指代自行提升为「按关键词全局处理」')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('只有用户明确说了「所有/凡是/都/全部」等全局词时才按批量执行')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('用户给出**完整替换文本**时(「把 X 换成 Y」且 Y 是完整句/段),替换范围就是**整个 X**;不要只替换其中一部分而保留原文残句。**提交前**按用户给的整句核对替换范围是否恰好覆盖 X;提交后以工具返回为准,不再读稿复核')
  })

  it('attach 连接下不引导面板导出且不自产替代文件', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【文件工具禁令】文稿正文的读写与导出交付,严禁经工作区文件工具(write/bash 等)——正文一律走 qing_* 工具。**当前这种连接方式下,右侧面板的导出功能不可用**:用户要文件时,如实告诉他这条连接导不了,请他在青简客户端里打开这篇再用客户端导出;**不要引导他去点右侧面板的导出按钮,也不要以"面板导不了"为由自己造文件替代**。')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('仅当面板导出不覆盖所需格式时才可自产文件')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('用户要文件时优先指引右侧面板的「导出」按钮下载')
  })

  it('按写作通道使用任务清单结构且不重复条目标记', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【列表纪律】有序列表的编号由列表结构自动生成:列表项文本内严禁再手写「1.」「2.」等序号(否则删改后字面编号与真实序号错乱);任务/检查/待办类清单必须用**任务清单结构**承载——整篇起草(QingML)用 `<tasks><task>事项</task></tasks>`,局部编辑的 Markdown 字段用 `- [ ] 事项`;**两者都不要在条目文字里再写一遍 `- [ ]` 或 `☐`**,否则会和渲染出的勾选框重复。')
  })

  it('面向用户隐藏工具、参数、版本与原始错误等内部术语', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【用户语言纪律】')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('禁止出现工具名(qing_write_draft/qing_edit_draft/qing_list_docs 等)')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('块 ID(ai-block-…)、vN 版本号、pendingReview 等内部枚举、HTTP 状态码与原始报错')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('以及「落库」「入库」「持久化」「候选」「基线」这类存储实现术语')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('说人话:「已经改好了」「已经生效了」「还没生效,等你确认」')
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

  it('每轮以中文用户话收尾，并要求审阅轮工具前导语也是完整句', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('每一轮的最后都必须有一句面向用户的中文话,说清这轮做了什么、下一步要他做什么')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不允许以工具调用作为一轮的结尾,也不允许停在冒号或半句话上')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('只说定性结论(如「改好了/已提交待你确认」),不要报字数、块数、章节数')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('收尾语只复述**已经确定发生的事**,措辞不得比原文更具体:用户或正文说「好多年」就说「好多年」,**不要替换成「十几年」这类你自己推断的数字或程度词**。')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('机制上你在工具调用之后不再有发言机会,由结果卡向用户说明')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('工具调用之前的那句话仍必须是完整的一句')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不得停在冒号或半句上')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('返回 review 后，本次工具调用已经结束：不要重写、不要读稿复核、不要自动裁决')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('返回 review 后，本回合已经结束')
  })

  it('区分容忍大改与整篇重写授权，同时避免对明确整篇和局部修改重复确认', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('注意区分**容忍改动幅度**与**授权推倒重写**')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('「大改也行」「随便改」「怎么顺怎么来」这类话只表示用户不介意改得多,**不等于允许替换全文结构**')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('只有用户的话里出现「整篇 / 全文 / 整个」这类范围词,或说了「推倒重来」,才算指向整篇、可免征询直接执行')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('用户已经明确说了整篇重写的,**不要再重复确认**')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('局部修改(改一段/改语气但不动结构)本来就不属于整篇重构,不需要为它征询')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('换个写法重写')
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
