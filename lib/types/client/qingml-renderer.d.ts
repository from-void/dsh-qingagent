export interface RenderedQingml {
    html: string;
    title: string | null;
    footnotes: number;
}
/** DOMParser 只解析；输出树由白名单逐节点重建，源节点和属性不会直接进入 innerHTML。 */
export declare function renderQingml(qingml: string, parser?: DOMParser): RenderedQingml;
//# sourceMappingURL=qingml-renderer.d.ts.map