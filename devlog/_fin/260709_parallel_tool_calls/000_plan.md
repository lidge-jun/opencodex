# Parallel tool call support (research-grounded)

## Loop-spec
- Archetype: spec-satisfaction (verifier = bun test + tsc, defines done).
- Trigger: user request (HOTL goal, session 019f451c-92f7-7020-9f77-212bf8ae08ed).
- Goal: routed openai-chat providers with proven parallel tool call support (xAI first)
  emit multiple tool calls per turn end-to-end: upstream request no longer forces
  `parallel_tool_calls:false`, the stream parser assembles fragmented/interleaved
  `tool_calls` deltas correctly, and the Codex catalog advertises the capability bit.
- Non-goals: cursor transport (already parallel), anthropic/google/kiro adapters,
  enabling GLM/zai (Z.AI does not document the parameter), gui/docs-site.
  Mistral/OpenRouter also stay out this unit despite official parallel_tool_calls support:
  xai is the only actively-used opted-in provider; widen after a live xai soak (follow-up).
- Verifier: `bun test` (full suite + new tests), `bunx tsc --noEmit`.
- Stop: all criteria met (goalplan c1-c6) or budget (4 work-phases / ~90min).
- Memory artifact: this unit + `.codexclaw/goalplans/enable-parallel-tool-call-support-end-to-end-in/`.
- Terminal outcomes: DONE expected; UNSAFE/NEEDS_HUMAN if scope must widen.
- Escalation: LOOP-REPAIR-01 (2 same-failure repairs -> root-cause; 3 -> replan).
- HOTL bounds: write scope = src/adapters/openai-chat.ts, src/providers/{registry,derive}.ts,
  src/router.ts (capability backfill only), src/codex/catalog.ts, src/types.ts (config field only), tests/*, this devlog unit.
  Subagents: gpt-5.5 only (A/C reviewers). No deploys, no external writes.

## Research base (Tier-3, 2026-07-09, claim ledger in session transcript)
- xAI: parallel officially supported & default-on; streamed tool calls arrive WHOLE in one
  chunk (docs.x.ai function-calling); `parallel_tool_calls:false` documented off-switch.
  Risk: strict 400 when assistant history message lacks a content element (langchain#34140).
- Z.AI/GLM: `parallel_tool_calls` NOT documented; official stream docs require index-keyed
  assembly; ecosystem clients disagree (LiteLLM strips, Roo sends true, opencode omits).
  Keep disabled.
- Ecosystem stream hazards: missing index / all-index-0 / id-only-on-first-chunk /
  name-after-arguments ordering / concatenated args. Parser must key by index+id and
  never cross-contaminate arguments.
- codex-rs: `supports_parallel_tool_calls` -> `Prompt.parallel_tool_calls` -> request bit;
  execution concurrency is per-tool (exec_command opts in). Catalog bit is the client lever.

## Current-state anchors (read 2026-07-09)
- src/adapters/openai-chat.ts:233 `if (tools) body.parallel_tool_calls = false;` (commit 8d9a3f6).
- src/adapters/openai-chat.ts:322-334 parseStream tracks ONE currentToolCallId, ignores `index`.
- src/adapters/openai-chat.ts:79 assistant tool_calls history sets `content = null`; :100 orphan-toolResult synthetic assistant message also `content: null`.
- src/codex/catalog.ts:404 `entry.supports_parallel_tool_calls = isCursorEntry;`.
- src/codex/catalog.ts:687 deriveEntry calls normalizeRoutedCatalogEntry(e) with `model?: CatalogModel` in scope.
- src/codex/catalog.ts:858 applyProviderConfigHints(name, prov, model) builds CatalogModel from provider config.
- src/providers/registry.ts:15 ProviderRegistryEntry; xai entry at :185 (adapter openai-chat).
- src/providers/derive.ts:65 providerConfigSeed copies registry capability fields.
- src/router.ts:80-101 routedProviderConfig backfills registry capability fields into persisted
  user configs; src/server/adapter-resolve.ts:26 feeds it to createOpenAIChatAdapter.
- Bridge contract (src/bridge.ts:469-520): tool_call_start/delta/end are strictly sequential;
  a start closes the previous call, and text_delta/reasoning deltas CLOSE an open tool-call item
  (bridge.ts:394,452). Parser must emit NON-OVERLAPPING, uninterrupted per-call sequences.
- Non-streaming path (openai-chat.ts:381-386) already loops multiple tool_calls: no change.

## Dependency-ordered work-phase map
1. 010 WP1 — stream-parser multi-call assembly (foundation: correctness of ingestion).
2. 020 WP2 — provider opt-in wiring (consumes WP1: only safe once parser is parallel-proof).
3. 030 WP3 — integration verification + SoT sync + final adversarial review (hardening).
