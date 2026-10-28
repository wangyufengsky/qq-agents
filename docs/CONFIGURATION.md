# 配置与数据目录

## 数据目录

默认数据目录是启动时当前目录下的 `.runtime/`，可用 `--data /path/to/private-data` 指定。目录内主要文件：

| 文件 / 目录                   | 内容                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config.json`                 | 运行配置（角色、QQ 账号连接、AI 后端、白名单、暂停等）。可用 `--config` 指定其他位置。                                                                                               |
| `admin-token`                 | 管理台登录令牌，首次启动自动生成，权限 0600。                                                                                                                                        |
| `memory.sqlite`               | 聊天、经历、日记、self、意图和发送账本。                                                                                                                                             |
| `media/`、`files/`、`voices/` | 各角色独立的图片、文件库和语音库。                                                                                                                                                   |
| `codex/<agentId>/home`        | 每个使用 Codex 的角色的专用 Codex 登录目录，不继承日常 Codex home。                                                                                                                  |
| `openai/<agentId>/sessions/`  | 使用 OpenAI 兼容后端的角色的模型会话历史（每个会话一个 JSON 文件，权限 0600）。                                                                                                      |
| `secrets.json`                | 可选。变量名到值的映射（都是字符串），启动时（`npm start`、`robots.mjs`、Docker）补进环境变量，启动终端里已经设置的变量优先。由 `npm run setup -- secret <变量名>` 写入，权限 0600。 |

`examples/config.example.json` 是唯一随仓库分发的示例。运行配置、凭据引用、人格、聊天、媒体、模型会话全部在私有数据目录；`.gitignore` 和隐私扫描器禁止把这些运行文件提交。

## 凭据与环境变量

OneBot 令牌填写环境变量名 `tokenEnv`，配置里只保存变量名，不保存令牌本身；启动桥接的进程环境中必须有这个变量，否则连接时报 `ONEBOT_TOKEN_ENV_MISSING`。Codex 后端、外部 MCP 和原生进程的 `env` 使用“目标变量名 → 本进程环境变量名”的映射，不把密钥写入仓库。Codex 和管理台原生 QQ 子进程默认仅继承运行所需的环境白名单，专用变量须显式映射。Codex home 固定在数据目录 `codex/<agentId>/home`，不继承日常 Codex home。审批 ID、环境白名单和升级说明见 [凭据边界](CREDENTIAL-BOUNDARIES.md)。

## OpenAI 兼容后端

`type: "openai"` 直接调用任何兼容 Chat Completions 的服务（DeepSeek、通义、Moonshot、OpenRouter，或本机的 Ollama、vLLM、LM Studio 等），不需要 DSH 或 Codex。工具在桥接进程内执行（与 Codex 相同，走 `callTool`），模型看到的工具只有本回合允许的桥接工具和已配置的外部 MCP，没有 shell 或文件系统等自带工具；不需要生成 MCP bundle，也不需要模型抄写能力凭据。

```json
{
  "id": "deepseek-api",
  "type": "openai",
  "label": "DeepSeek API",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKeyEnv": "QQ_UNIFIED_DEEPSEEK_KEY",
  "model": "deepseek-chat",
  "contextWindow": 128000
}
```

| 字段               | 说明                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`          | 必填。到 `/v1` 为止的 API 地址；远程服务必须是 HTTPS，明文 HTTP 只允许本机回环地址。不能带账号、查询参数。                                                                                                |
| `apiKeyEnv`        | 存放 API 密钥的环境变量名，以 `Bearer` 发送。本机服务不需要密钥时留空。                                                                                                                                   |
| `model`            | 必填（可由角色的 `model` 覆盖）。缺少时回合以 `OPENAI_MODEL_REQUIRED` 失败。                                                                                                                              |
| `contextWindow`    | 模型上下文窗口 tokens，用于上下文压力判断，应与所选模型一致。不填时读取服务 `/models` 列表里该模型的 `context_length`、`context_window`、`max_model_len` 或 `max_context_length`；都没有时按 32768 处理。 |
| `maxToolRounds`    | 单个回合最多的模型请求轮数，默认 32；超出以 `TOOL_ROUND_LIMIT` 结束。                                                                                                                                     |
| `requestTimeoutMs` | 单次请求超时，默认 180000。                                                                                                                                                                               |
| `vision`           | 模型支持图片输入时设为 `true`，工具返回的图片会作为图片消息附上；否则只告诉模型“没有看到画面”。每张图片只随紧接着的那次请求发送一次，之后会话历史里只留一句说明，需要再看时由模型重新读取。               |
| `sendEffort`       | 设为 `true` 时把 `effort` 作为 `reasoning_effort` 发送。仅推理模型支持，普通模型可能因此返回 400。                                                                                                        |

与 DSH、Codex 的差别：

- **会话保存在本机**：历史在 `openai/<agentId>/sessions/`，只在一步（模型回复及其全部工具结果）完整后写入。网络中断、5xx 或响应格式错误时可以续接一次，已完成的工具调用不会重放；401/403、429、上下文超限不重试，并退休该会话。
- **不支持上下文压缩**：上下文接近上限时由桥接退休会话，下一回合以来源交接重新开始，与其他后端的压缩失败路径相同。
- **不支持原生生图**：不提供 `generated_image_list`。
- **音频**：工具返回的音频不会传给模型，模型会被告知没有转录。
- 返回 `reasoning_content` 的推理模型，思考内容不会写回历史。

密钥与 OneBot 令牌一样只通过环境变量提供；后台启动时可写入数据目录的 `secrets.json`。外发检查会把该变量的值视为凭据，不允许出现在工具参数里。

## DSH bundle

DSH bundle 仅生成，不自动安装、改 profile 或重启应用：

```sh
npm run dsh:bundle -- --out /path/to/private-data/dsh-bundle --url http://127.0.0.1:3210
```

新运行时只注册 `memory_search`、`memory_read`、`conversation_read`、`diary_write`、`diary_revise` 等新工具。旧 `qq_memory_*`、双写和 1800 字自动注入不在执行路径中。短期上下文使用已核对的后端压缩接口，并由桥接统一管理用量阈值和安全退休，不全局修改用户的记忆插件。

## 配置保存

管理台每次保存都带上读取时的配置版本；期间配置已被其他页面或进程修改时，保存会以 `CONFIG_CONFLICT` 拒绝，刷新后重新核对即可，见 [故障排查](TROUBLESHOOTING.md#配置保存冲突)。按影响范围提交配置的细节见 [第五轮记录](history/RELIABILITY-ROUND-FIVE.md)。
