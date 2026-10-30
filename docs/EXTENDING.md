# 扩展：AI 后端、桥接工具与外部 MCP

QQ Agents 是一个可以直接部署的应用，不是 SDK。它留了三个有限的扩展点：

| 扩展点   | 改动方式                                        | 需要 fork |
| -------- | ----------------------------------------------- | --------- |
| 外部 MCP | 只改配置：后端的 `toolServers` 加角色工具白名单 | 否        |
| 桥接工具 | 改源码：`src/tools/` 中新增定义和处理函数       | 是        |
| AI 后端  | 改源码：新增适配器、注册、放开配置校验          | 是        |

只想让角色多一种能力（搜索、生图、转录等）时，优先用外部 MCP：不改代码，升级也不受影响。

## 不稳定的部分

- **没有稳定的程序化 API。** 下文提到的模块路径、函数名、参数和返回结构都是当前实现，任何版本都可能调整，不保证兼容，变更时也不一定有迁移说明。
- **扩展需要 fork 本仓库后修改。** 没有插件目录或运行时加载机制：`BackendRegistry` 的实例在 `src/main.mjs` 里创建，工具注册表在模块加载时冻结，外部代码无法在不改源码的情况下接进来。
- 变化相对较少的是配置文件格式（`version: 1`，见 [配置与数据目录](CONFIGURATION.md)）和两个 MCP 入口 `bridge_tools` / `bridge_call` 的名字，但同样没有兼容承诺。
- 升级时请以代码为准合并上游改动，并在 fork 中保留 `npm run verify` 全部通过。

以下以本文写作时的代码为准；如果和代码不一致，以代码为准。

## 新增 AI 后端

以 `src/backends/openai.mjs`（`OpenAIBackend`，Chat Completions + 桥接进程内的工具循环）为参考实现，它是三个后端中依赖最少的一个。

### 后端对象的契约

后端由工厂函数 `(config, agent, options) => backend` 创建：`config` 是配置里的一项 `backends[]`（已经过校验），`agent` 是使用它的角色配置，`options` 目前只有 `{ root }`（数据目录）。**每个角色各有一个后端实例**，同一后端配置被多个角色使用时会创建多个实例，所以按角色隔离的状态（会话文件、登录目录）应放在 `root` 下按 `agent.id` 分开的目录中，例如 `openai/<agentId>/sessions/`。

| 成员                                  | 必需 | 调用方与语义                                                                                                                                                                                                                                                  |
| ------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run(params)`                         | 是   | 执行一个模型回合，见下表。正常返回表示回合结束；失败时抛错。                                                                                                                                                                                                  |
| `models()`                            | 是   | 返回模型列表（数组，元素至少有 `id`）。管理台列模型时调用（`src/server.mjs`）。                                                                                                                                                                               |
| `health()`                            | 建议 | 「检测连接」调用（`src/core/backend-connections.mjs` 的 `probe`），返回 `{ models, endpoint? }`。未实现时退化为调用 `models()`。                                                                                                                              |
| `cancel()`                            | 是   | 中止该实例上所有进行中的回合（暂停、停止回合时调用）。                                                                                                                                                                                                        |
| `close()`                             | 是   | 释放连接、子进程和外部 MCP 客户端。配置变更、恢复连接和进程退出时调用，之后实例不再使用。                                                                                                                                                                     |
| `sessionSignature(tools)`             | 是   | 返回会话契约签名，通常直接 `return sessionSignature(this, tools)`，见下文。运行时用它判断旧会话能否继续。                                                                                                                                                     |
| `external`                            | 建议 | 一个 `ExternalTools`（`src/backends/external.mjs`）实例，用 `config.toolServers` 构造。`external_tools` / `external_tool` 两个工具通过它找外部 MCP；没有它时这两个工具返回 `EXTERNAL_TOOLS_UNAVAILABLE`。                                                     |
| `compact({ session, signal })`        | 可选 | 原生上下文压缩，由 `src/core/lifecycle.mjs` 在上下文压力高时调用。可返回 `{ usage, requiresReinitialize }`；`requiresReinitialize: true` 表示压缩后身份信息不可靠，运行时会退休会话并在下一回合重建。未实现时保留整理状态，达到硬容量阈值或整理后闲置时退休。 |
| `imageHistory(sessionId)`             | 可选 | 列出某个模型会话中的原生生图项，供 `src/core/generated-images.mjs` 补登记漏掉的生成图。                                                                                                                                                                       |
| `readGeneratedImage(sessionId, item)` | 可选 | 读取一张原生生成图，返回 `{ buffer, mimeType }`，登记进角色媒体库。和 `imageHistory` 一起实现，并在能力声明中打开 `imageGeneration`。                                                                                                                         |

`run` 收到的参数（由 `src/core/turn-runner.mjs` 组装，经 `runWithRecovery` 传入）：

| 参数                                                 | 说明                                                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                                             | 本回合的用户侧提示（消息、唤醒原因等）。续接恢复时会被替换为固定的“继续未完成部分”提示。                                                                                                                 |
| `instructions`                                       | 系统侧指令（人格、self、规则）。只在新建会话时需要写入；已有会话沿用。                                                                                                                                   |
| `tools`                                              | 本回合允许的工具，`[{ name, description, inputSchema }]`，`inputSchema` 是 JSON Schema draft-7。                                                                                                         |
| `callTool(name, args)`                               | 在桥接进程内执行一个工具，返回结果对象；用 `mcpResult()`（`src/tools/index.mjs`）转成 MCP 的 `content` 结构。失败会抛错，应把 `safeToolFailure(error)`（`src/tools/errors.mjs`）作为工具错误交还给模型。 |
| `signal`                                             | `AbortSignal`。中止后尽快抛错（现有实现抛 `ABORTED`），并且不能再调用 `callTool`。                                                                                                                       |
| `session`                                            | 上次保存的会话引用 `{ backend, id, signature }`，没有则为 `null`。                                                                                                                                       |
| `saveSession(value)`                                 | 保存会话引用；传 `null` 表示退休当前会话。新建会话后应立即保存。                                                                                                                                         |
| `onUsage(usage)`                                     | 上报上下文用量，例如 `{ source: "measured", contextTokens, capacityTokens }`，运行时据此决定压缩或退休。                                                                                                 |
| `onBackendTurn({ turnId })`                          | 记录后端自己的回合 ID，便于排查。                                                                                                                                                                        |
| `recovery`                                           | 续接时为上一次的 `BackendTurnFailure`，否则为 `undefined`。                                                                                                                                              |
| `agent`、`conversation`                              | 当前角色配置和会话（`group:<QQ>`、`private:<QQ>` 或主体空闲时间）。                                                                                                                                      |
| `onImageSession`、`onGeneratedImage`、`onImageError` | 只与原生生图有关，参考 `src/backends/codex.mjs`。                                                                                                                                                        |

几条容易忽略的规则：

- **模型文本不会自动发到 QQ。** 后端不需要、也不应该自己发消息；只有 `qq_send` 等工具经统一发送器投递。
- **只暴露 `tools` 里的工具。** 不要给模型 shell、文件系统或供应商自带的工具；OpenAI 兼容后端只把 `tools` 转成 function calling。
- **错误不要带原文。** 供应商的错误正文、HTML、工具参数都可能含密钥或聊天内容，只保留状态码和协议定义的错误码。`OpenAIBackend.request` 是可以照抄的写法。

### 声明能力

在 `src/backends/capabilities.mjs` 的 `BACKEND_CAPABILITIES` 里为新类型加一行：

```js
export const BACKEND_CAPABILITIES = {
  dsh: { compaction: true, imageGeneration: false },
  codex: { compaction: true, imageGeneration: true },
  openai: { compaction: false, imageGeneration: false },
  // mybackend: { compaction: false, imageGeneration: false },
};
```

未声明的类型按 `{ compaction: false, imageGeneration: false }` 处理。`imageGeneration` 决定角色能否拿到 `generated_image_list` 工具（`src/core/runtime.mjs` 的 `toolsFor`）；能力表也会显示在管理台的后端状态里。实际是否压缩看后端对象有没有 `compact` 方法，两者应保持一致。

### 注册

`src/backends/index.mjs` 的 `BackendRegistry` 构造时登记了 `dsh`、`codex`、`openai` 三个工厂，另有 `register(type, factory)`，类型重复时抛 `BACKEND_ALREADY_REGISTERED`，未登记的类型在创建时抛 `BACKEND_NOT_REGISTERED`。注册表实例在 `src/main.mjs` 中创建并传给 `Runtime`，因此可以二选一：

- 在 `BackendRegistry` 构造函数的 `factories` 里直接加一项；
- 或在 `src/main.mjs` 的 `const registry = new BackendRegistry();` 之后调用 `registry.register("mybackend", (c, a, o) => new MyBackend(c, a, o))`。

### 放开配置校验

`src/core/config.mjs` 的 `backends[]` 是严格 schema（`.strict()`），只注册不改校验时配置会被拒绝：

- 把新类型加进 `type: z.enum(["dsh", "codex", "openai"])`；
- 新的配置字段必须加进 schema，否则保存时报未知字段。参照 OpenAI 专用字段的写法：声明为 `.optional()`、**不给默认值**，并加 `refine` 限定只对新类型生效。给现有字段加默认值会改变 DSH/Codex 配置解析后的内容，进而改变它们的会话签名，导致所有已有会话被退休；
- `baseUrl` 的校验按类型区分：DSH 只能是本机回环地址，`openai` 允许 HTTPS 或本机 HTTP。新类型需要在对应 `refine` 里说明自己用哪一种；
- `env` 映射目前只允许 Codex 子进程使用。

想在管理台表单里选到新类型，还需要在 `public/app.js` 的后端类型下拉（`select("type", "适配器", …)`）里加一项。完整 JSON 配置直接写 `type` 即可。

### 会话签名与交接

`src/backends/session-contract.mjs` 提供：

- `sessionSignature(backend, tools)`：对后端配置（去掉 `recovery`，保留绑定的 DSH 实例）和工具目录（名称、说明、`inputSchema`，按名称排序）做规范化 JSON 后取 SHA-256，前缀 `contract-v2:`。
- `assertSession(session, backendType, signature)`：会话的 `backend` 或 `signature` 与当前不符时抛 `SESSION_REQUIRES_HANDOFF`。

`run` 一开始应先算签名并调用 `assertSession`。运行时在每个回合前比较签名（`src/core/lifecycle.mjs`），签名变化、self 版本变化或指令变化时退休旧会话，下一回合新建会话，并通过来源交接（`src/core/context-handoff.mjs`）把最近的来源线索带给新会话；原始经历和日记不受影响。所以：

- 新建会话时保存的引用要带上 `backend: "<你的类型>"` 和当前 `signature`；
- 改了模型、地址或任何工具的说明/schema，现有会话都会重建，这是预期行为。

### 失败分类与续接

失败要抛 `BackendTurnFailure`（`src/backends/turn-failure.mjs`）：

```js
new BackendTurnFailure(backend, code, category, turnId, recoverable);
```

- `code` 和 `category` 只用协议定义的常量（如 `rate-limit`、`authentication`、`context-limit`、`response-stream`、`malformed-response`），会显示在管理台、写进回合记录；不要放供应商原始消息。
- `recoverable` 表示错误本身是暂时的：网络中断、5xx、响应格式错误。429 不算，立即续接只会再次撞上限额。参考 `openaiTurnFailure`。
- `sessionReusable` 构造时总是 `false`，**由后端在确认会话状态完整后改为 `true`**。只有它为 `true` 时，`runWithRecovery` 才会用同一会话续接一次（只续接一次，从不重放原始 prompt 或某次工具调用），并在本回合已有投递尝试时锁定发送。OpenAI 后端只把完整的一步（模型回复加全部工具结果）写进历史，所以 `recoverable` 的错误可以直接标记可续接；DSH、Codex 需要先读回远端状态核对。
- 不可续接时调用 `saveSession(null)` 退休会话再抛错。

### 测试

`test/openai-backend.test.mjs` 用假的 `fetch` 覆盖了请求、工具循环、续接、错误分类和注册表，`test/session-readiness.test.mjs` 覆盖会话签名，`test/backends.test.mjs` 是 DSH/Codex 的协议测试，可以照着为新后端写测试。完成后运行 `npm run verify`。

## 新增桥接工具

“桥接工具”指模型在回合中能调用的 `qq_send`、`memory_search`、`file_list` 等工具，由本进程执行，和外部 MCP 工具不同。

### 定义、规格和注册

| 文件                          | 作用                                                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/definitions.mjs`   | 汇总所有工具定义：`名称: [说明, zod schema]`。核心工具直接写在这里，其余按分组从 `file-tools.mjs`、`mind.mjs`、`saved-media.mjs`、`screenshots.mjs`、`legacy.mjs`、`src/apps/tools.mjs`、`src/github/tools.mjs` 展开。 |
| `src/tools/core-handlers.mjs` | 核心工具的处理函数 `coreHandlers`，签名 `(runtime, ctx, args, name)`。                                                                                                                                                 |
| `src/tools/registry.mjs`      | 把定义和处理函数合成冻结的 `registry`。分组工具用分组的分发函数 `(runtime, ctx, name, args)`。加载时检查：同名处理函数重复抛 `DUPLICATE_TOOL_HANDLER`，定义与处理函数对不上抛 `TOOL_REGISTRY_MISMATCH`。               |
| `src/tools/specs.mjs`         | `toolSpecs(names)` 把 zod schema 转成 JSON Schema，产出给后端的 `{ name, description, inputSchema }`；`TOOL_NAMES` 是全部工具名，管理台的工具白名单列表也来自它。                                                      |
| `src/tools/catalog.mjs`       | `toolAvailable(agent, name, conversation)` 按功能开关决定工具是否可用（如 `github_*` 要求 `github.enabled`，`ops_*` 要求 `operations.enabled`）；另有 DSH 用的两个 MCP 入口和按回合的工具目录。                        |
| `src/tools/index.mjs`         | `dispatchTool`：按名称查注册表、用 zod 校验参数、拒绝参数中出现本回合能力凭据（`CAPABILITY_EXFILTRATION_BLOCKED`），再调用处理函数。                                                                                   |

新增一个工具，最少要：

1. 在 `definitions.mjs`（或某个分组文件的 `*Definitions`）里加定义。说明写给模型看，要讲清楚何时用、结果代表什么、不代表什么；schema 用 `.strict()`。
2. 加对应的处理函数：核心工具加进 `coreHandlers`，分组工具在该分组的分发函数里处理。新分组需要在 `definitions.mjs` 展开定义，并在 `registry.mjs` 的分组列表里登记分发函数。
3. 需要功能开关时，在 `toolAvailable` 里加条件，并在配置 schema 里设置与能力策略一致的默认值；普通工具能力默认开启。
4. 抛出的错误用全大写常量码，并加进 `src/core/error-codes.mjs` 的 `knownErrorCodes`；不在表里的错误信息不会原样离开进程。
5. 为角色启用：工具名加进角色的 `tools` 白名单（管理台「角色」页，或配置 `agents[].tools`）。同时更新 `src/tools/names.mjs` 的工具目录，注册表启动时校验名称一致。新角色默认包含全部目录；已保存的工具白名单保持原样。

`test/tool-registry.test.mjs` 会检查每个工具都恰好有一个 schema 和处理函数。

### 权限怎么校验

一次调用要依次通过：

1. **回合工具集**：回合开始时由 `Runtime.toolsFor(agent, conversation)` 算出本回合允许的工具（角色 `tools` 白名单 + 功能开关 + 会话类型，主体空闲时间另有限定），固定在回合上下文 `ctx.allowedTools`。只有这些工具会出现在 `run` 的 `tools` 里。
2. **执行前复核**：`Runtime.executeTool` 再次检查工具在 `ctx.allowedTools` 中、`toolAvailable` 仍为真，并 `assertActive(ctx)`：角色被暂停、回合被取消或凭据失效时直接拒绝。
3. **参数校验**：`dispatchTool` 用 zod 解析参数，并拒绝把能力凭据写进参数。
4. **处理函数内的业务检查**：发送预算、白名单、静默、跨会话资料外发（`runtime.authorizeExternal`）等由各处理函数负责。处理函数不能信任模型传入的身份或目标：角色、会话和发送目的地都从 `ctx` 取，不从参数取。

工具结果对模型来说是资料，不是指令；会改变外部状态的工具（发送、写文件）需要幂等键或回执，不能因为结果未知就自动重试。

### `callTool` 在进程内的执行路径

Codex 和 OpenAI 兼容后端在桥接进程内跑工具循环：

```
turn-runner 组装 params.callTool = (name, args) => runtime.callTool(ctx, name, args)
  → Runtime.callTool → runTool（记录名称、结果、耗时；主体空闲时间的调用预算）
  → executeTool（上节的第 1、2 步）
  → dispatchTool（第 3 步）
  → registry[name].handler(runtime, ctx, args, name)
```

`ctx` 是闭包里绑定的回合上下文，模型不需要也拿不到能力凭据。

### 为什么 DSH 要走 MCP 入口 `src/mcp.mjs`

DSH 是独立的桌面应用，模型回合和工具执行都在 DSH 进程里进行，桥接无法把进程内的函数交给它。所以 DSH 通过 MCP 调用工具：

- `npm run dsh:bundle` 生成的 bundle 让 DSH 以 stdio 方式启动 `src/mcp.mjs`。这个 MCP 服务只暴露两个入口：`bridge_tools`（发现本回合允许的工具和 schema）和 `bridge_call`（按短名调用）。
- 每个 DSH 回合的提示里带有本回合的能力凭据 `context=…`。模型调用入口时把它放在外层 `context` 参数里，`src/mcp.mjs` 把它作为 `x-agent-capability` 请求头转发到桥接本机的 `/agent/catalog` 或 `/agent/tools`。
- `src/server.mjs` 用 `runtime.capability(token)` 找回对应的回合上下文，之后走与进程内完全相同的 `runtime.callTool` 路径和权限检查。凭据只在本回合有效，回合结束、暂停或取消后失效。
- bundle 中的工具守卫（`src/backends/dsh-guard.mjs`）只允许这两个入口，屏蔽 DSH 自带的其他工具。

因此 DSH 的工具目录是固定的两个入口，新增桥接工具通过 `bridge_tools` 发现即可，不改变 DSH 看到的 MCP 工具列表。

## 接入外部 MCP 服务

不改代码就能给角色接上搜索、生图、转录等外部工具：在后端配置里加 `toolServers`，再给角色开放 `external_tools`（发现）和 `external_tool`（调用）两个工具。

```json
{
  "id": "search",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": { "authorization": "QQ_UNIFIED_SEARCH_AUTH" },
  "allowedTools": ["web_search"]
}
```

这里 `QQ_UNIFIED_SEARCH_AUTH` 是环境变量名，它的值会原样作为请求头发送，所以需要 Bearer 前缀时要把 `Bearer …` 整个写进变量。

| 字段           | 说明                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `id`           | 服务 ID，模型调用时用 `serverId` 指定。                                                                 |
| `transport`    | `stdio`（默认，需要 `command`，可选 `args`）、`http`（Streamable HTTP）或 `sse`（后两者需要 `url`）。   |
| `url`          | HTTPS，或本机回环的 HTTP。不能带用户名、密码、查询参数或片段。                                          |
| `headers`      | HTTP/SSE 的请求头，**值是环境变量名**，不是密钥本身。                                                   |
| `env`          | stdio 子进程的环境变量，同样是 `子进程变量名: 本进程环境变量名`。子进程只拿到 `PATH` 和这里映射的变量。 |
| `allowedTools` | 必填，至少一项。只有列出的工具会出现在发现结果里、能被调用。                                            |

凭据规则：

- **凭据只能用环境变量引用。** `headers` 和 `env` 的值必须是环境变量名（大写字母开头），配置里放不进密钥原文；缺少该变量时连接以 `EXTERNAL_SECRET_ENV_MISSING` 失败。环境变量可在启动终端里设置，或写进数据目录的 `secrets.json` 由 `scripts/robots.mjs` 注入，见 [配置与数据目录](CONFIGURATION.md)。
- HTTP/SSE 请求不跟随重定向，并且只发往配置的同一来源（包括 SSE 返回的端点），凭据不会被带到别的主机。
- `toolServers` 挂在后端上，使用该后端的所有角色共享这组服务；每个角色是否能用，仍由各自的 `tools` 白名单决定。

外部工具的说明和结果属于不可信资料。不要配置能绕过统一发送器直接发 QQ 消息的第三方工具。音频输入、图片结果登记、主体空闲时间的只读白名单等细节见 [功能说明](FEATURES.md#040-外部服务和语音)。
