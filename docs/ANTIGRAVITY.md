# Google Antigravity CLI

Antigravity 是继 DSH、Codex 之后的第三种 harness，配置类型为 `antigravity`；OpenAI 兼容 API 仍是独立的第四种后端。适配器使用官方 CLI 的 headless JSON 流，每回合启动一个进程，后续回合通过明确的 conversation ID 续接。

## 准备和配置

1. 按 [官方 CLI 文档](https://antigravity.google/docs/cli/) 安装 `agy` 并完成官方登录。服务进程必须能访问该登录所用的系统凭据存储；桥接不复制凭据。CLI 的账号、额度与系统登录关联，不保证每个角色使用不同账号。
2. 先运行下文的隔离验收。当前已在 macOS arm64、官方 CLI **1.4.11** 上通过真实模型验收。三平台 CI 使用模拟 CLI；不代表 Linux、Windows 上的真实账号和模型已验收。
3. 管理台「连接」新增后端，适配器选「Google Antigravity CLI」，命令填 `agy` 或已安装二进制的完整路径。模型从目录选择；思考强度可留空，或按模型能力选 `low`、`medium`、`high`、`xhigh`、`max`。
4. 将需要的角色绑定到该后端，检查角色权限和聊天白名单，再按原有流程解除暂停。安装或升级框架不会自动替换已有角色的后端。

后端配置片段如下；省略的字段由统一配置校验补齐：

```json
{
  "id": "antigravity",
  "type": "antigravity",
  "label": "Google Antigravity CLI",
  "command": "agy",
  "model": "",
  "effort": "",
  "toolServers": []
}
```

`npm run setup -- init` 的 answers 也接受 `backend: {"type":"antigravity","command":"agy","model":""}`。无需填写 `baseUrl`、`home`、`provider`、API 密钥或 `env` 映射；这些字段不适用于此适配器。外部 MCP 仍通过统一 `toolServers` 配置并受角色工具白名单限制。

## 会话和工具边界

- 每个角色的 profile 固定在私有数据目录 `antigravity/<agentId>/profile`，每个聊天有独立的哈希命名工作区和会话绑定。只续接同时匹配角色、聊天、配置与工具签名的会话；不会使用 CLI 的“最近会话”选项。原始经历、日记、Self 和发送账本仍由桥接保存。
- 工作区只加载桥接生成的 custom agent、MCP 配置和 `PreToolUse` hook。模型只获得当回合允许的桥接工具，原生 shell、文件、浏览、任务和子代理工具不开放。CLI 的 `finish` 仅结束模型回合，不发送 QQ。
- 工具经随机凭据保护的回环 HTTP 入口回到 `callTool`。凭据只给本回合的 CLI 子进程，不放进模型提示、命令行或公开配置。目录、hook 与调用入口分别检查授权；回合结束或取消时立即撤销入口。普通 assistant 文本不会被自动投递。
- 取消先撤销工具权限，再终止进程树，并退休该模型会话。异常输出、额度不足和无法确认完整性的失败同样退休会话；不自动重试原 prompt 或工具调用。下一回合按桥接的来源交接重新开始。已经开始执行的工具仍由统一取消检查、发送账本和幂等规则约束，不能把取消理解为撤回已经发生的外部动作。
- profile 是桥接专用目录，禁止自行放入 hooks、skills、plugins、全局 MCP 或个人设置。检测到这些配置以 `ANTIGRAVITY_PROFILE_UNSAFE` 拒绝启动，避免继承额外能力。

## 支持范围与兼容性

当前支持文本输入、工具调用、显式会话续接、模型目录和取消。未接入原生上下文压缩、原生生图和输入图片附件；CLI 输出的累计 usage 不等同当前上下文占用，因此不冒充实测容量上报，运行时继续使用保守估算与退休规则。工具返回媒体的识别效果需要按所选模型另行验证。

隔离 profile 使用 CLI 1.4.11 实测可用的 `--gemini_dir`、`--app_data_dir` 参数，它们不是公开稳定 API。升级 CLI 前需重跑隔离验收；若参数、事件结构或 hook 行为变化，应停止使用该版本并更新适配器。框架不捆绑 Antigravity 二进制，不自动下载或升级它；Docker 也需自行准备可用的 CLI 与登录。连接检测读取模型目录，并非付费模型请求成功的证明。桥接关闭额外 G1 credits，模型仍会消耗账号已有额度。

## 隔离验收

```sh
node scripts/antigravity-acceptance.mjs --allow-real-models --command agy --model <模型目录中的ID>
```

脚本必须显式允许真实模型并指定模型；它只新建临时私有数据目录，不读取生产配置、不连接 QQ。通过实际工具调用检查两回合记忆续接、不同聊天隔离、工具执行期间取消、旧会话退休、新会话恢复和零模拟发送。命令输出私有证据目录；目录含模型会话，请勿提交或上传。

`npm run verify` 中的 `test/antigravity-backend.test.mjs` 不调用真实模型，覆盖协议异常、错误脱敏、工具白名单、凭据/Origin 拒绝、hook 策略失效、回合结束后工具失效、取消迟到回调、会话签名与跨聊天绑定。真实验收依赖模型行为，不以模型自述或 `SUCCESS` 单独判定工具测试通过。

实现参考官方 [headless 协议](https://antigravity.google/docs/cli/headless/)、[MCP](https://antigravity.google/docs/mcp/) 和 [hooks](https://antigravity.google/docs/hooks/)；CLI 能力变化以实际版本验收为准。
