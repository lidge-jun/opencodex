# 260710 Multi-agent injection stabilization — plan (WP1-3)

Session: 019f49f3-c213-7942-8651-f4f2710daf65 (HOTL goal loop, goalplan slug
`stabilize-opencodex-product-surface-docs-after-m`). Subagents: gpt-5.6-sol,
reasoning high (user chat instruction overrides configured xhigh).

## Objective

Harden, surface-align, and document the in-flight multi-agent injection/config
work, then commit atomically. Three work-phases, dependency-ordered.

## In-flight diff (uncommitted, this session's work)

### Cluster 1 — v2-surface prompt injection (src/server/responses.ts, +49)
- `isV1CollabSurface` -> 3-state `collabSurface(parsed): "v1"|"v2"|null`.
  Flat `spawn_agent` = v2; namespaced spawn / send_input / close_agent = v1;
  ambiguous mix = null (never inject on unclear ground).
- `multiAgentGuidanceText`: v1 path unchanged (top-tier Proactive + optional
  injectionModel/effort). NEW v2 path: fires ONLY with injectionModel set;
  injects model designation + fork_turns="none"/partial-fork mandate +
  self-contained-message rule + optional reasoning_effort. No Proactive text
  duplication (codex-rs emits its own on v2).
- Behavior rule from user: base mode -> only sol/terra carry the v2 surface;
  forced v2 mode -> all models. Surface detection per-request makes this hold
  without a mode check.

### Cluster 2 — hide_spawn_agent_metadata always persisted (src/codex/features.ts +82, src/codex/sync.ts +9)
- `ensureHideSpawnAgentMetadata()`: writes `hide_spawn_agent_metadata = false`
  into `[features.multi_agent_v2]`; handles table/inline/boolean TOML forms;
  respects explicit user `true`; appends bare table when absent (verified
  upstream: bare table does NOT enable the feature — enabled is Option<bool>,
  features/src/feature_configs.rs).
- Hooked into `syncModelsToCodex` so every sync/start/mode-flip guarantees it.
- Live-verified: real ~/.codex/config.toml got the table; `codex features list`
  still shows multi_agent_v2=false.

### Cluster 3 — Anthropic dated-alias retention + warn dedupe (src/codex/catalog.ts +42)
- `isDatedVariantId(liveId, configuredId)`: `<alias>-YYYYMMDD` matcher.
- Live-discovery drop loop keeps configured aliases whose dated variant is in
  the live list (clones the dated entry under the alias id, reapplies config
  hints so alias-keyed contextWindow overrides win). Genuinely-missing ids
  still drop.
- `warnDroppedConfiguredIdsOnce`: per-provider signature dedupe kills the
  4x-repeated warn spam observed in `ocx start`.
- Live-verified: claude-haiku-4-5 back in the routed catalog.

### Tests (+129 lines across 3 files)
- tests/multi-agent-compat.test.ts: 4 new v2-surface cases (designation,
  effort, silence without model, ambiguous-mix veto).
- tests/codex-v2-gate.test.ts: 5 new ensureHideSpawnAgentMetadata cases
  (table/idempotent/inline/boolean-rewrite/bare-append).
- tests/codex-catalog.test.ts: dated-alias retention + isDatedVariantId.
- Full suite: 1924+ pass, tsc clean (pre-review baseline).

## Gap list (candidates for A-review challenge)

G1. management-api PUT /api/injection-model does not resync or ensure the
    hide flag; a user setting injectionModel via GUI on a v2 thread may still
    have `model` hidden until next sync. (Mitigated by sync-on-start; verify.)
G2. `ocx v2 status` does not report hide_spawn_agent_metadata state.
G3. v2 injection text asserts "Model overrides are rejected on a full-history
    fork" — verify wording stays true for agent_type/service_tier too (spec
    says service_tier is NOT fork-gated).
G4. features.ts boolean->inline rewrite: interaction with `codex features
    disable multi_agent_v2` afterwards (upstream edits its own format).
G5. isDatedVariantId: no upper bound on date sanity (fine) — but check alias
    entries do not double-count in /v1/models or picker dedupe paths.
G6. Warn dedupe map never clears on provider config change (acceptable? warn
    reappears only when id set changes — by design).

## Work-phase map (dependency-ordered)

- WP1 core hardening: A-audit the diff (sol high reviewer), fold High
  blockers, full gates, atomic commits. OUT: .github/workflows/*,
  tests/ci-workflows.test.ts (foreign in-flight edits).
- WP2 product surface consistency: scan cli/v2.ts status output,
  management-api injection endpoints, GUI labels for claims invalidated by
  the new behavior; fix or NOOP with evidence.
- WP3 docs: sol-high worker subagent, disjoint write scope docs/ +
  docs-site/src; document injection modes (base=sol/terra, forced=all),
  injectionModel/effort, hide auto-persist, fork_turns rule, dated-alias fix;
  astro build gate; commit.

## Accept criteria

Mirrors goalplan c1-c6 (reviewer verdict folded; gates fresh; commits atomic;
surface text truthful; docs sections present; astro build exit 0).
