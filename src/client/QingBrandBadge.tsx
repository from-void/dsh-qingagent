import { useCallback, useEffect, useId, useRef, useState } from 'react'

const QINGAGENT_FEEDBACK_URL = 'https://qingagent.com/feedback'
const QINGAGENT_BUG_URL = 'https://github.com/void2anything/dsh-qingagent/issues'
const QINGAGENT_UPDATE_COMMAND = 'npx @deepseek-ai/dsh plugin --profile web add dsh-qingagent@latest'
const UPDATE_SEEN_PREFIX = 'dsh-qingagent.update-seen.v1.'

interface ClientUpdateCheck {
  current: string
  latest: string
  hasUpdate: boolean
}

export function QingBrandBadge() {
  const [update, setUpdate] = useState<ClientUpdateCheck | null>(null)
  const [seenVersion, setSeenVersion] = useState<string | null>(null)
  const [cardOpen, setCardOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'selected'>('idle')
  const rootRef = useRef<HTMLDivElement>(null)
  // hover 宽限:触发区与卡片之间有视觉间隙,鼠标穿过时会短暂离开根元素;
  // 立即关闭会导致用户根本点不到卡里的按钮。延迟关闭 + 重新进入即取消。
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const openCardNow = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    if (!updateOpen) setCardOpen(true)
  }
  const closeCardSoon = () => {
    if (updateOpen) return
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => setCardOpen(false), 260)
  }
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])
  const updateTriggerRef = useRef<HTMLButtonElement>(null)
  const updatePopoverRef = useRef<HTMLDivElement>(null)
  const commandRef = useRef<HTMLInputElement>(null)
  const cardId = useId()
  const updatePopoverId = useId()
  const updateTitleId = useId()

  useEffect(() => {
    let cancelled = false
    void fetch('/qingagent-bridge/update-check')
      .then(async (response) => {
        if (!response.ok) return null
        const payload = await response.json() as Partial<ClientUpdateCheck>
        if (
          typeof payload.current !== 'string'
          || typeof payload.latest !== 'string'
          || typeof payload.hasUpdate !== 'boolean'
        ) return null
        return payload as ClientUpdateCheck
      })
      .then((payload) => {
        if (cancelled || !payload) return
        setSeenVersion(readUpdateSeen(payload.latest) ? payload.latest : null)
        setUpdate(payload)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  const closeUpdate = useCallback((restoreFocus = false) => {
    setUpdateOpen(false)
    if (restoreFocus) updateTriggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!updateOpen) return
    const handleOutsidePointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (updatePopoverRef.current?.contains(target) || updateTriggerRef.current?.contains(target)) return
      setCardOpen(false)
      closeUpdate()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeUpdate(true)
    }
    document.addEventListener('mousedown', handleOutsidePointer)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleOutsidePointer)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeUpdate, updateOpen])

  const hasUnseenUpdate = Boolean(update?.hasUpdate && update.latest !== seenVersion)

  const openUpdate = () => {
    if (!update?.hasUpdate) return
    writeUpdateSeen(update.latest)
    setSeenVersion(update.latest)
    setCopyStatus('idle')
    setUpdateOpen(true)
  }

  const copyUpdateCommand = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(QINGAGENT_UPDATE_COMMAND)
      setCopyStatus('copied')
    } catch {
      commandRef.current?.focus()
      commandRef.current?.select()
      setCopyStatus('selected')
    }
  }

  return (
    <div
      ref={rootRef}
      className="qingbrand-badge"
      onMouseEnter={openCardNow}
      onMouseLeave={closeCardSoon}
      onBlur={(event) => {
        if (!updateOpen && !rootRef.current?.contains(event.relatedTarget as Node | null)) setCardOpen(false)
      }}
    >
      <button
        className="qingbrand-trigger"
        type="button"
        aria-label={hasUnseenUpdate ? '青简，有新版本' : '青简反馈与更新'}
        aria-haspopup="true"
        aria-expanded={cardOpen}
        aria-controls={cardOpen ? cardId : undefined}
        onFocus={() => { if (!updateOpen) setCardOpen(true) }}
        onClick={() => setCardOpen(true)}
      >
        <span className="qingdoc-brand">青简</span>
        {hasUnseenUpdate ? <span className="qingbrand-new" aria-hidden="true">new</span> : null}
      </button>
      {cardOpen ? (
        <div id={cardId} className="qingbrand-hover-card" role="group" aria-label="青简反馈与更新">
          <div className="qingbrand-feedback-links">
            <a href={QINGAGENT_BUG_URL} target="_blank" rel="noreferrer">
              <span className="qingbrand-item-label">报 Bug</span>
              <span className="qingbrand-item-hint">用起来不对劲，去 GitHub 提一条</span>
            </a>
            <a href={QINGAGENT_FEEDBACK_URL} target="_blank" rel="noreferrer">
              <span className="qingbrand-item-label">提需求</span>
              <span className="qingbrand-item-hint">想要什么功能，去需求广场说</span>
            </a>
          </div>
          {update?.hasUpdate ? (
            <button
              ref={updateTriggerRef}
              className="qingbrand-update-trigger"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={updateOpen}
              aria-controls={updateOpen ? updatePopoverId : undefined}
              onClick={openUpdate}
            >
              <span className="qingbrand-item-label">
                更新插件
                {hasUnseenUpdate ? <span className="qingbrand-update-dot" aria-hidden="true" /> : null}
              </span>
              <span className="qingbrand-item-hint">
                {`有新版本 ${update.latest}，点开看怎么更新`}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
      {updateOpen && update ? (
        <div
          ref={updatePopoverRef}
          id={updatePopoverId}
          className="qingbrand-update-popover"
          role="dialog"
          aria-labelledby={updateTitleId}
        >
          <div className="qingbrand-update-heading">
            <strong id={updateTitleId}>更新青简插件</strong>
            <button type="button" onClick={() => closeUpdate(true)} aria-label="关闭更新插件浮层">×</button>
          </div>
          <p className="qingbrand-update-version">当前 {update.current} · 最新 {update.latest}</p>
          <label htmlFor={`${updatePopoverId}-command`}>在终端运行</label>
          <div className="qingbrand-command-row">
            <input
              ref={commandRef}
              id={`${updatePopoverId}-command`}
              readOnly
              value={QINGAGENT_UPDATE_COMMAND}
              aria-label="青简插件更新指令"
            />
            <button type="button" onClick={() => { void copyUpdateCommand() }}>复制</button>
          </div>
          <p className="qingbrand-copy-status" aria-live="polite">
            {copyStatus === 'copied' ? '已复制' : copyStatus === 'selected' ? '复制不可用，已选中指令' : ''}
          </p>
          <p className="qingbrand-update-note">运行后需重启 DSH 生效。</p>
        </div>
      ) : null}
    </div>
  )
}

function readUpdateSeen(version: string): boolean {
  try {
    return window.localStorage.getItem(UPDATE_SEEN_PREFIX + version) === '1'
  } catch {
    return false
  }
}

function writeUpdateSeen(version: string): void {
  try {
    window.localStorage.setItem(UPDATE_SEEN_PREFIX + version, '1')
  } catch {
    // 存储不可用不影响本次会话内清除角标和展示更新指令。
  }
}
