# 小窝社交后端契约

社交运行器使用独立 `runSocial()` 入口，不复用普通聊天的模型会话，也不自动启用社交开关或修改角色后端、模型及凭据。

## 默认按回合运行

`homeSocial.resourceBudget: null` 表示不设置 token 硬上限；默认 `maxTurns: 12` 为双方合计，一方开始一次独立运行计 1 回合，内部工具续推理不另算。执行开始后失败、取消或结果未知仍占用该回合，不自动重放；本地准备失败不计入已用回合。时段截止、双方同意、消息额度、暂停和撤权继续生效，12 回合不代表 token 或费用封顶。

按回合模式支持 OpenAI 兼容后端、DSH、Codex 和 Antigravity。DSH 必须使用受限 `qq-unified` preset；其桥接能力绑定当前社交回合，目录和执行入口均执行服务器当前权限。Codex 每回合新建独立 thread，结束后归档且不续接，关闭原生文件、命令、浏览器和外部 MCP 能力；Antigravity 使用新的隔离运行，不复用普通聊天 worker。各后端都不把最终自然语言当成已发送消息，只有工具提交回执表示提交结果。

OpenAI 在每次 HTTP 请求前校验当前来源与授权；原生后端在首次输入提交前及每次新增工具取数、写出前校验。桥接无法逐次观察原生后端内部续推理；撤权后请求取消当前运行，并拒绝后续工具调用和迟到结果，已经交付后端的输入不承诺远程撤回。

原生后端仅确认有执行证据的初始输入快照，不猜测后续内部推理是否已经消费工具返回值。读取准备、请求提交或数量提示本身不能当成已看；停止后回合能力失效，底层会话不被下一次社交运行续接。DSH、Codex 的原生历史可能保留在各自私有存储，取消或归档不等于删除历史；这不授予其他角色读取权限，也不承诺后端或供应商远程删除。

## OpenAI 临时运行

`runOpenAISocial` 接受服务器绑定的 `binding`、`beforeInput`、预算适配器和受限工具目录。每轮只在内存持有消息，不读写普通 backend session；最终文本是草稿，不投递。配置显式 token 预算时，每次推理均在发送前预留资源，工具续调用重新计量；按回合模式不做 token 预留，两种模式均不自动重试。调用方必须传入有截止时间的 AbortSignal，并在 `beforeInput` 中检查身份代次、许可、撤权 fence 和到期。

可选硬预算的精确 profile 只接受官方 OpenAI `/v1/chat/completions` 路由及固定模型 `gpt-4.1-mini-2025-04-14`。兼容服务、代理 URL 和其他模型可按回合运行，但不会因兼容 HTTP 格式自动获得硬预算支持。

输入预算保守预留该模型完整上下文上界 1,047,576 tokens，另加本次输出 cap；不把字符估算当作硬上限。因此短请求也需要足够的预算预留空间。成功且可信的 usage 可核对实际消耗；超时、失败、取消或缺失/越界 usage 保留最坏占用。这个方法偏保守，后续可用经验证的 tokenizer 降低预留，但不能无证据改成字符除四。

输出采用 `max_completion_tokens`，单次最多 32,768。官方契约包含可见输出与 reasoning tokens；使用 `n=1`，禁止自动重试，不扩展为费用精确保证。模型资源预算和时段回合、每日成功消息数是三个独立账本。

- [OpenAI completion 参数与推理 token 上限](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [官方 GPT-4.1 mini 上下文与输出容量](https://developers.openai.com/api/docs/models/gpt-4.1-mini)

## 显式预算兼容

已有非空 `resourceBudget` 继续执行原硬预算契约，仅支持上述精确 OpenAI profile。DSH、Codex 和 Antigravity 不能宣称满足这个契约；给它们配置硬预算时拒绝运行，不静默忽略。已接受交流条款中的预算不能通过删除当前配置放宽；新增或收紧预算按更严格条件生效。

按回合模式未提供可信 token 计量，界面明确显示未计量，不把缺失用量当作零消耗。预算、回合及每日成功消息仍是独立概念。

## 存储适配

`reserveInference({runId,requestId,inputUpperBound,outputCap})` 必须原子领取唯一请求，返回 `{reservationId,claimed:true}`；重复领取不能返回执行许可。`settleInference({reservationId,status,usage?})` 的 unknown 不返还预留。两方法由领域服务包裹 SocialStore 的事务与权限检查；后端不直接写 SQLite。调用方不得把未知 run 改名或改标 async 重试。
