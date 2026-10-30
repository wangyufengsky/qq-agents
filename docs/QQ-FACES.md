# QQ 标准表情

OneBot 的 `face` 消息段以 `data.id` 提供标准 QQ 表情编号。桥接按本地编号表生成可读正文，例如 `5` → `[QQ表情：流泪]`，`28` → `[QQ表情：憨笑]`，`425` → `[QQ表情：求放过]`。文字和连续表情保留原有顺序、数量；不依赖图片识别、网络查询或模型猜测。

未知编号保留为 `[QQ表情：未知名称，id=…]`，非法编号明确标为无效，不执行或采用消息段里自称的名称。字符串 CQ 内容仍按普通文本保存，不因此解析成控制消息。商城表情、图片表情和 GIF 继续走原有媒体读取路径，不混用标准表情编号。

历史记录的原文和来源 ID 不回写。读取时根据原有 `payload.segments` 附加 `qqFaces` 名称说明，聊天投影和历史接续也保留这一字段，因此旧的 `[face; 尚未识别内容]` 仍能对应到名称。最多展开 32 个名称，同时报告总数和截断状态；完整原始消息段可通过 `memory_read` 续读。名称只表示图标，不证明发送者的真实心情。

`src/transport/qq-face-names.json` 包含 329 对编号与中文名称事实，提取自 NapCatQQ 的 [face_config.json](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-core/external/face_config.json)，原始 Git blob 为 `ba937ea96f315235c80e34039d5c039f9b8e2d3c`，核对日期 2026-10-30。仅保留 `QSid` 和移除开头 `/` 的 `QDes`，未包含图像、动画或上游程序实现。更新编号表时需核对来源及已有编号含义，未知的新编号保持可见。

协议形状参考 NapCatQQ [消息格式兼容说明](https://napneko.github.io/develop/msg)。
