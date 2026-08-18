import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactPotentialPii } from '../src/telemetry/redact.js'

describe('telemetry redact shim', () => {
  it('与固定 vendor 源逐字一致，防止正则漂移', async () => {
    const [shim, vendor] = await Promise.all([
      readFile(resolve('src/telemetry/redact.ts'), 'utf8'),
      readFile(resolve('vendor/qingagent/apps/desktop/src/main/telemetry/redact.ts'), 'utf8'),
    ])
    expect(shim).toBe(vendor)
  })

  it('覆盖路径、Bearer、JSON secret、常见 key 与 JWT', () => {
    const cases = [
      ['/home/user/secret/doc.txt', '/home/user'],
      ['C:\\Users\\bob\\x.txt', 'bob'],
      ['file:///Users/alice/p.txt', 'alice'],
      ['authorization: Bearer ABC123BEARERTOKEN', 'ABC123BEARERTOKEN'],
      ['{"secret":"JSONSECRETVAL123"}', 'JSONSECRETVAL123'],
      ['use sk-ABCDEF123456 now', 'sk-ABCDEF123456'],
      ['eyJhbGciOiAB.eyJzdWIiOiCD.SflKxwRJ12', 'eyJhbGciOiAB.eyJzdWIiOiCD.SflKxwRJ12'],
    ]
    for (const [input, secret] of cases) expect(redactPotentialPii(input)).not.toContain(secret)
  })

  it('不误伤普通 URL、版本与错误文本', () => {
    for (const value of [
      'version 1.2.3',
      'see https://example.com/docs/page?tab=overview#section',
      "Cannot read properties of undefined (reading 'foo')",
    ]) expect(redactPotentialPii(value)).toBe(value)
  })
})
