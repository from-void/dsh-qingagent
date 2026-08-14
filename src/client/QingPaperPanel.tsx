import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { renderQingml } from './qingml-renderer.js'
import { qingClientStore } from './store.js'
import styles from './paper.module.css'

interface InjectedProps {
  qingLayout: ILayout
}

export type QingPaperPanelProps = PropsRuntime<'details'> & InjectedProps

export function QingPaperPanel(props: QingPaperPanelProps) {
  // 通过框架标准 kit 绑定当前会话；会话切换后本组件会订阅新的桥接流。
  const sessionId = String(props.useSession((session) => session.sessionId))
  const snapshot = useSyncExternalStore(
    (listener) => qingClientStore.subscribe(sessionId, listener),
    () => qingClientStore.getSnapshot(sessionId),
  )
  useEffect(() => qingClientStore.retain(sessionId, () => props.qingLayout.openDetails()), [sessionId, props.qingLayout])

  const rendered = useMemo(() => renderQingml(snapshot.qingml), [snapshot.qingml])
  const docs = snapshot.state?.docs ?? []
  if (!docs.length && !snapshot.streaming && !snapshot.qingml) return null

  const activeId = snapshot.activeEngineSessionId ?? snapshot.state?.binding.activeEngineSessionId
  const activeBound = docs.find((doc) => doc.engineSessionId === activeId)
  const title = rendered.title || snapshot.activeDoc?.title || activeBound?.title || '未命名文稿'
  const status = statusLabel(snapshot.streaming, snapshot.reviewCount, activeBound?.state, activeBound?.docVersion, snapshot.blocks, snapshot.words)
  const engineUrl = snapshot.state?.engine.engineUrl ?? 'http://127.0.0.1:8080'
  const openUrl = activeId ? `${engineUrl.replace(/\/$/, '')}/#/workspace?session=${encodeURIComponent(activeId)}` : engineUrl

  return (
    <section className={styles.panel} aria-label="青简宣纸预览">
      <header className={styles.toolbar}>
        <div className={styles.titleGroup}>
          <span className={styles.brand}>青简</span>
          <strong className={styles.title} title={title}>{title}</strong>
        </div>
        <div className={styles.controls}>
          {docs.length > 1 ? (
            <select
              className={styles.select}
              aria-label="切换青简文稿"
              value={activeId ?? ''}
              onChange={(event) => void qingClientStore.focus(sessionId, event.currentTarget.value)}
            >
              {docs.map((doc) => (
                <option key={doc.engineSessionId} value={doc.engineSessionId}>
                  {doc.title} · {compactDocState(doc.state, doc.docVersion)}
                </option>
              ))}
            </select>
          ) : null}
          <a className={styles.openLink} href={openUrl} target="_blank" rel="noopener noreferrer">在青简中打开 ↗</a>
          <button className={styles.closeButton} type="button" onClick={() => props.qingLayout.closeDetails()} aria-label="关闭青简预览">×</button>
        </div>
        <div className={styles.statusRow}>
          <span className={`${styles.statusDot} ${snapshot.streaming ? styles.statusWriting : ''}`} aria-hidden="true" />
          <span>{status}</span>
          {snapshot.error ? <span className={styles.error} title={snapshot.error}>连接提示：{snapshot.error}</span> : null}
        </div>
      </header>
      <div className={`${styles.paperViewport} qing-paper`}>
        {snapshot.qingml ? (
          <article
            className={styles.paper}
            aria-live={snapshot.streaming ? 'polite' : 'off'}
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        ) : (
          <div className={styles.empty}>这张宣纸还是空的。</div>
        )}
        {snapshot.streaming ? <span className={styles.inkCursor} aria-label="正在写作" /> : null}
        {snapshot.reviewCount ? (
          <div className={styles.reviewNotice} role="status">
            审阅待处理 · {snapshot.reviewCount} 处变更。请在青简中处理；DSH 审阅界面将在后续批次提供。
          </div>
        ) : null}
        {snapshot.draftFailure ? (
          <div className={styles.failureNotice} role="status">
            写作未完成 · {snapshot.draftFailure}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function statusLabel(
  streaming: boolean,
  reviewCount: number | undefined,
  state: string | undefined,
  version: number | null | undefined,
  blocks: number,
  words: number,
): string {
  if (streaming) return `写作中 · ${blocks} 块 · 约 ${words} 字`
  if (reviewCount || state === 'pendingReview') return `审阅待处理${reviewCount ? ` · ${reviewCount} 处` : ''}`
  if (state === 'offline') return '青简离线'
  if (version !== null && version !== undefined) return `已落稿 v${version}${words ? ` · 约 ${words} 字` : ''}`
  return '准备写作'
}

function compactDocState(state: string, version: number | null): string {
  if (state === 'pendingReview') return '待审阅'
  if (state === 'offline') return '离线'
  if (version !== null) return `v${version}`
  return '空白'
}
