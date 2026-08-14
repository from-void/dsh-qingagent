import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type FinishReason } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { BindingStore } from './bindings.js'
import type { BridgeHub } from './bridge.js'
import type { ExternalDoc, ExternalProposalResponse, SideModelConfig } from './contracts.js'
import { EngineHttpError, type EngineService } from './engine.js'
import {
  QINGML_SYSTEM,
  completeTopLevelBlocks,
  correctionPrompt,
  countWords,
  extractTitle,
  makeDraftPrompt,
  outlineOf,
} from './qingml.js'

interface ToolServices {
  ctx: Context
  engine: EngineService
  bindings: BindingStore
  bridge: BridgeHub
  sideModel?: SideModelConfig
}

const textBlock = (text: string) => [{ type: 'text' as const, text }]

const outlineSchema = {
  type: 'array' as const,
  items: { type: 'string' as const },
}

export function registerTools(services: ToolServices): void {
  const { ctx } = services
  ctx.effect(() => ctx.tools.register(writeDraftTool(services)))
  ctx.effect(() => ctx.tools.register(readDraftTool(services)))
  ctx.effect(() => ctx.tools.register(listDocsTool(services)))
  ctx.effect(() => ctx.tools.register(focusDocTool(services)))
}

function writeDraftTool(services: ToolServices) {
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
          outline: { ...outlineSchema, required: true },
        },
      },
      render: (_args, value) => textBlock([
        `青简文稿《${value.title}》已${value.status === 'committed' ? '提交' : '进入审阅'}。`,
        `文稿引用：${value.engineSessionId}`,
        `共 ${value.blocks} 个块，约 ${value.words} 字。`,
        value.outline.length ? `提纲：\n${value.outline.map((line) => `- ${line}`).join('\n')}` : '提纲：暂无标题层级。',
      ].join('\n')),
      presentationMeta: (_args, value) => ({
        title: value.title,
        blocks: value.blocks,
        words: value.words,
        status: value.status,
        engineSessionId: value.engineSessionId,
      }),
    },
    timeoutMs: 240_000,
    presentCall: (args) => ({
      card: 'generic',
      title: args.docRef ? '正在改写青简文稿' : '正在起草青简文稿',
      kind: 'edit',
      rawInput: { brief: args.brief, ...(args.title ? { title: args.title } : {}), ...(args.style ? { style: args.style } : {}) },
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? '青简写作未完成' : '青简文稿已生成',
    }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      await assertEngineOnline(services.engine)
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
      const initialPrompt = makeDraftPrompt({ brief: args.brief, title: args.title, style: args.style })
      let qingml = await streamQingml(services, exec, dshSessionId, bound.engineSessionId, initialPrompt)
      let proposal: ExternalProposalResponse
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
        qingml = await streamQingml(services, exec, dshSessionId, bound.engineSessionId, retryPrompt)
        proposal = await propose(services.engine, bound.engineSessionId, docBefore.docVersion, qingml)
      }

      const official = await readDoc(services.engine, bound.engineSessionId)
      const title = official.title?.trim() || extractTitle(qingml, args.title?.trim() || bound.title)
      await services.bindings.updateTitle(dshSessionId, bound.engineSessionId, title)
      const outline = outlineOf(qingml, title)
      if (proposal.status === 'committed') {
        services.bridge.emit(dshSessionId, {
          type: 'doc-committed',
          engineSessionId: bound.engineSessionId,
          doc: official,
          blocks: outline.blocks,
          words: outline.words,
        })
      } else {
        services.bridge.emit(dshSessionId, {
          type: 'doc-review-pending',
          engineSessionId: bound.engineSessionId,
          doc: official,
          count: proposal.count,
          blocks: outline.blocks,
          words: outline.words,
        })
      }
      return {
        title,
        blocks: outline.blocks,
        words: outline.words,
        status: proposal.status,
        engineSessionId: bound.engineSessionId,
        outline: outline.headings.map((heading) => `${'  '.repeat(Math.max(0, heading.level - 1))}${heading.text}`),
      }
    },
  })
}

function readDraftTool(services: ToolServices) {
  return defineTool({
    name: 'qing_read_draft',
    description: '读取当前会话绑定的青简文稿。默认只返回提纲和首句；只有确需全文时才用 full。',
    parameters: {
      docRef: { type: 'string', description: '青简会话 ID；省略时读取当前激活文稿。' },
      mode: { type: 'string', enum: ['outline', 'full'], default: 'outline', description: 'outline 返回紧凑提纲，full 返回完整 QingML。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          words: { type: 'integer', required: true },
          blocks: { type: 'integer', required: true },
          mode: { type: 'string', enum: ['outline', 'full'], required: true },
          content: { type: 'string', required: true },
          engineSessionId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(`《${value.title}》｜${value.blocks} 块｜约 ${value.words} 字\n${value.content}`),
    },
    presentCall: () => ({ card: 'generic', title: '读取青简文稿', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '读取青简文稿失败' : '已读取青简文稿' }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      const engineSessionId = resolveDocRef(services.bindings, dshSessionId, args.docRef)
      const doc = await readDoc(services.engine, engineSessionId)
      const outline = outlineOf(doc.qingml, doc.title)
      const mode = args.mode ?? 'outline'
      const content = mode === 'full'
        ? doc.qingml
        : outline.headings.map((heading) => `${'#'.repeat(heading.level)} ${heading.text}${heading.firstSentence ? `\n${heading.firstSentence}` : ''}`).join('\n') || '暂无标题层级。'
      return { title: outline.title, words: outline.words, blocks: outline.blocks, mode, content, engineSessionId }
    },
  })
}

function listDocsTool(services: ToolServices) {
  return defineTool({
    name: 'qing_list_docs',
    description: '列出当前 DSH 会话绑定的全部青简文稿、激活状态和引擎状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engine: { type: 'string', enum: ['online', 'offline', 'starting'], required: true },
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
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock(value.docs.length
        ? `青简引擎：${value.engine}\n${value.docs.map((doc) => `${doc.active ? '→' : ' '} ${doc.title}｜${doc.state}｜${doc.engineSessionId}`).join('\n')}`
        : `青简引擎：${value.engine}\n当前会话还没有绑定文稿。`),
    },
    presentCall: () => ({ card: 'generic', title: '查看青简文稿', kind: 'read' }),
    execute: async (_args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      const engine = await services.engine.status()
      const binding = services.bindings.getBinding(dshSessionId)
      const docs = await Promise.all(binding.docs.map(async (bound) => {
        let state = 'offline'
        if (engine.state === 'online') {
          try { state = (await readDoc(services.engine, bound.engineSessionId)).state } catch { state = 'unavailable' }
        }
        return { ...bound, active: bound.engineSessionId === binding.activeEngineSessionId, state }
      }))
      return { engine: engine.state, docs }
    },
  })
}

function focusDocTool(services: ToolServices) {
  return defineTool({
    name: 'qing_focus_doc',
    description: '把右侧青简宣纸预览切换到当前 DSH 会话内的指定文稿。',
    parameters: {
      docRef: { type: 'string', required: true, description: '要聚焦的青简会话 ID。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          engineSessionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          focused: { type: 'boolean', const: true, required: true },
        },
      },
      render: (_args, value) => textBlock(`右侧预览已切换到《${value.title}》（${value.engineSessionId}）。`),
    },
    presentCall: () => ({ card: 'generic', title: '切换青简预览', kind: 'read' }),
    execute: async (args, exec) => {
      const dshSessionId = sessionIdOf(exec)
      const doc = await services.bindings.setActive(dshSessionId, args.docRef)
      services.bridge.emit(dshSessionId, { type: 'focus-changed', engineSessionId: doc.engineSessionId })
      return { engineSessionId: doc.engineSessionId, title: doc.title, focused: true as const }
    },
  })
}

async function streamQingml(
  services: ToolServices,
  exec: ToolRunContext,
  dshSessionId: string,
  engineSessionId: string,
  prompt: string,
): Promise<string> {
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
  return engine.fetchJson<ExternalProposalResponse>(`/sessions/${encodeURIComponent(engineSessionId)}/proposals`, {
    method: 'POST',
    body: JSON.stringify({
      expectedDocVersion,
      clientMutationId: `dsh-${randomUUID()}`,
      ops: [{ kind: 'qingmlDraft', qingml }],
    }),
  })
}

function readDoc(engine: EngineService, engineSessionId: string): Promise<ExternalDoc> {
  return engine.fetchJson<ExternalDoc>(`/sessions/${encodeURIComponent(engineSessionId)}/doc?format=qingml`)
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

async function assertEngineOnline(engine: EngineService): Promise<void> {
  const status = await engine.ensureReady()
  if (status.state !== 'online') {
    throw new Error(`青简引擎离线：${status.message ?? '请先启动青简；需要自动启动时配置 autoLaunch 与 engineCommand。'}`)
  }
}

function hasDiagnostic(body: unknown): body is { diagnostic: unknown } {
  return typeof body === 'object' && body !== null && 'diagnostic' in body
}
