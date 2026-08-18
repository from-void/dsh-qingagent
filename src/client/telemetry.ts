import type {
  BridgeTelemetryEventName,
  PanelOpenSource,
  TelemetryEventMap,
} from '../telemetry.js'

const panelOpenSources = new Map<string, PanelOpenSource>()
const mountedPanels = new Set<string>()

export function markPanelOpenSource(sessionId: string, source: PanelOpenSource): void {
  if (mountedPanels.has(sessionId)) return
  panelOpenSources.set(sessionId, source)
}

export function beginPanelMount(sessionId: string): PanelOpenSource {
  const source = panelOpenSources.get(sessionId) ?? 'manual'
  panelOpenSources.delete(sessionId)
  mountedPanels.add(sessionId)
  return source
}

export function endPanelMount(sessionId: string): void {
  mountedPanels.delete(sessionId)
  panelOpenSources.delete(sessionId)
}

export function panelPatchesBucket(value: number): '1' | '2-5' | '6-20' | '>20' {
  if (value <= 1) return '1'
  if (value <= 5) return '2-5'
  if (value <= 20) return '6-20'
  return '>20'
}

/** 面板只把严格的白名单事件送到同源 bridge；外网请求始终由 node 侧完成。 */
export function capturePanelTelemetry<K extends BridgeTelemetryEventName>(
  event: K,
  properties: TelemetryEventMap[K],
): void {
  void fetch('/qingagent-bridge/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, properties }),
  }).catch(() => undefined)
}
