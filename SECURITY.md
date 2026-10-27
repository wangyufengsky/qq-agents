# 安全策略

QQ Agents 管理真实的 QQ 账号、AI 后端凭据和聊天记录，安全问题请**私下**报告，不要发公开 Issue。

## 如何报告

在本仓库的 **Security → Report a vulnerability** 提交私密报告（GitHub Private Vulnerability Reporting）。请尽量包含：

- 受影响的版本或提交；
- 复现步骤或最小配置（用示例账号和占位令牌）；
- 影响范围：例如越权发送、跨角色读取记忆、凭据泄露、绕过白名单或暂停。

**不要**在报告、Issue 或日志里附上真实的 QQ 号、令牌、API 密钥、`admin-token`、聊天内容或数据目录文件。需要样本时请先脱敏。

## 范围

在范围内：本仓库 `src/`、`public/`、`scripts/`、`vendor/` 中的代码，以及默认配置下的行为（隔离模式、全局暂停、白名单、能力凭据、外发检查、发送账本）。

不在范围内：NapCat、QQ 客户端、DSH、Codex、OpenCLI 及各模型服务本身的漏洞，请向对应项目报告；需要攻击者已能读写本机数据目录或以同一系统用户运行代码的场景。

## 支持的版本

只维护 `main` 分支的最新代码。修复会直接进入 `main`，并在 [更新日志](CHANGELOG.md) 中说明。
