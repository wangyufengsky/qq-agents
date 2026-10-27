# 配置与数据目录

## 数据目录

默认数据目录是启动时当前目录下的 `.runtime/`，可用 `--data /path/to/private-data` 指定。目录内主要文件：

| 文件 / 目录                   | 内容                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `config.json`                 | 运行配置（角色、QQ 账号连接、AI 后端、白名单、暂停等）。可用 `--config` 指定其他位置。      |
| `admin-token`                 | 管理台登录令牌，首次启动自动生成，权限 0600。                                               |
| `memory.sqlite`               | 聊天、经历、日记、self、意图和发送账本。                                                    |
| `media/`、`files/`、`voices/` | 各角色独立的图片、文件库和语音库。                                                          |
| `codex/<agentId>/home`        | 每个使用 Codex 的角色的专用 Codex 登录目录，不继承日常 Codex home。                         |
| `secrets.json`                | 可选。`scripts/robots.mjs` 启动时注入的本地环境变量（键值都是字符串），只有桥接子进程读取。 |

`examples/config.example.json` 是唯一随仓库分发的示例。运行配置、凭据引用、人格、聊天、媒体、模型会话全部在私有数据目录；`.gitignore` 和隐私扫描器禁止把这些运行文件提交。

## 凭据与环境变量

OneBot 令牌填写环境变量名 `tokenEnv`，配置里只保存变量名，不保存令牌本身；启动桥接的进程环境中必须有这个变量，否则连接时报 `ONEBOT_TOKEN_ENV_MISSING`。Codex 后端、外部 MCP 和原生进程的 `env` 使用“目标变量名 → 本进程环境变量名”的映射，不把密钥写入仓库。Codex 和管理台原生 QQ 子进程默认仅继承运行所需的环境白名单，专用变量须显式映射。Codex home 固定在数据目录 `codex/<agentId>/home`，不继承日常 Codex home。审批 ID、环境白名单和升级说明见 [凭据边界](CREDENTIAL-BOUNDARIES.md)。

## DSH bundle

DSH bundle 仅生成，不自动安装、改 profile 或重启应用：

```sh
npm run dsh:bundle -- --out /path/to/private-data/dsh-bundle --url http://127.0.0.1:3210
```

新运行时只注册 `memory_search`、`memory_read`、`conversation_read`、`diary_write`、`diary_revise` 等新工具。旧 `qq_memory_*`、双写和 1800 字自动注入不在执行路径中。短期上下文使用已核对的后端压缩接口，并由桥接统一管理用量阈值和安全退休，不全局修改用户的记忆插件。

## 配置保存

管理台每次保存都带上读取时的配置版本；期间配置已被其他页面或进程修改时，保存会以 `CONFIG_CONFLICT` 拒绝，刷新后重新核对即可，见 [故障排查](TROUBLESHOOTING.md#配置保存冲突)。按影响范围提交配置的细节见 [第五轮记录](history/RELIABILITY-ROUND-FIVE.md)。
