# 在 Windows 上运行

QQ Agents 可以直接在 Windows 10/11 上运行，CI 在 `windows-latest` 上跑同一套 `npm run verify`。下文只写与 macOS/Linux 不同的地方，完整流程仍按 [入门指南](GETTING-STARTED.md) 走。也可以用 WSL2 或 Docker Desktop 按 [Docker 部署](DOCKER.md) 运行。

## 0. 准备

- **Node.js 24 或更高版本**（[nodejs.org](https://nodejs.org/) 或 `winget install OpenJS.NodeJS`）。
- **Git**：用于获取代码。仓库的 `.gitattributes` 固定使用 LF 换行，不需要改 `core.autocrlf`。
- **FFmpeg / FFprobe**（语音和 GIF 需要）：`winget install Gyan.FFmpeg` 或 `choco install ffmpeg`，装好后新开终端确认 `ffmpeg -version` 能运行。不在 `PATH` 里时用 `FFMPEG_PATH` 指向 `ffmpeg.exe`。
- **NapCat**：使用 NapCat 的 Windows 版本，按其文档登录 QQ，并在 OneBot 11 网络配置里开启 HTTP 服务器和正向 WebSocket 服务器（见 [入门指南第 0 节](GETTING-STARTED.md#0-准备)）。地址填 `127.0.0.1`。

## 1. 启动管理台（PowerShell）

```powershell
npm ci --ignore-scripts
npm start
Get-Content .runtime\admin-token
```

打开 `http://127.0.0.1:3210`，粘贴令牌登录。需要独立数据目录时：

```powershell
node src/main.mjs --data "$env:USERPROFILE\qq-agents-data" --port 3210
```

## 2. 环境变量

配置里只保存环境变量的名字。在 PowerShell 中为当前窗口设置：

```powershell
$env:QQ_UNIFIED_ONEBOT_A = '<NapCat 中设置的 token>'
$env:QQ_UNIFIED_DEEPSEEK_KEY = '<API key>'
npm start -- --live
```

这些变量只对当前窗口有效，关闭后需要重新设置。不要用 `setx` 把令牌写进用户环境变量，否则所有程序都能读到它。

## 3. AI 后端

- **OpenAI 兼容 API**：与其他平台完全相同，推荐在 Windows 上优先使用，见 [OpenAI 兼容后端](CONFIGURATION.md#openai-兼容后端)。
- **Codex**：`npm install -g @openai/codex` 安装后是 `codex.cmd`，桥接会自动用 cmd.exe 安全地启动它；也可以把后端的“Codex 命令”设成 `codex.exe` 的绝对路径。专用登录目录的登录方式：

  ```powershell
  $env:CODEX_HOME = "<数据目录>\codex\<agentId>\home"
  codex login
  Remove-Item Env:CODEX_HOME
  ```

- **DSH**：DeepSeek Harness 桌面版在 Windows 上运行时，「选择 DSH 实例」会通过 `tasklist` 和 `netstat` 查找它监听的端口；找不到时在后端配置里填固定的本机地址。

## 4. 与 macOS / Linux 的差别

| 功能                               | Windows 上的情况                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 数据目录权限                       | Windows 不使用 POSIX 权限位，`0600`/`0700` 不生效，文件权限继承所在目录的 NTFS ACL。**把数据目录放在自己的用户目录下**（默认的 `.runtime/` 跟随代码目录，代码目录也应在用户目录内），不要放在 `C:\` 根目录或共享目录里。 |
| `scripts/robots.mjs`               | 不支持：它管理的是 macOS 原生 QQ（`QQ.app`）和 macOS 的进程查询。在 Windows 上用 `npm start -- --live` 在前台运行，或用任务计划程序在登录后启动同一条命令。                                                              |
| 本地语音合成（`voice_synthesize`） | 不可用（依赖 macOS 的 `say`），工具会返回 `LOCAL_TTS_UNAVAILABLE`，角色改用文字回复。导入的语音和 FFmpeg 处理不受影响。                                                                                                  |
| 公开网页截图                       | 自动查找 `Program Files` 和 `%LOCALAPPDATA%` 下的 Chrome，以及 Edge；都没有时用 `QQ_SCREENSHOT_BROWSER` 或 `CHROME_PATH` 指定浏览器的绝对路径。                                                                          |
| Docker 部署                        | 需要 Docker Desktop（WSL2 后端），按 [Docker 部署](DOCKER.md) 操作。                                                                                                                                                     |

## 5. 停止

在运行窗口按 Ctrl+C（或 Ctrl+Break）。管理台会结束进行中的回合、关闭连接并释放数据目录锁。

直接关闭窗口也会触发同样的停止流程，但 Windows 大约 10 秒后就会强制结束进程，进行中的回合可能来不及收尾，所以优先用 Ctrl+C。

进程被强制结束（任务管理器结束任务、断电）时，数据目录里会留下 `process.lock`，下次启动报 `DATA_DIRECTORY_LOCKED`。程序不会自动回收旧锁。先确认没有旧实例还在使用这个目录：

```powershell
Get-Content .runtime\process.lock          # 记录的 pid 和启动时间
Get-Process -Id <pid> -ErrorAction SilentlyContinue
```

确认该进程已不存在、也没有其他 `node` 进程在用同一数据目录后，再删除 `process.lock` 并重新启动。
