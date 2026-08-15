import { useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { QingSelection } from '../contracts.js'
import { qingClientStore } from './store.js'
import styles from './QingSelectionDock.module.css'

export function QingSelectionDock(props: PropsRuntime<'conversation.input.dock'>) {
  const sessionId = String(props.sessionId)
  const selection = useSyncExternalStore(
    (listener) => qingClientStore.subscribe(sessionId, listener),
    () => qingClientStore.getSnapshot(sessionId).selection,
  )
  if (!selection) return null
  return (
    <QingSelectionChip
      selection={selection}
      onClear={() => { void qingClientStore.clearSelection(sessionId) }}
    />
  )
}

export function QingSelectionChip(props: {
  selection: QingSelection
  onClear: () => void
}) {
  const preview = selectionPreview(props.selection.quote)
  return (
    <div className={styles.dock} data-qingagent-selection-dock>
      <div className={styles.chip} data-qingagent-selection-chip title={props.selection.quote}>
        <span className={styles.label}>✎ 选段:「{preview}」</span>
        <button
          className={styles.clear}
          type="button"
          aria-label="清除青简选段"
          onClick={props.onClear}
        >×</button>
      </div>
    </div>
  )
}

export function selectionPreview(quote: string): string {
  return quote.length > 20 ? `${quote.slice(0, 20)}…` : quote
}
