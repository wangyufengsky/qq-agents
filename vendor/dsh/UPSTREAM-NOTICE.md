# 来源与授权声明（NOTICE）

## 本项目

qq-bridge-enhanced 是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT 许可，
Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors）的二次开发版本，基线为上游 `v0.2.0-r3`
（源码包 `qq-bridge-0.2.0-r3.zip`，与上游 `main` 分支一致）。

- 上游的全部代码、文档与资源仍按上游 [LICENSE](LICENSE)（MIT）授权；本仓库保留上游的版权声明与 LICENSE 全文。
- v0.3.0 新增与修改的部分同样以 MIT 许可发布。新增文件主要位于 `src/social/`、`src/admin/`、`src/lib/`、
  `src/bridge-extensions.js`、`dsh/agent-presets/qq-agent-readonly/`、`scripts/test-continuity.mjs` 等，
  完整变更清单见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/release/RELEASE_NOTES_v0.3.0.md](docs/release/RELEASE_NOTES_v0.3.0.md)。
- 本项目与上游作者、DeepSeek、SnowLuma 项目及腾讯公司均无隶属关系。

## 第三方组件（不随本项目分发，适用各自许可）

上游 [LICENSE](LICENSE) 后半部分「第三方组件与合规边界」一节仍然有效，以下为 v0.3.0 开发时重新核对的要点：

| 组件 | 本项目如何使用 | 许可要点 |
| --- | --- | --- |
| **SnowLuma**（含专有原生组件 `native/snowluma-*.node/.dll`） | **不包含、不下载、不启动、不修改**；用户自行安装运行，桥接只通过 OneBot v11 WebSocket/HTTP 与它通信 | SnowLuma Source-Available Non-Commercial License v1.0 + EULA v1.1：非商业；**原生组件不得单独再分发、不得并入第三方安装包或通过自动化脚本部署**（EULA §5.4、LICENSE §5）；修改版公开发布需书面许可（LICENSE §3(d)） |
| **@snowluma/sdk**、**@snowluma/mcp**（npm 依赖） | 由 `npm ci` 从 npm 安装，**不随 Release ZIP 分发**；`postinstall` 只修补用户本地 `node_modules` 里的副本 | npm 包声明 `SEE LICENSE IN LICENSE` 但未附带 LICENSE 文件；推定适用 SnowLuma 仓库的许可。其 LICENSE §4(b)「未经授权不得开发、发布基于本软件的另一项目」对「通过 SDK/OneBot 协议与其通信的客户端」是否适用**没有明确条款**——这是上游就存在的法律不确定性，发布前请自行评估，必要时联系 SnowLuma 作者 |
| **DeepSeek Harness（@deepseek-ai/dsh 等）** | 用户自行安装；`@deepseek-ai/dsh-host-apiproxy`、`@deepseek-ai/schemastery` 作为 npm 依赖安装 | 适用其各自的 npm 许可 |
| 其它 npm 依赖 | `npm ci` 安装 | 见各包 LICENSE |

Release ZIP **不包含** `node_modules`、SnowLuma 的任何文件、DSH 的任何文件，也不包含上游仓库曾附带的
`@snowluma/mcp` 工具目录快照 `_snowluma-catalog.json`（v0.3.0 起移除并加入 .gitignore；没有任何代码引用它）。

## 使用风险（上游已声明，重申）

- SnowLuma 是非官方 QQ 协议实现，使用可能违反腾讯服务条款并导致账号受限，风险由使用者承担。
- 群友的消息会发送给 LLM 提供方（DeepSeek 等）；黑话学习会把群聊词条作为关键词发给搜索引擎。数据出机清单见上游 LICENSE。
- v0.3.0 的人物库会在本机长期保存群友的 QQ 号、各群名片与 AI 记下的印象。请告知群友，并善用 `sharePolicy`、`recordable`、
  `/person <QQ> forget` 与保留策略。
