import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { DocumentSnapshotView } from '@qingweb/pages/workspace/components/DocumentSnapshotView'
import { qingClientStore } from './store.js'
import { QINGDOC_FIXTURE_SNAPSHOT } from '../qingdoc/fixture.js'
import '../qingdoc/qingdoc.css'

interface InjectedProps {
  qingLayout: ILayout
}

export type QingDocPanelProps = PropsRuntime<'details'> & InjectedProps

const EMPTY_PATCH_IDS = new Set<string>()

export function QingDocPanel(props: QingDocPanelProps) {
  const sessionId = String(props.useSession((session) => session.sessionId))
  const [editable, setEditable] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const rootRef = useRef<HTMLElement>(null)

  useEffect(
    () => qingClientStore.retain(sessionId, () => props.qingLayout.openDetails()),
    [sessionId, props.qingLayout],
  )

  useEffect(() => {
    const handleToast = (event: Event) => {
      setToast((event as CustomEvent<string>).detail)
    }
    window.addEventListener('qingagent:panel-toast', handleToast)
    return () => window.removeEventListener('qingagent:panel-toast', handleToast)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const measurePaper = useCallback(() => {
    const root = rootRef.current
    const paper = root?.querySelector<HTMLElement>('.wf-doc')
      ?? root?.querySelector<HTMLElement>('.ws-paper-shell')
    if (!root || !paper) return
    const rect = paper.getBoundingClientRect()
    root.style.setProperty('--doc-left', `${rect.left}px`)
    root.style.setProperty('--doc-right', `${rect.right}px`)
  }, [])

  useEffect(() => {
    measurePaper()
    const root = rootRef.current
    const observer = root && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measurePaper)
      : null
    if (root) observer?.observe(root)
    window.addEventListener('resize', measurePaper)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measurePaper)
    }
  }, [measurePaper])

  const rootStyle = {
    '--ws-paper-body-padding-inline': '40px',
    '--ws-paper-chat-column-width': '400px',
    '--ws-paper-column-gap': '48px',
    '--ws-paper-column-width': '800px',
    '--ws-paper-top-offset': '52px',
    '--ws-paper-radius': '0',
  } as CSSProperties

  return (
    <section
      ref={rootRef}
      data-qingagent-doc-panel
      data-view="workspace"
      data-wf="WorkspacePage"
      data-content="editable"
      data-tool="none"
      data-ws-state="idle"
      data-qingdoc-mode={editable ? 'editable' : 'readonly'}
      style={rootStyle}
      aria-label="青简文档"
    >
      <div className="qingdoc-stage-controls" aria-label="第一阶段验收控制">
        <span className="qingdoc-stage-title">青简 · 固定 PM 样稿</span>
        <div className="qingdoc-mode-switch" role="group" aria-label="文档模式">
          <button
            type="button"
            className={editable ? 'is-active' : ''}
            aria-pressed={editable}
            onClick={() => setEditable(true)}
          >
            编辑
          </button>
          <button
            type="button"
            className={!editable ? 'is-active' : ''}
            aria-pressed={!editable}
            onClick={() => setEditable(false)}
          >
            只读
          </button>
        </div>
        <button
          className="qingdoc-close"
          type="button"
          onClick={() => props.qingLayout.closeDetails()}
          aria-label="关闭青简文档"
        >
          ×
        </button>
      </div>
      <div className="ws-body">
        <main className="ws-right">
          <div className="ws-paper-shell" data-wf="WorkspacePaperShell" aria-hidden="true" />
          <div className="ws-document-content" data-wf="WorkspaceHydrationDocumentContent">
            <DocumentSnapshotView
              doc={QINGDOC_FIXTURE_SNAPSHOT}
              docId={`dsh-fixture:${sessionId}`}
              editable
              interactiveEditable={editable}
              showPatches={false}
              acceptedPatches={EMPTY_PATCH_IDS}
              rejectedPatches={EMPTY_PATCH_IDS}
              onToast={setToast}
            />
          </div>
        </main>
      </div>
      {toast ? <div className="qingdoc-toast" role="status">{toast}</div> : null}
    </section>
  )
}
