import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { createScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { QingDocPanel } from './QingDocPanel.js'
import { QingSelectionDock } from './QingSelectionDock.js'
import { QingWriteToolCard } from './QingWriteToolCard.js'
import { qingClientStore } from './store.js'

export const name = 'dsh-qingagent-client'
export const inject = ['slots', 'layout', 'sessions', 'conversation']

export function apply(ctx: ClientContext): void {
  // Cordis 的 get() 在类型上允许服务未就绪；本插件的 inject 已把三者声明为启动前置。
  const slots = ctx.get('slots')!
  const layout = ctx.get('layout')!
  const sessions = ctx.get('sessions') as unknown as ISessions

  slots.inject('details', () => {
    let currentSessionId: string | undefined
    let disposePanel: (() => void) | undefined
    let releaseSession: (() => void) | undefined
    let unsubscribeStore: (() => void) | undefined

    const syncPanelRegistration = () => {
      const shouldRegister = currentSessionId !== undefined && qingClientStore.hasPanelContent(currentSessionId)
      if (shouldRegister && !disposePanel) {
        disposePanel = slots.register({
          name: 'details',
          priority: -10,
          inject: () => ({
            qingLayout: layout,
            // 审查按钮闭环:把组装好的审查 query 作为用户消息发进对应 dsh 会话(排队一轮)。
            qingSendMessage: async (dshSessionId: string, text: string) => {
              // conversation 是作用域寻址服务:sessions.scope() 返回的 AgentContext 挂在运行时
              // 根 fiber 下,不带本插件的 inject 声明会被 cordis 拒绝。用本插件 ctx 铸造同
              // 会话标签的临时作用域,属性链访问即携带 inject 与会话寻址。
              const handle = createScope(
                ctx as unknown as Parameters<typeof createScope>[0],
                dshSessionId as Parameters<typeof createScope>[1],
              )
              try {
                await (handle.ctx as unknown as { conversation: { send(text: string): Promise<void> } })
                  .conversation.send(text)
              } finally {
                handle.fiber.dispose()
              }
            },
          }),
        }, QingDocPanel)
      } else if (!shouldRegister && disposePanel) {
        disposePanel()
        disposePanel = undefined
      }
    }

    const syncCurrentSession = () => {
      const nextSessionId = sessions.list.getSnapshot().current
      if (nextSessionId === currentSessionId) return
      unsubscribeStore?.()
      releaseSession?.()
      disposePanel?.()
      unsubscribeStore = undefined
      releaseSession = undefined
      disposePanel = undefined
      currentSessionId = nextSessionId === undefined ? undefined : String(nextSessionId)
      if (currentSessionId) {
        unsubscribeStore = qingClientStore.subscribe(currentSessionId, syncPanelRegistration)
        releaseSession = qingClientStore.retain(currentSessionId)
      }
      syncPanelRegistration()
    }

    const unsubscribeSessions = sessions.list.subscribe(syncCurrentSession)
    syncCurrentSession()
    return () => {
      unsubscribeSessions()
      unsubscribeStore?.()
      releaseSession?.()
      disposePanel?.()
    }
  })

  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'qing_write_draft',
    inject: () => ({ qingLayout: layout }),
  }, QingWriteToolCard))

  slots.inject('conversation.input.dock', () => slots.register({
    name: 'conversation.input.dock',
    id: 'qingagent-selection',
    order: -10,
  }, QingSelectionDock))
}
