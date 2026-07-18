# Non-OpenAI provider chase roadmap

> Date: 2026-07-17
> Unit: `devlog/_plan/260717_non_openai_provider_chase/`
> Mode: HITL multi-cycle, docs-first Phase 0
> Class: C3 overall; auth/signing phases are promoted to C4

## Loop spec

- Archetype: spec-satisfaction repair and provider-contract integration.
- Trigger: OpenAI hardening is separately planned; the remaining provider chase needs one durable, dependency-aware execution map.
- Goal: plan every approved non-OpenAI chase item as one independently verifiable PABCD work-phase.
- Non-goals: OpenAI changes, further xAI work, production code changes in this Phase-0 cycle, release, deploy, and push.
- Verifier: each decade document must name real files, before/after behavior, activation scenarios, focused commands, and terminal outcomes; an independent A reviewer must verify the map against the current tree.
- Stop condition: this docs-only cycle ends when all decade docs exist, the chase source-of-truth is synchronized, the goalplan is registered, and the independent audit passes. Later implementation stops only when every work-phase and criterion is closed with fresh evidence.
- Memory artifact: this folder, `.codexclaw/goalplans/opencodex-openai-xai-provider-chase-durable-docs/goalplan.json`, and its ledger.
- Terminal outcomes: `DONE`, `NOOP`, `BLOCKED`, `UNSAFE`, `NEEDS_HUMAN`; `BUDGET_EXHAUSTED` is unavailable until a later HOTL phase states a real bound.
- Escalation: the main session reclaims a slice after two failed delegated packets; any future delegation is registered during that work-phase's P, never improvised during B.

## Direction locked by the user

- xAI is out of this chase. The current tree already owns OAuth, live discovery, 401 replay, reasoning replay, and direct xAI transport.
- Standalone Sakana Fugu is no longer rejected. Sakana now publishes a direct Bearer-key API at `https://api.sakana.ai/v1`, with Responses and Chat Completions support.
- Fugu/Sakana is the first implementation work-phase.
- Consumer-backed metadata remains in scope because it has an explicit catalog/runtime consumer boundary.

## Scope boundary

### In

- Sakana Fugu/Fugu Ultra direct provider.
- Cursor shared client-version ownership.
- Antigravity replay hardening and picker/alias separation.
- OpenCode Go Kimi effort probing and policy.
- Z.AI weekly-limit terminal classification.
- Anthropic indexed stream/tool replay hardening.
- Consumer-backed model metadata contracts.
- DeepInfra, Cohere, AI21, Databricks, Bedrock Mantle, first-class Vertex ADC/OAuth UX, and native Bedrock Runtime.
- Final catalog, provider-management, docs, and runtime smoke closure.

### Out

- OpenAI provider tiers and API model aliases.
- xAI behavior changes.
- Provider pricing UI, model-hub UX, role-model selection, or agent prompt policies.
- Remote push, release, or deployment without a later explicit user instruction.

## Dependency-ordered work-phase map

Independent units at the same architectural depth are ordered from lower integration cost to higher cost. This is not an effort-bucket split: registry-only providers precede workspace/auth/signing providers because the latter reuse catalog and provider-management contracts proved earlier.

| WP | Document | Outcome | Dependency |
|---|---|---|---|
| WP0 | this roadmap plus `001`/`002` and all decade docs | lock the execution map | current tree and official contracts |
| WP1 | [010_fugu_sakana_direct.md](./010_fugu_sakana_direct.md) | direct Sakana provider | existing keyed Responses adapter |
| WP2 | [020_cursor_client_version_owner.md](./020_cursor_client_version_owner.md) | one version owner and live proof | existing Cursor discovery/run paths |
| WP3 | [030_antigravity_replay_alias.md](./030_antigravity_replay_alias.md) | indexed replay and picker/alias split | existing Google adapter and replay cache |
| WP4 | [040_kimi_effort_matrix.md](./040_kimi_effort_matrix.md) | evidence-backed Kimi effort policy | existing OpenAI-chat effort mapping |
| WP5 | [050_zai_weekly_limit.md](./050_zai_weekly_limit.md) | terminal weekly-quota classification | generic error and key-failover behavior |
| WP6 | [060_anthropic_stream_replay.md](./060_anthropic_stream_replay.md) | per-index block/tool parser | existing Anthropic adapter and bridge |
| WP7 | [070_metadata_consumers.md](./070_metadata_consumers.md) | explicit metadata consumers and precedence | stable provider/catalog behavior from WP1-WP6 |
| WP8 | [080_deepinfra_provider.md](./080_deepinfra_provider.md) | DeepInfra preset | registry and catalog contracts |
| WP9 | [090_cohere_provider.md](./090_cohere_provider.md) | Cohere compatibility preset | registry and OpenAI-chat adapter |
| WP10 | [100_ai21_provider.md](./100_ai21_provider.md) | AI21 Jamba preset | registry and OpenAI-chat adapter |
| WP11 | [110_databricks_provider.md](./110_databricks_provider.md) | workspace-bound Databricks preset | base-URL override and provider UX |
| WP12 | [120_bedrock_mantle.md](./120_bedrock_mantle.md) | OpenAI-compatible Bedrock Mantle lane | keyed Responses provider contract |
| WP13 | [130_vertex_adc_oauth.md](./130_vertex_adc_oauth.md) | first-class existing ADC/OAuth flow | existing GCP token resolver and provider UX |
| WP14 | [140_bedrock_runtime_sigv4.md](./140_bedrock_runtime_sigv4.md) | native ConverseStream/SigV4 lane | C4 auth boundary and event adapter |
| WP15 | [150_integration_closeout.md](./150_integration_closeout.md) | cross-provider closure | WP1-WP14 complete or explicitly terminal |

One work-phase consumes exactly one decade document and runs one full P→A→B→C→D cycle. A phase may end `NOOP` when its stated probe proves the current implementation already satisfies the contract; that is not permission to skip the cycle.

## Cross-cutting invariants

- Registry is the preset source of truth: `src/providers/registry.ts` → `src/providers/derive.ts` → CLI/management GUI.
- No credential, token response body, signing material, or workspace URL query is logged.
- Provider-specific retry or quota policy requires a provider-specific fixture; no generic phrase expansion from one vendor.
- Live discovery wins over static model seeds. Static rows are logged-out fallbacks only.
- Inbound aliases survive picker retirement unless a separate migration/deprecation contract exists.
- Generated metadata cannot raise an explicit registry/config cap and cannot create a runtime behavior without a named consumer.
- New public provider rows receive registry parity, route, payload, error, and at least one stream/tool fixture before completion.
- C4 phases cannot begin unattended without explicit credential/write/time bounds.

## Phase-0 completion log

- P: current source owners, chase docs, tests, and primary provider documentation inspected; complete `010`–`150` map and durable goalplan registered.
- A: independent explorer reviewed every scoped file and primary contract. Three blocker rounds fixed fuzzy paths, a phantom owner, and a masked metadata-diff check. Final verdict: `PASS` with no remaining blocker.
- B: all 18 roadmap documents and five chase source-of-truth files finalized; no production source or test implementation changed.
- C: fresh checker confirmed 18 numbered docs, 16 goalplan work-phases, 16 criteria, and zero missing prefixes, links, `MODIFY` paths, required sections, WP mappings, or removed-card terms. `git diff --check HEAD^ HEAD` passed and commit `a8c80cb1` was the clean tracked state.
- D: docs-only cycle closed to `IDLE` with outcome `DONE`. No provider implementation or live credential smoke was claimed. WP1 (`010` Sakana direct) is selected as the next HITL unit but has not entered P.

## Phase-0 pessimist record

- Not improved yet: no runtime provider behavior changed; WP1-WP15 remain unimplemented by design.
- Dead hypothesis: direct Amazon Bedrock necessarily starts with a bespoke SigV4 adapter. Current AWS docs establish a lower-cost Mantle Responses lane and Bearer API keys, so native Runtime is conditional on a named Mantle gap.
- Direction would be wrong if Sakana withdraws its direct Responses contract, live probes contradict a phase's static assumptions, or a provider-specific fixture cannot reproduce the planned branch. The owning work-phase must then end `NOOP`, `BLOCKED`, or `NEEDS_HUMAN` instead of forcing the patch.
