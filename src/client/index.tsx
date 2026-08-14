import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { QingPaperPanel } from './QingPaperPanel.js'
import { QingWriteToolCard } from './QingWriteToolCard.js'

export const name = 'dsh-qingagent-client'
export const inject = ['slots', 'layout']

export function apply(ctx: ClientContext): void {
  // Cordis 的 get() 在类型上允许服务未就绪；本插件的 inject 已把两者声明为启动前置。
  const slots = ctx.get('slots')!
  const layout = ctx.get('layout')!

  slots.inject('details', () => slots.register({
    name: 'details',
    priority: -10,
    inject: () => ({ qingLayout: layout }),
  }, QingPaperPanel))

  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'qing_write_draft',
    inject: () => ({ qingLayout: layout }),
  }, QingWriteToolCard))
}
