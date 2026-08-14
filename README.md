# dsh-qingagent

青简 × DeepSeek Harness 写作桥。Agent 在 DSH 中收敛写作方向后调用 `qing_write_draft`，主机端用当前 Agent 模型旁支生成 QingML、提交到本机青简引擎；浏览器右侧 details 列同步长出暖墨纸系文稿。青简文档是真身，聊天只保留摘要。

批次 1 已覆盖“新建/整稿重写 → 流式预览 → 青简提交/待审阅”的闭环，不包含审阅操作界面、公式/图表真渲染和工作区导出。

## 能力

- `qing_write_draft`：新建或整稿重写；按完整顶层 QingML 块向浏览器广播，400 结构诊断只修正重试一次。
- `qing_read_draft`：默认读取标题层级、每节首句和字数；显式 `mode: full` 才回传全文 QingML。
- `qing_list_docs` / `qing_focus_doc`：一个 DSH 会话可绑定多篇青简文稿，激活指针只决定视图和默认读取对象。
- `ctx.qingagentEngine`：instance 文件/PID 探测、1.5 秒 health 超时、Bearer 封装、401 重读 token、自启动与 20 秒轮询。
- `/qingagent-bridge/*`：只接受回环请求的 state/doc/focus/SSE 同源桥；青简 token 不进入浏览器。
- 宣纸面板：DOMParser 白名单重建，支持任务、callout、分栏、高亮、附件、脚注，以及公式/Mermaid/Draw.io 安全占位。

## 环境与构建

要求 Node.js 20+、DSH `0.1.0-rc.6`，并确保 profile 已组合 storage hub、storage-domain 及一个 KV 后端（通常是 `@deepseek-ai/dsh-storage-json`）。青简默认监听 `http://127.0.0.1:8080`，运行时凭证由 `~/.qingagent/instance.json` 提供。

```bash
cd /home/jimmy/proj/dsh-qingagent
npm install
npm run check
# 或使用已配置的 pnpm：pnpm build
```

构建输出为 `lib/index.js`（Node ESM host）、`lib/client.js`（DSH module-loader CJS factory）和 `lib/types/`。React 18 与 DSH 平台模块保持 external；CSS Modules 在 client factory 物化时注入带 `data-plugin="dsh-qingagent"` 的 style 标签。

## 本地 profile 挂载

不要把 `lib/index.js` 的绝对路径直接写成插件名：那会绕过 package manifest，使 `dsh.client` 无法发现浏览器半区。开发期应把仓库作为 link dependency，再用包名插入；效果仍是直接加载本仓最新构建产物。

在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 中加入：

```json
{
  "dsh-qingagent": "link:/home/jimmy/proj/dsh-qingagent"
}
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 追加以下可复制片段（本仓不会代为修改用户 profile）：

```yaml
- insert:
    - id: qingagent
      name: 'dsh-qingagent'
      config:
        engineUrl: 'http://127.0.0.1:8080'
        autoLaunch: false
        workspaceProjection: true
        # 当前 Agent 没有公开 provider/model 时才使用此回退：
        # sideModel:
        #   provider: deepseek
        #   model: deepseek-chat
```

安装正式 bundle 时可改用：

```bash
dsh plugin --profile web add link:/home/jimmy/proj/dsh-qingagent
```

`package.json` 中的 `dsh.bundle.patch` 会合并仓内 `cordis.patch.yml`；不要同时保留手写挂载与 bundle 挂载，以免双重注册。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `engineUrl` | `http://127.0.0.1:8080` | 青简服务根地址 |
| `engineCommand` | 未设置 | 可选启动命令；只有同时启用 `autoLaunch` 才执行 |
| `engineCwd` | 未设置 | 启动命令工作目录 |
| `autoLaunch` | `false` | 离线时 detached 拉起，卸载插件不杀用户引擎 |
| `sideModel.provider/model` | 未设置 | 当前 `exec.agent.options` 缺失时的显式回退 |
| `workspaceProjection` | `true` | 批次 1 只保留兼容字段，尚不执行工作区导出 |

## 数据与安全边界

绑定数据使用 `@deepseek-ai/dsh-storage-domain` 的 `dsh_qingagent` v1 domain、`bindings` table；实际落盘介质由 profile 的 storage-domain route 决定，本插件不直接接触 JSON 后端。记录形状为：

```ts
{
  [dshSessionId]: {
    docs: Array<{ engineSessionId: string; title: string; createdAt: string }>
    activeEngineSessionId?: string
  }
}
```

桥接路由检查 `req.socket.remoteAddress`，只放行 `127.0.0.1`、`::1` 和 IPv4-mapped loopback。doc/focus 还校验目标文稿属于所给 DSH 会话。浏览器只能看到文稿与引擎状态，Bearer token 只存在于 host `Authorization` header。

QingML 渲染不是把输入 HTML 原样塞进页面：解析后逐节点创建新树，只复制标签/属性白名单；`script/style/iframe/object/embed/template` 连同内容删除，未知普通标签只保留安全子内容，`on*`、`javascript:`、data image 均不会进入输出。

## 实际接缝与证据

本实现按 rc.6 的公开类型面编写，未依赖私有对象：

- 工具：`@deepseek-ai/dsh-tools/lib/types/index.d.ts`、`schema.d.ts`——`defineTool`、严格 output schema、`ToolRunContext.agent/signal`、`timeoutMs`、presenter。
- 侧模型：`@deepseek-ai/dsh-llm/lib/types/index.d.ts`、`types.d.ts`、`message.d.ts`——`ctx.llm.stream`、`GenerateOptions`、`StreamChunk`、`createUserMessage`。
- 当前模型：`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`——公开的 `Agent.options.provider/model`；因此优先复用当前 Agent，`sideModel` 只是回退。
- HTTP：`@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts`——原生 Node `IncomingMessage/ServerResponse` route handler。
- 持久化：`@deepseek-ai/dsh-storage-domain/lib/types/index.d.ts`、`spec.d.ts`、`domain.d.ts`——`defineDomain`、`domainTable`、`Domain.table().get/put/update`。
- Prompt：`@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts`——`ctx.systemPrompt.section({ name, order, text })`。
- Client slot：`@deepseek-ai/dsh-client-runtime/lib/types/client/slots.d.ts`、`dsh-client-ui-layout/lib/types/client/index.d.ts`/`service.d.ts`、`dsh-client-ui-tool/lib/types/client/contract/slots.d.ts`——唯一 `slots.inject/register` 组合、details 单槽、keyed tool view、`layout.openDetails()`。
- 青简提案与鉴权：`qingagent/wt/dsh-bridge/packages/contract-ts/src/ExternalPropose.ts`、`packages/server/src/routes/external.ts`、`packages/server/src/app.ts`——实际请求为 `expectedDocVersion + ops:[{kind:'qingmlDraft',qingml}]`，且当前 external 子树连 health 也要求独立 Bearer，不采用早期简写/免鉴权假设。
- QingML：`qingagent/main/docs/model-notes/qingml-spec.md`；视觉 tokens：`qingagent/main/packages/ui-kit/src/tokens.css`。

## 取舍与已知缺口

- `details` 是 single slot；本插件以 `priority: -10` 接管整列。无绑定、无流时组件返回 `null`，但此时不会回退显示官方 tool-details occupant，这是 DSH 单槽 shadow 语义的结果。
- 已有文稿的整稿提案进入青简审阅。面板保留刚生成的预览并显示待审阅提示；接受/拒绝与权威版本刷新属于批次 2。
- 待审阅候选正文只存在本次页面的流式缓冲；刷新后 external doc 端点只提供权威已提交版本，因此仍显示“待审阅”但不能恢复候选全文。
- `math-block`、Mermaid、Draw.io 只显示安全等宽占位，不加载第三方渲染器。
- `workspaceProjection` 按规格保留默认值，批次 1 不导出工作区文件。
- 字数是 UI 进度估算：中日韩逐字、拉丁/数字连续串逐词；不用于 token 计费。

## 测试

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run --ignore-scripts
```

单测覆盖 QingML 白名单/XSS、自定义标签转换、流式顶层块边界与提纲、BindingStore 新建/聚焦/改名、Engine offline 降级和 401 token 单次重读。
