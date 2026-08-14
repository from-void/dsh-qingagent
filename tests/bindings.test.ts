import { describe, expect, it } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { BindingStore, type BindingDomain } from '../src/bindings.js'
import type { SessionBinding } from '../src/contracts.js'

function fakeDomain() {
  const records = new Map<string, SessionBinding>()
  const table: KvTable<string, SessionBinding> = {
    get: (key) => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    get size() { return records.size },
    put: async (key, value) => { records.set(key, value) },
    delete: async (key) => records.delete(key),
    update: async (key, transform) => {
      const current = records.get(key)
      if (!current) throw new Error('missing')
      const next = transform(current)
      records.set(key, next)
      return next
    },
  }
  return {
    records,
    domain: { table: () => table } as unknown as BindingDomain,
  }
}

describe('BindingStore', () => {
  it('新建文稿后持久化并设为活跃', async () => {
    const { domain, records } = fakeDomain()
    const changed: SessionBinding[] = []
    const store = new BindingStore(domain, {
      fetchJson: async <T>() => ({ sessionId: 'qing-1', seq: null }) as T,
    }, (_sessionId, binding) => changed.push(binding))

    const doc = await store.createDoc('dsh-1', '测试稿')
    expect(doc).toMatchObject({ engineSessionId: 'qing-1', title: '测试稿' })
    expect(records.get('dsh-1')?.activeEngineSessionId).toBe('qing-1')
    expect(store.getActive('dsh-1')).toEqual(doc)
    expect(changed).toHaveLength(1)
  })

  it('拒绝跨 DSH 会话聚焦，并能更新标题', async () => {
    const { domain } = fakeDomain()
    const store = new BindingStore(domain, {
      fetchJson: async <T>() => ({ sessionId: 'qing-2', seq: null }) as T,
    })
    await store.createDoc('dsh-1', '旧标题')
    await expect(store.setActive('dsh-2', 'qing-2')).rejects.toThrow('不属于当前 DSH 会话')
    await store.updateTitle('dsh-1', 'qing-2', '新标题')
    expect(store.getActive('dsh-1')?.title).toBe('新标题')
  })
})
