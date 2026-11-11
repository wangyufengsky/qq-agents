# 桌面小窝 P2 隔离试聊

Mac 样机沿用开门邀请、同一聊天面板、拖动记住座位和回家。隔离试聊接入龙（Codex）和猫（Antigravity ACP），小鱼保留在名单中。角色用简短的桌面设定和新建的专用会话，没有导入生产 QQ 资料、Self 或记忆。样机不启动桥接，不连接 QQ，也不修改生产权限。

## 房间规则

- 邀请由角色决定接受或婉拒。取消邀请会撤销本次请求，迟到同意不安排入场。邀请判断单独运行，聊天额度从角色在场后开始扣除。
- 管理员的新消息补满六次模型回合，覆盖上一段未完成的发言安排。每次启动扣一次，沉默、取消和失败也计一次。单次调用可以包含后端内部的工具续推理。
- 定时补满默认距上次刷新 60 分钟，可配置或关闭。定时补满恢复可用额度，下一次聊天仍从新输入开始。
- 有人回家时取消该角色的在途生成并清除其待运行项。加入会扩大听众，所有在场角色从新听众确定时的消息边界另开桌面会话。
- 房间与聊天存于进程内。关闭后只保留座位位置和刷新设置。原生后端使用专用数据目录管理会话及登录。

## 启动

使用本机 Apple Silicon 的 Electron 安装。直接启动 `desktop/home` 时进入模拟模式。隔离试聊由本地启动器设置 `DESKTOP_HOME_LIVE_ROOT`、`DESKTOP_HOME_NODE` 和 `DESKTOP_HOME_TRIAL_PROFILE`，分别指向独立的后端数据目录、Node.js 24+ 可执行文件和桌面设置目录。使用与生产不同的目录。

后端目录的私有 `trial-profile.json` 内容如下。Codex 只读取该目录内 `codex/dragon/home/auth.json` 的专用登录，Antigravity 使用此目录下单独建立的 ACP profile。两种原生适配器只向模型开放桌面决定工具。安装路径、实际模型参数和登录凭据留在本机私有目录。

```json
{
  "kind": "desktop-home-p2",
  "roles": [
    {
      "id": "dragon",
      "type": "codex",
      "command": "/path/to/codex",
      "model": "your-codex-model"
    },
    {
      "id": "cat",
      "type": "antigravity",
      "command": "/path/to/agy",
      "model": "your-agi-model"
    }
  ]
}
```
