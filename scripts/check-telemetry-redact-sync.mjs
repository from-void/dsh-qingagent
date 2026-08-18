import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const qingRoot = process.env.QING_ROOT ?? resolve('vendor/qingagent')
const vendorFile = resolve(qingRoot, 'apps/desktop/src/main/telemetry/redact.ts')
const shimFile = resolve('src/telemetry/redact.ts')

const [vendorSource, shimSource] = await Promise.all([
  readFile(vendorFile, 'utf8'),
  readFile(shimFile, 'utf8'),
])

if (vendorSource !== shimSource) {
  console.error('telemetry redact shim 已与 vendor 源漂移；请从 vendor/qingagent 同步后再提交。')
  process.exitCode = 1
}
