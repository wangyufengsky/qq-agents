# QQ Agents

English | [中文](README.md)

QQ Agents runs several AI characters from one local admin console. Each character is tied to its own QQ account (through NapCat/OneBot), gets its replies from an AI backend — DSH, Codex, Antigravity CLI or any OpenAI-compatible API — and keeps its own persona, memory, diary and permissions. A fresh setup starts isolated and fully paused, so nothing reaches QQ until you open the gates one by one.

![The console home page: one card per character with whether it can speak, its latest reply and the last 24 hours of activity](docs/images/console-home.png)

## What it is

QQ Agents is a **self-hosted application you deploy as is**. It runs on your own machine, stores configuration, chat history, memory and media in a private local data directory, and is configured and operated from a browser console. No code is needed to use it. Remote AI backends, external MCP servers and platform tools receive the context or requests needed for their configured functions; local storage does not make the application offline.

It also has a few narrow extension points: adding an AI backend, adding a bridge tool, and wiring in external MCP servers through configuration. It is **not a general-purpose bot SDK** and has no stable programmatic API. External MCP servers only need configuration; everything else means forking this repository and changing the source, and internal module paths may change between versions.

**A good fit if you**

- want one or a few long-lived QQ characters on your own machine, each with its own persona, memory and diary;
- want to check everything in isolation first, open up step by step, and be able to pause everything at once;
- already run NapCat (or are happy to) and can provide an AI backend — at minimum, one OpenAI-compatible API key.

**Not a good fit if you**

- need a hosted, multi-tenant service or a bot for a large audience;
- want a library or framework to embed in your own program, or rely on a stable plugin interface;
- don't want to look after a QQ login, NapCat and a local runtime yourself.

## What it can do

| Capability                         | Current support                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple characters                | Separate QQ accounts, personas, allowlists, participation rates and pauses; text, images, voice, files, replies and forwards depend on gateway and backend support.                                      |
| Memory and conversation continuity | Separate history, diaries, person cards, work notes and versioned Self. New model sessions receive recent original messages and unfinished work; continuing sessions receive new messages.               |
| Free-time activity                 | When enabled, characters can review history, browse and advance projects. Free-time sessions are continuous by default; contacting a chat goes through an intent and that chat's permissions and budget. |
| Projects and shared activities     | Read works and drafts, inspect revisions and compare linked files. Administrators can explicitly join, suggest changes, answer open questions and edit shared drafts.                                    |
| Files and media                    | Save and transfer authorized files, images and screenshots; read, search and download text files from the console or a linked project.                                                                   |
| External services                  | Public web access, platform browsing and sharing, read-only GitHub access and external MCP tools, subject to character policies, dependencies and credentials.                                           |
| Operations and updates             | Inspect connections, turns and unresolved deliveries; check official releases and use the managed launcher for backup, upgrade and recovery.                                                             |

New characters select the full tool catalog by default, with network, platform browsing/sharing, files, GitHub, scheduling, TTS, cross-group lookup and operations tool switches enabled. Actual use still requires the appropriate allowlists, credentials, directories, cross-group links and operations approvals. ASR and proactive wake behavior are not enabled by these defaults. Existing explicit disables and tool lists are preserved; see [configuration](docs/CONFIGURATION.md).

Model sessions are separate from long-term records. Completed sessions with compatible identity, model and tool contracts can survive restarts; compaction or retirement does not erase history, diaries or Self. Changes to another character's peer details do not recreate this character's sessions. See [chat continuity](docs/CHAT-CONTEXT.md) and [Self and session management](docs/SELF-CONTEXT.md).

## A look at the console

Everything is configured and operated from a local web console (in Chinese). These screenshots come from a demo setup; the characters, QQ numbers, group and messages are fictional.

<table>
  <tr>
    <td width="50%"><img src="docs/images/console-activity.png" alt="Character activity"></td>
    <td width="50%"><img src="docs/images/console-memory.png" alt="Memory and diary"></td>
  </tr>
  <tr>
    <td><b>Activity</b>: one entry per chat reply or free-time turn, with what the character read, what it said and which tools it used, including reply checks where it chose to stay quiet.</td>
    <td><b>Memory and diary</b>: messages are kept in the character's own history in the order they happened; a search hit comes back as a scene with the messages around it and who said what.</td>
  </tr>
  <tr>
    <td><img src="docs/images/console-mind.png" alt="Self"></td>
    <td><img src="docs/images/console-links.png" alt="QQ accounts and AI backends"></td>
  </tr>
  <tr>
    <td><b>Self</b>: name and appearance are fixed identity anchors; personality and ways of relating live in a versioned self that can grow, and administrators can review and restore it.</td>
    <td><b>Connections</b>: each character has its own QQ account (the logged-in number is checked before connecting); DSH, Codex, Antigravity CLI and OpenAI-compatible backends are checked and recovered independently.</td>
  </tr>
  <tr>
    <td><img src="docs/images/console-role-settings.png" alt="Character settings"></td>
    <td>
      <b>Character settings</b>: persona, allowlists, wake rules, participation rate and file, browsing and voice permissions are set per character.<br><br>
      <b>Pause all</b> at the top stops every character at once, and every start begins globally paused until you open it again.
    </td>
  </tr>
</table>

## Choosing a backend

DSH and Codex are the most complete. The OpenAI-compatible backend is the easiest to start with, but it has no context compaction and no native image generation.

| Backend           | You need                                                     | Bridge compaction | Native images | Notes                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------ | ----------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DSH               | The DeepSeek Harness desktop app with this project's bundle  | Yes               | No            | Tools are called through this project's MCP entry point.                                                                                                                |
| Codex             | The Codex CLI, logged in once per character                  | Yes               | Yes           | Dedicated app-server and login directory per character.                                                                                                                 |
| Antigravity CLI   | Git, the official `agy` CLI and a working login              | No                | No            | Explicit session continuation and restricted bridge tools; images use tool results, not direct image attachment input. See [setup and acceptance](docs/ANTIGRAVITY.md). |
| OpenAI-compatible | A base URL and an API key (local servers may not need a key) | No                | No            | Nothing else to install. Near the context limit the session is retired and rebuilt next turn.                                                                           |

All four backends use the bridge tool catalog and external MCP configuration. Available tools depend on permissions, turn type and backend capabilities; `generated_image_list` requires native image generation. Image input and recognition also depend on the adapter and model.

## Let an AI assistant install it

Give the repository to an AI assistant that can run commands on your machine (Claude Code, Codex, DSH …) and say:

> Please follow `docs/AI-INSTALL.md` in this repository to install and configure QQ Agents in isolated mode, explain the available capabilities and scope, and bring it online only after I confirm those choices.

The assistant asks for the bot's QQ number, group, persona and backend, then uses `npm run setup` and `npm run doctor` to configure and check the installation. You scan the QQ login code, enter any API key privately with `npm run setup -- secret …` or log in to the backend, choose capabilities and scope, and confirm going live. The [AI install runbook](docs/AI-INSTALL.md) has the exact steps.

### Updating an existing installation

The console's **System → Version updates** page checks official stable releases, shows release notes and lets you ignore a version. Automatic checks are off by default; enabling them checks every six hours.

With `npm run managed`, or a `robots.mjs` deployment configured with `managedUpdates`, the console can download a fixed release, install dependencies, wait for active turns and deliveries, stop and back up the data directory, then start and check the new code. Success restores the previous global participation state while preserving character and conversation pauses. Startup or health-check failure can restore the old code and backup in a paused state; once resuming has begun, recovery does not automatically overwrite new records or delivery history with an old backup.

Plain `npm start` has no independent upgrade launcher. Stop an existing service normally before changing launch methods, and follow [version updates and recovery](docs/UPDATES.md). For custom installations, manual commit updates or Docker image changes, give an assistant the [AI update runbook](docs/AI-UPDATE.md) and ask it to preserve characters, memory, configuration, logins and permissions, review capability changes, back up, update and verify within the agreed resume scope.

## Quick start

**Requirements:** Node.js 24 or later (for the built-in SQLite). Voice handling needs FFprobe/FFmpeg and GIF reading needs FFmpeg (`FFMPEG_PATH` can point to it). Browsing the console needs neither QQ nor an AI backend.

Clone the repository (or enter your existing checkout), install dependencies and start the console:

```sh
git clone https://github.com/wangyufengsky/qq-agents.git
cd qq-agents
npm ci --ignore-scripts
npm start
```

Keep it running, open another terminal in the same directory and read the token:

```sh
cat .runtime/admin-token
```

Open `http://127.0.0.1:3210` (use `127.0.0.1` or `localhost`) and paste the token into the login box. The token never goes into a URL or a log. Data lives in `.runtime/` by default; use `node src/main.mjs --data /path/to/private-data --port 3210` for another directory or port.

A fresh configuration ships with placeholder accounts, empty allowlists, disabled connections, paused characters and isolated mode. **Starting the console does not start QQ, DSH or any model turn**, so every page is safe to explore.

If you already have NapCat and an OpenAI-compatible API key (DeepSeek, for example), the "最快路径" (fastest path) section of the [getting started guide](docs/GETTING-STARTED.md) walks through connecting the first character.

## Core concepts

- **Character** (`agents[]`): one AI identity with a stable `agentId`, persona, memory and diary. It is bound to exactly one QQ account connection and one AI backend. Characters cannot read each other's memory.
- **QQ account connection** (`connections[]`): one NapCat/OneBot instance over HTTP plus a forward WebSocket. The logged-in QQ number is checked before connecting, and a mismatch is refused.
- **AI backend** (`backends[]`): the model service that produces replies — DSH, Codex, Antigravity CLI or an OpenAI-compatible API. Several characters can share one backend configuration.
- **Isolation and pauses**: with `mode: isolated` nothing connects to QQ and no model runs. In `live` mode there are still separate gates — the global pause (switched on at every start), the character pause, the conversation pause and quiet hours. A character speaks only when all of them are open, and the console lists on each character card exactly why it cannot speak right now.

## Going live

Configure the character, its QQ account connection and its AI backend in isolated mode first. Then, in order:

1. Restart with `--live` (`npm start -- --live`, or `scripts/robots.mjs` for background runs).
2. Set the run mode to `live` in the console and save.
3. Enable the QQ account connection, connect it manually and confirm it shows as connected.
4. Fill in the character's group/private allowlists — only allowlisted conversations are received and answered.
5. Lift the global pause.
6. Lift the character's own pause.

Every start begins globally paused. Once the setup works, `npm start -- --live --resume` (or `command: ["--live", "--resume"]` in Docker) connects the enabled QQ connections after a restart, checks the backends of unpaused characters and lifts only the global pause when everything is ready; character and conversation pauses stay as they are.

If the character still stays silent, check the reasons on its card against the [troubleshooting guide](docs/TROUBLESHOOTING.md).

## Choosing a launch method

| Use                                                                            | Command                                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foreground trial or development                                                | `npm start`; add `-- --live` for real connections and `--resume` to lift the startup pause after readiness checks.                               |
| Configured local background deployment, including registered macOS QQ profiles | `node scripts/robots.mjs start --data <data-directory>`; see [local operations](docs/LOCAL-OPERATIONS.md).                                       |
| Console-managed upgrades                                                       | `npm run managed -- --data <data-directory>`; add `--live` for real connections and `--resume` when startup should restore global participation. |
| Linux / Docker                                                                 | Follow the [Docker deployment guide](docs/DOCKER.md).                                                                                            |

Only one process may use a data directory at a time. A `live` configuration requires the explicit `--live` startup flag; `robots.mjs` adds it according to the configuration. Its `restart` command waits for active turns and deliveries; `stop` cancels unfinished turns.

## Third-party platforms

Some features read content from third-party platforms: Bilibili, Zhihu, Xiaohongshu and Tieba through a local OpenCLI install, Heybox through a ported request signature (`vendor/heybox/`), plus the legacy `vendor/social-reader` module. New characters enable browsing and sharing (`apps.enabled`, `apps.sharing`) and select all supported platforms by default; existing explicit settings are preserved. The legacy `social_*` reader tools are not offered to models. Actual access still needs the required dependencies, logins and permissions. Make sure your use complies with each platform's terms of service; the account you log in with and how often it reads are your responsibility. This project is not affiliated with or endorsed by any of these platforms.

## Documentation

The documentation is written in Chinese.

- [Getting started: your first character in a group](docs/GETTING-STARTED.md)
- [AI install runbook: let an assistant set it up](docs/AI-INSTALL.md)
- [Deploying on Linux / Docker, with a NapCat container](docs/DOCKER.md)
- [Running on Windows](docs/WINDOWS.md)
- [Configuration and the data directory](docs/CONFIGURATION.md), including the OpenAI-compatible backend
- [Troubleshooting by symptom](docs/TROUBLESHOOTING.md)
- [Antigravity CLI setup and acceptance](docs/ANTIGRAVITY.md)
- [AI update runbook](docs/AI-UPDATE.md) and [managed updates and recovery](docs/UPDATES.md)
- [Chat continuity](docs/CHAT-CONTEXT.md) and [Self and session management](docs/SELF-CONTEXT.md)
- [Projects, shared activities and works](docs/PROJECT-WORKSPACE.md)
- [Files](docs/FILE-TRANSFER.md), [saved media](docs/SAVED-MEDIA.md) and [platform browsing](docs/APP-EXPLORATION-IMPLEMENTATION.md)
- [Read-only GitHub access](docs/GITHUB-READ.md) and [protected work](docs/PROTECTED-WORK.md)
- [Local operations with `scripts/robots.mjs`](docs/LOCAL-OPERATIONS.md)
- [Features: scheduling, voice, images, external MCP](docs/FEATURES.md)
- [Architecture and identity boundaries](docs/ARCHITECTURE.md)
- [Extending: AI backends, bridge tools and external MCP](docs/EXTENDING.md)
- [Migration, deployment and rollback](docs/MIGRATION.md)
- [Security policy and vulnerability reports](SECURITY.md)
- [Contributing](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

The [Chinese README](README.md) has the full index.

## License and origins

MIT. The upstream [LICENSE](LICENSE), the [original NOTICE](UPSTREAM-NOTICE.md) and this project's [attribution notes](NOTICE.md) are kept; versions and file digests are listed in [`docs/SOURCES.json`](docs/SOURCES.json).

QQ Agents builds on the DSH client and discovery modules from [h-D-ACE/dsh-qq](https://github.com/h-D-ACE/dsh-qq), takes ideas from [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge), and folds in the Codex RPC, cross-character chat limits and platform readers from an earlier local two-bot project. This repository does not ship the QQ, NapCat, DSH or Codex applications or the SnowLuma SDK; those programs are under their own licenses.
