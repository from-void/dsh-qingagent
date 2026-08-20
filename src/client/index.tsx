import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { createScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { QingDocPanel } from './QingDocPanel.js'
import { QingWriteToolCard } from './QingWriteToolCard.js'
import {
  QingAnnotateToolCard,
  QingEditToolCard,
  QingFocusToolCard,
  QingListDocsToolCard,
  QingReadToolCard,
  QingReviewCommitToolCard,
} from './QingToolCard.js'
import { qingClientStore } from './store.js'
import {
  insertSelectionReference,
  QING_SELECTION_REFERENCE_SOURCE,
  qingSelectionReferenceSource,
  selectionReferenceText,
} from './selectionReference.js'
import {
  insertAnnotationReference,
  qingAnnotationReferenceSource,
  removeOccurrenceFromDraft,
  replaceOccurrenceRef,
} from './annotationReference.js'
import { installChipPresentation, type InputState as ChipInputState } from './chipPresentation.js'
import { installSelectionBubbleDecor } from './selectionBubbleDecor.js'
import { markPanelOpenSource } from './telemetry.js'

export const name = 'dsh-qingagent-client'
export const inject = ['slots', 'layout', 'sessions', 'conversation', 'inputTriggers']

// P26:会话名条件跟随纸面标题。记录插件上次写入的会话名;一旦用户手动改名(当前名≠上次
// 写入值)即永久脱离跟随,绝不覆盖用户命名。localStorage 持久化,跨 tab/重载一致。
const SYNCED_TITLE_PREFIX = 'qingagent.syncedSessionTitle.'

function readSyncedTitle(sessionId: string): string | undefined {
  try {
    return window.localStorage.getItem(SYNCED_TITLE_PREFIX + sessionId) ?? undefined
  } catch {
    return undefined
  }
}

function writeSyncedTitle(sessionId: string, title: string): void {
  try {
    window.localStorage.setItem(SYNCED_TITLE_PREFIX + sessionId, title)
  } catch {
    // 存储不可用时本次会话内仍靠内存值跟随。
  }
}

export function apply(ctx: ClientContext): void {
  // Cordis 的 get() 在类型上允许服务未就绪；本插件的 inject 已把三者声明为启动前置。
  const slots = ctx.get('slots')!
  const layout = ctx.get('layout')!
  const sessions = ctx.get('sessions') as unknown as ISessions
  const inputTriggers = ctx.get('inputTriggers')!

  // chip 提交必须能按 source 找回 codec；owner 缺失时 dsh 会阻止发送而不会降级成
  // clipboardText，因此 source 与选段 bridge 同属插件生命周期。
  ctx.effect(() => inputTriggers.registerSource(qingSelectionReferenceSource))
  // 批注采纳 chip 与选段 chip 同生命周期:codec 恒等展开完整修改指令。
  ctx.effect(() => inputTriggers.registerSource(qingAnnotationReferenceSource))
  // 发送气泡里的 [选段] 段落样式化(宿主消息渲染无槽位,DOM 装饰器随插件生命周期)。
  ctx.effect(() => installSelectionBubbleDecor())

  slots.inject('details', () => {
    let currentSessionId: string | undefined
    let disposePanel: (() => void) | undefined
    let releaseSession: (() => void) | undefined
    let unsubscribeStore: (() => void) | undefined
    let selectionScope: ReturnType<typeof createScope> | undefined
    let unsubscribeInput: (() => void) | undefined
    let pendingSelectionKey: string | undefined
    // bail 同步发布 input state 引发的重入窗口内一律短路(occurrence 尚未可见,不能据其放行)。
    let selectionInsertInFlight = false

    // 值键而非对象引用:bridge 状态重放会产出新对象,引用比较挡不住同一选段重触发(实测双 chip)。
    const selectionKey = (s: NonNullable<ReturnType<typeof qingClientStore.getSnapshot>['selection']>) =>
      `${s.engineSessionId}|${s.anchor.blockId}|${s.anchor.from}|${s.anchor.to}|${s.quote}`

    const syncSelectionReference = () => {
      const sessionId = currentSessionId
      const selection = sessionId
        ? qingClientStore.getSnapshot(sessionId).selection
        : undefined
      if (!sessionId || !selection || !selectionScope) return
      const key = selectionKey(selection)
      const snapshot = qingClientStore.getSnapshot(sessionId)
      const activeTitle = snapshot.activeEngineSessionId === selection.engineSessionId
        ? snapshot.activeDoc?.title
        : undefined
      const title = activeTitle ?? snapshot.state?.binding.docs.find(
        (doc) => doc.engineSessionId === selection.engineSessionId,
      )?.title
      if (key === pendingSelectionKey) {
        if (selectionInsertInFlight) return
        // 哨兵只防 bridge 重放双触发;chip 被用户移除(occurrence 已不在草稿)后,同一选段
        // 必须放行重插,否则「移除后无法再次引用」(评测 S3-R1-06)。
        const ref = selectionReferenceText(selection, title)
        const occurrences = selectionScope.ctx.conversation.input.for(selectionScope.ctx)
          .state.getSnapshot().occurrences
        const stillPresent = occurrences?.some((occurrence) =>
          occurrence.source === QING_SELECTION_REFERENCE_SOURCE && occurrence.ref === ref)
        if (stillPresent) return
        pendingSelectionKey = undefined
      }

      // 先设重入哨兵：bail 同步发布 input state，state subscriber 会在事件返回前回调。
      pendingSelectionKey = key
      selectionInsertInFlight = true
      let inserted = false
      try {
        inserted = insertSelectionReference(selectionScope.ctx, selection, title)
      } finally {
        selectionInsertInFlight = false
      }
      if (!inserted) {
        // adjudicating/submitting 等瞬态会拒绝插入；保留 bridge selection，等待 input
        // phase 或 store 下一次发布后重试。
        pendingSelectionKey = undefined
        return
      }

      // bridge selection 只是 ingress 单槽；成功铸成 composer occurrence 后立即清掉。
      // 这样用户删除原生 chip 就确实放弃该选段，后端动态提示也不会残留。
      void qingClientStore.clearSelection(sessionId).catch((error) => {
        console.warn('[qingagent] 清理已插入的选段 bridge 状态失败', error)
      })
    }

    const syncPanelRegistration = () => {
      const shouldRegister = currentSessionId !== undefined && qingClientStore.hasPanelContent(currentSessionId)
      if (shouldRegister && !disposePanel) {
        const shouldAutoOpen = currentSessionId !== undefined
          && qingClientStore.getSnapshot(currentSessionId).state?.engine.state !== 'online'
        if (shouldAutoOpen && currentSessionId) markPanelOpenSource(currentSessionId, 'auto')
        disposePanel = slots.register({
          name: 'details',
          priority: -10,
          inject: () => ({
            qingLayout: layout,
            // 审查按钮闭环:把组装好的审查 query 作为用户消息发进对应 dsh 会话(排队一轮)。
            qingSendMessage: async (dshSessionId: string, text: string) => {
              // conversation 是作用域寻址服务:sessions.scope() 返回的 AgentContext 挂在运行时
              // 根 fiber 下,不带本插件的 inject 声明会被 cordis 拒绝。用本插件 ctx 铸造同
              // 会话标签的临时作用域,属性链访问即携带 inject 与会话寻址。
              const handle = createScope(
                ctx as unknown as Parameters<typeof createScope>[0],
                dshSessionId as Parameters<typeof createScope>[1],
              )
              try {
                await (handle.ctx as unknown as { conversation: { send(text: string): Promise<void> } })
                  .conversation.send(text)
              } finally {
                handle.fiber.dispose()
              }
            },
            // 批注采纳:把完整修改指令铸成输入框 chip(不代发,发送权在用户)。
            qingInsertAnnotation: (instruction: string) => {
              const sessionId = currentSessionId
              if (!sessionId) return false
              const handle = createScope(
                ctx as unknown as Parameters<typeof createScope>[0],
                sessionId as Parameters<typeof createScope>[1],
              )
              try {
                return insertAnnotationReference(
                  handle.ctx as unknown as Parameters<typeof insertAnnotationReference>[0],
                  instruction,
                )
              } finally {
                handle.fiber.dispose()
              }
            },
          }),
        }, QingDocPanel)
        if (shouldAutoOpen) layout.openDetails()
      } else if (!shouldRegister && disposePanel) {
        disposePanel()
        disposePanel = undefined
      }
    }

    let renameInFlight = false
    const syncSessionTitle = () => {
      const sessionId = currentSessionId
      if (!sessionId || renameInFlight) return
      const docTitle = qingClientStore.getSnapshot(sessionId).activeDoc?.title?.trim()
      if (!docTitle) return
      const list = sessions.list.getSnapshot()
      const row = list.byId[sessionId as keyof typeof list.byId]
      if (!row || row.displayTitle === docTitle) return
      const lastSynced = readSyncedTitle(sessionId)
      // 跟随条件:此前一直由插件跟随(当前名===上次写入),或从未同步过(首稿即接管自动名)。
      // 用户手动改过名(当前名≠上次写入)则永久脱离,不覆盖。
      if (lastSynced !== undefined && row.displayTitle !== lastSynced) return
      const binding = sessions.binding(sessionId as Parameters<typeof sessions.binding>[0]) as
        | { session?: { rename(title: string): Promise<unknown> } }
        | undefined
      if (!binding?.session) return
      renameInFlight = true
      void binding.session.rename(docTitle)
        .then(() => writeSyncedTitle(sessionId, docTitle))
        .catch((error) => console.warn('[qingagent] 会话名跟随失败', error))
        .finally(() => {
          renameInFlight = false
        })
    }

    const syncCurrentSession = () => {
      const nextSessionId = sessions.list.getSnapshot().current
      if (nextSessionId === currentSessionId) return
      unsubscribeStore?.()
      unsubscribeInput?.()
      selectionScope?.fiber.dispose()
      releaseSession?.()
      disposePanel?.()
      unsubscribeStore = undefined
      unsubscribeInput = undefined
      selectionScope = undefined
      releaseSession = undefined
      disposePanel = undefined
      pendingSelectionKey = undefined
      currentSessionId = nextSessionId === undefined ? undefined : String(nextSessionId)
      if (currentSessionId) {
        unsubscribeStore = qingClientStore.subscribe(currentSessionId, () => {
          syncPanelRegistration()
          syncSessionTitle()
          syncSelectionReference()
        })
        releaseSession = qingClientStore.retain(currentSessionId)
        selectionScope = createScope(
          ctx as unknown as Parameters<typeof createScope>[0],
          currentSessionId as Parameters<typeof createScope>[1],
        )
        const inputFacade = selectionScope.ctx.conversation.input.for(selectionScope.ctx)
        const inputState = inputFacade.state
        const unsubscribeState = inputState.subscribe(syncSelectionReference)
        // chip 呈现层:打标+药丸样式+hover 面板+移除角标(布局零影响,详见 chipPresentation)。
        const scopeCtx = selectionScope.ctx
        const uninstallChips = installChipPresentation({
          getInputState: () => inputState.getSnapshot() as unknown as ChipInputState | undefined,
          subscribeInputState: (listener) => inputState.subscribe(listener),
          removeOccurrence: (occurrenceId) => removeOccurrenceFromDraft(
            scopeCtx as unknown as Parameters<typeof removeOccurrenceFromDraft>[0],
            occurrenceId,
          ),
          replaceOccurrenceRef: (occurrenceId, newRef) => replaceOccurrenceRef(
            scopeCtx as unknown as Parameters<typeof replaceOccurrenceRef>[0],
            occurrenceId,
            newRef,
          ),
          onToast: (text) => {
            (inputFacade as unknown as { notify(level: 'info' | 'error', text: string): void })
              .notify('error', text)
          },
          getDocTitle: () => {
            const id = currentSessionId
            return id ? qingClientStore.getSnapshot(id).activeDoc?.title ?? undefined : undefined
          },
        })
        unsubscribeInput = () => {
          unsubscribeState()
          uninstallChips()
        }
      }
      syncPanelRegistration()
      syncSelectionReference()
    }

    const unsubscribeSessions = sessions.list.subscribe(syncCurrentSession)
    syncCurrentSession()
    return () => {
      unsubscribeSessions()
      unsubscribeStore?.()
      unsubscribeInput?.()
      selectionScope?.fiber.dispose()
      releaseSession?.()
      disposePanel?.()
    }
  })

  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'qing_write_draft',
    inject: () => ({ qingLayout: layout }),
  }, QingWriteToolCard))

  // #23 具名状态卡:全部 qing 工具都有自己的名字与状态摘要,不落到通用卡。
  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'qing_edit_draft',
    inject: () => ({ qingLayout: layout }),
  }, QingEditToolCard))
  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'qing_review_commit',
    inject: () => ({ qingLayout: layout }),
  }, QingReviewCommitToolCard))
  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'qing_annotate',
    inject: () => ({ qingLayout: layout }),
  }, QingAnnotateToolCard))
  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'qing_read_draft',
    inject: () => ({ qingLayout: layout }),
  }, QingReadToolCard))
  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'qing_list_docs',
    inject: () => ({ qingLayout: layout }),
  }, QingListDocsToolCard))
  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'qing_focus_doc',
    inject: () => ({ qingLayout: layout }),
  }, QingFocusToolCard))
}
