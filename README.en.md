# QQ Agents

English | [中文](README.md)

QQ Agents runs several AI characters from one local admin console. Each character is tied to its own QQ account (through NapCat/OneBot), gets its replies from an AI backend — DSH, Codex or any OpenAI-compatible API — and keeps its own persona, memory, diary and permissions. A fresh setup starts isolated and fully paused, so nothing reaches QQ until you open the gates one by one.

## What it is

QQ Agents is a **self-hosted application you deploy as is**. It runs on your own machine, keeps every piece of data (configuration, chat history, memory, media) in a private local data directory, and is configured and operated from a browser console. No code is needed to use it.

It also has a few narrow extension points: adding an AI backend, adding a bridge tool, and wiring in external MCP servers through configuration. It is **not a general-purpose bot SDK** and has no stable programmatic API. External MCP servers only need configuration; everything else means forking this repository and changing the source, and internal module paths may change between versions.

**A good fit if you**

- want one or a few long-lived QQ characters on your own machine, each with its own persona, memory and diary;
- want to check everything in isolation first, open up step by step, and be able to pause everything at once;
- already run NapCat (or are happy to) and can provide an AI backend — at minimum, one OpenAI-compatible API key.

**Not a good fit if you**

- need a hosted, multi-tenant service or a bot for a large audience;
- want a library or framework to embed in your own program, or rely on a stable plugin interface;
- don't want to look after a QQ login, NapCat and a local runtime yourself.

## Choosing a backend

DSH and Codex are the most complete. The OpenAI-compatible backend is the easiest to start with, but it has no context compaction and no native image generation.

| Backend           | You need                                                     | Compaction | Native images | Notes                                                                                         |
| ----------------- | ------------------------------------------------------------ | ---------- | ------------- | --------------------------------------------------------------------------------------------- |
| DSH               | The DeepSeek Harness desktop app with this project's bundle  | Yes        | No            | Tools are called through this project's MCP entry point.                                      |
| Codex             | The Codex CLI, logged in once per character                  | Yes        | Yes           | Dedicated app-server and login directory per character.                                       |
| OpenAI-compatible | A base URL and an API key (local servers may not need a key) | No         | No            | Nothing else to install. Near the context limit the session is retired and rebuilt next turn. |

## Quick start

**Requirements:** Node.js 24 or later (for the built-in SQLite). Voice handling needs FFprobe/FFmpeg and GIF reading needs FFmpeg (`FFMPEG_PATH` can point to it). Browsing the console needs neither QQ nor an AI backend.

```sh
npm ci --ignore-scripts
npm start
cat .runtime/admin-token
```

Open `http://127.0.0.1:3210` (use `127.0.0.1` or `localhost`) and paste the token into the login box. The token never goes into a URL or a log. Data lives in `.runtime/` by default; use `node src/main.mjs --data /path/to/private-data --port 3210` for another directory or port.

A fresh configuration ships with placeholder accounts, empty allowlists, disabled connections, paused characters and isolated mode. **Starting the console does not start QQ, DSH or any model turn**, so every page is safe to explore.

If you already have NapCat and an OpenAI-compatible API key (DeepSeek, for example), the "最快路径" (fastest path) section of the [getting started guide](docs/GETTING-STARTED.md) brings one character online in about ten minutes.

## Core concepts

- **Character** (`agents[]`): one AI identity with a stable `agentId`, persona, memory and diary. It is bound to exactly one QQ account connection and one AI backend. Characters cannot read each other's memory.
- **QQ account connection** (`connections[]`): one NapCat/OneBot instance over HTTP plus a forward WebSocket. The logged-in QQ number is checked before connecting, and a mismatch is refused.
- **AI backend** (`backends[]`): the model service that produces replies — DSH, Codex or an OpenAI-compatible API. Several characters can share one backend configuration.
- **Isolation and pauses**: with `mode: isolated` nothing connects to QQ and no model runs. In `live` mode there are still separate gates — the global pause (switched on at every start), the character pause, the conversation pause and quiet hours. A character speaks only when all of them are open, and the console lists on each character card exactly why it cannot speak right now.

## Going live

Configure the character, its QQ account connection and its AI backend in isolated mode first. Then, in order:

1. Restart with `--live` (`npm start -- --live`, or `scripts/robots.mjs` for background runs).
2. Set the run mode to `live` in the console and save.
3. Enable the QQ account connection, connect it manually and confirm it shows as connected.
4. Fill in the character's group/private allowlists — only allowlisted conversations are received and answered.
5. Lift the global pause.
6. Lift the character's own pause.

If the character still stays silent, check the reasons on its card against the [troubleshooting guide](docs/TROUBLESHOOTING.md).

## Third-party platforms

Some features read content from third-party platforms: Bilibili, Zhihu, Xiaohongshu and Tieba through a local OpenCLI install, Heybox through a ported request signature (`vendor/heybox/`), plus the legacy `vendor/social-reader` module. These are **off by default**: per-character platform browsing (`apps.enabled`) is disabled with no platforms selected, and the legacy `social_*` reader tools are currently never offered to models. Before enabling them, make sure your use complies with each platform's terms of service; the account you log in with and how often it reads are your responsibility. This project is not affiliated with or endorsed by any of these platforms.

## Documentation

The documentation is written in Chinese.

- [Getting started: your first character in a group](docs/GETTING-STARTED.md)
- [Configuration and the data directory](docs/CONFIGURATION.md), including the OpenAI-compatible backend
- [Troubleshooting by symptom](docs/TROUBLESHOOTING.md)
- [Local operations with `scripts/robots.mjs`](docs/LOCAL-OPERATIONS.md)
- [Features: scheduling, voice, images, external MCP](docs/FEATURES.md)
- [Architecture and identity boundaries](docs/ARCHITECTURE.md)
- [Extending: AI backends, bridge tools and external MCP](docs/EXTENDING.md)
- [Migration, deployment and rollback](docs/MIGRATION.md)
- [Security policy and vulnerability reports](SECURITY.md)
- [Changelog](CHANGELOG.md)

The [Chinese README](README.md) has the full index.

## License and origins

MIT. The upstream [LICENSE](LICENSE), the [original NOTICE](UPSTREAM-NOTICE.md) and this project's [attribution notes](NOTICE.md) are kept; versions and file digests are listed in [`docs/SOURCES.json`](docs/SOURCES.json).

QQ Agents builds on the DSH client and discovery modules from [h-D-ACE/dsh-qq](https://github.com/h-D-ACE/dsh-qq), takes ideas from [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge), and folds in the Codex RPC, cross-character chat limits and platform readers from an earlier local two-bot project. This repository does not ship the QQ, NapCat, DSH or Codex applications or the SnowLuma SDK; those programs are under their own licenses.
