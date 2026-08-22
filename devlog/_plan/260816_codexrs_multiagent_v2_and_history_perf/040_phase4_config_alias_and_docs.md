# Phase 4 — config alias truth and its full consumer chain

Closes G7. One PABCD cycle. Independent of every other phase.

Audit history: `006_audit_round1.md`, `007_audit_round2.md`. This document is canonical —
all audit corrections are integrated below, not appended.

## Why: opencodex enforces a rule upstream reverted 4 months ago

`src/codex/features.ts:226-240` claims codex-rs "REFUSES to boot" on `[agents] max_threads`
with multi_agent_v2 enabled. Git archaeology in the upstream checkout:

| Commit | Date | Subject |
| --- | --- | --- |
| `d3b044938` | 2026-04-23 | Reject agents.max_threads with multi_agent_v2 (#19129) |
| `1f304dd1f` | 2026-04-26 | **Allow** agents.max_threads to work with multi_agent_v2 (#19733) |
| `03bb3b123` | 2026-07-16 | Unify multi-agent settings under `agents` (#33550) |

At HEAD `9dd22890f`:

```bash
$ rg -n 'cannot be set when|multi_agent_v2 is enabled' codex-rs/ --type rust
(no matches)
```

`max_threads` is a first-class alias — `codex-rs/config/src/key_aliases.rs:17-21` and
`codex-rs/config/src/config_toml.rs:668` (`#[serde(alias = "max_threads")]`).
`normalize_key_aliases` uses `.entry(canonical).or_insert(value)`: with BOTH keys present
the canonical key wins and the legacy value is silently discarded.

## Semantics that must survive

- V1 `[agents] max_threads = N` → N **child** threads (root not counted); default 6.
- V2 `max_concurrent_threads_per_session = N` → N **total** including root → N-1 children;
  default 4.
- `[agents] N` used as the V2 fallback resolves to N+1 total.

Already modeled by `isTranslatableV1ChildLimit` / `v1ChildLimitToV2TotalLimit`
(`src/codex/features.ts:1305-1310`). Preserve it.

## Change 1 — readers accept both keys

`getAgentsMaxThreads` (`:242-258`) matches only `max_threads`. Replace with:

```ts
/** Current [agents] thread limit: canonical max_concurrent_threads_per_session, else the
 *  max_threads legacy alias (key_aliases.rs:17-21 — canonical wins on conflict). */
export function getAgentsThreadLimit(configPath?: string): number | null
```

Keep `getAgentsMaxThreads` as a deprecated alias for one release; move every consumer.

## Change 2 — correct the claim

`hasAgentsMaxThreads` (`:226-240`) keeps its detection but changes its meaning: the key is
an accepted legacy alias, not a boot blocker. Rename to `hasLegacyAgentsMaxThreadsAlias`
(deprecated re-export for one release) and rewrite the doc comment citing `1f304dd1f` and
`key_aliases.rs:17-21`.

## Change 3 — detect the case that matters, and consume it

```ts
/** TRUE when [agents] defines BOTH keys with DIFFERENT values. Upstream
 *  normalize_key_aliases uses or_insert, so the canonical key wins and the legacy value is
 *  silently dropped — worth warning about, unlike the alias itself. */
export function hasConflictingAgentsThreadKeys(configPath?: string): boolean
```

Reuse the existing TOML readers (`parsedTomlTable`, `tomlTableBody`) at `:236-253` /
`:294-304`; no new dependency.

**GUI visibility (settled):** a two-key conflict is a config defect regardless of whether
V2 is on — the canonical key wins and the legacy value is discarded either way
(`key_aliases.rs:24-36`). So the conflict is surfaced **independently of `enabled`**. The
DTO key `agentsMaxThreadsConflict` keeps its name for contract stability; its value becomes
`hasConflictingAgentsThreadKeys()` with **no `enabled &&` guard**, and the GUI condition
drops `v2.enabled`.

## Change 4 — writer prefers the canonical key

`src/codex/features.ts:1215-1234`: new insertions write
`max_concurrent_threads_per_session`. An existing user-authored `max_threads` line keeps its
spelling and trailing comment (`mergeTrailingComments` discipline). The `:1496`
postconditions at **`:1486` (v2) and `:1496` (v1)** must be updated in the same commit or
they will assert on the old key and fail.

## Change 5 — the complete consumer chain

Every consumer of the old predicate or the `max_threads` spelling, verified this session:

| Consumer | Location | Required change |
| --- | --- | --- |
| logical display | `src/codex/features.ts:1305-1310` `getLogicalMaxThreads` | use `getAgentsThreadLimit` |
| migration discovery | `discoverStoredThreadLimit` (same file) | both spellings |
| **v2 migration postcondition** | `src/codex/features.ts:1486` | calls `hasAgentsMaxThreads(path)`, which sees only the legacy spelling — a residual **canonical** `[agents]` key would escape the check. Must assert that NEITHER `[agents]` spelling remains |
| v1 migration postcondition | `src/codex/features.ts:1496` | uses `getAgentsMaxThreads(path) !== threadLimit`; move to `getAgentsThreadLimit` so a canonical-spelled target validates |
| comment preservation | `src/codex/features.ts:1342` `activeThreadComment` | regex matches `max_threads` only; must also match the canonical key or comments are dropped on migration |
| dotted-key rejection | `src/codex/features.ts:1398` | pattern names `agents.max_threads`; add the canonical dotted form |
| duplicate detection | `src/codex/features.ts:1416` | counts duplicate `max_threads` only; must also count canonical duplicates and cross-key duplicates |
| management GET DTO | `src/server/management/agent-settings-routes.ts:232` | `hasConflictingAgentsThreadKeys()`, no `enabled &&` |
| management PUT DTO | `src/server/management/agent-settings-routes.ts:373` | same fix — repeats the stale predicate |
| CLI import | `src/cli/v2.ts:15` | move to the renamed predicate |
| **CLI warning text** | `src/cli/v2.ts:127` | **ships a false claim today:** "codex refuses to start while multi_agent_v2 is enabled". The most user-visible instance of G7 |
| GUI | `gui/src/pages/Models.tsx:1341` + locale strings | drop `v2.enabled` gating; rewrite the boot-refusal copy |
| SoT doc 1 | `structure/03_catalog-and-subagents.md` | child-vs-total table + alias fact with SHAs |
| SoT doc 2 | `structure/05_gui-and-management-api.md:105` | the `/api/v2` row describes migrating `[agents] max_threads` |

## Tests (`tests/codex-features-cache.test.ts`, `tests/codex-features-residual.test.ts`, `tests/codex-v2-gate.test.ts`)

1. `[agents] max_threads = 6` alone → read correctly, NOT a boot blocker.
2. `max_concurrent_threads_per_session = 6` alone → read correctly.
3. Both keys, same value → no conflict.
4. Both keys, different values → conflict reported AND surfaced in `GET /api/v2`.
5. **PUT `/api/v2` reports the conflict identically to GET.**
6. **The conflict is reported with V2 disabled** — activation evidence for Change 3.
7. `ocx v2 status` emits no boot-refusal claim for a lone `max_threads`.
8. New writes emit the canonical key; an existing `max_threads` line is preserved verbatim.
9. **A trailing comment on a canonical-key line survives migration** (`:1342`).
10. **Duplicate canonical keys, and one-of-each duplicates, are both rejected** (`:1416`).
11. Child/total conversion: `[agents] 6` ⇒ v2 total 7; v2 total 4 ⇒ 3 children.
12. Both migration postconditions (`:1486` v2, `:1496` v1) pass against the new writer.
13. **Transition starting from the canonical `[agents] max_concurrent_threads_per_session`
    spelling** — the v2 postcondition at `:1486` must catch a residual canonical key, which
    it cannot today. Activation evidence for that row.

## Verification

```bash
bun install                      # REQUIRED: this worktree has no node_modules
cd gui && bun install && cd ..   # REQUIRED for lint:gui (oxlint)
bun test tests/codex-features-cache.test.ts tests/codex-features-residual.test.ts tests/codex-v2-gate.test.ts
bun x tsc --noEmit
bun run lint:gui                 # Change 3/5 touch gui/src/pages/Models.tsx
```

The `/api/v2` route is covered by `tests/codex-v2-gate.test.ts` (verified). There is no
`tests/api-v2.test.ts`, and `bun test` ignores a missing path **silently** — a phantom
filename leaves the gate observing nothing.

**Receipts (measured 2026-08-16, dependency-less worktree).** Each row is the exact command
named above:

| Command | Exit | Observed |
| --- | --- | --- |
| the 3-file `bun test` command | 1 | `0 pass, 3 fail; Ran 3 tests across 3 files` — `Cannot find module 'zod/v4'` |
| `bun x tsc --noEmit` | 1 | `TS2688: Cannot find type definition file for 'bun-types'` |
| `bun run lint:gui` | **127** | `oxlint: command not found` (missing binary, not a lint failure) |

Environmental — `node_modules/` absent. B runs both installs and re-records.

Target observation: the features suites import `src/codex/features.ts` directly;
`tests/codex-v2-gate.test.ts` exercises the `/api/v2` route. Both `structure/` prose edits
are read by no gate — **human review**.

## Accept criteria

1. No opencodex surface claims codex-rs refuses to boot on `[agents] max_threads` —
   including `src/cli/v2.ts:127`, the GUI, and every locale.
2. Both key spellings are read, with canonical winning on conflict.
3. The conflict detector is consumed by GET **and** PUT `/api/v2` and rendered by the GUI
   regardless of `enabled`.
4. New writes use the canonical key; user-authored legacy keys are preserved verbatim.
5. Comment preservation, dotted-key rejection, and duplicate detection all handle both keys.
6. Both migration postconditions (`:1486`, `:1496`) pass, and neither `[agents]` spelling can escape them.
7. Both `structure/` docs are updated.

## Out of scope

Auto-migrating a user's config; changing default thread counts.
