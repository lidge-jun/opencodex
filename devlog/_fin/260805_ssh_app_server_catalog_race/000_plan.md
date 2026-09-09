# 260805 — SSH app-server vs. startup catalog write (issue #1046)

Routed Anthropic models were missing from the Codex App model picker on one SSH
remote host (`suji`) while the same app, the same opencodex version, and the same
injected config showed them correctly on another SSH remote host. The proxy was
healthy, the catalog on disk was correct, and `codex exec --model
anthropic/claude-opus-5` answered normally the entire time.

Killing the remote `app-server` fixed the picker. That is the whole bug, and the
interesting part is *why it only bit one of two otherwise identical hosts*.

## The claim this unit has to defend

The failure is a **startup ordering race**, not a configuration defect:

> `ocx start` writes the Codex catalog **after** the proxy is already listening,
> and the Codex App's SSH `app-server` boots independently. Whichever wins,
> nothing reconciles them — and unlike the CLI sync path, the startup path never
> even warns.

Two hosts, same software, opposite outcomes, explained by process start times
alone. That is the evidence this unit rests on (`001`).

## What is NOT the cause

Recorded because the investigation went down this road first and it was wrong:

- **`multiAgentMode` absent from the remote config.** Plausible-looking (the two
  hosts genuinely differed here), but `isEligibleV2SubagentEntry()`
  (`src/codex/catalog/sync.ts:70`) *allows* an absent `multi_agent_version`, and
  the routed entries already carried `visibility: "list"` before that config was
  touched. Setting it changed the catalog bytes without being load-bearing; the
  app-server restart that followed is what actually fixed the picker.
- **The `app-server-control.sock` collision.** The healthy host logged the same
  `control socket is already in use` error and showed every routed model.
- **A stale `models_cache.json` stamp.** `client_version: "0.0.0"` /
  `fetched_at: 2000-01-01` is deliberate — `invalidateCodexModelsCache()`
  (`src/codex/catalog/sync.ts:601`) writes those sentinels on purpose. Both hosts
  carry them.

## Documents

- `001_two_host_comparison.md` — the controlled comparison and the timing evidence.
- `002_startup_vs_sync_asymmetry.md` — why the CLI sync path warns and the
  startup path does not, with the call sites.
