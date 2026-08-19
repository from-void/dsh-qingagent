import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  AgentIndex,
  DOC_STATE_STALE_LINE,
  DocStateCache,
  FreshnessTracker,
  formatDocState,
  injectDocState,
} from '../src/docState.js'

describe('DocStateCache', () => {
  it('只注入标题、结构、字数与用户可理解状态，不泄露正文和内部标识', () => {
    const cache = new DocStateCache()
    const snapshot = cache.update('dsh-1', {
      state: 'editing',
      words: 5824,
      blocks: 12,
      structure: '3 章 12 块',
      title: '年度报告',
      docVersion: 9,
    })

    const text = formatDocState(snapshot)
    expect(text).toBe('【文稿状态】已落库生效,无待审稿。\n《年度报告》｜3 章 12 项内容｜约 5824 字')
    expect(text).not.toContain('块')
    expect(text).not.toMatch(/pendingReview|docRef|blockId|qing-1|docVersion|正文内容/u)
    expect(cache.contextText('dsh-1')).toBe(text)
  })

  it('dirty 或未知时输出可判定的先读稿信号，刷新后恢复摘要', () => {
    const cache = new DocStateCache()
    expect(cache.contextText('unknown')).toBe(DOC_STATE_STALE_LINE)
    cache.update('dsh-1', {
      state: 'pendingReview',
      words: 20,
      blocks: 2,
      structure: '一个标题加 1 段正文',
      title: '待审稿',
      docVersion: 3,
      patchCount: 2,
    })
    cache.markDirty('dsh-1')
    expect(cache.contextText('dsh-1')).toBe(DOC_STATE_STALE_LINE)
    expect(DOC_STATE_STALE_LINE).toContain('qing_read_draft')
  })

  it('AgentIndex 按对象 identity 查 scope，inject 推送一条 model-facing 状态消息', () => {
    const inject = vi.fn()
    const agent = { id: 'dsh-1', inject } as unknown as Agent
    const other = { id: 'dsh-1' } as unknown as Agent
    const index = new AgentIndex()
    index.add(agent)

    expect(String(index.get(agent))).toBe('dsh-1')
    expect(index.get(other)).toBeUndefined()
    injectDocState(agent, '【文稿状态】已落库生效,无待审稿。')
    expect(inject).toHaveBeenCalledOnce()
    expect(inject.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-qingagent' },
      content: [{ type: 'text', text: '【文稿状态】已落库生效,无待审稿。' }],
    })
  })

  // 注入是追加到消息末尾、不改前缀,所以重复注入不会掉缓存命中率,但会白占 token。
  // 与 DSH runtimeContext.project() 同口径:内容相同就不发。
  it('同一 agent 上重复注入相同状态只发一次,内容变了才再发', () => {
    const inject = vi.fn()
    const agent = { id: 'dsh-2', inject } as unknown as Agent
    const same = '【文稿状态】已落库生效,无待审稿。'

    injectDocState(agent, same)
    injectDocState(agent, same)
    injectDocState(agent, same)
    expect(inject).toHaveBeenCalledOnce()

    injectDocState(agent, '【文稿状态】有 3 处待裁决。')
    expect(inject).toHaveBeenCalledTimes(2)

    // 变回原文本也算变化,应当再发一次(否则模型会停留在旧状态)
    injectDocState(agent, same)
    expect(inject).toHaveBeenCalledTimes(3)
  })
})

describe('FreshnessTracker 文稿维度', () => {
  it('读 A 不能让编辑 B 过闸，新 generation 不复用旧 fresh 标记', () => {
    const tracker = new FreshnessTracker()
    const exec = { agent: { id: 'dsh-1' } } as unknown as ToolRunContext
    tracker.begin('dsh-1', 1)
    tracker.resetSegment('dsh-1', 'doc-a', 10)
    tracker.resetSegment('dsh-1', 'doc-b', 11)
    tracker.markFresh(exec, 'doc-a', 10)

    expect(() => tracker.assertFresh(exec, 'doc-a', 10)).not.toThrow()
    expect(() => tracker.assertFresh(exec, 'doc-b', 11)).toThrow('qing_read_draft')

    tracker.resetSegment('dsh-1', 'doc-a', 12)
    expect(() => tracker.assertFresh(exec, 'doc-a', 12)).toThrow('qing_read_draft')
  })
})
