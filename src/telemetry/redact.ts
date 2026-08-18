// 共享脱敏(纯函数,无 electron/dom 依赖):错误消息等可能夹带本机路径 / 密钥的文本统一脱敏。
// 渲染端(renderer-inject/telemetry-inject)与主进程(main/telemetry/index)都 import 本模块,
// 避免两份正则漂移。改这里务必同步跑 redact.test.mjs(对抗性输入回归)。

const PATH_PATTERNS: RegExp[] = [
  /file:\/\/\/[^\s"'`),]+/gi,
  // 盘符路径(C:\... / D:/...);负向后顾排除 https:// 里 "s:/" 之类被误判为路径。
  /(?<![A-Za-z])[a-zA-Z]:[\\/][^\s"'`),]+/g,
  /\\\\[^\s"'`),]+/g,
  /\/(?:Users|home)\/[^/\s"'`),]+\/[^\s"'`),]*/g,
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer <token> 整体抹(必须先于下面的通用 key=value,否则只抹到 "Bearer" 字样)。
  [/\bbearer\s+[A-Za-z0-9._\-]{6,}/gi, "Bearer [redacted]"],
  // key=value / "key":"value":键名两侧可带引号,分隔符 : 或 =,值前可带引号。
  [
    /\b(api[-_]?key|access[-_]?token|authorization|auth|token|secret|password|passwd|pwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]{3,}/gi,
    "$1=[redacted]",
  ],
  // 常见密钥前缀(sk_/phx_/ghp_/glpat-/xoxb- 等)。
  [/\b(?:sk|pk|rk|phx|ghp|gho|ghs|glpat|xox[baprs])[-_][A-Za-z0-9._-]{6,}/g, "[redacted]"],
  // JWT。
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[redacted]"],
];

/** 把字符串里的本机路径与密钥脱敏(路径→[path],密钥值→[redacted])。 */
export function redactPotentialPii(value: string): string {
  let redacted = value;
  for (const pattern of PATH_PATTERNS) {
    redacted = redacted.replace(pattern, "[path]");
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}
