# 青简编辑器功能矩阵

对照基线：`qingagent/wt/dsh-bridge@0470d41d4ee8` 的
`apps/web/src/pages/workspace/components/WorkspaceDocumentPane.tsx` 完整挂载面。

| 功能 | 状态 | 核查结果 |
| --- | --- | --- |
| DocToolbar 浮动工具栏 | 可用 | 按 `canUseDocumentEditing(dim, null, null)` 挂载青简原件；选区显隐、加粗和 `TableSizePicker` 插表已由真实 DOM 测试覆盖。标题、对齐、列表、引用、链接、颜色/高亮、图片、表格、分栏、callout、代码块、公式和 Mermaid 均走原命令闭包。 |
| BlockHandle 块菜单与拖拽 | 可用 | `DocumentSnapshotView` 在 `interactiveEditable` 下挂载原件；图片入口获得资产桥会话。 |
| TableControls 行列操作 | 可用 | 向 `DocumentSnapshotView` 补传 `onAiModify` 后解除原挂载条件，原行列增删、选择、合并/拆分与轴拖拽保留。 |
| ColumnDnD 分栏拖拽 | 可用 | 原 `ColumnView` / `ColumnDnD` extension 随 `DocumentSnapshotView` 同源挂载。 |
| CodeBlock 语言菜单 | 可用 | 原 `CodeBlockCM` / `CodeBlockView` NodeView 挂载；fixture DOM 已核查代码块结构。 |
| DiagramView：Mermaid | 可用 | 原 Mermaid 渲染、交互工具栏和双击编辑链随 NodeView 打包。 |
| DiagramView：drawio | 可用 | `DrawioEditorOverlay`、JSON embed 协议、maxGraph 回退渲染与写回链随原件 1:1 打包；宿主只读发布青简 `public/drawio`（v31.0.2，约 24 MiB）到同源 `/drawio/*`，不依赖远程 iframe。审阅态双击仅提示，不会进入编辑器或产生写事务。 |
| MathEditPopover | 可用 | 原公式点击事件、保存、删除和关闭链由 `DocumentSnapshotView` 挂载。 |
| DocFind / Ctrl+F | 可用 | 补挂原 `useWorkspaceFind` 与 `DocFindBar`，Ctrl+F DOM 回归已覆盖。 |
| undo / redo | 可用 | 青简 History extension 原命令链可逆恢复正文，DOM 测试覆盖。 |
| BlockCollapse 折叠 | 可用 | 原 `BlockCollapseExtension`、文稿 ID 绑定和交互命令保留。 |
| LinkHoverCard | 可用 | 原件在 `interactiveEditable` 下挂载。 |
| 图片粘贴 / 工具栏插图 | 宿主完成、待引擎端点 | 原 `insertImageAssets` / `insertUploadedAsset` 未改；上传适配为 base64 JSON，经宿主 `POST /qingagent-bridge/assets` 代理 external `POST /sessions/:id/assets`。PM 始终保存 schema 允许的内部引用，`ImageView` 仅在 DOM 加载层换成无 token 的 GET 桥 URL。青简 external assets 端点仍在并行开发，契约定稿后需按代码 TODO 对齐 multipart/base64 最终形态。 |
| AI 修改选段 / 表格选区 | 环境不适用 | 原按钮与 `AiModifyTarget` 闭包保留；青简本体把引用 chip 写入左侧 `ChatInput`，DSH details slot 当前没有等价的 composer draft/chip 写入口，点击时明确提示，不自造替代 UI。 |

状态含义：

- **可用**：宿主内已挂载原件且依赖闭包闭合。
- **缺依赖**：原件已挂载，但所需静态运行时或服务尚未由宿主发布。
- **环境不适用**：能力依赖青简工作区左栏等宿主不存在的交互表面。
