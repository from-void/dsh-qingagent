import { describe, expect, it } from 'vitest'
import { QINGAGENT_SYSTEM_PROMPT } from '../src/system-prompt.js'

describe('QINGAGENT_SYSTEM_PROMPT', () => {
  it('以最近工具状态为权威并要求新指令先刷新审阅态', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('当前注入的【文稿状态】行或最近一次 qing 工具返回的【文稿状态】行(含 qing_list_docs 的状态列)为同级权威,且都优先于聊天记忆')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('当前 system context 中的【文稿状态】摘要或最近一次 qing 工具返回为权威')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('摘要明确未刷新时才调用 qing_read_draft')
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
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('软目标最多自动重写一次,仍有偏差也会提交')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('这是文末自动落款，会随字数和保存时间自动更新，属于固定装饰，无法编辑或关闭；正文本身不包含它')
  })

  it('目标不唯一时先澄清且只在用户明确全局词时批量执行', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('**宁可多问一次,不可猜着批量改**:定位不唯一时问用户的代价是一个回合,猜错的代价是整篇误改')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('目标定位不唯一时(多处命中、指代含糊、「那段/那处」无法唯一确定)必须先用原生 ask_user 让用户选')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('严禁把模糊的单数指代自行提升为「按关键词全局处理」')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('只有用户明确说了「所有/凡是/都/全部」等全局词时才按批量执行')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('同一文字要全量替换时,只提交一个 strReplace 并设 all:true,不要逐处枚举')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('用户给出**完整替换文本**时(「把 X 换成 Y」且 Y 是完整句/段),替换范围就是**整个 X**;不要只替换其中一部分而保留原文残句。**提交前**按用户给的整句核对替换范围是否恰好覆盖 X;提交后以工具返回为准,不再读稿复核')
  })

  it('attach 连接下不引导面板导出且不自产替代文件', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【文件工具禁令】文稿正文的读写与导出交付,严禁经工作区文件工具(write/bash 等)——正文一律走 qing_* 工具。**当前这种连接方式下,右侧面板的导出功能不可用**:用户要文件时,如实告诉他这条连接导不了,请他在青简客户端里打开这篇再用客户端导出;**不要引导他去点右侧面板的导出按钮,也不要以"面板导不了"为由自己造文件替代**。')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('仅当面板导出不覆盖所需格式时才可自产文件')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('用户要文件时优先指引右侧面板的「导出」按钮下载')
  })

  it('按写作通道使用任务清单结构且不重复条目标记', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【列表纪律】有序列表的编号由列表结构自动生成:列表项文本内严禁再手写「1.」「2.」等序号(否则删改后字面编号与真实序号错乱);任务/检查/待办类清单必须用**任务清单结构**承载——整篇起草(QingML)用 `<tasks><task>事项</task></tasks>`,局部编辑的 Markdown 字段用 `- [ ] 事项`;**两者都不要在条目文字里再写一遍 `- [ ]` 或 `☐`**,否则会和渲染出的勾选框重复。')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('「大类下面再列具体的」「分几类、每类带几项」这类口语对应**嵌套列表**(子项挂在父项之下),不是「二级标题+平级列表」')
  })

  it('面向用户隐藏工具、参数、版本与原始错误等内部术语', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【用户语言纪律】')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('禁止出现工具名(qing_write_draft/qing_edit_draft/qing_list_docs 等)')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('内部定位键、vN 版本号、pendingReview 等内部枚举、HTTP 状态码与原始报错')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('以及「落库」「入库」「持久化」「候选」「基线」这类存储实现术语')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('说人话:「已经改好了」「已经生效了」「还没生效,等你确认」')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('qing 工具返回里的 vN 版本号、定位键、【文稿状态】行、REVIEW_PENDING 等,是给你判断用的内部状态,不是给用户看的措辞')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('✗「已直接落库生效(v1)」→✓「已经写好了,右侧就能看到」')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('工具失败时只说用户能做什么,不转述原始错误')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('ask_user 的选项若指代修改前内容,生成时一律写「改动前的原文」,禁止写「v1 原文」或任何 vN')
    expect(QINGAGENT_SYSTEM_PROMPT.indexOf('【用户语言纪律】'))
      .toBeLessThan(QINGAGENT_SYSTEM_PROMPT.indexOf('【局部修改纪律】'))
  })

  it('区分内容项统计与纸面自然段数', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('工具返回的内容项包含标题、列表、表格等非段落结构,不等于自然段')
  })

  it('改标题时同步稿名和纸面大标题并覆盖无大标题分支', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('正文是否有与旧稿名相同的纸面大标题')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('两者必须在同一次 ops 里提交且文字保持一致')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('没有则允许只用 setTitle 改稿名')
  })

  it('明确提纲走独立 outline 通道', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('必须把各级标题逐项放进独立的 outline 参数,保持原顺序和标题文字')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不能只把提纲埋在 brief 里')
  })

  it('现状提问会刷新旧审阅态且作者快照免读', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('新的修改指令或任何关于文稿现状的提问(当前状态/结构/字数/改了什么/还剩什么没处理)时')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('【作者免读】')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('committed 时直接按返回摘要汇报,不要再读稿复核')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('新回合遇到可能过期的状态线索时,先刷新权威状态再决定是否读稿')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('任何新回合开始时一律先刷新')
  })

  it('每轮以中文用户话收尾，并要求审阅轮工具前导语也是完整句', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('每一轮的最后都必须有一句面向用户的中文话,说清这轮做了什么、下一步要他做什么')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不允许以工具调用作为一轮的结尾,也不允许停在冒号或半句话上')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('只说定性结论(如「改好了/已提交待你确认」),不要报字数、内容项数、章节数')
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

  it('压缩只授权原结构内删字，章节变更仍按全文重构征询', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('用户要求「压缩字数/删减篇幅」不等于授权重排结构——它免征询的范围仅限于删字,不动章节')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('「压缩到 N 字」不授权增删、合并或重排章节')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('需要动结构时仍按【全文重构纪律】处理')
  })

  it('字数软修正收在工具内，不开放同回合第二次编辑', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('字数软目标的唯一次自动修正由 qing_write_draft 工具内部完成')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不得在同回合再自驱读稿或追加修改')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('首稿落库即发现低于硬要求时')
  })

  it('审核结果回流:全采纳一句话收尾', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('**拒绝 0 处(全部采纳)**:只需**一句话**确认结果')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不复述改动清单,不总结改了什么,不主动追加建议——用户问起再说')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('这一句话同时就是【回合收尾纪律】要求的收尾语,不另加第二句')
    expect(QINGAGENT_SYSTEM_PROMPT).not.toContain('只需简短确认,等待用户下一步指示')
  })

  // 用户定的四步:不管已采纳的 → review 被拒的 → 反问是不是哪里改得不好 → 当轮就给方案。
  it('审核结果回流:有拒绝时不复述已采纳、就被拒项求证并当轮给方案', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('也不要复述或总结那些已采纳的改动')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('**拒绝 1 处及以上**:只针对被拒的那几处处理')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('同一条回复里依次做完三件事,不要拆到下一回合、也不要只问不给')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('先读回流消息里附的被拒条目原文与当时的改法,自己判断问题可能出在哪')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('问得具体,不要泛泛地问「哪里不满意」')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('**当轮就给出针对这几处的替代方案**')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('方案未经用户同意前不要动手改稿')
  })

  it('要求正式回复与深度思考都使用中文和用户语言', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('始终使用中文与用户交流,包括深度思考(reasoning/thinking)的内容也必须使用中文')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('思考里指代文稿对象时也尽量用用户语言')
  })

  it('不编造落款开关或其他不存在的界面入口', () => {
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('固定回答:「这是文末自动落款，会随字数和保存时间自动更新，属于固定装饰，无法编辑或关闭；正文本身不包含它。」')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不要即兴发挥别的说法,尤其不要编造设置入口')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不得向用户指路不存在的按钮、菜单或设置项')
    expect(QINGAGENT_SYSTEM_PROMPT).toContain('不确定界面上有没有某个入口时,只说这件事做不到,不要猜路径')
  })
})
