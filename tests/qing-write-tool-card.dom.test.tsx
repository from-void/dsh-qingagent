// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { failureSummary } from '../src/client/QingWriteToolCard.js'

const stylesheet = readFileSync(
  resolve('src/client/QingWriteToolCard.module.css'),
  'utf8',
)

afterEach(() => {
  document.head.replaceChildren()
})

describe('QingWriteToolCard theme styles', () => {
  it('从失败 result content 首行提取用户可读摘要', () => {
    expect(failureSummary([{ type: 'text', text: 'Error: 文稿正在审阅中（请先裁决）\n详情' }]))
      .toBe('文稿审阅中')
    expect(failureSummary([{ type: 'text', text: 'Error: 青简正在处理其他任务（AGENT_BUSY）' }]))
      .toBe('引擎忙')
  })

  it('uses only dsh semantic variables instead of literal colors', () => {
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)

    expect(document.styleSheets[0]?.cssRules.length).toBeGreaterThan(0)
    expect(stylesheet).not.toMatch(/#[\da-f]{3,8}\b|rgba?\s*\(/i)

    const themeColors = [...stylesheet.matchAll(
      /^\s*(?:color|background(?:-color)?|border-color|outline-color|box-shadow)\s*:\s*([^;]+);/gm,
    )].map((match) => match[1]?.trim())
    expect(themeColors.length).toBeGreaterThan(0)
    expect(themeColors.every((value) => value === 'transparent' || /^var\(--dsw-[\w-]+\)$/.test(value ?? ''))).toBe(true)

    const variables = [...stylesheet.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1])
    expect(variables.length).toBeGreaterThan(0)
    expect(variables.every((variable) => variable?.startsWith('--dsw-'))).toBe(true)
  })
})
