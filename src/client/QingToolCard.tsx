import { useEffect, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { qingClientStore, type QingClientSnapshot } from './store.js'
import { failureSummary } from './QingWriteToolCard.js'
import styles from './QingWriteToolCard.module.css'

/** 工具卡的具名文案与摘要装配;meta 来自各工具的 presentationMeta(#23)。 */
export interface QingToolCardConfig {
  runningTitle: string
  doneTitle: (meta: ToolCardMeta) => string
  failedTitle: string
  /** 完成态摘要;返回空串则不渲染摘要段。 */
  summary: (meta: ToolCardMeta, snapshot: QingClientSnapshot) => string
  /** 运行态摘要(如写作流式字数);缺省为空。 */
  runningSummary?: (snapshot: QingClientSnapshot) => string
  /** 失败态是否隐藏「查看」按钮以外,默认所有卡都带「查看」入口(与写作卡一致)。 */
  showViewButton?: boolean
}

export interface ToolCardMeta {
  title?: string
  blocks?: number
  words?: number
  status?: string
  reviewCount?: number
  acceptedCount?: number
  rejectedCount?: number
  adopted?: boolean
  count?: number
  scope?: string
  mode?: string
}

interface InjectedProps {
  qingLayout: ILayout
}

type Props = PropsRuntime<'tool.call.toolview'> & InjectedProps

export function createQingToolCard(config: QingToolCardConfig) {
  return function QingToolCard(props: Props) {
    const sessionId = String(props.useSession((session) => session.sessionId))
    const snapshot = useSyncExternalStore(
      (listener) => qingClientStore.subscribe(sessionId, listener),
      () => qingClientStore.getSnapshot(sessionId),
    )
    useEffect(() => qingClientStore.retain(sessionId), [sessionId])
    const settledBlock = 'kind' in props.block ? props.block : undefined
    const settled = settledBlock !== undefined
    const failed = settledBlock?.isError ?? false
    const meta: ToolCardMeta = isMeta(settledBlock?.meta) ? settledBlock.meta : {}
    const state = failed ? 'failed' : settled ? 'complete' : 'running'
    const summaryText = failed
      ? failureSummary(settledBlock?.content ?? [])
      : settled
        ? config.summary(meta, snapshot)
        : config.runningSummary?.(snapshot) ?? ''

    return (
      <div className={styles.toolCard} data-state={state}>
        <strong className={styles.toolTitle}>
          {failed ? config.failedTitle : settled ? config.doneTitle(meta) : config.runningTitle}
        </strong>
        {summaryText ? <span className={styles.separator} aria-hidden="true" /> : null}
        {summaryText ? <span className={styles.toolSummary}>{summaryText}</span> : null}
        {!failed && config.showViewButton !== false ? (
          <button
            type="button"
            className={styles.viewButton}
            onClick={() => { qingClientStore.reopenPanel(sessionId); props.qingLayout.openDetails() }}
          >查看</button>
        ) : null}
      </div>
    )
  }
}

function isMeta(value: unknown): value is ToolCardMeta {
  return typeof value === 'object' && value !== null
}

const titled = (meta: ToolCardMeta) => (meta.title ? `《${meta.title}》` : '')

export const QingEditToolCard = createQingToolCard({
  runningTitle: '正在修改文稿',
  doneTitle: (meta) => (meta.status === 'review' ? '修改待审阅' : '修改已生效'),
  failedTitle: '修改未完成',
  summary: (meta) => [
    titled(meta),
    meta.status === 'review' && meta.reviewCount ? `${meta.reviewCount} 处待裁决` : '',
  ].filter(Boolean).join(' · '),
})

export const QingReviewCommitToolCard = createQingToolCard({
  runningTitle: '正在处理审阅',
  doneTitle: () => '审阅已处理',
  failedTitle: '审阅处理未完成',
  summary: (meta) => [
    titled(meta),
    typeof meta.acceptedCount === 'number' || typeof meta.rejectedCount === 'number'
      ? `采纳 ${meta.acceptedCount ?? 0} · 拒绝 ${meta.rejectedCount ?? 0}`
      : '',
  ].filter(Boolean).join(' · '),
})

export const QingReadToolCard = createQingToolCard({
  runningTitle: '正在读取文稿',
  doneTitle: () => '已读取文稿',
  failedTitle: '读取未完成',
  summary: (meta) => [
    titled(meta),
    typeof meta.words === 'number' && meta.words > 0 ? `约 ${meta.words} 字` : '',
  ].filter(Boolean).join(' · '),
  showViewButton: false,
})

export const QingListDocsToolCard = createQingToolCard({
  runningTitle: '正在查看文稿清单',
  doneTitle: (meta) => (meta.scope === 'library' ? '文库清单' : '会话文稿清单'),
  failedTitle: '文稿清单读取未完成',
  summary: (meta) => (typeof meta.count === 'number' ? `${meta.count} 篇` : ''),
  showViewButton: false,
})

export const QingFocusToolCard = createQingToolCard({
  runningTitle: '正在切换预览',
  doneTitle: (meta) => (meta.adopted ? '已收养文库文稿' : '已切换预览'),
  failedTitle: '切换预览未完成',
  summary: (meta) => titled(meta),
})
