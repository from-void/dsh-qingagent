import type { DocumentSnapshotViewHandle } from '@qingweb/pages/workspace/components/DocumentSnapshotView';
import { type DocumentFrameDecision } from '@qingweb/pages/workspace/data/docWriteResultOwnership';
import type { ExternalPmDocReadResponse } from '../contracts.js';
export interface DocumentWriteActivity {
    pendingDocWrite: boolean;
    queuedDocWrite: boolean;
}
export declare function decideIncomingPanelDocument(input: {
    handle: DocumentSnapshotViewHandle;
    panelDoc: ExternalPmDocReadResponse;
    activity: () => DocumentWriteActivity;
    reviewActive: boolean;
    reviewBaseVersion?: number | null;
    /** defer 必须先登记本会话来稿版本，再 drain 保存；否则 drain 中的 409 无法识别自产版本。 */
    onDeferred?: (panelDoc: ExternalPmDocReadResponse) => void;
    afterFlush?: () => Promise<void>;
}): Promise<DocumentFrameDecision>;
//# sourceMappingURL=incomingPanelDocument.d.ts.map