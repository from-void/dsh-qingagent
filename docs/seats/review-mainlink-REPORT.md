# 席 R 批次三交付报告

## 改动清单

### 任务 A：bridge 代理

- `src/bridge.ts` 新增模板列表/选择/创建/更新/删除、文档级补充要求、external 词库清单和审查素材列表代理；全部通过 `engine.fetchInternal` 转发到 `/api/v1/external/*`，并保留上游状态码与错误体。
- 新增 `/qingagent-bridge/review-turn` 打标及发送失败撤销端点。打标状态和工具运行时通过同一 `EngineService` 身份共享，不写磁盘。
- 批注写入没有再开浏览器 bridge 路由，`qing_annotate` 由服务端工具直连 external engine，符合 SPEC 允许的简化路径。

### 任务 B：`qing_annotate`

- `src/tools.ts` 注册纯批注工具，参数覆盖引擎批注组契约；`origin` 不暴露给模型，按活动审查类型注入，引擎再强制存为 `external-plugin`。
- 写入版本取本回合 `qing_read_draft` 产生的 FreshnessTracker 鲜度标记和 ReadTurnTracker 权威快照；未读稿直接拒绝。
- 写批注前必须持有现有回合租约。预申领为 `BUSY_NATIVE` 时不阻断审查读取，真正写入前再走一次完整冷申领。
- 首次 `VERSION_CONFLICT` 会重读 QingML 与 PM 文稿，在最新 PM 文本上逐项重建/验证锚点后仅重试一次；第二次冲突直接保留引擎错误，不再重放。
- 成功卡冻结 `groupCount` 与响应中的 summary，标题为“审查批注已生成 · N 处”；失败卡保留当次失败事实。成功后刷新 DocState，面板在引擎帧及现有 `turn-ended` 链路读回批注。

### 任务 C：审查回合状态机

- 新增 `src/reviewTurn.ts`：pending → `agent/pre-step` active → stopping/error/dispose 清理，活动态记录审查类型、模板和 DSH turn id。
- 审查首步沿用现有 AgentTurnLeaseCoordinator 预申领当前钉住文稿；`BUSY_NATIVE` 不向 agent pre-step 抛错。
- 活动审查回合中的 `qing_write_draft` / `qing_edit_draft` 在任何引擎访问前以钦定文案拒绝。
- 审查 `agent/error` 按终态立即释放租约；普通回合仍保留原有 step-error 非终态语义。

### 任务 D：统一审查发起链

- `QingDocPanel.tsx` 直接导入 vendor 真源 `ReviewLaunchModal`，八类审查（含 `deai`）统一走 review templates；已删除插件侧旧 Deai 内联模板。
- 真源依据：`vendor/qingagent/apps/web/src/pages/workspace/components/ReviewLaunchModal.tsx:13` 为八类元数据，`:85` 为完整注入 props，`:144` 为组件入口，`:430` 为确认/阻断区，`:456` 为模板编辑器，`:469` 表明 AI 起草只在传入可选 `onAiDraft` 时开放。
- 模板 CRUD、选择和补充要求均已桥接。真源没有统一的 template editor 禁用 prop，因此没有改造 UI；AI 起草按裁定省略 `onAiDraft`，不显示入口。
- external 词库清单映射为真源 summary；多选保存只更新当前弹窗内存，不调用持久化接口，确认时把本次所选词库注入指令。
- 来源核查在打开弹窗和最终发送前各检查一次素材列表，只有 `parseState === "ready"` 才放行；无素材使用真源钦定阻断文案。
- 指令直接调用 `vendor/qingagent/packages/contract-ts/src/ReviewQuery.ts:42` 的 `assembleReviewQuery`；真源专项契约位于 `:14`、`:22`、`:31`，插件只替换四个工具名并传入词库，不再拼接旧 DSH 审查动线。
- 发送顺序为 review-turn 打标 → `qingSendMessage`；消息发送失败会撤销 pending 标记，成功 toast 保持不变。

### 提示词与构建类型

- `system-prompt.ts` 收口为“审查回合只读全文并生成批注”，明确禁止正文写改/裁决及格式模拟批注，不再描述用 `qing_edit_draft` 落审查结果。
- build 专用声明补充 ReviewLaunchModal、ReviewTemplate、Lexicon 与 `assembleReviewQuery` 类型；没有修改 vendor，也没有变更 CSS 钉扎源。

## 与 SPEC 的偏差/裁定落实

- 未实现 `/qingagent-bridge/review-annotations`：服务端工具直接调用 engine external 批注路由，SPEC 明确允许该方案。
- 没有 AI 模板起草：真源 `onAiDraft` 是可选 prop，本期按补充裁定不传入；没有自造替代交互。
- 模板编辑器未禁用：真源只有运行时 capability 判定，没有注入式禁用 prop；为保持真源交互，已把 CRUD 全部接到 external 模板接口。若引擎未开启模板 mutation capability，上游会按契约拒绝并由真源显示保存失败。
- external 引擎只提供词库清单，没有词条详情接口，因此未传 `loadLexiconEntries`；词库清单、多选和指令注入不受影响。
- 准备命令受托管权限限制：标准 submodule 初始化无法写共享 `.git/modules`，已从本机现有 qingagent 仓库恢复 vendor 到钉定提交 `1217dd6aa1c88f3a739d66775ef587749cfb610a`，未 bump；`pnpm install --prefer-offline` 因默认 store 只读、临时 store 又缺私有离线包而失败，最终复用同锁文件基线的只读依赖并为 Vite 缓存建立本 worktree 可写目录。产品源码验证不受影响。

## `index.tsx` 待接线项

- 审查主链无待接线项；沿用既有 `qingSendMessage` prop 即可，`src/client/index.tsx` 未改。
- 真源在来源阻断区提供可选 `onAddMaterial`。当前 DSH 没有已授权的素材添加入口，所以没有传入该回调；阻断与二次校验完整生效。若后续协调人提供宿主素材入口，需要在不仿造 UI 的前提下把该动作传入面板。

## 测试结果

- `npm run check`：通过。
  - CSS 钉扎检查：通过。
  - telemetry 脱敏同步检查：通过。
  - TypeScript typecheck：通过。
  - Vitest：48 个文件、485 项测试全部通过。
  - server/client 生产构建：通过。
- 新增/更新回归覆盖：bridge external 路由；打标→首步激活→写/改拒绝→stopping/error 清理；预申领忙碌再申领；未读稿拒绝；一次版本冲突重建重试；二次冲突原样返回；成功/失败卡事件快照；八类指令 snapshot；统一 Deai；来源素材阻断；敏感词瞬态多选与清单注入。
- `git diff --check`：通过。
- 禁止文件 `src/client/chipPresentation.ts`、`src/client/annotationReference.ts`、`src/client/index.tsx`：均无改动。

## 遗留风险

1. 真源来源阻断区的“添加素材”按钮依赖可选 `onAddMaterial`；本批没有可用的 DSH 宿主动作，按钮保留真源形态但无回调，需后续宿主接线。
2. 模板选择/CRUD 与补充要求写入取决于部署引擎的 template mutation capability；若部署关闭该能力，真源确认动作会显示设置保存失败，需由部署侧按 external 模板契约开启，而不能由插件伪造本地模板状态。
3. 批注帧由引擎发布；插件面板的最终权威刷新仍依赖现有回合 `turn-ended`。若宿主异常退出且不发 stopping/dispose，只能等待既有租约过期/重连恢复。
4. 当前沙箱把共享 Git 元数据挂为只读；源码和报告已完成，但分任务提交需要在恢复 `.git/worktrees/review-main` 写权限后执行。

## 建议提交拆分

1. `feat(review): 接入审查 bridge 与回合状态机`
2. `feat(review): 增加纯批注工具与冲突重建`
3. `feat(review): 统一真源审查发起链`
4. `test(review): 覆盖审查批次三契约`
5. `docs(review): 添加席 R 交付报告`
