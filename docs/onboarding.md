# Quick Start

dsh-qingagent 依赖本机运行的青简桌面端。插件不会把青简的 Bearer token 发送给浏览器；host 会从 `~/.qingagent/instance.json` 读取当前实例信息，并只通过回环地址连接青简。

## 1. 安装青简

从 [青简官网](https://qingagent.com) 下载适合当前系统的最新版本并完成安装。

## 2. 启动一次青简

打开青简并保持运行。首次启动会创建 `~/.qingagent/instance.json`，其中包含本次本机实例的端口、版本、attach 协议版本和临时访问令牌。

## 3. 安装 dsh-qingagent

在插件源码目录完成依赖安装与构建，然后以包名安装到 DSH profile：

```bash
npm install
npm run build
dsh plugin --profile web add link:/你的路径/dsh-qingagent
```

开发期如果手工维护 profile，也必须通过 `dsh-qingagent` 包名挂载，不能直接指向 `lib/index.js`，否则 DSH 无法发现浏览器侧面板。

## 4. 等待自动连接

启动 DSH 后，插件会立即探测青简。未连接时，右侧纸面板显示三步引导；青简就绪后会自动恢复正常文稿面板，无需重启 DSH。

探测失败后会在后台按 5、10、20、30 秒的间隔重试，之后保持 30 秒封顶；连接恢复后回到常规健康检查节奏。

## 故障排查

### 提示“未检测到可用的青简引擎”

- 确认青简已经安装，并至少成功启动过一次。
- 确认青简仍在运行；如果刚启动，请等待几秒让插件自动重连。
- 检查当前系统用户下是否存在 `~/.qingagent/instance.json`。
- 不需要手工刷新页面或重启 DSH。

### 提示“检测到青简，但握手失败”

引导卡会显示具体原因，不应把这类问题当作“未安装”：

- `401` 或实例令牌失效：完全退出青简后重新启动，让它刷新 `instance.json`。
- `instance.json` 损坏或字段不完整：完全退出青简，移走损坏文件，再重新启动青简生成新文件。
- 版本不符：`instance.json` 记录的版本与实际监听服务不一致，通常说明残留了旧进程；退出所有青简进程后重新启动。
- `attachProtocolVersion` 不兼容：升级青简到 Releases 中的最新兼容版本。
- 健康检查返回非预期 HTTP 状态或无效响应：确认目标端口没有被其他程序占用。

修复后保持青简运行即可，插件会在下一轮探测时自动恢复。

### 工具返回“未连接青简”

`qing_write_draft`、`qing_edit_draft`、`qing_review_commit`、`qing_read_draft`、`qing_list_docs` 和 `qing_focus_doc` 都使用同一连接保护。先按工具消息中的具体原因处理并启动青简；不要让 Agent 猜测文稿是否已经创建或提交。连接成功后重新发出原写作请求即可。

### 自定义端口或启动命令

默认引擎地址是 `http://127.0.0.1:8080`。只有明确使用自定义部署时才修改插件的 `engineUrl`。可选的 `autoLaunch` 还要求同时配置 `engineCommand`；一般桌面用户直接手动启动青简即可。
