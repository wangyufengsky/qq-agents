# 真实后端的本地验收

`npm run verify` 不调用模型，不使用真实 QQ。`scripts/local-acceptance.mjs` 是需要显式选择的真实后端验收工具，会消耗所选模型的额度。所有 QQ 写请求都由脚本内的回环 HTTP/WS 网关记录，不能投递到真实 QQ。

## 准备独立环境

- Node.js 24、FFprobe、FFmpeg，以及已安装的 DSH 与 Codex CLI。
- 专用 DSH_HOME、profile、会话目录与登录；将本项目生成的 `qq-unified` bundle 安装到该 profile，桥接地址为 `http://127.0.0.1:3212`，DSH 监听 `127.0.0.1:3213`。
- Codex 只使用验收数据目录下 `codex/acceptance-codex/home` 的专用登录。不要指向日常 Codex home，不共享会话目录。
- 确认 3212–3216 端口可用，现有机器人保持暂停。脚本不会寻找、修改或启动现有机器人，也不会读取旧机器人的配置或凭据。

默认数据目录是 `work/live-acceptance/bridge`。现有目录的角色标识必须属于本验收环境；脚本取得 `process.lock` 后才运行。异常退出留下锁时先检查 PID，不自动删除活跃进程的锁。

```sh
node scripts/dsh-bundle.mjs --out work/unified-test-bundle --url http://127.0.0.1:3212
# 按 DSH 支持的 bundle/profile 流程启用上述包，并完成专用登录。
DSH_HOME=/path/to/independent-dsh-home npm run acceptance:live -- --allow-real-models --run-all
```

当前验收配置使用 `deepseek-account/deepseek-flash/high` 与 `gpt-6-astra/high`。执行前通过实际模型目录核对可用性；不同部署请在脚本的验收配置中明确选择自己的模型。

## 用例与结果

两后端逐项运行：实际 WebSocket 入站与工具发送、语音读取/音量转换/发送及解码回读、嵌套转发展开与发送、按人物检索仍能读取群场景并结合日记自主发言、等待后有限睡眠与再次唤醒、真实时钟主动参与、AI 任务创建/查询/修改/删除、真实分钟边界的一次性 AI 定时任务及不重复执行、等待中暂停后无迟到发送。

```sh
DSH_HOME=/path/to/independent-dsh-home npm run acceptance:live -- --allow-real-models --run-all --agent acceptance-dsh --case wait-sleep,proactive
```

`--case memory-scene` 专门验证：只按甲的关键词和身份搜索，仍能读到乙的改期及对甲的引用、丙的回应，正确说出群名/三位发言者/最终时间，再读取个人日记并向当前主人私聊发送，且没有发言授权申请。所有内容是合成测试资料，发送只到本机网关。

每项通过条件核对网关实际收到的发送请求和工具完成状态。定时任务还核对 SQLite 的终态记录；取消用例要求发送数为零。`acceptance-results.json` 保存脱离消息正文的结果与工具状态，失败退出码为 1。

省略 `--run-all` 可保留控制台进行浏览器验证。管理台在 3212，令牌从数据目录 `admin-token` 读取，不能放进 URL。3216 控制接口使用同一令牌的 `x-admin-token` 请求头，`POST /case` 接受 `agentId` 与 `test`。每次只跑一项；用例结束时角色和全局均暂停。

## 经授权的真实 QQ 输入

`--inputs /path/to/private-fixture.json` 可装载经用户授权、保存在本机的输入样本：

- `voiceSegments`：真实消息中的 record 段；`record`：同一已观察文件经真实 `get_record` 返回的结果。用例 `received-voice` 使用这些输入，实际走工具、音频校验、FFmpeg 和真实模型。
- `forwardSegments`：真实消息中的 forward 段；`forwardResources`：只读获取的根及嵌套资源，按 resource ID 索引；内嵌子资源保留原始 content，不能人为补成可远程获取的资源。`forwardDepth` 记录实际观察到的深度（至少为 1）。用例 `received-forward` 验证内外层测试文字与转发工具。

采集前明确发送者、私聊对象和测试标记；只采集用户新建的测试内容。此脚本不会主动连接生产 QQ 网关采集，也不会把真实 QQ 发件人或收件人绑定到出站连接。样本可能含私人标识、音频或附件地址，必须留在忽略的私有工作目录，不能提交 Git。

浏览器选择文件、提交导入、列表成功提示和本机试听需要单独通过实际 UI 验证。原生音频输入或转录能力取决于后端；成功处理/转发音频不代表模型已理解语音内容。
