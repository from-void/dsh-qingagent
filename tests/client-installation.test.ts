import { describe, expect, it, vi } from 'vitest'
import {
  decodeProcessOutput,
  parseMdfindOutput,
  parseWindowsProtocolOutput,
  parseWindowsUninstallOutput,
  QingjianClientInstallationDetector,
  type InstallationDependencies,
} from '../src/clientInstallation.js'

function fixture(overrides: Partial<InstallationDependencies> = {}) {
  const dependencies: InstallationDependencies = {
    execFileOutput: vi.fn(async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    homedir: () => '/Users/qing',
    now: () => 0,
    platform: () => 'win32',
    spawnDetached: vi.fn(),
    stat: vi.fn(async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    ...overrides,
  }
  return { dependencies, detector: new QingjianClientInstallationDetector(dependencies) }
}

function reg(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

describe('青简桌面客户端系统注册锚点检测', () => {
  it('解析协议默认值中的带引号完整路径并按 qingagent 优先命中即止', async () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\Classes\\qingagent\\shell\\open\\command',
      '    (默认)    REG_SZ    "D:\\Apps Folder\\青简\\qingagent.exe" "%1"',
    ].join('\r\n')
    const execFileOutput = vi.fn(async () => Buffer.from(`\uFEFF${output}`, 'utf16le'))
    const stat = vi.fn(async () => ({}))
    const { detector } = fixture({ execFileOutput, stat })

    await expect(detector.detect()).resolves.toEqual({
      installed: true,
      executablePath: 'D:\\Apps Folder\\青简\\qingagent.exe',
    })
    expect(execFileOutput).toHaveBeenCalledWith('reg.exe', [
      'query',
      'HKCU\\Software\\Classes\\qingagent\\shell\\open\\command',
      '/ve',
    ], 2_000)
    expect(execFileOutput).toHaveBeenCalledTimes(1)
    expect(stat).toHaveBeenCalledWith('D:\\Apps Folder\\青简\\qingagent.exe')
  })

  it('协议未命中后枚举 HKCU NSIS 卸载项，并按中文 DisplayName 拼接 exe', async () => {
    const uninstallOutput = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\random-product',
      '    DisplayName    REG_SZ    青简桌面客户端',
      '    InstallLocation    REG_SZ    E:\\Portable Apps\\Qingjian',
    ].join('\r\n')
    const execFileOutput = vi.fn(async (_file: string, args: string[]) => {
      if (args[1]?.startsWith('HKCU\\Software\\Microsoft') && !args.includes('/reg:64')) {
        return reg(uninstallOutput)
      }
      throw new Error('missing')
    })
    const stat = vi.fn(async () => ({}))
    const { detector } = fixture({ execFileOutput, stat })

    await expect(detector.detect()).resolves.toEqual({
      installed: true,
      executablePath: 'E:\\Portable Apps\\Qingjian\\qingagent.exe',
    })
    expect(execFileOutput.mock.calls.some(([, args]) => args.includes('/reg:64'))).toBe(true)
    expect(execFileOutput.mock.calls.some(([, args]) => args[1]?.startsWith('HKLM'))).toBe(false)
  })

  it('qingagent 未命中时继续 qingjian，并可从 64 位注册表视图读取协议路径', async () => {
    const qingjianOutput = [
      'HKEY_CURRENT_USER\\Software\\Classes\\qingjian\\shell\\open\\command',
      '    (Default)    REG_SZ    "C:\\Qingjian64\\qingagent.exe" "%1"',
    ].join('\r\n')
    const execFileOutput = vi.fn(async (_file: string, args: string[]) => {
      if (args[1]?.includes('Classes\\qingjian') && args.includes('/reg:64')) return reg(qingjianOutput)
      throw new Error('missing')
    })
    const { detector } = fixture({ execFileOutput, stat: vi.fn(async () => ({})) })

    await expect(detector.detect()).resolves.toEqual({
      installed: true,
      executablePath: 'C:\\Qingjian64\\qingagent.exe',
    })
    expect(execFileOutput.mock.calls.map(([, args]) => args.slice(1))).toEqual([
      ['HKCU\\Software\\Classes\\qingagent\\shell\\open\\command', '/ve'],
      ['HKCU\\Software\\Classes\\qingagent\\shell\\open\\command', '/ve', '/reg:64'],
      ['HKCU\\Software\\Classes\\qingjian\\shell\\open\\command', '/ve'],
      ['HKCU\\Software\\Classes\\qingjian\\shell\\open\\command', '/ve', '/reg:64'],
    ])
  })

  it('中文字段发生乱码时不抛错，并可用卸载 key 名安全识别产品', async () => {
    const bytes = Buffer.concat([
      reg('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.qingagent.desktop\r\n'),
      Buffer.from([0xff]),
      reg('DisplayName    REG_SZ    broken-name\r\n    InstallLocation    REG_SZ    C:\\Qingjian\r\n'),
    ])
    const decoded = decodeProcessOutput(bytes)

    expect(() => parseWindowsUninstallOutput(decoded)).not.toThrow()
    expect(parseWindowsUninstallOutput(decoded)).toEqual(['C:\\Qingjian\\qingagent.exe'])
  })

  it('协议和卸载项残留但 exe 均不存在时判定未安装，且不回退 Windows 固定目录', async () => {
    const protocolOutput = [
      'HKEY_CURRENT_USER\\Software\\Classes\\qingagent\\shell\\open\\command',
      '    (Default)    REG_SZ    "D:\\Removed\\qingagent.exe" "%1"',
    ].join('\r\n')
    const uninstallOutput = [
      'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QingAgent',
      '    DisplayName    REG_SZ    青简',
      '    InstallLocation    REG_SZ    F:\\RemovedToo',
    ].join('\r\n')
    const execFileOutput = vi.fn(async (_file: string, args: string[]) => {
      if (args[1]?.includes('Classes\\qingagent') && !args.includes('/reg:64')) return reg(protocolOutput)
      if (args[1]?.startsWith('HKLM\\Software\\Microsoft') && !args.includes('/reg:64')) return reg(uninstallOutput)
      throw new Error('missing')
    })
    const stat = vi.fn(async (_path: string) => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    const { detector } = fixture({ execFileOutput, stat })

    await expect(detector.detect()).resolves.toEqual({ installed: false })
    expect(stat.mock.calls.map(([path]) => path)).toEqual([
      'D:\\Removed\\qingagent.exe',
      'F:\\RemovedToo\\qingagent.exe',
    ])
    expect(stat.mock.calls.flat().join('\n')).not.toContain('AppData\\Local\\Programs')
  })

  it('解析 mdfind 多行结果，优先验证 Spotlight 命中的可移动 app 路径', async () => {
    const execFileOutput = vi.fn(async () => reg([
      '/Volumes/Work/青简.app',
      '/Applications/青简 Beta.app',
      '',
    ].join('\n')))
    const stat = vi.fn(async (path: string) => {
      if (path === '/Volumes/Work/青简.app') return {}
      throw new Error('missing')
    })
    const { detector } = fixture({
      execFileOutput,
      platform: () => 'darwin',
      stat,
    })

    expect(parseMdfindOutput('/A/青简.app\r\n\r\n/A/青简.app\nnot-an-app')).toEqual(['/A/青简.app'])
    await expect(detector.detect()).resolves.toEqual({
      installed: true,
      executablePath: '/Volumes/Work/青简.app',
    })
    expect(execFileOutput).toHaveBeenCalledWith('mdfind', [
      "kMDItemCFBundleIdentifier == 'com.qingagent.desktop'",
    ], 2_000)
    expect(stat).toHaveBeenCalledTimes(1)
  })

  it('mdfind 为空时仅在 macOS 兜底系统和用户 Applications 路径', async () => {
    const stat = vi.fn()
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce({})
    const { detector } = fixture({
      execFileOutput: vi.fn(async () => reg('\r\n')),
      homedir: () => '/Users/qing',
      platform: () => 'darwin',
      stat,
    })

    await expect(detector.detect()).resolves.toEqual({
      installed: true,
      executablePath: '/Users/qing/Applications/青简.app',
    })
    expect(stat.mock.calls.map(([path]) => path)).toEqual([
      '/Applications/青简.app',
      '/Users/qing/Applications/青简.app',
    ])
  })

  it('30 秒内复用检测结果，过期后才再次启动 mdfind', async () => {
    let now = 1_000
    const execFileOutput = vi.fn(async () => reg('/Applications/青简.app\n'))
    const { detector } = fixture({
      execFileOutput,
      now: () => now,
      platform: () => 'darwin',
      stat: vi.fn(async () => ({})),
    })

    await detector.detect()
    now = 30_999
    await detector.detect()
    expect(execFileOutput).toHaveBeenCalledTimes(1)
    now = 31_001
    await detector.detect()
    expect(execFileOutput).toHaveBeenCalledTimes(2)
  })

  it('无参启动只使用 host 检测到的路径，Windows detached spawn 不接受外部路径', async () => {
    const hostPath = 'D:\\User Chosen\\qingagent.exe'
    const spawnDetached = vi.fn()
    const { detector } = fixture({
      execFileOutput: vi.fn(async () => reg(
        `HKEY_CURRENT_USER\\Software\\Classes\\qingagent\\shell\\open\\command\r\n`
        + `    (Default)    REG_SZ    "${hostPath}" "%1"`,
      )),
      spawnDetached,
      stat: vi.fn(async () => ({})),
    })

    await expect(detector.launchDetected()).resolves.toBe(true)
    expect(spawnDetached).toHaveBeenCalledWith(hostPath, [])
  })

  it('其他平台恒为未安装且不调用子进程或 stat', async () => {
    const execFileOutput = vi.fn()
    const stat = vi.fn()
    const { detector } = fixture({ execFileOutput, platform: () => 'linux', stat })

    await expect(detector.detect()).resolves.toEqual({ installed: false })
    expect(execFileOutput).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })
})

describe('注册表纯解析', () => {
  it('拒绝协议命令中非 qingagent.exe 的目标', () => {
    expect(parseWindowsProtocolOutput('    (Default)    REG_SZ    "C:\\Temp\\other.exe" "%1"'))
      .toBeUndefined()
  })
})
