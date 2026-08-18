import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type FinishReason } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  aiBlocksToQingml,
  countDocVisibleChars,
  pmToAiIr,
  pmToMarkdownWithLineMap,
  type PmDoc,
} from '@qingagent/pm-schema'
import type { BindingStore } from './bindings.js'
import type { BridgeHub } from './bridge.js'
import type {
  ExternalDoc,
  ExternalDocReadResponse,
  ExternalEditProposalOp,
  ExternalPmDocReadResponse,
  ExternalProposalResponse,
  ExternalReviewCommitRequest,
  ExternalReviewCommitResponse,
  ExternalReviewRenderModelResponse,
  SideModelConfig,
} from './contracts.js'
import { DRAFT_MARK_COLORS } from './contracts.js'
import { EngineHttpError, EngineUnavailableError, type EngineService } from './engine.js'
import {
  QINGML_SYSTEM,
  completeTopLevelBlocks,
  convertQingmlSourceSyntax,
  correctionPrompt,
  countWords,
  extractTitle,
  makeDraftPrompt,
  outlineOf,
  structureFactsOf,
} from './qingml.js'
import { isWholeDocReview } from './reviewMode.js'
import {
  blocksBucket,
  countBucket,
  editRejectedReason,
  patchesBucket,
  wordsBucket,
  type TelemetryCapture,
} from './telemetry.js'
import {
  DocStateCache,
  FreshnessTracker,
  docStateLine,
  formatDocState,
  injectDocState,
  type DocStateSnapshot,
} from './docState.js'

interface ToolServices {
  ctx: Context
  engine: EngineService
  bindings: BindingStore
  bridge: BridgeHub
  telemetry?: TelemetryCapture
  sideModel?: SideModelConfig
  docStates?: DocStateCache
  freshness?: FreshnessTracker
}

interface RuntimeToolServices extends ToolServices {
  docStates: DocStateCache
  freshness: FreshnessTracker
}

const textBlock = (text: string) => [{ type: 'text' as const, text }]

const REVIEW_END_MESSAGE = '改动已提交审阅，右侧面板等待用户裁决。本次工具调用结束——不要重写、不要读稿复核、不要自动裁决；收尾说明由工具卡向用户展示，本回合不再产生任何输出。'
const REVIEW_REPEAT_ERROR = '本回合已裁决过一次，禁止连环裁决；等待用户指示'
const REVIEW_PENDING_ERROR = '文稿正在审阅中。待审内容可能是你此前轮次提交的,也可能来自其他会话——不要断言归属。先用 ask_user 向用户说明存在待审稿,经用户明确授权后才可处置;不得代为提交或放弃。'
const STR_REPLACE_PLAIN_TEXT_ERROR = 'old 必须是纯文本内容,不要带 ## 等 markdown 标记'
const STR_REPLACE_LINES_NOTICE = '注意:strReplace 的 old 用纯文本,不要带行首 ## - 等标记。'
const PM_INLINE_ATOM_PLACEHOLDER = '\uFFFC'
const EMPTY_DRAFT_CORRECTION = '上一次只产出了标题、缺少正文。请重写整份文档,只输出包含完整正文块的 QingML;除 <title> 和 h1-h6 标题外,至少包含一个承载正文内容的顶层块。'
const EMPTY_DRAFT_ERROR = '侧模型修正后仍只返回标题,缺少正文块,未提交文稿。'
const SOURCE_SYNTAX_LEAK_ERROR = '文稿中仍有无法识别的脚注或公式写法，未提交文稿。'
// 局部 op 只接受纯文本/Markdown;QingML/HTML 原始标签会被当普通文字刻进正文(用户实测颜色事故)。
const RAW_TAG_PATTERN = /<\/?\s*(article|title|h[1-6]|p|ul|ol|li|tasks?|blockquote|hr|pre|table|tr|td|th|callout|columns?|mermaid|drawio|math(?:-block)?|img|file|pennote|b|strong|i|em|u|s|del|code|a|mark|color|footnote|br|span|div)\b[^>]*>/i
const RAW_TAG_ERROR = '检测到 QingML/HTML 标签:局部操作(strReplace/insertAfterLine/appendSection)只接受纯文本或 Markdown；直接写入 <mark>/<color> 等标签会把它们当普通文字刻进正文。样式类修改请改用 qing_edit_draft 的 markText 操作。'

/**
 * 空壳按顶层块形态判定,不用字数阈值:合法的一句话通知也只需一个 <p>,
 * 而排除 <title> 后仍只有 h1-h6 的产物没有任何可落库的正文块。
 */
function isBodylessDraft(qingml: string): boolean {
  return !completeTopLevelBlocks(qingml).blocks.some((block) =>
    !/^<title(?:\s|>)/i.test(block) && !/^<h[1-6](?:\s|>)/i.test(block))
}

/** P14(RC13):每个工具返回带当前聚焦文稿,纠偏模型沿用旧 docRef。 */
/** mode:"blocks" 用的宽松 PM 节点形状(只读 blockId/type/文本摘要,不承诺完整 schema)。 */
interface PmBlockNode {
  type?: string
  attrs?: { blockId?: string }
  content?: PmBlockNode[]
  text?: string
}

function pmNodeText(node: PmBlockNode): string {
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(pmNodeText).join('')
}

function describePmBlock(node: PmBlockNode, depth: number): string {
  const summary = pmNodeText(node).replace(/\s+/g, ' ').trim()
  const clipped = summary.length > 40 ? `${summary.slice(0, 40)}…` : summary || '(无文本)'
  return `${'  '.repeat(depth)}${node.attrs?.blockId ?? '(无块ID)'}｜${node.type ?? 'unknown'}｜${clipped}`
}

const DOC_STATE_LABELS: Record<string, string> = {
  pendingReview: '审阅中(待用户裁决)',
  editing: '已落库生效',
  empty: '空文稿',
  offline: '引擎离线',
  unavailable: '暂不可读',
}

function docStateLabel(state: string): string {
  return DOC_STATE_LABELS[state] ?? '暂不可读'
}

function focusSuffix(services: ToolServices, dshSessionId: string): string {
  const active = services.bindings.getActive(dshSessionId)
  return active ? `\n(当前面板聚焦:《${active.title}》 docRef=${active.engineSessionId};用户未点名文稿时以聚焦稿为准)` : ''
}

function assertNoRawTags(ops: ExternalEditProposalOp[]): void {
  for (const op of ops) {
    const payloads = op.kind === 'strReplace' ? [op.new] : 'markdown' in op ? [op.markdown] : []
    for (const payload of payloads) {
      if (typeof payload === 'string' && RAW_TAG_PATTERN.test(payload)) throw new Error(RAW_TAG_ERROR)
    }
  }
}

const outlineSchema = {
  type: 'array' as const,
  items: { type: 'string' as const },
}

export function registerTools(services: ToolServices): void {
  const runtime: RuntimeToolServices = {
    ...services,
    docStates: services.docStates ?? new DocStateCache(),
    freshness: services.freshness ?? new FreshnessTracker(),
  }
  const { ctx } = runtime
  const reviewTurns = new ReviewTurnTracker()
  installTurnTracking(ctx, reviewTurns, runtime)
  ctx.effect(() => ctx.tools.register(writeDraftTool(runtime)))
  ctx.effect(() => ctx.tools.register(editDraftTool(runtime)))
  ctx.effect(() => ctx.tools.register(reviewCommitTool(runtime, reviewTurns)))
  ctx.effect(() => ctx.tools.register(readDraftTool(runtime)))
  ctx.effect(() => ctx.tools.register(listDocsTool(runtime)))
  ctx.effect(() => ctx.tools.register(focusDocTool(runtime)))
}

function writeDraftTool(services: RuntimeToolServices) {
  return defineTool({
    name: 'qing_write_draft',
    description: '根据写作简报生成完整 QingML 文稿并提交到青简。省略 docRef 会新建文稿；改写已有文稿必须传当前会话内的 docRef。',
    parameters: {
      brief: { type: 'string', required: true, description: '完整写作简报：目标、受众、要点、素材和约束。' },
      title: { type: 'string', description: '可选标题；未给出时由侧模型拟定。' },
      style: { type: 'string', description: '可选文风、篇幅与排版要求。' },
      docRef: { type: 'string', description: '要整稿改写的青简会话 ID；省略即新建。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          blocks: { type: 'integer', required: true },
          words: { type: 'integer', required: true },
          status: { type: 'string', enum: ['committed', 'review'], required: true },
          engineSessionId: { type: 'string', required: true },
          docVersion: { type: 'integer', required: true },
          patchCount: { type: 'integer', description: 'review 态的待裁决处数。' },
          patchIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'review 态本批次的补丁 ID。',
          },
          wholeDocReview: { type: 'boolean', required: true },
          outline: { ...outlineSchema, required: true },
          footnotes: { type: 'integer', required: true, description: '文稿实际包含的脚注数。' },
          formulas: { type: 'integer', required: true, description: '文稿实际包含的公式数。' },
          automaticConversions: { type: 'integer', required: true, description: '已自动整理为正确格式的脚注与公式数。' },
          warning: { type: 'string', description: '落库块数与提交块数不符时的缺损警告。' },
        },
      },
      render: (_args, value) => value.status === 'review'
        ? textBlock(`${docStateLine('pendingReview', value.patchCount)}\n本稿含 ${value.footnotes} 处脚注、${value.formulas} 个公式，其中 ${value.automaticConversions} 处已自动整理为正确格式。\n${REVIEW_END_MESSAGE}`)
        : textBlock([
          docStateLine('editing'),
          `青简文稿《${value.title}》已提交。`,
          // 反幻觉锚点:committed 必须明确否定审阅态,防模型把审阅纪律泛化脑补(实测幻觉案例)。
          `文稿已直接落库生效,当前不在审阅态,没有任何待审稿,可以立即继续修改。`,
          `文稿引用：${value.engineSessionId}`,
          `全文约 ${value.words} 字。`,
          `本稿含 ${value.footnotes} 处脚注、${value.formulas} 个公式，其中 ${value.automaticConversions} 处已自动整理为正确格式。`,
          ...(typeof value.warning === 'string' ? [`⚠ ${value.warning}`] : []),
          value.outline.length ? `提纲：\n${value.outline.map((line) => `- ${line}`).join('\n')}` : '提纲：暂无标题层级。',
        ].join('\n')),
      presentationMeta: (_args, value) => ({
        title: value.title,
        blocks: value.blocks,
        words: value.words,
        status: value.status,
        patchCount: value.patchCount ?? 0,
        wholeDocReview: value.wholeDocReview,
        engineSessionId: value.engineSessionId,
        ...(value.status === 'review' ? { patchIds: value.patchIds } : {}),
      }),
    },
    timeoutMs: 240_000,
    presentCall: (args) => ({
      card: 'generic',
      title: args.docRef ? '正在改写青简文稿' : '正在起草青简文稿',
      kind: 'edit',
      rawInput: { brief: args.brief, ...(args.title ? { title: args.title } : {}), ...(args.style ? { style: args.style } : {}) },
    }),
    presentResult: (_args, result) => result.isError
      ? failedResultPresentation('青简写作未完成', result.content)
      : { card: 'generic', title: '青简文稿已生成' },
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      let generation = randomUUID()
      let retried = false
      try {
        await assertEngineOnline(services.engine)
        if (args.docRef) services.freshness.assertFresh(exec)
        let bound
        if (args.docRef) {
          if (!services.bindings.hasDoc(dshSessionId, args.docRef)) {
            throw new Error('docRef 不属于当前 DSH 会话。请先调用 qing_list_docs 获取可用文稿。')
          }
          bound = services.bindings.listDocs(dshSessionId).find((doc) => doc.engineSessionId === args.docRef)!
          await services.bindings.setActive(dshSessionId, args.docRef)
        } else {
          bound = await services.bindings.createDoc(dshSessionId, args.title?.trim() || '未命名文稿')
        }

        const docBefore = await readDoc(services.engine, bound.engineSessionId)
        if (docBefore.state === 'pendingReview') {
          throw new Error(REVIEW_PENDING_ERROR)
        }
        const initialPrompt = makeDraftPrompt({ brief: args.brief, title: args.title, style: args.style })
        let qingml: string
        let automaticConversions = 0
        let proposal: ExternalProposalResponse
        try {
          qingml = await streamQingml(services, exec, dshSessionId, bound.engineSessionId, generation, initialPrompt)
          if (isBodylessDraft(qingml)) {
            retried = true
            const retryPrompt = makeDraftPrompt({
              brief: args.brief,
              title: args.title,
              style: args.style,
              correction: `${EMPTY_DRAFT_CORRECTION}\n\n上一次输出:\n${qingml}`,
            })
            generation = randomUUID()
            qingml = await streamQingml(services, exec, dshSessionId, bound.engineSessionId, generation, retryPrompt)
            if (isBodylessDraft(qingml)) throw new Error(EMPTY_DRAFT_ERROR)
          }
          let sourceConversion = convertQingmlSourceSyntax(qingml)
          qingml = sourceConversion.qingml
          automaticConversions = sourceConversion.converted
          if (sourceConversion.leaks.length > 0) throw new Error(SOURCE_SYNTAX_LEAK_ERROR)
          try {
            proposal = await propose(services.engine, bound.engineSessionId, docBefore.docVersion, qingml)
          } catch (error) {
            if (!(error instanceof EngineHttpError) || error.status !== 400 || !hasDiagnostic(error.body)) throw error
            const retryPrompt = makeDraftPrompt({
              brief: args.brief,
              title: args.title,
              style: args.style,
              correction: correctionPrompt(qingml, error.body.diagnostic),
            })
            generation = randomUUID()
            qingml = await streamQingml(services, exec, dshSessionId, bound.engineSessionId, generation, retryPrompt)
            if (isBodylessDraft(qingml)) throw new Error(EMPTY_DRAFT_ERROR)
            sourceConversion = convertQingmlSourceSyntax(qingml)
            qingml = sourceConversion.qingml
            automaticConversions = sourceConversion.converted
            if (sourceConversion.leaks.length > 0) throw new Error(SOURCE_SYNTAX_LEAK_ERROR)
            proposal = await propose(services.engine, bound.engineSessionId, docBefore.docVersion, qingml)
          }
        } catch (error) {
          const safeError = sanitizeToolBoundaryError(error)
          services.bridge.emit(dshSessionId, {
            type: 'draft-failed',
            engineSessionId: bound.engineSessionId,
            generation,
            message: readableError(safeError),
          })
          throw safeError
        }

        try {
          const [official, reviewCandidate, officialPmDoc] = await Promise.all([
            readDoc(services.engine, bound.engineSessionId),
            proposal.status === 'review'
              ? readReviewCandidate(services.engine, bound.engineSessionId)
              : Promise.resolve(null),
            proposal.status === 'committed'
              ? readPmDoc(services.engine, bound.engineSessionId)
              : Promise.resolve(null),
          ])
          const renderedQingml = reviewCandidate?.qingml ?? official.qingml ?? qingml
          const renderedPmDoc = reviewCandidate?.pmDoc ?? officialPmDoc
          if (!renderedPmDoc) throw new Error('青简文稿暂时无法读取，请稍后重试。')
          const words = countDocVisibleChars(renderedPmDoc)
          const wholeDocReview = reviewCandidate
            ? isWholeDocReview(official, reviewCandidate.renderModel, true)
            : false
          const title = official.title?.trim() || extractTitle(renderedQingml, args.title?.trim() || bound.title)
          await services.bindings.updateTitle(dshSessionId, bound.engineSessionId, title)
          // committed 用权威落库稿，review 用 render-model 候选稿；两者都避开本地生成文本与
          // 引擎实际接受结构不一致时的误报。
          const outline = outlineOf(renderedQingml, title)
          const structureFacts = structureFactsOf(renderedQingml)
          const submittedBlocks = completeTopLevelBlocks(qingml).blocks
            .filter((block) => !/^<title(?:\s|>)/i.test(block)).length
          const lostBlocks = Math.max(0, submittedBlocks - outline.blocks)
          if (proposal.status === 'committed') {
            services.bridge.emit(dshSessionId, {
              type: 'doc-committed',
              engineSessionId: bound.engineSessionId,
              generation,
              doc: official,
              blocks: outline.blocks,
              words,
            })
          } else {
            services.bridge.emit(dshSessionId, {
              type: 'doc-review-pending',
              engineSessionId: bound.engineSessionId,
              generation,
              doc: official,
              count: proposal.count,
              blocks: outline.blocks,
              words,
            })
          }
          if (proposal.status === 'review') exec.concludeTurn()
          void services.telemetry?.capture('draft_created', {
            words_bucket: wordsBucket(words),
            blocks_bucket: blocksBucket(outline.blocks),
            retried,
          })
          rememberDocState(services, exec, {
            state: proposal.status === 'review' ? 'pendingReview' : 'editing',
            words,
            blocks: outline.blocks,
            structure: outline.structure,
            title,
            docVersion: official.docVersion,
            ...(proposal.status === 'review' ? { patchCount: proposal.count } : {}),
          }, true)
          return {
            title,
            blocks: outline.blocks,
            words,
            ...(lostBlocks > 0
              ? { warning: `注意:提交了 ${submittedBlocks} 个块,落库仅 ${outline.blocks} 个——有 ${lostBlocks} 个块因 QingML 结构不合规被引擎剥除。请用 qing_read_draft 核对落库内容,缺失的部分需修正格式后重写。` }
              : {}),
            status: proposal.status,
            engineSessionId: bound.engineSessionId,
            docVersion: official.docVersion,
            wholeDocReview,
            footnotes: structureFacts.footnotes,
            formulas: structureFacts.formulas,
            automaticConversions,
            ...(proposal.status === 'review'
              ? { patchCount: proposal.count, patchIds: proposal.patchIds }
              : {}),
            outline: outline.headings.map((heading) => `${'  '.repeat(Math.max(0, heading.level - 1))}${heading.text}`),
          }
        } catch (error) {
          const safeError = sanitizeToolBoundaryError(error)
          services.bridge.emit(dshSessionId, {
            type: 'draft-failed',
            engineSessionId: bound.engineSessionId,
            generation,
            message: readableError(safeError),
          })
          throw safeError
        }
      } catch (error) {
        throw sanitizeToolBoundaryError(error)
      } finally {
        services.bridge.clearSelection(dshSessionId)
      }
    },
  })
}

function editDraftTool(services: RuntimeToolServices) {
  return defineTool({
    name: 'qing_edit_draft',
    description: '对已有青简文稿做结构化局部修改。改标题要同时改两处:setTitle 改稿名(元数据),正文首个大标题块用 strReplace 改(纸面上看到的标题就是它);两者必须在同一次 ops 里一起提交,文字保持一致。正文没有大标题块时,用 insertAfterLine 在文首补一个与稿名一致的「# 标题」一级标题,同样与 setTitle 同批提交。删除整段/整节/清单项用 deleteBlock/deleteListItem(先 qing_read_draft mode:"blocks" 取块 ID,严禁用 strReplace 置空留残壳);改一句、插入一段或追加一节用相应操作;高亮、文字颜色、加粗一句话等行内标记用 markText,严禁为加标记用 qing_write_draft 整篇重写。markText add 会替换命中内容已有的同类型不同属性标记,同类型同属性则幂等提示;remove 仅移除属性全等的标记,调用前必须先用 qing_read_draft(mode:"blocks") 或读稿确认现有标记的确切 attrs;代码块内文本不支持行内标记;命中列表项时审阅卡会按顶层块呈现为整列表替换。strReplace 的 old/new 必须是纯文本内容，不含 ##、-、** 等 Markdown 语法标记。只有用户明确表达「所有/全部/凡是/都」等全局意图时,才用单个 strReplace + all:true 替换全部命中;all:true 不得与 nth 同时使用。all 缺省时,old 多处命中且未指定 nth 仍会拒绝并要求先向用户确认。多处修改必须放进同一次调用的 ops 数组一次提交；逐条调用会因首条进入审阅态而被 REVIEW_PENDING 拒绝。insertAfterLine 用的行号来自你读稿那一刻的稿子;同一批 ops 里一旦有插入或删除,其后所有行号都会整体偏移,不要再沿用读稿时的旧行号。需要在插入点之后继续改时,改用 insertAfterBlock 这类块级锚点(不受行号偏移影响),或留到下一回合重读后再改。命中待办清单、表格、嵌套列表这类多行块时,优先用 insertAfterBlock 等项级/块级 op;例外:指向多行块的最后一行是合法的,语义是插到整块之后(不是块内)——想在清单尾部追加子项时别用它,那会插到清单外面。拿不准结构时先 qing_read_draft(mode:"blocks") 看清再选。文稿审阅中不得调用，应先用 ask_user 征询用户如何处理待审稿。',
    parameters: {
      docRef: { type: 'string', description: '要局部修改的青简会话 ID；省略时使用当前激活文稿。' },
      ops: {
        type: 'array',
        required: true,
        description: '同一次调用中按顺序原子提交的局部操作（最多 50 条）；多处修改必须全部放在本数组中。strReplace 的 nth 为从 1 开始的命中序号；用户明确要求全量替换时改用单个 strReplace + all:true。',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'strReplace', required: true },
                old: { type: 'string', required: true, description: '要匹配的纯文本内容，不含行首 ##、-、数字. 或包裹性 **/__ 等 Markdown 标记。' },
                new: { type: 'string', required: true, description: '替换后的纯文本内容，不含行首 ##、-、数字. 或包裹性 **/__ 等 Markdown 标记。' },
                nth: { type: 'integer', description: '只替换从 1 开始计数的第几处命中；不得与 all:true 同时使用。' },
                all: { type: 'boolean', description: '仅当用户明确说「所有/全部/凡是/都」等全局范围时设为 true；用单个操作替换全部命中，不得与 nth 同时使用。' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'markText', required: true },
                find: { type: 'string', required: true },
                mark: {
                  required: true,
                  oneOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'bold', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'italic', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'strike', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'underline', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: { type: { type: 'string', const: 'code', required: true } },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        type: { type: 'string', const: 'highlight', required: true },
                        color: { type: 'string', enum: DRAFT_MARK_COLORS, required: true },
                      },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        type: { type: 'string', const: 'textColor', required: true },
                        color: { type: 'string', enum: DRAFT_MARK_COLORS, required: true },
                      },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        type: { type: 'string', const: 'link', required: true },
                        href: { type: 'string', required: true },
                        title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                      },
                    },
                  ],
                },
                op: { type: 'string', enum: ['add', 'remove'], required: true },
                all: { type: 'boolean' },
                isRegex: { type: 'boolean' },
                withinRef: { type: 'string' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'insertAfterLine', required: true },
                line: { type: 'integer', required: true },
                markdown: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'appendSection', required: true },
                markdown: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'deleteBlock', required: true },
                blockId: { type: 'string', required: true, description: '要整块删除的块 ID(先用 qing_read_draft mode:"blocks" 获取)。删节/删段用它,严禁用 strReplace 置空留残壳。' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'deleteListItem', required: true },
                blockId: { type: 'string', required: true, description: '要删除的清单项/任务项块 ID(qing_read_draft mode:"blocks" 获取);删掉最后一项时父清单自动清壳。' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'insertAfterBlock', required: true },
                blockId: { type: 'string', required: true, description: '锚点块 ID(qing_read_draft mode:"blocks" 获取)。锚点为清单项→同清单同深度插入兄弟项(markdown 须恰 1 条同类列表项);锚点为顶层块→其后插入顶层块。清单内插入用它,不要用 insertAfterLine。' },
                markdown: { type: 'string', required: true, description: '要插入的 Markdown 内容;禁止 HTML/QingML 标签。' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'setTitle', required: true },
                title: { type: 'string', required: true, description: '新标题;引擎约束:去空白后 1-48 字,同一批最多一个 setTitle,不与整篇 draft 混用。改标题时必须在同一次 ops 里一起提交正文标题同步操作:已有大标题用 strReplace,没有大标题则用 insertAfterLine 在文首补「# 标题」。' },
              },
            },
          ],
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['committed', 'review'], required: true },
          message: { type: 'string', required: true },
          engineSessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          blocks: { type: 'integer', required: true },
          words: { type: 'integer', required: true },
          docVersion: { type: 'integer', required: true },
          reviewCount: { type: 'integer', required: true },
          opResults: {
            type: 'array',
            required: true,
            description: '原始 ops 中每项文字替换实际涉及的处数；opIndex 从 1 开始。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                opIndex: { type: 'integer', required: true },
                affectedCount: { type: 'integer', required: true },
              },
            },
          },
          affectedCount: { type: 'integer', required: true, description: '本批文字替换共影响的处数。' },
          patchIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'review 态本批次的补丁 ID。',
          },
          wholeDocReview: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(value.message),
      presentationMeta: (_args, value) => ({
        status: value.status,
        engineSessionId: value.engineSessionId,
        title: value.title,
        blocks: value.blocks,
        words: value.words,
        reviewCount: value.reviewCount,
        opResults: value.opResults,
        affectedCount: value.affectedCount,
        wholeDocReview: value.wholeDocReview,
        ...(value.status === 'review' ? { patchIds: value.patchIds } : {}),
      }),
    },
    presentCall: () => ({ card: 'generic', title: '正在局部修改青简文稿', kind: 'edit' }),
    presentResult: (_args, result) => result.isError
      ? failedResultPresentation('青简局部修改未完成', result.content)
      : { card: 'generic', title: '青简局部修改已提交' },
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      try {
        await assertEngineOnline(services.engine)
        services.freshness.assertFresh(exec)
        const engineSessionId = resolveDocRef(services.bindings, dshSessionId, args.docRef)
        await services.bindings.setActive(dshSessionId, engineSessionId)
        const before = await readDocWithLines(services.engine, engineSessionId)
        if (before.state === 'pendingReview') throw new Error(REVIEW_PENDING_ERROR)
        const ops = args.ops as ExternalEditProposalOp[]
        const titleOnly = ops.every((op) => op.kind === 'setTitle')
        if (before.state === 'empty' && !titleOnly) throw new Error('文稿尚无正文；请先用 qing_write_draft 起草完整文稿。改标题可单独用 setTitle。')
        assertNoRawTags(ops)
        const prepared = await prepareEditOps(services.engine, engineSessionId, ops)
        const proposal = await proposeEditOpsWithPlainTextRetry(
          services.engine,
          engineSessionId,
          before.docVersion,
          prepared.ops,
        )
        const [official, reviewCandidate, officialPmDoc] = await Promise.all([
          readDoc(services.engine, engineSessionId),
          proposal.status === 'review'
            ? readReviewCandidate(services.engine, engineSessionId)
            : Promise.resolve(null),
          proposal.status === 'committed'
            ? readPmDoc(services.engine, engineSessionId)
            : Promise.resolve(null),
        ])
        const renderedQingml = reviewCandidate?.qingml ?? official.qingml
        const renderedPmDoc = reviewCandidate?.pmDoc ?? officialPmDoc
        if (!renderedPmDoc) throw new Error('青简文稿暂时无法读取，请稍后重试。')
        const words = countDocVisibleChars(renderedPmDoc)
        const wholeDocReview = reviewCandidate
          ? isWholeDocReview(official, reviewCandidate.renderModel, true)
          : false
        const outline = outlineOf(renderedQingml, official.title)
        await services.bindings.updateTitle(dshSessionId, engineSessionId, outline.title)
        if (proposal.status === 'committed') {
          services.bridge.emit(dshSessionId, {
            type: 'doc-committed',
            engineSessionId,
            doc: official,
            blocks: outline.blocks,
            words,
          })
        } else {
          services.bridge.emit(dshSessionId, {
            type: 'doc-review-pending',
            engineSessionId,
            doc: official,
            count: proposal.count,
            blocks: outline.blocks,
            words,
          })
          exec.concludeTurn()
        }
        const countLine = editCountLine(prepared.opResults, prepared.affectedCount)
        void services.telemetry?.capture('draft_edited', {
          ops_bucket: countBucket(ops.length),
          op_kinds: [...new Set(ops.map((op) => op.kind))],
          outcome: proposal.status,
        })
        rememberDocState(services, exec, {
          state: proposal.status === 'review' ? 'pendingReview' : 'editing',
          words,
          blocks: outline.blocks,
          structure: outline.structure,
          title: outline.title,
          docVersion: official.docVersion,
          ...(proposal.status === 'review' ? { patchCount: proposal.count } : {}),
        }, true)
        return {
          status: proposal.status,
          message: (proposal.status === 'review'
            ? `${docStateLine('pendingReview', proposal.count)}${countLine}\n${REVIEW_END_MESSAGE}`
            : `${docStateLine('editing')}\n局部修改已提交到《${outline.title}》。${countLine}`) + focusSuffix(services, dshSessionId),
          engineSessionId,
          title: outline.title,
          blocks: outline.blocks,
          words,
          docVersion: official.docVersion,
          reviewCount: proposal.status === 'review' ? proposal.count : 0,
          opResults: prepared.opResults,
          affectedCount: prepared.affectedCount,
          ...(proposal.status === 'review' ? { patchIds: proposal.patchIds } : {}),
          wholeDocReview,
        }
      } catch (error) {
        void services.telemetry?.capture('edit_rejected', { reason: editRejectedReason(error) })
        throw sanitizeToolBoundaryError(error)
      } finally {
        services.bridge.clearSelection(dshSessionId)
      }
    },
  })
}

function reviewCommitTool(services: RuntimeToolServices, reviewTurns: ReviewTurnTracker) {
  return defineTool({
    name: 'qing_review_commit',
    description: '全量接受或拒绝青简文稿的待审变更。仅当用户在原话中明确授权（如“直接改不用问”“全部接受”“全部放弃”）才可调用；默认必须让用户逐处裁决。审阅中收到新的修改指令时，先调 qing_list_docs 确认文稿仍在审阅中，确认后用 ask_user 征询用户如何处理当前待审稿，禁止擅自 accept_all/reject_all。同一 DSH 会话回合最多调用一次。docRef 省略时使用活跃文稿。',
    parameters: {
      docRef: { type: 'string', description: '青简会话 ID；省略时处理当前激活文稿。' },
      action: { type: 'string', enum: ['accept_all', 'reject_all'], required: true, description: 'accept_all 全部接受；reject_all 全部拒绝。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['reviewed', 'no_pending_review'], required: true },
          message: { type: 'string', required: true },
          engineSessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          docVersion: { type: 'integer', required: true },
          acceptedCount: { type: 'integer', required: true },
          rejectedCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => textBlock(value.message),
      presentationMeta: (_args, value) => ({
        status: value.status,
        engineSessionId: value.engineSessionId,
        title: value.title,
        acceptedCount: value.acceptedCount,
        rejectedCount: value.rejectedCount,
      }),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'accept_all' ? '接受全部青简修改' : '拒绝全部青简修改',
      kind: 'edit',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? '青简审阅处理未完成' : '青简审阅已处理',
    }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      await assertEngineOnline(services.engine)
      reviewTurns.assertFirstAdjudication(exec)
      const engineSessionId = resolveDocRef(services.bindings, dshSessionId, args.docRef)
      const before = await readDoc(services.engine, engineSessionId)
      const beforeTitle = before.title?.trim() || services.bindings.listDocs(dshSessionId)
        .find((doc) => doc.engineSessionId === engineSessionId)?.title || '未命名文稿'
      if (before.state !== 'pendingReview') {
        await refreshAndPublishDocState(services, exec, true)
        return {
          status: 'no_pending_review' as const,
          message: `【文稿状态】已落库生效,当前无待审稿——此前的审阅已由用户在面板处理完毕。不要再次询问如何处置待审稿,直接按用户最新指令继续。${focusSuffix(services, dshSessionId)}`,
          engineSessionId,
          title: beforeTitle,
          docVersion: before.docVersion,
          acceptedCount: 0,
          rejectedCount: 0,
        }
      }

      const body: ExternalReviewCommitRequest = {
        expectedDocVersion: before.docVersion,
        action: args.action,
      }
      const reviewed = await services.engine.fetchJson<ExternalReviewCommitResponse>(
        `/sessions/${encodeURIComponent(engineSessionId)}/review/commit`,
        { method: 'POST', body: JSON.stringify(body) },
      )
      const [official, officialPmDoc] = await Promise.all([
        readDoc(services.engine, engineSessionId),
        readPmDoc(services.engine, engineSessionId),
      ])
      const outline = outlineOf(official.qingml, official.title)
      const words = countDocVisibleChars(officialPmDoc)
      await services.bindings.updateTitle(dshSessionId, engineSessionId, outline.title)
      services.bridge.emit(dshSessionId, {
        type: 'doc-committed',
        engineSessionId,
        doc: official,
        blocks: outline.blocks,
        words,
      })
      const settledPatches = reviewed.acceptedCount + reviewed.rejectedCount
      if (settledPatches > 0) {
        void services.telemetry?.capture('review_settled', {
          action: args.action === 'reject_all' ? 'discard' : 'commit',
          patches_bucket: patchesBucket(settledPatches),
          retried: false,
        })
      }
      rememberDocState(services, exec, {
        state: 'editing',
        words,
        blocks: outline.blocks,
        structure: outline.structure,
        title: outline.title,
        docVersion: official.docVersion,
      }, true)
      return {
        status: 'reviewed' as const,
        message: `【文稿状态】已落库生效,无待审稿。\n${args.action === 'accept_all' ? '已接受' : '已拒绝'}全部待审变更（接受 ${reviewed.acceptedCount} 处，拒绝 ${reviewed.rejectedCount} 处）。请继续完成已排队编辑。${focusSuffix(services, dshSessionId)}`,
        engineSessionId,
        title: outline.title,
        docVersion: official.docVersion,
        acceptedCount: reviewed.acceptedCount,
        rejectedCount: reviewed.rejectedCount,
      }
    },
  })
}

function readDraftTool(services: RuntimeToolServices) {
  return defineTool({
    name: 'qing_read_draft',
    description: '读取当前会话绑定的青简文稿。审阅态下 outline/full 默认读取尚未生效的待审候选；mode:"base" 才读取已提交基线。局部插入前用 mode:"lines" 取得已提交 Markdown 行号;删除块/清单项前用 mode:"blocks" 取得块 ID 清单。',
    parameters: {
      docRef: { type: 'string', description: '青简会话 ID；省略时读取当前激活文稿。' },
      mode: { type: 'string', enum: ['outline', 'full', 'base', 'lines', 'blocks'], default: 'outline', description: 'outline 返回提纲；full 返回完整候选；base 返回已提交基线 QingML；lines 返回带行号的已提交 Markdown；blocks 返回已提交基线的块 ID 清单(deleteBlock/deleteListItem 用)。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          words: { type: 'integer', required: true },
          blocks: { type: 'integer', required: true },
          structure: { type: 'string', required: true },
          mode: { type: 'string', enum: ['outline', 'full', 'base', 'lines', 'blocks'], required: true },
          content: { type: 'string', required: true },
          engineSessionId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          docVersion: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => textBlock(`${docStateLine(value.state)}\n《${value.title}》｜${value.structure}｜约 ${value.words} 字\n${value.content}`),
      presentationMeta: (_args, value) => ({ title: value.title, words: value.words, mode: value.mode }),
    },
    presentCall: () => ({ card: 'generic', title: '读取青简文稿', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '读取青简文稿失败' : '已读取青简文稿' }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      await assertEngineOnline(services.engine)
      const engineSessionId = resolveDocRef(services.bindings, dshSessionId, args.docRef)
      const [doc, basePmDoc] = await Promise.all([
        readDoc(services.engine, engineSessionId),
        readPmDoc(services.engine, engineSessionId),
      ])
      const mode = args.mode ?? 'outline'
      const currentReviewCandidate = doc.state === 'pendingReview'
        ? await readReviewCandidate(services.engine, engineSessionId)
        : null
      const currentQingml = currentReviewCandidate?.qingml ?? doc.qingml
      const currentPmDoc = currentReviewCandidate?.pmDoc ?? basePmDoc
      const currentOutline = outlineOf(currentQingml, doc.title)
      const currentPatchCount = currentReviewCandidate?.renderModel.suggestions
        .filter((suggestion) => suggestion.status === 'reviewing').length
      if (mode === 'blocks') {
        const outline = outlineOf(doc.qingml, doc.title)
        const lines = ['以下为已提交基线的块 ID 清单(供 deleteBlock/deleteListItem 使用;缩进项为清单项)。']
        for (const rawNode of basePmDoc.content ?? []) {
          const node = rawNode as unknown as PmBlockNode
          lines.push(describePmBlock(node, 0))
          if (node.type === 'orderedList' || node.type === 'bulletList' || node.type === 'taskList') {
            for (const item of node.content ?? []) lines.push(describePmBlock(item, 1))
          }
        }
        rememberDocState(services, exec, {
          state: doc.state,
          words: countDocVisibleChars(currentPmDoc),
          blocks: currentOutline.blocks,
          structure: currentOutline.structure,
          title: currentOutline.title,
          docVersion: doc.docVersion,
          ...(currentPatchCount !== undefined ? { patchCount: currentPatchCount } : {}),
        }, true)
        return {
          title: outline.title,
          words: countDocVisibleChars(basePmDoc),
          blocks: outline.blocks,
          structure: outline.structure,
          mode,
          content: lines.join('\n'),
          engineSessionId,
          state: doc.state,
          docVersion: doc.docVersion,
        }
      }
      if (mode === 'lines') {
        const lined = await readDocWithLines(services.engine, engineSessionId)
        const outline = outlineOf(doc.qingml, doc.title)
        const notice = `${STR_REPLACE_LINES_NOTICE}\n${doc.state === 'pendingReview'
          ? '以下行号对应已提交基线（不含待审候选）。\n'
          : ''}`
        rememberDocState(services, exec, {
          state: doc.state,
          words: countDocVisibleChars(currentPmDoc),
          blocks: currentOutline.blocks,
          structure: currentOutline.structure,
          title: currentOutline.title,
          docVersion: doc.docVersion,
          ...(currentPatchCount !== undefined ? { patchCount: currentPatchCount } : {}),
        }, true)
        return {
          title: outline.title,
          words: countDocVisibleChars(basePmDoc),
          blocks: outline.blocks,
          structure: outline.structure,
          mode,
          content: `${notice}${lined.markdownWithLineNumbers ?? lineNumbered(lined.markdown)}`,
          engineSessionId,
          state: doc.state,
          docVersion: doc.docVersion,
        }
      }
      const reviewCandidate = mode !== 'base' ? currentReviewCandidate : null
      const candidate = reviewCandidate?.qingml ?? doc.qingml
      const candidatePmDoc = reviewCandidate?.pmDoc ?? basePmDoc
      const outline = outlineOf(candidate, doc.title)
      const notice = doc.state === 'pendingReview' && mode !== 'base'
        ? '以下为待审候选（尚未生效）；已提交基线请传 mode:"base"。\n'
        : mode === 'base' && doc.state === 'pendingReview'
          ? '以下为已提交基线（不含待审候选）。\n'
          : ''
      const content = mode === 'full' || mode === 'base'
        ? `${notice}${candidate}`
        : `${notice}${outline.headings.map((heading) => `${'#'.repeat(heading.level)} ${heading.text}${heading.firstSentence ? `\n${heading.firstSentence}` : ''}`).join('\n') || '暂无标题层级。'}`
      rememberDocState(services, exec, {
        state: doc.state,
        words: countDocVisibleChars(currentPmDoc),
        blocks: currentOutline.blocks,
        structure: currentOutline.structure,
        title: currentOutline.title,
        docVersion: doc.docVersion,
        ...(currentPatchCount !== undefined ? { patchCount: currentPatchCount } : {}),
      }, true)
      return {
        title: outline.title,
        words: countDocVisibleChars(candidatePmDoc),
        blocks: outline.blocks,
        structure: outline.structure,
        mode,
        content,
        engineSessionId,
        state: doc.state,
        docVersion: doc.docVersion,
      }
    },
  })
}

function listDocsTool(services: RuntimeToolServices) {
  return defineTool({
    name: 'qing_list_docs',
    description: '列出青简文稿。默认列当前 DSH 会话绑定的文稿;scope:"library" 列整个青简文库最近更新的文稿(含其他会话的,最多 50 篇),配合 qing_focus_doc 可收养到本会话。',
    parameters: {
      scope: { type: 'string', enum: ['session', 'library'], default: 'session', description: 'session=本会话绑定稿;library=全库最近文稿。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engine: { type: 'string', enum: ['online', 'offline', 'starting', 'handshake-failed'], required: true },
          docs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                engineSessionId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                active: { type: 'boolean', required: true },
                state: { type: 'string', required: true },
                docVersion: { type: 'integer' },
                createdAt: { type: 'string', required: true },
                bound: { type: 'boolean', description: 'library 模式下:是否已绑定到本会话。' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const active = args.scope !== 'library'
          ? value.docs.find((doc) => doc.active && typeof doc.docVersion === 'number')
          : undefined
        return textBlock([
          `青简引擎：${value.engine}`,
          ...(active ? [docStateLine(active.state)] : []),
          value.docs.length
            ? value.docs.map((doc) => `${doc.active ? '→' : ' '} ${doc.title}｜${docStateLabel(doc.state)}｜${doc.engineSessionId}${doc.bound === false ? '｜未绑定(可用 qing_focus_doc 收养)' : ''}`).join('\n')
            : args.scope === 'library' ? '文库暂无文稿。' : '当前会话还没有绑定文稿。',
        ].join('\n'))
      },
      presentationMeta: (args, value) => ({ count: value.docs.length, scope: args.scope ?? 'session' }),
    },
    presentCall: (args) => ({ card: 'generic', title: args.scope === 'library' ? '查看青简文库' : '查看青简文稿', kind: 'read' }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      const engine = await assertEngineOnline(services.engine)
      const binding = services.bindings.getBinding(dshSessionId)
      if (args.scope === 'library') {
        // 文库模式:引擎全库最近文稿(含其他会话),供空会话/跨会话收养闭环(P40,K3 定案 B)。
        const listing = await services.engine.fetchJson<{
          sessions: Array<{ id: string; title: string | null; state: string; updatedAt: string }>
        }>('/sessions?limit=50')
        const boundIds = new Set(binding.docs.map((doc) => doc.engineSessionId))
        await refreshAndPublishDocState(services, exec, false)
        return {
          engine: engine.state,
          docs: listing.sessions.map((session) => ({
            engineSessionId: session.id,
            title: session.title ?? '未命名文稿',
            active: session.id === binding.activeEngineSessionId,
            state: session.state,
            createdAt: session.updatedAt,
            bound: boundIds.has(session.id),
          })),
        }
      }
      const docs = await Promise.all(binding.docs.map(async (bound) => {
        let state = 'offline'
        let docVersion: number | undefined
        if (engine.state === 'online') {
          try {
            const current = await readDoc(services.engine, bound.engineSessionId)
            state = current.state
            docVersion = current.docVersion
          } catch (error) {
            if (error instanceof EngineUnavailableError) throw error
            state = 'unavailable'
          }
        }
        return {
          ...bound,
          active: bound.engineSessionId === binding.activeEngineSessionId,
          state,
          ...(docVersion !== undefined ? { docVersion } : {}),
        }
      }))
      await refreshAndPublishDocState(services, exec, false)
      return { engine: engine.state, docs }
    },
  })
}

function focusDocTool(services: RuntimeToolServices) {
  return defineTool({
    name: 'qing_focus_doc',
    description: '把右侧青简宣纸预览切换到指定文稿。docRef 未绑定到本会话时,会从青简文库收养该文稿(按 ID 或标题精确匹配且唯一;先用 qing_list_docs scope:"library" 查看文库)。',
    parameters: {
      docRef: { type: 'string', required: true, description: '青简会话 ID,或文库中的文稿标题(精确匹配)。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engineSessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          focused: { type: 'boolean', const: true, required: true },
          state: { type: 'string', required: true },
          docVersion: { type: 'integer', required: true },
          adopted: { type: 'boolean', description: '本次是否为从文库收养(跨会话)。' },
          warning: { type: 'string' },
        },
      },
      render: (_args, value) => textBlock([
        docStateLine(value.state),
        value.adopted
          ? `已从文库收养《${value.title}》(${value.engineSessionId})并切换右侧预览。`
          : `右侧预览已切换到《${value.title}》（${value.engineSessionId}）。`,
        ...(value.warning ? [`⚠ ${value.warning}`] : []),
      ].join('\n')),
      presentationMeta: (_args, value) => ({ adopted: Boolean(value.adopted), title: value.title }),
    },
    presentCall: () => ({ card: 'generic', title: '切换青简预览', kind: 'read' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError
        ? '切换青简预览失败'
        : (result.meta as { adopted?: boolean } | undefined)?.adopted ? '已收养文库文稿' : '已切换青简预览',
    }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      await assertEngineOnline(services.engine)
      const binding = services.bindings.getBinding(dshSessionId)
      if (binding.docs.some((item) => item.engineSessionId === args.docRef)) {
        const doc = await services.bindings.setActive(dshSessionId, args.docRef)
        const current = await readDoc(services.engine, doc.engineSessionId)
        services.bridge.emit(dshSessionId, { type: 'focus-changed', engineSessionId: doc.engineSessionId })
        await refreshAndPublishDocState(services, exec, false)
        return {
          engineSessionId: doc.engineSessionId,
          title: doc.title,
          focused: true as const,
          state: current.state,
          docVersion: current.docVersion,
        }
      }
      // 收养路径(P40,K3 定案):先按 ID 探测引擎确有此稿;未命中再按标题精确匹配,须唯一——
      // 模糊匹配是误收养的最大事故面,多命中一律报错并列候选让用户选。
      let target: { id: string; title: string; state: string } | undefined
      try {
        const probe = await readDoc(services.engine, args.docRef)
        target = { id: args.docRef, title: probe.title?.trim() || '未命名文稿', state: probe.state }
      } catch {
        const listing = await services.engine.fetchJson<{
          sessions: Array<{ id: string; title: string | null; state: string; updatedAt: string }>
        }>('/sessions?limit=50')
        const matches = listing.sessions.filter((session) => (session.title ?? '').trim() === args.docRef.trim())
        if (matches.length > 1) {
          throw new Error(`标题「${args.docRef}」在文库命中 ${matches.length} 篇,请改用文稿 ID:\n${matches.map((m) => `- ${m.title}｜${m.id}`).join('\n')}`)
        }
        if (matches.length === 1) {
          target = { id: matches[0].id, title: matches[0].title ?? '未命名文稿', state: matches[0].state }
        }
      }
      if (!target) {
        throw new Error('未找到该文稿:既不是本会话绑定稿,ID/标题在文库中也未精确命中。先用 qing_list_docs scope:"library" 查看文库。')
      }
      const doc = await services.bindings.adoptDoc(dshSessionId, target.id, target.title)
      const current = await readDoc(services.engine, doc.engineSessionId)
      services.bridge.emit(dshSessionId, { type: 'focus-changed', engineSessionId: doc.engineSessionId })
      await refreshAndPublishDocState(services, exec, false)
      return {
        engineSessionId: doc.engineSessionId,
        title: doc.title,
        focused: true as const,
        state: current.state,
        docVersion: current.docVersion,
        adopted: true,
        ...(current.state === 'pendingReview'
          ? { warning: '该稿有待审内容,可能来自其他会话——不得代为提交/放弃,先向用户说明。' }
          : {}),
      }
    },
  })
}

interface DocStateReadServices {
  engine: EngineService
  bindings: BindingStore
}

/** 读取当前聚焦稿的权威摘要；正文只在进程内计算，缓存与注入均不保存正文。 */
export async function refreshDocState(
  services: DocStateReadServices,
  cache: DocStateCache,
  dshSessionId: string,
): Promise<DocStateSnapshot | undefined> {
  const active = services.bindings.getActive(dshSessionId)
  if (!active) {
    cache.dispose(dshSessionId)
    return undefined
  }
  const [doc, basePmDoc] = await Promise.all([
    readDoc(services.engine, active.engineSessionId),
    readPmDoc(services.engine, active.engineSessionId),
  ])
  const reviewCandidate = doc.state === 'pendingReview'
    ? await readReviewCandidate(services.engine, active.engineSessionId)
    : null
  const qingml = reviewCandidate?.qingml ?? doc.qingml
  const pmDoc = reviewCandidate?.pmDoc ?? basePmDoc
  const outline = outlineOf(qingml, doc.title ?? active.title)
  const patchCount = reviewCandidate?.renderModel.suggestions
    .filter((suggestion) => suggestion.status === 'reviewing').length
  return cache.update(dshSessionId, {
    state: doc.state,
    words: countDocVisibleChars(pmDoc),
    blocks: outline.blocks,
    structure: outline.structure,
    title: outline.title,
    docVersion: doc.docVersion,
    ...(patchCount !== undefined ? { patchCount } : {}),
  })
}

function rememberDocState(
  services: RuntimeToolServices,
  exec: ToolRunContext,
  snapshot: Omit<DocStateSnapshot, 'dirty'>,
  establishesFreshness: boolean,
): void {
  const dshSessionId = sessionIdOf(exec)
  const current = services.docStates.update(dshSessionId, snapshot)
  if (establishesFreshness) services.freshness.markFresh(exec)
  injectDocState(exec.agent, formatDocState(current))
}

async function refreshAndPublishDocState(
  services: RuntimeToolServices,
  exec: ToolRunContext,
  establishesFreshness: boolean,
): Promise<void> {
  if (establishesFreshness) services.freshness.markFresh(exec)
  const dshSessionId = sessionIdOf(exec)
  try {
    const current = await refreshDocState(services, services.docStates, dshSessionId)
    if (current) injectDocState(exec.agent, formatDocState(current))
  } catch {
    services.docStates.markDirty(dshSessionId)
    injectDocState(exec.agent, services.docStates.contextText(dshSessionId))
  }
}

async function streamQingml(
  services: ToolServices,
  exec: ToolRunContext,
  dshSessionId: string,
  engineSessionId: string,
  generation: string,
  prompt: string,
): Promise<string> {
  services.bridge.emit(dshSessionId, { type: 'draft-started', engineSessionId, generation })
  const provider = exec.agent?.options.provider ?? services.sideModel?.provider
  const model = exec.agent?.options.model ?? services.sideModel?.model
  if (!provider || !model) {
    throw new Error('没有可用的侧模型。请为当前 Agent 选择 provider/model，或配置 qingagent.sideModel。')
  }
  let qingml = ''
  let emitted = 0
  let finish: FinishReason | undefined
  const message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-qingagent' },
  })
  for await (const chunk of services.ctx.llm.stream({
    provider,
    model,
    system: QINGML_SYSTEM,
    messages: [message],
    signal: exec.signal,
    ...(exec.agent ? { sessionId: exec.agent.id } : {}),
    temperature: 0.4,
  })) {
    if (chunk.type === 'text-delta') {
      qingml += chunk.text
      const completed = completeTopLevelBlocks(qingml).blocks
      if (completed.length > emitted) {
        const accumulated = completed.join('')
        const contentBlocks = completed.filter((block) => !/^<title(?:\s|>)/i.test(block))
        services.bridge.emit(dshSessionId, {
          type: 'draft-chunk',
          engineSessionId,
          generation,
          chunkQingml: completed.slice(emitted).join(''),
          accumulatedBlocks: completed,
          title: extractTitle(accumulated),
          blocks: contentBlocks.length,
          words: countWords(accumulated),
        })
        emitted = completed.length
      }
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  if (!finish || finish.kind === 'error' || finish.kind === 'aborted') {
    const detail = finish && 'failure' in finish ? finish.failure.message : '模型流未正常结束'
    throw new Error(`QingML 生成失败：${detail}`)
  }
  const output = qingml.trim()
  if (!output) throw new Error('侧模型没有返回 QingML。')
  return output
}

async function propose(engine: EngineService, engineSessionId: string, expectedDocVersion: number, qingml: string): Promise<ExternalProposalResponse> {
  return proposeOps(engine, engineSessionId, expectedDocVersion, [{ kind: 'qingmlDraft', qingml }])
}

const LINE_SHIFTING_BLOCK_OPS = new Set<ExternalEditProposalOp['kind']>([
  'deleteBlock',
  'deleteListItem',
  'insertAfterBlock',
])

interface EditOpResult {
  opIndex: number
  affectedCount: number
}

interface PreparedEditOps {
  ops: ExternalEditProposalOp[]
  opResults: EditOpResult[]
  affectedCount: number
}

async function prepareEditOps(
  engine: EngineService,
  engineSessionId: string,
  ops: ExternalEditProposalOp[],
): Promise<PreparedEditOps> {
  const lineOps = ops.flatMap((op, index) => op.kind === 'insertAfterLine' ? [{ op, index }] : [])
  const strReplaceOps = ops.flatMap((op, index) => op.kind === 'strReplace' ? [{ op, index }] : [])
  if (lineOps.length === 0 && strReplaceOps.length === 0) {
    return { ops, opResults: [], affectedCount: 0 }
  }

  for (const { index } of lineOps) {
    if (ops.slice(0, index).some((op) => LINE_SHIFTING_BLOCK_OPS.has(op.kind))) {
      throw new Error('这批修改先增删了内容，后面的旧行号会失效。请重新读取文稿后改用稳定的段落位置，或调整为先按行插入再增删。')
    }
  }

  const pmDoc = await readPmDoc(engine, engineSessionId)
  const matchCounts = inspectStrReplaceTargets(pmDoc, strReplaceOps)
  const opResults = strReplaceOps.map(({ op, index }) => ({
    opIndex: index + 1,
    affectedCount: op.all === true ? matchCounts.get(index)! : 1,
  }))
  const affectedCount = opResults.reduce((total, result) => total + result.affectedCount, 0)
  const expandAllReplacements = (preparedOps: ExternalEditProposalOp[]): ExternalEditProposalOp[] =>
    preparedOps.flatMap((op, index) => expandStrReplaceForEngine(op, matchCounts.get(index)))
  if (lineOps.length === 0) {
    return { ops: expandAllReplacements(ops), opResults, affectedCount }
  }

  const spans = pmToMarkdownWithLineMap(pmDoc).blocks
  for (const { op } of lineOps) {
    const span = spans.find((item) => op.line >= item.startLine && op.line <= item.endLine)
    if (!span) {
      throw new Error(`第 ${op.line} 行不在当前文稿范围内。请重新读取文稿后再选择插入位置。`)
    }
    if (span.contentEndLine > span.startLine && op.line < span.contentEndLine) {
      throw new Error(`第 ${op.line} 行位于一段多行内容的中间，不能作为插入位置。请改在这段内容的末行之后，或重新读取文稿后按整段定位。`)
    }
  }

  const descending = [...lineOps].sort((left, right) =>
    right.op.line - left.op.line || right.index - left.index)
  let lineIndex = 0
  const reorderedOps = ops.map((op) => op.kind === 'insertAfterLine' ? descending[lineIndex++]!.op : op)
  return { ops: expandAllReplacements(reorderedOps), opResults, affectedCount }
}

interface PmTextNodeLike {
  type?: string
  content?: PmTextNodeLike[]
  text?: string
}

/** 与引擎 findLiteralMatches 同口径：文本节点跨 mark 拼接，hardBreak 投影为换行，块之间不串接。 */
function pmTextBlocks(doc: PmDoc): string[] {
  const blocks: string[] = []
  const visit = (node: PmTextNodeLike): void => {
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock' || node.type === 'penNote') {
      blocks.push((node.content ?? []).map((child) => {
        if (child.type === 'hardBreak') return '\n'
        if (child.type === 'inlineMath' || child.type === 'footnoteReference') return PM_INLINE_ATOM_PLACEHOLDER
        return child.type === 'text' && typeof child.text === 'string' ? child.text : ''
      }).join(''))
    }
    for (const child of node.content ?? []) visit(child)
  }
  for (const node of doc.content as PmTextNodeLike[]) visit(node)
  return blocks
}

function countLiteralMatches(blocks: readonly string[], find: string): number {
  if (!find) return 0
  let count = 0
  for (const block of blocks) {
    let index = block.indexOf(find)
    while (index >= 0) {
      count += 1
      index = block.indexOf(find, index + find.length)
    }
  }
  return count
}

function inspectStrReplaceTargets(
  doc: PmDoc,
  ops: Array<{ op: Extract<ExternalEditProposalOp, { kind: 'strReplace' }>; index: number }>,
): Map<number, number> {
  const matchCounts = new Map<number, number>()
  if (ops.length === 0) return matchCounts
  const blocks = pmTextBlocks(doc)
  for (const { op, index } of ops) {
    if (op.all === true && op.nth !== undefined) {
      throw new Error(`第 ${index + 1} 项不能同时选择全部替换和单处位置；请只保留一种范围。`)
    }
    let matches = countLiteralMatches(blocks, op.old)
    if (matches === 0) {
      const normalizedOld = normalizeStrReplaceText(op.old)
      if (normalizedOld !== op.old) matches = countLiteralMatches(blocks, normalizedOld)
    }
    if (matches === 0) {
      throw new Error(`第 ${index + 1} 个 strReplace 的 old 命中 0 处；请重新读取文稿，并改用当前正文中的精确文字。`)
    }
    if (matches >= 2 && op.nth === undefined && op.all !== true) {
      throw new Error(`第 ${index + 1} 个 strReplace 的 old 命中 ${matches} 处，未指定 nth；目标不唯一时先用原生 ask_user 让用户选。`)
    }
    matchCounts.set(index, matches)
  }
  return matchCounts
}

function expandStrReplaceForEngine(op: ExternalEditProposalOp, matches?: number): ExternalEditProposalOp[] {
  if (op.kind !== 'strReplace') return [op]
  const { all, ...engineOp } = op
  if (all !== true) return [all === undefined ? op : engineOp]

  // 当前引擎契约只支持 nth；从后往前处理可保持原文位置稳定，且整批仍只提交一次。
  return Array.from({ length: matches ?? 0 }, (_, index) => ({
    ...engineOp,
    nth: (matches ?? 0) - index,
  }))
}

function editCountLine(opResults: readonly EditOpResult[], affectedCount: number): string {
  if (opResults.length === 0) return ''
  const perOp = opResults
    .map((result) => `第 ${result.opIndex} 项修改 ${result.affectedCount} 处`)
    .join('，')
  return `\n${perOp}；本批共影响 ${affectedCount} 处。`
}

async function proposeEditOpsWithPlainTextRetry(
  engine: EngineService,
  engineSessionId: string,
  expectedDocVersion: number,
  ops: ExternalEditProposalOp[],
): Promise<ExternalProposalResponse> {
  try {
    return await proposeOps(engine, engineSessionId, expectedDocVersion, ops)
  } catch (error) {
    if (!isStrReplaceNoMatch(error, ops)) throw error
    const normalizedOps = ops.map(normalizeEditOp)
    try {
      return await proposeOps(engine, engineSessionId, expectedDocVersion, normalizedOps)
    } catch (retryError) {
      if (isStrReplaceNoMatch(retryError, normalizedOps)) throw plainTextStrReplaceError(retryError)
      throw retryError
    }
  }
}

function normalizeEditOp(op: ExternalEditProposalOp): ExternalEditProposalOp {
  if (op.kind !== 'strReplace') return op
  return {
    ...op,
    old: normalizeStrReplaceText(op.old),
    new: normalizeStrReplaceText(op.new),
  }
}

function normalizeStrReplaceText(text: string): string {
  const withoutLinePrefixes = text.split('\n').map((line) => {
    const plain = line.replace(
      /^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+|>[ \t]+)/,
      '',
    )
    return unwrapMarkdownEmphasis(plain)
  }).join('\n')
  return unwrapMarkdownEmphasis(withoutLinePrefixes)
}

function unwrapMarkdownEmphasis(text: string): string {
  let normalized = text
  while (true) {
    const wrapped = /^(\*\*|__)([\s\S]+)\1$/.exec(normalized)
    if (!wrapped) return normalized
    normalized = wrapped[2]!
  }
}

function isStrReplaceNoMatch(error: unknown, ops: ExternalEditProposalOp[]): error is EngineHttpError {
  if (!(error instanceof EngineHttpError) || error.status !== 400 || !ops.some((op) => op.kind === 'strReplace')) return false
  const body = error.body as { error?: unknown } | null
  return typeof body?.error === 'string' && body.error.includes('未命中')
}

function plainTextStrReplaceError(error: EngineHttpError): EngineHttpError {
  return new EngineHttpError(error.status, error.body, `${error.message}；${STR_REPLACE_PLAIN_TEXT_ERROR}`)
}

function proposeOps(
  engine: EngineService,
  engineSessionId: string,
  expectedDocVersion: number,
  ops: ExternalEditProposalOp[] | Array<{ kind: 'qingmlDraft'; qingml: string }>,
): Promise<ExternalProposalResponse> {
  // 引擎契约:结构操作批(deleteBlock/deleteListItem)必须携带请求级 opId(幂等寻址)。
  const structural = ops.some((op) => op.kind === 'deleteBlock' || op.kind === 'deleteListItem' || op.kind === 'insertAfterBlock')
  return engine.fetchJson<ExternalProposalResponse>(`/sessions/${encodeURIComponent(engineSessionId)}/proposals`, {
    method: 'POST',
    body: JSON.stringify({
      expectedDocVersion,
      clientMutationId: `dsh-${randomUUID()}`,
      ...(structural ? { opId: `dsh-op-${randomUUID()}` } : {}),
      ops,
    }),
  })
}

function readDoc(engine: EngineService, engineSessionId: string): Promise<ExternalDoc> {
  return engine.fetchJson<ExternalDoc>(`/sessions/${encodeURIComponent(engineSessionId)}/doc?format=qingml`)
}

function readDocWithLines(engine: EngineService, engineSessionId: string): Promise<ExternalDocReadResponse> {
  return engine.fetchJson<ExternalDocReadResponse>(`/sessions/${encodeURIComponent(engineSessionId)}/doc?lines=1`)
}

async function readPmDoc(engine: EngineService, engineSessionId: string): Promise<PmDoc> {
  const response = await engine.fetchJson<ExternalPmDocReadResponse>(
    `/sessions/${encodeURIComponent(engineSessionId)}/doc?format=pm`,
  )
  if (!response.pmDoc) throw new Error('青简文稿暂时无法读取，请稍后重试。')
  return response.pmDoc
}

async function readReviewCandidate(
  engine: EngineService,
  engineSessionId: string,
): Promise<{ qingml: string; pmDoc: PmDoc; renderModel: ExternalReviewRenderModelResponse }> {
  const renderModel = await engine.fetchJson<ExternalReviewRenderModelResponse>(
    `/sessions/${encodeURIComponent(engineSessionId)}/review?format=render-model`,
  )
  const candidate = renderModel.editedDoc ?? renderModel.previewDoc
  if (!candidate) throw new Error('青简待审候选缺少可读取的完整文档。请在右侧面板裁决当前变更。')
  return { qingml: serializePmQingml(candidate), pmDoc: candidate, renderModel }
}

function serializePmQingml(doc: PmDoc): string {
  return aiBlocksToQingml(pmToAiIr(doc).blocks)
}

function lineNumbered(markdown: string): string {
  return markdown.split('\n').map((line, index) => `${String(index + 1).padStart(4)} | ${line}`).join('\n')
}

function sessionIdOf(exec: ToolRunContext): string {
  if (!exec.agent) throw new Error('此工具必须在 DSH 会话中调用。')
  return String(exec.agent.id)
}

function resolveDocRef(bindings: BindingStore, dshSessionId: string, docRef?: string): string {
  if (docRef) {
    if (!bindings.hasDoc(dshSessionId, docRef)) throw new Error('docRef 不属于当前 DSH 会话。')
    return docRef
  }
  const active = bindings.getActive(dshSessionId)
  if (!active) throw new Error('当前会话没有激活文稿。请先写一篇，或用 qing_list_docs / qing_focus_doc 选择。')
  return active.engineSessionId
}

async function assertEngineOnline(
  engine: EngineService,
): Promise<Awaited<ReturnType<EngineService['ensureReady']>> & { state: 'online' }> {
  const status = await engine.ensureReady()
  if (status.state !== 'online') {
    throw new EngineUnavailableError(status)
  }
  return status as typeof status & { state: 'online' }
}

function hasDiagnostic(body: unknown): body is { diagnostic: unknown } {
  return typeof body === 'object' && body !== null && 'diagnostic' in body
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function engineErrorDetail(body: unknown): { code: string; error: string } {
  if (!body || typeof body !== 'object') return { code: '', error: '' }
  const value = body as { code?: unknown; error?: unknown }
  return {
    code: typeof value.code === 'string' ? value.code.trim() : '',
    error: typeof value.error === 'string' ? value.error.trim() : '',
  }
}

function sanitizeToolBoundaryError(error: unknown): unknown {
  if (!(error instanceof EngineHttpError)) return error
  const detail = engineErrorDetail(error.body)
  const raw = `${detail.error}\n${error.message}`
  if (error.message.includes(STR_REPLACE_PLAIN_TEXT_ERROR)) return new Error(STR_REPLACE_PLAIN_TEXT_ERROR)
  if (/位于多行|insertAfter(?:Line|Block)|paragraph\s*块/i.test(raw)) {
    const line = /第\s*(\d+)\s*行/u.exec(raw)?.[1]
    return new Error(`${line ? `第 ${line} 行` : '所选位置'}位于一段多行内容的中间，不能作为插入位置。请改在这段内容的末行之后，或重新读取文稿后按整段定位。`)
  }
  if (/未命中|未唯一命中/u.test(raw)) {
    return new Error('没有找到唯一的目标文字。请重新读取文稿，缩小目标范围后再试。')
  }
  if (detail.code === 'REVIEW_PENDING') return new Error(REVIEW_PENDING_ERROR)
  if (detail.code === 'AGENT_BUSY') return new Error('青简正在处理其他任务，请稍后重试。')
  if (detail.code === 'VERSION_CONFLICT') return new Error('文稿内容已经变化，请重新读取后基于最新内容修改。')
  if (detail.code === 'RATE_LIMITED' || error.status === 429) return new Error('请求过于频繁，请稍后重试。')
  if (detail.code === 'SESSION_NOT_FOUND' || detail.code === 'NOT_FOUND' || error.status === 404) {
    return new Error('没有找到目标文稿，请重新查看文稿列表后再试。')
  }
  if (error.status === 409) return new Error('文稿当前状态不允许这次操作，请重新读取文稿状态后再试。')
  if (error.status === 400) return new Error('这次修改没有生效。请重新读取文稿，换用清晰、稳定的内容位置后再试。')
  return new Error('青简暂时无法完成这次操作，请稍后重试。')
}

function sanitizeFailureSummary(text: string): string {
  if (/paragraph|insertAfter(?:Line|Block)?|blockId|HTTP\s*\d{3}|\b400\b|块\s+[A-Za-z0-9_-]+/i.test(text)) {
    return '修改位置需要重新确认，请重新读取文稿后再试'
  }
  return text
}

function failedResultPresentation(title: string, content: readonly unknown[]) {
  const summary = failureSummary(content)
  return {
    card: 'generic' as const,
    title,
    ...(summary ? { content: textBlock(`未完成 · ${summary}`) } : {}),
  }
}

function failureSummary(content: readonly unknown[]): string {
  const rawText = content.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const value = block as { type?: unknown; text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n').split(/\r?\n/, 1)[0]?.replace(/^Error:\s*/i, '').trim() ?? ''
  const text = sanitizeFailureSummary(rawText)
  if (/审阅|REVIEW_PENDING/i.test(text)) return '文稿审阅中'
  if (/AGENT_BUSY|正在处理其他任务|引擎忙/i.test(text)) return '引擎忙'
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

class ReviewTurnTracker {
  private readonly turns = new Map<string, number>()
  private readonly adjudicated = new Map<string, string>()

  begin(agentId: string, turn: number): void {
    if (this.turns.get(agentId) === turn) return
    this.turns.set(agentId, turn)
    this.adjudicated.delete(agentId)
  }

  dispose(agentId: string): void {
    this.turns.delete(agentId)
    this.adjudicated.delete(agentId)
  }

  assertFirstAdjudication(exec: ToolRunContext): void {
    const agentId = sessionIdOf(exec)
    const turn = this.turns.get(agentId)
    const key = turn === undefined ? `root:${String(exec.rootCallId)}` : `turn:${turn}`
    if (this.adjudicated.get(agentId) === key) throw new Error(REVIEW_REPEAT_ERROR)
    this.adjudicated.set(agentId, key)
  }
}

function installTurnTracking(
  ctx: Context,
  reviewTurns: ReviewTurnTracker,
  services: RuntimeToolServices,
): void {
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const dshSessionId = String(payload.agent.id)
    reviewTurns.begin(dshSessionId, payload.turn)
    services.freshness.begin(dshSessionId, payload.turn)
    if (services.bindings.getActive(dshSessionId) && services.docStates.needsRefresh(dshSessionId)) {
      try {
        await refreshDocState(services, services.docStates, dshSessionId)
      } catch {
        services.docStates.markDirty(dshSessionId)
      }
    }
    return next()
  }))
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    const dshSessionId = String(agent.id)
    reviewTurns.dispose(dshSessionId)
    services.freshness.dispose(dshSessionId)
    services.docStates.dispose(dshSessionId)
  }))
}
