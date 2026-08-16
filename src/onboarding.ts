import type { EngineStatusSnapshot } from './contracts.js'

/** 引导卡、工具报错共用的唯一下载地址；后续发布渠道变化只改这里。 */
export const QINGJIAN_DOWNLOAD_URL = 'https://github.com/from-void/qingagent/releases'

export function qingjianUnavailableMessage(status: EngineStatusSnapshot): string {
  const download = `下载青简：${QINGJIAN_DOWNLOAD_URL}`
  if (status.state === 'handshake-failed') {
    return [
      '【未连接青简】检测到青简引擎，但握手失败。',
      `具体原因：${status.message ?? '青简版本或本机实例信息与插件不兼容。'}`,
      '请修复或更新青简并保持运行；插件会自动重连，无需重启 DSH。',
      download,
    ].join('\n')
  }
  if (status.state === 'starting') {
    return [
      '【未连接青简】青简正在启动，插件会自动连接。',
      '若尚未安装青简，请先下载安装并启动一次；无需重启 DSH。',
      download,
    ].join('\n')
  }
  return [
    '【未连接青简】未检测到可用的青简引擎。',
    '请先安装并启动青简；插件会自动连接，无需重启 DSH。',
    download,
  ].join('\n')
}
