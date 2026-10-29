# 入门指南：在一个群里接入第一个角色

本指南从零开始，把一个角色接入一个 QQ 群。全程分三段：先在隔离模式下把配置填完整，再以 live 模式连接 QQ 但保持全局暂停、只观察不发言，最后才逐道解除暂停。任何一步出错都可以停在当前阶段，不会有消息发到 QQ。

管理台按钮和分组可能随版本调整，下文描述的是要完成的事情，而不是具体按钮位置。

## 最快路径：NapCat + 一个 API key，约 10 分钟

已经有一个登录好目标 QQ 号的 NapCat，再准备一个 OpenAI 兼容服务的 API key（例如 DeepSeek），就不需要安装 DSH 或 Codex。下面是压缩后的顺序，每一步的细节和检查点见后文第 0–3 节。

1. **NapCat**：在 OneBot 11 网络配置里开一个 HTTP 服务器和一个正向 WebSocket 服务器，都监听本机回环地址，设同一个访问令牌（见[第 0 节](#0-准备)）。
2. **环境变量**：在要启动桥接的终端里设置 OneBot 令牌和 API key。变量名可以自己取，配置里只填名字：

   ```sh
   export QQ_UNIFIED_ONEBOT_A='<NapCat 中设置的 token>'
   export QQ_UNIFIED_DEEPSEEK_KEY='<API key>'
   ```

3. **启动并登录**：

   ```sh
   npm ci --ignore-scripts
   npm start -- --live
   cat .runtime/admin-token
   ```

   打开 `http://127.0.0.1:3210` 粘贴令牌。这时仍是隔离模式和全局暂停，不会连接 QQ 或调用模型。

4. **AI 后端**（「连接」页）：添加类型为“OpenAI 兼容 API”的后端，地址填服务商的 API 地址（DeepSeek 为 `https://api.deepseek.com/v1`），密钥变量名填 `QQ_UNIFIED_DEEPSEEK_KEY`，模型名以服务商文档为准。字段说明见 [OpenAI 兼容后端](CONFIGURATION.md#openai-兼容后端)。
5. **QQ 账号连接**（「连接」页）：编辑一个示例连接，填写真实 QQ 号、HTTP 和 WS 地址、令牌变量名 `QQ_UNIFIED_ONEBOT_A`，部署方式选 `external`。
6. **角色**（「角色」页）：编辑一个示例角色，填名称和人格，绑定上面的连接和后端，群白名单填测试群号。
7. **上线**：把运行模式设为 `live` 并保存；对后端执行“检测连接”确认就绪；启用 QQ 账号连接并点击连接，确认“已连接”；然后解除全局暂停和该角色的角色暂停。
8. 在测试群里 @ 角色或叫它的名字。没有回复时看角色卡片上“当前无法发言”的原因，对照 [故障排查](TROUBLESHOOTING.md)。

OpenAI 兼容后端不支持上下文压缩和原生生图；需要这些能力时再按下文接入 DSH 或 Codex。想一步步确认每个阶段，按下面第 0–3 节的完整流程走。

## 0. 准备

**本机软件**

- Node.js 24 或更高版本；需要语音或 GIF 时再装 FFmpeg/FFprobe。
- 一个已登录目标 QQ 号的 NapCat（或其他 OneBot 11 实现）。本项目不分发 NapCat，也不替你登录 QQ。
- 至少一个 AI 后端：
  - **DSH**：DeepSeek Harness 桌面应用已启动并登录。建议用 `npm run dsh:bundle` 生成本项目专用的 preset/MCP bundle 并按 DSH 的流程启用，见 [配置与数据目录](CONFIGURATION.md#dsh-bundle)。
  - **Codex**：已安装 Codex CLI。本项目为每个角色使用独立的 Codex 登录目录 `<数据目录>/codex/<agentId>/home`，需要以该目录为 `CODEX_HOME` 按 Codex 官方流程单独登录一次（例如 `CODEX_HOME=<该目录> codex login`）。不要指向日常使用的 Codex home。
  - **OpenAI 兼容 API**：只需要服务地址和 API 密钥（本机的 Ollama 等不需要密钥），不用安装其他应用。把密钥放进环境变量（方法同下文的 OneBot 令牌），在「连接」页添加类型为“OpenAI 兼容 API”的 AI 后端，填写地址、密钥变量名和模型，见 [OpenAI 兼容后端](CONFIGURATION.md#openai-兼容后端)。

**NapCat / OneBot 设置**

在 NapCat 的 OneBot 11 网络配置中开启：

- 一个 **HTTP 服务器**（桥接通过它调用 `get_login_info`、发送消息等）；
- 一个 **WebSocket 服务器**（正向 WS，桥接主动连接它接收消息）；
- 两者设置同一个访问令牌（token）。

两个地址都必须是本机回环地址，例如 `http://127.0.0.1:23010` 和 `ws://127.0.0.1:23011`；配置校验会拒绝非本机地址。

**令牌放进环境变量**

配置文件只保存环境变量的名字（`tokenEnv`），不保存令牌本身。选一个变量名，例如 `QQ_UNIFIED_ONEBOT_A`，在启动桥接的终端里设置它：

```sh
export QQ_UNIFIED_ONEBOT_A='<NapCat 中设置的 token>'
```

也可以运行 `npm run setup -- secret QQ_UNIFIED_ONEBOT_A`，把它写进数据目录的 `secrets.json`（输入时不显示）。之后每次启动（`npm start`、`scripts/robots.mjs`、Docker）都会自动读取，不用再在终端里设置。该文件只留在私有数据目录，不要提交。缺少该变量时，连接会以 `ONEBOT_TOKEN_ENV_MISSING` 失败。

## 1. 隔离模式：填写配置

```sh
npm ci --ignore-scripts
npm start
cat .runtime/admin-token
```

打开 `http://127.0.0.1:3210`，粘贴令牌登录。新数据目录自带两个示例角色、两个示例 QQ 账号连接和两个 AI 后端，全部停用或暂停。接下来只改其中一套：

1. **QQ 账号连接**（「连接」页）：编辑示例连接，填写真实 QQ 号（`accountId`）、HTTP 和 WS 地址、令牌环境变量名（`tokenEnv`），部署方式选 `external`（NapCat 由你自己启动和维护）。暂时保持停用。
2. **AI 后端**（「连接」页）：保留需要的 DSH 或 Codex 后端，按需填写模型和思考强度；留空表示使用后端默认值。
3. **角色**（「角色」页 → 设置 → 配置角色）：
   - 名称和唤醒别名，人格在下面折叠的「人格与外形」里；
   - 绑定上面的 QQ 账号连接和 AI 后端，模型和思考强度留空表示用后端的设置；
   - **群白名单**里添加测试群号（输入后按回车），私聊白名单暂时留空；
   - 唤醒方式：默认在被 @、被叫名字和私聊时唤醒，其他消息按参与率滑块（默认 5%）偶尔参与。第一次测试可以保持默认。
   - 保持角色暂停。

保存后，角色卡片会显示“当前无法发言：隔离模式、全局暂停、角色暂停、QQ 连接已停用”之类的原因，这正是预期状态。

此阶段可以运行一次本地检查，确认代码和配置环境正常：

```sh
npm run verify
```

`npm run verify` 不调用模型，也不连接真实 QQ。想在不碰真实 QQ 的前提下验证真实模型，可使用 [真实后端的本地验收](LOCAL-ACCEPTANCE.md)，它的 QQ 写请求全部终止在本机回环网关。

## 2. live 模式 + 全局暂停：只观察，不发言

1. 停止管理台（Ctrl+C），在已设置令牌环境变量的终端中以 live 启动：

   ```sh
   npm start -- --live
   ```

2. 在管理台把运行模式改为 `live` 并保存。每次启动都会自动处于全局暂停，此时角色仍不会发言。
3. 在「连接」页对该后端执行“检测连接”，确认显示就绪（Codex 检查专用登录和模型目录，DSH 检查提供方和模型，OpenAI 兼容 API 检查密钥和模型列表）。
4. 在「连接」页启用该连接并保存，然后点击连接。连接前会核对 NapCat 实际登录的 QQ 号；不一致时以 `QQ_ACCOUNT_MISMATCH` 拒绝。
5. 显示“已连接”后，在测试群里发几条消息。全局暂停期间连接仍会记录收到的消息，可以在「经历与日记」等页面确认消息已经进入该角色的记录。

到这里，角色卡片上应该只剩“全局暂停”和“角色暂停”两个原因。

## 3. 解除暂停

1. 解除全局暂停。解除全局暂停不会解除角色暂停，也不会自动连接 QQ。
2. 解除目标角色的角色暂停。
3. 在测试群里 @ 角色或叫它的名字。角色卡片上的“当前无法发言”提示应已消失。

如果角色仍然不回复，或回复后出现“待核对发送”，按 [故障排查](TROUBLESHOOTING.md) 逐项检查。

## 之后

- 日常后台运行、开机后一键启动和自动解除全局暂停，见 [本机运维](LOCAL-OPERATIONS.md)。
- 文件收发、联网浏览、GitHub 读取等能力默认关闭，按需在对应页面为角色单独开启，见 [功能说明](FEATURES.md)。
- 需要暂停某个群而不影响其他会话时，使用会话暂停；随时可以重新打开全局暂停让所有角色立即停下。
