# Phase 1 — catalog multi-agent capability contract

Closes G1, G2, G9, G12, G13 — **but NOT all in one cycle.** See `011_c1_investigation_and_scope.md`
(3판): the first implementation cycle (C1) is a **roster + daybreak-catalog** cycle covering only
the roster predicate (`sync.ts:105-108`) and the global-allowlist addition. G1's default-mode
blanket stamp, G2's creation path, and G12's fallback capability class remain **OPEN** and are
scheduled as separate cycles, because `8a0de6c44` redefined the explicit-v2 branch and the
encrypted-NEW_TASK constraint (#92) entangles the fallback work.

One PABCD cycle per listed change-group. Independent of every other phase.

Audit history: `006_audit_round1.md`, `007_audit_round2.md`. This document is canonical —
all audit corrections are integrated below, not appended.

## Why

`6d4d9442c` changed `multi_agent_version` from an eligibility gate into a **child
capability declaration**. Verified at upstream HEAD `9dd22890f`:

- `codex-rs/core/src/tools/handlers/multi_agents_common.rs:36-42` —
  `model_supports_multi_agent_backend` returns true unless the model's value is
  `Some(Disabled)`. Eligibility no longer requires `v2`.
- `codex-rs/core/src/tools/spec_plan.rs:599-610` — `collab_tools_enabled` grants a
  **child** (`session_source.get_agent_path().is_some()`) collaboration tools only when
  its own catalog value is exactly `Some(MultiAgentVersion::V2)`.
- `codex-rs/models-manager/models.json` — sol/terra `"v2"` (lines 21, 136), luna `"v1"`
  (line 249), gpt-5.5 and others `null` (lines 358, 465, 570, 670, 767).

| Value | Offered to a v2 parent | Child gets collab tools | Meaning |
| --- | --- | --- | --- |
| `"v2"` | yes | yes | recursive delegator |
| `"v1"` | yes | no | **leaf worker** |
| absent/null | yes | no | **leaf worker** |
| `"disabled"` | no | no | ineligible |

## Current state (verified this session)

| Location | Fact |
| --- | --- |
| `src/codex/catalog/sync.ts:105-108` | `isEligibleV2SubagentEntry` true for `v2`/null/undefined — **excludes `v1`**, so Luna is excluded |
| `src/codex/catalog/sync.ts:157` | roster filter uses that predicate |
| `src/codex/catalog/sync.ts:190-193` | exclusion reasons reuse it (`surface_incompatible`) |
| `src/codex/catalog/parsing.ts:382-388` | `default` mode + v2 feature stamps unpinned rows `"v2"` |
| `src/codex/catalog/sync.ts:627` | `applyMultiAgentMode` call in `buildCatalogEntries` |
| `src/codex/catalog/sync.ts:1087` | `applyMultiAgentMode` call in the merge/sync path |
| `src/codex/catalog/provider-fetch.ts:999` | `catalogHintsFromModelsApiItem` does not read `multi_agent_version` |
| `src/codex/catalog/effort.ts:113` | `applyCatalogModelMetadata` — the RawEntry stamping seam, called from `sync.ts:322` |
| `src/server/management/model-rows.ts:67` | native management rows built field-by-field |
| `gui/src/pages/models-shared.ts:28` | GUI model type omits the field |
| `src/codex/subagent-model-fallback.ts:269` | `selectAvailableSubagentModel` — quota/health only |
| `src/codex/subagent-model-fallback.ts:510` | `applySubagentModelFallback` |
| `src/server/responses/core.ts:1768`, `:1856` | **both** fallback call sites |
| `src/server/responses/collaboration.ts:349` | fork-override guidance text |

## Change 1 — eligibility follows upstream (`src/codex/catalog/sync.ts:105-108`)

```ts
export function isEligibleV2SubagentEntry(entry: RawEntry): boolean {
  // Since 6d4d9442c a v2 parent may spawn ANY model except explicit "disabled"
  // (multi_agents_common.rs:36-42). A "v1" pin means "eligible LEAF": the child simply
  // receives no collaboration tools (spec_plan.rs:599-610).
  return entry.multi_agent_version !== "disabled";
}
```

Rewrite the doc comment at `sync.ts:90-104` (it cites the superseded `92938d880` equality
rule). Keep the three-way distinction — it now maps to eligible-recursive /
eligible-leaf / excluded. `surface_incompatible` (`:190-193`) now fires only for an
explicit `disabled` pin; keep the reason code and update its message.

## Change 2 — drop the blanket v2 stamp (`src/codex/catalog/parsing.ts:382-388`)

```ts
      if (typeof upstreamPin === "string") {
        entry.multi_agent_version = upstreamPin;
      } else if (typeof entry[OCX_MULTI_AGENT_FIELD] === "string") {
        entry.multi_agent_version = entry[OCX_MULTI_AGENT_FIELD];   // Change 3 provenance
      } else {
        // Absent means LEAF, not "refused". Stamping "v2" would claim every routed
        // third-party model is a recursive delegator.
        delete entry.multi_agent_version;
      }
```

Rewrite the `@param v2FeatureEnabled` comment at `parsing.ts:345-360` (states the
superseded "clean refusal at spawn time" rationale). Mark the parameter `@deprecated` and
stop reading it; leave it in the signature so the two call sites need no change this cycle.
Explicit `mode === "v1"` / `"v2"` force-all behavior is UNCHANGED.

## Change 3 — the capability's creation path and bridge

**NEW** constant in `src/codex/catalog/parsing.ts` beside `SPAWN_PRIORITY_FIELD`
(`sync.ts:80` precedent): `export const OCX_MULTI_AGENT_FIELD = "opencodex_multi_agent_version";`

**MODIFY** `src/codex/catalog/provider-fetch.ts:999` `catalogHintsFromModelsApiItem`:

```ts
  // CANONICAL: multi_agent_version is a TOP-LEVEL ModelInfo field (openai_models.rs:459-460).
  // The metadata-nested form is only a tolerated fallback for providers that mirror it there.
  const declared =
    (typeof item.multi_agent_version === "string" ? item.multi_agent_version : undefined)
    ?? (typeof metadata?.multi_agent_version === "string" ? metadata.multi_agent_version : undefined);
  // Only "v2" | "v1" | "disabled" are meaningful; anything else is treated as absent,
  // matching upstream deserialize_optional_model_selector (openai_models.rs:322-331).
```

**MODIFY** `src/codex/catalog/effort.ts:113` `applyCatalogModelMetadata` — without this
stamp the marker never exists and `applyMultiAgentMode` can never see it:

```ts
  // Private marker: survives strict normalization so applyMultiAgentMode can serialize the
  // declared capability without inferring it. Same pattern as the owned_by combo marker.
  if (model.multiAgentVersion) entry[OCX_MULTI_AGENT_FIELD] = model.multiAgentVersion;
```

**MODIFY** `CatalogModel` (`src/codex/catalog/parsing.ts:94`): add
`multiAgentVersion?: "disabled" | "v1" | "v2"`.

Field chain (PLAN-FIELD-CHAIN-01):

| Stage | Exact location |
| --- | --- |
| creation — provider `/models` | `src/codex/catalog/provider-fetch.ts:999` (top-level field) |
| creation — native pins | `src/codex/catalog/metadata.ts:174` `nativeMultiAgentVersion` (exists) |
| creation — user config | **N/A** — no per-model user control this cycle; `ocx v2 mode` is global |
| type | `CatalogModel` `parsing.ts:94` |
| **bridge** | `applyCatalogModelMetadata` `effort.ts:113` (called `sync.ts:322`) stamps `entry[OCX_MULTI_AGENT_FIELD]` |
| serialization | `applyMultiAgentMode` writes snake_case `multi_agent_version` (`openai_models.rs:372-461`) |
| deserialization | `readCatalog`; unknown strings preserved verbatim, never coerced |
| consumer — roster | `isEligibleV2SubagentEntry`, `effectiveSubagentRoster` `sync.ts:142` |
| consumer — management | `src/server/management/model-rows.ts:67` — native rows must carry it explicitly |
| consumer — fallback | Change 4 |
| GUI — **type projection, N/A as a consumer** | `gui/src/pages/models-shared.ts:28` gets the optional field for type fidelity only; no GUI surface renders it this cycle, and a type without a renderer is not a consumer. Rendering is deliberately deferred. |

Do **not** emit camelCase `multiAgentVersion` on the `/models` wire; camelCase belongs only
to app-server `model/list` (`v2/model.rs:110`), which opencodex does not serve.

## Change 4 — fallback preserves the capability class (G12)

`applySubagentModelFallback` rewrites a child's model *after* Codex built that child's
tool surface, and `selectAvailableSubagentModel` (`:269`) never checks capability. A `v2`
child quota-swapped to a `v1`/`disabled` model keeps collaboration tools it cannot honor.

ADD to `src/codex/catalog/sync.ts`, beside the predicate:

```ts
export type SubagentCapabilityClass = "recursive" | "leaf" | "excluded";

export function subagentCapabilityClass(entry: RawEntry | undefined): SubagentCapabilityClass {
  if (!entry) return "leaf";                     // unknown model: assume leaf, never recursive
  if (entry.multi_agent_version === "disabled") return "excluded";
  return entry.multi_agent_version === "v2" ? "recursive" : "leaf";
}
```

`selectAvailableSubagentModel` gains an **additive optional** `requiredClass?: SubagentCapabilityClass`
and resolves each candidate's class from the active catalog via `configuredCatalogEntry`
(`sync.ts:127-130`). A candidate weaker than `requiredClass` is skipped; `excluded` is never
selected. Omitting the parameter preserves today's behavior exactly. When no same-class
candidate remains, prefer failing the fallback over silently downgrading.

**Both** call sites must pass it: `src/server/responses/core.ts:1768` and `:1856`.

## Change 5 — fork-override guidance (G13, OPTIONAL)

Upstream's `DEFAULT_MULTI_AGENT_V2_MODEL_OVERRIDE_USAGE_HINT_TEXT`
(`codex-rs/core/src/config/mod.rs:253`) states full-history forks "do not accept
overrides", while the implementation honors them (`multi_agents_v2/spawn.rs:39-99`; test
`subagent_notifications.rs:1040-1087`). opencodex's `collaboration.ts:349` text therefore
**mirrors upstream guidance and is not wrong**.

Settled outcome: keep the wording aligned with upstream's hint. Do NOT assert a runtime
rejection, and do NOT claim upstream merely "discourages" it. This change is optional
polish, not a defect fix.

## Change 6 — SoT doc sync

MODIFY `structure/03_catalog-and-subagents.md:133-153`: replace the `"default"` row's
"codex feature flag decides" with the three-state semantics table; cite `6d4d9442c` and
`spec_plan.rs:599-610`.

## Tests

`tests/multi-agent-compat.test.ts` (roster anchors `:243, :293, :408, :471`):

1. **Luna is in the roster** — `effectiveSubagentRoster(["gpt-5.6-luna"], "v2")` lists it in
   `advertised`. Fails today with `surface_incompatible` — activation evidence.
2. `disabled` is the ONLY capability-based exclusion.
3. `candidates` still capped at `MAX_SPAWN_AGENT_MODEL_OVERRIDES` (5).

`tests/native-model-toggle.test.ts` (anchor `:324`):

4. Four-row matrix (`v2`/`v1`/absent/`disabled`) with the v2 flag ON and OFF. The
   routed-row-with-flag-ON case asserts `Object.hasOwn(entry, "multi_agent_version") === false`
   — currently `"v2"`.

`tests/codex-catalog.test.ts` / `tests/codex-v2-gate.test.ts` (anchor `:1899`):

5. A provider `/models` item declaring a top-level `multi_agent_version` reaches the wire.
6. An unknown declared value is treated as absent.
6b. **Management projection** — `listManagementModelRows` (`src/server/management/model-rows.ts:67`) emits the capability on a NATIVE row (routed rows inherit it by spreading `CatalogModel`; native rows are built field-by-field and would silently drop it). Assert via the `/api/models` route suite.

`tests/subagent-model-fallback.test.ts`, `tests/subagent-model-fallback-api.test.ts`,
`tests/subagent-fallback-handle-responses.test.ts`:

7. A `v2` child quota-swapped to a `v1` candidate does not silently downgrade, on both
   runtime paths (`core.ts:1768` and `:1856`).

## Verification

```bash
bun install                      # REQUIRED: this worktree has no node_modules
cd gui && bun install && cd ..   # REQUIRED for lint:gui (oxlint)
bun test tests/multi-agent-compat.test.ts tests/native-model-toggle.test.ts tests/codex-catalog.test.ts tests/codex-v2-gate.test.ts tests/subagent-model-fallback.test.ts tests/subagent-model-fallback-api.test.ts tests/subagent-fallback-handle-responses.test.ts
bun x tsc --noEmit
bun run lint:gui                 # Change 3 touches gui/src/pages/models-shared.ts
```

**Receipts (PLAN-VERIFIER-REAL-01, measured 2026-08-16 in this dependency-less worktree).**
Each row is the exact command named above:

| Command | Exit | Observed |
| --- | --- | --- |
| the 7-file `bun test` command | 1 | `0 pass, 7 fail, 7 errors; Ran 7 tests across 7 files` — `Cannot find module 'zod/v4'` |
| `bun x tsc --noEmit` | 1 | `TS2688: Cannot find type definition file for 'bun-types'` |
| `bun run lint:gui` | **127** | `oxlint: command not found` (missing binary, not a lint failure) |

All three are environmental: `ls node_modules` → absent. B runs both installs first and
re-records real exit codes.

Target observation: `tests/native-model-toggle.test.ts:23` imports `applyMultiAgentMode`
from `../src/codex/catalog/parsing`; `tests/multi-agent-compat.test.ts:13` imports
`effectiveSubagentRoster` from `../src/codex/catalog`. Both gates read this phase's targets.
The `structure/` prose edit is read by no gate — **human review**.

## Accept criteria

1. `effectiveSubagentRoster(["gpt-5.6-luna"], "v2")` advertises Luna.
2. Only an explicit `disabled` pin excludes a model for capability reasons.
3. `applyMultiAgentMode(rows, "default", true)` leaves an unpinned row's key absent.
4. A provider-declared top-level capability survives creation → bridge → serialization →
   roster → management.
5. Quota fallback never downgrades a `v2` child, on both call sites.
6. Fork guidance stays aligned with upstream's hint text (optional polish).
7. `structure/03_catalog-and-subagents.md` states the three-state semantics.

## Out of scope

`ocx v2 mode` CLI semantics; a per-model user-facing capability control; GUI rendering of
the capability; the quota/health logic itself (only its capability awareness changes).
