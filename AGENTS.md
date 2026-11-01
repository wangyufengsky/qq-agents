# QQ Agents 开发与交付约定

本文件适用于整个仓库，供在此项目中工作的编码助手使用。先读相关源码和文档再修改；用户当前明确指令优先，子目录有更具体的 `AGENTS.md` 时也要遵守（任务 worktree 里检出的 `AGENTS.md` 副本不算子目录约定）。沟通和用户文档使用中文，代码注释使用英文并解释原因。

本文件只写编码助手特有的流程、边界和陷阱；环境、`npm run verify` 各步骤、隐私身份、提交信息格式、代码约定和管理台规范以 [CONTRIBUTING.md](CONTRIBUTING.md) 为准，这里不再重复。本仓库公开，本文件及其修改不得写入本机路径、真实部署位置、账号或私有运维信息。

## 每项修改的完整流程

本项目维护流程为：**独立 worktree → 开发与验证 → 提交并推送 → PR → CI 通过 → 合并 main → 同步本地主目录 → 更新服务并复查 → 报告与收尾**。代码、配置示例、测试和纯文档修改都按此流程；同一任务的后续修正留在该任务的 worktree。除非用户明确另有安排，不能停在本地改完、PR 已开或仅已合并的阶段。

### 1. 核对现场

确认仓库、远程、当前分支、未提交修改和 `git worktree list`；读取本次涉及的模块（入口见下文“项目入口与模块”和“按任务找入口”）。保留其他任务的工作和正在使用的 worktree，不自动 stash、reset、清理或删除。

### 2. 新建任务 worktree

- `git fetch origin main` 后，从最新 `origin/main` 创建：`git worktree add -b codex/<任务名> <worktree 目录> origin/main`。
- 分支前缀统一用 `codex/`，与使用哪个编码助手无关；`<任务名>` 用简短的英文短横线词组。
- `<worktree 目录>` 放在仓库目录**之外**的一个固定父目录中（例如与仓库同级的 `qq-agents-worktrees/<任务名>`）。不要放在系统临时目录（重启后可能被清空，留下失效的 worktree 记录），也不要放在仓库内的 `work/` 等目录（检出的旧 `AGENTS.md` 会被误读成子目录约定）。
- 在新 worktree 内编辑、安装依赖和验证；本地主目录只用于同步已合并的 `main`，不得直接开发或提交到 `main`。不从旧功能分支复制未合并改动，不让多个任务共用同一 worktree。

### 3. 实现与验证

- 保持修改聚焦，行为改动补相关回归测试；同步配置、默认示例和文档，并按下文“文档与更新日志”更新 `CHANGELOG.md`。
- 先跑相关定向检查，再运行完整 `npm run verify`。失败要查明并修复，不降低检查标准、不把文件加入忽略列表绕过。
- 新功能或大范围设计按贡献指南先讨论；已明确授权的任务不重复索取相同确认。

### 4. 提交、推送、开 PR

- 检查 `git diff --check`、完整 diff、暂存文件和提交身份；只提交本任务文件。按 CONTRIBUTING 使用仓库配置的 GitHub noreply 邮箱和英文类型前缀标题，不跳过隐私钩子；推送前运行 `node scripts/privacy-scan.mjs --commits origin/main..HEAD`。
- 推送 `codex/` 分支，按 `.github/PULL_REQUEST_TEMPLATE.md` 创建面向 `main` 的 PR，写清问题、最终行为、验证和兼容性。
- 创建后把本 PR 的真实编号与链接补入更新日志条目并推送，随后等待最新提交的 CI。

### 5. 等待当前提交的 CI，通过后合并

- 按 `.github/workflows/verify.yml` 核对 Windows 框架预检、Ubuntu/macOS/Windows 完整验证和 Docker 检查，全部针对**最新提交**成功。排队、运行中、跳过、取消或旧提交的成功都不算通过。
- 已知偶发：macOS 完整验证有时在 `test/server.test.mjs` 结束后挂起直至超时而被取消，Windows 偶有纯计时类超时。先看日志确认没有断言失败，再重跑该任务一次；重复出现时应排查（例如测试遗留的句柄），不能把重跑当成修复，也不能对真实失败重跑碰运气。
- 处理审查阻塞；若 `main` 前进导致分支落后或冲突，在任务 worktree 同步并重新验证，推送后等待新的 CI。通过仓库允许的方式合并，不绕过分支保护或强推 `main`。

### 6. 同步本地主目录

确认 PR 已合并及其合并 SHA，获取最新远程 `main`。在本地主目录工作区干净且可安全快进时执行 `git switch main`、`git merge --ff-only origin/main`。遇到其他任务的改动或分叉，保留现场并说明具体阻碍，不能覆盖。核对本地 HEAD 与远程当前 `main` 相同。

### 7. 更新实际服务

按下文“合并后更新本地服务”用已合并的最新 `main` 更新真实部署。此步骤属于维护者要求的交付闭环；只在当前工作环境确有对应部署和运维权限时执行，不假定外部贡献者也有本机服务。纯文档或纯测试改动不影响运行代码时，说明理由后可以不重启服务，但仍要报告服务当前运行的版本。

### 8. 报告与收尾

- 给出修改文件、PR 链接、合并 SHA、验证结果、本地分支与服务运行版本，以及任何未完成项。不能只凭源目录或 `deployment.json` 已更新就宣称服务已升级；保留回退资料。
- 列出本任务及其他已合并、工作区干净的任务 worktree 和本地分支，**经用户确认后**再用 `git worktree remove <目录>` 和 `git branch -d <分支>` 清理，最后 `git worktree prune` 清除失效记录。不自动删除，不删除有未提交改动、未合并提交或正被其他会话使用的 worktree，也不删除旧发布目录。

## 项目入口与模块

Node.js 24+、ESM（`.mjs`）、内置 SQLite。管理台使用普通浏览器脚本，无前端打包框架；依赖使用精确版本。入口及职责如下，改动前继续读对应文件，不把本表当作完整接口契约。

| 位置                                         | 职责与联动                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.mjs`、`src/server.mjs`             | 进程启动、数据目录、管理 API、鉴权与配置；核对暂停、Host/Origin 和启动屏障。                                                                                                                                              |
| `src/core/`                                  | 运行时、会话生命周期、调度、Self、上下文交接及权限。聊天接续看 `chat-context.mjs`、`chat-recall.mjs`、`lifecycle.mjs`；配置看 `config.mjs`、`default-config.mjs`；对外错误码看 `error-codes.mjs`。                        |
| `src/backends/`                              | DSH、Codex、Google Antigravity CLI、OpenAI 兼容四类后端与能力契约（`capabilities.mjs`、`session-contract.mjs`、`turn-failure.mjs`）；`external.mjs` 是外部 MCP 客户端。改会话、取消、用量和压缩时一并核对恢复与迟到回调。 |
| `src/transport/`                             | OneBot 连接、账号校验、消息归一化、附件、QQ 表情；不能混淆网关消息号与内部事件 ID。                                                                                                                                       |
| `src/memory/`                                | SQLite、身份绑定、来源/保护标记、搜索、纠正、迁移、导出恢复；新增记录须考虑旧库和导出兼容。                                                                                                                               |
| `src/tools/`、`src/mcp.mjs`                  | 桥接工具的定义、注册、目录、执行与回合凭据；新增步骤见下文“常见陷阱”和 [扩展指南](docs/EXTENDING.md#新增桥接工具)。                                                                                                       |
| `src/games/`                                 | 网页游戏：通用内核（`core/`）、独立子进程与 AI 决策框架（`framework/`）、五子棋模块（`gomoku/`）。默认关闭，独立端口和数据库，不导入桥接运行时或管理/QQ 凭据。                                                            |
| `src/updates/`                               | 版本检查、一键升级、受管启动（`npm run managed`）和升级前排空；涉及备份、回退和暂停状态保留。                                                                                                                             |
| `src/apps/`、`src/github/`                   | 外部应用读取、分享与 GitHub 只读策略；联网、凭据和保护边界应留在统一入口中。                                                                                                                                              |
| `public/`                                    | 中文管理台；跨脚本共享的全局符号登记在 `eslint.config.mjs` 的 `browserScripts`，页面规范见贡献指南。                                                                                                                      |
| `scripts/`、`src/cli/`                       | 校验、隐私扫描、导出备份、构建清单、安装诊断、真实验收脚本和启停工具；生产启停入口是 `scripts/robots.mjs`。                                                                                                               |
| `test/`                                      | Node 内置测试，公共夹具在 `test/helpers.mjs`，使用临时目录和假网关。                                                                                                                                                      |
| `docs/`、`examples/`                         | 当前功能、配置、运维和脱敏示例；`docs/history/` 是历史证据，`docs/plans/` 的计划不等同已实现功能。                                                                                                                        |
| `vendor/`、`NOTICE.md`、`docs/SOURCES.json`  | 上游代码和归属；改动保留许可与来源说明。                                                                                                                                                                                  |
| `.github/workflows/verify.yml`、`Dockerfile` | 多平台 CI 与容器交付；不能只验证开发机平台。                                                                                                                                                                              |

### 按任务找入口

| 任务                     | 先读                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 聊天接续、历史回放       | `src/core/chat-context.mjs`、`chat-recall.mjs`、`lifecycle.mjs`，[聊天接续](docs/CHAT-CONTEXT.md)                                                      |
| Self、模型会话退休与交接 | `src/core/context-handoff.mjs`、`session-records.mjs`，[Self 与会话](docs/SELF-CONTEXT.md)、[回合恢复](docs/turn-recovery.md)                          |
| 新增或修改后端           | `src/backends/index.mjs`、`capabilities.mjs`、`session-contract.mjs`，[扩展指南](docs/EXTENDING.md#新增-ai-后端)、[后端恢复](docs/BACKEND-RECOVERY.md) |
| 新增或修改桥接工具       | `src/tools/definitions.mjs`、`registry.mjs`、`catalog.mjs`、`names.mjs`，[扩展指南](docs/EXTENDING.md#新增桥接工具)                                    |
| QQ 发送与投递            | `src/core/delivery.mjs`、`send-budget.mjs`、`outbound-policy.mjs`，`src/transport/onebot.mjs`                                                          |
| 受保护工作与外发         | `src/core/protected-work.mjs`、`protected-mind.mjs`，[受保护工作](docs/PROTECTED-WORK.md)                                                              |
| 记忆、迁移与导出         | `src/memory/store.mjs`、`migrate.mjs`、`export.mjs`，[记忆设计](docs/MEMORY-DESIGN.md)、[迁移](docs/MIGRATION.md)                                      |
| 配置项与默认值           | `src/core/config.mjs`、`default-config.mjs`，[配置说明](docs/CONFIGURATION.md)                                                                         |
| 网页游戏                 | `src/games/`，[P2 指南](docs/WEB-GAME-P2.md)、[P3 指南](docs/WEB-GAME-P3.md)                                                                           |
| 版本更新与升级           | `src/updates/`，[版本更新](docs/UPDATES.md)、[AI 更新手册](docs/AI-UPDATE.md)                                                                          |
| 管理台页面               | `public/`、`eslint.config.mjs`，CONTRIBUTING 的“管理台页面”                                                                                            |

进一步阅读：[架构](docs/ARCHITECTURE.md)、[功能矩阵](docs/FEATURE-MATRIX.md)、[凭据边界](docs/CREDENTIAL-BOUNDARIES.md)、[本机运维](docs/LOCAL-OPERATIONS.md)。

## 开发与验证

- 环境与 `npm run verify` 的各步骤见 CONTRIBUTING。在任务 worktree 用 `npm ci --ignore-scripts` 安装依赖；完整测试需要 FFmpeg 和 FFprobe；不要为跑测试使用真实 QQ 账号或模型。
- 定向测试用 `node --test --test-timeout=120000 test/<相关文件>.test.mjs`。行为、权限和失败恢复有相应回归；纯文档改动不增加只复述文字的测试，但仍执行完整 `npm run verify`。
- `npm run format:check` 尚未覆盖根目录的 `AGENTS.md`、`CHANGELOG.md`、`CONTRIBUTING.md`；修改它们时另用项目内的 Prettier（`npx prettier --check <文件>`）检查修改文件，避免无关的全文件格式化。
- 隔离调试使用独立临时数据目录和不冲突的端口。不要对生产数据运行 `npm start`、迁移实验或测试夹具。真实后端验收按 [LOCAL-ACCEPTANCE.md](docs/LOCAL-ACCEPTANCE.md) 单独安排，不能用模拟测试冒充真实投递成功。

## 常见陷阱

这些错误 `npm run verify` 不一定全能拦住，提交前逐项对照：

- **错误码未登记**：新的对外错误码必须加入 `src/core/error-codes.mjs` 的 `knownErrorCodes`，否则不会原样离开进程，用户只看到泛化错误。错误码用大写下划线常量，不带服务商原文、路径、令牌或聊天内容。
- **工具只加了一半**：新增桥接工具要同时改定义（`definitions.mjs` 或分组 `*Definitions`，schema 用 `.strict()`）、处理函数（`core-handlers.mjs` 或分组分发函数，新分组还要登记到 `registry.mjs`）、功能开关（`catalog.mjs` 的 `toolAvailable`）、工具目录（`names.mjs`）和错误码；`test/tool-registry.test.mjs` 会校验一一对应。处理函数从 `ctx` 取角色、会话和目标，不信任参数里的身份。
- **默认值不同步**：改默认值后运行 `npm run defaults:write`，核对 `examples/config.example.json` 和 [配置说明](docs/CONFIGURATION.md)；保留已有显式配置，工具开关开启不等于发送、外部访问或运维已授权。
- **类型检查漏模块**：`tsc` 只检查列在 `tsconfig.json` `include` 中、文件头带 `// @ts-check` 的模块；新模块能通过时一并纳入。
- **管理台全局符号未登记**：`public/` 脚本新增跨文件使用的名字，要登记到 `eslint.config.mjs` 的 `browserScripts`。
- **把未确认当已发送**：投递 `pending`/`unknown` 不等于已发送，不能换 requestId 自动重发；普通 assistant 文本不直接发送 QQ。
- **历史当新消息**：历史回放、交接摘要和 Self 不推进已读水位、不增加回复额度、不赋予新授权。
- **数据库变更不兼容**：新增表或字段要能在旧库上迁移，并考虑导出/导入格式；回退代码需要配合升级前的备份。

## 必须保持的运行边界

- `agentId` 是稳定记忆身份，`connectionId` 是 QQ 连接，`backendId` 是模型入口；不能用换 ID 处理改名或会话问题。各角色的记忆与授权保持隔离。
- 模型会话可以压缩、退休和重建，原始经历、日记、Self 和发送账本独立保留。
- QQ 投递走统一发送器和幂等账本。
- `isolated`、全局/角色/会话暂停、静默、白名单、预算和凭据分别生效。空闲主体通过意图交给目标聊天决定发送；受保护工作不能借普通记忆、Self 或意图外流。
- 网页游戏、外部应用读取等子系统保持各自的进程、凭据和权限边界，不借用聊天会话、记忆或管理凭据。
- 新增能力遵守现有权限检查，并覆盖必要的拒绝路径；不为修复故障放宽范围、移除来源保护或授予未知工具权限。不把服务商原文、令牌或聊天内容写进日志。
- 不提交 `.runtime/`、真实配置、数据库、登录数据、凭据、原始聊天、未脱敏截图或本机路径。PR 和公开文档只使用占位数据；私有运维证明存放在部署的私有目录中。

## 合并后更新本地服务

结合 [AI 更新手册](docs/AI-UPDATE.md) 检查目标版本、兼容性与能力差异。授权按以下方式区分：

- 维护者已明确授权的合并、更新及恢复**原有**运行状态，无需重复确认。
- 新版本带来新能力、权限扩大、能力默认值变化，或需要恢复原本处于暂停的发言时，仍在 AI 更新手册的对应停止点（第 2.5 步、第 7 步）停下，按实际范围向用户确认；不能仅凭本文件推定授权。

步骤：

1. 从运行进程的 `--data`、启动器记录和该数据目录的 `deployment.json` 找到真实部署，以实际 `codeRoot` 的 [LOCAL-OPERATIONS.md](docs/LOCAL-OPERATIONS.md) 为准。不把当前工作目录、默认端口或历史路径当作现场，不启动第二份桥接。
2. 记录本地与远程 `main` SHA、当前发布目录及逐角色状态。部署前保存配置、部署元数据及一致的 SQLite 备份（使用 `scripts/backup.mjs` 或 SQLite 在线备份，不能只复制正在使用的 WAL 主文件）；基线包括暂停状态、会话引用、事件/日记计数和 Self 版本。等待活跃回合结束，暂停用于切换时保留原有暂停意图。
3. 从已合并的精确提交生成独立发布目录，不部署任务 worktree 的未提交内容。依赖与锁文件一致；无 `.git` 时在发布目录运行 `node scripts/framework-build.mjs --commit <完整SHA>`，验证构建摘要和版本来源，再切换 `deployment.json` 的 `codeRoot`。保留旧发布和回退位置。
4. 使用确认过的代码和数据目录调用 `node <codeRoot>/scripts/robots.mjs restart --data <dataRoot>`。只有原本需要恢复自动活动时加 `--resume`；它检查连接和模型后只解除全局启动屏障，保留角色/会话暂停。不要更改 QQ 登录、记忆、白名单或重置模型会话来完成升级。
5. 启动命令报错时先检查服务实际状态和错误码；例如模型目录检查超时可能已有服务但仍暂停，应诊断后最小恢复，不循环重启。前一步失败不得继续执行依赖它的切换或重启；不使用 `killall`、盲删锁或强制覆盖数据。
6. 核对实际进程入口、构建清单和合并版本；逐角色检查 QQ 已连接、后端就绪、暂停/阻断及未确认投递。立即检查一次，约 10–30 秒后复查稳定性，并对比配置、会话引用、记忆与 Self。如果新版本按契约需要退休会话，说明具体原因，不能宣称会话全未变化；正常新增记录可以使计数增加。
7. 不主动发送 QQ 测试消息或触发定时任务作为验证。需要重新登录、用户解除有意暂停、处理数据分叉等不可自动完成的情况，报告准确阻碍和剩余步骤，不把交付标成全部完成。

## 文档与更新日志

- **每个 PR 都必须实际更新 `CHANGELOG.md` 的“未发布”章节**：功能、修复、测试、重构、依赖、CI、纯文档均不例外，不能只在 PR 描述中建议一句。写明改了什么、为什么，以及适用的兼容性、迁移或运维影响；没有用户可见行为变化时如实写维护、验证或文档层面的变化，不编造功能收益。
- 条目标题带本 PR 的真实编号与链接：创建 PR 前可暂缺，创建后补上并推送，再等待最新提交的 CI。已有条目按最终结果修订，后续修正不堆重复条目。
- 功能或行为变化同步最贴近的指南、配置说明和默认示例。创建新文档时补合适的 README 索引，并核对文件路径、命令、配置项和链接确实存在。
- 合并前核对 PR 标题、描述、最终 diff、测试结果和日志讲的是同一个改动，不遗留已经放弃的方案或尚未完成的承诺。区分待合并、已合并、已发布和已部署。
- 新版本只有实际发布时才增加版本标题、标签和相应包版本；不要为补日志随意升级版本。
