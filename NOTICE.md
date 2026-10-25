# Attribution

QQ Bridge Unified is an independent derivative project under MIT.

- h-D-ACE/dsh-qq at `0a10b6b13778bf19816432fbe8b51cdf00302d89`: DSH Web RPC/mux client, dynamic endpoint discovery, Markdown conversion, scheduler rules/time/commands and TOTP. Original copyright: 2026 Derpyu520 and qq-bridge / QSH contributors; enhanced work by h-D-ACE. Original LICENSE and UPSTREAM-NOTICE.md retained verbatim.
- Derpyu520/qq-bridge at `a49877f4e58d04e47532d44b803360d0f001160d`: protocol and behavior reference, MIT.
- Local qq-bridge-codex at `6ddd867`: Codex stdio RPC, peer conversation limiter, social-reader modules, voice/forward/wait helpers. Only reviewed source modules copied; no configuration, credentials, history, instance directories, or Git history imported.

`vendor/` contains the explicitly reused modules. Runtime integration and new memory implementation live in `src/`. No SnowLuma SDK, MCP package, QQ client, NapCat binary, DSH application, or Codex application is bundled. Each external application retains its own license. See vendor/social-reader for its dependency notices.

The vendored forward helper changes only its Markdown-helper import path. All vendored source hashes and baseline origins are recorded in docs/SOURCES.json.
