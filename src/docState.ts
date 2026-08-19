import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FRESH_DRAFT_REQUIRED_ERROR, sanitizeUserVisibleText } from './userVisibleText.js'

export { FRESH_DRAFT_REQUIRED_ERROR } from './userVisibleText.js'

export interface DocStateSnapshot {
  state: string
  words: number
  blocks: number
  structure: string
  title: string
  docVersion: number
  patchCount?: number
  dirty: boolean
}

export const DOC_STATE_STALE_LINE = '【文稿状态】尚未刷新；回答字数、结构或状态前，先调用 qing_read_draft 读取当前文稿。'

/** 所有工具返回与运行时注入共用同一套用户可理解的状态措辞。 */
export function docStateLine(state: string, patchCount?: number): string {
  return state === 'pendingReview'
    ? `【文稿状态】审阅中·${patchCount !== undefined ? `${patchCount} 处` : ''}待用户裁决。`
    : '【文稿状态】已落库生效,无待审稿。'
}

/** 只包含状态、标题、结构和字数，绝不携带正文或内部文稿标识。 */
export function formatDocState(snapshot: DocStateSnapshot): string {
  return `${docStateLine(snapshot.state, snapshot.patchCount)}\n《${snapshot.title}》｜${sanitizeUserVisibleText(snapshot.structure)}｜约 ${snapshot.words} 字`
}

export class DocStateCache {
  private readonly states = new Map<string, DocStateSnapshot>()

  get(sessionId: string): DocStateSnapshot | undefined {
    return this.states.get(sessionId)
  }

  update(sessionId: string, snapshot: Omit<DocStateSnapshot, 'dirty'>): DocStateSnapshot {
    const current = { ...snapshot, dirty: false }
    this.states.set(sessionId, current)
    return current
  }

  markDirty(sessionId: string): void {
    const current = this.states.get(sessionId)
    if (current) this.states.set(sessionId, { ...current, dirty: true })
  }

  needsRefresh(sessionId: string): boolean {
    return this.states.get(sessionId)?.dirty !== false
  }

  contextText(sessionId: string): string {
    const current = this.states.get(sessionId)
    return !current || current.dirty ? DOC_STATE_STALE_LINE : formatDocState(current)
  }

  dispose(sessionId: string): void {
    this.states.delete(sessionId)
  }
}

/** 与 agent/pre-step 的 turn 编号绑定；同一回合后续 step 保留 fresh。 */
export class FreshnessTracker {
  private readonly turns = new Map<string, number>()
  private readonly fresh = new Set<string>()

  begin(sessionId: string, turn: number): void {
    if (this.turns.get(sessionId) === turn) return
    this.turns.set(sessionId, turn)
    this.fresh.delete(sessionId)
  }

  markFresh(exec: ToolRunContext): void {
    this.fresh.add(sessionIdOf(exec))
  }

  assertFresh(exec: ToolRunContext): void {
    const sessionId = sessionIdOf(exec)
    // 独立工具测试没有 agent loop 的 pre-step；真机每回合必先 begin。
    if (this.turns.has(sessionId) && !this.fresh.has(sessionId)) {
      throw new Error(FRESH_DRAFT_REQUIRED_ERROR)
    }
  }

  dispose(sessionId: string): void {
    this.turns.delete(sessionId)
    this.fresh.delete(sessionId)
  }
}

/** Prompt scope 是 opaque identity，必须用 Agent 对象本身做 WeakMap key。 */
export class AgentIndex {
  private readonly sessions = new WeakMap<object, Agent['id']>()

  add(agent: Agent): void {
    this.sessions.set(agent, agent.id)
  }

  get(scope: object): Agent['id'] | undefined {
    return this.sessions.get(scope)
  }

  delete(agent: Agent): void {
    this.sessions.delete(agent)
  }
}

/**
 * 上次注入过的状态行,按 agent 记。内容没变就不再注入——DSH 的 runtimeContext.project()
 * 对同名快照就是这个口径(`if (this.retained?.text === snapshot) return`),我们没理由更啰嗦。
 * 注入是**追加到消息末尾**、不改前缀,所以这里省的是冗余 token,不是缓存命中率。
 */
const lastInjected = new WeakMap<Agent, string>()

export function injectDocState(agent: Agent | undefined, text: string): void {
  if (!agent || typeof agent.inject !== 'function') return
  if (lastInjected.get(agent) === text) return
  lastInjected.set(agent, text)
  agent.inject(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-qingagent' },
  }))
}

function sessionIdOf(exec: ToolRunContext): string {
  if (!exec.agent) throw new Error('此工具必须在 DSH 会话中调用。')
  return String(exec.agent.id)
}
