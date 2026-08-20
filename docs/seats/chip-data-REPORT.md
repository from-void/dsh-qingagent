# 席 C 实施报告：chip 数据/结构层

## 改动清单

- `src/client/selectionReference.ts`
  - 将选区 chip 预览长度从 5 放宽为 14，并公开为 `CHIP_LABEL_PREVIEW_LENGTH`。
  - 同步 `selectionReferenceLabel` 内部引用；原有插入幂等守卫、ref 组装和 source 行为保持不变。
- `src/client/annotationReference.ts`
  - 新增 `QING_ANNOTATION_REFERENCE_SOURCE`、`annotationReferenceLabel`、`insertAnnotationReference` 与恒等 codec 的 `qingAnnotationReferenceSource`。
  - 新增 `findOccurrenceProjection`，精确支持 U+FFFC 单字符和 `@label` 多字符（含至多一个尾随空格）两种运行时投影。
  - 新增 plain phase 守卫下的 `removeOccurrenceFromDraft` 与 `replaceOccurrenceRef`；替换使用删除后的最新 `draftRev`，新插入失败时重建旧 occurrence，重建也被拒绝时恢复原草稿文本。
- `src/client/QingDocPanel.tsx`
  - 新增可选 prop `qingInsertAnnotation?: (instruction: string) => boolean`。
  - 批注采纳改为插入 chip，成功提示“已填入修改要求，请点击发送”，失败提示“输入框当前不可用，请稍后再回填批注”；保留 `turnRunningEffective` 门槛，不再代发消息。
- 测试
  - 新增 `tests/annotation-reference.test.ts`，覆盖标签截断、恒等 codec、重复插入、两种投影、phase 拒绝、首尾/相邻 occurrence、特殊字符 label、定位失败安全返回、按 source 重算 label 和替换失败回滚。
  - 更新选区 chip 的 14 字 label 断言。
  - 在 `QingDocPanel` 生命周期测试中 mock `qingInsertAnnotation`，验证成功/失败提示及不调用 `qingSendMessage`。

## 接口偏差

- 无。冻结函数名、参数、返回值和 prop 签名均按 SPEC 实现。
- 按席位边界未修改 `src/client/index.tsx`。**待整合层在 `index.tsx` registerSource(`qingAnnotationReferenceSource`)**，并把当前会话的 `insertAnnotationReference` 包装为 `QingDocPanel` 的 `qingInsertAnnotation` prop。

## 测试结果

- 定向测试：`npx vitest run tests/annotation-reference.test.ts tests/selection-chip.dom.test.ts tests/qingdoc-panel-save-lifecycle.test.tsx`
  - 3 个测试文件、60 个测试全部通过。
- 完整质量门：`npm run check`
  - QingDoc CSS 同步检查通过。
  - telemetry redact 同步检查通过。
  - TypeScript typecheck 通过。
  - Vitest：46 个测试文件、455 个测试全部通过。
  - 服务端与客户端构建通过。
- `pnpm install --prefer-offline`
  - 已执行；沙箱禁止写用户级 pnpm SQLite store，改用 `/tmp` 可写 store 后，本机 store 缺少部分 tarball 且沙箱网络返回 `EPERM`，因此完整重新物化无法在本环境完成。
  - 已从相同 `pnpm-lock.yaml` 的本地依赖树恢复 `node_modules`，确认虚拟 store lock 与当前 lockfile 完全一致；随后 `pnpm install --prefer-offline --lockfile-only --store-dir /tmp/qingagent-chip-pnpm-store-ready` 成功，且上述完整质量门全绿。

## 遗留风险

- `qingAnnotationReferenceSource` 未注册前，宿主提交时无法路由 annotation ref codec；必须由整合层完成上述 `index.tsx` 接线。
- occurrence 定位对未知第三种投影形态会安全返回 `undefined`/`false`，不会猜测删除；若宿主未来再改变投影格式，需要在精确识别规则与回归测试中显式扩展。

## 提交状态

- 已执行 `git add`，但本会话对共享 Git 元数据 `/home/jimmy/proj/dsh-qingagent/.git/worktrees/chip-data` 只有只读权限，Git 无法创建 `index.lock`，因此不能在此环境完成暂存和 commit。
- 源码与报告均已留在当前 worktree；协调人取得 Git 元数据写权限后可执行：
  - `git add REPORT.md src/client/selectionReference.ts src/client/annotationReference.ts src/client/QingDocPanel.tsx tests/selection-chip.dom.test.ts tests/annotation-reference.test.ts tests/qingdoc-panel-save-lifecycle.test.tsx`
  - `git commit -m "feat(client): 新增批注 chip 数据原语"`
