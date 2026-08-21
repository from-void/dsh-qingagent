import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
export { FRESH_DRAFT_REQUIRED_ERROR, FULL_DRAFT_REQUIRED_ERROR } from './userVisibleText.js';
export type DraftReadMode = 'outline' | 'full' | 'base' | 'lines' | 'blocks';
export interface DocStateSnapshot {
    state: string;
    words: number;
    blocks: number;
    structure: string;
    title: string;
    docVersion: number;
    patchCount?: number;
    dirty: boolean;
}
export declare const DOC_STATE_STALE_LINE = "\u3010\u6587\u7A3F\u72B6\u6001\u3011\u5C1A\u672A\u5237\u65B0\uFF1B\u56DE\u7B54\u5B57\u6570\u3001\u7ED3\u6784\u6216\u72B6\u6001\u524D\uFF0C\u5148\u8C03\u7528 qing_read_draft \u8BFB\u53D6\u5F53\u524D\u6587\u7A3F\u3002";
/** 所有工具返回与运行时注入共用同一套用户可理解的状态措辞。 */
export declare function docStateLine(state: string, patchCount?: number): string;
/** 只包含状态、标题、结构和字数，绝不携带正文或内部文稿标识。 */
export declare function formatDocState(snapshot: DocStateSnapshot): string;
export declare class DocStateCache {
    private readonly states;
    get(sessionId: string): DocStateSnapshot | undefined;
    update(sessionId: string, snapshot: Omit<DocStateSnapshot, 'dirty'>): DocStateSnapshot;
    markDirty(sessionId: string): void;
    needsRefresh(sessionId: string): boolean;
    contextText(sessionId: string): string;
    dispose(sessionId: string): void;
}
/** 与 agent/pre-step 的 turn 及文稿租约段绑定；A 稿的读取不能让 B 稿越过写前新鲜度门。 */
export declare class FreshnessTracker {
    private readonly turns;
    private readonly documents;
    begin(sessionId: string, turn: number): void;
    resetSegment(sessionId: string, engineSessionId: string, generation: number): void;
    markFresh(exec: ToolRunContext, engineSessionId: string, generation?: number): void;
    markRead(exec: ToolRunContext, engineSessionId: string, mode: DraftReadMode, generation?: number): void;
    markAgentWritten(exec: ToolRunContext, engineSessionId: string, generation?: number): void;
    assertFresh(exec: ToolRunContext, engineSessionId: string, generation?: number): void;
    assertWholeDraftReady(exec: ToolRunContext, engineSessionId: string, generation?: number): void;
    dispose(sessionId: string): void;
    private updateMarker;
}
/** Prompt scope 是 opaque identity，必须用 Agent 对象本身做 WeakMap key。 */
export declare class AgentIndex {
    private readonly sessions;
    add(agent: Agent): void;
    get(scope: object): Agent['id'] | undefined;
    delete(agent: Agent): void;
}
export declare function injectDocState(agent: Agent | undefined, text: string): void;
//# sourceMappingURL=docState.d.ts.map