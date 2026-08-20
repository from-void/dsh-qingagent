# 席 K 实施报告:chip 呈现/交互层

分支:`feat/chip-ui`(基线 main=v0.1.40)。席位:席 K(呈现/交互层),规格见 SPEC.md「席 K 交付」。

## 改动清单

只新增文件,未改任何现有文件(`index.tsx` / `selectionReference.ts` 等均未触碰):

- `src/client/chipPresentation.ts`(新):导出 `installChipPresentation(deps)`、`ChipPresentationDeps`、`InputState`、`InputOccurrence`、`CHIP_PANEL_SHOW_DELAY` / `CHIP_PANEL_HIDE_DELAY`。
- `tests/chip-presentation.dom.test.ts`(新):vitest + jsdom,13 条用例。
- `REPORT.md`(新):本报告。

五项职责落实:

1. **打标**:`[class*="backdrop"]` 模糊匹配镜像层,其内 `[class*="chip"]` 排除 `chipLabel`/`chipIcon`/`chipInvalid` 修饰类;与 occurrences(offset 升序)按 DOM 顺序配对,仅 `qingagent-selection` / `qingagent-annotation` 两来源打 `data-qing-chip` + `data-qing-occ`。差量打标(只改需要改的属性),幂等可重入;MutationObserver(监听 body childList,过滤浮层自身变更)+ input state 订阅双路触发重打标。
2. **样式注入**:`<style id="qingagent-chip-presentation-style">`,只用 background / box-shadow(spread 描边)/ color / border-radius,零布局影响;选区 rgba(200,169,106,.16)/(.40)/#ece4d4,批注 rgba(176,84,30,.16)/(.45),直角。裸 `@` 不动。
3. **hover 面板**:document.body 单例浮层,position:fixed;mousemove 坐标命中(textarea 上),80ms 开、离开 350ms 关,chip 上方 8px、视口边缘翻转;选段面板=「选段内容」+文稿名(可选)+只读 ref;批注面板=「完整修改指令」+ 96px textarea +「移除」「确认」,确认走 `replaceOccurrenceRef`,失败 toast「输入框当前不可用,请稍后重试」。
4. **✕ 角标**:body 单例浮层,hover 命中即显示在 chip 右上角;自身 mousedown 拦截(preventDefault + stopPropagation,不落焦 textarea)后调 `removeOccurrence`,失败同文案 toast。
5. **测试**:见下。

## 接口偏差

- **`InputState` / `InputOccurrence` 为本地结构类型**:`@deepseek-ai/*` 0.1.0-rc.6 类型包未导出 `InputState`(grep 全 node_modules 无此符号),按 SPEC 真机实测字段定义并 export;TypeScript 结构类型保证整合层传真实快照即可接线,签名形状与 SPEC 冻结接口逐字段一致。
- 其余无偏差:`ChipPresentationDeps` 六字段(含可选 `getDocTitle`)与 SPEC 完全一致,未增删。
- 文案仅用 SPEC 冻结文案;面板与 ✕ 角标的移除失败 toast 复用同一条「输入框当前不可用,请稍后重试」(SPEC 只给出这一条失败文案)。

## 测试结果

`pnpm install --prefer-offline` 后 `npm run check` 全绿(exit 0):

- `check:qingdoc-css` ✓、`check:telemetry-redact` ✓、`typecheck`(tsc --noEmit)✓
- vitest:46 个测试文件 / 451 条用例全部通过(含本席位新增 `tests/chip-presentation.dom.test.ts` 13 条)
- `build`(tsc -p tsconfig.build.json && tsdown)✓ —— 新文件未接入口,构建不引用它,测试文件直接 import

新增测试覆盖(SPEC 第 5 条清单):

- 按序配对与打标:DOM 顺序 ↔ offset 升序配对、只打本插件两来源、修饰类排除、hash 类名变体、订阅重复触发幂等
- 两种投影形态(U+FFFC 单字符 / `@`+label 文本)下 chip 集合增删后 MutationObserver 重打标与标转移
- 面板开合时序(假计时器:80ms 开 / 350ms 关)、鼠标入面板保持、选段/批注面板内容与文稿名省略、定位上方 8px 与贴顶翻转
- 「确认」成功(带新值回调并关面板)/失败(toast 冻结文案且不关)、面板与 ✕ 角标「移除」回调、✕ mousedown 拦截默认行为
- 卸载清理干净:样式标签、浮层 DOM、observer、监听器、打标全清,可重复安装

## 遗留风险

- **配对假设**:chip DOM 顺序与 occurrences offset 升序一一对应(沿用旧 hover title 的配对思路)。若宿主未来对非本插件来源的 occurrence 不渲染 chip,或单输入区出现多个 backdrop 且顺序交叉,配对会错位;命中失败的表现仅是漏打标,不会错删(面板/角标操作都以 `data-qing-occ` 回查 occurrence)。
- **jsdom 无真实布局**:面板定位、翻转逻辑在 jsdom 下 offsetHeight=0,只验证了分支走向;真机视觉需整合后人工验收。
- **mousemove 逐事件命中**:未做 rAF 节流(为测试确定性同步处理);chip 数量极小(<10),实测开销可忽略,若未来输入区 chip 很多可再加节流。
- 批注 chip 的文字颜色 SPEC 未给定,保持宿主原色(只覆盖背景/描边/圆角)。
