import type { ReactNode } from 'react'

export interface ConfirmOptions {
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'affirm'
  subject?: string
  footHint?: string
}

let toastSequence = 0

export function useToast() {
  return {
    show(input: string | { message: string }): string {
      const message = typeof input === 'string' ? input : input.message
      window.dispatchEvent(new CustomEvent('qingagent:panel-toast', { detail: message }))
      return `qingdoc-toast-${++toastSequence}`
    },
    dismiss(): void {},
  }
}

export function useConfirm() {
  return async (options: ConfirmOptions): Promise<boolean> =>
    window.confirm(`${options.title}\n\n${String(options.message)}`)
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}
