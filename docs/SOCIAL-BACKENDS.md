# 小窝社交后端前置契约

此模块是二期运行器的前置实现，不注册工具、不调度模型、不改变普通后端 `run()`、不启用社交开关，也不安装或修改 Harness bundle。

## OpenAI 临时运行

`runOpenAISocial` 接受服务器绑定的 `binding`、`beforeInput`、预算适配器和受限工具目录。每轮只在内存持有消息，不读写普通 backend session；最终文本是草稿，不投递。每次推理均在发送前预留资源，工具续调用重新计量；不自动重试。调用方必须传入有截止时间的 AbortSignal，并在 `beforeInput` 中检查身份代次、许可、撤权 fence 和到期。

首个精确 profile 只接受官方 OpenAI `/v1/chat/completions` 路由及固定模型 `gpt-4.1-mini-2025-04-14`。兼容服务、代理 URL 和其他模型不会因兼容 HTTP 格式自动获准。

输入预算保守预留该模型完整上下文上界 1,047,576 tokens，另加本次输出 cap；不把字符估算当作硬上限。因此短请求也需要足够的预算预留空间。成功且可信的 usage 可核对实际消耗；超时、失败、取消或缺失/越界 usage 保留最坏占用。这个方法偏保守，后续可用经验证的 tokenizer 降低预留，但不能无证据改成字符除四。

输出采用 `max_completion_tokens`，单次最多 32,768。官方契约包含可见输出与 reasoning tokens；使用 `n=1`，禁止自动重试，不扩展为费用精确保证。模型资源预算和时段回合、每日成功消息数是三个独立账本。

- [OpenAI completion 参数与推理 token 上限](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [官方 GPT-4.1 mini 上下文与输出容量](https://developers.openai.com/api/docs/models/gpt-4.1-mini)

## DSH guard 及支持门

`installDshSocialGuard` 是供独立社交 preset 使用的可测试 hook 模块，尚未注册为生产 preset。它不能单独证明某个已安装 DSH 后端合格。

已只读核验 Harness 0.2.1-rc.5 的 agent loop：`agent/request` 可设置逐推理 `maxTokens`，`llm/stream` 可在实际模型流前拒绝调用；DeepSeek adapter 会发送 `max_tokens`。公共 session RPC 没有等价预算字段。

接入者须提供可信控制通道，将新 session 与 runId/身份/epoch/fence 绑定，并验证精确 provider 的 reasoning 上限和每次付费尝试的重试边界。未明确验证的 provider 一律拒绝。guard 每次 stream 单独预留，流失败或完成均暂记 unknown，保留最坏预算，直到另有经过验证的 usage 投影。request hook 的逐推理 cap 不等于整个 turn 的资源预算。

自动标题、compaction、辅助模型、子代理及 adapter 内重试必须关闭或纳入逐次预留；插件 hook 位置不足以覆盖时不得宣称支持。现有测试只验证模拟 hook 顺序、逐次重试预留和失败占用，不代表真实 Harness/provider 已通过验收。集成仍需独立社交 preset、能力握手和有回执清理，不修改普通 preset 或 Harness 应用源码。

## 存储适配

`reserveInference({runId,requestId,inputUpperBound,outputCap})` 必须原子领取唯一请求，返回 `{reservationId,claimed:true}`；重复领取不能返回执行许可。`settleInference({reservationId,status,usage?})` 的 unknown 不返还预留。两方法由领域服务包裹 SocialStore 的事务与权限检查；后端不直接写 SQLite。调用方不得把未知 run 改名或改标 async 重试。
