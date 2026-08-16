// 测试桩:真模块顶层依赖 window.__ModuleLoader__,测试环境不可得。
export function createScope(ctx: unknown, key: unknown) {
  const custom = (ctx as { __createScope?: (sessionId: unknown) => unknown }).__createScope
  if (custom) return custom(key)
  const state = {
    getSnapshot: () => ({ draft: '', draftRev: 0 }),
    subscribe: () => () => undefined,
  }
  const scopedCtx = {
    bail: () => undefined,
    conversation: {
      input: { for: () => ({ state }) },
      send: async () => undefined,
    },
  }
  return {
    ctx: scopedCtx,
    fiber: { dispose: () => undefined },
  }
}
export type ClientContext = unknown
export type ISessions = unknown
