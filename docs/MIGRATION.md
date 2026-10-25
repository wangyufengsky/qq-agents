# 迁移、部署与回退

当前生产实例不由本项目启动、暂停、恢复或替换。本轮不运行任何真实 QQ 发送测试。以下步骤须在明确决定切换后执行。

## 先准备可回退的新目录

1. 记录旧代码 commit、部署方式、进程/端口及两个 AI 的暂停状态。保留旧人格、模型会话、原生 QQ 登录目录、Docker 容器/卷/镜像和现有回退备份。
2. 为新项目创建单独的私有数据目录与端口。选择稳定 agentId，映射原 QQ 身份；不要把后端名当成主体身份。
3. 逐项对照 FEATURE-MATRIX.md。逐项核对目标网关扩展、语音格式和真实模型工具，不仅凭离线测试决定替换。

## 记忆预检与导入

```sh
npm run migrate -- --source /path/to/old-instance --agent agent-a --data /path/to/new-data
```

默认只读预检；只输出数量和覆盖缺口，不打印聊天内容。支持：

- `state/social-v2.json` 的 recentMessages/unread 窗口；重复消息幂等导入。
- `history/*.jsonl` 中具有 conversation/key、body/text、messageId 等字段的显式历史导出。
- 使用 `--legacy-db /path/to/old.sqlite --legacy-agent old-id` 指定旧 memories 表和原主体 ID，只导入该主体的笔记。

没有识别到的档案结构会明确报告，不能自动猜测人物、内容或来源。窗口可能已经被旧代码截断，无法恢复缺失部分。DSH/Codex 模型内部历史不在本版自动导入范围。

```sh
npm run migrate -- --source /path/to/old-instance --agent agent-a --data /path/to/new-data --apply
```

目标目录有进程锁时拒绝导入；已有目标数据库先用 SQLite backup API 做一致备份。导入采用事务、幂等事件键和迁移摘要。**旧文件不移动、不覆盖、不删除。** 旧笔记成为 `legacy.note`，不是伪造的过去日记；旧发送文本标为 legacy-unverified，不能当作真实投递回执。

旧状态的水位、未读数量、wakeConfig、最后回复时间保存在 runtime.legacy；新水位独立计算。导入会话保留暂停，不能自动发出积压内容。后续准备切换时，可在管理台“经历与日记”填写准确来源，手动解除该来源暂停；角色和全局暂停仍分别生效。基础人格需从原角色卡核对后写入新配置；本脚本不代写人格或从旧笔记推断人格。

## 导出与恢复

```sh
npm run export -- --data /path/to/new-data --agent agent-a --file /path/to/private-export.json
npm run export -- --data /path/to/restore-data --agent agent-a --file /path/to/private-export.json --restore
```

恢复不覆盖已有目标主体。可以逐主体恢复到一个新 SQLite 数据库；跨主体冲突会事务回退，局部 seq 水位按需重映射，证据 ID 和日记修订保留。备份需另含 `media/` 和 `voices/`；JSON 中是媒体引用，不包含全部图片字节。凭据、角色配置和模型 home 需要按用户选择单独保留在本机。

## 旧语音、作息与任务

本轮不读取或复制现有私有语音、任务和人格。准备切换时先独立备份旧语音目录，通过新语音库导入并核对格式/标题；不要把旧本机路径直接当新 audioId。旧作息参数与定时任务须根据新 `behavior`/`scheduler` 字段逐项映射、在管理台预览，再确认启用。新任务以 SQLite 的 `@scheduler` 记录保存，导出恢复包含该状态；中断执行恢复为 unknown，不自动补发。

未迁移的旧运行状态仍完整保留在旧目录。默认主动参与、黑话 learner、跨群与运维开关关闭，单纯导入资料不会解除它们。只将验收后需要的工具加入角色白名单。

## 两后端接入

DSH 使用生成的 `qq-unified-dsh` bundle，它声明独立 `qq-unified` preset 和 `qq-unified` MCP server。生成器不修改 DSH。使用 DSH 支持的本地 bundle/link 工作流安装到选择的 profile，先备份该 profile。核对 MCP tools/list、agentPresets/list、实际工具隔离和模型目录后再进入模型回合。没有 preset 时适配器直接拒绝，不降级到默认开发 agent。

Codex 的专用 home 位于新数据目录 `codex/<agentId>/home`；按 Codex 官方流程单独登录。不要把日常 Codex home 当作此目录。MCP 和动态工具由新桥接适配器管理。模型/强度可以在控制台编辑，实际可用性以对应后端目录为准。

## NapCat 与生产切换

已有原生/Docker 实例优先设为 `external`：新桥接只连接 OneBot，不触碰登录目录和现有启动器。

新托管原生实例配置 `process.command/args/env`，管理器只停止自己启动的子进程；工作目录在新数据目录内，不扫描/终止其他 QQ 进程。它不负责下载 QQ/NapCat 或自动完成手机认证。

新 Docker 实例需已有容器及 `qq-bridge-unified.instance=<connectionId>` 标签；管理器只有 inspect/start/stop，不执行 rm、volume rm、pull 或覆盖容器。现有无标签生产容器继续 external，不为添加标签而重建它。

后续切换顺序：旧 AI 保持暂停 → 新系统也暂停 → 只连接核对账号与入站记录 → 独立验证后端工具 → 经明确指令测试真实模型和 QQ 投递 → 最后单角色逐步解除暂停。不要让两个桥接同时代表同一 QQ 身份参与。

## 回退

新项目测试或切换异常时，先全局暂停并断开新连接，退出新管理器。旧文件、模型 home、原生登录与 Docker 资源从未被本项目迁移覆盖，因此可按原启动器流程恢复旧桥接，仍保持暂停核验。

如果仅回退新记忆导入，停止新管理器，将当前新数据库及 WAL/SHM 一起移动到另一私有备份目录，再用一致备份恢复数据库；不要删除原始旧资料。实际生产回退、QQ 重启与手机确认未在本项目验收中执行，不承诺无人值守恢复。

## 0.4.0 schema 2 的独立升级与一致备份

升级前先用 `npm run memory:backup -- --source OLD_SQLITE --destination NEW_BACKUP_SQLITE` 创建一致备份；这条命令只读打开源库，不触发升级，包含已提交 WAL 页面。目标路径必须不存在，验证 integrity_check 和 foreign_key_check 后才报告成功。

0.4.0 首次打开 schema 1 时，在单一事务中建立 FTS 和明确引用/撤回派生索引，回填现有原文并改为 schema 2。失败回滚，不改写或裁剪历史。重复打开不重复回填；来自 0.3.0 的主体 JSON 导出恢复后由触发器建索引。日记历史版本和证据 ID 保留。大库回填会需要时间及额外磁盘空间，建议在独立副本先演练。

0.3.0 代码会拒绝较新 schema；回退代码时使用升级前的一致备份，不能假定直接打开 schema 2 可用。恢复也只写新路径，不覆盖生产。媒体、语音和选择保留的独立模型 home 仍需单独备份；SQLite 备份不是整套部署备份。本轮仅在合成数据中演练以上过程，未迁移现有生产实例。
