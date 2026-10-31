# Google Antigravity CLI

Antigravity 是继 DSH、Codex 之后的第三种 harness，配置类型为 `antigravity`；OpenAI 兼容 API 仍是独立的第四种后端。适配器使用官方 CLI 的 headless JSON 流，每回合启动一个进程，后续回合通过明确的 conversation ID 续接。

## 准备和配置

1. 安装 Git，按 [官方 CLI 文档](https://antigravity.google/docs/cli/) 安装 `agy` 并完成官方登录。服务进程必须能访问该登录所用的系统凭据存储；桥接不复制凭据。CLI 的账号、额度与系统登录关联，不保证每个角色使用不同账号。
2. 先运行下文的隔离验收。协议隔离验收已在 macOS arm64、官方 CLI **1.4.12** 上通过；媒体与压力交接的验收范围见下文。版本以 `agy --version` 输出为准，不以安装目录名推断。三平台 CI 使用模拟 CLI；不代表 Linux、Windows 上的真实账号和模型已验收。
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
- 工作区只加载桥接生成的 custom agent、MCP 配置和 `PreToolUse` hook。模型只获得当回合允许的桥接工具，原生 shell、任意文件读写、浏览、任务和子代理工具不开放；仅允许 `view_file` 读取本回合已授权工具返回并登记的临时图片。CLI 的 `finish` 仅结束模型回合，不发送 QQ。
- custom agent 明确列出已允许工具的结构化参数 schema 和 `call_mcp_tool` 调用格式，避免通用 MCP 入口只呈现工具名称时反复猜参数；参数校验失败还会返回该工具的 schema，不回显输入值，也不扩大权限。重复参数指南以工具名为键，省略逐项包装字段及 schema 的说明性 description，保留类型、必填项、枚举、范围与额外字段限制；完整描述仍保留在 MCP 目录和参数错误反馈中，名为 description 的真实参数不会删除。升级到此参数契约时，旧 Antigravity 会话在下一回合交接重建一次；之后正常续接，其他后端会话不受影响。
- CLI 会按 Git 仓库根目录加载配置，因此桥接为角色目录和每个聊天工作区建立空的独立 Git 仓库，并检查其根目录；不继承上级仓库 hooks/MCP，也不使用个人 Git 配置。不会将私有文件提交到这些空仓库。缺少 Git 或工作区边界异常时拒绝运行。
- 工具经随机凭据保护的回环 HTTP 入口回到 `callTool`。凭据只给本回合的 CLI 子进程，不放进模型提示、命令行或公开配置。目录、hook 与调用入口分别检查授权；回合结束或取消时立即撤销入口。普通 assistant 文本不会被自动投递。
- 取消先撤销工具权限，再终止进程树，并退休该模型会话。异常输出、额度不足和无法确认完整性的失败同样退休会话；不自动重试原 prompt 或工具调用。下一回合按桥接的来源交接重新开始。已经开始执行的工具仍由统一取消检查、发送账本和幂等规则约束，不能把取消理解为撤回已经发生的外部动作。
- profile 是桥接专用目录，禁止自行放入 hooks、skills、plugins、全局 MCP 或个人设置。检测到这些配置以 `ANTIGRAVITY_PROFILE_UNSAFE` 拒绝启动，避免继承额外能力。

## 支持范围与兼容性

当前支持文本输入、工具调用、显式会话续接、模型目录和取消。图片通过已授权工具返回的 MCP `image` 内容块进入桥接，再由受限原生 `view_file` 读取临时图片；这与直接向 headless 输入流发送图片附件不同。未接入原生生图和直接图片附件输入，也没有可由框架主动调用的原生压缩接口。

### 图片理解路径

QQ 图片消息 → `qq_image_read(id)` → 框架下载或读取缓存 → 媒体检查 → 登记本回合临时图片 → 原生 `view_file` → Antigravity 模型。图片文件附件还需要文件接收权限和 `file_download`；`sticker_read(mediaId)` 可重读已缓存图片。GIF 由框架解码为按时间排列的图片帧和时间信息，模型应按 `complete` / `sampled` 判断是否看完。

真实验收发现 CLI 会将 MCP 图片内容块转成落盘资源引用，仅有工具成功和路径文本不能保证像素进入模型，后续多图还出现了误用旧画面的情况。适配器因此把每张图写入私有临时目录，明确要求模型调用原生 `view_file` 读取后再描述；逐张保留原有顺序、帧序号、时间和采样说明，PNG/JPEG/WebP 不缩放或拼图。单帧 GIF 由适配器复用框架 FFmpeg 解码器转为 PNG（沿用最长边 512 像素限制），原始缓存及其他后端的单帧处理不变。

`PreToolUse` hook 只允许当前回合目录中已经登记的精确图片路径，并核对文件大小、SHA-256 和非符号链接；任意其他路径、附加读取参数、被篡改的文件、过期回合一律拒绝。模型不能把路径参数用于读取配置、代码或凭据。回合结束或取消后撤销授权并清理临时图片；之后需要重看时重新调用框架图片工具。

支持静态 PNG/JPEG/WebP 和经转换的单帧 GIF；多帧 GIF 必须先经过框架解码，APNG/动态 WebP 不能静默当作静态图。每个工具结果最多 10 张图、总输入最多 20 MiB、每张最多 8 MiB，每回合最多登记 32 张不同图片和 64 MiB。格式、大小或写入失败返回固定错误，不授予部分图片权限。单帧及多帧 GIF 解码沿用现有 FFmpeg 依赖，原生看图本身不新增外部依赖。

此图片读取契约升级为 `antigravity-tools-v3`。旧 Antigravity 会话在下一回合通过原有交接重建一次，使原生工具集合和指令一致；角色身份、长期记忆、Self 和发送账本保留，DSH/Codex 会话不受此契约影响。

此路径沿用现有工具与来源权限，仅增加上述精确图片读取例外，不开放任意文件、shell 或浏览器工具。工具报错、只返回链接或没有图片内容块时，不能声称看到了画面。不同模型、CLI 版本和图片类型需要分别验收；合成图通过不代表复杂文字、长动图或所有外部 MCP 媒体均可靠。

当前官方 headless 文档只接受文本输入内容块，非文本块会报错。外部 MCP 返回图片可沿用相同的授权图片登记通道，但服务器自身的读取、格式和权限应单独验证；音频、视频、PDF 原始内容块不在本次验收范围内。

### 长会话与压缩

Antigravity 官方说明 CLI 会自动将旧上下文压缩成 checkpoint。框架目前不触发这个内部过程，也没有可靠的公开 headless 手动压缩接口：`/context` 是交互面板，print 模式拒绝执行，不能把发送普通“请总结”提示当成已压缩。

因此 `compaction: false` 表示框架不能主动请求并确认压缩，不表示 CLI 内部永远不压缩。框架仍以最后一次有效响应的实际占用和管理员设置的容量管理会话；达到硬阈值时退休原生会话，下轮重新注入 Self、聊天历史、工作笔记及可回查的来源。原始经历和发送账本保留，历史回放不增加回复额度或推进已读。

若希望保留更长的原生会话，在确认所选模型窗口后设置角色 `contextPolicy.capacityTokens`。例如 `65536` 是管理员选择的框架预算，不是自动识别的模型上限；预留量和 `hardRatio` 仍生效。不要仅因模型宣称长窗口而取消容量保护。默认容量保持 `32768`，已有显式配置不变。

上下文占用取成功回合中最后一个已完成 `agent_response` 的 `input_tokens + cache_read_tokens + output_tokens`，包含缓存输入，不累加各轮请求，不重复加入已包含在输出中的 thinking tokens。忽略 checkpoint 等辅助步骤、其他会话、乱序旧步骤和结束后的迟到回调；最终 `result.usage` 是累计用量，不作为占用。最后一次模型响应没有有效用量时，保留框架原有保守估算，不能把缺失数据当作零。

CLI 未提供模型窗口容量时仍使用角色 `contextPolicy.capacityTokens`（缺省 32768），不宣称这是模型真实上限，也不自动扩大管理员配置；预留量、硬阈值、取消及压力退休继续生效。正常的小上下文不再因工具目录的字符数被当成 token 数而每轮退休。需要更长会话时，应在核对所用模型窗口后设置该角色容量。

隔离 profile 使用 CLI 1.4.11 实测可用的 `--gemini_dir`、`--app_data_dir` 参数，它们不是公开稳定 API。升级 CLI 前需重跑隔离验收；若参数、事件结构或 hook 行为变化，应停止使用该版本并更新适配器。框架不捆绑 Antigravity 二进制，不自动下载或升级它；Docker 也需自行准备可用的 CLI 与登录。连接检测读取模型目录，并非付费模型请求成功的证明。桥接关闭额外 G1 credits，模型仍会消耗账号已有额度。

## 隔离验收

```sh
node scripts/antigravity-acceptance.mjs --allow-real-models --command agy --model <模型目录中的ID>
node scripts/antigravity-chat-acceptance.mjs --allow-real-models --command agy --model <模型目录中的ID>
# 九轮扩展验收，需要 FFmpeg / FFprobe；耗时门槛明确由本次验收指定
node scripts/antigravity-chat-acceptance.mjs --allow-real-models --extended --command agy --model <模型目录中的ID> --max-first-send-ms 120000
```

脚本必须显式允许真实模型并指定模型；它只新建临时私有数据目录，不读取生产配置、不连接 QQ。通过实际工具调用检查两回合记忆续接、不同聊天隔离、工具执行期间取消、旧会话退休、新会话恢复和零模拟发送；上级临时 Git 仓库的 canary hook 必须保持未执行。命令输出私有证据目录；目录含模型会话，请勿提交或上传。

第二条命令进一步通过真实 Runtime、默认工具配置和 32768 容量运行三轮合成私聊，实际调用发送及已读工具。QQ 发送仅落入内存中的假网关，禁止任何真实传输或外部工具动作；检查每轮一条模拟回复、零参数失败、已读推进、同会话续接和标记回忆。每轮从唤醒到首次模拟发送默认必须不超过 30000 ms，可用 `--max-first-send-ms` 明确指定验收门槛；同时记录总回合耗时和逐次生成用量。通过仅说明该模型、CLI 版本及测试负载下的结果，不是生产延迟保证。

`--extended` 在前三轮后增加六轮：随机四色 PNG、单帧 GIF、两帧 GIF、图片不可读取的负例、容量压力退休、换会话后回忆标记并重新读取旧图。图片答案只存在于像素中，不写入模型提示、文件名或工具文本；程序核对模拟回复的颜色顺序、实际图片工具调用和原生 `view_file` 执行。缺图负例必须收到固定读取错误并回答无法看图，不能凭空描述。

扩展验收只在临时角色上将媒体阶段容量设为 `65536`，再临时降到 `4096` 触发真实容量保护，下一轮恢复 `65536`；不改变生产配置，不向模型灌满真实窗口。因此它验证的是压力换会话和来源交接，不是原生自动 checkpoint 已触发，也不是数十万 token 的长窗口压力测试。图片预先写入临时媒体缓存，验收不覆盖 NapCat 上游图片下载、登录或 rkey 可用性。

私有 `acceptance-summary.json` 记录实际 CLI 版本、模型、逐轮耗时、图片内容摘要、续接/新建状态和检查结果；含模型会话的整个证据目录只留本机。普通三轮仍默认使用 `30000 ms` 门槛；扩展示例中的 `120000 ms` 只定义验收上限，不是生产延迟保证。

2026-10-31 在 macOS arm64、CLI **1.4.12**、`gemini-3.8-flash-low` 上的真实验收记录见 [PR #94](https://github.com/wangyufengsky/qq-agents/pull/94)。记录包含默认容量续接、原生看图次数与颜色顺序、缺图负例、压力交接和首次模拟回复耗时；结果只对应注明的版本、模型和合成负载，不是生产延迟或所有图片的识别保证。

`npm run verify` 中的 `test/antigravity-backend.test.mjs` 不调用真实模型，覆盖协议异常、错误脱敏、工具白名单、凭据/Origin 拒绝、hook 策略失效、回合结束后工具失效、取消迟到回调、会话签名与跨聊天绑定。另覆盖图片字节和顺序、原始采样说明、真实 MCP 子进程、路径/哈希/符号链接/过期回合拒绝、格式与容量限制，以及容量退休后的来源保留。真实验收依赖模型行为，不以模型自述或 `SUCCESS` 单独判定工具测试通过。

实现参考官方 [headless 协议](https://antigravity.google/docs/cli/headless/)、[MCP](https://antigravity.google/docs/mcp/) 和 [hooks](https://antigravity.google/docs/hooks/)；CLI 能力变化以实际版本验收为准。

长会话行为参考官方 [上下文与自动 checkpoint](https://antigravity.google/docs/cli/commands/context/)。
