import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { BindingDomainSpec, BindingStore } from './bindings.js'
import { BridgeHub, type BridgeDocStateObserver } from './bridge.js'
import { EngineService } from './engine.js'
import { QINGAGENT_SYSTEM_PROMPT } from './system-prompt.js'
import { createTelemetry } from './telemetry.js'
import { refreshDocState, registerTools } from './tools.js'
import {
  AgentIndex,
  DOC_STATE_STALE_LINE,
  DocStateCache,
  FreshnessTracker,
  formatDocState,
  injectDocState,
} from './docState.js'

export const name = 'dsh-qingagent'
export const inject = ['agents', 'tools', 'webServer', 'storageDomain', 'systemPrompt']

export interface Config {
  engineUrl?: string
  engineCommand?: string
  engineCwd?: string
  autoLaunch?: boolean
  /** 批次 1 保留配置位；工作区导出将在后续批次实现。 */
  workspaceProjection?: boolean
}

export const Config: z<Config> = z.object({
  engineUrl: z.string().default('http://127.0.0.1:8080'),
  engineCommand: z.string(),
  engineCwd: z.string(),
  autoLaunch: z.boolean().default(false),
  workspaceProjection: z.boolean().default(true),
})

export function createBridgeDocStateObserver(
  ctx: Context,
  engine: EngineService,
  bindings: BindingStore,
  docStates: DocStateCache,
): BridgeDocStateObserver {
  return {
    documentChanged: async (dshSessionId, engineSessionId) => {
      if (bindings.getActive(dshSessionId)?.engineSessionId !== engineSessionId) return
      docStates.markDirty(dshSessionId)
      const agent = ctx.agents.list().find((candidate) => String(candidate.id) === dshSessionId)
      try {
        await refreshDocState({ engine, bindings }, docStates, dshSessionId)
      } catch {
        // 主动 inject 只保留面板外部变更后的 stale 提醒；正常状态统一走 systemPrompt.context。
        injectDocState(agent, DOC_STATE_STALE_LINE)
      }
    },
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const resolved = {
    engineUrl: config.engineUrl ?? 'http://127.0.0.1:8080',
    engineCommand: config.engineCommand,
    engineCwd: config.engineCwd,
    autoLaunch: config.autoLaunch ?? false,
  }
  let bridge: BridgeHub | undefined
  const telemetry = createTelemetry(ctx)
  const engine = new EngineService(ctx, resolved, (status) => {
    bridge?.engineStatus(status)
    telemetry.trackEngineStatus(status)
  })
  const domain = await ctx.storageDomain.open(BindingDomainSpec)
  ctx.effect(() => () => domain.close())
  const bindings = new BindingStore(domain, engine, (sessionId, binding) => bridge?.bindingChanged(sessionId, binding))
  const docStates = new DocStateCache()
  const freshness = new FreshnessTracker()
  const agentIndex = new AgentIndex()
  bridge = new BridgeHub(
    ctx,
    engine,
    bindings,
    undefined,
    undefined,
    telemetry,
    createBridgeDocStateObserver(ctx, engine, bindings, docStates),
  )
  bridge.mount()
  engine.startMonitoring()
  void (async () => {
    await telemetry.init()
    await telemetry.capturePluginActivated(await engine.status())
  })().catch(() => undefined)

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:qingagent-writing-discipline',
    order: 160,
    text: QINGAGENT_SYSTEM_PROMPT,
  }))
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'plugin:qingagent-doc-state',
    order: 100,
    text: (assemblyContext) => {
      const scope = assemblyContext.scope
      if (!scope || typeof scope !== 'object') return ''
      const dshSessionId = agentIndex.get(scope)
      if (!dshSessionId || !bindings.getActive(dshSessionId)) return ''
      return docStates.contextText(dshSessionId)
    },
  }))
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => agentIndex.add(agent)))
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => agentIndex.delete(agent)))
  for (const agent of ctx.agents.list()) agentIndex.add(agent)
  registerTools({
    ctx,
    engine,
    bindings,
    bridge,
    telemetry,
    docStates,
    freshness,
  })
}

export { BindingStore, BindingDomainSpec } from './bindings.js'
export { BridgeHub, isLoopback } from './bridge.js'
export { EngineConnection, EngineHttpError, EngineService } from './engine.js'
export {
  Telemetry,
  TelemetryDomainSpec,
  ageDaysBucket,
  blocksBucket,
  browserStyleUserAgent,
  countBucket,
  createTelemetry,
  editRejectedReason,
  engineStateBucket,
  patchesBucket,
  safeTelemetryErrorMessage,
  validateBridgeTelemetryEvent,
  wordsBucket,
} from './telemetry.js'
export {
  detectQingjianClientInstallation,
  launchDetectedQingjianClient,
  QingjianClientInstallationDetector,
} from './clientInstallation.js'
export {
  CURRENT_PACKAGE_VERSION,
  isNewer,
  PluginUpdateChecker,
} from './updateCheck.js'
export { QINGJIAN_DOWNLOAD_URL, qingjianUnavailableMessage } from './onboarding.js'
export { completeTopLevelBlocks, outlineOf } from './qingml.js'
export { compileQingmlDocument } from './qingmlCompile.js'
export { selectionSystemPrompt } from './selection.js'
export {
  AgentIndex,
  DOC_STATE_STALE_LINE,
  DocStateCache,
  FRESH_DRAFT_REQUIRED_ERROR,
  FreshnessTracker,
  docStateLine,
  formatDocState,
} from './docState.js'
export type * from './contracts.js'
