import type { EngineStatusSnapshot } from '../contracts.js'
import { QINGJIAN_DOWNLOAD_URL } from '../onboarding.js'
import styles from './QingConnectionGuide.module.css'

export interface QingConnectionGuideProps {
  status: EngineStatusSnapshot
}

export function QingConnectionGuide({ status }: QingConnectionGuideProps) {
  const handshakeFailed = status.state === 'handshake-failed'
  const starting = status.state === 'starting'
  return (
    <main className={styles.viewport} data-qing-connection-guide>
      <article className={styles.card} aria-labelledby="qing-connection-guide-title">
        <p className={styles.eyebrow}>{starting ? '正在等待青简' : handshakeFailed ? '连接需要处理' : '开始使用青简'}</p>
        <h2 className={styles.title} id="qing-connection-guide-title">
          {starting ? '青简正在启动' : handshakeFailed ? '检测到青简，但握手失败' : '尚未连接青简'}
        </h2>
        <p className={styles.lead}>
          {handshakeFailed
            ? '插件会继续在后台重试。请先按下方原因修复青简，无需重启 DSH。'
            : '完成下面三步后，插件会自动接入青简，无需重启 DSH。'}
        </p>
        {handshakeFailed ? (
          <p className={styles.reason} role="alert"><span>具体原因</span>{status.message ?? '青简版本或本机实例信息与插件不兼容。'}</p>
        ) : null}
        <ol className={styles.steps} aria-label="连接青简的三个步骤">
          <li><span aria-hidden="true">①</span><strong>下载并安装青简</strong></li>
          <li><span aria-hidden="true">②</span><strong>启动一次青简</strong></li>
          <li><span aria-hidden="true">③</span><strong>插件将自动连接</strong></li>
        </ol>
        <a
          className={styles.download}
          href={QINGJIAN_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
        >前往下载青简</a>
        <p className={styles.retry}>连接探测正在后台运行；青简就绪后，本引导会自动消失。</p>
      </article>
    </main>
  )
}
