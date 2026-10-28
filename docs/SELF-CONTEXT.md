# Self、主体意图与会话管理

实现从 0.4.0 / main b60fee1 延续。合并不是部署：现有角色、旧人格、登录、聊天和 Docker 均不迁移或启动。正式规则见 [PROMPT-CONTEXT-DISCUSSION.md](history/PROMPT-CONTEXT-DISCUSSION.md)；本文件记录工程选择及验收边界。

## 数据与权限

SQLite schema 4 保存 self_versions、self_candidates、intentions、work_notes、model_turns、session_history、message_progress；原 events、diaries、runtime 和 deliveries 继续作为经历、主观记录、调度状态和发送账本。所有行绑定 agent_id；群/私聊可并行，共享同一主体的 self。

初始 persona 只建立第一版 self。管理员编辑和恢复都创建新版本，expectedVersion 不匹配就拒绝。恢复不抹除后来历史。名字与 appearance 属于固定配置；旧配置须在首次替换 self 前将原有外形明确填入 appearance；未确认时程序拒绝替换并保留首版，模板历史可在管理台查看。不会自动从自由文本中可靠提取外形。

普通聊天只提出候选。主体回顾可以采纳、修订、继续观察或拒绝；源会话可撤回。候选有 baseVersion、revision、理由、证据、反例和回顾记录。日记引用递归追溯到原始入站事件；同作者同文、同场同日讨论不能凑成多次独立经历。程序只执行来源、范围、延迟、版本和少量明确控制性用语检查，不保证识别所有语义上的人格操纵。

每轮固定 selfVersion。下一轮前发现新版本则安全退休并重新加载完整当前版；空闲不调用模型。当前实现选择所有 self 变化均重建，不依赖未经行为确认的系统指令原地替换。撤权与暂停立即失效，不等下一轮。

## 默认值与依据

| 配置                                     | 默认值                                 | 依据                                             |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| selfPolicy.minorDelayMs                  | 6 小时                                 | 兴趣尝试仍需隔开当时情绪；可调                   |
| selfPolicy.majorDelayMs                  | 24 小时                                | 习惯/关系变化需延后且至少两次独立场景；可调      |
| selfPolicy.maxBodyChars                  | 6000 字符                              | 控制稳定提示长度；初始旧模板最多保留 32000 字符  |
| contextPolicy.capacityTokens             | 32768                                  | 仅无后端容量时的保守假定，UI 标估算              |
| contextPolicy.reserveTokens              | 4096                                   | 为工具结果和输出留空间                           |
| 整理阈值                                 | 75%（含预留）                          | 规格固定起点                                     |
| contextPolicy.recoverRatio / hardRatio   | 60% / 90%                              | 避免阈值反复震荡；极限前可靠切换                 |
| contextPolicy.idleMs                     | 45 分钟                                | 仅压力已出现时使用，无压力不按天重开             |
| contextPolicy.compactCooldownMs          | 5 分钟                                 | 原生压缩无明显回落时避免每轮再次调用             |
| subject.enabled                          | false                                  | 需明确开启；旧 proactive.enabled 兼容为主体开关  |
| subject.intervalMs / maxChecksPerDay     | 60 分钟 / 滚动 24 小时 6 次            | 每主体预算，不随聊天数量倍增                     |
| subject.maxContactsPerDay                | 滚动 24 小时 4 次                      | 限制短期主动开场                                 |
| contactCooldownMs / unansweredCooldownMs | 1 小时 / 24 小时                       | 同主体开场冷却；未回应不追问                     |
| offlineReview / reviewInSilence          | false / true                           | 离线不重试；勿扰可保留内部回顾                   |
| 主动范围                                 | 明确列出的群、主人、同伴；额外私聊单列 | 与回复白名单取交集，绝不因能回复就主动联系所有人 |

旧 proactive 的概率、随机间隔、夜间系数不再控制逐聊天主动调用。普通回复、有限睡眠和明确调度任务保留语义。勿扰窗口沿用 agent.silence。未来 App 通过 subject.readTools 和显式 externalReads 白名单复用现有读取适配器，不自动登录或安装新服务。

## 上下文与交接

初始化加载身份、完整当前 self 与简短基本协议；普通回合只追加新增消息、唤醒原因和一次性凭据。详细分页/来源/调度/文件规则在工具说明及结果内。Codex 的稳定层进入 baseInstructions；DSH 固定协议由 preset 承载，动态 self 在初始化消息中提供。

message_progress 记录实际提供的条目，区分摘要与完整正文；零散检索不能越过未见间隙。readThroughSeq 仍须显式 qq_mark_read；发送由 deliveries 独立确认。模型读取数据库最新 self 不改变当前回合已采用版本。

交接包含准确水位、意图/投递结果、未完成工作笔记及原始来源。笔记不是日记或事实；缺失来源标 unavailable，超过首批八条显示溢出并通过 work_notes 翻页。没有笔记时不伪造模型摘要、不强迫日记或 self 更新。原文一直保留。

75% 后优先尝试原生压缩；低于回落阈值才退出整理。无接口、失败或没有确认下降时保留整理状态；普通聊天空闲退休，90% 容量保护强制安全交接，主体检查结束可立即退休。退休不预先调用模型。进程重启将运行中回合记 interrupted，pending 投递记 unknown；未知发送不可重放，但不阻塞无关会话。

## 后端协议核对

核对源是本机 Codex 0.164.0-alpha.11.1 生成的 app-server 协议，以及安装的 DSH 0.2.1-rc.2 包源码和真实独立 profile。

- Codex 支持 thread/resume 的 baseInstructions / developerInstructions 字段、thread/compact/start 和 thread/tokenUsage/updated。占用使用 last.inputTokens + last.outputTokens；total 单独记录累计消耗，不能当当前占用。
- DSH 当次 assistant/message usage 的 input、cacheRead、cacheWrite 为不相交计数，合计再加输出。request/context 给容量。contextPressure.projectedTokens 是带 provider 锚点的估算，不能称全部实测。
- 当前 DSH 的 /compact 走 commands/execute，session/prompt 只是普通消息。生成的 QQ preset 必须挂载隔离 compaction 服务与命令，旧测试 preset 缺少命令会返回未识别；不得把 undefined 当成功。
- DSH 原生压缩可能总结掉初始化 self，因此确认压缩后仍退休并在下一次机会重新提供完整 self。不会声称已实现可靠的动态系统指令替换。
- 无用量时用本桥接追踪的文本字符/工具结果估算上下文，并标明未覆盖未知后端开销；不是累计 token。估算无精确 tokenizer 保证。

## 意图与投递

主体仅有读取、日记、self 回顾和意图工具，没有 QQ 发送能力。目标会话选择 send/defer/cancel/complete；只有 send 才关联本意图的一次出站，使用确定的 intent:<id> 请求键进入共同 outbox。发送前重新校验目标范围、暂停、有效期、冷却、预算和新来信。未回应不会触发 replyCheck 补发；无关来信不自动完成意图。complete 要求本对象新的原始来信证据及判断理由，程序不宣称能确认语义相关性。

管理台「Self 与主体」可查看当前版本、候选来源/回顾、逐版差异与初始化模板，编辑/恢复 self，配置主体范围/预算，取消意图，并查看工作会话、实测/估算用量和手动退休。

## 开发验收与迁移

离线：npm run verify。真实多轮：在独立验收 home/profile 中运行 acceptance:live -- --allow-real-models --run-all --agent acceptance-dsh --case self-context；QQ 请求终止于本机 HTTP/WS 网关。实际模型输出必须人工阅读，脚本的数量/状态/词项断言不代替行为质量判断。

部署前先用 memory:backup 备份 SQLite，再在新数据目录验证 schema 4；JSON 导出包含新表及来源。旧代码会拒绝较新 schema，回退应使用备份的新路径，不能直接让旧版本写 schema 4。更新 DSH bundle 是单独部署动作，本次只刷新独立测试 profile。真实 QQ、生产迁移与跨平台安装验收不包含在本次合并中。

## 审查后的补强

- 旧版连续处理水位是已完成历史的权威基线，不要求旧数据库回读全部历史来补 message_progress。
- 来信机会使用原始事件游标，最多每批 20 项、显式溢出数量；仅成功检查前移。失败、暂停和重启保留未确认事件，新增事件不会被旧批次覆盖。
- 初始化交接包含真正的任务归属/目标、近期主体联系结果及预算/冷却。主体的发送结果从目标聊天账本读取。
- 没有独立外形字段的旧模板会阻止正式 self 替换（IDENTITY_ANCHORS_REQUIRE_MIGRATION），直到管理员在角色设置中明确确认原有外形或无固定外形；不会用一个空泛提示代替实际锚点，也不靠模型或关键词自动猜测。
- 已读取受限 Operations 内容的回合不能写入共享 self、候选、工作笔记或意图；受限日记也不能作这些记录的证据。普通跨聊天回忆继续由 AI 判断表达，不增加逐次 QQ 授权。
- 移除正在工作的角色、取消和配置更新均释放运行槽和完成承诺；压缩期间也受取消控制。
- self 历史和候选工具分页。新表导出恢复与事件游标一起迁移，恢复拒绝覆盖仅已有 self 的目标。

Codex 原生压缩可能发送 last=0 的统计重置通知，适配器忽略该值，不把它当上下文已空。DSH 只有命令返回成功且含 sourceEventSeq 才算真正写入摘要；“无可压缩历史”是无操作，不声称压缩有效。DSH 静态 MCP 工具目录会显示普通工具，但每次调用仍由桥接当前能力凭据执行主体白名单，QQ 发送在程序端被拒绝。

联系预算按尝试计数：网络发送前与 outbox 同一事务预留，失败/未知不归还，避免换主题重试。回执和意图终态同事务更新，重启从账本幂等补齐旧崩溃窗口。已过期的历史冷却不清除新的普通 replyCheck。稳定指令摘要同时涵盖名字、外形、self 与协议，任何实际变化均在下一回合安全重建。完整证据见 [本轮验收](history/QUALITY-SELF-CONTEXT.md)。

## 后端契约变化的统一交接

在准备提示之前，ContextLifecycle 比较后端配置及完整工具协议（name、description、inputSchema）的规范化摘要。对象键顺序和工具目录排列不影响摘要。实际变化及旧的仅名称签名统一走退休、来源交接和 initial 初始化；下一轮加载完整 Self。原会话历史、水位和原始事件不删除，无需 work_note 或日记。无变化时继续复用，重启保留摘要；缺旧契约基线时保守重建一次。适配器遇到不匹配会话直接拒绝，不能在收到增量 prompt 后偷偷新建。

黑话 learner 是独立提取工作，会在契约变化时留存旧会话轨迹，重新提供本批来源；它不继承普通聊天任务。P3 App 分享全历史扫描仍作为独立性能项保留，本批未重构查询路径。

## 异常轨迹留存

聊天、主体和 learner 的会话清空共用事务归档路径。模型工作回合保存 backendId、允许字段中的后端会话引用，以及适配器实际取得的原生 turn ID；后端尚未返回 ID 时明确缺失，不制造定位依据。失败、取消、进程恢复和取消中的会话创建都在清空前写 session_history，并关联 model_turns。归档键按工作范围、会话引用及回合确定，重复恢复/终结不新增同一轨迹。learner 使用独立范围及回合记录，保留原提取水位。

归档仅保存 ID、后端类型、契约摘要及程序生成的终止原因，不复制任意 RPC 错误、URL、认证数据或工具能力凭据。晚到的回调只能留存其原回合引用，不能覆盖另一回合的活动会话。未知投递仍由发送账本决定，轨迹恢复不重放发送。取消中的压缩会退休并留存引用，下一次机会再初始化。

异步最终处理和原生压缩结束前，持久回合仍为 running，并以 phase 标识 finalizing/compacting；模型原始结果另存 modelOutcome。失败/取消先归档清空，再写终态，不能提前标完成而漏掉崩溃恢复。进程在压缩中退出后，下次启动仍能定位并退休原会话。

归档事务或终态写入失败时，learner 也保留 running；计时器和能力凭据仍释放。启动恢复及同范围下一轮准备共用恢复路径，成功归档清空后才能启动新工作；失败会阻止复用旧会话。已提交的 learner 水位继续有效，终态写入故障不会重复执行该批成功结果。晚到会话回调只关联原回合归档，不能恢复已结束会话或覆盖新回合；unknown 投递仍不重放。

## 主体检查状态与历史

管理台单独按主体查询最近 10 个思考回合，不受普通聊天回合数量影响；完成但未发送 QQ、失败、取消与运行中分别显示。检查状态同时显示滚动 24 小时已用/剩余次数，以及结合检查间隔与额度释放计算的最早可检查时间。暂停、离线或恢复中单独提示，不能将已经过去的计划时间当作仍可执行的时间。

只修改主体检查间隔、24 小时检查上限或普通消息参与率时热更新，保留 QQ 连接、已有回合与累计检查次数。提高上限后，到期检查在下一次调度时继续；修改间隔以最近一次检查为基准重新计算。权限、主动联系范围及其他配置变更仍采用完整失效与重新连接流程。

## 空闲时间（主体回合）

主体回合定位为角色自己的空闲时间，而不是“检查有没有事”。此前提示两次写明“可不行动”、每次附上空的“新增消息”、并让会话跨唤醒累积，生产数据中两个角色 3 天 46 次主体回合几乎全部直接结束。现在：

- **每次唤醒新开会话**（`subject.sessionMode`，默认 `fresh`；`continuous` 保留旧行为）。在创建新模型上下文前归档旧会话、已读来源和连续性引用，再建立独立的本轮来源集合。归档失败则停止，旧回调不能写回新来源集合；普通聊天和 `continuous` 不执行这项重建。检查次数、联系预算和平台读取额度不会重置。
- **空闲时间素材**由程序生成并替代“新增消息”：最近 3 条空闲时间日志、最近 24 小时各会话消息数、最近日记标题、按会话汇总的未读来信、已开启平台的入口与今日剩余读取额度、可用的外部搜索、最近几次分享意图的去向。`fresh` 自动素材和交接在展示前过滤受保护日志、日记标题、笔记、意图和最近联系结果，原始记录保留。主体仍可显式读取受保护记忆，但这些读取会限制当前回合的外网请求；下一次独立回合重新按实际展示来源判断。
- **`subject_log`** 仅主体可用：记录做了什么（browsed/searched/read/wrote/reviewed/rested）、发现、下次想做的事；选择休息须给出原因。日志作为 `subject.log` 事件存储，继承本回合资料的保护标记，可被导出和检索。
- **每回合工具上限** `subject.maxToolCallsPerTurn`（默认 8，`subject_log` 不计），超出返回 `SUBJECT_TOOL_BUDGET`。该项与 `sessionMode` 在每回合开始时读取，修改不撤销会话或重建后端。
- **工具调用记录**：所有回合（含聊天）在 `model_turns.toolCalls` 记录每次调用的工具名、成败（错误码）与耗时，不记录参数和结果，最多 50 条。
- **管理台** Self 页新增“空闲时间日志”：24 小时内空闲时间次数、有实际行动的次数、留下日志的次数与工具调用总数，以及每个主体回合用到的工具。

分享仍走意图交接，联系上限、冷却与未回应冷却均不变。

`app_capabilities.contextGate` 描述当前上下文是否通过平台读取入口检查，历史 `lastProbe` 成功只表示平台探测结果，不能代替当轮权限、时段、平台白名单和额度。`external_tools` 同时提供 `callFormat`，主体还会看到 `subjectReadAllowlist`；调用 `external_tool` 必须填写 `serverId`、`tool`、`arguments`。漏填选择器先返回参数错误，只有合法但未授权的组合才返回 `SUBJECT_EXTERNAL_TOOL_NOT_READ_ALLOWED`。
