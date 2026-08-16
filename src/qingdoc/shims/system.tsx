// 确认层直接复用青简产品的 ConfirmProvider；WholeDocReviewNav 的 useConfirm
// 通过本 shim 与面板外层 Provider 共享同一个 Symbol.for context。
export { ConfirmProvider, useConfirm } from '@qingweb/system/ConfirmProvider'
export type { ConfirmOptions } from '@qingweb/system/ConfirmProvider'

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
