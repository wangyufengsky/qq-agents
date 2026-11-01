# 让角色更像人：节奏、口吻、作息与关系

基线：PR #119 / 7ada579。本文是交给开发者的设计文档，**不是已实现功能**。分三档、七个 PR 逐个实现、验证和合并；每个 PR 都按 [AGENTS.md](../../AGENTS.md) 与 [CONTRIBUTING.md](../../CONTRIBUTING.md) 的完整流程交付。

## 现状

已有的拟人基础不在本文范围内重做：可成长的 Self（`src/memory/identity.mjs`）、自记心情（`src/core/mood.mjs`）、人物卡与相处记录（`src/core/person-cards.mjs`）、日记、空闲时间与主动意图（`src/core/subject.mjs`）、群聊现场（`src/core/floor.mjs`）、分条连发 `qq_send_burst`、表情包、语音、拍一拍。

本文要补的缺口：

| 缺口       | 现状                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 打字节奏   | 连发间隔是 `burstMinMs`–`burstMaxMs` 的均匀随机数，外加 `longGapProbability` 概率的 `longGapMs` 长停顿（`src/tools/legacy.mjs` 的 `qq_send_burst`），与消息长度无关；首条回复没有“打字时间”。 |
| 正在输入   | 传输层没有调用 NapCat 的输入状态接口。                                                                                                                                                        |
| AI 腔      | 发送前已用 `mdToPlain` 把 Markdown 转成纯文本（`src/core/delivery.mjs`），格式问题基本解决；但“总结一下”“希望对你有帮助”、每条都反问、闲聊写长段落这类口吻没有任何约束或检查。                |
| 作息       | 只有主动联系的 `proactive.nightFactor` 和平台浏览时段 `apps.hours`；聊天回复不分昼夜，凌晨也会立即回复。                                                                                      |
| QQ 小动作  | 没有贴表情回应、撤回自己消息；收到别人给自己消息贴的表情也不会进入记录。                                                                                                                      |
| 沉默与留白 | 群聊提示以“不插话”的禁止句式为主，没有把“不回、只回个表情、话题自然结束”说成正常选择。                                                                                                        |
| 关系温度   | 人物卡记录事实与印象，没有反映“熟不熟”的程度，称呼、语气和主动找人的频率不随关系变化。                                                                                                        |

## 总体原则

- **所有新行为都走现有边界**：发送与动作经 `DeliveryService` 和幂等账本；暂停、静默、白名单、限速、`isolated`、受保护工作照常生效。延迟和作息只能让角色“更慢、更少”，不能绕过任何限额或制造新的回复授权。
- **新能力默认关闭或保持现有行为**：打字节奏这类纯节奏改进可默认开启，但默认值要让总耗时与现在相近；贴表情、撤回、作息默认关闭，由管理员在管理台按角色开启。
- **不伪造**：不为显得像人而编造经历、故意说错事实或假装没看到已读消息。“不完美”只体现在节奏、长度和是否开口上。
- **配置改动三处同步**：`src/core/policy.mjs` 的 schema、`npm run defaults:write` 生成的默认值与 `examples/config.example.json`、[配置说明](../CONFIGURATION.md)；管理台对应表单补齐。
- **新错误码**登记到 `src/core/error-codes.mjs` 的 `knownErrorCodes`；**新工具**按 [扩展指南](../EXTENDING.md#新增桥接工具) 同时改定义、处理函数、`catalog.mjs` 开关和 `names.mjs`。

## 第一档

### PR 1：按长度计算的打字节奏

**目标**：短句快、长段慢；首条回复也有与长度相称的打字时间。

**配置**（`behavior.typing`，新对象，旧配置缺省时按默认值加载）：

| 字段              | 默认    | 含义                                                      |
| ----------------- | ------- | --------------------------------------------------------- |
| `enabled`         | `true`  | 关闭时恢复现在的 `burstMinMs`–`burstMaxMs` 均匀随机。     |
| `msPerChar`       | `180`   | 每个字符的基础打字耗时。表情、链接、图片按固定 1 字计。   |
| `jitter`          | `0.35`  | 乘性抖动幅度，实际耗时 = 基础 ×（1 ± jitter）的均匀随机。 |
| `minMs`           | `600`   | 单条下限。                                                |
| `maxMs`           | `12000` | 单条上限，避免长文让对方等太久。                          |
| `firstReply`      | `true`  | 是否给回合内第一条发送也加打字时间。                      |
| `firstReplyMaxMs` | `6000`  | 首条的单独上限：此前已有 `quietAfterNewMs` 攒消息的等待。 |

**行为**：

1. 新增纯函数 `typingDelay(text, typing, random)`（建议放 `src/core/typing.mjs`，带 `// @ts-check` 并加入 `tsconfig.json`）。
2. `qq_send_burst`：第 2 条起，间隔改为 `typingDelay(下一条)`；模型显式传 `gapMs` 时仍以 `gapMs` 为准。保留 `longGapProbability` 作为偶尔“走神”的额外停顿，叠加而非替换。
3. 首条：在 `qq_send` / `qq_send_burst` / `qq_send_voice` 的第一次发送前，若本回合尚无确认发送（`ctx.confirmedSends` 为 0）且 `firstReply` 开启，先等待 `min(typingDelay, firstReplyMaxMs)`。语音按转写文字或固定 2 秒计。
4. 等待使用 `ctx.controller.signal`，期间暂停或撤权立即中断；等待后再次 `runtime.assertActive(ctx)`，与现有连发一致。
5. 等待期间收到新消息不打断本条（保持现有语义）；但若 `typing.enabled` 且等待超过 3 秒，等待结束后应检查是否有新的人类消息到达，有则沿用“已选定意图遇到新消息”的处理思路，让模型先读再决定是否继续发送。实现时可只在首条做这个检查，连发中间不做，以免改变 burst 的回执语义。

**不改**：定时任务的固定文字、`failureNotice`、`outageNotice` 等程序固定发送（`ctx.internalDelivery`）不加打字时间。

**测试**（`test/typing.test.mjs` + 现有 burst 回归）：注入 `runtime.random` 固定值验证长度与延迟单调、上下限、`gapMs` 覆盖、关闭后回到旧算法；暂停时等待被中断且不发送；内部发送不延迟。用假时钟，不真实等待。

### PR 2：私聊“正在输入”

**目标**：私聊里打字等待期间，对方看到“对方正在输入…”。

**设计**：

- `OneBotTransport` 新增 `setTyping(conversation)`：仅 `private:` 会话调用 NapCat 的 `set_input_status`（参数 `user_id`、`event_type: 1`）。群聊 QQ 本身不显示，直接跳过。
- 在 PR 1 的每次打字等待开始时调用一次；状态由 QQ 客户端自行超时消失，不需要显式取消。
- **尽力而为**：调用失败、网关不支持（返回非 0 retcode）或超时 1 秒，只记一次诊断计数，不抛错、不影响发送、不写入聊天记录和发送账本。
- 开关 `behavior.typing.indicator`，默认 `true`；`isolated` 角色或会话暂停时不调用。
- 需在真实 NapCat 版本上确认接口名与参数（不同版本可能为 `set_input_status` 或扩展接口），写入 [QQ 连接说明](../GETTING-STARTED.md) 的兼容表。网关不支持时功能自动失效即可。

**测试**：假网关记录调用；群聊不调用；网关报错时发送仍成功；暂停后不调用。

### PR 3：去 AI 腔——说话样本、提示与发送前口吻检查

**3a. Self 说话样本**

- Self 初始化模板（`identity.mjs` 的 `initialize` 使用的 `agent.persona`）的推荐格式里增加一节“说话样本”：5–10 句这个角色真实会说的话，体现口头禅、标点习惯（例如句尾不用句号）、笑的写法、常见长度。只是模板与管理台占位提示的变化，**不改已建立的 Self**。
- 管理台 Self 编辑页在占位文字或帮助里说明这一节；[Self 与会话](../SELF-CONTEXT.md) 写清它属于 Self、可随成长修改。

**3b. 稳定提示**

- 在 `src/core/prompts.mjs` 的聊天分支增加一段口吻说明，用正面描述加少量反例，例如：QQ 聊天按 Self 的说话样本说话；闲聊通常一两句；不写“总结一下”“希望对你有帮助”“作为……”“有什么可以帮你”之类客服或助手用语；不必每条都以问题结尾；认真问题可以说长，但分段说话而不是写报告。
- 这会改变稳定层内容，按 [Prompt 与 Self 的职责](../PROMPT-CONTRACTS.md) 的规则触发一次会话交接；`test/prompt-contracts.test.mjs` 相应更新。

**3c. 发送前口吻检查**

- 配置 `behavior.toneCheck`：`mode` 为 `off` / `warn`（默认 `warn`），`phrases` 为管理员可追加的短语列表（内置一份默认列表，见下），`maxLinesCasual` 默认 `6`。
- 位置：`DeliveryService.send` 中 `mdToPlain` 之后、进入 `deliver` 写 `pending` 账本**之前**。这样被退回的文本不占用 requestId，也不会出现“未知投递”。
- 规则：命中内置或自定义短语，或在非管理员会话中单条超过 `maxLinesCasual` 行，则抛 `TONE_REVIEW_SUGGESTED`，错误详情给出命中项（短语本身，不回显全文）。
- 放行：同一回合内对**同一 requestId 且同一文本**的第二次提交直接放行（记在 `ctx`，不持久化）。模型可以选择改写后用新 requestId 发送，也可以确认原文合适后原样重发。这样检查只是提醒，不会卡死正常表达。
- 内置短语（可在实现时调整，放在单独模块便于测试）：`希望对你有帮助`、`作为一个AI`、`作为AI`、`总结一下`、`综上所述`、`有什么可以帮你`、`如果你还有其他问题`、`我理解你的感受`。
- 不检查：`ctx.internalDelivery`、合并转发、文件、主人私聊中明确要求的长文（以行数规则豁免主人私聊即可）。

**测试**：命中时不写账本、返回命中项；同 requestId 同文本二次放行；改字后视为新文本再次检查；`off` 不检查；内部发送不检查；错误码原样离开进程。

## 第二档

### PR 4：作息与忙闲

已由 [PR #123](https://github.com/wangyufengsky/qq-agents/pull/123) 实现；默认关闭，正式配置与边界见 [配置说明](../CONFIGURATION.md#作息与忙闲behaviorrhythm)。真实 QQ 作息体验需在测试账号单独验收。

**目标**：角色有睡觉时段和偶尔的慢回复，回复时机像一个有生活的人。

**配置**（`behavior.rhythm`，默认 `enabled: false`，开启前行为完全不变）：

| 字段           | 默认                                           | 含义                                                                          |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `enabled`      | `false`                                        | 总开关。                                                                      |
| `timezone`     | 同 `proactive.timezone`                        | 作息时区。                                                                    |
| `sleep`        | `{start:"01:00", end:"08:30"}`                 | 睡觉时段，可跨午夜。                                                          |
| `sleepMode`    | `"defer"`                                      | `defer`：睡觉期间不唤醒，醒来后统一处理；`slow`：照常唤醒但套用下面的慢回复。 |
| `urgentOwners` | `true`                                         | 主人私聊不受睡觉推迟（仍有打字节奏）。                                        |
| `wakeJitterMs` | `1800000`                                      | 起床时间在 `end` 之后 0–30 分钟随机，避免每天整点准时。                       |
| `lateReply`    | `{probability:0.1, minMs:60000, maxMs:600000}` | 非睡觉时段，未被 @、未被引用的消息有一定概率晚几分钟才唤醒。                  |

**行为**：

1. **唤醒推迟**：在 `src/core/conversations.mjs` 计算 `wakeDueAt` 的位置（`slide`）之后加一个作息调整：睡觉时段内把 `wakeDueAt` 推到“今天的起床时间 + 抖动”；`lateReply` 命中时加上随机延迟。抖动值在一次推迟内固定（写入会话状态），重启后不重新抽签。
2. **不推迟的情况**：主人私聊（`urgentOwners`）、定时任务唤醒、受保护工作、意图唤醒中已选定的发送；@ 或引用本角色的消息不套用 `lateReply`（但睡觉期间仍推迟）。
3. **起床语境**：被推迟到起床后的回合，`turnEnvironment` 增加一行“你刚起床，下面是睡觉期间收到的消息”，并给出睡觉时段，便于模型自然地说“刚醒”。这行由程序提供，不写入 Self。
4. **空闲时间**：睡觉时段内跳过主体空闲回合（`subject.mjs` 的调度），醒来后的第一次空闲时间照常。`proactive.nightFactor` 保留，作息开启时睡觉时段内主动联系概率直接为 0。
5. **状态可见**：`turnEnvironment` 在作息开启时给出当前作息状态（醒着 / 快睡了 / 睡觉中被主人叫醒），管理台角色状态卡显示“睡觉中，预计 08:47 起床”。
6. **限额不变**：推迟后批量处理的消息仍受连续回复上限、分钟/小时限速约束；推迟不产生额外回复额度。

**持久化**：只用现有 `runtime` 表的会话状态 JSON 新增可选字段（如 `rhythmDeferredUntil`），旧状态无此字段时按未推迟处理，不需要数据库迁移。

**测试**：假时钟覆盖跨午夜睡觉段、起床抖动在重启后不变、主人私聊不推迟、@ 消息不套用 `lateReply`、关闭时 `wakeDueAt` 与旧逻辑完全一致、睡觉时段主体不运行、起床回合环境行出现一次。

### PR 5：贴表情回应（含收到回应）

**目标**：角色可以只给消息贴一个 QQ 表情，也能看到别人给自己的消息贴了什么。

**发出**——新工具 `qq_react`：

- 参数：`requestId`、`messageRef`（本会话内的记录 ID 或消息号，按 `qq_send.replyTo` 相同方式用 `resolveMessage` 解析，不信任模型给的网关 ID）、`faceId`（必须在 `src/transport/qq-faces.mjs` 已登记的 QQ 标准表情中）。
- 走 `runtime.deliver(..., { action: true })`，与 `qq_send_poke` 同一模式：意图 `{kind:"react", messageId, faceId}`，正文 `[贴表情:名称]`，网关调用 NapCat 的 `set_msg_emoji_like`（`message_id`、`emoji_id`），成功回执为 `{confirmed:true}`。
- 限额：计入分钟/小时发送限速；**不**计入连续文字回复批次，也**不**恢复任何回复额度。另设 `behavior.actions.reactMaxPerMinute`（默认 3）。
- 开关：`behavior.actions.react`，默认 `false`；`catalog.mjs` 的 `toolAvailable` 按开关裁剪。
- 错误码：`REACT_UNKNOWN_MESSAGE`、`REACT_FACE_UNKNOWN`、`REACT_RATE_LIMITED`、`REACT_UNSUPPORTED`（网关不支持）。
- 提示：在 PR 3 的口吻说明里补一句“有时贴个表情或发个表情包就够了，不必每次都打字”，仅在工具可用时出现。

**收到**：

- `src/transport/onebot.mjs` 归一化 NapCat 的 `group_msg_emoji_like` 通知为 `notice.reaction`，正文 `[贴表情] QQ:<操作者> → 消息 <消息号>：<表情名>`，只处理贴在**本角色消息**上的回应，其他丢弃，避免刷屏。
- 收到回应只作为观察记录，不触发唤醒、不算人类新消息、不恢复回复额度。`liveInput` 只接受 `message.received`，额度与授权天然不受影响；唤醒路径需对照拍一拍（`notice.poke`）现有处理，显式把 `notice.reaction` 排除在唤醒之外。下一次正常回合的聊天材料里能看到。

**测试**：解析非本会话消息被拒；未知表情被拒；暂停时拒绝；动作写账本且重复 requestId 不重发；开关关闭时工具不可见、执行也拒绝；收到的回应不唤醒且不推进水位。

### PR 6：撤回自己刚发的消息

**目标**：角色发错字或说错话时，能在 QQ 允许的时间内撤回并补一句。

**新工具 `qq_recall`**：

- 参数：`requestId`、`messageRef`。只能指向**本角色在当前会话发出且账本状态为 `sent`** 的消息；入站消息、别人的消息、`unknown`/`pending` 投递一律拒绝。
- 时限：`behavior.actions.recallWindowMs`，默认 `110000`（QQ 普通撤回限 2 分钟，留出余量），按账本记录的发送时间计算，超时返回 `RECALL_TOO_LATE`。
- 走 `runtime.deliver(..., { action: true })`：意图 `{kind:"recall", messageId}`，网关调用 `delete_msg`。成功后追加一条 `action.confirmed` 事件，并让被撤回的原消息在聊天材料、回放和人物卡来源中显示为“（你已撤回）”。**原始记录保留**，不删除、不改写正文，符合“原始经历独立保留”的边界。
- 限额：`behavior.actions.recallMaxPerHour`，默认 3；不恢复回复额度，撤回后补发的消息照常计入限额。
- 开关：`behavior.actions.recall`，默认 `false`。
- 错误码：`RECALL_NOT_OWN`、`RECALL_TOO_LATE`、`RECALL_NOT_SENT`、`RECALL_RATE_LIMITED`、`RECALL_UNSUPPORTED`。
- 网关返回失败时记为失败动作，不重试；网关超时按动作的 `unknown` 处理，不换 requestId 重放。

**展示**：`chat-context.mjs` / `chat-recall.mjs` 生成材料时识别撤回动作；导出格式里撤回只是一条普通动作事件，旧版本导入时可读（显示为动作记录），无需格式升级。

**测试**：只能撤自己的已发送消息；超时拒绝；`unknown` 投递拒绝；撤回后原记录仍在且材料中带标记；重复 requestId 不重复撤回；暂停与开关关闭均拒绝。

## 第三档

### PR 7：沉默与留白、关系温度

**7a. 沉默与留白**（只改提示，不加机制）：

- 把聊天提示中“不插话”系列的禁止句改写为正面描述：不回、只贴表情或表情包、简短接一句、让话题自然结束，都是正常的选择；最近说得多就少说；不必为每条消息找话说。
- 明确“已读不回”的做法：读完、`qq_mark_read` 标记已处理、结束回合，不需要解释。
- 不引入故意记错、假装没看到等机制。
- 回归：`test/prompt-contracts.test.mjs` 更新稳定层快照；会话交接按协议变化触发一次。

**7b. 关系温度**：

- **计算而非让模型打分**：新增纯函数 `closeness(memory, personId, now)`（建议放 `src/core/closeness.mjs`），从事件表统计与此人的互动：最近 30 天双向消息轮次、对方主动开口次数、本角色主动开口且被回应的次数，按 14 天半衰期衰减，映射为四档 `陌生 / 认识 / 熟 / 很熟`。阈值写成常量并在测试中固定。
- **结果缓存**：写入 `person_notes.value` JSON 的可选字段 `closeness: {tier, at}`，24 小时内复用。旧行无此字段时按需计算；它是派生数据，导出时可省略，导入后重新计算，不需要迁移。
- **使用**：人物卡呈现给模型时附带档位（例如 `相处：熟`），提示中说明档位只影响称呼与语气的随意程度，不改变任何权限，也不是对对方的评价；空闲时间素材的 `reach.targets` 按档位与上次联系时间排序，更熟的人更常想起，但冷却与每日额度不变。
- **管理员可覆盖**：管理台人物卡页允许把某人固定为某档（写 `closeness.override`），用于主人或刚认识但需要熟络的对象。
- **隔离**：档位按 `agentId` 隔离，同伴之间不共享；不对外显示，不写进 Self。

**测试**：固定事件序列得到确定档位；半衰期衰减生效；覆盖值优先；旧人物卡无字段时可读；档位不进入 QQ 发送正文；各角色互不影响。

## 交付顺序与依赖

| 顺序 | PR                 | 依赖 | 数据库变化 | 默认行为变化         |
| ---- | ------------------ | ---- | ---------- | -------------------- |
| 1    | 打字节奏           | 无   | 无         | 有，总耗时与现在相近 |
| 2    | 正在输入           | 1    | 无         | 有，失败自动失效     |
| 3    | 去 AI 腔           | 无   | 无         | 有，`warn` 仅提醒    |
| 4    | 作息与忙闲         | 1    | 无         | 无（默认关闭）       |
| 5    | 贴表情回应         | 3    | 无         | 无（发出默认关闭）   |
| 6    | 撤回自己消息       | 无   | 无         | 无（默认关闭）       |
| 7    | 沉默留白、关系温度 | 3    | 无         | 有，仅提示与排序     |

1、3、6 互不依赖，可以并行开发；涉及 `prompts.mjs` 的 3、5、7 建议按顺序合并以减少冲突。

## 每个 PR 的共同检查

- 默认值改动后运行 `npm run defaults:write`，核对示例配置和 [配置说明](../CONFIGURATION.md)；管理台表单与帮助同步，新增全局符号登记到 `eslint.config.mjs`。
- 新错误码登记 `knownErrorCodes`；新工具过 `test/tool-registry.test.mjs`。
- 定向测试后跑完整 `npm run verify`；`CHANGELOG.md` 的“未发布”写明改了什么、默认是否开启、兼容性。
- 实现完成后在本文对应小节注明“已由 PR #编号 实现”，并把实际行为写进最贴近的正式指南（如 [功能说明](../FEATURES.md)），本文保持为设计记录。

## 验收

- 模拟测试只证明逻辑；真实效果按 [本机验收](../LOCAL-ACCEPTANCE.md) 在测试账号上单独安排，不在生产角色上主动发送测试消息。
- 节奏与输入状态：测试私聊中观察短句、长段、连发的间隔是否随长度变化，“正在输入”是否出现。
- 作息：把睡觉时段设到当前时间附近，确认消息被推迟到起床时间后统一回复，主人私聊不受影响。
- 贴表情与撤回：确认 QQ 客户端可见、账本有动作记录、撤回后的原消息在管理台记录中仍可查到并带标记。
- 口吻：抽查一周聊天记录中 `TONE_REVIEW_SUGGESTED` 的命中频率与改写结果，据此调整内置短语表。
