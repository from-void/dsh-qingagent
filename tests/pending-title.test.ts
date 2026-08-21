import { describe, expect, it, vi } from 'vitest'
import type { BindingStore } from '../src/bindings.js'
import type { ExternalDoc } from '../src/contracts.js'
import type { EngineService } from '../src/engine.js'
import { PendingTitleCoordinator } from '../src/pendingTitle.js'

function doc(overrides: Partial<ExternalDoc> = {}): ExternalDoc {
  return {
    sessionId: 'qing-1',
    docVersion: 4,
    state: 'editing',
    agentBusy: false,
    markdown: '# 新标题\n\n正文',
    qingml: '<h1>新标题</h1><p>正文</p>',
    title: '旧标题',
    ...overrides,
  }
}

function fixture(reads: ExternalDoc[]) {
  const queue = [...reads]
  let appliedTitle: string | undefined
  const engine = {
    fetchJson: vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/doc?format=qingml')) {
        const value = queue.shift() ?? reads.at(-1)!
        return appliedTitle ? { ...value, title: appliedTitle } : value
      }
      if (path.endsWith('/proposals')) {
        const body = JSON.parse(String(init?.body)) as { ops?: Array<{ kind: string; title?: string }> }
        appliedTitle = body.ops?.find((op) => op.kind === 'setTitle')?.title
        return { status: 'committed', docVersion: reads.at(-1)?.docVersion ?? 4 }
      }
      throw new Error(`unexpected path: ${path}`)
    }),
  } as unknown as EngineService
  const bindings = {
    updateTitle: vi.fn(async () => undefined),
  } as unknown as BindingStore
  return { coordinator: new PendingTitleCoordinator(engine, bindings), engine, bindings }
}

function proposalBodies(engine: EngineService): Array<Record<string, unknown>> {
  return vi.mocked(engine.fetchJson).mock.calls.flatMap(([path, init]) =>
    String(path).endsWith('/proposals') ? [JSON.parse(String(init?.body)) as Record<string, unknown>] : [])
}

describe('PendingTitleCoordinator', () => {
  it('accept 后按生效 H1 补发 setTitle，走 titleOp 钉住通道且重入不双发', async () => {
    const { coordinator, engine, bindings } = fixture([doc({ qingml: '<h1>新 标题</h1><p>正文</p>' })])
    coordinator.deferTitle('dsh-1', 'qing-1', '新标题')

    const [first, second] = await Promise.all([
      coordinator.settlePendingTitle('dsh-1', 'qing-1'),
      coordinator.settlePendingTitle('dsh-1', 'qing-1'),
    ])

    expect(first).toBe('applied')
    expect(second).toBe('applied')
    expect(proposalBodies(engine)).toEqual([expect.objectContaining({
      expectedDocVersion: 4,
      ops: [{ kind: 'setTitle', title: '新标题' }],
    })])
    expect(bindings.updateTitle).toHaveBeenCalledWith('dsh-1', 'qing-1', '新标题')
    await expect(coordinator.settlePendingTitle('dsh-1', 'qing-1')).resolves.toBe('none')
    expect(proposalBodies(engine)).toHaveLength(1)
  })

  it('reject 后生效 H1 未对齐则丢弃，不补发且无标题残留', async () => {
    const { coordinator, engine, bindings } = fixture([
      doc({ qingml: '<h1>旧标题</h1><p>正文</p>', title: '旧标题' }),
    ])
    coordinator.deferTitle('dsh-1', 'qing-1', '新标题')

    await expect(coordinator.settlePendingTitle('dsh-1', 'qing-1')).resolves.toBe('discarded')

    expect(proposalBodies(engine)).toHaveLength(0)
    expect(bindings.updateTitle).not.toHaveBeenCalled()
    expect(coordinator.hasPendingTitle('dsh-1', 'qing-1')).toBe(false)
  })

  it('部分裁决期间保留，全部结算后 H1 不一致即丢弃', async () => {
    const { coordinator, engine } = fixture([
      doc({ state: 'pendingReview', qingml: '<h1>旧标题</h1><p>候选正文</p>' }),
      doc({ state: 'editing', qingml: '<h1>用户另改标题</h1><p>正文</p>' }),
    ])
    coordinator.deferTitle('dsh-1', 'qing-1', '新标题')

    await expect(coordinator.settlePendingTitle('dsh-1', 'qing-1')).resolves.toBe('pending-review')
    expect(coordinator.hasPendingTitle('dsh-1', 'qing-1')).toBe(true)
    await expect(coordinator.settlePendingTitle('dsh-1', 'qing-1')).resolves.toBe('discarded')

    expect(proposalBodies(engine)).toHaveLength(0)
    expect(coordinator.hasPendingTitle('dsh-1', 'qing-1')).toBe(false)
  })

  it('一稿一槽由新记录覆盖，整稿/删除清理接口不跨稿残留', async () => {
    const { coordinator, engine } = fixture([doc()])
    coordinator.deferTitle('dsh-1', 'qing-1', '过期标题')
    coordinator.deferTitle('dsh-1', 'qing-1', '新标题')
    await expect(coordinator.settlePendingTitle('dsh-1', 'qing-1')).resolves.toBe('applied')
    expect(proposalBodies(engine)[0]).toMatchObject({ ops: [{ kind: 'setTitle', title: '新标题' }] })

    coordinator.deferTitle('dsh-1', 'qing-1', '待清理')
    coordinator.clearDocument('dsh-1', 'qing-1')
    expect(coordinator.hasPendingTitle('dsh-1', 'qing-1')).toBe(false)
    coordinator.deferTitle('dsh-1', 'qing-2', '待释放')
    coordinator.clearSession('dsh-1')
    expect(coordinator.hasPendingTitle('dsh-1', 'qing-2')).toBe(false)
  })
})
