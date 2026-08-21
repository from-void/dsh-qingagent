import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client';
export { failureSummary } from './QingToolCard.js';
interface InjectedProps {
    qingLayout: ILayout;
}
export type QingWriteToolCardProps = PropsRuntime<'tool.call.toolview'> & InjectedProps;
export declare function QingWriteToolCard(props: QingWriteToolCardProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=QingWriteToolCard.d.ts.map