# 评测 r3 两缺陷修复报告

## 改动清单

### 1. `setTitle` 扣留与审阅结算对齐

- 新增运行时 `PendingTitleCoordinator`，按 `dshSessionId + engineSessionId` 为每稿保留一个最新标题槽。
- `qing_edit_draft` 同批收到 `setTitle` 与正文操作时，只向引擎提交正文操作；同时兼容新提示约定，在单独 `strReplace` 命中与旧稿名相同的 H1 时自动记录目标稿名。
- 正文直落或审阅全部结算后回读生效 QingML：第一个 H1 与目标去空白后一致才经 external proposal 的 `setTitle` 通道补发，从而保留引擎 `titlePinned` 语义；不一致即丢弃。
- 结算为单飞、幂等、可重入；部分裁决仍处于 `pendingReview` 时保留槽位，并发刷新不会重复补发。补发失败保留重试机会，但后到标题、整稿重写、删除或 dispose 会使旧请求失效，不能复活旧槽。
- 面板 `review-verdicts`、`review-commit` 与文稿直写沿既有 `documentChanged` 链统一触发结算；`qing_review_commit` 工具也在裁决后触发。批注 ignore 不触发标题结算。
- 新的 `qing_write_draft`、引擎会话缺失、agent dispose 与插件 dispose 会清理对应槽位；普通 turn 结束不清理。
- 系统提示、工具描述和 `setTitle` 参数描述已改为：正文有同名 H1 时只改纸面标题，稿名在正文生效后跟随；没有同名 H1 时才直接 `setTitle`。
- 保留纯 `setTitle` 的原直发通道；补发后尽量回读引擎真实稿名，以同步引擎的长标题截断结果。

### 2. chip 复制完整载荷

- 在 capture 阶段监听 composer textarea 的 `copy` / `cut`。
- 选区与本插件 occurrence 投影相交时，按 offset 顺序拼接选区：普通文本保留，投影段替换为各 occurrence 的完整 `clipboardText`。
- 支持多枚相邻 chip 独立展开，以及仅选中投影一部分时仍完整展开该 occurrence。
- textarea 值与当前 `InputState.draft` 不一致时不接管，避免宿主状态更新间隙按旧 offset 展开错误载荷；普通文本复制完全交回宿主。

## 偏差

- `cut` 采用任务书允许的安全降级：写入完整剪贴板文本并阻止原生删除，toast 固定为“已复制,请手动删除”。未手动拼接宿主 draft diff，避免跨 chip 选区破坏 occurrence。
- 环境将主仓 Git 管理目录挂为只读：`git add` 无法创建 `/home/jimmy/proj/dsh-qingagent/.git/worktrees/r3d/index.lock`，因此无法在本环境完成分任务 commit。建议在具备 Git 元数据写权限的同一工作树执行：
  1. `git add src/pendingTitle.ts src/tools.ts src/bridge.ts src/index.ts src/system-prompt.ts tests/pending-title.test.ts tests/tools.test.ts tests/bridge.test.ts tests/system-prompt.test.ts && git commit -m "fix(title): 扣留候选标题并在审阅结算后补发"`
  2. `git add src/client/chipPresentation.ts tests/chip-presentation.dom.test.ts && git commit -m "fix(chip): 复制时展开批注完整载荷"`
  3. `git add REPORT.md && git commit -m "docs: 记录评测 r3 两缺陷修复验收"`
- 准备阶段的 `git submodule update --init --depth 1` 同样因只读 Git 管理目录不能写 submodule metadata；已从本机缓存的、与 worktree gitlink 完全一致的对象恢复 `vendor/qingagent` 内容。
- `pnpm install --prefer-offline` 因全局 pnpm store 的 SQLite 文件只读而失败；使用锁文件一致的相邻 worktree `node_modules` 完成验证，没有访问网络或修改全局 store。

## 测试

- `npm run check`：通过。
- Vitest：49 个测试文件、509 项测试全部通过。
- TypeScript：`tsc --noEmit` 通过。
- 构建：服务端 ESM 与客户端 CJS 均成功产出。
- 新增覆盖：
  - 混合批次提交给引擎的 ops 不含 `setTitle`。
  - 直接生效正文自动补发稿名。
  - accept 后补发 `setTitle` 且重入不双发。
  - reject 后不补发、不残留。
  - 部分裁决期间保留，全部结算且 H1 不一致时丢弃。
  - 最新标题覆盖旧槽、文稿/会话清理。
  - 纯 `setTitle` 直发不受影响。
  - 两枚 chip、相邻 chip、部分投影、普通文本 copy，以及 cut 降级。
  - bridge 文稿变化与删除清理接线。

## 风险

- pending title 按设计只存在进程内存中；若插件进程在正文进入审阅后、用户裁决前重启，该槽不会跨进程恢复。
- 标题补发与正文结算是两个有序请求；若补发遇到瞬时版本/连接错误，槽位会保留并等待下一次文稿刷新重试。若其间发生整稿重写、删除或新标题覆盖，则旧槽按最新状态丢弃。
- cut 未自动删除原选区，这是明确选择的数据安全降级，不会造成 chip 载荷损坏，但用户需要手动删除原内容。
