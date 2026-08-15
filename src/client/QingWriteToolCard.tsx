import { useEffect, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { qingClientStore } from './store.js'
import styles from './QingWriteToolCard.module.css'

interface InjectedProps {
  qingLayout: ILayout
}

export type QingWriteToolCardProps = PropsRuntime<'tool.call.toolview'> & InjectedProps

export function QingWriteToolCard(props: QingWriteToolCardProps) {
  const sessionId = String(props.useSession((session) => session.sessionId))
  const snapshot = useSyncExternalStore(
    (listener) => qingClientStore.subscribe(sessionId, listener),
    () => qingClientStore.getSnapshot(sessionId),
  )
  useEffect(() => qingClientStore.retain(sessionId), [sessionId])
  const settledBlock = 'kind' in props.block ? props.block : undefined
  const settled = settledBlock !== undefined
  const failed = settledBlock?.isError ?? false
  const meta = isMeta(settledBlock?.meta) ? settledBlock.meta : undefined
  const blocks = meta?.blocks ?? snapshot.blocks
  const words = meta?.words ?? snapshot.words
  const title = meta?.title
  const failure = failed ? failureSummary(settledBlock?.content ?? []) : ''
  const state = failed ? 'failed' : settled ? 'complete' : 'running'

  return (
    <div className={styles.toolCard} data-state={state}>
      <strong className={styles.toolTitle}>
        {failed ? '青简写作未完成' : settled ? '青简文稿已生成' : '正在写作'}
      </strong>
      <span className={styles.separator} aria-hidden="true" />
      <span className={styles.toolSummary}>
        {failed
          ? `未完成${failure ? ` · ${failure}` : ''}`
          : <>
              {title ? `《${title}》 · ` : ''}
              {/* 「块」是内部概念不暴露;没有字数时不显示「约 0 字」。 */}
              {words > 0 ? `约 ${words} 字` : (settled ? '' : '写作中')}
              {meta?.status === 'review' ? ' · 待审阅' : ''}
            </>}
      </span>
      {!failed ? <button type="button" className={styles.viewButton} onClick={() => props.qingLayout.openDetails()}>查看</button> : null}
    </div>
  )
}

interface ToolMeta {
  title?: string
  blocks?: number
  words?: number
  status?: string
}

function isMeta(value: unknown): value is ToolMeta {
  return typeof value === 'object' && value !== null
}

export function failureSummary(content: readonly unknown[]): string {
  const text = content.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const value = block as { type?: unknown; text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n').split(/\r?\n/, 1)[0]?.replace(/^Error:\s*/i, '').trim() ?? ''
  if (/审阅|REVIEW_PENDING/i.test(text)) return '文稿审阅中'
  if (/AGENT_BUSY|正在处理其他任务|引擎忙/i.test(text)) return '引擎忙'
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}
