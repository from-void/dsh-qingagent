import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client';
import { type QingClientSnapshot } from './store.js';
/** 工具卡的具名文案与摘要装配;meta 来自各工具的 presentationMeta(#23)。 */
export interface QingToolCardConfig {
    runningTitle: string;
    doneTitle: (meta: ToolCardMeta) => string;
    failedTitle: string;
    /** 完成态摘要;返回空串则不渲染摘要段。 */
    summary: (meta: ToolCardMeta, snapshot: QingClientSnapshot) => string;
    /** 完成态叙述;返回空串则不渲染第二行。 */
    narrative?: (meta: ToolCardMeta, snapshot: QingClientSnapshot) => string;
    /** 运行态摘要(如写作流式字数);缺省为空。 */
    runningSummary?: (snapshot: QingClientSnapshot) => string;
    /** 失败态是否隐藏「查看」按钮以外,默认所有卡都带「查看」入口(与写作卡一致)。 */
    showViewButton?: boolean;
}
export interface ToolCardMeta {
    engineSessionId?: string;
    title?: string;
    blocks?: number;
    words?: number;
    status?: string;
    reviewCount?: number;
    acceptedCount?: number;
    rejectedCount?: number;
    adopted?: boolean;
    count?: number;
    scope?: string;
    mode?: string;
    wholeDocReview?: boolean;
    patchIds?: string[];
    summaries?: string[];
}
interface InjectedProps {
    qingLayout: ILayout;
}
type Props = PropsRuntime<'tool.call.toolview'> & InjectedProps;
export declare function createQingToolCard(config: QingToolCardConfig): (props: Props) => import("react/jsx-runtime").JSX.Element | null;
/** 工具卡「查看」统一入口：旧卡只开面板，具名稿聚焦，已确认删除的稿保留 missing 纸面。 */
export declare function openToolCardDocument(sessionId: string, engineSessionId: string | undefined, snapshot: QingClientSnapshot, openDetails: () => void): void;
export declare const QingEditToolCard: (props: Props) => import("react/jsx-runtime").JSX.Element | null;
export declare const QingReviewCommitToolCard: (props: Props) => import("react/jsx-runtime").JSX.Element | null;
export declare const QingReadToolCard: (props: Props) => import("react/jsx-runtime").JSX.Element | null;
export declare const QingListMaterialsToolCard: (props: Props) => import("react/jsx-runtime").JSX.Element | null;
export declare const QingReadMaterialToolCard: (props: Props) => import("react/jsx-runtime").JSX.Element | null;
export declare const QingListDocsToolCard: (props: Props) => import("react/jsx-runtime").JSX.Element | null;
export declare const QingFocusToolCard: (props: Props) => import("react/jsx-runtime").JSX.Element | null;
export declare const QingAnnotateToolCard: (props: Props) => import("react/jsx-runtime").JSX.Element | null;
export declare function failureSummary(content: readonly unknown[]): string;
export {};
//# sourceMappingURL=QingToolCard.d.ts.map