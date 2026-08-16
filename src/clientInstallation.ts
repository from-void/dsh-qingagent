import { execFile, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { posix, win32 } from 'node:path'

const DETECTION_CACHE_MS = 30_000
const PROCESS_TIMEOUT_MS = 2_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const WINDOWS_PROTOCOLS = ['qingagent', 'qingjian'] as const
const WINDOWS_UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const

export interface QingjianClientInstallation {
  installed: boolean
  /** Windows 为 qingagent.exe，macOS 为匹配 bundle id 的 .app 路径。 */
  executablePath?: string
}

export interface InstallationDependencies {
  execFileOutput: (file: string, args: string[], timeoutMs: number) => Promise<Buffer>
  homedir: () => string
  now: () => number
  platform: () => NodeJS.Platform
  spawnDetached: (file: string, args: string[]) => void
  stat: (path: string) => Promise<unknown>
}

const defaultDependencies: InstallationDependencies = {
  execFileOutput: (file, args, timeoutMs) => new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'buffer',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
    })
  }),
  homedir,
  now: Date.now,
  platform,
  spawnDetached: (file, args) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', () => undefined)
    child.unref()
  },
  stat,
}

/**
 * 对系统注册锚点做短缓存，避免 EngineConnection 的 5 秒轮询反复启动 reg.exe/mdfind。
 * 依赖可注入，测试不会访问真实注册表、Spotlight 或文件系统。
 */
export class QingjianClientInstallationDetector {
  private cached?: { expiresAt: number; result: QingjianClientInstallation }
  private pending?: Promise<QingjianClientInstallation>

  constructor(
    private readonly dependencies: InstallationDependencies = defaultDependencies,
    private readonly cacheMs = DETECTION_CACHE_MS,
  ) {}

  detect(): Promise<QingjianClientInstallation> {
    const cached = this.cached
    if (cached && this.dependencies.now() < cached.expiresAt) return Promise.resolve(cached.result)
    this.pending ??= this.detectUncached()
      .catch(() => ({ installed: false }))
      .then((result) => {
        this.cached = { expiresAt: this.dependencies.now() + this.cacheMs, result }
        return result
      })
      .finally(() => { this.pending = undefined })
    return this.pending
  }

  /** 只启动本检测器解析并 stat 过的路径，不接受来自 bridge 客户端的路径。 */
  async launchDetected(): Promise<boolean> {
    try {
      const installation = await this.detect()
      const executablePath = installation.executablePath
      if (!installation.installed || !executablePath) return false
      const currentPlatform = this.dependencies.platform()
      const args = currentPlatform === 'darwin' ? [executablePath] : []
      const command = currentPlatform === 'darwin' ? '/usr/bin/open' : executablePath
      this.dependencies.spawnDetached(command, args)
      return true
    } catch {
      return false
    }
  }

  private async detectUncached(): Promise<QingjianClientInstallation> {
    try {
      const currentPlatform = this.dependencies.platform()
      if (currentPlatform === 'win32') return await this.detectWindows()
      if (currentPlatform === 'darwin') return await this.detectMacOS()
    } catch {
      // 安装检测不得阻断引擎连接，任何异常统一降级为未安装。
    }
    return { installed: false }
  }

  private async detectWindows(): Promise<QingjianClientInstallation> {
    for (const protocol of WINDOWS_PROTOCOLS) {
      const key = `HKCU\\Software\\Classes\\${protocol}\\shell\\open\\command`
      for (const args of registryQueryVariants([key, '/ve'])) {
        const output = await this.tryExec('reg.exe', ['query', ...args])
        const executablePath = output && parseWindowsProtocolOutput(decodeProcessOutput(output))
        if (executablePath && await this.exists(executablePath)) {
          return { installed: true, executablePath }
        }
      }
    }

    for (const root of WINDOWS_UNINSTALL_ROOTS) {
      for (const args of registryQueryVariants([root, '/s'])) {
        const output = await this.tryExec('reg.exe', ['query', ...args])
        if (!output) continue
        for (const executablePath of parseWindowsUninstallOutput(decodeProcessOutput(output))) {
          if (await this.exists(executablePath)) return { installed: true, executablePath }
        }
      }
    }
    return { installed: false }
  }

  private async detectMacOS(): Promise<QingjianClientInstallation> {
    const output = await this.tryExec('mdfind', [
      "kMDItemCFBundleIdentifier == 'com.qingagent.desktop'",
    ])
    const spotlightPaths = output ? parseMdfindOutput(decodeProcessOutput(output)) : []
    for (const executablePath of spotlightPaths) {
      if (await this.exists(executablePath)) return { installed: true, executablePath }
    }
    const systemFallback = '/Applications/青简.app'
    if (await this.exists(systemFallback)) {
      return { installed: true, executablePath: systemFallback }
    }
    const userFallback = posix.join(this.dependencies.homedir(), 'Applications', '青简.app')
    if (await this.exists(userFallback)) return { installed: true, executablePath: userFallback }
    return { installed: false }
  }

  private async tryExec(file: string, args: string[]): Promise<Buffer | undefined> {
    try {
      return await this.dependencies.execFileOutput(file, args, PROCESS_TIMEOUT_MS)
    } catch {
      return undefined
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.dependencies.stat(path)
      return true
    } catch {
      return false
    }
  }
}

function registryQueryVariants(args: string[]): string[][] {
  return [args, [...args, '/reg:64']]
}

/** 兼容 reg.exe 的 UTF-16LE、UTF-8 与中文 Windows 常见 GB18030 输出。 */
export function decodeProcessOutput(output: Buffer): string {
  try {
    const hasUtf16Bom = output[0] === 0xff && output[1] === 0xfe
    const zeroBytes = output.subarray(0, Math.min(output.length, 128))
      .reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0)
    if (hasUtf16Bom || zeroBytes > 8) return output.toString('utf16le').replace(/^\uFEFF/, '')
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(output)
    } catch {
      return new TextDecoder('gb18030').decode(output)
    }
  } catch {
    return output.toString('utf8')
  }
}

export function parseWindowsProtocolOutput(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const value = registryStringValue(line)
    if (!value) continue
    const quoted = value.match(/^"([^"]+?\.exe)"(?:\s|$)/i)?.[1]
    const unquoted = value.match(/^(.+?\.exe)(?:\s|$)/i)?.[1]
    const executablePath = (quoted ?? unquoted)?.trim()
    if (
      executablePath
      && win32.isAbsolute(executablePath)
      && win32.basename(executablePath).toLowerCase() === 'qingagent.exe'
    ) return executablePath
  }
  return undefined
}

export function parseWindowsUninstallOutput(output: string): string[] {
  const entries: Array<{ key: string; values: Map<string, string> }> = []
  let current: { key: string; values: Map<string, string> } | undefined
  for (const line of output.split(/\r?\n/)) {
    const key = line.trim()
    if (/^HKEY_(?:CURRENT_USER|LOCAL_MACHINE)\\/i.test(key)) {
      current = { key, values: new Map() }
      entries.push(current)
      continue
    }
    if (!current) continue
    const match = line.match(/^\s*(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/i)
    if (match?.[1] && match[2] !== undefined) current.values.set(match[1].trim().toLowerCase(), match[2])
  }

  const candidates: string[] = []
  for (const entry of entries) {
    const displayName = entry.values.get('displayname') ?? ''
    const keyName = entry.key.slice(entry.key.lastIndexOf('\\') + 1).toLowerCase()
    const matchesProduct = displayName.includes('青简')
      || keyName.includes('qingagent')
      || keyName.includes('com.qingagent.desktop')
      || keyName.includes('青简')
    const installLocation = stripRegistryQuotes(entry.values.get('installlocation') ?? '')
    if (matchesProduct && installLocation && win32.isAbsolute(installLocation)) {
      candidates.push(win32.join(installLocation, 'qingagent.exe'))
    }
  }
  return [...new Set(candidates)]
}

export function parseMdfindOutput(output: string): string[] {
  return [...new Set(output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => posix.isAbsolute(line) && line.toLowerCase().endsWith('.app')))]
}

function registryStringValue(line: string): string | undefined {
  return line.match(/^\s*.*?\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i)?.[1]
}

function stripRegistryQuotes(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed
}

const detector = new QingjianClientInstallationDetector()

export function detectQingjianClientInstallation(): Promise<QingjianClientInstallation> {
  return detector.detect()
}

export function launchDetectedQingjianClient(): Promise<boolean> {
  return detector.launchDetected()
}
