import { useEffect, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { qingClientStore } from './store.js'
import styles from './paper.module.css'

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

  return (
    <div className={`${styles.toolCard} ${failed ? styles.toolCardError : ''}`}>
      <span className={styles.toolGlyph} aria-hidden="true">✎</span>
      <div className={styles.toolCopy}>
        <strong>{failed ? '青简写作未完成' : settled ? '青简文稿已生成' : '正在写作'}</strong>
        <span>
          {title ? `《${title}》 · ` : ''}
          {settled ? `${blocks} 块 · 约 ${words} 字` : `已写 ${blocks} 块 · ${words} 字`}
          {meta?.status === 'review' ? ' · 待审阅' : ''}
        </span>
      </div>
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
