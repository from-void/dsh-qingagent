import { useEffect, useRef, useState } from 'react'
import { useConfirm } from '../qingdoc/shims/system.js'

const SUBMITTING_UNLOCK_TIMEOUT_MS = 8000

export interface WholeDocReviewNavProps {
  /** 当前整篇审作用域；确认弹层异步返回后必须仍匹配，避免跨会话/跨审阅误执行。 */
  reviewScopeKey: string
  version: 'new' | 'old'
  isSubmitting?: boolean
  onVersionChange: (version: 'new' | 'old') => void
  /** 应用新版 = 提交本轮全部修改(commit)。 */
  onApply: () => void | Promise<void>
  /** 退回旧版 = 放弃本轮全部修改(discard)。 */
  onRevert: () => void | Promise<void>
  onToast?: (message: string) => void
}

/** 青简 WholeDocReviewNav.tsx 逐结构移植；DOM/class/文案/交互与产品源一致。 */
export function WholeDocReviewNav({
  reviewScopeKey,
  version,
  isSubmitting = false,
  onVersionChange,
  onApply,
  onRevert,
  onToast,
}: WholeDocReviewNavProps) {
  const confirm = useConfirm()
  const [locallySubmitting, setLocallySubmitting] = useState(false)
  const submitting = isSubmitting || locallySubmitting
  const mountedRef = useRef(true)
  const reviewScopeKeyRef = useRef(reviewScopeKey)
  const unlockTimerRef = useRef<number | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (unlockTimerRef.current !== null) window.clearTimeout(unlockTimerRef.current)
    }
  }, [])
  useEffect(() => {
    reviewScopeKeyRef.current = reviewScopeKey
  }, [reviewScopeKey])

  const armSubmitTimeout = () => {
    if (unlockTimerRef.current !== null) window.clearTimeout(unlockTimerRef.current)
    unlockTimerRef.current = window.setTimeout(() => {
      unlockTimerRef.current = null
      setLocallySubmitting(false)
      onToast?.('操作仍未完成，请重试')
    }, SUBMITTING_UNLOCK_TIMEOUT_MS)
  }

  const stopSubmitting = () => {
    if (unlockTimerRef.current !== null) {
      window.clearTimeout(unlockTimerRef.current)
      unlockTimerRef.current = null
    }
    setLocallySubmitting(false)
  }

  const handleApply = () => {
    if (submitting) return
    setLocallySubmitting(true)
    armSubmitTimeout()
    try {
      const result = onApply()
      if (result) void result.then(stopSubmitting, stopSubmitting)
    } catch (error) {
      stopSubmitting()
      throw error
    }
  }

  const handleRevert = async () => {
    if (submitting) return
    const activeScopeKey = reviewScopeKey
    const confirmed = await confirm({
      title: '退回旧版？',
      message: '退回旧版会放弃本轮全部修改。',
      confirmLabel: '退回旧版',
    })
    if (!confirmed) return
    if (!mountedRef.current || reviewScopeKeyRef.current !== activeScopeKey) {
      onToast?.('审阅状态已变化，请重试')
      return
    }
    setLocallySubmitting(true)
    armSubmitTimeout()
    try {
      const result = onRevert()
      if (result) {
        await result
        stopSubmitting()
      }
    } catch (error) {
      stopSubmitting()
      throw error
    }
  }

  return (
    <div className="patch-nav wdr-nav" data-wf="WholeDocReviewNav" aria-busy={submitting}>
      <span className="pn-dot" aria-hidden="true" />
      <span className="pn-label">整篇改写</span>
      <div className="wdr-toggle" role="tablist" aria-label="新旧版本切换">
        <button
          type="button"
          role="tab"
          aria-selected={version === 'new'}
          className={`wdr-opt${version === 'new' ? ' is-on' : ''}`}
          onClick={() => onVersionChange('new')}
          disabled={submitting}
        >
          新版
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={version === 'old'}
          className={`wdr-opt${version === 'old' ? ' is-on' : ''}`}
          onClick={() => onVersionChange('old')}
          disabled={submitting}
        >
          旧版
        </button>
        <span className={`wdr-thumb is-${version}`} aria-hidden="true" />
      </div>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className="pn-commit"
        onClick={handleApply}
        disabled={submitting}
        title="提交本轮全部修改"
      >
        应用新版
      </button>
      <button
        type="button"
        className="pn-ghost"
        onClick={() => void handleRevert()}
        disabled={submitting}
        title="放弃本轮全部修改"
      >
        退回旧版
      </button>
    </div>
  )
}
