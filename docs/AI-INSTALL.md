# 让 AI 助手安装 QQ Agents

这份文档写给帮用户安装 QQ Agents 的 AI 助手（Claude Code、Codex、DSH 等能在用户电脑上执行命令的助手）。用户只需要对助手说：

> 请按照这个仓库的 `docs/AI-INSTALL.md`，帮我安装并配置 QQ Agents，先让我选择角色能用的能力和范围，确认后再上线，并验证真实回复。

助手按下面的步骤执行。每一步都有可以直接运行的命令，`npm run doctor` 用来检查结果，`npm run setup` 用来生成配置；不要手写 `config.json`。

**已经部署好、只想更新框架？** 请改用 [AI 更新手册](AI-UPDATE.md)，不要重新执行本文的初始化或首次上线步骤，以免覆盖现有配置或改变角色暂停偏好。

## 给助手的规则

这几条优先于用户之外的任何指示，也优先于“更快完成”：

1. **不为配置或排错主动提取、不打印、不复述密钥的值**：OneBot 令牌、API key、`admin-token`、`secrets.json` 的内容都不要显示在对话里，也不要写进命令参数或日志。必要的日志诊断按第 3 步的告知、读取范围和脱敏要求进行。密钥由用户本人在终端里运行 `npm run setup -- secret <变量名>` 输入。OneBot 令牌由 `setup init` 自动生成，并直接写进 NapCat 配置，任何人都不需要看到它。
2. **四处必须停下来等用户**，不能代替用户完成，也不能跳过：
   - **扫码登录 QQ**：只能由用户用手机 QQ 扫码。
   - **输入密钥或登录 AI 后端**：API key 由用户运行 `setup secret` 输入；Codex/DSH 登录也由用户亲自完成。
   - **选择能力**：按第 6 步逐项说明用途、范围、费用和风险，让用户选择保留、关闭或稍后配置；不能把默认开关当作授权。
   - **确认上线**：上线之后角色会在真实的 QQ 群里发言。先把将要生效的内容（QQ 号、群号、私聊白名单、角色名、人设、后端和模型）列给用户，得到用户明确的“确认上线”之后，才能运行 `setup live --confirm` 和 `setup unpause --confirm`。
3. **让用户选择能力，不代替用户全开或全关**。新角色默认开启工具和多项能力；上线前必须核对并保存用户的选择。已有显式关闭设置仍保留。不要猜填账号、目录、凭据、跨群链接或授予运维 L1–L3 级别，`allowPrivateNetwork` 仅在已确认的 Docker/内网部署需要时使用，须说明 OneBot 令牌经明文 HTTP/WS 传输的边界；跨机器优先使用加密隧道。语音转写须先选择具体服务。
4. **环境和配置就绪后、上线前后分别运行 doctor**。检查 `fail`、`warn` 和 `skip`；先诊断，不机械执行 `checks[].fix`，尤其不能自动重新初始化、删除登录或扩大权限。未生成配置时的缺配置不靠 `--force` 解决。`ok: true` 不代表所有能力或真实聊天已验证。
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

## 第 2 步：准备环境并固定版本

先确认部署机器、系统、代码路径和私有数据路径。下文本机默认 `.runtime`，Docker 默认命名卷 `/data`；自定义时，每条 setup/doctor/启动命令都使用同一个数据路径（本机加 `--data "<绝对路径>"`）。目录中已有配置或角色时停止首次安装，改走 [AI 更新手册](AI-UPDATE.md)，不覆盖。

在一个不存在的安装目录获取代码，记录完整 SHA 并把目标版本交给用户确认；切换到确认的提交后再装依赖或构建镜像：

```sh
git clone https://github.com/wangyufengsky/qq-agents.git
cd qq-agents
git rev-parse HEAD
git switch --detach "<已确认的完整提交SHA>"
```

本机路径才需要在宿主机执行：

```sh
node --version          # 需要 v24 或更高
npm ci --ignore-scripts
npm run check
```

Docker 路径需要 Docker Engine 和 Compose，Node 在镜像中，不要求宿主机另装 Node；镜像构建在第 3 步完成。Windows 原生命令/路径与 PowerShell 环境变量语法见 [Windows 说明](WINDOWS.md)，不要原样执行 POSIX 的续行反斜杠或输入重定向示例；Docker 命令示例按 POSIX shell 编写。

没有 Node 24 时，先征得用户同意再安装（`winget install OpenJS.NodeJS`、Homebrew 的 `brew install node`，或 nodejs.org 的安装包）。按用户选择的能力准备依赖：语音和动图需要 FFmpeg/FFprobe，截图需要 Chromium；未选择的功能不必安装。doctor 的提示要对应说明哪些能力因此不可用。

下面分两条路径。**A：Docker**（NapCat 和 QQ Agents 都在容器里）；**B：本机**（NapCat 用官方的 Windows/macOS/Linux 版本，QQ Agents 用 `npm start`）。

先核对后端与部署方式：

- **OpenAI 兼容 API**：本机和默认 Docker 镜像均可用；模型需支持工具调用，视觉需另外确认模型支持。API 端点与模型以服务商说明为准。
- **Codex**：本机先安装 CLI，每角色以实际 `agentId` 对应的 `<数据目录>/codex/<agentId>/home` 为专用 `CODEX_HOME`，由用户完成登录，不复用日常 Codex home。默认 Docker 镜像不含 CLI，须经用户确认另建镜像并验证专用登录，不能直接宣称已支持。
- **DSH**：需可用的 macOS 桌面应用、用户登录和本项目专用 bundle/preset，按 [DSH bundle](CONFIGURATION.md#dsh-bundle) 配置。默认 Docker/Linux 方案不能连接宿主机的 DSH 回环服务；应选择本机 macOS 或其他后端，不绕过地址限制。

## 第 3 步：启动 NapCat，让用户扫码（停下来）

**A：Docker**

```sh
cp docker-compose.example.yml docker-compose.yml
```

创建仅当前用户可读写的 `.env.napcat`，内容为一行 `WEBUI_TOKEN=<随机长串>`；再创建私有的空 `.env.qq-agents`。这两个文件已被 `.gitignore` 排除；用系统安全随机源生成令牌并直接写入文件，不打印到终端或对话。参见 [Docker 环境变量说明](DOCKER.md#1-准备两个环境变量文件)。

```sh
docker compose build --build-arg SOURCE_COMMIT="<已确认的完整提交SHA>" qq-agents
docker compose up -d napcat
```

**停下来**：告诉用户打开 `http://127.0.0.1:6099/webui`，WebUI 登录令牌在 `.env.napcat` 里（请用户自己打开这个文件查看），然后用手机 QQ 扫码。由用户在本机界面确认登录成功，后续 doctor 再核对实际账号；仅配置文件存在不代表当前已登录。需要诊断时，先告知用户 NapCat 日志可能含 WebUI 令牌、认证链接、二维码或聊天信息，取得同意后可由助手读取必要的本机日志。优先在本机先筛选、脱敏，再读取相关时间段的有限行数，例如 `docker compose logs --tail 100 napcat`，不要默认无限串流或读取整份历史。若只能读取原始日志，要先说明敏感内容可能进入助手上下文；读后脱敏不能撤销这种暴露。展示或分享前移除令牌、认证链接、二维码和私人内容；不要上传整份日志到外部服务、Issue 或 PR，不为排错提取密钥值。确需传递含敏感认证信息的原文时，必须另行明确说明内容类别与接收方并取得用户确认，不能以“同意诊断”代替。

**B：本机**

按 NapCat 官方文档（https://napneko.github.io/）安装适合用户系统的版本并启动。**停下来**，让用户扫码登录。登录后，在 NapCat 的配置目录里会出现 `onebot11_<QQ号>.json`，记下这个目录的路径。

## 第 4 步：生成配置

把第 1 步问到的信息写进 `answers.json`。这个文件不放密钥，但含账号、群号和人设，应仅当前用户可读写；不提交到 Git，成功生成配置后按用户意愿删除。

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

Docker 中 setup 以非 root 的 `node` 用户运行（默认 UID 1000），挂载的 NapCat 配置目录可能属于其他用户。先检查实际属主和写权限；不匹配时说明影响并让用户确认精确的用户/组权限方案，不自动改为 root 或 `chmod 777`。

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

然后只重启本次配置的 NapCat 实例，不终止其他 QQ 进程。

`init` 会生成隔离模式下的配置（角色处于暂停状态），把随机生成的 OneBot 令牌写进 `secrets.json`，并在 NapCat 的配置里开启名为 `qq-agents-http` 和 `qq-agents-ws` 的两个服务。NapCat 原有的配置会先备份成 `*.before-setup-*`。如果数据目录里已经有配置，`init` 会拒绝执行。此时先确认是否已有部署，不能为通过检查自动加 `--force`；已有角色按更新手册处理。输出里的 `next` 列出了接下来要做的事。

用 Codex 时，`backend` 写 `{ "type": "codex" }`；用 DSH 时写 `{ "type": "dsh" }`。之后按 [入门指南](GETTING-STARTED.md) 完成 Codex 的专用登录，或 DSH 的 bundle 设置。

## 第 5 步：用户完成后端凭据或登录（停下来）

以下命令仅适用于选了需要密钥的 OpenAI 兼容后端；Codex/DSH 按第 2 步完成各自登录，不创建无用的 API key。若 answers 指定了其他 `apiKeyEnv`，命令使用同一个变量名。

请用户在**自己的终端**里运行下面的命令。输入时不会显示字符，助手也看不到：

```sh
npm run setup -- secret QQ_AGENTS_API_KEY
```

Docker：

```sh
docker compose run --rm --no-deps -it --entrypoint node qq-agents src/cli/setup.mjs secret QQ_AGENTS_API_KEY --data /data
```

本机服务（例如 Ollama）不需要 key 时，在 answers 里把 `apiKeyEnv` 设为 `null`，并跳过这一步。

## 第 6 步：让用户选择角色能力（停下来）

不要只问“要不要全部功能”。先用普通语言介绍下表，按角色问：**哪些保留启用，哪些关闭，哪些等凭据或环境准备好再配置？** 用户可先选“聊天和记忆 + 看图”，以后逐项增加；这只是选择示例，不是自动套用的预设。

### 默认开启不等于已经可用或已经获准

当前版本的新角色、缺省配置和管理台创建入口使用完整工具目录，联网、平台、文件、GitHub、定时、TTS、跨群和运维开关默认开启；语音转写仍须选择服务，默认关闭。账号、凭据、本机目录、私有仓库、跨群链接和运维级别不会自动授予。旧版本曾仅默认选择 8 个聊天/记忆工具；旧配置显式保存的工具列表和关闭值会保留，所以更新后仍可能“没有某项能力”。不要因此重新初始化或把所有工具强行补齐。

**工具被选中、策略允许、后端支持、依赖与凭据就绪、当前会话允许**是不同条件。框架自查及部分 Self/记忆工具由运行时提供，不能仅凭 `tools` 数量判断全部能力；完整工具目录也不意味着普通群聊能使用运维或私有仓库。

### 按用途选择，并解释边界

表中的字段均位于角色 `agents[]`，外部工具配置位于 `backends[]`。表格是选择清单，不是要求把所有开关打开。

| 能力                 | 可以做什么 / 对应设置                                                                          | 配置前要说清楚                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 聊天、记忆与 Self    | “能力”中的聊天、记忆、Self 分组；`tools`、`subject`、`selfPolicy`                              | 基础对话、回忆和日记；主动参与还受唤醒、主体策略、静默及暂停控制。内容会保存在本机，模型回合会使用所选后端额度。                                                                 |
| 图片、表情与生图     | “能力”中的图片与表情工具；例如 `qq_image_read`、`sticker_read`                                 | 看图需模型支持图片；GIF 需 FFmpeg。原生生图目前仅 Codex 支持，DSH/OpenAI 兼容后端不能靠勾选工具获得原生生图；生成与视觉调用可能收费。                                            |
| 公开网页与截图       | `web_fetch`、`web_screenshot`，以及 `network.autonomous`、`network.publicUrls`                 | 自主联网允许自行整理查询并交给外部服务，不是每次再确认；询问是否允许。截图需 Chromium，精确 URL 不得包含私密参数。                                                               |
| 平台浏览与分享       | “浏览与分享”页的 `apps.enabled`、`platforms`、`sharing`、时段与预算                            | 浏览和向 QQ 分享分别决定；部分平台需本机 OpenCLI/登录，访问受平台条款限制。登录态不交给助手展示，设每日读取/分享限额。                                                           |
| 文件收发             | “文件”页的 `files.enabled`、`download`、`receive`、`send`、`create`、`localRoots`、配额        | 分别选择下载、接收、生成、发送；目录留空也能用角色文件库。授权目录意味着可在已授权聊天中发送其中普通文件，不是每次确认；不要选整个主目录或凭据目录。                             |
| 语音发送、TTS 与转写 | 语音工具、`voice.tts.enabled`、`voice.asr`                                                     | 发送已有语音、合成语音、识别来信是三件事。内建 TTS 仅 macOS 可用；FFmpeg/FFprobe 用于媒体处理。ASR 需后端允许的外部 MCP 工具，会把聊天音频送到该服务，单独确认隐私、费用与配额。 |
| 定时与作息           | 定时工具、`scheduler.enabled`、`ownerIds`、目标/时区/预算                                      | AI 登记任务限管理员私聊；其他目标还受 `allowAiOtherTargets` 和确认控制。确认发送范围、免打扰时间与频率，不把选能力等同于批准创建任务。                                           |
| GitHub 只读          | “联网与 GitHub”中的 `github.enabled`、`auth`、`tokenEnv`、`privateRepositories` 及 GitHub 工具 | 只读，不提供提交或工作流操作。由用户配置独立只读凭据；私库需明确列入范围且只在受保护工作中读取，不自动向普通聊天披露。                                                           |
| 跨群统计             | `qq_cross_group_query`、`crossGroup.enabled`、`crossGroup.links`                               | 按来源群、目标群和 `presence`/`activity` 项目逐条授权；不是跨群全文读取或群发许可。不要自动把所有群互联。                                                                        |
| 外部 MCP / 运维      | `external_tools`、`external_tool` 与后端 `toolServers[].allowedTools`；运维 `operations`       | 每个外部服务可能有独立费用和读写副作用，逐工具确认。运维只在独立受保护任务中，工作区、允许命令、L1–L3 与写入批准仍各自受控；不为“功能完整”授予 L3。                              |

### 在现有管理台保存选择，不虚构配置命令

`setup init` 的 answers 只接受账号、基础角色和后端信息，**没有能力选择向导，也不接受 `agent.tools` 或 `agent.files` 等任意字段**。不要往 `answers.json` 塞这些字段，也不要发明 `setup capabilities` 命令。先用 setup 生成配置，再在隔离、暂停状态下打开管理台：

- 本机：`npm start`。
- Docker：确认 Compose 的框架 `command: []`，运行 `docker compose up -d --no-deps qq-agents`。
- 用户自行取得并输入管理令牌；助手不读取令牌内容。按 [入门指南](GETTING-STARTED.md) 登录。

在“角色”页展开“能力”，按组或高级逐项选择；“联网与 GitHub”“语音转写”有独立设置。文件与平台工具由“文件”“浏览与分享”页管理，保存会同步相关工具白名单，不在角色页强改这些受管理项。定时在“定时任务设置”中配置；只有完整配置提供的字段，按对应说明使用管理台的完整配置编辑并校验，基于现有配置改动，不重写整份文件。详见 [文件权限](FILE-TRANSFER.md)、[配置](CONFIGURATION.md)、[外部 MCP](EXTENDING.md) 和 [受保护工作](PROTECTED-WORK.md)。

保存前给用户一份逐角色清单：**能力、当前状态、用户选择、允许范围、依赖/费用、未就绪原因**。默认已经打开但用户不要的能力也要明确关闭；未回答的选择不能靠默认值替代确认，不进入上线步骤。所有密钥仍由用户自行输入。

保存后重新打开相关页面，核对工具与策略、后端和范围是否一致；对所选能力分别记录“已配置 / 依赖未就绪 / 未实测”，不能把 doctor 的 `ok: true` 或模型列表当作全部能力验收。真实发言、文件投递、外部收费调用等测试须另经用户确认，在指定测试会话做最小验证。

**离开本步骤前正常停止刚打开的管理台**（本机 Ctrl+C；Docker `docker compose stop qq-agents`），保持隔离和暂停。随后检查，再由用户确认上线；`setup live` 必须在管理台停止时运行。

## 第 7 步：检查

```sh
npm run doctor -- --json
```

Docker 下要在容器里运行，因为 `napcat` 这个服务名只能在容器网络里解析：

```sh
docker compose run --rm --no-deps -T --entrypoint node qq-agents src/cli/doctor.mjs --data /data --json
```

逐项诊断 `fail`，说明 `warn` 和 `skip`。期望 `onebot:*` 核对实际 QQ 号、`backend:*` 确认模型目录；未运行管理台时 console 检查可能跳过，角色在隔离或暂停时不能发言是预期。doctor 会访问所配 OneBot/模型服务，但不发送 QQ 消息；模型目录成功不代表真实回合成功。

## 第 8 步：上线（停下来，需要用户明确确认）

把将要生效的内容列给用户：QQ 号、群号和私聊白名单、角色名、人设、后端和模型，以及第 6 步确认的能力、可访问范围、费用与尚未就绪项。告诉用户：“上线后，角色会在这些会话里根据设置自动回复，随时可以在管理台一键暂停。”**只有在用户明确回复确认后**，才能继续。

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

`live` 会把运行模式设为 live、启用角色所用的 QQ 连接，并解除**所有角色**暂停。只适用于这里新建且全部已确认上线的单角色配置；只上线部分角色或已有部署时不要使用，改在管理台按角色操作。`unpause` 会连接 QQ，并解除全局暂停（每次启动时都会重新打开全局暂停）。它的输出会列出每个角色还剩哪些 `blockers`，为空表示角色可以发言了。

## 第 9 步：确认能聊天

在用户确认的一个测试会话中 @ 角色或叫它的名字，核对真实回复、角色身份与投递回执。再运行 doctor；`agent:*` 显示 `can speak` 只是阻断条件已解除，不是已收到真实回复的证据。所选能力分别按第 6 步的最小测试确认，没测的如实列为未验证；不要向所有群广播。没有回复时，对照 [故障排查](TROUBLESHOOTING.md#机器人不说话) 处理。

最后告诉用户：

- 管理台地址是 `http://127.0.0.1:3210`。登录令牌在数据目录的 `admin-token` 文件里（本机是 `.runtime/admin-token`；Docker 下运行 `docker compose exec qq-agents cat /data/admin-token`），请用户自己查看。
- 逐角色交付能力清单，区分已配置、已验证、关闭和待配置，不把“默认开启”写成“已经全部能用”。
- 管理台里随时可以“全部暂停”。修改人设、白名单和权限都在「角色」页。
- 重启后会自动回到全局暂停，需要再运行一次 `unpause`（或在管理台点“解除全局暂停”）。

## 出错时

| 现象                                           | 处理                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `setup init` 报 `DATA_DIRECTORY_LOCKED`        | 管理台正在运行。先停止它（Ctrl+C 或 `docker compose stop qq-agents`），再执行。                          |
| `setup init` 报 `CONFIG_EXISTS`                | 停止初始化，核对是否已有部署，按更新手册保留角色和数据；不要自动覆盖。                                   |
| `INVALID_ANSWERS`                              | 按输出里的 `issues` 修改 answers.json。                                                                  |
| doctor 显示 `onebot:*` 为 `ECONNREFUSED`       | NapCat 没有运行、还没登录完成，或者改完配置后没有重启。                                                  |
| doctor 显示 `onebot:*` 为 `ONEBOT_HTTP_ERROR`  | 核对目标账号、地址和令牌来源，由用户修正对应密钥或 NapCat 设置；不要自动重跑 `init --force` 或输出令牌。 |
| `unpause` 报 `RESTART_WITH_LIVE_FLAG_REQUIRED` | 管理台不是用 `--live` 启动的，或者还没运行 `setup live --confirm`。                                      |
| `unpause` 报 `QQ_NOT_READY`                    | 30 秒内没能连上 QQ。运行 doctor 查看 `onebot:*` 的结果。                                                 |
