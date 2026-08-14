import { z } from 'zod'
import { defineDomain, domainTable, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { BoundDocument, ExternalSessionCreateResponse, SessionBinding } from './contracts.js'

const boundDocumentSchema = z.object({
  engineSessionId: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
})
const sessionBindingSchema = z.object({
  docs: z.array(boundDocumentSchema),
  activeEngineSessionId: z.string().min(1).optional(),
})

export const BindingDomainSpec = defineDomain({
  name: 'dsh_qingagent',
  version: 1,
  tables: {
    bindings: domainTable<string, SessionBinding>(sessionBindingSchema),
  },
})

export type BindingDomain = Domain<typeof BindingDomainSpec>

export interface BindingEngine {
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>
}

export type BindingChanged = (dshSessionId: string, binding: SessionBinding) => void

export class BindingStore {
  private readonly table: KvTable<string, SessionBinding>

  constructor(
    domain: BindingDomain,
    private readonly engine: BindingEngine,
    private readonly changed: BindingChanged = () => undefined,
  ) {
    this.table = domain.table('bindings')
  }

  getBinding(dshSessionId: string): SessionBinding {
    return this.table.get(dshSessionId) ?? { docs: [] }
  }

  listDocs(dshSessionId: string): BoundDocument[] {
    return [...this.getBinding(dshSessionId).docs]
  }

  getActive(dshSessionId: string): BoundDocument | undefined {
    const binding = this.getBinding(dshSessionId)
    return binding.docs.find((doc) => doc.engineSessionId === binding.activeEngineSessionId)
  }

  hasDoc(dshSessionId: string, engineSessionId: string): boolean {
    return this.getBinding(dshSessionId).docs.some((doc) => doc.engineSessionId === engineSessionId)
  }

  async createDoc(dshSessionId: string, title = '未命名文稿'): Promise<BoundDocument> {
    const created = await this.engine.fetchJson<ExternalSessionCreateResponse>('/sessions', {
      method: 'POST',
      body: '{}',
    })
    const doc = { engineSessionId: created.sessionId, title, createdAt: new Date().toISOString() }
    const current = this.getBinding(dshSessionId)
    const next: SessionBinding = { docs: [...current.docs, doc], activeEngineSessionId: doc.engineSessionId }
    await this.table.put(dshSessionId, next)
    this.changed(dshSessionId, next)
    return doc
  }

  async setActive(dshSessionId: string, engineSessionId: string): Promise<BoundDocument> {
    const current = this.getBinding(dshSessionId)
    const doc = current.docs.find((item) => item.engineSessionId === engineSessionId)
    if (!doc) throw new Error('该文稿不属于当前 DSH 会话，无法切换。')
    const next = { ...current, activeEngineSessionId: engineSessionId }
    await this.table.put(dshSessionId, next)
    this.changed(dshSessionId, next)
    return doc
  }

  async updateTitle(dshSessionId: string, engineSessionId: string, title: string): Promise<void> {
    const current = this.getBinding(dshSessionId)
    if (!current.docs.some((doc) => doc.engineSessionId === engineSessionId)) {
      throw new Error('该文稿不属于当前 DSH 会话，无法改名。')
    }
    const next = {
      ...current,
      docs: current.docs.map((doc) => doc.engineSessionId === engineSessionId ? { ...doc, title } : doc),
    }
    await this.table.put(dshSessionId, next)
    this.changed(dshSessionId, next)
  }
}
