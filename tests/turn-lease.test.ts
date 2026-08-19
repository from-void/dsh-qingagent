import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentTurnLeaseCoordinator,
  LEASE_BUSY_NATIVE_ERROR,
  LEASE_LOST_ERROR,
  LEASE_UNSUPPORTED_ERROR,
} from '../src/bridge.js'
import { EngineHttpError, type EngineService } from '../src/engine.js'

function error(status: number, code?: string): EngineHttpError {
  return new EngineHttpError(status, { error: code ?? 'failed', ...(code ? { code } : {}) })
}

function fixture(responses: Array<unknown | Error> = []) {
  const fetchTurnSignal = vi.fn(async (_path: string, body: unknown) => {
    const queued = responses.shift()
    if (queued instanceof Error) throw queued
    if (queued !== undefined) return queued
    return { active: (body as { action: string }).action !== 'end' }
  })
  const engine = { fetchTurnSignal } as unknown as EngineService
  const opened: Array<[string, string, number]> = []
  const closed: Array<[string, string[]]> = []
  const coordinator = new AgentTurnLeaseCoordinator(
    engine,
    10,
    (() => { let id = 0; return () => `turn-${++id}` })(),
    (dshSessionId, engineSessionId, generation) => opened.push([dshSessionId, engineSessionId, generation]),
    (dshSessionId, engineSessionIds) => closed.push([dshSessionId, engineSessionIds]),
  )
  return { coordinator, fetchTurnSignal, opened, closed }
}

function actions(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map(([, body]) => (body as { action: string }).action)
}

afterEach(() => vi.useRealTimers())

describe('AgentTurnLeaseCoordinator F3+H2 迁移表', () => {
  it('2xx active:true 进 acquired，失效 turnId 错误进 lost 且本段不复位', async () => {
    const { coordinator, fetchTurnSignal } = fixture()
    await coordinator.openTurn('dsh', 1, 'doc-a')
    expect(coordinator.state('dsh', 'doc-a')).toBe('acquired')

    coordinator.recordWriteFailure('dsh', 'doc-a', error(409, 'LOCK_LOST'))
    expect(coordinator.state('dsh', 'doc-a')).toBe('lost')
    await expect(coordinator.touchDocument('dsh', 'doc-a')).rejects.toThrow(LEASE_LOST_ERROR)
    expect(actions(fetchTurnSignal)).toEqual(['begin'])
  })

  it('cold begin 的 BUSY_NATIVE 间隔 2s 有界重试两次，仍忙则本回合放弃写', async () => {
    vi.useFakeTimers()
    const { coordinator, fetchTurnSignal } = fixture([
      error(409, 'BUSY_NATIVE'),
      error(409, 'BUSY_NATIVE'),
      error(409, 'BUSY_NATIVE'),
    ])
    const opening = coordinator.openTurn('dsh', 1, 'doc-a')
    await vi.advanceTimersByTimeAsync(4_000)
    await opening
    expect(actions(fetchTurnSignal)).toEqual(['begin', 'begin', 'begin'])
    await expect(coordinator.touchDocument('dsh', 'doc-a')).rejects.toThrow(LEASE_BUSY_NATIVE_ERROR)
  })

  it.each([
    ['LEASE_HELD', 'lost', LEASE_LOST_ERROR],
    ['LOCK_LOST', 'lost', LEASE_LOST_ERROR],
  ] as const)('cold begin %s 进 %s', async (code, expectedState, message) => {
    const { coordinator } = fixture([error(409, code)])
    await coordinator.openTurn('dsh', 1, 'doc-a')
    expect(coordinator.state('dsh', 'doc-a')).toBe(expectedState)
    await expect(coordinator.touchDocument('dsh', 'doc-a')).rejects.toThrow(message)
  })

  it('404 路由不存在进 unsupported，SESSION_NOT_FOUND 保留既有会话失效错误', async () => {
    const unsupported = fixture([error(404)])
    await unsupported.coordinator.openTurn('dsh', 1, 'doc-a')
    expect(unsupported.coordinator.state('dsh', 'doc-a')).toBe('unsupported')
    await expect(unsupported.coordinator.touchDocument('dsh', 'doc-a')).rejects.toThrow(LEASE_UNSUPPORTED_ERROR)
    await expect(unsupported.coordinator.touchDocument('dsh', 'doc-a')).rejects.not.toThrow('请升级客户端')

    const missing = fixture([error(404, 'SESSION_NOT_FOUND')])
    await missing.coordinator.openTurn('dsh', 1, 'doc-a')
    await expect(missing.coordinator.touchDocument('dsh', 'doc-a')).rejects.toThrow('青简会话不存在')
  })

  it('401/鉴权失效进 lost 并给出重连引导', async () => {
    const { coordinator } = fixture([error(401)])
    await coordinator.openTurn('dsh', 1, 'doc-a')
    expect(coordinator.state('dsh', 'doc-a')).toBe('lost')
    await expect(coordinator.touchDocument('dsh', 'doc-a')).rejects.toThrow('请重新连接客户端')
  })

  it.each([
    ['429', error(429)],
    ['5xx', error(500)],
    ['timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
    ['响应丢失', new Error('socket closed')],
  ])('cold begin %s 进 unknown，同 turnId 消歧成功后 acquired', async (_label, failure) => {
    const { coordinator, fetchTurnSignal } = fixture([
      failure,
      { active: true },
    ])
    await coordinator.openTurn('dsh', 1, 'doc-a')
    expect(coordinator.state('dsh', 'doc-a')).toBe('acquired')
    const turnIds = fetchTurnSignal.mock.calls.map(([, body]) => (body as { turnId: string }).turnId)
    expect(turnIds).toEqual(['turn-1', 'turn-1'])
  })

  it('unknown 同 turnId 最多消歧两次，仍不明则 lost', async () => {
    const { coordinator, fetchTurnSignal } = fixture([error(500), error(429), error(500)])
    await coordinator.openTurn('dsh', 1, 'doc-a')
    expect(actions(fetchTurnSignal)).toEqual(['begin', 'begin', 'begin'])
    expect(coordinator.state('dsh', 'doc-a')).toBe('lost')
  })

  it('heartbeat active:false 走 recovery begin，recovery 遇 BUSY_NATIVE 直接 lost', async () => {
    vi.useFakeTimers()
    const { coordinator, fetchTurnSignal } = fixture([
      { active: true },
      { active: false },
      error(409, 'BUSY_NATIVE'),
    ])
    await coordinator.openTurn('dsh', 1, 'doc-a')
    await vi.advanceTimersByTimeAsync(10)
    expect(actions(fetchTurnSignal)).toEqual(['begin', 'heartbeat', 'begin'])
    expect(coordinator.state('dsh', 'doc-a')).toBe('lost')
  })

  it('heartbeat 瞬态失败下周期重试，连续 3 次后用同 turnId recovery begin', async () => {
    vi.useFakeTimers()
    const { coordinator, fetchTurnSignal } = fixture([
      { active: true },
      error(500),
      error(429),
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
      { active: true },
    ])
    await coordinator.openTurn('dsh', 1, 'doc-a')
    await vi.advanceTimersByTimeAsync(30)
    expect(actions(fetchTurnSignal)).toEqual(['begin', 'heartbeat', 'heartbeat', 'heartbeat', 'begin'])
    expect(coordinator.state('dsh', 'doc-a')).toBe('acquired')
    const turnIds = fetchTurnSignal.mock.calls.map(([, body]) => (body as { turnId: string }).turnId)
    expect(new Set(turnIds)).toEqual(new Set(['turn-1']))
  })

  it('proposal/review 的 BUSY_NATIVE、LEASE_HELD、LOCK_LOST 都停写，瞬态失败不重发', async () => {
    for (const failure of [
      error(409, 'BUSY_NATIVE'),
      error(409, 'LEASE_HELD'),
      error(409, 'LOCK_LOST'),
      error(500),
    ]) {
      const { coordinator, fetchTurnSignal } = fixture()
      await coordinator.openTurn('dsh', 1, 'doc-a')
      coordinator.recordWriteFailure('dsh', 'doc-a', failure)
      await expect(coordinator.touchDocument('dsh', 'doc-a')).rejects.toThrow()
      expect(actions(fetchTurnSignal)).toEqual(['begin'])
    }
  })

  it('proposal/review 的 404 也区分旧路由与 SESSION_NOT_FOUND', async () => {
    const unsupported = fixture()
    await unsupported.coordinator.openTurn('dsh', 1, 'doc-a')
    unsupported.coordinator.recordWriteFailure('dsh', 'doc-a', error(404))
    expect(unsupported.coordinator.state('dsh', 'doc-a')).toBe('unsupported')

    const missing = fixture()
    await missing.coordinator.openTurn('dsh', 1, 'doc-a')
    missing.coordinator.recordWriteFailure('dsh', 'doc-a', error(404, 'SESSION_NOT_FOUND'))
    expect(missing.coordinator.state('dsh', 'doc-a')).toBe('lost')
  })

  it('agent/error 不 end，后续步骤仍复用同段 acquired 租约', async () => {
    const { coordinator, fetchTurnSignal } = fixture()
    await coordinator.openTurn('dsh', 7, 'doc-a')
    coordinator.markAgentError('dsh', 7)
    await expect(coordinator.touchDocument('dsh', 'doc-a')).resolves.toBe('turn-1')
    expect(actions(fetchTurnSignal)).toEqual(['begin'])
  })

  it('agent/error 后的挂起期仍持续 heartbeat，直到显式 turn-stopping', async () => {
    vi.useFakeTimers()
    const { coordinator, fetchTurnSignal } = fixture()
    await coordinator.openTurn('dsh', 7, 'doc-a')
    coordinator.markAgentError('dsh', 7)

    await vi.advanceTimersByTimeAsync(20)
    expect(actions(fetchTurnSignal)).toEqual(['begin', 'heartbeat', 'heartbeat'])

    await coordinator.endTurn('dsh', 7)
    await vi.advanceTimersByTimeAsync(20)
    expect(actions(fetchTurnSignal)).toEqual(['begin', 'heartbeat', 'heartbeat', 'end'])
  })
})

describe('AgentTurnLeaseCoordinator 多文稿与段代际', () => {
  it('纯读只领 generation 不发 begin，后续写意图复用同一段', async () => {
    const { coordinator, fetchTurnSignal, opened } = fixture()
    await coordinator.openTurn('dsh', 1)
    const generation = coordinator.observeDocument('dsh', 'doc-b')
    expect(actions(fetchTurnSignal)).toEqual([])
    await coordinator.touchDocument('dsh', 'doc-b')
    expect(actions(fetchTurnSignal)).toEqual(['begin'])
    expect(coordinator.generation('dsh', 'doc-b')).toBe(generation)
    expect(opened).toHaveLength(1)
  })

  it('回合内默认目标钉扎，同 turn 重进 pre-step 不被面板新 focus 改写', async () => {
    const { coordinator } = fixture()
    await coordinator.openTurn('dsh', 1, 'doc-a')
    await coordinator.openTurn('dsh', 1, 'doc-b')
    expect(coordinator.pinnedDocument('dsh')).toBe('doc-a')
    await coordinator.endTurn('dsh', 1)
    await coordinator.openTurn('dsh', 2, 'doc-b')
    expect(coordinator.pinnedDocument('dsh')).toBe('doc-b')
  })

  it('同一 DSH 回合可同时持有多稿，end 并行发出', async () => {
    const { coordinator, fetchTurnSignal, opened, closed } = fixture()
    await coordinator.openTurn('dsh', 1, 'doc-a')
    await coordinator.touchDocument('dsh', 'doc-b')
    await coordinator.endTurn('dsh', 1)
    expect(actions(fetchTurnSignal)).toEqual(['begin', 'begin', 'end', 'end'])
    expect(opened.map(([, doc]) => doc)).toEqual(['doc-a', 'doc-b'])
    expect(opened[1]![2]).toBeGreaterThan(opened[0]![2])
    expect(closed).toEqual([['dsh', ['doc-a', 'doc-b']]])
  })

  it('旧段 end 未完成时，同文稿新段 begin 等待；其他文稿不被拖住', async () => {
    let releaseEnd!: () => void
    const endPending = new Promise<void>((resolve) => { releaseEnd = resolve })
    const fetchTurnSignal = vi.fn(async (_path: string, body: unknown) => {
      if ((body as { action: string }).action === 'end') await endPending
      return { active: (body as { action: string }).action !== 'end' }
    })
    const coordinator = new AgentTurnLeaseCoordinator(
      { fetchTurnSignal } as unknown as EngineService,
      1_000,
      (() => { let id = 0; return () => `turn-${++id}` })(),
    )
    await coordinator.openTurn('dsh', 1, 'doc-a')
    const closing = coordinator.endTurn('dsh', 1)
    const reopening = coordinator.openTurn('dsh', 2, 'doc-a')
    await coordinator.touchDocument('dsh', 'doc-b')
    expect(actions(fetchTurnSignal)).toEqual(['begin', 'begin', 'end'])
    expect(fetchTurnSignal.mock.calls[1]![0]).toContain('/doc-b/')
    releaseEnd()
    await Promise.all([closing, reopening])
    expect(actions(fetchTurnSignal)).toEqual(['begin', 'begin', 'end', 'begin'])
    expect(fetchTurnSignal.mock.calls[3]![0]).toContain('/doc-a/')
  })

  it('并行 close 的总等待不超过 10s，单稿 end 卡住交给 TTL 收口', async () => {
    vi.useFakeTimers()
    const fetchTurnSignal = vi.fn(async (_path: string, body: unknown) => {
      if ((body as { action: string }).action === 'end') return new Promise<never>(() => undefined)
      return { active: true }
    })
    const closed = vi.fn()
    const coordinator = new AgentTurnLeaseCoordinator(
      { fetchTurnSignal } as unknown as EngineService,
      1_000,
      undefined,
      undefined,
      closed,
    )
    await coordinator.openTurn('dsh', 1, 'doc-a')
    await coordinator.touchDocument('dsh', 'doc-b')
    const closing = coordinator.endTurn('dsh', 1)
    let finished = false
    void closing.then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await closing
    expect(finished).toBe(true)
    expect(actions(fetchTurnSignal).filter((action) => action === 'end')).toHaveLength(2)
    expect(closed).toHaveBeenCalledWith('dsh', ['doc-a', 'doc-b'])
  })
})
