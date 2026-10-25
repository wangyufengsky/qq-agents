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

`--case files` 验证公开 URL 下载、合成 QQ 文件附件下载、文本文件创建和两次附件发送，分别在 DSH/Codex 执行。用例只开启隔离角色的文件权限；上传终止于本机网关，并比对 SHA-256、字节数、发送对象及无额外确认。下载对象为公开 GitHub 文本，不采集真实 QQ 文件。详见 [文件收发说明](FILE-TRANSFER.md)。

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

## 0.4.0 可选验收

新增工具后必须在**独立测试 profile**刷新由 `dsh-bundle.mjs` 生成的 guard 白名单，并重启自己的测试 Host；只更新源码不足以让已有 bundle 暴露新工具。不要修改日常桌面 profile 或生产 QQ preset。

- `--case memory-quality`：复杂合成场景，严格校验六类结论及证据 UUID，保存结构化结果与需要人工阅读的解释。检查原始错误，不将主判断通过视作每次工具参数都正确。
- `--tool-config PRIVATE_JSON --case external-search`：JSON 是 `toolServers` 数组，需明确配置并允许真实 Exa 工具；脚本交给两个后端发现实际 schema。消耗外部服务额度。
- `--case external-image`：测试配置需提供 `artifact` 服务器，其真实目录必须包含 `read_image_artifact`。它用于读取一张已有的真实生成图片，不应伪装为生成服务。断言接收图片 SHA-256 与登记 ID 相同。该私有验收适配器不是项目内置工具。
- `--case tts`：本机需已安装 Tingting 音色；使用实际 macOS `say`。系统语音组件受限时可能返回空音频，FFprobe 会拒绝。不得用合成蜂鸣替代后声称语音生成通过；Windows/Linux 明确不支持此本机提供者。
- `--case group-scope`：只创建合成群活动和有向链接，由模型实际汇总并发 at 段至本机网关。不是实际 @ 群友。

```sh
npm run memory:benchmark -- --synthetic --count 200000 --out work/new-benchmark
npm run memory:backup -- --source /path/to/instance/memory.sqlite --destination /path/to/new-backup.sqlite
```

基准要求新数据库，默认 20 万条，上限 200 万条；耗时和磁盘占用随规模增加。仅使用合成记录。备份目标必须不存在；同一命令可以从备份恢复到新路径，不能覆盖运行中数据。备份命令直接只读打开源 SQLite，不触发 schema 升级。
