# 260816 — codex-rs multi-agent v2 + history performance: opencodex response

## Objective

Upstream codex-rs shipped two changes that opencodex must answer: multi-agent v2
delegation now targets **every** catalog model that is not explicitly disabled
(Luna included), and the local conversation-history stack was redesigned around
paginated rollouts, ordinals, and a SQLite projection. This unit determines what
opencodex must change, and stages it as dependency-ordered implementation phases.

> **Revision 2 (2026-08-16), after an adversarial A-phase audit.** An independent
> reviewer returned FAIL with 11 blockers against revision 1; all were verified against
> real code and folded in. The substantive corrections: the roster eligibility predicate
> (`sync.ts:105`) was the actual defect and revision 1 left it untouched; the subagent
> fallback chain can silently downgrade a v2 child; G5's stated impact was unreachable
> and is now conditional; three phase dependencies were not real; and the research docs
> carried prescriptive roadmaps that belong here. Details in each decade doc's amendment
> note and in `006_audit_round1.md`.

## Evidence baseline

| Repo | Commit | Verified |
| --- | --- | --- |
| upstream codex-rs (조사 시점) | `9dd22890f5ff47e4af128c20e32b9758a61d78d2` | `git log -1`, 2026-08-12 |
| upstream codex-rs (재검증 후, ff 완료) | `49db349ff` | 2026-08-15, +181 커밋. 두 P0 모두 유효함을 재확인 — `008`/`009` |
| opencodex | `7612e4c4f81544a250c3eea9fe8ca85d8022e765` | `git log -1`, `fix(routing): source capability evidence from explicit catalog provenance (#1799)` |

Research documents (evidence only — no prescriptions; see LEXICO-SPLIT-01):

- `001_upstream_multiagent_v2_evidence.md` — v2 wire surface, catalog contract, tool schemas.
- `002_upstream_history_perf_evidence.md` — rollout format, migration, pagination, proxy-visibility verdict.
- `003_opencodex_subagent_catalog_inventory.md` — current opencodex catalog/subagent surface.
- `004_opencodex_history_responses_inventory.md` — current opencodex rollout/Responses surface.
- `005_public_web_evidence.md` — public claim ledger.
- `006_audit_round1.md` — the A-phase reviewer's blockers and their disposition.

## The two findings that drive this unit

### 1. `multi_agent_version` no longer means "may I be a delegation target"

Before `6d4d9442c` (2026-08-04), a v2 parent could only spawn a model whose catalog
value equalled `v2`. Now `model_supports_multi_agent_backend`
(`codex-rs/core/src/tools/handlers/multi_agents_common.rs:36-42`) admits every model
*except* explicit `Disabled`. The value instead decides whether the **child** gets
collaboration tools: `collab_tools_enabled`
(`codex-rs/core/src/tools/spec_plan.rs:599-610`) gives a child recursive tools only
when its own catalog value is exactly `Some(V2)`.

| Value | Offered to a v2 parent | Child gets collab tools | Meaning |
| --- | --- | --- | --- |
| `"v2"` | yes | yes | recursive delegator |
| `"v1"` | yes | no | **leaf worker** |
| absent/null | yes | no | **leaf worker** |
| `"disabled"` | no | no | ineligible |

opencodex encodes the OLD rule in two places, not one:

1. `isEligibleV2SubagentEntry` (`src/codex/catalog/sync.ts:105-108`) returns true only
   for `v2`/null/undefined — so an explicit `v1` pin like Luna's is **excluded from the
   roster entirely**. This is the load-bearing defect.
2. `applyMultiAgentMode` (`src/codex/catalog/parsing.ts:382-388`) stamps every unpinned
   row `"v2"` when the feature flag is on, claiming every routed third-party model is a
   recursive delegator.

Both must change eventually, but they are **separable and are being done in separate cycles**
(see `011` 3판): the roster predicate alone puts Luna back in the roster, while the stamp fix
must be redesigned around `8a0de6c44`'s explicit-v2 policy. Fixing only the predicate leaves
routed rows over-claiming recursion in `default` mode — that residual is tracked as G1b.

Classification: **silent degradation** — nothing errors; the roster is simply wrong.

### 2. Paginated rollouts reject ordinal-less appended records

`6bb6e9045` + `4bb7ee347` introduce paginated rollouts: each JSONL line carries a
monotonically increasing `ordinal`, `SessionMeta.history_mode` becomes `"paginated"`,
and a SQLite projection materializes turns/items. `read_projection_steps`
(`thread_history_materialization.rs:170-186`) returns a hard `Internal` error for a
paginated line missing an ordinal.

opencodex's `updateSessionMeta` (`src/codex/history-provider.ts:523+`) **always**
appends an ordinal-less `session_meta` line, and every thread SELECT
(`history-provider.ts:589,714,722`) omits `history_mode`. Upstream's equivalent
(`codex-rs/thread-store/src/local/update_thread_metadata.rs:74`) branches on `paginated` and updates only the threads table.

Classification: **compat-break** — corrupts a paginated thread's projection.

### What is explicitly NOT our problem

The "~98% fewer requests" figure is an N+1 elimination in *local SQLite* summary paging
(`332eac4b8`): ~749 queries to ~8 for a 741-turn thread at the 100-turn page cap. It is
not a reduction in `/v1/responses` calls, and `ResponsesApiRequest`
(`codex-rs/codex-api/src/common.rs:252`) is unchanged by the entire history series.

The `27.6s → 1.7s` and 741-turn figures come from an **official OpenAI announcement**
(user-confirmed). They do not appear in any public PR body — `gh api search/issues` returns
`total_count: 0` for both `27.6s` and `"98% fewer"` — so treat them as an internal benchmark
whose *code* is public, not as a fabricated claim. `009_gh_pr_review.md` maps the figures to
the PRs that produced them (#36384 N+1 removal, #32234/#33364 pagination, #36948-36951 TUI
bounded hydration, #38604 resume round-trip removal, #34361 clone avoidance). What remains
opencodex-relevant is unchanged: those requests are local SQLite/app-server calls, not
`/v1/responses` calls.

opencodex is a provider proxy, not Codex's app-server. It must **not** implement
`thread/turns/list`, `thread/items/list`, or `includeTurns`.

## Gap matrix

| # | Gap | Class | Phase |
| --- | --- | --- | --- |
| G1a | Roster predicate `isEligibleV2SubagentEntry` (`sync.ts:105-108`) excludes explicit `v1` pins, dropping Luna | silent-degradation | **C1 (011)** |
| G1b | `default` mode stamps unpinned rows `v2` (`parsing.ts:409+`) — NOT fixed by `8a0de6c44`, which only added an explicit-`v2` branch | silent-degradation | **OPEN** — later cycle |
| G2 | No typed per-model multi-agent capability, and no creation path for one | missed-opportunity | 010 |
| G3 | `updateSessionMeta` appends ordinal-less lines to paginated rollouts | compat-break | 020 |
| G4 | Thread SELECTs omit `history_mode`; bulk updates cannot skip unknown rows | compat-break | 020 |
| G5 | `extractUserMessagePreview` misses canonical `ItemCompleted` records | **conditional** — no reachable consumer found; see 030 gate | 030 |
| G6 | Rollout filename assumed to carry thread id; `4ef836f88` separates them | compat-break (latent) | 030 |
| G7 | `hasAgentsMaxThreads` claims a boot refusal upstream reverted in `1f304dd1f` | stale-guard | 040 |
| G8 | `/v1/responses/compact` full-field forwarding unverified | missed-opportunity | 050 |
| G9 | `structure/03_catalog-and-subagents.md:133-153` documents the superseded rule | docs-drift | 010 |
| **G12** | Quota fallback can rewrite a v2 child to a v1/disabled model, keeping collab tools | **compat-break** | 010 |
| G13 | `collaboration.ts:349` fork-override guidance | **no-action (optional polish)** — upstream's own hint (`config/mod.rs:253`) says forks "do not accept overrides", so our text mirrors it; the implementation honors overrides but the guidance is not wrong | 010 |
| **G14** | `model_messages.multi_agent` (role/mode 지시문)이 카탈로그에서 공급됨 (#38619); opencodex는 `model_messages` 를 `metadata.ts:300-308` 에서 변형하고 `upstream-models.json` 스냅샷으로 공급하는데 이 서브트리를 모름 | missed-opportunity → 잠재 silent-degradation | 060 (신규, 미작성) |
| G10 | Storage cleanup refuses paginated history | no-action (keep refusal) | — |
| G11 | App-server pagination protocol | no-action (out of proxy scope) | — |

G12 and G13 were found by the A-phase reviewer, not by the research swarm.

## Phase map

Ordering follows build order where a real dependency exists. Revision 1 asserted three
dependencies that the reviewer disproved; the corrected map is mostly **parallel**, which
is itself a useful finding — these are independent defects, not a chain.

| Phase | Doc | Outcome | Depends on |
| --- | --- | --- | --- |
| 1 | `010_phase1_catalog_capability_contract.md` | Leaf semantics restored end-to-end: eligibility, stamp, creation path, fallback capability class | — |
| 2 | `020_phase2_history_mode_awareness.md` | Never write ordinal-less records to a paginated rollout | — |
| 3 | `030_phase3_rollout_identity_and_previews.md` | Rollout-id/thread-id separation locked; G5 gated | — |
| 4 | `040_phase4_config_alias_and_docs.md` | `max_threads` alias truth through its full consumer chain | — |
| 5 | `050_phase5_compact_wire_verification.md` | `/v1/responses/compact` field-fidelity regression | — |

Recommended execution order (risk-first, not dependency-forced): 1 → 2 → 4 → 3 → 5.
Phase 1 carries two compat-breaks (G12) and the headline defect; Phase 2 carries the
data-corruption risk. Phases 3 and 5 may both close as NOOP with recorded evidence.

Each phase closes with an independently verifiable gate. Most phases are one PABCD cycle;
**Phase 1 is split into three** because `8a0de6c44` landed mid-roadmap and the encrypted-NEW_TASK
constraint (#92) entangles part of it (see `011_c1_investigation_and_scope.md`):

| Cycle | Covers | Status |
| --- | --- | --- |
| C1 | Roster predicate G1a (`sync.ts:105-108`) + `gpt-daybreak-blue-latest` global allowlist (owner decision) | in progress |
| C2 | G1b — `default`-mode blanket stamp, redesigned on top of `8a0de6c44`'s explicit-v2 policy | open |
| C3 | G2 creation path + G12 fallback capability class (entangled with encrypted-task native-only fallback) | open |

## Environment precondition (applies to every phase)

This worktree has **no `node_modules/`**. Every verifier command therefore exits 1 for an
environmental reason (`Cannot find module 'zod/v4'`; `TS2688: bun-types`). Each phase's B
must run `bun install` first and re-record real exit codes beside its verifier table.
Note `package.json:41` defines `"test": "bun scripts/test.ts"` — use `bun run test` for a
full run, `bun test <file>` for focused iteration.

## Scope boundary

IN, by phase:

- **catalog/capability (010):** `src/codex/catalog/parsing.ts`, `src/codex/catalog/sync.ts`,
  `src/codex/catalog/provider-fetch.ts`, `src/codex/catalog/effort.ts` (the
  `applyCatalogModelMetadata` bridge), `src/codex/subagent-model-fallback.ts`,
  `src/server/responses/core.ts` (both fallback call sites),
  `src/server/responses/collaboration.ts`, `src/server/management/model-rows.ts`,
  `gui/src/pages/models-shared.ts`.
- **history (020/030):** `src/codex/history-provider.ts`, `src/codex/sqlite-columns.ts` (new),
  `src/codex/history-worker.ts`, `src/codex/history-job.ts`, `src/codex/history-transition.ts`,
  `src/codex/history-migration-guardian.ts`, `src/codex/inject.ts`,
  `src/codex/convergence-types.ts` and `src/codex/transition-state.ts` (the durable
  reason vocabulary + its schema migration, Phase 2 Change 6),
  `src/storage/cleanup.ts` (read paths + the `columnExists` re-export).
- **config/docs (040):** `src/codex/features.ts`, `src/cli/v2.ts`,
  `src/server/management/agent-settings-routes.ts` (GET and PUT), `gui/src/pages/Models.tsx`
  and its locale strings.
- **compact (050):** `src/server/responses/compact.ts`, `src/adapters/openai-responses.ts`.
- **docs:** `structure/03_catalog-and-subagents.md`, `structure/05_gui-and-management-api.md`.
- matching `tests/` for each.

OUT: the codex-rs checkout (read-only), app-server protocol reimplementation, **other**
provider adapters (`src/adapters/openai-responses.ts` is explicitly IN for Phase 5's
passthrough regression; no other adapter is), GUI redesign beyond the copy/type changes
listed above, release actions, any `git push`.

## Terminal outcome for this docs cycle

`DONE` when 000-007 plus every decade doc exist at diff-level precision, every audit-round
blocker is folded or explicitly rebutted, and the unit is committed locally. `006` and `007`
are audit history: the decade docs are canonical, and where an amendment corrected an
earlier instruction the canonical text was rewritten rather than appended to.
