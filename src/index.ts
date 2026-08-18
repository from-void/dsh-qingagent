import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { BindingDomainSpec, BindingStore } from './bindings.js'
import { BridgeHub } from './bridge.js'
import { EngineService } from './engine.js'
import { QINGAGENT_SYSTEM_PROMPT } from './system-prompt.js'
import { createTelemetry } from './telemetry.js'
import { registerTools } from './tools.js'
import type { SideModelConfig } from './contracts.js'

export const name = 'dsh-qingagent'
export const inject = ['llm', 'tools', 'webServer', 'storageDomain', 'systemPrompt']

export interface Config {
  engineUrl?: string
  engineCommand?: string
  engineCwd?: string
  autoLaunch?: boolean
  /** 批次 1 保留配置位；工作区导出将在后续批次实现。 */
  workspaceProjection?: boolean
  sideModel?: SideModelConfig
}

export const Config: z<Config> = z.object({
  engineUrl: z.string().default('http://127.0.0.1:8080'),
  engineCommand: z.string(),
  engineCwd: z.string(),
  autoLaunch: z.boolean().default(false),
  workspaceProjection: z.boolean().default(true),
  // Schemastery 的 object 自带 {} 默认；与 never 联合才能表达“整段可省略，出现时两项必填”。
  sideModel: z.union([
    z.never(),
    z.object({
      provider: z.string().required(),
      model: z.string().required(),
    }),
  ]),
})

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
  bridge = new BridgeHub(ctx, engine, bindings, undefined, telemetry)
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
  registerTools({ ctx, engine, bindings, bridge, telemetry, sideModel: config.sideModel })
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
export { QINGJIAN_DOWNLOAD_URL, qingjianUnavailableMessage } from './onboarding.js'
export { QINGML_SYSTEM, completeTopLevelBlocks, countWords, outlineOf } from './qingml.js'
export { selectionSystemPrompt } from './selection.js'
export type * from './contracts.js'
