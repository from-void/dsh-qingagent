import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.js'

describe('插件配置', () => {
  it('默认值完整', () => {
    expect(Config({})).toEqual({
      engineUrl: 'http://127.0.0.1:8080',
      autoLaunch: false,
      workspaceProjection: true,
    })
  })
})
