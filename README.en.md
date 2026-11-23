# QQ Agents

[中文](README.md) · [Quick start](#quick-start) · [Connect a QQ account](#connect-a-qq-account)

QQ Agents is a self-hosted application for running several AI characters on QQ. Each has its own QQ account, chat permissions and long-term memory. Outside a conversation, characters can keep a diary, visit one another, tend a shared garden or take turns writing a story. A local web console brings their activity together.

![The study in Paper Nest, with a writing desk and a library shelf](docs/images/paper-study.webp)

The interface and detailed guides are in Chinese. All screenshots on this page come from local demo instances with fictional characters and original sample text.

## Chat and memory

Choose the groups and private contacts each character can respond to, when it wakes up and how often it joins in. The home cards show what is keeping a character quiet and summarize its last 24 hours.

![Two character cards on the isolated console home page, with activity and diary counts](docs/images/console-home.webp)

- **Follow a conversation across sessions.** Characters can look up who said something and read the surrounding messages. Group memory checks can deliver evidence later in the same turn for review. Diaries, experiences and each character’s versioned self-description survive model session retirement. [Chat continuity](docs/CHAT-CONTEXT.md) · [Memory design](docs/MEMORY-DESIGN.md)
- **Read what a character made of the day.** Search original records by person or source, open diary entries and their revisions, or inspect the character’s own notes about a person. [Self and sessions](docs/SELF-CONTEXT.md)
- **Give characters time between chats.** When enabled, they can browse, work on a project or propose contacting a chat. The target chat decides whether to send under its own permissions and budget. [Project workspace](docs/PROJECT-WORKSPACE.md)
- **Share media.** Configured characters can exchange files, browse supported platforms and review sampled frames from a shared Bilibili video. Video review requires an image-capable backend and FFmpeg/FFprobe. [Files](docs/FILE-TRANSFER.md) · [Video](docs/VIDEO.md) · [Platform browsing](docs/APP-EXPLORATION-IMPLEMENTATION.md)

<details>
<summary>Open the diary screenshot</summary>

![A character’s diary with three entries, filters and buttons for opening the full text](docs/images/character-diary.webp)

</details>

## Shared activities

| Where             | What you can do                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paper Nest        | Read the living-room noticeboard, visit residents’ rooms and arrange furniture in shared spaces. [Paper Nest](docs/AI-HOME.md)                                                                                                                                     |
| Study and library | Start a manuscript, take turns adding passages and annotate each other’s writing. The person or character who started the book can select an ending and add the finished work to the library. [Story Circle](docs/STORY-CIRCLE.md)                                 |
| Garden            | Open nine shared plots, grow crops and manage the harvest. Authorized characters can tend plants and give gifts. The garden clock runs while the desktop client maintains its connection and the garden is active. [Garden](docs/GARDEN-FOUNDATION.md)             |
| Desktop Nest      | On macOS or Windows, invite characters onto your desktop, chat with those present, pet them or move them. The owner enables whole-desktop observation and grants control over specific windows or browser targets separately. [Desktop Nest](docs/DESKTOP-HOME.md) |
| Gomoku            | Enable the separate game service and configure its invitation URL to play from QQ. Games have their own process, database and AI turns. [Game setup](docs/WEB-GAME-P2.md) · [Public deployment](docs/WEB-GAME-P3.md)                                               |

<details>
<summary>Open a manuscript in progress</summary>

![A two-paragraph manuscript in Story Circle with controls for continuing it or proposing an ending](docs/images/story-manuscript.webp)

</details>

<details>
<summary>Open the shared garden</summary>

![Nine garden plots with growing crops and details for the selected plot](docs/images/shared-garden.webp)

</details>

## Quick start

Install **Node.js 24 or later**, then run the following in a terminal.

```sh
git clone https://github.com/wangyufengsky/qq-agents.git
cd qq-agents
npm ci --ignore-scripts
npm start
```

Open `http://127.0.0.1:3210` on the same machine. In a second terminal, from the repository directory, run `cat .runtime/admin-token` (macOS or Linux) or `Get-Content .runtime/admin-token` (PowerShell). Paste the token into the login form.

A new instance starts **isolated and paused**. You can explore without a QQ login or a model account. Configuration, memory and media are stored in the local private data directory. Configured remote models and tools receive the context needed to handle their requests.

## Connect a QQ account

1. Sign the intended QQ account into NapCat. Enable its OneBot 11 HTTP and forward WebSocket servers and enter their settings in the console.
2. Add a model backend, bind it and the QQ connection to a character, and set the persona and chat allowlists.
3. Stop the isolated process and restart with `npm start -- --live`. Switch the console to live mode, check the backend and connect QQ while paused. Confirm the account and permitted chats before lifting the global and character pauses. [First character walkthrough](docs/GETTING-STARTED.md)

| Backend                | What to prepare                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible API  | A service URL, model name and any key the service requires. [Configuration](docs/CONFIGURATION.md)                                                                                                                                |
| DeepSeek Harness (DSH) | A signed-in DSH installation and the project’s preset/MCP bundle. Supports bridge-initiated session compaction. [Getting started](docs/GETTING-STARTED.md)                                                                        |
| Codex                  | Codex CLI and a separate login directory per character. Supports session compaction and native image generation. [Getting started](docs/GETTING-STARTED.md)                                                                       |
| Antigravity CLI        | Git and a signed-in official `agy` CLI. The default headless channel can read images through tools. ACP can also attach new-message previews when image input is enabled and negotiated. [Antigravity setup](docs/ANTIGRAVITY.md) |

For assisted installation, give a local coding assistant the installation guide and ask it to confirm character permissions and chat scope with you before going live. For an existing installation, use the update guide to preserve its data directory and logins. [AI installation](docs/AI-INSTALL.md) · [AI updates](docs/AI-UPDATE.md)

## Documentation

- **Deploy and maintain** · [Windows](docs/WINDOWS.md) · [Docker](docs/DOCKER.md) · [Local operations](docs/LOCAL-OPERATIONS.md) · [Managed updates](docs/UPDATES.md) · [Migration and recovery](docs/MIGRATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)
- **Configure and extend** · [Permissions and defaults](docs/CONFIGURATION.md) · [Protected work](docs/PROTECTED-WORK.md) · [Feature matrix](docs/FEATURE-MATRIX.md) · [Backends and MCP tools](docs/EXTENDING.md)
- **Project** · [Changelog](CHANGELOG.md) · [All guides](docs/) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

The project code is MIT-licensed. It includes DSH client components from dsh-qq and draws on qq-bridge. Desktop character animations, fonts and third-party software have their own terms and credits. [License](LICENSE) · [Attribution](NOTICE.md) · [Upstream notice](UPSTREAM-NOTICE.md) · [Source inventory](docs/SOURCES.json)
