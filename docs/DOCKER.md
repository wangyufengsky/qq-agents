# 在 Linux / Docker 上部署

本文从零开始，用 Docker Compose 在一台 Linux 服务器上跑起 NapCat 和 QQ Agents，扫码登录 QQ，配置 OneBot 连接，直到角色在 live 模式下发言。macOS 上同样可以用这套方式，但 macOS 用户通常按 [入门指南](GETTING-STARTED.md) 直接在本机运行即可。

整体流程与入门指南一致：先在隔离模式下把配置填完整，再以 live 模式连接 QQ 但保持全局暂停，最后才逐道解除暂停。

## 0. 准备

- Docker Engine 24 或更高版本，带 `docker compose` 插件。
- 一个用于机器人的 QQ 号，以及能扫码的手机 QQ。
- 至少一个能在容器里使用的 AI 后端。镜像里实际可用的是 **OpenAI 兼容 API**（只需要 HTTPS 地址和 API 密钥）；DSH 和 Codex 的限制见文末 [Linux 上不可用的功能](#linux-上不可用的功能)。
- 获取代码：

  ```sh
  git clone https://github.com/wangyufengsky/qq-agents.git
  cd qq-agents
  cp docker-compose.example.yml docker-compose.yml
  ```

## 1. 准备两个环境变量文件

两个文件都以 `.env` 开头，已被 `.gitignore` 和 `.dockerignore` 排除，不会进入 git 或镜像。只给当前用户读写：

```sh
touch .env.napcat .env.qq-agents
chmod 600 .env.napcat .env.qq-agents
```

`.env.napcat`（NapCat 容器使用）：

```sh
# NapCat WebUI 的登录令牌，只在首次初始化配置时生效
WEBUI_TOKEN=<自己生成的长随机串>
# 可选：NapCat 在容器内运行的用户，挂载目录须对它可写
NAPCAT_UID=1000
NAPCAT_GID=1000
```

`.env.qq-agents`（QQ Agents 容器使用）：

```sh
# OneBot 访问令牌：稍后在 NapCat 的 HTTP 和 WS 服务器里设置同一个值
QQ_UNIFIED_ONEBOT_A=<另一个长随机串>
# OpenAI 兼容 API 的密钥，变量名可自定，稍后在管理台的 apiKeyEnv 里填写
OPENAI_API_KEY=<你的 API 密钥>
```

QQ Agents 的配置文件只保存这些变量的**名字**（`tokenEnv`、`apiKeyEnv`），不保存值。随机串可以用 `openssl rand -hex 32` 生成。

## 2. 启动并扫码登录 QQ

```sh
docker compose up -d --build
docker compose logs -f napcat
```

- 日志里会出现登录二维码；也可以打开 `http://127.0.0.1:6099/webui`，用 `WEBUI_TOKEN` 登录 NapCat WebUI 后扫码。
- 服务器没有图形界面时，从自己的电脑建 SSH 隧道再用浏览器访问：

  ```sh
  ssh -N -L 6099:127.0.0.1:6099 -L 3210:127.0.0.1:3210 <服务器>
  ```

- 登录状态保存在 `./data/napcat/qq`，重启容器后不需要重新扫码（QQ 侧要求重新验证时除外）。

## 3. 在 NapCat 里开启 OneBot HTTP 和 WS

在 NapCat WebUI 的网络配置里新建两项，都启用，并设置第 1 步的 `QQ_UNIFIED_ONEBOT_A` 作为 token：

| 类型                     | 监听地址（host） | 端口 |
| ------------------------ | ---------------- | ---- |
| HTTP 服务器              | `0.0.0.0`        | 3000 |
| WebSocket 服务器（正向） | `0.0.0.0`        | 3001 |

监听地址必须是 `0.0.0.0`：QQ Agents 在另一个容器里，NapCat 只监听 `127.0.0.1` 时它连不上。这两个端口没有在 compose 里发布到宿主机，只在 compose 网络内可达，宿主机和外网都访问不到。

## 4. 隔离模式：在管理台填写配置

```sh
docker compose exec qq-agents cat /data/admin-token
```

打开 `http://127.0.0.1:3210`，粘贴令牌登录。然后按 [入门指南](GETTING-STARTED.md#1-隔离模式填写配置) 第 1 步填写，其中 QQ 账号连接这样填：

| 字段                         | 值                                               |
| ---------------------------- | ------------------------------------------------ |
| QQ 账号                      | 机器人的 QQ 号                                   |
| 部署方式                     | `external`（已有外部实例）                       |
| OneBot HTTP 地址             | `http://napcat:3000`                             |
| OneBot WebSocket 地址        | `ws://napcat:3001`                               |
| 访问令牌的环境变量名         | `QQ_UNIFIED_ONEBOT_A`                            |
| NapCat Web 管理地址（可选）  | `http://napcat:6099`，或留空                     |
| 允许 Docker 服务名或内网地址 | 勾选（对应配置字段 `allowPrivateNetwork: true`） |

AI 后端选“OpenAI 兼容 API”，填写 HTTPS 服务地址、密钥变量名 `OPENAI_API_KEY` 和模型。

### `allowPrivateNetwork` 的含义

OneBot 的 HTTP/WS 是明文协议，令牌以 `Authorization: Bearer` 请求头发送。所以默认只允许本机回环地址（`127.0.0.1`、`localhost`、`[::1]`）。连接上设置 `allowPrivateNetwork: true` 后，`httpUrl`、`wsUrl`、`webUrl` 还可以使用：

- 不含点的单段主机名，例如 compose 服务名 `napcat`；
- `host.docker.internal`；
- 私有 IPv4 网段 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`，以及 IPv6 唯一本地地址 `fc00::/7`。

公网地址、带点的公网域名、链路本地地址（如云厂商元数据地址 `169.254.169.254`）、`100.64.0.0/10` 等仍然拒绝，地址里也不能带用户名、密码、查询参数或片段。开启后要清楚：

- **令牌会以明文经过容器网络**。同一 Docker 网络里的其他容器、能抓取该网桥流量的宿主机用户都能看到它。只把 NapCat 和 QQ Agents 放在专用的 compose 网络里，不要和不信任的容器共用网络。
- 校验只看配置里写的字符串，不固定 DNS 解析结果。单段主机名由容器的 DNS 解析，应确保它指向你自己的 NapCat。
- 用私有 IP 跨机器连接（例如另一台局域网主机上的 NapCat）时，令牌会经过局域网，同样是明文。需要跨机器时优先用 SSH 隧道或 WireGuard 等加密通道，再按回环地址连接。

没有勾选该选项时，填 `http://napcat:3000` 会以 `Loopback URL required` 被拒绝保存。

## 5. live 模式 + 全局暂停：只观察，不发言

把 `docker-compose.yml` 里 qq-agents 的 `command: []` 改为：

```yaml
command: ["--live"]
```

然后：

```sh
docker compose up -d qq-agents
```

接下来按 [入门指南第 2 步](GETTING-STARTED.md#2-live-模式--全局暂停只观察不发言) 操作：在管理台把运行模式改为 `live` 并保存，检测 AI 后端，启用并连接 QQ 账号连接。连接前会核对 NapCat 实际登录的 QQ 号。显示“已连接”后，在测试群里发几条消息，确认它们被记录。

常见连接失败：

- `ONEBOT_TOKEN_ENV_MISSING`：`.env.qq-agents` 里缺少该变量，或改完文件后没有重建容器（`docker compose up -d qq-agents`）。
- `ONEBOT_HTTP_ERROR` / `ONEBOT_WS_ERROR`：NapCat 的 HTTP/WS 服务器没有启用、端口不是 3000/3001、监听地址不是 `0.0.0.0`，或 token 不一致。

## 6. 解除暂停

与 [入门指南第 3 步](GETTING-STARTED.md#3-解除暂停) 相同：先解除全局暂停，再解除角色暂停，然后在测试群里 @ 角色。每次容器重启都会重新进入全局暂停。

希望容器重启（包括宿主机重启）后自动恢复发言时，把 compose 里的 `command` 改成 `["--live", "--resume"]`。启动后管理台仍先处于全局暂停，它会连接所有已启用的 QQ 账号连接、检测每个未暂停角色的 AI 后端，全部就绪后才解除全局暂停；角色暂停、会话暂停和静默时段保持不变。NapCat 启动较慢时会按 5 秒起、逐次翻倍、最长 60 秒的间隔重试，最多 10 次，仍未就绪就保持暂停。这期间在管理台手动暂停、解除暂停或切到隔离模式，都会停止自动恢复。概览顶部显示自动恢复的状态。

## 管理台监听地址与端口映射

镜像以 `--host 0.0.0.0` 启动，因为端口映射需要容器内监听所有网卡。安全边界不靠监听地址，而靠下面几层：

- compose 只把端口发布到宿主机的 `127.0.0.1`（`"127.0.0.1:3210:3210"`），局域网和公网连不上。
- 管理台只接受 `Host` 为 `127.0.0.1`、`localhost` 或 `[::1]` 加端口的请求，用局域网 IP 或其他域名访问会得到 `INVALID_HOST`；跨源请求会得到 `CROSS_ORIGIN`。这同时防止 DNS 重绑定。
- 所有管理接口都要求 `x-admin-token` 请求头。管理令牌不会出现在 URL 里，也不要把它写进书签或分享链接。

如果宿主机的 3210 端口已被占用，需要换端口，例如 `"127.0.0.1:8080:3210"`，就要告诉管理台浏览器实际使用的端口，否则 `Host: 127.0.0.1:8080` 会被拒绝：

```yaml
command: ["--public-port", "8080"]
```

需要同时 live 时写成 `command: ["--live", "--public-port", "8080"]`。不要把端口发布成 `"3210:3210"` 或 `"0.0.0.0:3210:3210"`。

不使用 Docker、直接在 Linux 上 `npm start` 时，默认仍然只监听 `127.0.0.1`，不需要 `--host`。

## 镜像说明

- 基于 `node:24-bookworm-slim`，内含 `ffmpeg`/`ffprobe`（语音转码、GIF 帧读取），依赖用 `npm ci --ignore-scripts --omit=dev` 安装。
- 以镜像自带的非 root 用户 `node`（uid 1000）运行。数据目录是 `/data`，compose 用命名卷 `qq-agents-data` 挂载，里面有配置、记忆数据库、管理令牌和收发的文件。备份时备份这个卷。
- 公开网页截图需要 Chromium，默认不装。需要时构建带 Chromium 和中文字体的镜像：

  ```sh
  docker compose build --build-arg WITH_CHROMIUM=true qq-agents
  ```

  截图工具按以下顺序找浏览器：环境变量 `QQ_SCREENSHOT_BROWSER`，然后 `CHROME_PATH`（都必须是存在的绝对路径，写错时直接报错而不会换用别的浏览器），然后本平台的常见路径（Linux 上是 `/usr/bin/chromium`、`/usr/bin/chromium-browser`、`/usr/bin/google-chrome`、`/usr/bin/google-chrome-stable`、`/snap/bin/chromium`）。都找不到时工具返回 `SCREENSHOT_BROWSER_MISSING`。

## Linux 上不可用的功能

| 功能                                   | 原因与替代                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/robots.mjs` 一键启动          | 它管理的是 macOS 原生 QQ 和本机 NapCat 进程。Linux 上由 compose 负责启停和 `restart: unless-stopped`。                                                                          |
| 本地 TTS（`voice_synthesize`）         | 调用的是 macOS 自带的 `say`。其他平台上即使在角色设置里开启，工具也只返回 `LOCAL_TTS_UNAVAILABLE`，不生成文件、不发送任何内容，并提示模型改用文字回复。语音接收与转码不受影响。 |
| DSH 后端                               | DeepSeek Harness 桌面应用只有 macOS 版，且只允许回环地址；容器里的回环是容器自己，连不到宿主机上的 DSH。                                                                        |
| Codex 后端                             | 镜像里没有 Codex CLI。需要时可基于本镜像另建镜像安装 Codex CLI，并按 [入门指南](GETTING-STARTED.md#0-准备) 用 `<数据目录>/codex/<agentId>/home` 单独登录。                      |
| 部署方式 `docker`（由桥接启停 NapCat） | 需要在桥接里执行 `docker` 命令。镜像里没有 Docker CLI，也不应把 Docker socket 挂进容器（等同于宿主机 root 权限）。在 compose 部署里一律用 `external`。                          |

## 停止与残留锁

管理台运行时在数据目录里持有 `process.lock`，正常退出时删除。Docker 默认只等 10 秒就强制结束容器，而管理台自己的关闭预算是 30 秒，所以 compose 示例里设置了 `stop_grace_period: 40s`。不用 compose 时，用 `docker stop -t 40 <容器>` 停止。

容器被强制结束（`docker kill`、超出宽限期、内存不足被杀、宿主机断电）后，锁会留在数据卷里，下次启动报 `DATA_DIRECTORY_LOCKED`，`restart: unless-stopped` 会让容器反复重启又失败。程序不会自动回收旧锁。按下面的步骤处理：

```sh
docker compose stop qq-agents
docker compose ps                     # 确认 qq-agents 已停止，且没有别的容器挂载同一个卷
docker compose run --rm --no-deps --entrypoint cat qq-agents /data/process.lock   # 记录的 pid 和启动时间
docker compose run --rm --no-deps --entrypoint rm qq-agents /data/process.lock
docker compose start qq-agents
```

只有确认没有任何容器或进程还在使用这个数据卷时才删除锁；两个实例同时写同一个数据库会损坏数据。

## 升级与备份

```sh
git pull
docker compose up -d --build
```

备份数据卷（容器停止时进行，避免数据库写入中途）：

```sh
docker compose stop qq-agents
docker run --rm -v qq-agents_qq-agents-data:/data -v "$PWD":/backup node:24-bookworm-slim \
  tar -czf /backup/qq-agents-data.tgz -C /data .
docker compose start qq-agents
```

卷名前缀取决于 compose 项目名（默认是目录名），用 `docker volume ls` 确认。备份文件里有令牌和全部聊天记录，按私密数据保管。
