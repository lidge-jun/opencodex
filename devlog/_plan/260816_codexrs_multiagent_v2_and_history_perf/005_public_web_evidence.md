# Lane E — public web evidence and upstream-to-OpenCodex roadmap

Research cutoff: 2026-08-16 (Asia/Seoul). The two checkouts were inspected read-only.

## Executive finding

The public evidence verifies the GPT-5.6 family, `ultra`/multi-agent delegation, and
the official Daybreak Blue alias mapping. It does **not** verify the reported
`741`-turn / `27.6s -> 1.7s` / `~98% fewer requests` figures: no primary web page,
official changelog entry, or upstream commit message containing those exact figures
was found. Treat those numbers as **UNVERIFIED** pending an internal benchmark or
the missing upstream announcement.

The upstream checkout itself contains the implementation evidence needed for the
roadmap. Its HEAD is `9dd22890f5ff47e4af128c20e32b9758a61d78d2`.

## Public claim ledger

| Claim | URL | Publication date | Source type | Status |
|---|---|---:|---|---|
| GPT-5.6 launches Sol, Terra, and Luna for general availability; `ultra` coordinates multiple agents across parallel workstreams. | [OpenAI GPT-5.6 release](https://openai.com/index/gpt-5-6/) | 2026-07-09; page also records a 2026-07-30 pricing update | primary, official OpenAI release | verified |
| The official API model guidance maps `gpt-5.6` to `gpt-5.6-sol`, and names Terra for balance and Luna for efficient high-volume work. | [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) | Not stated on page; retrieved 2026-08-16 | primary, official developer docs | verified |
| The same guidance documents multi-agent beta in Responses API: a GPT-5.6 instance coordinates parallel subagents and synthesizes results. | [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) | Not stated on page; retrieved 2026-08-16 | primary, official developer docs | verified |
| The same guidance documents persisted reasoning across turns and recommends `previous_response_id`/history replay when using `all_turns`. | [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) | Not stated on page; retrieved 2026-08-16 | primary, official developer docs | verified |
| Daybreak Blue API alias `gpt-daybreak-blue` maps to model ID `gpt-5.6-sol`; Red maps to `gpt-5.6-cyber`. | [OpenAI Help: Enterprise Daybreak onboarding](https://help.openai.com/en/articles/20001261-enterprise-daybreak-onboarding) | Updated 3 days before retrieval; exact calendar date not rendered | primary, official Help Center | verified |
| OpenAI’s Daybreak page reports GPT-5.6 Sol completing 7/10 of a 32-step simulation versus 2/10 for GPT-5.5. | [OpenAI Daybreak](https://openai.com/daybreak/) | Page lists latest Daybreak item 2026-08-10; claim page date not separately rendered | primary, official OpenAI product page | verified |
| Codex GitHub releases show August 2026 prereleases, including `0.148.0-alpha.14` on Aug 14 and `0.148.0-alpha.17` on Aug 14. | [openai/codex releases](https://github.com/openai/codex/releases) | 2026-08-14 | primary, official repository release page | verified |
| Upstream issue reports a catalog-visible `gpt-5.6-luna` rejected by the native `spawn_agent` allowlist while Sol/Terra worked. | [openai/codex#34399](https://github.com/openai/codex/issues/34399) | Opened 2026-07-20; now closed | primary, official repository issue | verified as historical issue evidence, not a current support guarantee |
| Upstream issue reports a later Agent V2 behavioral regression where repeated Sol delegation emitted `exec`/`wait` instead of `spawn_agent`. | [openai/codex#35620](https://github.com/openai/codex/issues/35620) | Opened 2026-07-27; still open at retrieval | primary, official repository issue | verified as reported behavior; root cause unverified |
| The exact `741` turns, `27.6s -> 1.7s`, `~98% fewer requests`, and memory-use claims are publicly documented. | [Google/web search result set](https://github.com/openai/codex) | N/A | No primary source found | **candidate — unverified snippet / empty primary result** |

Search coverage: 26 distinct queries across OpenAI developer docs, Help Center,
OpenAI product/release pages, GitHub releases/issues/source, and secondary coverage;
the exact performance-number searches returned no primary source.

## Upstream implementation evidence

All paths below are relative to `/Users/jun/Developer/codex/121_openai-codex` and
line numbers are from the inspected HEAD `9dd22890f`.

### Delegation to leaf and supported models

- `6d4d9442c7142c08ac5c5098dfd6e82d8cd9f65a` (2026-08-04, “Support leaf models in multi-agent v2”) changes `codex-rs/core/src/tools/handlers/multi_agents_common.rs:model_supports_multi_agent_backend` (line 36) so V2 accepts every model except one explicitly marked `Disabled`. The same commit changes `codex-rs/core/src/agent/control/spawn.rs:AgentControl` (stored model restoration around lines 268–324), preserving the selected worker model on reload.
- `92938d880eccbad1242a86a63f819f67780f68c0` (2026-07-13) adds backend-aware filtering and validation in `codex-rs/core/src/tools/handlers/multi_agents_common.rs:find_spawn_agent_model_name` (line 431) and `model_supports_multi_agent_backend` (line 36), plus `codex-rs/core/src/tools/handlers/multi_agents_spec.rs:spawn_agent_models_description` (line 781). The advertised override list is picker-visible and backend-compatible, capped at five.
- `ea1545628404e448347bae336771eaf649614105` (2026-07-13) exposes optional `model` and `reasoning_effort` controls in `codex-rs/core/src/tools/handlers/multi_agents_spec.rs:create_spawn_agent_tool_v2` (line 102), guarded by `SpawnAgentToolOptions` (line 26).
- `b00c9b2e16ccdbf2c7c8d58a590e0fc2ca97573b` (2026-07-20) marks Multi-Agent V2 stable in the feature configuration. `6d4d9442c` is the important “all visible models unless disabled” semantic change; it is not a hard-coded Sol/Terra/Luna list.
- `51e36d2ec23c0eff710053d28c400d447500a41a` (2026-08-07) exposes nullable `multiAgentVersion` (`disabled`, `v1`, `v2`) through `codex-rs/app-server/src/models.rs:model_from_preset` (line 27), sourced from `codex-rs/protocol/src/openai_models.rs:ModelPreset` (line 206).

### Conversation-history loading and request reduction

- `161748a68eb4a4aba5420c3a6f1739f098513178` (2026-07-17) adds `codex-rs/message-history/src/batch.rs:lookup_batch` (line 111): cursor-based newest-first reads, max 128 rows/64 KiB, byte anchors for unchanged append-only files, and safe offset fallback after rewrites.
- `8bfa49e350edb065889332c72854d06f0e7ce50f` (2026-08-04) adds `codex-rs/tui/src/app/history_pagination.rs:App::handle_older_history_page` (line 57) and bounded initial hydration in `codex-rs/tui/src/app_server_session/history.rs:AppServerSession::hydrate_initial_thread_history` (line 198). The initial view loads a bounded page; older pages load as the user navigates upward.
- `3b8d22ec2c75bf8fcd6048c34039344795ff7a0a` (2026-08-04) hardens `codex-rs/tui/src/app_server_session/history.rs:thread_items_page` (line 116), `merge_thread_item_page` (line 154), cursor-repeat protection (`advancing_cursor`, line 51), and initial-vs-complete hydration. This is the closest code-level explanation for fewer history-load requests, but the exact 98%/27.6s/1.7s benchmark is **UNVERIFIED**.
- `7ed19a97580e65a55feed9074f21decb2d720e9b` (2026-07-17) batches persistent history reads during reverse search; `codex-rs/message-history/src/batch.rs` is the reusable primitive.
- `63002bdb26c939925f3fa59b9575cc0a3564cb45` (2026-08-10) extracts persisted history types into `codex-rs/history/src/lib.rs`, separating history contracts from protocol/runtime consumers.


---

Evidence only (LEXICO-SPLIT-01). The prescriptive roadmap that once ended this file
lives in [000_plan.md](000_plan.md) and the decade docs.
