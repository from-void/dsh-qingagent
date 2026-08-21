import type { Editor } from '@tiptap/react';
import type { AnnotationGroup } from '@qingagent/contract-ts';
import type { ExternalAnnotation } from '../contracts.js';
export declare function externalAnnotationsToGroups(annotations: readonly ExternalAnnotation[]): AnnotationGroup[];
export declare function QingAnnotationCarousel(props: {
    annotations: readonly ExternalAnnotation[];
    editor: Editor | null;
    onAccept: (group: AnnotationGroup, suggestion: string) => boolean;
    onIgnore: (group: AnnotationGroup) => void;
}): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=annotationCarousel.d.ts.map