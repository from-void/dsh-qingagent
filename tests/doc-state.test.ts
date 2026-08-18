import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AgentIndex,
  DOC_STATE_STALE_LINE,
  DocStateCache,
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
    expect(text).toBe('【文稿状态】已落库生效,无待审稿。\n《年度报告》｜3 章 12 块｜约 5824 字')
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
})
