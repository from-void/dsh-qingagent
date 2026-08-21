import { type Domain } from '@deepseek-ai/dsh-storage-domain';
import type { BoundDocument, SessionBinding } from './contracts.js';
export declare const BindingDomainSpec: {
    name: string;
    version: number;
    tables: {
        bindings: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, SessionBinding>;
    };
};
export type BindingDomain = Domain<typeof BindingDomainSpec>;
export interface BindingEngine {
    fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
}
export type BindingChanged = (dshSessionId: string, binding: SessionBinding) => void;
export declare class BindingStore {
    private readonly engine;
    private readonly changed;
    private readonly table;
    constructor(domain: BindingDomain, engine: BindingEngine, changed?: BindingChanged);
    getBinding(dshSessionId: string): SessionBinding;
    listDocs(dshSessionId: string): BoundDocument[];
    getActive(dshSessionId: string): BoundDocument | undefined;
    hasDoc(dshSessionId: string, engineSessionId: string): boolean;
    createDoc(dshSessionId: string, title?: string): Promise<BoundDocument>;
    /** 收养一篇既有引擎文稿(青简文库打开):已绑定则仅切换,未绑定则登记并设为活跃。 */
    adoptDoc(dshSessionId: string, engineSessionId: string, title: string): Promise<BoundDocument>;
    setActive(dshSessionId: string, engineSessionId: string): Promise<BoundDocument>;
    updateTitle(dshSessionId: string, engineSessionId: string, title: string): Promise<void>;
}
//# sourceMappingURL=bindings.d.ts.map