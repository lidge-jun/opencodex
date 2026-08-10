# 001 — cc-switch toggle mechanics (reference implementation)

Research only. No diffs here. Sources were opened against upstream `main` on
2026-08-02 via the GitHub API (research lane Zeno, main-agent spot-check of the
two load-bearing claims).

cc-switch v3.17.0 (Tauri 2, Rust + React) manages Claude Code, Claude Desktop,
Codex, Gemini CLI, Grok Build, OpenCode, OpenClaw, and Hermes Agent. It is the
closest shipping implementation of the "on/off switch per client app" this unit
evaluates. Its own provider store is `~/.cc-switch/cc-switch.db` (SQLite), with
`settings.json` for device preferences and `backups/` for database backups
([README.md#L302-L305](https://github.com/farion1231/cc-switch/blob/main/README.md#L302-L305),
[database/mod.rs#L96-L109](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/database/mod.rs#L96-L109)).

## 1. Two app classes: exclusive vs additive

The toggle semantics split on whether the client keeps one active provider or
many coexisting ones:

| Class | Clients | "Switch on" means | "Switch off" means |
|-------|---------|-------------------|--------------------|
| Exclusive | Claude Code, Codex, Gemini | backfill current live config into the stored provider record, then overwrite live config with the target provider | switching away backfills and overwrites with the next provider |
| Additive | OpenCode, OpenClaw, Hermes | insert the provider entry into the client's live config, alongside existing ones | `remove_provider_from_live_config` deletes only that live entry; the provider stays in cc-switch's DB, marked `live_config_managed=false` |

Source: [provider/mod.rs#L2893-L2951](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/mod.rs#L2893-L2951),
[provider/mod.rs#L2954-L2966](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/mod.rs#L2954-L2966),
[provider/mod.rs#L3087-L3146](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/mod.rs#L3087-L3146).
Main-agent spot-check: `live_config_managed` markers and
`provider_live_config_managed` confirmed in `provider/mod.rs` (lines 1870,
2437-2450).

All four of this unit's target clients (Hermes, OpenClaw, and by their config
shapes Kimi Code and Gajae Code) are **additive-class**: a toggle writes and
removes one provider entry, never a whole-file takeover.

## 2. Write discipline

- Provider-specific writers project into native files: Claude ->
  `~/.claude/settings.json`, Codex -> `~/.codex/auth.json` + `config.toml`,
  OpenClaw -> `~/.openclaw/openclaw.json` (JSON5), Hermes ->
  `~/.hermes/config.yaml` (YAML).
- JSON/TOML/text writes go through a temporary sibling file + rename (atomic on
  Unix; Windows removes the destination first).
  [provider/live.rs#L1015-L1060](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/live.rs#L1015-L1060),
  [config.rs#L273-L351](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/config.rs#L273-L351)
- Writer modules preserve unknown fields (`serde(flatten)` extra maps in
  `hermes_config.rs` / `openclaw_config.rs`) and honor the client's own
  config-dir overrides (`HERMES_HOME`, Windows `%LOCALAPPDATA%\hermes`).
- Health warnings are returned on write (`OpenClawWriteOutcome.warnings`).

## 3. Proxy takeover: the *other* kind of toggle

cc-switch has a second, coarser switch — "proxy takeover" — which is
backup-and-restore, not provider-entry deletion:

1. Enable: start the local proxy if needed, snapshot the app's current live
   config into the DB's live-backup storage, then write proxy
   endpoint/placeholder fields into the client config.
2. Disable/stop-with-restore: write the saved snapshot back and delete the
   backup rows. Missing backup -> attempt SSOT/provider reconstruction and
   placeholder cleanup.
3. Switching providers *while* takeover is active is a hot switch: the client
   keeps pointing at the local proxy and only the proxy's upstream target
   changes.

[services/proxy.rs#L730-L820](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/proxy.rs#L730-L820),
[services/proxy.rs#L1292-L1323](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/proxy.rs#L1292-L1323),
[services/proxy.rs#L1822-L1865](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/proxy.rs#L1822-L1865),
[provider/mod.rs#L3004-L3054](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/mod.rs#L3004-L3054)

For opencodex this pattern is mostly redundant — opencodex *is* the proxy, so
the client config only ever needs the additive provider entry; there is no
upstream target to hot-switch inside the client.

## 4. Universal endpoint (relay), not a management API

cc-switch embeds an Axum server (default `http://127.0.0.1:15721`) exposing
Claude / OpenAI Responses / Gemini routes plus health and status; tools point
their base URL at it. It is a data-plane relay, **not** a control API — the
toggle operations live in Tauri commands, and the only URL scheme is
`ccswitch://v1/import?...` for config import.
[proxy/server.rs#L100-L145](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/server.rs#L100-L145),
[proxy/server.rs#L291-L366](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/server.rs#L291-L366),
[deeplink/parser.rs#L11-L67](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/deeplink/parser.rs#L11-L67)

Main-agent spot-check: `proxy/server.rs` binds
`config.listen_address:listen_port` via tokio TcpListener (lines 101-145).

## 5. What this means for an opencodex toggle

- The additive per-client writer is the pattern to copy: insert/remove exactly
  one provider entry, preserve everything else, atomic write, health warnings
  on read-back.
- cc-switch's "is it on?" state is *its own DB record* plus a
  `live_config_managed` marker — it does not re-derive state from the client
  file. An opencodex toggle has no such DB; state must be read back from the
  client config itself (does our entry exist, and does it match what we would
  generate now?). This is a real design divergence, explored in 003.
- Its exclusive-app machinery (backfill/overwrite) and proxy-takeover
  snapshot/restore solve problems opencodex does not have; neither needs
  porting.
