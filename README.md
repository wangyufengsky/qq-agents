# QQ Agents

QQ Agents 用一个本机管理台同时管理多个 AI 角色：每个角色绑定一个 QQ 账号（通过 NapCat/OneBot 接入），由 DSH 或 Codex 作为 AI 后端生成回复，并拥有各自独立的人格、记忆、日记和权限。所有新配置默认处于隔离模式并全部暂停，确认无误后再逐步放开。

## 5 分钟快速开始

**需要：** Node.js 24 或更高版本（内置 SQLite）。语音处理需要 FFprobe/FFmpeg，GIF 动图阅读需要 FFmpeg（可用 `FFMPEG_PATH` 指定）。只看管理台不需要 QQ 或 AI 后端。

1. 安装依赖：

   ```sh
   npm ci --ignore-scripts
   ```

2. 启动管理台（默认数据目录为当前目录下的 `.runtime/`，端口 3210）：

   ```sh
   npm start
   ```

3. 取得管理令牌。首次启动会在数据目录生成 `admin-token`：

   ```sh
   cat .runtime/admin-token
   ```

4. 用浏览器打开 `http://127.0.0.1:3210`（必须用 `127.0.0.1` 或 `localhost` 访问），在登录框粘贴令牌。令牌不放进 URL，也不会打印到日志。

新建的配置使用示例占位账号、空白名单、停用的连接、暂停的角色和隔离模式。**启动管理台不会启动 QQ、DSH 或模型回合**，可以放心浏览每个页面。

需要指定独立数据目录或端口时：

```sh
node src/main.mjs --data /path/to/private-data --port 3210
```

接入第一个真实角色的完整步骤见 [入门指南](docs/GETTING-STARTED.md)。

## 核心概念

- **角色**：一个 AI 身份，有稳定的 `agentId`、人格、记忆和日记。每个角色只绑定一个 QQ 账号连接和一个 AI 后端；不同角色之间不能互读记忆。（管理台「角色」页。）
- **QQ 账号连接**：一个 NapCat/OneBot 实例，使用 HTTP + 正向 WebSocket。连接前会核对实际登录的 QQ 号，不匹配时拒绝接入。（管理台「连接」页。）
- **AI 后端**：生成回复的模型服务，目前支持 DSH（DeepSeek Harness 桌面应用）、Codex（本项目专用的 Codex app-server，独立登录目录）和任意 OpenAI 兼容 API（一个地址加一个密钥即可，见 [OpenAI 兼容后端](docs/CONFIGURATION.md#openai-兼容后端)）。DSH 和 Codex 功能最全；OpenAI 兼容后端不支持上下文压缩和原生生图。多个角色可以共用一个后端配置。（管理台「连接」页。）
- **隔离模式与暂停**：`mode: isolated` 时不会连接 QQ、不会运行模型回合。切到 `live` 之后，仍有几道独立的开关：全局暂停（每次启动都会自动打开）、角色暂停、会话暂停和静默时段。任意一道没放开，角色都不会发言；管理台在每个角色卡片上列出“当前无法发言”的具体原因。

更多术语见 [术语表](#术语表)。

## 上线步骤

先在隔离模式下配置好角色、QQ 账号连接和 AI 后端，再按顺序：

1. 以 `--live` 重新启动（`npm start -- --live`，或用下文的 `scripts/robots.mjs`）。
2. 在管理台把运行模式设为 `live` 并保存。
3. 启用目标 QQ 账号连接，然后手动点击连接，确认显示“已连接”。
4. 在角色配置里填好群聊/私聊白名单（只有白名单内的会话会被接收和回复）。
5. 解除全局暂停。
6. 解除目标角色的角色暂停。

之后如果角色仍不说话，看角色卡片上“当前无法发言：…”列出的原因，对照 [故障排查](docs/TROUBLESHOOTING.md#机器人不说话)。

## 用哪个启动方式

| 场景                                                                                                                                          | 用法                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 第一次试用、开发调试、隔离模式验证；想在前台看日志，按 Ctrl+C 停止                                                                            | `npm start`（等同 `node src/main.mjs`），真实接入加 `-- --live`                              |
| 已配置好的数据目录日常运行：后台运行、自动带上 `--live`、从 `secrets.json` 注入环境变量、可选择连接成功后自动解除全局暂停、管理 macOS 原生 QQ | `node scripts/robots.mjs start --data <数据目录>`，详见 [本机运维](docs/LOCAL-OPERATIONS.md) |

两者使用同一个数据目录格式，但同一数据目录同一时间只能被一个进程使用（有进程锁）。配置为 `mode: live` 的数据目录如果不带 `--live` 启动，`npm start` 会以 `LIVE_CONFIG_REQUIRES_EXPLICIT_LIVE_FLAG` 拒绝启动；`robots.mjs` 会按配置自动加上该参数。

## 文档索引

**开始使用**

- [入门指南：在一个群里接入第一个角色](docs/GETTING-STARTED.md)
- [故障排查（按症状查找）](docs/TROUBLESHOOTING.md)
- [配置与数据目录](docs/CONFIGURATION.md)

**日常运维**

- [本机启停与旧桥接退役（`scripts/robots.mjs`）](docs/LOCAL-OPERATIONS.md)
- [AI 后端连接状态与恢复](docs/BACKEND-RECOVERY.md)
- [回合失败与会话恢复](docs/turn-recovery.md)
- [迁移、部署与回退](docs/MIGRATION.md)
- [真实后端的本地验收](docs/LOCAL-ACCEPTANCE.md)
- [公开前检查与提交身份扫描](docs/PUBLIC-READINESS.md)
- [安全策略与漏洞报告](SECURITY.md)

**功能指南**

- [功能说明：主动调度、语音、图片与旧工具](docs/FEATURES.md)
- [连续聊天与联网策略](docs/CHAT-NETWORK-POLICY.md)
- [自主文件收发](docs/FILE-TRANSFER.md)
- [图片、截图与文件资料库](docs/SAVED-MEDIA.md)
- [平台浏览与分享](docs/APP-EXPLORATION-IMPLEMENTATION.md)
- [GitHub 只读访问](docs/GITHUB-READ.md)
- [Self、主体意图与会话管理](docs/SELF-CONTEXT.md)
- [意图取消与普通回复](docs/intent-reply-recovery.md)
- [受保护的工作笔记、聊天意图与文件](docs/protected-mind-records.md)

**设计与参考**

- [架构与身份边界](docs/ARCHITECTURE.md)
- [场景记忆、来源与自主表达](docs/MEMORY-DESIGN.md)
- [Prompt 与 Self 的职责](docs/PROMPT-CONTRACTS.md)
- [审批标识与子进程凭据边界](docs/CREDENTIAL-BOUNDARIES.md)
- [基线与功能对照](docs/FEATURE-MATRIX.md)

**历史记录**

- [更新日志](CHANGELOG.md)：按版本和轮次列出变化，并链接到 [`docs/history/`](docs/history/) 中的验收、审查和讨论记录。

## 术语表

| 术语                | 含义                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 角色                | 一个 AI 身份（配置中的 `agents[]`），用 `agentId` 标识。文档中旧称“机器人”“智能体”“AI”均指角色。                            |
| QQ 账号连接         | 配置中的 `connections[]`，一个 NapCat/OneBot 实例及其登录的 QQ 号。                                                         |
| AI 后端             | 配置中的 `backends[]`，即 DSH、Codex 或 OpenAI 兼容 API。                                                                   |
| DSH                 | DeepSeek Harness 桌面应用。本项目通过它的 Web RPC 接入，并可生成专用的 preset/MCP bundle（`npm run dsh:bundle`）。          |
| self                | 角色可长期成长的自我描述（性格、喜好、关系、表达倾向），按版本保存在 SQLite，可在管理台「Self 与主体」查看和恢复。          |
| 主体                | 角色在聊天之外的“自己”：在空闲时回顾 self、读取资料、提出要联系谁的意图；主体本身没有 QQ 发送能力，由目标聊天决定是否发送。 |
| 隔离模式 / live     | 配置 `mode`。`isolated` 不连接 QQ、不运行模型回合；`live` 需要以 `--live` 启动才能启用。                                    |
| 全局暂停 / 角色暂停 | 两道独立开关。每次启动都会打开全局暂停；解除全局暂停不会解除角色暂停。                                                      |
| 会话暂停 / 会话静默 | 针对单个群聊或私聊。会话暂停由管理员设置；会话静默是角色自己选择安静一段时间（`qq_set_silence`）。                          |
| L0–L3               | 管理员私聊运维权限等级。L0 无运维权限（默认）；L1 只读普通文件；L2 写入需逐项确认；L3 需额外开关、TOTP 和独立命令批准。     |

## 来源和许可

MIT。保留上游 [LICENSE](LICENSE)、[原 NOTICE](UPSTREAM-NOTICE.md) 和 [本项目归属说明](NOTICE.md)。版本及文件摘要见 [`docs/SOURCES.json`](docs/SOURCES.json)。

本项目基于 [h-D-ACE/dsh-qq](https://github.com/h-D-ACE/dsh-qq) 的 DSH 客户端与发现模块，参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，整合本地双机器人项目的 Codex RPC、互聊边界与平台读取模块。仓库不分发 QQ/NapCat/DSH/Codex 应用或 SnowLuma SDK；外部程序适用各自许可。
