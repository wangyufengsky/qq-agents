# Attribution

QQ Agents (formerly developed privately as QQ Bridge Unified) is an independent derivative project under MIT.

- h-D-ACE/dsh-qq at `0a10b6b13778bf19816432fbe8b51cdf00302d89`: DSH Web RPC/mux client, dynamic endpoint discovery, Markdown conversion, scheduler rules/time/commands and TOTP. Original copyright: 2026 Derpyu520 and qq-bridge / QSH contributors; enhanced work by h-D-ACE. Original LICENSE and UPSTREAM-NOTICE.md retained verbatim in vendor/dsh/UPSTREAM-LICENSE.md and vendor/dsh/UPSTREAM-NOTICE.md; their implementation notes describe the historical upstream, not this project.
- Derpyu520/qq-bridge at `a49877f4e58d04e47532d44b803360d0f001160d`: protocol and behavior reference, MIT.
- Local qq-bridge-codex at `6ddd867`: Codex stdio RPC, peer conversation limiter, social-reader modules, voice/forward/wait helpers. Only reviewed source modules copied; no configuration, credentials, history, instance directories, or Git history imported.

`vendor/` contains the explicitly reused modules. Runtime integration and new memory implementation live in `src/`. No SnowLuma SDK, MCP package, QQ client, NapCat binary, DSH application, or Codex application is bundled. Each external application retains its own license. See vendor/social-reader for its dependency notices.

The vendored forward helper changes only its Markdown-helper import path. The social-reader search adapter supplies the objective field required by the verified Exa schema. The social-reader safe fetcher calls a caller-supplied authorization hook for each hop and reports the response Content-Type; its address, DNS and redirect checks are unchanged. All vendored source hashes, local modifications and baseline origins are recorded in docs/SOURCES.json.

- shadowfish07/heybox-cli at `0a03f8884f35298bf26d37dfb8b390e2b5ac1d21`: MIT read API signature port; original license in `vendor/heybox/LICENSE`. plasta2steel/dsh-xiaoheihe at `32bc17d707397af48368db759548806763bca6aa` was read as an endpoint/response reference only.
- Platform adapters call a locally installed OpenCLI 1.8.4 through its fixed read commands and helpers. OpenCLI and browser login material are not bundled. The tested version is pinned at the adapter boundary; other versions fail with an explicit compatibility error.

Current npm dependency licenses are recorded in package-lock.json. Distributed copies must preserve the applicable upstream copyright and license notices. The root LICENSE contains the MIT license; historical upstream commentary does not add permissions for external applications.

- QQ system-face identifier/name facts are referenced from NapNeko/NapCatQQ `packages/napcat-core/external/face_config.json`, Git blob `ba937ea96f315235c80e34039d5c039f9b8e2d3c`. Only identifier/name pairs are included; no QQ artwork, animation, or NapCat implementation is bundled. See docs/QQ-FACES.md.

## 纸页小窝与桌面小窝生成素材

`public/garden-art/` 的 65 张花园纸贴由 OpenAI imagegen 按维护者选定的平印与松绿纸贴设计制作，按本项目根目录 MIT 许可提供。原图哈希、导出规格和制作说明见 [小窝花园素材](docs/AI-HOME-ASSETS.md#小窝花园平印纸贴)。

纸页小窝的 `Paper Nest Hand` 网页字体源自 [LXGW WenKai Regular v1.530](https://github.com/lxgw/LxgwWenKai/releases/tag/v1.530)，按 SIL Open Font License 1.1 分发。字体由 LXGW 基于 Fontworks Klee 开发；完整版权和许可保留在 `vendor/fonts/LXGW-OFL.txt`。本项目为遵守保留字体名称要求更改了字体家族名，并转换为 WOFF2；未修改或删减字形，转换版本与哈希记录在 `docs/SOURCES.json`。

`public/home-preview/assets/` 的 27 张手绘纸板与纸片由维护者委托 OpenAI imagegen 生成，作为 QQ Agents 项目贡献按根目录 MIT 许可提供。来源、提示词、原图哈希及 WebP 转换记录见 [素材说明](docs/AI-HOME-ASSETS.md)；原始用户参考附件不包含在发布素材中。

桌面小窝随附的 WebP 纸片角色和六套动作姿势由 OpenAI imagegen 生成。蓝鲸、白龙和星饰猫的拟人方向参考 [ZipZipPipe 的角色设定](https://www.bilibili.com/opus/1233069202138464289)，鲸鱼形象源自上善无形的「溟月」。桌面版本重新设计了衣装、姿势和纸片画法。

桌宠的站姿和步行帧由 OpenAI imagegen 参考上述角色的待机图生成。裁切并转换后的透明 WebP 作为 QQ Agents 项目贡献按根目录 MIT 许可分发，制作和发布路径见 [桌宠动作素材](docs/AI-HOME-ASSETS.md#桌宠动作素材)。

## 桌面角色动画

桌宠浮窗使用 [hunmer/aboutme-pets](https://github.com/hunmer/aboutme-pets/tree/df864c0c7db75857854740b301f6677e50d0b29c) 的 DSH、Gemini 和 GPT 动作。此处直接使用原尺寸的透明 WebP 精灵图，按原动作帧率播放；未包含音轨。

- 小鱼素材来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，由 hunmer 转换。原型「溟月」由上善无形创作，女仆鲸鱼娘设计来自 ZipZipPipe。角色采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)，公开二创须署名上游。
- 小猫、小龙的角色立绘由 [lokicorvus/crosspet](https://github.com/lokicorvus/crosspet) 提供，动作由 hunmer 生成。相应素材及此处改编按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 分享，包括署名、非商业使用和相同方式共享条款。

上述素材单独适用各自条款。代码许可见 LICENSE。
