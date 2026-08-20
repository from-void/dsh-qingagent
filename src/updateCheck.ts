import { createRequire } from 'node:module'

export const UPDATE_CHECK_URL = 'https://registry.npmjs.org/dsh-qingagent/latest'
export const UPDATE_CHECK_TIMEOUT_MS = 3_000
export const UPDATE_CHECK_CACHE_MS = 12 * 60 * 60 * 1_000

const require = createRequire(import.meta.url)

export interface UpdateCheckResult {
  current: string
  latest: string
  hasUpdate: boolean
}

export interface UpdateCheckDependencies {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
  now: () => number
}

export interface UpdateCheckProvider {
  check: () => Promise<UpdateCheckResult>
}

interface ParsedVersion {
  core: [number, number, number]
  prerelease?: Array<number | string>
}

const defaultDependencies: UpdateCheckDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: Date.now,
}

export const CURRENT_PACKAGE_VERSION = readCurrentPackageVersion()

/**
 * registry 查询只影响提示，不得阻塞或打扰青简主链路：失败、超时、非 200 与坏载荷
 * 一律折叠为“当前即最新”。正负结果共用 12h 缓存，并合并并发挂载产生的查询。
 */
export class PluginUpdateChecker implements UpdateCheckProvider {
  private cached?: { expiresAt: number; result: UpdateCheckResult }
  private pending?: Promise<UpdateCheckResult>

  constructor(
    private readonly currentVersion = CURRENT_PACKAGE_VERSION,
    private readonly dependencies: UpdateCheckDependencies = defaultDependencies,
    private readonly cacheMs = UPDATE_CHECK_CACHE_MS,
  ) {}

  check(): Promise<UpdateCheckResult> {
    const cached = this.cached
    if (cached && this.dependencies.now() < cached.expiresAt) return Promise.resolve(cached.result)
    this.pending ??= this.checkUncached()
      .catch(() => this.noUpdate())
      .then((result) => {
        this.cached = { expiresAt: this.dependencies.now() + this.cacheMs, result }
        return result
      })
      .finally(() => { this.pending = undefined })
    return this.pending
  }

  private async checkUncached(): Promise<UpdateCheckResult> {
    const response = await this.dependencies.fetch(UPDATE_CHECK_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    })
    if (!response.ok) return this.noUpdate()
    const payload = await response.json() as { version?: unknown }
    if (typeof payload.version !== 'string' || !parseVersion(payload.version)) return this.noUpdate()
    return {
      current: this.currentVersion,
      latest: payload.version,
      hasUpdate: isNewer(payload.version, this.currentVersion),
    }
  }

  private noUpdate(): UpdateCheckResult {
    return {
      current: this.currentVersion,
      latest: this.currentVersion,
      hasUpdate: false,
    }
  }
}

/** latest 严格新于 current 时返回 true；任一输入不是最小 semver 形态则静默返回 false。 */
export function isNewer(latest: string, current: string): boolean {
  const left = parseVersion(latest)
  const right = parseVersion(current)
  if (!left || !right) return false

  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index]! !== right.core[index]!) {
      return left.core[index]! > right.core[index]!
    }
  }

  if (!left.prerelease && !right.prerelease) return false
  if (!left.prerelease) return true
  if (!right.prerelease) return false
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return false
    if (rightPart === undefined) return true
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'string') return false
    if (typeof leftPart === 'string' && typeof rightPart === 'number') return true
    return leftPart > rightPart
  }
  return false
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim())
  if (!match) return undefined
  const core = match.slice(1, 4).map(Number) as [number, number, number]
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined
  const prereleaseRaw = match[4]
  if (!prereleaseRaw) return { core }
  const prerelease = prereleaseRaw.split('.').map((part) => {
    if (!/^\d+$/.test(part)) return part
    if (part.length > 1 && part.startsWith('0')) return undefined
    const number = Number(part)
    return Number.isSafeInteger(number) ? number : undefined
  })
  if (prerelease.some((part) => part === undefined)) return undefined
  return { core, prerelease: prerelease as Array<number | string> }
}

function readCurrentPackageVersion(): string {
  try {
    const packageJson = require('../package.json') as { version?: unknown }
    return typeof packageJson.version === 'string' ? packageJson.version : ''
  } catch {
    return ''
  }
}
