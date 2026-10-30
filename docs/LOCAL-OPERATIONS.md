# 独立本机启停与旧桥接退役

`scripts/robots.mjs` 统一管理本项目桥接和已明确登记的 macOS 原生 QQ。无需启动旧桥接管理台，DSH 桌面仍需先启动；Codex 使用数据目录下的独立 CLI 登录。此入口不会修改日常 Codex 登录、清空会话或启动 Docker。

```sh
node scripts/robots.mjs status --data /absolute/private/bridge-data
node scripts/robots.mjs start --data /absolute/private/bridge-data --resume --open
node scripts/robots.mjs stop --data /absolute/private/bridge-data
node scripts/robots.mjs restart --data /absolute/private/bridge-data --resume
# 只有桥接已停止时，才可单独停止本入口确认拥有的原生 QQ：
node scripts/robots.mjs qq-stop --data /absolute/private/bridge-data
```

`start` 默认保持全局暂停；`--resume` 在连接和模型目录检查成功后解除全局暂停，保留角色、会话各自的暂停偏好。`stop` 立即关闭桥接并取消未完成回合，保留 QQ 和 DSH；下次启动仍从全局暂停开始。启动时对已启用的原生连接最多等待 60 秒，确认账号、在线状态与 WS 端口就绪后再连接桥接。端口未启动可短暂重试；身份、认证和协议错误立即终止，持续离线报告 `NATIVE_LOGIN_REQUIRED`。启动失败不删除登录数据。

`restart` 先通过管理员接口 `POST /api/maintenance`（空 JSON 对象）关闭新回合入口，轮询等待已有回合和投递结束，再停止及启动。等待期间不取消原回合、工具请求继续按原权限执行，新来信排队；`GET /api/status` 的 `maintenance` 显示是否等待、剩余工作数及截止时间。等待超时停止本次重启并保留现场，需要立即停止时仍使用 `stop`。未提供此接口的旧部署须先人工等待活跃回合结束，不能把接口失败当成允许强行重启。

管理台仅修改角色的普通消息参与率时立即生效，保留已有 QQ 连接、模型回合与会话；新比例用于之后的普通消息唤醒判断，已排队或正在进行的回合不会因此取消。原样保存同样不会断开连接。其他配置修改仍会撤销旧能力并要求重新连接，保存提示会说明是否需要接入。暂停、重置会话、断开连接或配置变更引起的正常取消不再报 `BACKEND_TURN_FAILED`；实际后端失败仍保留，回合达到时限显示 `BACKEND_TURN_TIMEOUT`。

数据目录可包含 `deployment.json` 的 `codeRoot`，指向本地发布快照；省略时使用脚本所在项目。设置 `managedUpdates: true` 后，原有启停命令改为管理独立升级启动器，支持管理台一键升级；切换前先正常停止原桥接，详情见 [版本更新](UPDATES.md)。`secrets.json` 保存本地环境变量，只有桥接子进程会读取。`native-profiles.json` 的结构如下，必须留在私有数据目录，不能提交：

```json
{
  "profiles": [
    {
      "id": "napcat-a",
      "accountId": "10001",
      "workdir": "/absolute/private/napcat-profile-a"
    }
  ]
}
```

原生配置从该 profile 的 `config/onebot11_<accountId>.json` 与 `config/webui.json` 读取，只接受本机带令牌的独立 HTTP/WS/WebUI 端口，并与新桥接账号和地址核对。账号、端口或 PID 归属不符时停止操作。只复用同时匹配账号、规范路径、进程组、启动时间及精确命令的原生进程记录；PID 被重用时不接管、不结束。未完成的停止会报错，不强制杀进程。

启动器有独立操作锁。桥接异常退出留下的数据锁只在原 PID 已不存在时改名保留；操作锁如果因启动器崩溃留下，先核对其中 PID，再人工归档，不能盲删。

## 退役顺序

1. 保存当前数据库、配置、发布快照与凭据的本地备份；Git 只提交代码及脱敏示例。
2. 核对新版真实 QQ 回复和工具回执。预设列表必须没有 `broken`；只有模型目录可读还不足以证明能创建会话。
3. 在此入口登记原生 QQ profile，演练桥接停止、重新连接、恢复及独立 QQ 重启。任何重新登录要求交给用户，不绕过手机验证。
4. 停止旧桥接应用进程，保持共享 QQ 运行。旧入口的 `stop` 与 `qq-stop` 含义不同，后者会断开新框架仍使用的 QQ。
5. 停用旧 QQ 专用 DSH bundle、移除其旧路径 MCP 注册。其他用途的浏览器/搜索插件不随旧桥接清理。
6. 检查活跃进程、符号链接、DSH profile 和新启动脚本均不引用待移除的旧代码。旧 DSH 工作区的历史会话目录必须单独保留。
7. 将旧代码归档到私有回退目录，再从原位置移除；旧人格、历史会话、QQ 登录、浏览器登录、Docker 资源不与代码一起删除。记录恢复路径和启动方式。

## DSH 预设热更新

DSH 保留已有会话对应的预设版本。压缩引擎与 `/compact` 必须放入同一个 `cordis:group`，使用 `isolate.compaction: true` 为每个版本分配独立作用域。使用固定的字符串隔离名称会让新旧版本重复注册 `compaction`，导致新会话被拒绝。更新 bundle 后必须实际创建新会话，并在有旧会话存活时再次热加载验证。现有历史不需要删除。

## 框架版本清单

源码运行时，框架从当前仓库读取 commit 并检查修改状态。发布快照不带 `.git` 时，在快照根目录运行 `node scripts/framework-build.mjs --commit <完整提交SHA>` 生成 `framework-build.json`，再启动应用。打包方须使用该提交的真实代码；脚本记录 src、vendor、public、scripts、docs 和依赖锁文件等运行资料的构建摘要，运行时验证摘要后才使用清单中的 commit。没有可验证清单或源码仓库时明确报告版本未知，不从父目录仓库推断版本。清单不包含配置、路径或密钥，不要手写虚假的提交号。

每次启动保存框架资料快照，运行期间修改源码不会冒充已重新部署。应用更新后应重启，使运行代码、工具目录和说明同步。
