# 更新日志

按时间倒序排列。每节对应一个版本、一轮可靠性工作或一个合并的 PR；详细的验收、审查和讨论记录保存在 [`docs/history/`](docs/history/)。“合并”不代表部署：除非另有说明，以下改动都只在本机隔离环境验证，生产角色保持暂停。

2026-10-28 公开之后的条目用本仓库的 PR 链接；更早条目中的 `#编号` 指公开前私有仓库中的 PR，与本仓库的 Issue/PR 编号无关。

## 交给 AI 安装（2026-10-28）

- 新增 [AI 安装手册](docs/AI-INSTALL.md)：用户把仓库交给 Claude Code、Codex、DSH 等助手，助手就能按步骤完成安装、部署 NapCat 和管理台、生成配置和上线。全程只在扫码登录、输入 API key、确认上线这三处停下来等用户。README 中英文版都加了“让 AI 帮你装”一节。
- `npm run setup`：`init` 把答案文件生成为隔离、暂停状态下的配置，随机生成 OneBot 令牌，并写好 NapCat 的 `onebot11_<QQ号>.json`（保留原有的其他服务和文件权限，先备份）；`secret` 用不回显的方式写入密钥；`live --confirm` 和 `unpause --confirm` 负责上线。
- `npm run doctor`：只读检查 Node、FFmpeg、配置、配置用到的密钥（只检查是否存在，不显示值）、管理台状态和各角色无法发言的原因、OneBot 登录的账号、后端可用性，`--json` 输出每项的修复命令。
- 启动时（`npm start`、Docker）会读取数据目录的 `secrets.json`，补上启动终端里没有设置的环境变量，和 `scripts/robots.mjs` 原来的做法一致。

## 受保护记忆召回与会话恢复（2026-10-28）

- 群聊和非管理员私聊在读取前隔离受保护的日记、事件、工作笔记和意图，避免普通记忆搜索读入私有来源后持续无法回复。管理员私聊和主体仍保留原有读取与披露边界。
- 新增管理端会话恢复接口：暂停目标会话后归档旧上下文，建立不含受限交接的新上下文；保留原始记忆、发送账本和限额，并阻止旧回调写回。详见 [受保护记录](docs/protected-mind-records.md)。

## Windows 支持（2026-10-28）

- CI 增加 `windows-latest`，三个平台运行同一套 `npm run verify`；新增 `.gitattributes` 统一使用 LF 换行。
- Codex 在 Windows 上通过 `cross-spawn` 启动 npm 安装的 `codex.cmd`；平台浏览子进程的脚本路径改用 `fileURLToPath`；公开网页截图自动查找 Windows 上的 Chrome 和 Edge。
- Windows 上关闭控制台窗口（`SIGHUP`）和 Ctrl+Break（`SIGBREAK`）与 Ctrl+C 一样正常停止并释放数据目录锁。
- 新增 [在 Windows 上运行](docs/WINDOWS.md)：PowerShell 启动与环境变量、三种后端的配置、NTFS 下数据目录的放置，以及 `robots.mjs`、本地语音合成等不可用的功能。

## 开源发布（2026-10-28）

- 仓库公开为 [wangyufengsky/qq-agents](https://github.com/wangyufengsky/qq-agents)：历史只带入 `main`，提交身份改写为 GitHub 隐私邮箱，旧 PR 编号改为文字说明；新增 [安全策略](SECURITY.md)，开启私下报告漏洞。迁移方式见 [公开前检查](docs/PUBLIC-READINESS.md)。
- **Linux / Docker 部署**（[#10](https://github.com/wangyufengsky/qq-agents/pull/10)）：`Dockerfile`、含 NapCat 的 `docker-compose.example.yml` 和 [Docker 部署](docs/DOCKER.md)。连接新增显式开启的 `allowPrivateNetwork`，开启后 OneBot 地址可用 Docker 服务名或私有网段（令牌以明文经过容器网络），默认仍只允许本机回环；启动参数新增 `--host` 和 `--public-port`，容器内监听 `0.0.0.0` 时管理台仍只接受回环 Host。截图浏览器支持 `CHROME_PATH` 和 Linux 常见路径；本地 TTS 在非 macOS 上返回可读的不可用提示。CI 新增镜像构建与冒烟测试，Ubuntu 上安装 FFmpeg 改为不装推荐依赖并单独限时。
- **文档**（[#3](https://github.com/wangyufengsky/qq-agents/pull/3)）：README 说明项目定位（可直接部署的自托管应用，扩展点有限）并对比三种后端；新增英文版 [README.en.md](README.en.md)、[扩展指南](docs/EXTENDING.md)、入门“最快路径”，以及第三方平台读取默认关闭、需自行遵守平台条款的说明。
- **社区**（[#2](https://github.com/wangyufengsky/qq-agents/pull/2)）：新增 [贡献指南](CONTRIBUTING.md)、[行为准则](CODE_OF_CONDUCT.md)（Contributor Covenant 2.1 中文版）、Issue/PR 模板和 Dependabot 配置。
- **开发**（[#4](https://github.com/wangyufengsky/qq-agents/pull/4)）：ESLint 覆盖 `src`、`scripts`、`test`、`public` 全部代码（`vendor` 除外）；类型检查改为按文件 `// @ts-check` 纳入，从 4 个文件扩大到 51 个，包括 `src/backends` 和 `src/github` 全部。
- **CI 修复**（[#1](https://github.com/wangyufengsky/qq-agents/pull/1)）：修复控制台测试与启动时自动加载之间的时序竞争；隐私扫描接受 GitHub Actions 机器人的隐私邮箱。

## OpenAI 兼容后端（2026-10-28）

- 新增 `type: "openai"` 后端：直接调用兼容 Chat Completions 的 API，工具在桥接进程内执行，会话历史保存在数据目录 `openai/<agentId>/sessions/`。可恢复的错误（网络、5xx、响应格式）续接一次且不重放已完成的工具调用。
- 后端声明能力（压缩、原生生图），运行时按能力决定是否提供 `generated_image_list`；OpenAI 兼容后端两者都不支持。
- 管理台「连接」页的 AI 后端可选择该类型并填写地址、密钥变量、上下文窗口、图片输入和思考强度开关。详见 [OpenAI 兼容后端](docs/CONFIGURATION.md#openai-兼容后端)。

## 表单精简与样式统一（2026-10-28）

- “浏览与分享”设置只显示开关、平台和浏览时段，读取/分享额度、有效期、时区等收进“高级设置”。
- “作息与定时”拆成“唤醒与回复节奏”（关键词、指定发言者、拍一拍、入群、安静与合并窗口）和“定时任务设置”（启用、时区、免打扰），其余收进各自的“高级设置”。字段名不变，保存结果与之前一致。
- 必填项在折叠区里校验失败时会自动展开该区，不再静默无法提交。
- 动态列表与其他列表使用同一种行样式；每个表单只有一个主要保存按钮。
- 修复：在权限或浏览页面原样保存会重排工具顺序，被当作配置变化而结束该角色当前回合；现在保持原有顺序。

## 首页重做（2026-10-27）

- 首页以角色为主：每个角色一张卡片，显示能否发言、最近一条动态、最近 24 小时的回复数、空闲时间中有行动的次数、读过的文章与写过的日记，以及下次空闲时间；可直接“查看动态”或进入“设置”。
- “需要处理”合并受限动作授权与待核对发送，没有时只显示“暂无”；最近错误收进可展开的区块。去掉了四张数量卡片。
- 新接口 `GET /api/home`，只读汇总；头像改用名字最后一个字，名字前缀相同时也能区分。

## 管理台导航改为四个分区（2026-10-27）

- 左侧导航由 13 项改为 **首页 / 角色 / 连接 / 系统**。
- “角色”分区顶部统一选择角色并显示其能否发言，下面的标签页为 动态 / 设置 / Self 与主体 / 记忆与日记 / 作息与定时 / 浏览与分享 / 文件 / 语音，全部跟随所选角色；原先各页自带的角色下拉框不再显示。
- “连接”把 QQ 账号与 AI 后端放在同一页；“系统”包含运维与运行设置。
- 首页角色卡片新增“查看动态”，直接打开该角色的动态页。各页面内容与操作不变。

## 暂停黑话学习，修复小问题（2026-10-27）

- 黑话学习暂停对外提供：不运行 learner、不向模型提供 `slang_*` 工具、管理台隐藏入口，`/api/slang` 返回 `SLANG_FEATURE_DISABLED`；配置项保留兼容，已有候选不删除。开发时可用 `QQ_AGENTS_EXPERIMENTAL_SLANG=1` 启用。
- 修复偶发失败的 `child-env` 测试：等子进程写完完整 JSON 再读取。
- Self 页主体设置说明更正：修改权限或联系范围只结束该角色当前回合，不需要重新连接 QQ。导航“词汇与运维”更名为“运维”。

## 角色动态时间线（2026-10-27）

- 管理台新增“动态”页：按角色列出每一次聊天回复和空闲时间，附上这一回合实际做的事——空闲时间日志、发出的消息、浏览（同一帖子的列表、正文和评论合并，评论可展开）、搜索、日记、主动意图和用到的工具。
- 可按全部 / 空闲时间 / 聊天回复 / 浏览筛选，分页加载；内部的黑话学习回合不显示。
- 新接口 `GET /api/activity`，只读汇总现有记录，不改存储。

## 主体空闲时间（2026-10-27）

- 主体回合改为“空闲时间”：去掉“可不行动”的引导，每次新开会话，用程序生成的素材（上次线索、最近动态、可用入口与额度、分享去向）代替空的“新增消息”。
- 新增仅主体可用的 `subject_log` 工具和每回合工具上限；所有回合记录工具调用（名称、成败、耗时）。
- 管理台 Self 页新增空闲时间日志与 24 小时活动统计。详见 [Self 与上下文](docs/SELF-CONTEXT.md#空闲时间主体回合)。

## 文档整理（2026-10-27）

- README 改为使用指南：快速开始、核心概念、上线步骤、启动方式选择、按任务分组的文档索引和术语表。
- 新增 [入门指南](docs/GETTING-STARTED.md)、[故障排查](docs/TROUBLESHOOTING.md) 和 [配置与数据目录](docs/CONFIGURATION.md)；原 README 的功能列表移入 [功能说明](docs/FEATURES.md#功能一览)。
- 各轮验收、审查和讨论记录移入 `docs/history/`，原链接已更新。

## 暂停与权限写入统一提交（#45，2026-10-27）

暂停、App 权限与文件权限的写入统一经过按影响范围的配置提交，与其他配置修改使用同样的版本检查和冲突处理。

## QQ 接收通道自动重连（#44，2026-10-27）

管理员手动连接过的 QQ 账号连接在意外断开后按指数退避自动重连（默认最多 8 次，可按连接关闭）。只恢复接收，不重发、不补录断线期间的消息；登录账号不匹配时立即停止（`QQ_ACCOUNT_MISMATCH`），重试用尽后显示 `QQ_AUTO_RECONNECT_EXHAUSTED`。

## 待核对发送与“当前无法发言”原因（#43，2026-10-27）

管理台总览新增“待核对发送”：网络结果未知的发送由管理员在 QQ 中核对后标记已发出/未发出，两种结论都不会重发。每个角色卡片列出当前无法发言的具体原因。

## 凭据过滤、会话暂停与发送前取消（#42，2026-10-27）

收窄凭据过滤（普通词语不再误拦 QQ 发送）；暂停单个会话只取消该会话的回合；已预留但尚未提交网关就被取消的发送记为失败（`CANCELLED_BEFORE_SEND`），而不是结果未知。

## 第五轮：调度、配置隔离与维护边界（#41，2026-10-27）

到期索引、按影响范围提交配置、运行时与工具职责拆分、增量质量门禁和默认配置收尾。记录：[RELIABILITY-ROUND-FIVE](docs/history/RELIABILITY-ROUND-FIVE.md)。

## 第四轮：有界导出与浏览游标（#40，2026-10-27）

管理台、HTTP、CLI 导出和 App 分页存储的大小上限与完整性恢复。记录：[RELIABILITY-ROUND-FOUR](docs/history/RELIABILITY-ROUND-FOUR.md)。

## 第三轮：发送预算、文件库恢复与静默语义（#39，2026-10-27）

角色总发送额度、文件库损坏恢复和相等静默时间的明确处理。记录：[RELIABILITY-ROUND-THREE](docs/history/RELIABILITY-ROUND-THREE.md)。

## 第二轮：审批标识与子进程凭据边界（#38，2026-10-27）

移除管理台状态中的模型 capability，收紧 Codex 与原生 QQ 子进程默认继承的环境变量。说明：[CREDENTIAL-BOUNDARIES](docs/CREDENTIAL-BOUNDARIES.md)。

## 第一轮：停机、配置提交与错误诊断（#37，2026-10-27）

进程退出与在途任务收敛、配置版本与提交、错误分类和管理台“最近错误”。记录：[RELIABILITY-ROUND-ONE](docs/history/RELIABILITY-ROUND-ONE.md)。

## 回合恢复、受保护笔记与 GitHub 只读（#32–#36，2026-10-26）

- 意图取消后恢复普通回复：[intent-reply-recovery](docs/intent-reply-recovery.md)（#36）。
- 受保护的工作笔记、聊天意图与文件：[protected-mind-records](docs/protected-mind-records.md)（#35）。
- 可恢复的后端会话不重放 QQ 发送：[turn-recovery](docs/turn-recovery.md)（#34）。
- 管理台顶部补回“解除全局暂停”（#33）。
- 按角色的 GitHub 只读搜索与公开前检查：[GITHUB-READ](docs/GITHUB-READ.md)、[PUBLIC-READINESS](docs/PUBLIC-READINESS.md)（#32）。

## 资料库、后端恢复与主体用量（#27–#31，2026-10-26）

- 原生生图登记、图片/文件留存和网页/App 内容页截图：[SAVED-MEDIA](docs/SAVED-MEDIA.md)（#28）。
- AI 后端连接状态与自动恢复：[BACKEND-RECOVERY](docs/BACKEND-RECOVERY.md)（#27）。
- 日记可读视图、主体历史与额度、短聊天节奏（#29–#31）。
- 当时的完成状态与剩余事项：[STATUS](docs/history/STATUS.md)。

## 连续聊天、联网策略与管理台改版（#19–#26，2026-10-25）

- 连续聊天与联网策略：连续回复预算随可信人类新输入推进；公开请求按精确参数和来源授权；浏览时段可关闭或仅约束自主浏览。旧配置兼容。说明：[CHAT-NETWORK-POLICY](docs/CHAT-NETWORK-POLICY.md)（#21，#26）。
- GIF 动图阅读：图片读取自动返回带时间信息的动图采样帧，并支持逐帧分页，见 [功能说明](docs/FEATURES.md#gif-动图阅读)（#20）。
- Prompt 与 Self 的职责：[PROMPT-CONTRACTS](docs/PROMPT-CONTRACTS.md)（#19）。
- 管理台改版、参与率热更新与 QQ 媒体下载修复（#22–#25）。

## 迁移准备与记忆连续性（#13–#18，2026-10-25）

迁移前修复与隔离演练、迁移记忆连续性、别名与目标账号一致性、退役会话回调保护。记录：[QUALITY-MIGRATION-READINESS](docs/history/QUALITY-MIGRATION-READINESS.md)、[QUALITY-MEMORY-CONTINUITY](docs/history/QUALITY-MEMORY-CONTINUITY.md)。迁移步骤见 [MIGRATION](docs/MIGRATION.md)。

## App 自主浏览与 QQ 分享（#12，2026-10-25）

按角色开启 B 站、小黑盒、知乎、小红书、贴吧的读取与分享，主体提出意图，目标聊天决定是否发送。说明：[APP-EXPLORATION-IMPLEMENTATION](docs/APP-EXPLORATION-IMPLEMENTATION.md)；规格讨论：[APP-EXPLORATION-DISCUSSION](docs/history/APP-EXPLORATION-DISCUSSION.md)。

## Self 复审修复（#11，2026-10-25）

六个复审问题的修复与联合验收契约。记录：[SELF-REVIEW-FIXES](docs/history/SELF-REVIEW-FIXES.md)。

## Self、主体意图与上下文管理（#10，2026-10-25）

SQLite 版本化 self 与延后回顾、逐回合同步、75% 整理和延迟重建、主体思考到目标聊天的意图交接。管理台可编辑/恢复 self、配置主动范围和查看用量。旧数据升级前须备份并确认外形锚点。说明：[SELF-CONTEXT](docs/SELF-CONTEXT.md)；验收：[QUALITY-SELF-CONTEXT](docs/history/QUALITY-SELF-CONTEXT.md)；规格：[PROMPT-CONTEXT-DISCUSSION](docs/history/PROMPT-CONTEXT-DISCUSSION.md)。

## 0.4.0：外部工具发现与场景证据读取（#8，#9，2026-10-24）

- HTTP/SSE/stdio MCP 白名单目录、受控图像和音频结果、本机可选 TTS；跨时间明确引用/撤回、重叠片段去重、事件稳定游标与中文 FTS 加速。真实平台、两后端和 20 万条合成压测的结果与限制见 [QUALITY-0.4](docs/history/QUALITY-0.4.md)。ASR 与常驻图像生成服务仍待配置。
- 自主文件收发：管理台“权限”页可分别开启每个角色的下载与发送权限；各角色使用独立文件库，普通收发不逐项确认，默认关闭。说明：[FILE-TRANSFER](docs/FILE-TRANSFER.md)；额度、文件库恢复见第三轮记录。
- 合并前审查：[PR-REVIEW-0.4](docs/history/PR-REVIEW-0.4.md)。

## 0.3.0：场景记忆与自主回忆（2026-10-24）

场景化记忆、来源与自主表达。设计：[MEMORY-DESIGN](docs/MEMORY-DESIGN.md)；当时的本地统一验收：[ACCEPTANCE](docs/history/ACCEPTANCE.md)；功能对照：[FEATURE-MATRIX](docs/FEATURE-MATRIX.md)。

## 0.2.x：统一多角色桥接（2026-10-24）

首个统一多角色桥接（旧调度与媒体能力迁入）、隔离的真实后端验收（0.2.1）以及 QQ 转发卡片和 Codex 投递确认修复（#3–#6）。真实后端验收工具：[LOCAL-ACCEPTANCE](docs/LOCAL-ACCEPTANCE.md)。
