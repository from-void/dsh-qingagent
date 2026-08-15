// 测试桩:真模块顶层依赖 window.__ModuleLoader__,测试环境不可得。
export function createScope(_ctx: unknown, _key: unknown) {
  return {
    ctx: { conversation: { send: async () => undefined } },
    fiber: { dispose: () => undefined },
  }
}
export type ClientContext = unknown
export type ISessions = unknown
