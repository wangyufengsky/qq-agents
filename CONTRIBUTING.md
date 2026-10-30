# 参与贡献

感谢你愿意改进 QQ Agents。这个项目管理真实的 QQ 账号、AI 后端凭据和聊天记录，所以除了代码本身，提交前的隐私检查同样重要。参与本项目即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 先开 Issue 再动手

- 修错别字、补测试、修一个明确的小问题：可以直接提 PR。
- 新功能、改变默认行为、调整配置格式、新增依赖、跨多个模块的重构：请先开 Issue 说明要解决的问题和打算的做法，讨论清楚再写代码，避免白做。
- **安全问题不要开公开 Issue**，按 [安全策略](SECURITY.md) 通过仓库 Security 页私下报告。

## 开发环境

需要 Node.js 24 或更高版本（使用内置 SQLite）。运行完整测试还需要 FFmpeg 和 FFprobe（语音和 GIF 相关测试会直接调用它们）。

```sh
npm ci --ignore-scripts
npm start
```

`npm start` 默认使用当前目录下的 `.runtime/` 作为数据目录、端口 3210。新建的配置处于隔离模式（`mode: isolated`），全部暂停，**不会连接 QQ、不会运行模型回合**，可以放心在管理台里点每个页面。需要独立数据目录时用 `node src/main.mjs --data /path/to/private-data`。登录方式和更多说明见 [README](README.md) 与 [入门指南](docs/GETTING-STARTED.md)。

数据目录（`.runtime/` 等）里是运行配置、令牌和聊天记录，已被 `.gitignore` 排除，不要提交，也不要附到 Issue 或 PR 里。

编码助手的模块导航、验证与交付要求见根目录 [AGENTS.md](AGENTS.md)。每项新修改（包括文档）须从最新 `origin/main` 新建独立 worktree 和 `codex/` 分支，不在本地主目录的 `main` 上直接开发。

## 提交前：`npm run verify`

每个 PR 都必须在本机通过 `npm run verify`，CI 在 Ubuntu、macOS 和 Windows 上运行同一条命令。它依次执行：

| 步骤     | 命令                     | 检查内容                                                                                                                                                      |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 语法检查 | `npm run check`          | 对 `src`、`public`、`scripts`、`test`、`vendor` 下所有 `.mjs`/`.js` 运行 `node --check`。                                                                     |
| 代码规范 | `npm run lint`           | ESLint 检查 `src`、`scripts`、`test`、`public` 下的全部代码（`vendor` 除外，规则见 `eslint.config.mjs`）。                                                    |
| 类型检查 | `npm run typecheck`      | `tsc` 按 JSDoc 检查文件头带 `// @ts-check`、并列在 `tsconfig.json` 的 `include` 里的模块；新模块能通过时请一起纳入。                                          |
| 默认配置 | `npm run defaults:check` | `examples/config.example.json` 必须与运行时默认配置一致；改了默认值后运行 `npm run defaults:write` 重新生成。                                                 |
| 测试     | `npm test`               | `node --test --test-timeout=120000 test/*.test.mjs`：每个测试最多 2 分钟，挂住时直接报出是哪个测试。测试使用临时目录和本地假网关，不调用模型，不连接真实 QQ。 |
| 格式     | `npm run format:check`   | Prettier 检查代码、`docs`、`examples`、`README.md`、`.github` 等；用 `npm run format` 自动修正。                                                              |
| 隐私扫描 | `npm run privacy-scan`   | 扫描受 Git 跟踪的文件中的凭据、本机路径、运行数据文件，以及当前有效的提交作者/提交者邮箱。                                                                    |

需要真实模型的端到端验收（`npm run acceptance:live`）会消耗模型额度，不属于 `verify`，只在需要时按 [真实后端的本地验收](docs/LOCAL-ACCEPTANCE.md) 单独运行。

## 隐私规则

详细规则和原因见 [公开前检查](docs/PUBLIC-READINESS.md)，要点如下：

- **提交身份**：作者和提交者邮箱必须是 GitHub 设置里提供的 `users.noreply.github.com` 隐私邮箱，只配置在当前仓库：

  ```sh
  git config --local user.email "<id>+<username>@users.noreply.github.com"
  ```

  `Co-authored-by` 行同样会被检查。

- **提交前钩子**：先确认本机没有需要保留的现有钩子，然后启用仓库自带的钩子，它会在每次提交前扫描暂存文件和提交身份：

  ```sh
  git config --local core.hooksPath .githooks
  ```

  提交说明在推送前再检查一次：`node scripts/privacy-scan.mjs --commits origin/main..HEAD`。

- **测试数据**：测试、示例和文档只用明显的占位编号（如 `10000`、`10001`）和占位令牌，不得出现真实 QQ 号、群号、令牌、API 密钥或聊天内容。
- **Issue、PR 和日志**：同样不得附上真实 QQ 号、令牌、`admin-token`、聊天内容、截图中的会话或数据目录文件。需要样本时先脱敏；报告问题时贴错误码，而不是原始日志。

扫描失败时请修改内容或身份，不要通过加入忽略列表来绕过。

## 代码约定

- **模块**：Node.js ESM（`.mjs`），不引入构建步骤。新增运行时依赖需要先在 Issue 里说明理由；`package.json` 中的依赖使用精确版本。
- **注释**：用英文，写“为什么”而不是复述代码：说明约束、边界条件和安全取舍，例如为什么某个错误不能带出原文、为什么某一步只在完整写入后才持久化。显而易见的代码不加注释。
- **错误码**：抛出的错误使用大写下划线的稳定错误码，如 `throw new Error("FILE_PATH_DENIED")`、`Error("CONFIG_CONFLICT")`。不要把服务商返回的错误原文、HTML、请求参数、路径或凭据放进错误信息或日志：它们可能含有密钥和私人聊天内容。需要区分原因时，映射到协议定义的分类（参见 `src/backends/turn-failure.mjs`、`src/tools/errors.mjs`）。
- **权限边界**：能力默认值遵循 `src/core/default-config.mjs` 和 [配置说明](docs/CONFIGURATION.md)，保留已有显式设置；工具开关开启不等于获得发送、外部访问或运维授权。涉及发送、读取他人记忆、外部网络或凭据的改动要同时补上拒绝路径的测试。
- **测试**：行为改动都要有对应测试，放在 `test/*.test.mjs`，复用 `test/helpers.mjs` 中的夹具，不依赖网络和真实账号。
- **用户可见文本**：管理台和文档面向中文用户，术语与 [README 的术语表](README.md#术语表) 保持一致。

## 管理台页面

管理台在 `public/` 下，是几个共享全局作用域的普通脚本（跨脚本用到的名字登记在 `eslint.config.mjs` 的 `browserScripts`）。页面照首页的做法：

- **内容在前，设置在后**：一页最先看到的是这页要看的东西（日志、记录、列表），设置、额度和导入放在下面。
- **次要区块默认折叠**：用 `fold(id, 标题, 内容, { summary, open })`。`summary` 用几个字写出关键状态，不展开也能看懂；`id` 跨渲染稳定（例如 `subject-quota`），浏览器会记住用户展开过的区块。
- **能选就不让人填**：固定几档的值用 `select(key, 标签, 值, [[值, 文字], …])`；QQ 号和群号用 `ids(key, 标签, 值, { kind: "group" | "person" })`，渲染后调用 `fillIds(root, agentId)`，从这个角色认识的群和人（`/api/known-targets`）里提供选项，表单照旧提交逗号分隔的字符串；连续数值用 `range(key, 标签, 值, { min, max, step, unit })`。实在只能手填的（环境变量名、地址、日期），在 `placeholder` 里给出示例。
- **版式固定**：长文本截断（悬停看全文），不撑开卡片；手机宽度（375px）下不能横向溢出。

## 提交信息

标题用英文，加上类型前缀，简短描述改动，除专有名词外用小写，结尾不加句号。仓库历史中的例子：

```text
feat: OpenAI-compatible backend with local sessions
fix: answer every tool call before image messages; drop stale OpenAI fields
feat: bounded backoff auto-reconnect for the OneBot receive channel
docs: turn README and docs into a task-oriented user guide
```

常用前缀：`feat:`（新功能）、`fix:`（修复）、`test:`（只改测试）、`docs:`（只改文档）、`refactor:`（不改变行为的重构）、`chore:`（仓库维护）。正文说明改了什么、为什么，可以用列表；涉及行为或兼容性变化时写清楚影响。一个提交只做一件事。

## 文档

用户文档放在 `docs/`，用中文书写，风格与现有文档一致：面向任务，先说怎么做，再说原理和限制。新增文档时在 PR 描述中说明应加入 README 的哪个索引位置。改变了配置项、默认值或用户可见行为时，同步更新相关文档，并在 PR 描述里写一句更新日志条目。

## 提交 PR

1. 获取最新 `origin/main`，为本任务新建独立 worktree 和 `codex/` 分支；在该 worktree 内完成修改与 `npm run verify`。
2. 检查 diff 和提交隐私后提交、推送，再按 PR 模板填写：做了什么、为什么、怎么验证的、隐私自检、文档与 CHANGELOG。
3. 一个 PR 只解决一个问题；大的改动拆成可以独立审阅的几个 PR，不混入无关格式化或重命名。
4. 当前 PR 提交的全部 CI 通过，并满足仓库审查要求后合并 `main`。同步主线或修复失败后必须等待新提交的 CI，不能沿用旧结果。
5. 维护者在干净的本地主目录快进到最新远程 `main`，保留其他未提交工作。
6. 有对应本机部署的维护者按 [AGENTS.md](AGENTS.md#合并后更新本地主代码与服务) 更新实际服务、验证运行版本与各角色健康，并报告 PR、验证及部署结果；外部贡献者不需要操作维护者的私有服务。
