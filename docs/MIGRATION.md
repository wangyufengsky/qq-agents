# 迁移、部署与回退

当前生产实例不由本项目启动、暂停、恢复或替换。本轮不运行任何真实 QQ 发送测试。以下步骤须在明确决定切换后执行。

## 先准备可回退的新目录

1. 记录旧代码 commit、部署方式、进程/端口及两个 AI 的暂停状态。保留旧人格、模型会话、原生 QQ 登录目录、Docker 容器/卷/镜像和现有回退备份。
2. 为新项目创建单独的私有数据目录与端口。选择稳定 agentId，映射原 QQ 身份；不要把后端名当成主体身份。
3. 逐项对照 FEATURE-MATRIX.md。逐项核对目标网关扩展、语音格式和真实模型工具，不仅凭离线测试决定替换。

## 记忆预检与导入

```sh
npm run migrate -- --source /path/to/old-instance --agent agent-a --account 10001 --connection-map /private/connection-map.json --data /path/to/new-data
```

默认只读预检；只输出数量和覆盖缺口，不打印聊天内容。支持：

- `state/social-v2.json` 的 recentMessages/unread 窗口；重复消息幂等导入。
- `history/*.jsonl` 中具有 conversation/key、body/text、messageId 等字段的显式历史导出。
- 使用 `--legacy-db /path/to/old.sqlite --legacy-agent old-id` 指定旧 memories 表和原主体 ID，只导入该主体的笔记。

没有识别到的档案结构会明确报告，不能自动猜测人物、内容或来源。窗口可能已经被旧代码截断，无法恢复缺失部分。DSH/Codex 模型内部历史不在本版自动导入范围。

```sh
npm run migrate -- --source /path/to/old-instance --agent agent-a --account 10001 --connection-map /private/connection-map.json --data /path/to/new-data --apply
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

## 0.4.0 schema 3 的独立升级与一致备份

升级前先用 `npm run memory:backup -- --source OLD_SQLITE --destination NEW_BACKUP_SQLITE` 创建一致备份；这条命令只读打开源库，不触发升级，包含已提交 WAL 页面。目标路径必须不存在，验证 integrity_check 和 foreign_key_check 后才报告成功。

0.4.0 首次打开 schema 1 时，在单一事务中建立 FTS 和明确引用/撤回派生索引，回填现有原文并改为 schema 3。已使用早期 schema 2 的独立副本只需补建机器人已确认回复的引用索引，不重建 FTS。回复索引同时识别入站 reply 段和出站 payload.replyTo；未确认或失败的发送不会形成关系。失败回滚，不改写或裁剪历史。重复打开不重复回填；来自 0.3.0 的主体 JSON 导出恢复后由触发器建索引。日记历史版本和证据 ID 保留。大库回填会需要时间及额外磁盘空间，建议在独立副本先演练。

0.3.0 代码会拒绝较新 schema；回退代码时使用升级前的一致备份，不能假定直接打开 schema 3 可用。恢复也只写新路径，不覆盖生产。媒体、语音和选择保留的独立模型 home 仍需单独备份；SQLite 备份不是整套部署备份。本轮仅在合成数据中演练以上过程，未迁移现有生产实例。

## Self / schema 4

本轮新增 self、候选、意图、工作笔记、回合/退休记录和已见消息表。部署前先做一致 SQLite 备份并在新路径验收。旧 persona 只初始化首版 self；有旧模板但缺少独立 appearance 时，更新被拒绝，需由管理员明确保存原有外形或无固定外形，不能靠自动解析猜测。名字/外形变更及 self 变化都在下一回合安全同步。JSON 恢复要求目标主体所有表为空，并重映射事件/活动游标。回退旧代码应恢复备份到新路径，禁止旧代码写入 schema 4。详见 [工程说明](SELF-CONTEXT.md) 与 [验收证据](history/QUALITY-SELF-CONTEXT.md)。本轮未执行生产迁移。

## 迁移前修复：显式主体与档案格式

导入器现要求显式 `agentId`。近期缓存和 camelCase history 绑定所选源实例；用 `--account` 提供原账号，方向和发送者矛盾会拒绝。独立 QQ JSONL 用重复的 `--export FILE` 指定，只接受 schema_version=1 的已知原始来源；不能将重点对话合并视角当原档案导入。`--subject-map` 指向本机 JSON，例如 `{"10001":{"agentId":"agent-a","robot":"测试角色"},"10002":{"agentId":"agent-b"}}`。同一混合文件可分别导入两主体，其他已映射主体计入 otherSubjects，未知主体或矛盾行列入 rejected；有拒绝记录时 apply 整体拒绝。

```sh
npm run migrate -- --source /path/to/old-instance --agent agent-a --account 10001 \
  --connection-map /private/connection-map.json \
  --subject-map /private/subject-map.json --export /private/all-conversations.jsonl \
  --legacy-db /private/snapshot.sqlite --legacy-agent old-a --data /private/new-data
```

QQ 导出的扁平 text/at/reply/附件消息段转换为可查询的 segments，同时保存 originalSegments；来源、截断属性和原始时间字段均留存。缓存时间是旧缓存的观察时间，不能声称总是 QQ 原始发送时间。缺原时间存 unknown，缺方向存 unknown，缺 ID 不生成 QQ ID；所有旧消息仍为 legacy-unverified，不生成投递账本。旧 SQLite 必须匹配已知 memories/people/sightings/events schema，按 legacy-agent 显式选取；保留笔记主体、证据 source_ref、certainty、可见性、替代引用与修订审计。修订审计没有历史正文时，不伪造历史版本。pendingThoughts 和模型草稿排除。

同主体、同会话、同 messageId 只有一条导入消息；跨来源重复观察合并到来源列表，更完整的已知正文优先显示，其他正文与时间差异仍保留。没有 ID 时采用稳定来源、时间、方向、发送者和原序号/位置的保守身份；不按同正文或近时间合并不同来源。无 ID 跨来源可能重复，统计须注明，不能把保留观察数宣称为独立消息精确总数。`--source-id`、`--legacy-source-id` 和 `--export-source-id` 可为缓存、旧库和导出快照提供同一逻辑源标识，复制档案或增量导出时应保持它们稳定。未显式提供时使用原路径摘要。

已有目标先由只读 SQLite backup API 做包含 WAL 的一致备份，验证后才构造 MemoryStore 升级；备份失败时不打开目标。目标数据库及 WAL/SHM 的符号链接、硬链接均拒绝，防止别名指向旧源。导入事务失败时保留升级前备份和错误中的备份位置，恢复到另一个新路径核验，禁止用已升级副本假称升级前回退。目标必须停机；不要复制活跃 SQLite 主文件代替备份。

已存档快照不能代替切换时增量。记录每主体/会话的归档截止、源文件摘要、快照时刻和缺口，旧源继续归档时再次取得一致快照；稳定 messageId 幂等导入，无 ID 的歧义保留来源并人工核对。本轮演练结果与脱敏统计另列，不代表生产切换获准。

已有旧版导入记录按主体、会话和 messageId 识别，保留原事件 ID、来源正文和元数据后补充新观察；已有多个候选时明确拒绝，需先核对歧义。首次迁入已有会话时保留目标水位、会话及运行字段，只合并旧源元数据并设为暂停。别名 ID、发送者、方向、时间相矛盾时拒绝；缓存 text、plain、tail 语义不同，分别保存，不能因 plain 更短而丢掉引用或尾段。

## 连接连续性与 schema 5

导入聊天必须显式提供账号到目标连接的绑定：`--connection-map /private/connection-map.json`，例如 `{"10001":{"agentId":"agent-a","connectionId":"qq-a"},"10002":{"agentId":"agent-b","connectionId":"qq-b"}}`。同一账号、主体和连接不得重复或矛盾绑定；缺映射的行拒绝。缓存/history 使用 `--account`（或唯一 subject-map 账号），QQ 导出按 robot_qq 选择绑定。目标已有 `config.json` 时自动核对角色连接和连接账号，也可用 `--target-config FILE` 明确核对准备配置；未提供配置时结果 `targetConfigChecked=false`，不能声称已核实正式连接。

已迁入的空连接记录在导入事务中补绑；保留 UUID、seq、来源观察、原文和处理水位，重建明确关系与时间索引，涉及会话保持暂停。旧来源有多个账号、与绑定冲突、同一消息多个迁入候选，均拒绝整批。更早且没有账号证据的记录须有本批唯一兼容来源重放支持；缺证据不能猜测。绑定写入 runtime 的 `@migration-binding` 并随 JSON 导出，已有绑定冲突需要先独立核对，不会自动跨连接合并。新消息身份包括目标连接；已有导入键保留，通过兼容查询复用原 UUID。

schema 5 新增可靠消息时间的派生索引和事件更新时的关系刷新。账本 seq、已读水位及原记录不重排。缓存观察时间、未知时间不作为可靠发生时间；新取得的不同可靠观察可以更正所选时间，原时间观察仍在来源列表，并记录 timeProvenance。相同旧观察的重放不覆盖后来选择；没有源版本的 A→B→A 无法区分更正与旧快照重放，保留已有选择与全部证据，不推测来源新旧。搜索锚点仍按账本游标分页，锚点的邻文按消息时间及 UUID 排列；时间展开使用独立 aroundCursor，不能作已读水位。具体见 MEMORY-DESIGN.md。

JSON 多主体恢复同时映射 learner 的 `slang.throughSeq`，以原账本边界对应到目标主体的本地 seq，避免新库中尚未处理的消息被旧数字跳过。Self、日记、回合与归档引用保留，派生索引按恢复后的记录重新生成。

先做升级前的 WAL 一致备份，再打开 schema 5。旧 schema 4 代码会拒绝 schema 5；回退应把升级前备份恢复到新路径，并用实际旧代码读取。JSON 恢复从原事件重建派生索引，无需导出派生表。数据库备份仍不包含配置、凭据和媒体。最新全量历史与正式连接/切换验收仍需另行完成。

## 消息编号别名与 schema 6

网关更换后，后端编号不一定相同。先核对已有审计映射及原始观察，再准备本机版本 1 的别名清单，通过 `--message-aliases FILE --alias-source ORIGINAL_EVIDENCE_FILE` 导入；多个原始证据文件重复传 `--alias-source`。原证据是含 robot_qq、conversation、native_message_id、message_id、record_digest、match_basis 的审计数组。导入器验证文件 SHA-256、逐条编号对应及匹配依据、目标记录来源观察摘要、显式账号/连接绑定及唯一性，不做正文或时间相似度匹配。审计数组与规范清单须同时提供；转换时必须逐条核对来源、完整性和已发生的引用编号转换，保留原文件。

清单顶层为 `{"version":1,"aliases":[...]}`，每条包含：

| 字段                             | 内容                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| accountId / conversation         | 已显式绑定的账号及 `group:` / `private:` 会话                                     |
| archiveMessageId                 | 目标档案保留的原编号；目标必须唯一存在                                            |
| namespace / messageId            | 当前网关编号命名空间和该网关实际编号；`archive` 保留给档案                        |
| evidence.sourceId / sourceDigest | 有界逻辑来源标识及 `--alias-source` 文件 SHA-256                                  |
| evidence.targetDigest            | 目标 `payload.migration.sources` 中同账号来源观察的 digest                        |
| evidence.basis                   | 已核实的 `verified-sequence`、`verified-observation` 或新原生记录 `native-record` |

目标连接须配置相同的 `messageIdNamespace`，默认 `onebot`；显式 `--target-config` 会校验它。不同网关编号空间应使用不同稳定名称，不复用已有空间表示另一种编号；同一 namespace 下一个目标只能有一个编号。缺源、冲突、缺目标或账号不符会拒绝整批。可对已导入目标补充别名，无须改写旧 UUID、message_id、账本 seq 或时间索引。补充和重复导入不会推进水位；无稳定身份的疑似重复继续保留。

schema 6 新增 message_aliases 和 message_observations。明确别名解析统一用于双向回复/撤回关系、场景引用、证据追溯和发往当前网关的引用；没有当前网关编号时拒绝发送该引用。用户只给编号而跨空间存在多个目标时拒绝猜测。旧记录缺显式空间时，只允许不歧义的兼容解析；不会凭相同文本合并。运行时同一消息再次观察保留到独立观察表，原文、来源、发生时间和已读边界保持；不把重复观察作为新来信唤醒。连接不能在同一迁移绑定下换成另一账号。

两个新表随主体 JSON 导出恢复；外键、主体/连接/会话及来源校验均保留。仍须在首次升级前执行只读一致备份（CLI apply 自动先备份），使用实际 schema 5 旧代码读取升级前备份的新路径恢复副本。旧代码不能打开 schema 6；新 schema 备份不能替代升级前回退。媒体、登录、配置和模型 home 不在数据库备份内。
