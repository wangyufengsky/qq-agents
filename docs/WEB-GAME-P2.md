# 网页游戏 P2：QQ 身份、邀请与隔离 AI 回合

P2 将五子棋接到真实 QQ 来源和 Codex 适配器。日常聊天与游戏分别建立模型回合；游戏只接收自己参与者的投影视图、模块动作 schema 和专门填写的公开游戏角色设定。既有 P0/P1 测试入口仍独立运行，不迁移合成身份，也不修改已发布的五子棋 v1 资源。P2 使用五子棋模块/UI v2。

## 启用条件

全局 `games.enabled` 和对应角色 `agents[].games.enabled` 都默认关闭。现有工具列表、聊天白名单、登录与暂停状态保持原样。首个适配后端为 Codex；DSH 与 Antigravity 明确返回 `GAME_BACKEND_UNSUPPORTED`。

通过管理台的配置接口保存以下字段，保留其他配置和当前修订号。公网隧道或反向代理由部署者提供，不会自动配置域名、代理或 QQ 登录。

```json
{
  "games": {
    "enabled": true,
    "port": 35824,
    "publicOrigin": "https://games.example.test"
  }
}
```

对应角色配置：

```json
{
  "games": {
    "enabled": true,
    "publicPersona": "谨慎的五子棋对手。"
  }
}
```

`publicPersona` 是公开游戏设定，不复制聊天 persona、Self、记忆或会话历史。需要通过模型发起创建/关闭时，再向该角色的 `tools` 增加 `game_create`、`game_close`；管理台角色工具分组可选择它们。`game_view` 和 `game_act` 只在独立游戏回合开放，普通聊天目录不会展示它们。

修改游戏监听端口、入口域名或预算配置后按正常流程重启。进程不会把正在运行的旧入口当成新配置；不匹配时阻止新 AI 调用与网页操作。空 `publicOrigin` 仅供本机健康检查，生产适配器拒绝投递这样的邀请。

## 公网入口验证

启用后，桥接启动独立游戏子进程，仅绑定 `127.0.0.1:<games.port>`。该进程只导入游戏数据库、规则和静态资源，不提供管理 API，不继承桥接密钥或代理环境。它不是操作系统沙箱；部署者仍需保护本机账户和游戏数据目录。

反向代理只能转发游戏端口，必须保留精确的公网 Host，并覆盖 `X-Forwarded-Proto: https`。服务拒绝错误 Host、非 HTTPS、非同源 POST 和跨站请求。Cookie 为 HttpOnly、SameSite=Strict、Secure；邀请页面无第三方资源和 Referer 外泄。不要把管理台端口映射到公网。

1. 使用手机流量或另一条独立网络访问 `https://games.example.test/health`。
2. 记录本次启动返回的 `challenge`，确认这是外部设备实际拿到的响应。
3. 在已认证的管理 API 调用 `POST /api/games/verify-entry`，正文为 `{"challenge":"<外部响应中的 challenge>","external":true}`。鉴权方式与管理台其他 API 相同。
4. `GET /api/games` 查看 `ready` 与 `externallyVerified`。管理 API 不提供预期 challenge；同机请求健康页不能作为异地验收证据。

挑战与当前子进程启动及入口域名绑定，重启后重新验证。验证前不投递可用邀请。P2 自动测试中的本机代理、浏览器引擎和假 QQ 网关不代表真实手机/QQ 内置浏览器公网验收；跨网完整对局属于后续 P3。

## 用户流程与真实身份

- 在允许的私聊发送 `下五子棋`，或在允许的群中明确 @ 角色并发送 `下五子棋`。命令由框架处理，不需要普通聊天模型先生成邀请。
- 群内发公开房间地址；私聊发高熵单次邀请。邀请由统一 QQ 发送器及投递账本处理，模型工具只得到房间编号和投递状态。
- 网页点“确认加入”，复制完整的 `确认游戏 <roomId> <bindingId> <challenge>` 回原 QQ 会话发送。框架检查原连接、角色、来源会话和真实发送者，浏览器不能选择 QQ 身份或座位。
- 返回网页点“已在 QQ 确认，继续加入”，由浏览器绑定 Cookie 兑换会话。双方确认后玩家点“开始”，先执黑落子，AI 执白回应。
- 加入中刷新可恢复同一浏览器的待确认信息；凭据不跨浏览器或域名共享。邀请过期或浏览器丢失绑定时，在原 QQ 会话发送 `重新加入游戏 <roomId>`，重新确权后进入同一房间；不会自动重发未知投递。公网部署、换域与手机实测流程见 [P3 指南](WEB-GAME-P3.md)。

邀请和确认口令在聊天归档前遮蔽，包括未确认投递的网关回声。游戏数据库只保存邀请、浏览器绑定和会话令牌的摘要；浏览器 sessionStorage 保存短期确认口令以支持刷新恢复，不保存私聊邀请令牌。原始私聊邀请只在发送时存在于框架内存和 QQ 投递内容中。

建房来源票据取自当前会话中十分钟内明确请求下棋的可信入站事件，不接受任意 QQ 号。创建请求按来源、发送者和 requestId 幂等；创建记录在投递前保存。`pending`/`unknown` 不重新生成链接或调用发送器，先用已有 `qq_delivery_status` 查询 `game-invite:<requestId>`。短期请求记录保留七天，底层建房墓碑另有容量上限；到期请求不隐式重新建房。关闭请求持久保存首次构造的 actionId 和 expectedRevision，重试不会更新版本绕过冲突。

## AI 执行与失败恢复

状态转移、动作回执、决策和 outbox 在同一 SQLite 事务提交。outbox 初次立即投递，失败后按 1/2/4/8/16 秒及 ±20% 抖动重试，每次最多等待 5 秒，总计六次；接收 inbox 持久去重。确认只表示登记，未完成模型动作时不会显示为已经落子。

worker 领取不可变的 jobKey/runId/fencingToken，租约 60 秒，每 15 秒续租。提交动作在写棋局的事务中检查决策、版本、模块、角色、租约与当前来源权限。暂停、关闭、到期、撤销和过期租约均不能被迟到回调绕过。QQ 断线阻止新 AI 调用；全局/角色/会话暂停、静默、白名单和隔离模式同样生效。

每次真实尝试建立新的 Codex 原生线程，只含该次游戏投影；跨决策的权威状态保存在游戏数据库，不复用聊天会话。工具闭包只允许本房间的 `game_view`/`game_act`，没有 QQ 发送、记忆、网页或文件工具。原生线程和 turn ID 存在游戏执行记录中，游戏回合不写聊天的 model_turns 或 session 引用。同一后端有聊天或游戏工作时，新的游戏执行等待；维护排空会等待已经开始的游戏回合。

本地取消、租约过期和服务重启都不等于远端结束。未确认终态记为 `outcome_unknown`，保留 token 预留和运行引用，阻止替代执行；即使房间到期也不删除唯一的未知运行证据。管理员可用 `POST /api/games/retry`、正文 `{"decisionId":"<决策 UUID>"}` 查询原生线程的准确 turn 终态；无法证明结束时拒绝重试。已失效的旧决策只完成对账，不向新版本补落子。

`model_failed`、`delivery_failed` 或预算耗尽不会判负；网页显示稳定状态码。模型失败不会自动重试；管理员明确重试仍使用原任务并重新预留预算。Web 刷新和轮询不会触发额外模型调用。

## 有限预算

| 配置                       |   默认值 | 含义                                     |
| -------------------------- | -------: | ---------------------------------------- |
| `maxRooms`                 |       32 | 同时保留的房间上限                       |
| `maxAttemptsPerRoom`       |      128 | 单房间累计模型尝试数                     |
| `maxAttemptsPerAgent`      |      256 | 该角色跨房间累计游戏尝试数               |
| `maxAttemptsTotal`         |      512 | 此游戏数据目录的累计尝试数               |
| `reservedTokensPerAttempt` |    32768 | 每次调用前预留量                         |
| `maxTokensPerRoom`         |  4194304 | 房间预留总额上限                         |
| `maxTokensPerAgent`        |  8388608 | 角色游戏预留总额上限                     |
| `maxTokensTotal`           | 16777216 | 框架游戏预留总额上限                     |
| `turnTimeoutMs`            |   120000 | 游戏回合最长时限，同时受角色回合时限约束 |

预算持久保存，重启、刷新、失败、换房或改 requestId 不重置。当前 Codex 适配器没有可执行的硬 token 上限，也没有可靠的逐尝试账单，因此保留完整预留，不自动退款；这些限制约束调用准入，**不能承诺严格费用封顶**。它们是游戏执行预算，不替代日常聊天的原有调度限制。

## 验证与运维

普通回归只使用临时数据、假网关和假后端：

```sh
node --test --test-timeout=120000 test/game-framework.test.mjs test/game-core.test.mjs test/game-http.test.mjs test/game-gomoku.test.mjs test/backends.test.mjs
npm run verify
```

真实模型验收需另行明确授权，并使用独立专用登录目录。只执行一次游戏决策，QQ 终止于内存假网关：

```sh
node scripts/game-p2-acceptance.mjs --allow-real-model --data /path/to/private-game-acceptance
```

先为该目录的 `codex/game-acceptance/home` 配置专用登录。脚本拒绝已有聊天数据库；不要指向生产数据或日常 Codex home。结果写入该私有目录的 `result.json`，包括合法动作、原生终态、尝试次数及聊天 model_turns 数量，不输出凭据或私密邀请。

实际游戏数据在部署数据目录的 `games/rooms.sqlite`，与聊天 SQLite 分离。备份需一起保存整个游戏目录；热备必须使用 SQLite 一致备份，不能只复制运行中的 WAL 主文件。升级排空后重启，保留旧发布与回退资料。启用后若子进程退出，页面请求会失败关闭；检查管理状态和端口后再恢复，不循环重启或自动改公网域名。
