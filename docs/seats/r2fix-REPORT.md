# 席 F 交付报告：审查目标钉扎与素材读取工具

## 交付状态

- 任务 B、任务 C 均已实现，`npm run check` 全绿。
- 未启动 dev server，未使用浏览器，未访问任务书禁止的端口，未读写 `~/.qingagent`，未修改其他 worktree 或 `main`。
- 当前沙箱把 worktree 的真实 Git 元数据目录挂载为只读，无法创建 `index.lock`，因此未能生成任务书要求的分任务提交；代码与测试差异均保留在 `fix/review-target-materials` 工作树中。

## 任务 B：审查回合目标钉扎

### 改动清单

- `src/client/QingDocPanel.tsx`
  - 审查弹窗打开时冻结 `engineSessionId`、标题和审查类型。
  - 素材预检、文档补充要求、添加素材深链和最终 `review-turn` 打标均沿用弹窗打开瞬间的目标稿；弹窗打开后切稿不会漂移。
- `src/bridge.ts`、`src/reviewTurn.ts`
  - `POST /qingagent-bridge/review-turn` 接收并校验 `engineSessionId`，拒绝不属于当前 DSH 会话的目标。
  - pending/active review 状态记录 `targetEngineSessionId`。
- `src/tools.ts`
  - `agent/pre-step` 激活审查回合后，以 `targetEngineSessionId` 预申领租约；普通回合仍使用回合起点活跃稿。
  - `qing_read_draft` 省略 `docRef` 时经回合租约解析到钉扎目标。
  - `qing_annotate` 始终写入并校验钉扎目标；新增可选 `docRef` 仅用于显式目标校验。
  - 错传其他 `docRef` 时返回“本审查回合的目标是《…》”；未读目标稿或鲜度不足时也带目标标题。

### Bridge 接口摘要

`POST /qingagent-bridge/review-turn`

请求体：

```json
{
  "dshSessionId": "dsh-session-id",
  "engineSessionId": "popup-focused-engine-session-id",
  "type": "source",
  "templateId": "review-source-default",
  "templateName": "来源核查"
}
```

- `engineSessionId` 必须是当前 DSH 会话已绑定文稿。
- 成功响应保持 `{ "pending": true }`。
- 激活后内部状态把该值保存为 `targetEngineSessionId`，不会根据后来活跃稿重新计算。

## 任务 C：素材读取工具

### 改动清单

- `src/tools.ts`
  - 新增只读工具 `qing_list_materials` 与 `qing_read_material`。
  - 两者通过 `engine.fetchJson` 直连 external 数据面，不经过浏览器 bridge，也不申领写租约。
  - 审查回合解析到 `targetEngineSessionId`；其他回合解析到调用当刻的活跃稿。
- `src/client/QingToolCard.tsx`、`src/client/index.tsx`
  - 注册具名工具卡：“正在读取素材清单 / 已读取素材清单 · N 份”和“正在读取素材 / 已读取素材《名称》”。
  - 素材卡不显示文稿“查看”按钮。
- `src/client/reviewExport.ts`
  - 仅在 SOURCE 真源契约后追加：`素材读取用 qing_list_materials / qing_read_material;素材引文 materialQuote 必须逐字来自素材文本`。
  - 真源契约其余文字及其他审查类型保持不变。
- `src/system-prompt.ts`
  - 增加两项素材工具及审查目标解析的一句说明。

### External 接口与工具输出摘要

引擎 gitlink `cecf06ab7162c710d40c33d1260085e6ba4c9e6d` 的 `external.ts` 实际响应字段已核对。

1. `qing_list_materials`
   - 请求：`GET /api/v1/external/sessions/:id/files`
   - 引擎字段映射：`id -> materialId`、`filename -> name`，保留 `parseState`，非空 `summary` 作为可选字段。
   - 工具输出：`{ materials: [{ materialId, name, parseState, summary? }] }`。
   - 空素材正常返回 `{ materials: [] }`。
2. `qing_read_material`
   - 请求：`GET /api/v1/external/sessions/:id/files/:materialId/text`
   - 工具输出：`{ materialId, name, mime, text, byteLen, truncated }`。
   - `text`、`byteLen`、`truncated` 直接采用引擎响应，不做二次截断或预算处理。
   - `MATERIAL_NOT_FOUND` 等 404 保留引擎错误，不伪造空素材。

## 测试结果

- 任务 B 定向回归：3 个测试文件、125 个用例通过。
- 任务 B/C 联合定向回归：7 个测试文件、180 个用例通过；SOURCE snapshot 已更新。
- `npm run check`：通过。
  - `check:qingdoc-css`：通过。
  - `check:telemetry-redact`：通过。
  - TypeScript `--noEmit`：通过。
  - Vitest：48 个测试文件、497 个用例通过。
  - server/client 构建：通过。
- `git diff --check`：通过。

新增覆盖包括：

- 弹窗打开后切稿，打标请求仍携带弹窗发起稿。
- 打标后活跃稿变化，pre-step 租约、无 `docRef` 读稿及批注仍命中打标稿。
- `qing_annotate` 错稿和未读稿错误包含目标标题。
- 素材清单正常映射、空清单、素材 404、文本截断元数据透传。
- 审查回合内素材工具命中钉扎目标而非后来活跃稿。
- 两张素材工具卡文案、注册和 SOURCE 指令 snapshot。

## 环境说明与遗留风险

1. `git submodule update --init --depth 1` 因外置 `.git/worktrees/r2fix/modules` 只读而失败；为完成验证，从主仓库只读复制了完全相同 gitlink 提交 `cecf06a` 的子模块工作树到本 worktree，排除了 `.git` 指针。
2. `pnpm install --prefer-offline` 的默认 store 数据库不可写，改用 `/tmp` store 后又因缓存缺包且网络受限失败；随后从主仓库只读复制现成 `node_modules` 到本 worktree，完整检查已证明依赖可用。失败安装的半成品保留在 `/tmp/qingagent-r2-node_modules-partial-20260821`。
3. 若目标稿在打标后被删除，工具会按钉扎 ID 得到引擎 `SESSION_NOT_FOUND`，不会静默改投其他活跃稿；这是防止错稿写入的预期 fail-closed 行为。
4. `qing_read_material` 会如实返回引擎的 `truncated`；模型必须把截断文本视为已读取范围，不能假定拿到了素材全文。
5. 构建仍会显示仓库既有的 tsdown deprecated 配置提示，以及第三方 `@maxgraph/core` 的 direct-eval 警告；均未导致检查失败，与本批改动无关。
6. 分任务提交受只读 Git 元数据阻塞。恢复写权限后建议依次提交：
   - `修复审查回合目标钉扎`
   - `新增会话素材读取工具`
   - `补充席 F 交付报告`
