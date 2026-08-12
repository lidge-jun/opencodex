# 001 — Issue triage (49 open at the 2026-08-06T13:49Z cutoff)

Two sol-medium lanes classified every open issue against the working tree.
Rule applied: a reporter's claim is not evidence — each verdict cites the code
path that proves or refutes it. Snapshot: `.snapshot_issues.json`.

## Classification key

| Class | Meaning |
|-------|---------|
| `FIXABLE` | Real defect with a bounded fix; enters the stack |
| `LARGE` | Real defect, but program-scale; deferred with reason |
| `UPSTREAM` | Not fixable in this repository |
| `NEEDS_INFO` | Cannot be confirmed on the current tree |
| `FEATURE` | Enhancement, not a bug |

## In-scope defects (enter the stack)

| # | Reporter | Class | Proof on the current tree | Phase |
|---|----------|-------|---------------------------|-------|
| 1112 | lidge-jun | FIXABLE | `trackSseForRequestLog` (`src/server/relay.ts:353`) appends into `buffer` inside `inspectChunk` at `:382` with no cap and re-parses each payload through three string helpers; `relaySseWithHeartbeat` (`:498`) repeats the same unbounded append at `:540` | 010 |
| 1120 | MarcusNeufeldt | FIXABLE | `runOwnedStageSweep` (`src/codex/native-profile-startup.ts:131`) always calls `entry.manager.sweepStages()`, and `sweepStages` (`src/codex/native-profile-manager.ts:916`) enters the locked path (`sweepStagesLocked`, `:828`) even with zero artifacts | 020 |
| 1117 | giulioleone097 | FIXABLE | `applyFinalRouteRequestNormalization` (`src/server/responses/core.ts:856`, called at `:1532`) overwrites `parsed.modelId` with the bare upstream id; the image loop then emits that value (`src/images/loop.ts:903`), as do the JSON/streaming and web-search paths | 050 |
| 1110 | Simon-Opopeee | FIXABLE | The `github-copilot` entry (`src/providers/registry.ts:2043`) declares `adapter: "openai-chat"` at `:2046`; Responses is forced per model by `modelWireDefaults` at `:2060-2067`. Those responses reach the Responses relay, which composes only generic image/id/snapshot repairs — no Copilot-specific normalization exists | 060 |
| 1127 | 0xWinner98 | FIXABLE | `selectEagerPath` (`src/lib/bun-stream-caps.ts:99`) returns null whenever `needsClientRewrite` is set (`:106`), and its Darwin tail admits only `config-eager` (`:112`); inline payload rewrite and budget remain Win32-only in `core.ts` | 070 |
| 1017 | Vincent-HD | FIXABLE | Codex's freeform custom tool is exposed as a single-string `input` parameter (`src/responses/parser.ts:167-173`); the Cursor adapter emits normalized arguments with no structured-edit conversion (`src/adapters/cursor/protobuf-events.ts`, tool-call emission path) | 110 |
| 241 | Lingchen97 | UPSTREAM (docs) | Routed rows are emitted with `visibility = "list"` (`src/codex/catalog/sync.ts:240`); the Desktop allowlist is outside this repo. Documented workaround only | 150 |

## Real but program-scale (deferred, reason recorded)

| # | Reporter | Why deferred |
|---|----------|--------------|
| 1102 | comfuture | Non-loopback requires credentials (`src/server/auth-cors.ts:211`) and Responses accepts only the dedicated header (`auth-cors.ts:369`); token inheritance exists only when the shim is the parent (`src/codex/shim.ts:381`). Transparent hand-off to a directly spawned binary needs a new trust/admission design |
| 1059 | lidge-jun | Windows suite failures cross temp-write, ACL, replacement, journal, catalog, and coordinator paths (`src/config.ts:198-219`, `src/codex/internal/catalog-writer.ts:47`). Run 31095755263 failed all four shards. No subset can be honestly proven fixed from macOS — injected I/O tests cannot establish Windows ACL inheritance, replacement semantics, or real cross-process SQLite locking |
| 1049 | lidge-jun | Pre-substrate homes are classified `legacy-uncoordinated` (`src/codex/inject-coordination.ts:24`) and bypass the lock (`src/codex/inject.ts:870`). Crash-safe adoption is migration-grade work needing its own recovery matrix |

## Upstream-owned (no repo-side fix exists)

| # | Reporter | Evidence |
|---|----------|----------|
| 92 | webmastertorch | The proxy recognizes valid Fernet task content but holds no key (`src/server/responses/encrypted-payload.ts:204`) and now rejects routed delivery cleanly (`src/server/responses/core.ts:1507`). Plaintext must be retained upstream — openai/codex#33551 |
| 417 | lidge-jun | The relay forwards bytes without decode/re-encode (`src/server/index.ts:305`); the Korean/1.3 MB regression is an ancestor of HEAD. Upstream openai/codex#35161 |
| 1100 | c3right | OpenCodex advertises effort levels but strips inherited summary capability conservatively (`src/codex/catalog/parsing.ts:341`); explicit per-model opt-in works (`src/codex/catalog/effort.ts:139`). Codex gates its whole reasoning object on the summary flag before ingress |

## Needs reproduction (cannot be confirmed on the current tree)

| # | Reporter | What is missing |
|---|----------|-----------------|
| 1128 | c040340 | The asserted missing policy is not borne out: DeepSeek disables upstream SSE (`src/providers/registry.ts:1310`), `core.ts:874` applies it, and routed `/responses/compact` re-enters `handleResponses` (`src/server/responses/compact.ts:553`) |
| 1024 | brunoflma | NVIDIA Nemotron is text-only by classification (`src/providers/registry.ts:658`); MiMo is excluded because the measured endpoint accepts images (`registry.ts:363`). The remaining custom route needs its provider config |
| 994 | hamzasoussi53 | The suspected zen DeepSeek path is fixed with coverage (`src/providers/registry.ts:1967`, `tests/opencode-zen-deepseek-reasoning.test.ts:55`), but the report never identifies provider/model |
| 904 | lidge-jun | Relay paths are byte-clean (`src/server/index.ts:305`); needs a failing client/provider capture |
| 796 | hooliy-01 | Ark hosts receive the structured placeholder (`src/adapters/openai-chat.ts:546`), but no live Ark endpoint verifies acceptance (`tests/volcengine-ark-assistant-content.test.ts:16`) |
| 418 | brunoflma | The latest trace completed on an inherited native model because `model` was omitted; it did not reproduce the original custom-parent→custom-child failure |

## Features / roadmap (out of scope for a bug campaign)

`#1125`, `#1107`, `#1091`, `#1086`, `#1082`, `#1076`, `#1073`, `#1062`, `#1060`,
`#1058`, `#1048`, `#974`, `#823`, `#822`, `#821`, `#820`, `#809`, `#755`, `#695`,
`#657`, `#572`, `#561`, `#540`, `#415`, `#414`, `#386`, `#201`, `#178`, `#177`,
`#95`.

Spot-checked rather than assumed: `#1086` (tri-state `fastMode` already applied
at `src/server/responses/core.ts:903`; only the per-model map is missing),
`#1073` (runtime already resolves `modelContextWindows[id]` then provider
`contextWindow` at `src/codex/catalog/provider-fetch.ts:528`), `#809` (every
`/api/*` route is management-authenticated at `src/server/index.ts:676`, so a
data-plane catalog route is a new security-sensitive API), and `#1048` (reduced
scope already merged in #1106).

## Coverage

7 issues enter the stack, 3 are real-but-large, 3 upstream, 6 need
reproduction, 30 are features/roadmap. Total 49 — every open issue accounted
for.
