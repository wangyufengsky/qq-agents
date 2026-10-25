# QQ Bridge Unified

一个项目、一个管理台，管理多个独立 AI 和多个 NapCat 连接。基于 [h-D-ACE/dsh-qq](https://github.com/h-D-ACE/dsh-qq) 的 DSH 客户端与发现模块，参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，整合本地双机器人项目的 Codex RPC、互聊边界与平台读取模块。

**0.2 已补齐旧功能主线**：语音、嵌套转发、长等待/潜水、主动参与、13 类定时规则、跨群汇总、黑话 learner 和分级运维都已接入共享核心与管理台。代码在本地统一测试，GitHub 仅管理代码与 PR，不使用 GitHub Actions。现有双机器人保持暂停；真实模型、QQ 投递与生产切换留待统一验收。

## 本地启动

需要 Node.js 24（内置 SQLite）；语音校验与音量处理需要 FFprobe/FFmpeg。

```sh
npm ci --ignore-scripts
npm start
```

打开 `http://127.0.0.1:3210`，在登录框输入本机 `.runtime/admin-token` 的内容。令牌不放进 URL，不打印到日志。新建配置采用示例占位账号、空白名单、停用连接、角色暂停和隔离模式。**启动管理台不会启动 QQ、DSH 或模型回合。**

```sh
npm run verify
```

需要指定独立数据目录或端口时：

```sh
node src/main.mjs --data /path/to/private-data --port 3210
```

真实接入需要显式 `--live` 启动、配置 `mode: live`、开启目标连接并手动连接；所有启动仍会落在全局暂停状态。进入参与状态要分别解除全局暂停和角色暂停。此开关属于后续部署步骤，不属于本轮本地验收。

## 已实现的功能

- 任意数量的 `agents`、`connections` 和 `backends`。一只机器人对应稳定 `agentId` 和一个 QQ 身份，后端/模型会话可以变更。
- 统一管理台：增改机器人、QQ 连接、后端、提供方、模型、思考强度、人格、工具白名单、群/私聊白名单、名字/@/问句唤醒、参与率、静默时段、暂停及状态。
- OneBot HTTP + 正向 WebSocket；连接前核对实际登录账号。群聊和私聊按白名单接收；自己的消息不触发自己；其他 AI 的互聊有共享计数与冷却边界。
- DSH Web RPC + mux 适配，动态发现本机端口；独立的 DSH preset/MCP bundle 生成器。Codex 使用专用 app-server、独立 home、动态工具和回合取消。
- 完整入站消息在接收时持续写入 SQLite。出站尝试、确认、失败/未知结果分别记录。幂等键避免重复接收/发送；网络结果未知时不自动重放。
- 自主个人日记及版本历史，中文关键词/人物/来源/时间检索，摘要、按 ID 分页展开、前后文读取。不同机器人不能互读；同一机器人可回忆自己的群聊和私聊。
- 私密回忆与披露分开。跨会话读取后，当前模型会话保留披露限制；发送及外部工具调用需要管理员对本回合、目标和记录授予权限。可重置模型会话解除残留上下文，经历仍保留。
- 图片像素读取、角色独立的表情收藏、图片/文字/引用/@ 投递；允许的外部 MCP 图像工具可返回图片并登记为受控媒体后投递。平台只读搜索/内容/评论复用 social-reader 的并发锁。
- 显式原生进程启动/停止、带归属标签的 Docker 容器启动/停止。仅操作本管理器拥有的实例，不创建/删除登录目录、容器、卷或镜像。
- 旧 social-v2 窗口、JSONL 历史、旧 SQLite 笔记的只读预检与幂等导入；单身份导出/恢复；保留旧资料及修订历史。

- 角色语音库、导入/试听、音量/响度处理、受控语音发送；嵌套转发展开、归档、分页与合并转发发送；拍一拍与分段连发。
- 可取消长等待、睡前观察、条件唤醒、有限睡眠、消息合并与回复检查、夜间衰减、主动参与与统一发送限额。
- 13 类定时规则、时区/排除日期、固定文字/AI 任务、配额、忙碌队列、执行日志及重启不重放；管理台预览与编辑。
- 独立黑话 learner、人工确认、显式有向跨群汇总；管理员私聊 L1–L3 运维、逐项批准与 TOTP 防重放，默认关闭。

图片/音频生成、转录与黑话检索依赖管理员配置的 MCP；平台读取依赖 OpenCLI/mcporter 和已有登录。官方表情收藏/备注需要旧网关扩展接口，不能假定所有 NapCat 版本支持。详见 [使用说明](docs/FEATURES.md) 与 [功能对照](docs/FEATURE-MATRIX.md)。

## 配置与数据

`examples/config.example.json` 是唯一随仓库分发的示例。运行配置、凭据引用、人格、聊天、媒体、模型会话全部在私有数据目录；`.gitignore` 和隐私扫描器禁止把这些运行文件提交。

OneBot 令牌填写环境变量名 `tokenEnv`；外部 MCP 和原生进程的 `env` 使用“目标变量名 → 本进程环境变量名”的映射，不把密钥写入仓库。Codex home 固定在数据目录 `codex/<agentId>/home`，不继承日常 Codex home。

DSH bundle 仅生成，不自动安装、改 profile 或重启应用：

```sh
npm run dsh:bundle -- --out /path/to/private-data/dsh-bundle --url http://127.0.0.1:3210
```

新运行时只注册 `memory_search`、`memory_read`、`conversation_read`、`diary_write`、`diary_revise` 等新工具。旧 `qq_memory_*`、双写和 1800 字自动注入不在执行路径中。DSH/Codex 自身短期上下文与压缩继续由后端管理，不全局修改用户的记忆插件。

## 文档

- [架构与身份边界](docs/ARCHITECTURE.md)
- [基线与功能对照](docs/FEATURE-MATRIX.md)
- [迁移、部署与回退](docs/MIGRATION.md)
- [主动调度与旧工具使用](docs/FEATURES.md)
- [验收范围](docs/ACCEPTANCE.md)

## 来源和许可

MIT。保留上游 [LICENSE](LICENSE)、[原 NOTICE](UPSTREAM-NOTICE.md) 和 [本项目归属说明](NOTICE.md)。版本及文件摘要见 `docs/SOURCES.json`。仓库不分发 QQ/NapCat/DSH/Codex 应用或 SnowLuma SDK；外部程序适用各自许可。
