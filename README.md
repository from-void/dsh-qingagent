# dsh-qingagent

青简 × DeepSeek Harness 写作桥插件。Agent 在 DSH 对话里收敛写作方向后,通过青简引擎起草、局部修改、提交审阅;浏览器右侧同步长出**青简宣纸面板**——与青简桌面端同源的纸面渲染(暖纸、宋体、直角),支持逐条裁决、批注轮播、图编辑与导出。青简文稿是真身,聊天只保留摘要。

## 前提:需要青简

本插件是[青简](https://github.com/from-void/qingagent)的 DSH 前端,**必须安装并运行青简桌面客户端**(它承载文稿引擎与本机数据库):

1. 从 [青简 Releases](https://github.com/from-void/qingagent/releases) 下载安装;
2. 启动一次青简(引擎随之常驻,凭证写入 `~/.qingagent/instance.json`);
3. 之后装好本插件即自动连接;青简未运行时,面板会显示引导卡并在青简启动后自动恢复。

引擎默认监听 `http://127.0.0.1:8080`;Bearer token 只存在于插件 host 进程,**永不进入浏览器**。安装与故障排查详见 [docs/onboarding.md](docs/onboarding.md)。

## 快速开始

要求 Node.js 20+、DSH `0.1.0-rc.6`(profile 已组合 storage hub、storage-domain 及一个 KV 后端,通常是 `@deepseek-ai/dsh-storage-json`)。

```bash
git clone --recursive <本仓地址> dsh-qingagent
cd dsh-qingagent
npm install
npm run check   # CSS 钉扎校验 + 类型 + 测试 + 构建
```

> 忘了 `--recursive` 就补一句 `git submodule update --init`。青简源码以 submodule 钉在 `vendor/qingagent`(构建期依赖,详见下文)。

在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 中加入(路径换成你的检出位置):

```json
{ "dsh-qingagent": "link:/path/to/dsh-qingagent" }
```

或直接:

```bash
dsh plugin --profile web add link:/path/to/dsh-qingagent
```

`package.json` 中的 `dsh.bundle.patch` 会合并仓内 `cordis.patch.yml`;不要同时保留手写挂载与 bundle 挂载,以免双重注册。重启 `dsh web` 生效。

## 能力

**工具面(host)**

- `qing_write_draft`:新建或整篇重构(整篇重构须用户原话授权);
- `qing_edit_draft`:局部修改——`strReplace` / `insertAfterLine` / `appendSection` / `setTitle` / `deleteBlock` / `deleteListItem` / `insertAfterBlock`,结构性操作带请求级 opId 幂等;
- `qing_read_draft`:分级读取(概要 / `mode:"lines"` 行号语料 / `mode:"blocks"` 块 ID / `mode:"base"` 已提交基线);
- `qing_review_commit`:仅在用户明确授权下全量接受/拒绝;
- `qing_list_docs` / `qing_focus_doc`:一个 DSH 会话绑定多篇文稿,切换右侧预览。

**纸面板(client,与青简同源渲染)**

- 青简 web 编辑器源码直接编译进插件(`vendor/qingagent` submodule),纸面观感 1:1:公式、Mermaid、Draw.io(双击可开编辑写回)、表格、脚注、印章落款;
- 审阅态逐条裁决:补丁导航、批注轮播、全文审阅导航;结算后仅在有拒绝项时回流一条结构化【审核结果】消息;
- 审查/导出等文稿功能钮长在纸面原位;「在青简中打开」深链拉起桌面客户端(共享同一本机库);
- 纸上选中文字可作为「选段」chip 插入输入框(支持多条,悬停看全文),发送气泡同样以 chip 样式呈现。

**来源归属**:经外部 API 写入的消息按 `x-qa-client` 标注来源(Claude Code / ChatGPT / DeepSeek Harness),在青简客户端可见。

## 构建期依赖:vendor/qingagent submodule

纸面渲染直接复用青简 `apps/web` 源码与 CSS,构建期从 `QING_ROOT` 读取:

- 默认 `vendor/qingagent`(submodule,**钉死在校验过的 commit**);
- 环境变量 `QING_ROOT=/path/to/qingagent` 可覆盖(本地开发指向自己的青简工作树);
- drawio 离线运行时也从该处发布(`QINGAGENT_DRAWIO_ROOT` 可单独覆盖)。

CSS 按行号从青简样式表中提取(`scripts/extract-qingdoc-css.mjs`),`npm run check:qingdoc-css` 是**部署红线**:升级 submodule 后必须先跑它,行号漂移会导致提取切坏、构建残缺。校验红 = 禁止部署;修钉扎(对齐新行号)后再走全检。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `engineUrl` | `http://127.0.0.1:8080` | 青简引擎根地址 |
| `engineCommand` / `engineCwd` | 未设置 | 可选启动命令,仅 `autoLaunch` 时执行 |
| `autoLaunch` | `false` | 离线时 detached 拉起,卸载插件不杀用户引擎 |
| `sideModel.provider/model` | 未设置 | 当前 Agent 未公开 provider/model 时的回退 |
| `workspaceProjection` | `true` | 兼容字段 |

## 架构与安全边界

- **host**(`lib/index.js`,Node ESM):工具注册、系统提示词、引擎 API 调用与 token 管理、`/qingagent-bridge/*` 同源桥(仅回环地址可访问,doc/focus 校验文稿归属会话)、drawio 资产只读发布;
- **client**(`lib/client.js`,DSH module-loader factory):纸面板、选段 chip、气泡装饰、具名工具状态卡——全部经 DSH 公开插件 API(`registerSource`、scoped events、`ctx.effect` 生命周期)接入,**移除插件即整体消失**;
- 青简仓的所有 CSS 构建时包进 `@scope([data-qingagent-doc-panel])`,不泄漏到宿主界面;
- 绑定数据存于 `@deepseek-ai/dsh-storage-domain` 的 `dsh_qingagent` v1 domain;
- QingML 渲染走白名单重建:`script/style/iframe/object/embed/template` 连内容删除,`on*` / `javascript:` 不进输出。

## 测试

```bash
npm run check          # 全检:CSS 钉扎 + typecheck + vitest + build
npm test               # 仅单测
```

契约测试锁住:纸面 800px 版心、宋体、直角与暖纸色板只作用于面板根;CSS 提取与钉扎行段一致;bridge 回环与会话隔离;QingML XSS 白名单;审阅态拦截与 401 token 重读等。

## License

Apache-2.0(本仓)。`vendor/qingagent` submodule 为 [青简](https://github.com/from-void/qingagent),MIT。
