// 从 vendor/qingagent 钉扎版本搬入的纯调度器；消费侧只负责按节拍应用帧。

export interface RevealCursorInfo {
  id: string
  lane: number
}

export interface RevealFrame {
  revealed: string[]
  typed: Array<[string, number]>
  cursors: RevealCursorInfo[]
}

export function revealNewPartLen(before: string, after: string): number {
  const isAddition = before.length > 0 && after.startsWith(before) && after.length > before.length
  const newPart = isAddition ? after.slice(before.length) : after
  return Array.from(newPart).length
}

export function planRevealTypewriter(
  ids: readonly string[],
  targetOf: (id: string) => number,
  concurrency: number,
  charsPerTick: number,
): RevealFrame[] {
  const heads = Math.max(1, Math.floor(concurrency))
  const step = Math.max(1, Math.floor(charsPerTick))
  const queue = ids.slice()
  const active: { id: string; typed: number; lane: number }[] = []
  const typed = new Map<string, number>()
  const revealed = new Set<string>()
  const usedLanes = new Set<number>()

  const targetSafe = (id: string) => Math.max(0, Math.floor(targetOf(id)))
  const takeLane = (): number => {
    let lane = 1
    while (usedLanes.has(lane)) lane += 1
    usedLanes.add(lane)
    return lane
  }
  const refill = () => {
    while (active.length < heads && queue.length > 0) {
      const id = queue.shift()!
      revealed.add(id)
      typed.set(id, 0)
      if (targetSafe(id) <= 0) continue
      active.push({ id, typed: 0, lane: takeLane() })
    }
  }
  const snapshot = (): RevealFrame => ({
    revealed: [...revealed],
    typed: [...typed.entries()],
    cursors: active.map((head) => ({ id: head.id, lane: head.lane })),
  })

  const frames: RevealFrame[] = []
  refill()
  frames.push(snapshot())

  let totalChars = 0
  for (const id of ids) totalChars += targetSafe(id)
  const guardMax = totalChars + ids.length + 8
  let guard = 0
  while ((active.length > 0 || queue.length > 0) && guard <= guardMax) {
    guard += 1
    for (const head of active) {
      head.typed += step
      typed.set(head.id, Math.min(head.typed, targetSafe(head.id)))
    }
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const head = active[index]!
      if (head.typed >= targetSafe(head.id)) {
        typed.set(head.id, targetSafe(head.id))
        usedLanes.delete(head.lane)
        active.splice(index, 1)
      }
    }
    refill()
    frames.push(snapshot())
  }
  return frames
}

export const DEFAULT_REVEAL_CONCURRENCY = 5
export const DEFAULT_REVEAL_STEP_DELAY_MS = 20
export const DEFAULT_REVEAL_CHARS_PER_TICK = 1
export const DEFAULT_REVEAL_TAIL_HOLD_MS = 390
