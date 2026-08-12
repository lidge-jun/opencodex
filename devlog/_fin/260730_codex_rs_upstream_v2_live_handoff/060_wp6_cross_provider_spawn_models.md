# 060 — WP6: allow cross-provider subagent spawns (DECIDED: option B)

One full PABCD cycle. Independent of WP1-WP5; it touches the model catalog, not the
config TOML helpers or the live relay.

## The decision

Upstream `92938d880` restricts V2 `spawn_agent` models to the active backend:

```rust
pub(crate) fn model_supports_multi_agent_backend(
    model: &ModelPreset,
    multi_agent_version: MultiAgentVersion,
) -> bool {
    multi_agent_version != MultiAgentVersion::V2
        || model.multi_agent_version == Some(multi_agent_version)
}
```

That equality test assumes one backend serves every model. OpenCodex is a multi-provider
proxy, so importing it verbatim rejects exactly the cross-provider delegation OpenCodex
exists to enable.

**User decision (2026-07-30): option B — widen the compatible set to every model
OpenCodex actually routes, while keeping upstream's unknown-model guardrail and error
shape.** The gate stays; the guest list widens. A typo still gets a clear tool-level
message instead of an opaque provider error.

## Where the restriction actually lives in OpenCodex

OpenCodex does not re-implement upstream's validator. It *generates the catalog* the
native binary then validates against, and it already replicates the single-backend
filter in two places inside `effectiveSubagentRoster`
([src/codex/catalog/sync.ts:75](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/sync.ts:75)):

- line 89, which drops non-`v2` entries from the advertised candidate list
- line 113, which reports a configured model as `surface_incompatible`

So this phase is a catalog-filter change, not a validator change. That is a smaller and
safer surface than the phase looked like when it was first recorded as an open question
in `002` §A8.

## Change map

| Path | Action |
|---|---|
| `src/codex/catalog/sync.ts` | MODIFY — replace the `=== "v2"` equality with a routed-model predicate |
| `src/codex/catalog.ts` | MODIFY — re-export the new predicate if tests need it directly |
| `tests/multi-agent-compat.test.ts` | MODIFY — the existing roster tests; verified as the only file referencing `effectiveSubagentRoster` |

`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5` ([sync.ts:43](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/sync.ts:43))
stays as is. Widening eligibility must not widen how many models are advertised, or the
tool schema grows and every spawn prompt pays for it.

## Diff 1 — the eligibility predicate

NEW in `src/codex/catalog/sync.ts`, above `effectiveSubagentRoster`:

```ts
/**
 * Whether a catalog entry may be offered as a V2 subagent model.
 *
 * Upstream (codex-rs 92938d880) requires `multi_agent_version === "v2"` exactly, because
 * upstream assumes a single backend serves every model. opencodex routes many providers,
 * so that equality would reject the cross-provider spawns this proxy exists to enable.
 *
 * Decision (option B): any model opencodex actually routes is eligible. Entries pinned to
 * a DIFFERENT multi-agent backend (`v1`) stay excluded, because that pin is a real
 * capability statement rather than an absence of information. An unpinned entry
 * (`multi_agent_version` null or absent) is a routed third-party model and is allowed.
 */
export function isEligibleV2SubagentEntry(entry: RawEntry): boolean {
  const pinned = entry.multi_agent_version;
  return pinned === "v2" || pinned === null || pinned === undefined;
}
```

The three-way distinction is the whole substance of this phase, so it must not be
flattened into a truthiness check:

| `multi_agent_version` | Meaning | Eligible? |
|---|---|---|
| `"v2"` | native model, V2-capable | yes |
| `null` / absent | routed third-party model, no upstream claim | **yes (this is the change)** |
| `"v1"` | pinned to the other multi-agent backend | no |

Evidence that all three occur in the shipped data: `src/codex/data/upstream-models.json`
contains `"multi_agent_version": "v2"` (lines 21, 135), `"v1"` (line 247), and `null`
(lines 355, 461, 562, 658, 754).

## Diff 2 — candidate filter

MODIFY `src/codex/catalog/sync.ts:89`.

BEFORE:

```ts
    .filter(({ entry }) => surface !== "v2" || entry.multi_agent_version === "v2")
```

AFTER:

```ts
    .filter(({ entry }) => surface !== "v2" || isEligibleV2SubagentEntry(entry))
```

## Diff 3 — exclusion reporting

MODIFY `src/codex/catalog/sync.ts:113`.

BEFORE:

```ts
    if (surface === "v2" && entry.multi_agent_version !== "v2") {
      return [{ configured: model, catalogModel, reason: "surface_incompatible" }];
    }
```

AFTER:

```ts
    if (surface === "v2" && !isEligibleV2SubagentEntry(entry)) {
      return [{ configured: model, catalogModel, reason: "surface_incompatible" }];
    }
```

The `surface_incompatible` reason string is unchanged, so every consumer of
`SubagentRosterExclusion` keeps working. After this change it means "pinned to a
different multi-agent backend" rather than "not pinned to v2", which is a narrower and
more accurate use of the same label.

Consumers to leave alone, verified present:
`src/codex/catalog.ts:12` re-exports the types, and
`src/server/responses/{collaboration,core,compact,fetch-helpers,encrypted-payload}.ts`
consume `EffectiveSubagentRoster` / `SpawnAgentSurface` without inspecting
`multi_agent_version` themselves.

## What deliberately does NOT change

- `surface === "v1"` behavior. Upstream imposes no equality filter for V1, and neither
  does OpenCodex today.
- `visibility === "list"` gating. A picker-hidden model stays hidden; eligibility is not
  visibility.
- The advertised cap of 5.
- The `picker_hidden`, `missing_catalog_entry`, and `outside_display_limit` exclusion
  reasons.
- Any native-binary validation. OpenCodex supplies the catalog; the binary still applies
  its own check against what it was given.

## Risk: does the native binary re-reject what we now advertise?

This is the one real unknown in the phase and B must settle it empirically before C
claims success. Upstream's validator compares against *its* `available_models` list. If
that list is the catalog OpenCodex writes, widening the catalog is sufficient. If the
binary carries an independent pin, an unpinned model could be advertised and then
refused at spawn time — a worse user experience than today's clean exclusion.

Resolve it by running a real cross-provider spawn against a routed model and reading the
result, not by reasoning from the Rust source. If the binary does re-reject, the phase's
honest outcome is `BLOCKED` with that evidence recorded, and the fallback is to keep the
narrow filter and surface a clearer explanation instead of silently advertising models
that cannot spawn.

## Accept criteria

1. A routed third-party model with `multi_agent_version` null or absent is advertised as
   a V2 subagent candidate.
2. A model pinned `"v1"` is still excluded, with reason `surface_incompatible`.
3. A model pinned `"v2"` is still advertised, unchanged from today.
4. `surface === "v1"` rosters are byte-identical before and after.
5. Picker-hidden models stay excluded with reason `picker_hidden`, taking precedence over
   the eligibility check exactly as it does today.
6. At most `MAX_SPAWN_AGENT_MODEL_OVERRIDES` models are advertised, unchanged.
7. A cross-provider spawn of a newly eligible model **actually succeeds end to end**, or
   the phase closes `BLOCKED` with the refusal captured.

### Activation scenarios (C-ACTIVATION-GROUNDING-01)

| Path | Trigger | Observable |
|---|---|---|
| unpinned-eligible branch | catalog fixture with `multi_agent_version: null` | model appears in `advertised`; this is the branch the whole phase exists for |
| absent-key branch | fixture with the key omitted entirely, not null | same result as null; proves `undefined` is handled, not just `null` |
| v1-pinned exclusion | fixture pinned `"v1"` | excluded with `surface_incompatible` |
| precedence | fixture that is BOTH picker-hidden and unpinned | reason is `picker_hidden`, proving order is unchanged |
| live spawn | real cross-provider spawn request | child agent starts and returns; log or response captured |

The absent-key case is the one most likely to ship broken: a predicate written as
`pinned === "v2" || pinned === null` passes the null fixture and fails on a real entry
that simply omits the field. Drive both.

## Verification gate

`bun run typecheck`, `tests/multi-agent-compat.test.ts` green with all seven criteria
asserted, and the live cross-provider spawn evidence from criterion 7 pasted into the phase's
`checkOutput`. A green suite alone does not close this phase, because the suite cannot
observe the native binary's own validation.

---

# P-phase re-verification (2026-07-31, execution cycle)

Stale check against the tree after WP1-WP5 (`da6e9d873`). Filter sites confirmed exact
(`sync.ts:89`, `:113`); the fixture-helper trap confirmed
(`tests/multi-agent-compat.test.ts:53` rewrites `undefined` to `"v2"`); snapshot counts
re-verified (v2=2, v1=1, null=5, absent=0 of 8 in
`src/codex/data/upstream-models.json`). No uncommitted changes on target files.

One amendment that widens this phase's change map, because the `005` staleness audit
turned the "risk" section below from an unknown into a near-certainty.

## Amendment A — Diff 1-3 alone is the documented BLOCKED case; the write path is in scope

`005` finding 13, re-verified this cycle: the native binary applies its OWN pin
predicate to the catalog file we write (`multi_agents_common.rs:271` fetches the loaded
catalog, `:416` filters with the V2 pin test; `config/mod.rs:968` says a configured
`model_catalog_json` replaces the bundled catalog). And our write path actively strips
the pin for exactly the models option B cares about:

- `normalizeRoutedCatalogEntry` deletes `multi_agent_version` (`parsing.ts:328`).
- `applyMultiAgentMode(entries, "default")` deletes it for every entry without an
  upstream pin (`parsing.ts:303-318`).

So under default mode the emitted `opencodex-catalog.json` marks routed models ABSENT,
and absent fails `model.multi_agent_version == Some(V2)`. Relaxing only the roster
filter would make the guidance text advertise models the binary then refuses at spawn
time — precisely the "worse user experience" the risk section warns about, and the
live spawn would fail. The write path is therefore in scope.

### Final design

1. **Roster filter** (unchanged from Diffs 1-3): `isEligibleV2SubagentEntry` admits
   `"v2"`, `null`, and absent; excludes `"v1"`. This governs the guidance text — what
   the parent agent is told it may spawn.
2. **Write path, gated on the feature**: `applyMultiAgentMode` gains an optional third
   parameter `v2FeatureEnabled`. When mode is `"default"` AND the v2 feature is enabled
   in the native config, entries WITHOUT an upstream pin get
   `multi_agent_version = "v2"` written (instead of the key being deleted), so the
   binary's own predicate admits them. Upstream pins are untouched: `"v1"` stays
   `"v1"` (still excluded), `"v2"` stays `"v2"`. When the feature is disabled, the
   byte output of default mode is identical to today — zero behavior change for
   non-v2 users, and no existing mode-default test should move. Modes `"v1"`/`"v2"`
   are unchanged (they already force every entry).
3. **Callers** (`sync.ts:287`, `:461`) pass `isMultiAgentV2Enabled()` — the sync path
   already reads native config for other gates, so no new plumbing.
4. **Fixture helper fix** (`multi-agent-compat.test.ts:53`): stop rewriting
   `undefined` to `"v2"`; omit the key entirely so the absent case is constructible.

### Why gating on the feature is the conservative reading of option B

The user's decision widens the V2 guest list. Writing `"v2"` for unpinned models only
when V2 is active means: nothing changes for anyone not using V2 (catalog bytes
identical), and the moment V2 is on, the models the guidance advertises are exactly
the models the binary will accept. The alternative (always writing `"v2"` in default
mode) would change catalog bytes for every default-mode user whether or not they use
V2, for zero benefit.

### Open question the audit must settle

Enumerate EVERY upstream consumer of the per-model `multi_agent_version` field beyond
the spawn filter at `multi_agents_common.rs:416`. If some other consumer (agent
registry, depth accounting, model-family selection) treats a `"v2"` pin on a routed
model differently than absent, the write-path half needs re-scoping. The audit verdict
on this question is a hard gate for B.

### Live-spawn evidence, staged

Criterion 7 stands. The staged approach for C: first an isolated-`CODEX_HOME` proof
that the emitted catalog carries `"v2"` for a routed model AND that the binary loads
that catalog without rejecting the model at validation time (the "Unknown model for
spawn_agent" refusal happens before any network call, so a refusal is observable even
offline); then, if a real provider is reachable in this environment, one genuine
cross-provider spawn. If neither is observable here, the phase says so plainly and
closes `BLOCKED` with the static evidence rather than rounding a green suite up to
success.

---

# A-phase fold-back, execution cycle (verdict GO-WITH-FIXES, 2 High blockers)

Independent terra review (Turing). Both blockers accepted; near-pass. The hard gate
from the P amendment is RESOLVED in the design's favor, quoted below.

## Hard gate resolved — no main-session behavior change

Every upstream consumer of the per-model pin, enumerated:

| Consumer | Role | Delta for absent → "v2" under feature-on |
|---|---|---|
| `protocol/openai_models.rs:645` | catalog → preset propagation | none (plumbing) |
| `session/mod.rs:3323`, `turn_context.rs:756-759` | session resolution | none — `multi_agent_version_override()` returns V2 first when the feature is on (`config/mod.rs:1521-1547`), so the pin does not select anything new |
| `tools/handlers/multi_agents_spec.rs:786-790` | spawn_agent schema filter | intended: routed model newly offered |
| `tools/handlers/multi_agents_common.rs:423-439` | spawn-time validation + refusal | intended: routed model newly accepted |

Depth, registry, residency, execution limits, and child instruction handling all
consume the resolved `TurnContext.multi_agent_version`, which the global flag already
sets — the stamp selects nothing there. No wire-shape branch reads the field.

## Blocker 1 (accepted) — the stale-catalog transition window

The roster (guidance) and the binary read the same catalog file, but the file is only
re-stamped on a sync. A user who enables v2 OUTSIDE an ocx path (`codex features
enable multi_agent_v2` directly) gets a window where guidance advertises a routed
model the not-yet-stamped catalog still refuses. Disposition:

- All ocx-owned toggle paths already refresh: the management PUT calls
  `refreshCodexCatalogBestEffort()`; `cmdV2` takes a `sync` dependency for exactly
  this. B verifies the CLI path calls it (test-backed).
- The residual window (direct native toggle + spawn attempt before any ocx sync)
  fails LOUDLY and recoverably: the binary's refusal names the available models, the
  parent can pick another, and the next ocx sync stamps the catalog. It is not silent
  corruption and it self-heals. Accepted as a documented residual rather than
  engineering a write side-effect into the per-request guidance path.
- B adds the stale-catalog transition test the reviewer asked for: feature toggled on
  with an unstamped catalog → guidance advertises (documented), then a sync runs →
  the catalog is stamped and the binary-side predicate would accept.

## Blocker 2 (accepted) — both-callers regression contract

`applyMultiAgentMode` is invoked from `buildCatalogEntries` (`sync.ts:287`) and
`mergeCatalogEntriesForSync` (`sync.ts:461`). B adds feature-on AND feature-off
assertions for BOTH paths: default+on stamps only unpinned rows (routed and
null-pinned natives); default+off is byte-identical to today; v1/v2 modes still force
everything; upstream v1/v2 pins are preserved in every case. The existing three-state
tests (`codex-v2-gate.test.ts:989-998`, `:1021-1040`) run with no feature fixture and
keep exercising feature-off behavior, so they stay green only if the new parameter
defaults to false — B asserts that default explicitly.

## Live-evidence staging refined (from the audit)

- `codex debug prompt-input --enable multi_agent_v2` with an isolated CODEX_HOME
  exercises the binary's schema-side filter OFFLINE (the catalog becomes a
  `StaticModelsManager`; no network). `codex debug models` proves catalog loading.
- Neither reaches the spawn-time handler, so criterion 7 still requires a real spawn
  attempt. A prior repo note (unverified) warns heterogeneous V2 parent/child traffic
  may hit `unreadable_encrypted_agent_task` — one more reason the real spawn is the
  gate, not the schema check.

## Test updates now enumerated (from the audit)

- `multi-agent-compat.test.ts:126-153`: null-pinned `gpt-5.5` becomes
  candidate/advertised and appears in guidance.
- `multi-agent-compat.test.ts:222-225`: null-pinned `gpt-5.5` becomes a valid
  preferred model.
- Fixture helper `:53` omits the key instead of rewriting to `"v2"`.

---

# C-phase evidence: what the native binary actually confirms (2026-07-31)

The open risk this phase carried was whether the native binary would still refuse a
model our roster advertises. Probed directly against the installed binary
(`codex-cli 0.146.0-alpha.9.2`) with an isolated `CODEX_HOME`, a catalog written in our
own schema, and `multi_agent_v2` enabled.

## Confirmed by execution

`codex debug models` echoes the pin exactly as we wrote it:

```
gpt-5.6-sol                 -> 'v2'
opencode-go/glm-5.2         -> 'v2'      # what our writer now emits (feature ON)
opencode-go/unpinned-probe  -> None      # what it emitted before
```

Two things follow, and they are the load-bearing half of the design:

1. The binary loads a routed, slash-namespaced model carrying `multi_agent_version:
   "v2"` without complaint — the catalog is accepted, not filtered on ingest.
2. The absent-key and stamped rows survive as DISTINCT values, which is exactly the
   distinction `applyMultiAgentMode` now controls. If the binary had normalized or
   dropped the field, the write-path half of option B would be pointless.

## NOT confirmed, stated plainly

`codex debug prompt-input --enable multi_agent_v2` renders the multi-agent PROSE
guidance, not the `spawn_agent` tool schema: no model list appears in its output at all
(searched for every probe slug — zero mentions), while the collaboration instructions
are present. So this surface cannot show which models the schema advertises, and
neither debug command reaches the spawn-time validator.

A genuine cross-provider spawn therefore remains unproven. That is a limitation of the
available offline surfaces, not evidence of failure: the mechanism upstream applies its
pin test to the loaded catalog, and the loaded catalog demonstrably now carries `"v2"`
for a routed model.

## Outcome for this work-phase

`DONE` for the catalog-eligibility change with the evidence above; the end-to-end spawn
assertion is carried forward as the one open item rather than being quietly rounded up
to success. Criterion 7 is explicitly NOT claimed met by a green suite — it needs a real
session against a live routed provider, which is a runtime check the user can make in
one turn and this phase cannot make for them.

---

# Criterion 7 CLOSED by a live spawn + control (2026-07-31)

The open item is resolved, and with a controlled experiment rather than a single happy
path. Both runs used `codex exec --enable multi_agent_v2` against the real installed
binary (`codex-cli 0.146.0-alpha.9.2`) with an isolated `CODEX_HOME`, the same auth, and
the same prompt: spawn `opencode-go/glm-5.2` and report verbatim what happened.

The only difference between the two runs is the field WP6 writes.

| Catalog fed to the binary | Result |
|---|---|
| Produced by our writer (`mergeCatalogEntriesForSync`, default mode, v2 feature ON) — 21 routed rows stamped `"v2"` | **spawn succeeded**: `{"task_name":"/root/reply_ok"}` |
| Byte-identical control with the pin stripped from those same 21 rows | **refused**: ``Unknown model `opencode-go/glm-5.2` for spawn_agent. Available models: gpt-5.5, gpt-5.6-sol, gpt-5.6-terra, gpt-5.4-mini, gpt-5.4`` |

Three things this proves that the earlier `codex debug models` evidence could not:

1. The spawn-time validator is genuinely reached, and it accepts a routed,
   slash-namespaced, cross-provider model. Option B works end to end.
2. The write-path half is load-bearing, not decorative. Stripping only the stamp — with
   the roster filter, the feature flag, and everything else identical — reproduces the
   exact upstream refusal. Widening our advisory roster alone would have shipped a
   guidance surface that promised models the binary then rejected.
3. The refusal message and its available-models list are unchanged, so the
   unknown-model guardrail the user asked to keep is intact for genuinely bad input.

Note on the live user config at the time of this test: the machine was in
`multiAgentMode: "v1"` with the v2 feature OFF, so its on-disk catalog carried `"v1"` on
every row and our new branch was correctly dormant there. The test therefore drove the
production writer explicitly rather than reading whatever happened to be on disk — which
is also why the feature-OFF byte-identity contract in `tests/codex-v2-gate.test.ts`
matters: most users sit in exactly that dormant state.

Criterion 7: **met**. Work-phase outcome upgraded from "DONE with one open item" to
plain `DONE`.
