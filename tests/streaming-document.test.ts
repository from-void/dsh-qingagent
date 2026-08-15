import { describe, expect, it } from 'vitest'
import type { PmDoc } from '../src/contracts.js'
import { createQingmlCompileThrottle } from '../src/client/streamingDocument.js'

describe('QingML 增量编译节流', () => {
  it('首块立即编译，节流窗口只编译最后一份累计 QingML', () => {
    let now = 0
    let scheduled: (() => void) | undefined
    let scheduledDelay = -1
    const compiledSources: string[] = []
    const delivered: PmDoc[] = []
    const throttle = createQingmlCompileThrottle({
      intervalMs: 80,
      now: () => now,
      schedule: (callback, delay) => {
        scheduled = callback
        scheduledDelay = delay
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: () => undefined,
      compile: (source) => {
        compiledSources.push(source)
        return { type: 'doc', attrs: { schemaVersion: 1 }, content: [] } as PmDoc
      },
      onCompiled: (doc) => delivered.push(doc),
    })

    throttle.push('<p>一</p>')
    expect(compiledSources).toEqual(['<p>一</p>'])
    now = 10
    throttle.push('<p>一</p><p>二</p>')
    throttle.push('<p>一</p><p>二</p><p>三</p>')
    expect(scheduledDelay).toBe(70)
    expect(compiledSources).toHaveLength(1)

    now = 80
    scheduled?.()
    expect(compiledSources).toEqual(['<p>一</p>', '<p>一</p><p>二</p><p>三</p>'])
    expect(delivered).toHaveLength(2)
  })
})
