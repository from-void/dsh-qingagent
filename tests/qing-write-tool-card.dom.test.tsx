// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  resolve('src/client/QingWriteToolCard.module.css'),
  'utf8',
)

afterEach(() => {
  document.head.replaceChildren()
})

describe('QingWriteToolCard theme styles', () => {
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
