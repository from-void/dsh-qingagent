import { aiIrToPm, qingmlParse, type PmDoc } from '@qingagent/pm-schema'

export function compileQingmlDocument(qingml: string): PmDoc {
  const parsed = qingmlParse(qingml)
  return aiIrToPm({ blocks: parsed.blocks })
}

export interface QingmlCompileThrottle {
  push(qingml: string): void
  cancel(): void
}

export interface QingmlCompileThrottleOptions {
  intervalMs?: number
  now?: () => number
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
  compile?: (qingml: string) => PmDoc
  onCompiled: (doc: PmDoc) => void
  onError?: (error: unknown) => void
}

/** 首帧立即编译，窗口内只保留最后一份 QingML，在窗口尾补一次 remote 全文。 */
export function createQingmlCompileThrottle(options: QingmlCompileThrottleOptions): QingmlCompileThrottle {
  const interval = options.intervalMs ?? 80
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds))
  const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer))
  const compile = options.compile ?? compileQingmlDocument
  let latest: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastRun = Number.NEGATIVE_INFINITY

  const run = () => {
    timer = null
    const source = latest
    latest = null
    if (source === null) return
    lastRun = now()
    try {
      options.onCompiled(compile(source))
    } catch (error) {
      options.onError?.(error)
    }
  }

  return {
    push(qingml) {
      // 空首帧无可编译内容,静默跳过(评测 P8)。
      if (!qingml.trim()) return
      latest = qingml
      if (timer) return
      const remaining = Math.max(0, interval - (now() - lastRun))
      if (remaining === 0) run()
      else timer = schedule(run, remaining)
    },
    cancel() {
      if (timer) cancelSchedule(timer)
      timer = null
      latest = null
    },
  }
}
