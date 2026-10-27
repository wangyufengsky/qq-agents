# 公开前检查

本仓库自 2026-10-28 起公开。公开前的开发在一个私有仓库中进行；迁移时只带入 `main`，并把提交作者/提交者的个人邮箱统一改写为 GitHub 隐私邮箱、把提交说明中的旧 PR 编号改为文字，文件内容不变。私有仓库保持私有，其中的旧分支、PR 引用和讨论不会公开。

以下检查继续适用于每次提交，以及将来新增的分支、标签和 Release。

## 日常提交

使用 GitHub 设置中提供的 `users.noreply.github.com` 隐私邮箱，仅配置当前仓库，不把私人邮箱写入提交。`npm run verify` 会检查文件和当前有效的作者/提交者身份；环境变量覆盖的身份同样检查。

```sh
npm run privacy-scan
node scripts/privacy-scan.mjs --staged
node scripts/privacy-scan.mjs --commits origin/main..HEAD
```

本机可用 `git config --local core.hooksPath .githooks` 启用仓库内的提交前钩子，检查暂存文件和有效提交身份。先确认没有需要保留的现有钩子；提交说明在提交后、推送前用上述 `--commits` 检查。

扫描包含 author、committer、Co-authored-by、提交说明中的凭据/本机路径，以及通过 `QQ_PRIVATE_IDENTIFIER_HASHES` 提供的私密编号 SHA-256。散列列表仅在本机环境设置，不把原始编号或凭据放入命令参数或仓库。输出只列路径、提交哈希、字段和规则，不回显命中的邮箱、编号或令牌。允许 GitHub 隐私邮箱以及明确的服务 noreply 地址，不允许整个公司邮箱域。

## 完整历史

```sh
node scripts/privacy-scan.mjs --history
```

完整扫描遍历所有本地引用可达的文件对象与提交元数据。检查远端时先取得全部分支、标签和 PR 引用（例如 `git clone --mirror`）再运行；普通 checkout 或浅克隆不等于完整远端历史。扫描失败时不能把命中加入忽略列表来声称通过。

另外单独检查 GitHub 的 PR/Issue 文本、评论、附件、Actions 日志、Artifacts、Releases，以及作者身份资料；这些不全在 Git 对象里。GitHub 为每个 PR 保留的 `refs/pull/*` 无法由仓库所有者改写或删除，所以已经推到 PR 里的提交，改写分支历史也去不掉。仓库公开后他人可以保存副本，重新设为私有不能收回已复制的内容。

## 依赖与归属

使用 npm 官方审计服务检查已知漏洞：`npm audit --omit=dev --registry=https://registry.npmjs.org`。镜像源没有审计接口时应报告未完成，而不是通过。升级后执行完整回归，并确认实际运行发布目录采用新版锁文件与依赖。

根 LICENSE 为 MIT；`NOTICE.md` 描述当前复用范围；`vendor/dsh/UPSTREAM-LICENSE.md` 与 `vendor/dsh/UPSTREAM-NOTICE.md` 原样保留上游历史说明。外部程序不随仓库分发，适用自身许可。运行配置、凭据、日记、聊天、下载文件和备份继续保留在被 Git 忽略的私有数据目录。
