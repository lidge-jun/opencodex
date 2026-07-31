# 260710 — Hard reasoning-effort caps (effortCap / subagentEffortCap)

## Decision (user request, 260710)

Prompt-side effort designation (`injectionEffort`, devlog/260710_injection_effort) is
advisory: it asks the parent model to pass `reasoning_effort` to spawn_agent. Live
traffic showed the failure mode — a sol thread running at the config default
(`model_reasoning_effort = "ultra"`, wire `max`) leaks max-tier children whenever the
parent spawns WITHOUT explicit args. Add proxy-side enforcement: hard caps that rewrite
the effort of proxied turns at the request choke point.

## Why prompting cannot be trusted (codex-rs @ 6138909d, 260710)

- Bare spawn (no model/effort args): child inherits the PARENT turn's effective effort
  (`core/src/tools/handlers/multi_agents_common.rs:177-190`) — an ultra-default session
  spawns ultra children.
- Full-history forks (`fork_turns` omitted or "all") hard-reject model/effort overrides
  (`multi_agents_v2/spawn.rs:67-85`); a retrying parent may simply drop the args.
- A non-empty agent-role file rebuilds the child Config from persisted layers AFTER the
  spawn args were applied, silently restoring config.toml's model/effort
  (`core/src/agent/role.rs:132-153`, `201-213`).

## Mechanism

Two `OcxConfig` fields, both Codex-ladder values, both "only lower, never raise":

- `effortCap` — global ceiling for EVERY proxied turn (main + sub-agents). Ultra/max
  arrivals are indistinguishable (codex-rs converts ultra -> max client-side), so this is
  a max-tier cap, not an ultra-only knob.
- `subagentEffortCap` — ceiling for sub-agent turns only. Classification uses codex-rs's
  own spawned-child markers: `x-openai-subagent: collab_spawn` header, or
  `subagent_kind` inside the JSON `x-codex-turn-metadata` header
  (`core/src/responses_metadata.rs:210-337`). Lower of both caps wins for sub-agents.

`applyEffortCap` runs in `handleResponses` after multi-agent guidance injection and
BEFORE the mock-max clamp, rewriting BOTH request shapes (`parsed.options.reasoning` +
`_rawBody.reasoning.effort` — same dual-write contract as `nativeEffortClamp`), so the
cap covers the ChatGPT passthrough and every routed adapter centrally. The WS bridge
rebuilds internal requests from the FORWARD_HEADERS allowlist; `x-openai-subagent` was
added to it (turn metadata was already forwarded).

Request log surfaces applied caps as `requestedEffort: "max->high"`, mirroring the
native clamp annotation. `ocx debug injection on` logs each application.

## API

`GET /api/effort-caps` -> `{ effortCap, subagentEffortCap, efforts }`.
`PUT /api/effort-caps` — per-key semantics: absent -> unchanged; null/"" -> clear;
ladder value -> set; anything else -> 400 (mirrors /api/injection-model).

## Files touched

- `src/server/effort-policy.ts` — NEW: `isSubagentRequest`, `effortCapFor`, `applyEffortCap`.
- `src/reasoning-effort.ts` — exported `codexEffortRank()`.
- `src/types.ts` — `OcxConfig.effortCap?`, `OcxConfig.subagentEffortCap?`.
- `src/server/responses.ts` — cap application in `handleResponses` (before mock-max clamp).
- `src/adapters/openai-responses.ts` — `x-openai-subagent` added to FORWARD_HEADERS.
- `src/server/management-api.ts` — GET/PUT `/api/effort-caps`.
- `tests/effort-policy.test.ts` — NEW: 13 tests (classifier, cap resolution, dual rewrite, API roundtrip).

## Verification (260710)

- `bun test` — 2031 pass, 0 fail (199 files; +13 = exactly the new tests).
- `bunx tsc --noEmit` — clean (exit 0).
- Forensics backing the design: proxy request log showed spawn args honored when
  explicitly passed (sol/opus children at low/medium as instructed, 22:13-22:15 KST) and
  max-tier leakage from a bare-spawning ultra-default parent (22:06-22:07 KST).

Live note: the running proxy predates this change; caps take effect after the next
`ocx restart` on a build containing this commit. GUI selectors for the two caps are a
follow-up (Dashboard delegation panel, same pattern as injectionEffort).

## Follow-ups

- DONE (WP1, 010_ladder_hardening.md): ladder-aware cap resolution — snap-down,
  cap-unfulfillable strip, no-effort-model strip; `supportedLadderFor` with the
  raw-vs-sanitized distinction and the forward-identity catalog gate. 4-round sol
  audit loop (3x FAIL folded, then PASS); bun test 2049 pass / tsc clean at close.
- DONE (WP2, 020_exposure.md): Dashboard effort-caps panel + i18n (en/ko/zh/de) and
  docs-site configuration reference rows (en/ko/zh-cn). gui build exit 0; full suite
  2052 pass / 0 fail at close.
- Remaining: live capture asserting the `x-openai-subagent` header on real Codex
  Desktop child traffic after the next release restart (source-backed at codex-rs
  6138909d; belt exists via x-codex-turn-metadata).
