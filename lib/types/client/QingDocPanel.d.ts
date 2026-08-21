import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client';
import { type DocumentSaveState } from './documentSaveCoordinator.js';
export { computeExternalReviewChangeRatio } from '../reviewMode.js';
export { QingBrandBadge } from './QingBrandBadge.js';
import '../qingdoc/qingdoc.css';
import './QingDocPanel.css';
interface InjectedProps {
    qingLayout: ILayout;
    qingSendMessage?: (dshSessionId: string, text: string) => Promise<void>;
    qingInsertAnnotation?: (instruction: string) => boolean;
}
export type QingDocPanelProps = PropsRuntime<'details'> & InjectedProps;
export declare function QingDocPanel(props: QingDocPanelProps): import("react/jsx-runtime").JSX.Element;
export declare function panelStatus(input: {
    busy: boolean;
    blocks: number;
    words: number;
    pendingReview: boolean;
    reviewCount: number;
    saveState: DocumentSaveState;
    showSaving: boolean;
}): string;
export interface QingDocFunctionsProps {
    sessionId: string;
    engineSessionId: string;
    title: string;
    reviewDisabledReason: string | null;
    exportDisabledReason: string | null;
    onFlushSave: () => Promise<void>;
    onToast: (message: string) => void;
    onSendMessage?: (dshSessionId: string, text: string) => Promise<void>;
}
/** 青简纸面原生功能区；组件与 DOM 结构对齐 WorkspaceDocumentPane.tsx:436-522。 */
export declare function QingDocFunctions(props: QingDocFunctionsProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=QingDocPanel.d.ts.map