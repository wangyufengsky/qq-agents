# 网页游戏 P0：公网与手机访问验证

P0 只验证异地进入、Cookie、测试落点提交、刷新、轮询与后台恢复。测试棋盘不调用模型、不连接 QQ、不判五子棋胜负；邀请持有人身份不等于 QQ 身份。后续实现入口见 [多游戏网页框架契约 v0.5](plans/WEB-GAME-v0.5.md)，其中继承的安全与恢复约束见 [v0.4 基线](plans/WEB-GAME-v0.4.md)。

五子棋是首个游戏试点。P0 的固定棋盘、坐标与测试身份只服务于访问实验，不是未来通用内核的接口；P1 将先建立通用房间和模块契约，再接入五子棋规则及非棋盘测试夹具。上述设计尚未实现，不改变本页程序的启动方式或限制。

## 本机启动

Node.js 24+，在已安装依赖的代码目录运行：

```sh
node scripts/game-p0.mjs --data /absolute/private/game-p0-data --port 35821
```

数据目录必须独立，不能是 QQ Agents 生产数据目录；存在不属于 P0 的文件时拒绝启动。服务只监听 `127.0.0.1`。没有 `--public-origin` 时仅用于本机测试，Cookie 不加 Secure；公网模式只接受精确 HTTPS origin。

每次启动在容量允许时生成最多两个独立测试房间的邀请，写入数据目录的 `invitations.json`，不在控制台输出令牌。分别用于 QQ 内置浏览器和系统浏览器。邀请 15 分钟有效、显式点击才兑换；已兑换浏览器会话与测试房间从创建起保留 24 小时。最多同时 8 个未过期房间；过期记录在下一次建房时清理。容量满时仍启动服务并恢复原房间，输出 `invitationCount: 0` 和 `capacity-limited`，保留原邀请文件。P0 尚未实现活动局自动暂停或 QQ 换域续座。

不要把 `invitations.json`、Cookie、完整测试地址或数据库提交到 Git 或公开 Issue。邀请链接经隧道服务传输，该服务参与 HTTPS 终止；程序自身不记录请求 URL。禁止给隧道开启包含请求正文/URL 的调试采集。

## 临时公网入口

由部署者明确开启；此程序不自动启动或下载隧道程序。先从 [Cloudflare 官方渠道](https://developers.cloudflare.com/tunnel/downloads/)安装并核验 `cloudflared`，在单独终端运行固定 upstream：

```sh
cloudflared tunnel --url http://127.0.0.1:35821 --no-autoupdate
```

拿到临时 HTTPS 域名后，在另一个终端启动游戏服务。如果此前在本机模式测试，先正常 Ctrl+C 退出该 P0 进程，保留数据，勿启动第二份监听：

```sh
node scripts/game-p0.mjs --data /absolute/private/game-p0-data --port 35821 --public-origin https://example.trycloudflare.com
```

不要添加将 Host 改成管理台地址的参数，不能把 upstream 换成 QQ Agents 管理端口。这里的 HTTPS origin 必须与浏览器打开的域名一致，不带路径、查询或尾随斜杠。没有域名证书、CORS 或管理台配置需要修改。

公网模式要求受信任隧道覆盖 `X-Forwarded-Proto: https`，并设置 HSTS；隧道的明文 HTTP 入口会被应用拒绝。不要让公网客户端自行控制该转发头。只有本机 `/health` 可以直接用回环 HTTP 检查。

Quick Tunnel 是试玩入口：无在线保证、地址重建会变、最多 200 个在途请求、不支持 SSE；P0 使用短轮询。学校/公司网络和手机流量须分别验证，不能从一种网络推出另一种网络可用。[官方限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

### Quick Tunnel 无法连接时的可替换实验入口

Cloudflare 分配了域名但边缘连接失败时，不代表应用已公开可用。先区分 QUIC 超时、HTTP/2 握手失败和本机服务故障；不要关闭证书验证。需要替换入口时，可以用 localhost.run 的无需账号临时 HTTPS 隧道：

```sh
ssh -F /dev/null -o IdentityFile=none -o IdentityAgent=none \
  -o UserKnownHostsFile=/absolute/private/p0-known-hosts \
  -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 -R 80:127.0.0.1:35821 nokey@localhost.run \
  -- --inject-http-proxy-headers
```

这条命令不读取个人 SSH 配置或密钥，首次主机密钥写入专用文件，之后拒绝密钥变化。先结束原 P0 进程，再用新域名作为 `--public-origin` 启动；只有 P0 测试端口被转发。显式保留 `--inject-http-proxy-headers`，不假定服务默认注入；缺少此标记时应用会返回 `HTTPS_REQUIRED`。

此服务也会终止 HTTPS 并转发测试流量，域名定期变化且限速。只用合成测试数据，仍须独立挑战和手机验收，不能声称正式稳定入口。参见 [官方基础说明](https://localhost.run/docs/)、[无需密钥模式](https://localhost.run/docs/faq#i-dont-want-to-use-an-ssh-key)、[免费限制](https://localhost.run/docs/forever-free)。

已观察到部分浏览器路径的协议头与健康请求不一致，以及免费域名短时间内轮换；遇到 `HTTPS_REQUIRED` 时该入口不能标记为可用。须验证完整的浏览器加入、落点和刷新，健康探测通过不能代替此项；不要通过忽略协议头来绕过失败。

## 健康验证不等于手机通过

`GET /health` 只返回服务类型和本次启动随机挑战，不返回房间、配置或凭据。`p0-status.json` 记录本地 PID、origin、challenge 和 `externalProbeStatus: unverified`；进程启动不自动标记 ready。

1. 本机检查 `http://127.0.0.1:35821/health`。
2. 独立外部探测点请求公网 `/health`，与本次 challenge 对比，记录探测来源、时间、耗时、响应是否匹配。不要把本机请求公网域名记成独立外部验证。
3. 用户手机关闭 Wi-Fi 后进行下面的实测。若没有外部探测条件，可以记录当次手机人工验证；保留不同网络结论的区别。

记录可以存入数据目录之外的私有验收目录，不修改 `p0-status.json` 冒充自动探测。失败如实写 unverified/failed。临时地址被阻断时记录浏览器错误和网络，不能用关闭鉴权、更换成 HTTP 或开放管理台解决。

## 手机操作单

给两种浏览器各用一条新邀请；从 QQ 打开需要由测试者自己将对应邀请发到自己的 QQ。P0 不提供自动发送 QQ 的能力。

| 操作                                   | 预期                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| 关闭 Wi-Fi，用流量从 QQ 打开第一条邀请 | 看见测试说明及「确认加入」，仅预览不消费邀请                                      |
| 点击确认加入                           | 地址去掉 invite 参数，出现测试棋盘                                                |
| 选 H8、取消，再选 H8                   | 有坐标与 3×3 放大；尚未改变棋盘版本                                               |
| 点击确认落点                           | 同步期间暂不可点；同步完成后提交，版本从 0 变 1，出现黑子；快速重复点不增加第二手 |
| 刷新页面                               | 仍有登录状态和同一落点，版本不回到 0                                              |
| 切后台后返回、旋转屏幕                 | 自动同步，旧选点取消，不自动提交                                                  |
| 断网后提交，再恢复                     | 显示待确认；查询同一操作，不能凭超时显示成功                                      |
| 第二条邀请用系统浏览器重复上述步骤     | 独立记录结果；不要求两浏览器共享 Cookie                                           |
| 关闭 JavaScript 后刷新已加入的房间     | 有带时间的棋盘快照及刷新提示，不能提交                                            |

表格由用户实际结果填写；桌面窄屏模拟不是 QQ WebView 或真实手机验收。学校、公司网络另开独立记录，不将工作网络访问权限扩大为其他网络操作。

| 环境                       | HTTPS/加入 | 落点 | 刷新 | 后台返回 | 延迟/失败原因 |
| -------------------------- | ---------- | ---- | ---- | -------- | ------------- |
| 手机流量 / QQ 内置浏览器   | 待测       | 待测 | 待测 | 待测     | 待记录        |
| 手机流量 / 系统浏览器      | 待测       | 待测 | 待测 | 待测     | 待记录        |
| 学校或公司网络（有条件时） | 待测       | 待测 | 待测 | 待测     | 待记录        |

## 停止与故障边界

分别在 P0 服务和隧道终端按 Ctrl+C 正常退出，只结束本次进程。不要运行 QQ Agents 的 stop 命令或杀掉其他隧道。保留测试数据库以供复查；24 小时截止后拒绝读写，P0 不会重建旧房间。

同一公网域名、同一数据目录重新启动后，原浏览器仍可读取尚未到期的棋盘；每次启动会另外生成新测试邀请。换域后旧 Cookie 不迁移，P0 使用新测试房间重测，P1/P2 才实现经 QQ 确认恢复原座位。

自动化回归：`node --test --test-timeout=120000 test/game-p0.test.mjs`。覆盖预览不兑换、Secure Cookie、跨站拒绝、假身份、并发幂等、重启回执、无脚本快照、假时钟过期、容量和管理路由隔离。最终还需 `npm run verify`。

本机已安装 Chrome/Chromium 时，可另运行 `node scripts/game-p0-browser-acceptance.mjs`；它使用临时浏览器、内存数据库和本机端口，检查窄屏加入、延迟同步期间的提交门禁、选点取消、提交、刷新、丢失回执后的对账及无脚本快照。需要自定义浏览器路径时设置 `CHROME_PATH`。它不会发送 QQ 或访问模型，也不替代真实手机测试。

Safari/QQ 的 iOS 页面还应使用 WebKit 回归：先为现有 Playwright 安装测试用 WebKit，再执行 `node scripts/game-p0-browser-acceptance.mjs --webkit`。测试浏览器可用 `PLAYWRIGHT_BROWSERS_PATH` 放入临时目录，不修改个人 Safari 配置。加入请求保持 Fetch 的 CORS 模式、同源目标和同源凭据；若改为 `same-origin` 模式，WebKit 在 `no-referrer` 下会发送 `Origin: null` 并被服务拒绝。该约定见 [Fetch Origin 规则](https://fetch.spec.whatwg.org/#origin-header)，不能通过接受空 Origin 解决。
