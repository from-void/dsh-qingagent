import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.js'

describe('插件配置', () => {
  it('sideModel 整段可省略且默认值正确', () => {
    expect(Config({})).toEqual({
      engineUrl: 'http://127.0.0.1:8080',
      autoLaunch: false,
      workspaceProjection: true,
    })
  })

  it('sideModel 出现时 provider/model 都必填', () => {
    expect(Config({ sideModel: { provider: 'deepseek', model: 'deepseek-chat' } }).sideModel).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(() => Config({ sideModel: { provider: 'deepseek' } as never })).toThrow(/sideModel/)
  })
})
