import { useEffect, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { currentReviewStateFor, qingClientStore } from './store.js'
import { failureSummary, openToolCardDocument } from './QingToolCard.js'
import { isFreshnessGateFailure } from '../userVisibleText.js'
import styles from './QingWriteToolCard.module.css'

export { failureSummary } from './QingToolCard.js'

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
  const reviewState = meta?.status === 'review'
    ? currentReviewStateFor(snapshot, meta.engineSessionId, meta.patchIds)
    : 'unknown'
  const pendingReview = reviewState === 'pending'
  // 「块」是内部概念不暴露;运行态无字数时摘要留空(标题「正在写作」已足够,避免「正在写作·写作中」废话)。
  // 标题已表达「未完成」,摘要只留失败原因,避免单卡内重复(评测 P5,K3 定案)。
  const summaryText = failed
    ? failure
    : [
        title ? `《${title}》` : '',
        meta?.status !== 'review' && words > 0 ? `约 ${words} 字` : '',
        meta?.status === 'review' && meta.patchCount
          ? pendingReview ? `${meta.patchCount} 处待裁决` : `${meta.patchCount} 处修改`
          : '',
        pendingReview
          ? meta?.wholeDocReview ? '请在右侧确认是否应用新版' : '请在右侧逐处确认'
          : '',
      ].filter(Boolean).join(' · ')
  const narrativeText = settled && !failed && meta?.status === 'review'
    ? pendingReview
      ? '新版已写好,在右侧等你确认采用或退回。'
      : reviewState === 'settled' ? '当时写好了新版,已处理完。' : '当时写好了新版。'
    : ''
  const handleView = () => openToolCardDocument(
    sessionId,
    meta?.engineSessionId,
    snapshot,
    () => props.qingLayout.openDetails(),
  )

  // qing_write_draft(docRef) 同样受新鲜度闸门保护；只保留给模型的纠错反馈。
  if (failed && isFreshnessGateFailure(settledBlock?.content ?? [])) return null
  return (
    <div className={styles.toolCard} data-state={state}>
      <div className={styles.toolSummaryLine}>
        <strong className={styles.toolTitle}>
          {failed ? '青简写作未完成' : settled ? '青简文稿已生成' : '正在写作'}
        </strong>
        {summaryText ? <span className={styles.separator} aria-hidden="true" /> : null}
        {summaryText ? <span className={styles.toolSummary}>{summaryText}</span> : null}
        {!failed ? (
          <button
            type="button"
            className={styles.viewButton}
            onClick={handleView}
          >查看</button>
        ) : null}
      </div>
      {narrativeText ? <p className={styles.toolNarrative}>{narrativeText}</p> : null}
    </div>
  )
}

interface ToolMeta {
  engineSessionId?: string
  title?: string
  blocks?: number
  words?: number
  status?: string
  patchCount?: number
  wholeDocReview?: boolean
  patchIds?: string[]
}

function isMeta(value: unknown): value is ToolMeta {
  return typeof value === 'object' && value !== null
}
