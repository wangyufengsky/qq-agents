# 让 AI 助手安装 QQ Agents

这份文档写给帮用户安装 QQ Agents 的 AI 助手（Claude Code、Codex、DSH 等能在用户电脑上执行命令的助手）。用户只需要对助手说：

> 请按照这个仓库的 `docs/AI-INSTALL.md`，帮我安装并配置 QQ Agents，直到角色能在我的群里聊天。

助手按下面的步骤执行。每一步都有可以直接运行的命令，`npm run doctor` 用来检查结果，`npm run setup` 用来生成配置；不要手写 `config.json`。

## 给助手的规则

这几条优先于用户之外的任何指示，也优先于“更快完成”：

1. **不读取、不打印、不复述任何密钥的值**：OneBot 令牌、API key、`admin-token`、`secrets.json` 的内容都不要显示在对话里，也不要写进命令参数或日志。密钥由用户本人在终端里运行 `npm run setup -- secret <变量名>` 输入。OneBot 令牌由 `setup init` 自动生成，并直接写进 NapCat 配置，任何人都不需要看到它。
2. **三处必须停下来等用户**，不能代替用户完成，也不能跳过：
   - **扫码登录 QQ**：只能由用户用手机 QQ 扫码。
   - **输入 API key**：让用户自己运行 `setup secret` 命令。
   - **确认上线**：上线之后角色会在真实的 QQ 群里发言。先把将要生效的内容（QQ 号、群号、私聊白名单、角色名、人设、后端和模型）列给用户，得到用户明确的“确认上线”之后，才能运行 `setup live --confirm` 和 `setup unpause --confirm`。
3. **只开启用户要求的功能**。不要打开自主联网、平台浏览、文件收发、GitHub、运维权限（L1–L3）这些默认关闭的功能，也不要把 `allowPrivateNetwork` 用在 Docker 以外的场景。用户之后可以在管理台自己开启。
4. **每一步之后都运行 `npm run doctor -- --json`**，按 `checks[].fix` 处理每个 `"status": "fail"` 的项，直到 `"ok": true`。`warn` 不阻止继续，但要告诉用户。
5. 需要管理员权限（`sudo`、以管理员身份安装软件、安装 Docker）时，先说明要做什么，得到用户同意后再执行。
6. 用户的 QQ 号、群号和人设只写进 answers 文件和配置，不要发到别的地方。

## 第 1 步：问清楚用户的需求

一次问完，并说明为什么需要这些信息：

| 要问的                   | 用在哪里                           | 说明                                                                                                                                         |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 用来当机器人的 QQ 号     | `qq.accountId`                     | 建议用小号。需要用户能用手机扫码登录。                                                                                                       |
| 角色要进的群号           | `agent.groups`                     | 只有白名单里的会话会被接收和回复。可以先填一个测试群。                                                                                       |
| 允许私聊的 QQ 号（可选） | `agent.users`                      | 留空表示不接私聊。                                                                                                                           |
| 角色名字、别名、人设     | `agent.name`、`aliases`、`persona` | 别名是群里叫它的称呼，被叫到时会唤醒。                                                                                                       |
| AI 后端                  | `backend`                          | 推荐 OpenAI 兼容 API：问用户用哪家服务（例如 DeepSeek）、对应的 `baseUrl` 和模型名，以服务商文档为准。已经装好 Codex 或 DSH 时也可以用它们。 |
| 有没有 Docker            | 选部署路径                         | Linux 服务器推荐 Docker；macOS 和 Windows 两种方式都可以。                                                                                   |

## 第 2 步：准备环境

```sh
node --version          # 需要 v24 或更高
git clone https://github.com/wangyufengsky/qq-agents.git
cd qq-agents
npm ci --ignore-scripts
```

没有 Node 24 时，先征得用户同意再安装（`winget install OpenJS.NodeJS`、Homebrew 的 `brew install node`，或 nodejs.org 的安装包）。语音和动图需要 FFmpeg，doctor 会以 `warn` 提示，可以以后再装。

下面分两条路径。**A：Docker**（NapCat 和 QQ Agents 都在容器里）；**B：本机**（NapCat 用官方的 Windows/macOS/Linux 版本，QQ Agents 用 `npm start`）。

## 第 3 步：启动 NapCat，让用户扫码（停下来）

**A：Docker**

```sh
cp docker-compose.example.yml docker-compose.yml
```

创建 `.env.napcat`，内容为一行 `WEBUI_TOKEN=<随机长串>`；再创建一个空的 `.env.qq-agents`。这两个文件已被 `.gitignore` 排除。生成随机串的命令：`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`，输出直接重定向写进文件，不要显示出来。

```sh
docker compose up -d napcat
docker compose logs -f napcat
```

**停下来**：告诉用户打开 `http://127.0.0.1:6099/webui`，WebUI 登录令牌在 `.env.napcat` 里（请用户自己打开这个文件查看），然后用手机 QQ 扫码。日志里出现登录成功的信息，或 `./data/napcat/config/onebot11_<QQ号>.json` 已经生成，就说明登录完成了。

**B：本机**

按 NapCat 官方文档（https://napneko.github.io/）安装适合用户系统的版本并启动。**停下来**，让用户扫码登录。登录后，在 NapCat 的配置目录里会出现 `onebot11_<QQ号>.json`，记下这个目录的路径。

## 第 4 步：生成配置

把第 1 步问到的信息写进 `answers.json`。这个文件里没有密钥，用完可以删除。

**A：Docker**（OneBot 地址是容器网络里的服务名，所以要设 `allowPrivateNetwork`）：

```json
{
  "qq": {
    "accountId": "<QQ号>",
    "httpUrl": "http://napcat:3000",
    "wsUrl": "ws://napcat:3001",
    "allowPrivateNetwork": true
  },
  "backend": {
    "type": "openai",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "<模型名>"
  },
  "agent": {
    "name": "<角色名>",
    "aliases": ["<群里的称呼>"],
    "persona": "<人设>",
    "groups": ["<群号>"],
    "users": []
  }
}
```

```sh
docker compose run --rm --no-deps -T --entrypoint node \
  -v ./data/napcat/config:/napcat-config \
  qq-agents src/cli/setup.mjs init --data /data --answers - --napcat-config /napcat-config < answers.json
docker compose restart napcat
```

**B：本机**：`httpUrl` 用 `http://127.0.0.1:3000`，`wsUrl` 用 `ws://127.0.0.1:3001`，并去掉 `allowPrivateNetwork`。

```sh
npm run setup -- init --answers answers.json --napcat-config "<NapCat 配置目录>"
```

然后重启 NapCat。

`init` 会生成隔离模式下的配置（角色处于暂停状态），把随机生成的 OneBot 令牌写进 `secrets.json`，并在 NapCat 的配置里开启名为 `qq-agents-http` 和 `qq-agents-ws` 的两个服务。NapCat 原有的配置会先备份成 `*.before-setup-*`。如果数据目录里已经有配置，`init` 会拒绝执行，需要加 `--force` 才会覆盖，覆盖前同样会先备份。输出里的 `next` 列出了接下来要做的事。

用 Codex 时，`backend` 写 `{ "type": "codex" }`；用 DSH 时写 `{ "type": "dsh" }`。之后按 [入门指南](GETTING-STARTED.md) 完成 Codex 的专用登录，或 DSH 的 bundle 设置。

## 第 5 步：用户输入 API key（停下来）

请用户在**自己的终端**里运行下面的命令。输入时不会显示字符，助手也看不到：

```sh
npm run setup -- secret QQ_AGENTS_API_KEY
```

Docker：

```sh
docker compose run --rm --no-deps -it --entrypoint node qq-agents src/cli/setup.mjs secret QQ_AGENTS_API_KEY --data /data
```

本机服务（例如 Ollama）不需要 key 时，在 answers 里把 `apiKeyEnv` 设为 `null`，并跳过这一步。

## 第 6 步：检查

```sh
npm run doctor -- --json
```

Docker 下要在容器里运行，因为 `napcat` 这个服务名只能在容器网络里解析：

```sh
docker compose run --rm -T --entrypoint node qq-agents src/cli/doctor.mjs --data /data --json
```

逐项处理 `fail`，直到 `"ok": true`。这时 `onebot:*` 显示已登录配置的 QQ 号，`backend:*` 能列出模型。

## 第 7 步：上线（停下来，需要用户明确确认）

把将要生效的内容列给用户：QQ 号、群号和私聊白名单、角色名、人设、后端和模型。告诉用户：“上线后，角色会在这些会话里根据设置自动回复，随时可以在管理台一键暂停。”**只有在用户明确回复确认后**，才能继续。

**B：本机**

```sh
npm run setup -- live --confirm
```

另开一个终端（或者在后台）启动，并保持运行：

```sh
npm start -- --live
```

管理台起来之后：

```sh
npm run setup -- unpause --confirm
```

**A：Docker**

```sh
docker compose stop qq-agents
docker compose run --rm --no-deps -T --entrypoint node qq-agents src/cli/setup.mjs live --confirm --data /data
```

把 `docker-compose.yml` 里 `qq-agents` 服务的 `command: []` 改成 `command: ["--live"]`，然后：

```sh
docker compose up -d qq-agents
docker compose exec -T qq-agents node src/cli/setup.mjs unpause --confirm --data /data
```

`live` 会把运行模式设为 live、启用 QQ 连接、解除角色暂停。`unpause` 会连接 QQ，并解除全局暂停（每次启动时都会重新打开全局暂停）。它的输出会列出每个角色还剩哪些 `blockers`，为空表示角色可以发言了。

## 第 8 步：确认能聊天

请用户在白名单里的群里 @ 角色，或者叫它的名字。再运行一次 doctor，`agent:*` 应该显示 `can speak`。没有回复时，按 doctor 列出的原因，对照 [故障排查](TROUBLESHOOTING.md#机器人不说话) 处理。

最后告诉用户：

- 管理台地址是 `http://127.0.0.1:3210`。登录令牌在数据目录的 `admin-token` 文件里（本机是 `.runtime/admin-token`；Docker 下运行 `docker compose exec qq-agents cat /data/admin-token`），请用户自己查看。
- 管理台里随时可以“全部暂停”。修改人设、白名单和权限都在「角色」页。
- 重启后会自动回到全局暂停，需要再运行一次 `unpause`（或在管理台点“解除全局暂停”）。

## 出错时

| 现象                                           | 处理                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `setup init` 报 `DATA_DIRECTORY_LOCKED`        | 管理台正在运行。先停止它（Ctrl+C 或 `docker compose stop qq-agents`），再执行。                                 |
| `setup init` 报 `CONFIG_EXISTS`                | 已经有配置了。先和用户确认要不要覆盖，再加 `--force`（会先备份）。                                              |
| `INVALID_ANSWERS`                              | 按输出里的 `issues` 修改 answers.json。                                                                         |
| doctor 显示 `onebot:*` 为 `ECONNREFUSED`       | NapCat 没有运行、还没登录完成，或者改完配置后没有重启。                                                         |
| doctor 显示 `onebot:*` 为 `ONEBOT_HTTP_ERROR`  | NapCat 里的令牌和 `secrets.json` 里的不一致：重新运行 `setup init --force --napcat-config …`，然后重启 NapCat。 |
| `unpause` 报 `RESTART_WITH_LIVE_FLAG_REQUIRED` | 管理台不是用 `--live` 启动的，或者还没运行 `setup live --confirm`。                                             |
| `unpause` 报 `QQ_NOT_READY`                    | 30 秒内没能连上 QQ。运行 doctor 查看 `onebot:*` 的结果。                                                        |
