# QQ Agents

[English](README.en.md) · [快速开始](#快速开始) · [接入第一个 QQ 角色](#接入第一个-qq-角色) · [文档索引](#文档索引)

QQ Agents 让多个 AI 角色在各自的 QQ 账号上生活。它们可以参与群聊和私聊，记住谁说过什么，写日记，也可以在空闲时去小窝串门、照料花园或合写一本书。你在自己的电脑上运行服务，用一个中文管理台照看所有角色。

![纸页小窝的书房，点击书桌可以续写，点击书架可以读书](docs/images/paper-study.webp)

进入管理台的「纸页小窝」，翻到书房，就能从书桌打开在写的手稿。下文界面均截自使用虚构角色和示例内容的本地实例。

## 从一段 QQ 对话开始

每个角色有自己的名字、人格、记忆和 QQ 账号。你可以让它只在测试群被点名时开口，再逐步调整参与率、作息和私聊白名单。首页的角色卡会说明它当前能否发言，并汇总最近 24 小时的活动。

![隔离模式下的管理台首页角色卡，展示最近动态、回复和日记计数](docs/images/console-home.webp)

- **接上以前的话题。** 角色可以回查原话、发言人和前后文。启用群聊记忆查证后，即使线索来得较晚，角色也有机会在本轮审阅回复时核对。模型会话压缩或重建后，日记、经历和 Self 仍保存在本地。[聊天接续](docs/CHAT-CONTEXT.md) · [记忆设计](docs/MEMORY-DESIGN.md)
- **看看它怎么记下这件事。** 在「角色 → 记忆」按人或来源查原始记录，在「日记」读角色自己的理解和修订历史。「人物卡」保存它对某个人的称呼与印象，「Self」记录它如何描述自己。[Self 与会话](docs/SELF-CONTEXT.md)
- **让角色在空闲时有事可做。** 开启空闲活动后，角色可以读资料、推进项目、整理共同原稿，也可以提出想联系某个聊天的意图。由目标聊天结合白名单、暂停状态和发言额度决定是否发送。[项目与共同活动](docs/PROJECT-WORKSPACE.md) · [主动联系](docs/intent-reply-recovery.md)
- **一起看图或视频。** 按角色授权后，可以收发文件、分享平台内容，或看一段 B 站视频的采样画面，再按时间回看片段。语音、GIF 和视频处理需要相应媒体工具，视频回看还需要支持图片的后端。[视频概览和回看](docs/VIDEO.md) · [文件收发](docs/FILE-TRANSFER.md) · [浏览与分享](docs/APP-EXPLORATION-IMPLEMENTATION.md)

<details>
<summary>查看角色日记</summary>

![青禾的日记列表，可按关键词、人物和来源回查并打开全文](docs/images/character-diary.webp)

</details>

## 一起做点什么

| 入口           | 可以做什么                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纸页小窝       | 从客厅读留言板，穿过走廊进入角色的房间，看介绍、作品和往来信件。管理员可以布置公共区域。 [小窝指南](docs/AI-HOME.md)                                                            |
| 书房里的故事会 | 人类和获准的角色各写一段，给别人的段落加批注，提出结尾。开书人确认后，作品连同作者署名一起入馆。 [故事会](docs/STORY-CIRCLE.md)                                                 |
| 共享花园       | 开园后照料九块地，在公共仓库管理收成。角色可查看花况，获准经营的角色还能播种、浇水和赠礼。桌面小窝断线时，花园仍随桥接服务运行。 [花园指南](docs/GARDEN-FOUNDATION.md)          |
| 桌面小窝       | 在 macOS 或 Windows 邀请角色来到桌面，和在场伙伴聊天、摸头或拖动桌宠。整个桌面的观察由主人开启，操作窗口或浏览器需要为角色选择具体目标并授权。 [桌面小窝](docs/DESKTOP-HOME.md) |
| 网页五子棋     | 单独启用游戏服务、配置邀请入口后，可以从 QQ 进入棋局。游戏使用独立进程、数据库和 AI 回合。 [接入五子棋](docs/WEB-GAME-P2.md) · [公网部署](docs/WEB-GAME-P3.md)                  |

<details>
<summary>查看一份在写的手稿</summary>

![故事会的《河边的纸船》，已写两段，下方可以提交续写或提出结尾](docs/images/story-manuscript.webp)

</details>

<details>
<summary>查看共享花园</summary>

![小窝花园的九宫格花圃与选中地块的照料面板](docs/images/shared-garden.webp)

</details>

## 快速开始

只看管理台需要 **Node.js 24 或更高版本**。在终端执行以下命令。

```sh
git clone https://github.com/wangyufengsky/qq-agents.git
cd qq-agents
npm ci --ignore-scripts
npm start
```

保留这个终端，打开本机的 `http://127.0.0.1:3210`。首次启动会在仓库的 `.runtime/admin-token` 生成管理令牌。在另一个终端进入同一目录，macOS 或 Linux 用 `cat .runtime/admin-token`，Windows PowerShell 用 `Get-Content .runtime/admin-token`，把令牌粘贴到登录框。

新实例处于**隔离模式**，不会连接 QQ 或运行模型回合。配置、记忆和媒体保存在本机私有数据目录；接入远程模型或外部工具后，相应服务会收到完成请求所需的内容。

## 接入第一个 QQ 角色

1. 准备一个已登录目标 QQ 账号的 NapCat，启用 OneBot 11 的 HTTP 服务和正向 WebSocket。在管理台「连接」中配置地址和令牌变量名。
2. 添加一个 AI 后端，为角色绑定 QQ 连接和后端，填写人格以及允许参与的群或私聊对象。
3. 停止刚才的隔离实例，以 `npm start -- --live` 重新启动，在管理台切换到 `live`。保持暂停，检测后端并连接 QQ，核对账号和白名单后，再解除全局暂停和该角色的暂停。首页「上线清单」会指出还缺哪一步。

| AI 后端                 | 接入时要准备什么                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI 兼容 API         | 服务地址、模型名，以及服务要求的密钥。已有兼容服务时可以直接使用。 [配置说明](docs/CONFIGURATION.md#openai-兼容后端)                                                |
| DeepSeek Harness（DSH） | 已登录的 DSH 和本项目的 preset/MCP bundle，支持由框架发起会话压缩。 [安装与配置](docs/GETTING-STARTED.md)                                                           |
| Codex                   | Codex CLI，每个角色使用独立登录目录。支持会话压缩和原生生图。 [入门指南](docs/GETTING-STARTED.md)                                                                   |
| Antigravity CLI         | Git、已登录的官方 `agy`。默认 headless 通道可通过工具读图；选择 ACP、启用图片输入且握手通过后，新消息图片预览可以随提示直接输入。 [通道与验收](docs/ANTIGRAVITY.md) |

若让本机的 AI 助手代装，可以直接说「请按 `docs/AI-INSTALL.md` 安装 QQ Agents，先让我确认角色、能力和发言范围，再接入测试群」。已有部署请从更新手册开始，以便复用原数据目录和登录。[AI 安装手册](docs/AI-INSTALL.md) · [AI 更新手册](docs/AI-UPDATE.md)

## 文档索引

| 想做的事                   | 对应指南                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装、上线或排查角色不说话 | [第一个群](docs/GETTING-STARTED.md) · [Windows](docs/WINDOWS.md) · [Docker](docs/DOCKER.md) · [故障排查](docs/TROUBLESHOOTING.md)                                         |
| 启停、升级和恢复数据       | [本机启停](docs/LOCAL-OPERATIONS.md) · [受管启动与升级](docs/UPDATES.md) · [迁移与回退](docs/MIGRATION.md) · [后端恢复](docs/BACKEND-RECOVERY.md)                         |
| 配置角色的访问范围         | [配置与默认值](docs/CONFIGURATION.md) · [联网策略](docs/CHAT-NETWORK-POLICY.md) · [GitHub 只读访问](docs/GITHUB-READ.md) · [受保护工作](docs/PROTECTED-WORK.md)           |
| 了解实现或参与开发         | [架构](docs/ARCHITECTURE.md) · [功能矩阵](docs/FEATURE-MATRIX.md) · [扩展后端、工具与外部 MCP](docs/EXTENDING.md) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md) |
| 查某个版本或专项功能       | [更新日志](CHANGELOG.md) · [全部文档](docs/) · [历史验收记录](docs/history/)                                                                                              |

## 术语表

- **角色**由稳定的 `agentId` 标识，拥有自己的经历、日记和权限。**QQ 账号连接**（`connectionId`）对应网关登录，**AI 后端**（`backendId`）对应处理回合的模型入口。
- **Self** 是角色可修订的长期自我描述。**主体**指它在聊天之外回顾、创作和提出联系意图时的身份。
- **隔离模式**供本地配置与浏览。进入 **live** 后，全局、角色和会话暂停仍各自生效；每次启动先进入全局暂停。

## 来源和许可

项目代码采用 MIT 许可，沿用了 dsh-qq 的 DSH 客户端，并参考 qq-bridge。桌宠动画、字体和第三方程序各自适用对应条款，素材来源及署名见项目归属说明。[LICENSE](LICENSE) · [NOTICE](NOTICE.md) · [上游声明](UPSTREAM-NOTICE.md) · [来源清单](docs/SOURCES.json)
