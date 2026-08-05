# 010 — WP1: fix the v1↔v2 concurrency translation

One full PABCD cycle. Depends on nothing. Must land before WP2 because WP2 extends the
same TOML edit helpers.

## The defect

Upstream `codex-rs/core/src/config/mod.rs:2674` (`resolve_multi_agent_v2_config`) reads
the V2-native key first and falls back to the `[agents]` key **plus one**:

```rust
let max_concurrent_threads_per_session = base
    .and_then(|config| config.max_concurrent_threads_per_session)
    .or_else(|| {
        config_toml
            .agents
            .as_ref()
            .and_then(|agents| agents.max_concurrent_threads_per_session)
            .map(|max_threads| max_threads.saturating_add(1))
    })
    .unwrap_or(DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION);
```

The `+1` accounts for the root agent's own slot: the `[agents]` number counts spawned
children, the V2 number counts total threads including the root.

OpenCodex treats them as the same number in both directions.

## Change map

| Path | Action |
|---|---|
| `src/codex/features.ts` | MODIFY — add the translation helpers, apply them in `getLogicalMaxThreads` and `transitionMultiAgentV2` |
| `tests/codex-v2-gate.test.ts` | MODIFY — add round-trip and boundary tests (path verified; see the audit fold-back below) |

The test path above was verified to exist. `tests/v2-agent-message-failfast.test.ts`
also exists but is unrelated to config migration.

## Diff 1 — translation helpers

MODIFY `src/codex/features.ts`. Insert immediately after `getMaxConcurrentThreads`
(currently ends at line 158, before the `setMaxConcurrentThreads` doc comment).

NEW:

```ts
/**
 * Upstream counts the root agent inside the V2 thread limit but not inside the
 * legacy `[agents]` limit (codex-rs core/src/config/mod.rs resolve_multi_agent_v2_config
 * applies saturating_add(1) to the [agents] value). These two helpers keep our
 * migrations on the same side of that boundary.
 */
export function v1ChildLimitToV2TotalLimit(childLimit: number): number {
  return childLimit + 1;
}

/**
 * Inverse of `v1ChildLimitToV2TotalLimit`. A V2 total limit of 1 means "root only,
 * no children", which has no representable legacy child count >= 1, so it clamps to 1
 * rather than producing 0 and tripping the `>= 1` validation on the legacy key.
 */
export function v2TotalLimitToV1ChildLimit(totalLimit: number): number {
  return Math.max(1, totalLimit - 1);
}
```

## Diff 2 — `getLogicalMaxThreads`

MODIFY `src/codex/features.ts:317`.

BEFORE:

```ts
export function getLogicalMaxThreads(configPath?: string): number | null {
  return isMultiAgentV2Enabled(configPath)
    ? getMaxConcurrentThreads(configPath) ?? getAgentsMaxThreads(configPath)
    : getAgentsMaxThreads(configPath) ?? getMaxConcurrentThreads(configPath);
}
```

AFTER:

```ts
export function getLogicalMaxThreads(configPath?: string): number | null {
  if (isMultiAgentV2Enabled(configPath)) {
    const v2 = getMaxConcurrentThreads(configPath);
    if (v2 !== null) return v2;
    const legacy = getAgentsMaxThreads(configPath);
    return legacy === null ? null : v1ChildLimitToV2TotalLimit(legacy);
  }
  const legacy = getAgentsMaxThreads(configPath);
  if (legacy !== null) return legacy;
  const v2 = getMaxConcurrentThreads(configPath);
  return v2 === null ? null : v2TotalLimitToV1ChildLimit(v2);
}
```

Rationale: the function's contract becomes "the effective limit in the units of the
currently active backend", which is what every caller wants. Under V2 it reports the
total-thread limit upstream will actually enforce; under V1 it reports the child limit.

## Diff 3 — the migration itself

MODIFY `src/codex/features.ts` inside `transitionMultiAgentV2` (starts at line 392).
Read the current body at P; the shape is:

```ts
if (enabled) {
  if (!beforeEnabled) {
    const staged = applyConfigEditsAtomically(path, tempPath => {
      const v2 = ensureDisabledV2Config(threadLimit, tempPath, migratedComment);
      if (!v2.ok) return v2;
      return editAgentsMaxThreads(null, tempPath);
    });
```

The change: when the transition derives its V2 value from an existing legacy
`[agents].max_threads` rather than from an explicit caller-supplied `threadLimit`, feed
`v1ChildLimitToV2TotalLimit(legacy)` into `ensureDisabledV2Config`. Symmetrically, the
disable path writes `v2TotalLimitToV1ChildLimit(v2Total)` into `[agents].max_threads`.

An explicit `options.threadLimit` from the caller is already in the target backend's
units and must NOT be translated. This distinction is the whole point of the phase:
translate on *migration of an existing value*, never on a caller-specified value.

Write the exact before/after for this hunk at P after re-reading lines 392-450; the
surrounding rollback machinery must stay byte-identical.

## Accept criteria

1. `[agents].max_threads = 3` + `ocx v2 on` → `features.multi_agent_v2.max_concurrent_threads_per_session = 4`.
2. `features.multi_agent_v2.max_concurrent_threads_per_session = 4` + `ocx v2 off` → `[agents].max_threads = 3`.
3. Round trip 1→2 is identity for every value 1..10.
4. `ocx v2 threads 5` under V2 writes exactly `5`, untranslated.
5. V2 total limit of `1` disabling to V1 writes `1`, not `0`.
6. `getLogicalMaxThreads` returns `null` when neither key is present.

### Activation scenarios (C-ACTIVATION-GROUNDING-01)

Each conditional path needs a test that drives it and an observable proving it ran:

| Path | Trigger | Observable |
|---|---|---|
| V2 active, V2 key present | config with only the V2 key | returned value equals the raw V2 key, no translation |
| V2 active, only legacy key | config with only `[agents].max_threads` | returned value is legacy + 1 |
| V1 active, only V2 key | V2 key present, feature disabled | returned value is V2 − 1 |
| clamp branch | V2 total limit `1`, disable | written legacy value is `1`, and the clamp is exercised rather than inferred |

The clamp branch is the one most likely to be silently dead: assert the written value
directly rather than relying on the suite being green.

## Verification gate

`bun run typecheck` and the features test file, both green, with the six criteria above
as explicit assertions.

## Appendix — translation executed, and the one asymmetry

The two helpers were run under Bun during this planning cycle:

```
round-trip v1 -> v2 -> v1, values 1..10
  child=1  -> v2=2  -> child=1   OK
  child=2  -> v2=3  -> child=2   OK
  ...
  child=10 -> v2=11 -> child=10  OK

v2 total -> v1 child
  total=1 -> child=1
  total=2 -> child=1
  total=3 -> child=2
  total=5 -> child=4
```

**The v1→v2→v1 direction is identity for every value. The v2→v1→v2 direction is not,
and cannot be.** A V2 total limit of 1 means "root only, no children". There is no
legal legacy child count for that state, because upstream constrains the legacy key to
`>= 1`. So `total=1` and `total=2` both map to `child=1`, and re-enabling V2 from
`child=1` yields `total=2`.

Implementation consequences:

1. Do not write a round-trip test asserting identity in the v2→v1→v2 direction. It will
   fail at `total=1` for a correct implementation. Assert identity only for
   v1→v2→v1, and assert the specific clamp behavior separately.
2. Accept criterion 3 in this doc is deliberately scoped to "round trip 1→2 is identity
   for every value 1..10" for exactly this reason. Do not generalize it.
3. If the user's config genuinely holds a V2 total limit of 1, disabling V2 silently
   grants one extra child slot. That is the least-bad option: the alternative is
   writing an invalid `0` that breaks upstream config parsing. Note it in the D summary
   rather than treating it as a bug to fix.

This asymmetry is why the clamp is called out as the branch most likely to ship dead:
it only fires for `total <= 2`, which no realistic default config produces.

---

# Audit fold-back (A-phase, blockers 3, 5, 6)

An independent adversarial review raised three blockers against this doc. All three are
accepted and resolved below. This section supersedes the corresponding parts of Diff 3
and the change map above.

## Blocker 6 (accepted) — the test file does not exist

`tests/codex-features.test.ts` is not a real path. The relevant existing test file is
[`tests/codex-v2-gate.test.ts`](/Users/jun/Developer/new/700_projects/opencodex/tests/codex-v2-gate.test.ts).
The change map's second row is corrected to that path. There is also
`tests/v2-agent-message-failfast.test.ts`, which is unrelated to config migration.

## Blocker 3 (accepted) — Diff 3 must not be deferred, and naive translation double-counts

The full current body, read at `src/codex/features.ts:398-440`:

```ts
  const beforeEnabled = isMultiAgentV2Enabled(path);
  const threadLimit = options.threadLimit ?? getLogicalMaxThreads(path);
  const migratedComment = activeThreadComment(original, beforeEnabled);
  try {
    if (enabled) {
      if (!beforeEnabled) {
        const staged = applyConfigEditsAtomically(path, tempPath => {
          const v2 = ensureDisabledV2Config(threadLimit, tempPath, migratedComment);
          if (!v2.ok) return v2;
          return editAgentsMaxThreads(null, tempPath);
        });
        if (!staged.ok) throw new Error(staged.error);
        toggleFeature(true);
      }
      ...
      if (hasAgentsMaxThreads(path) || getMaxConcurrentThreads(path) !== threadLimit) throw new Error("v2 thread-limit migration postcondition failed");
    } else {
      ...
        return editAgentsMaxThreads(threadLimit, tempPath, migratedComment);
      ...
      if (getMaxConcurrentThreads(path) !== null || getAgentsMaxThreads(path) !== threadLimit) throw new Error("v1 thread-limit migration postcondition failed");
    }
    return { ok: true, changed: readConfigText(path) !== original, threadLimit };
```

**The critical interaction Diff 2 creates.** After Diff 2, `getLogicalMaxThreads`
returns a value already expressed in the *currently active* backend's units. But
`transitionMultiAgentV2` is called precisely when the backend is about to change, so
`threadLimit` at line 406 is in the units of the backend being left, while every write
below it targets the backend being entered.

Translating again inside the branches would therefore double-count. Translating in
neither place leaves the original defect. The correct shape is to translate exactly
once, at the point where the source value crosses the boundary.

AFTER, replacing line 406 and leaving the branch bodies and both postconditions
structurally untouched:

```ts
  const beforeEnabled = isMultiAgentV2Enabled(path);
  // `options.threadLimit` is caller-supplied and already expressed in the DESTINATION
  // backend's units, so it is never translated. A value discovered from config is in
  // the SOURCE backend's units and must cross the root-slot boundary exactly once:
  // enabling V2 means child-count -> total-count (+1), disabling means total -> child (-1).
  // getLogicalMaxThreads already reports in the source backend's units after Diff 2,
  // so translating here and nowhere else keeps the count single-applied.
  const discoveredLimit = getLogicalMaxThreads(path);
  const threadLimit = options.threadLimit ?? (
    discoveredLimit === null
      ? null
      : enabled
        ? v1ChildLimitToV2TotalLimit(discoveredLimit)
        : v2TotalLimitToV1ChildLimit(discoveredLimit)
  );
```

Both postconditions (lines 428 and 438) then remain correct **unchanged**, because
`threadLimit` is now in destination units and those assertions compare the written
destination key against it. That is the reason to translate at line 406 rather than
inside the branches: it keeps the two postconditions honest without editing them.

One subtlety the implementer must not miss. When `beforeEnabled` is already `true` and
`enabled` is `true` (a no-op re-enable), `getLogicalMaxThreads` returns the V2 total and
the code above would add 1 to it. Guard the translation on an actual backend change:

```ts
  const backendChanges = enabled !== beforeEnabled;
  const threadLimit = options.threadLimit ?? (
    discoveredLimit === null || !backendChanges
      ? discoveredLimit
      : enabled
        ? v1ChildLimitToV2TotalLimit(discoveredLimit)
        : v2TotalLimitToV1ChildLimit(discoveredLimit)
  );
```

This is the version to implement. The idempotent-call path is a real code path —
`ocx v2 on` on an already-V2 config reaches it — so it needs its own test.

## Blocker 5 (accepted, scope-bounded) — `saturating_add` versus `+ 1`

Upstream's field is `Option<usize>` and it uses `usize::saturating_add(1)`, which
cannot overflow. JavaScript `childLimit + 1` has no such guarantee at the top of the
numeric range.

In practice the reachable range is bounded by the existing readers: both
`getAgentsMaxThreads` and `getMaxConcurrentThreads` parse `\d+` and reject anything
that is not an integer `>= 1`, and `transitionMultiAgentV2` already rejects a
caller-supplied limit that is not an integer `>= 1`. So a value large enough to lose
precision cannot reach the helpers through any current path.

That makes this a latent rather than live defect, and the fix is a cheap explicit
bound rather than a saturating numeric type:

```ts
/** Largest thread limit we will translate. Well below Number.MAX_SAFE_INTEGER and far
 *  above any real concurrency setting; upstream's usize cannot overflow, ours can. */
const MAX_TRANSLATABLE_THREAD_LIMIT = 1_000_000;

export function v1ChildLimitToV2TotalLimit(childLimit: number): number {
  if (!Number.isInteger(childLimit) || childLimit < 1 || childLimit > MAX_TRANSLATABLE_THREAD_LIMIT) {
    throw new RangeError(`thread limit out of translatable range: ${childLimit}`);
  }
  return childLimit + 1;
}
```

`v2TotalLimitToV1ChildLimit` takes the same guard. Add a boundary test at
`MAX_TRANSLATABLE_THREAD_LIMIT` and one past it asserting the throw, rather than
asserting semantic equivalence with Rust.

## Revised accept criteria

Criteria 1-6 above stand, plus:

7. A no-op re-enable (`ocx v2 on` while already V2) leaves the thread limit unchanged,
   proving the `backendChanges` guard fires.
8. A no-op re-disable leaves the legacy limit unchanged.
9. Both postconditions at lines 428 and 438 still pass unmodified after the change.
10. A limit above `MAX_TRANSLATABLE_THREAD_LIMIT` throws `RangeError` rather than
    silently producing an imprecise value.

### Added activation scenarios

| Path | Trigger | Observable |
|---|---|---|
| `backendChanges` guard false | `transitionMultiAgentV2(true, ...)` on an already-V2 config | written V2 limit equals the pre-call value, not value+1 |
| range guard | limit `1_000_001` | `RangeError`, config bytes unchanged |
| `discoveredLimit === null` | config with neither key | `threadLimit` stays null; `removeMaxConcurrentThreads` path taken |

The `backendChanges` guard is now the highest-risk branch in this phase: without it the
change introduces a *new* off-by-one on idempotent calls while fixing the original one.

---

# P-phase re-verification (2026-07-31, execution cycle)

Stale check against `dev` HEAD `8759e34de`. Every line reference in this doc still
resolves:

| Doc claim | Current tree | Status |
|---|---|---|
| `getLogicalMaxThreads` at `src/codex/features.ts:317` | 316-321 | valid |
| `transitionMultiAgentV2` starts at line 392 | 392 | valid |
| body read at 398-440 | matches verbatim, incl. both postconditions | valid |
| `getMaxConcurrentThreads` ends near 158 | 147-158 | valid |
| `tests/codex-v2-gate.test.ts` exists | 591 lines | valid |

No amendment needed to Diffs 1-2 or to the `backendChanges` guard. Two amendments
below are required, both discovered by reading callers the earlier cycle did not trace.

## Amendment A — the RangeError cannot be thrown where Diff 3 puts it

Blocker 5 adds a throwing range guard to both helpers, and Diff 3 (as amended)
computes `discoveredLimit` at line 406 — **before** the `try {` at line 407. A
`RangeError` raised there escapes `transitionMultiAgentV2` as an uncaught exception
instead of becoming the documented `{ ok: false, error }` result, bypassing the
rollback contract this function exists to provide.

A stored value large enough to trip the guard is reachable: `getMaxConcurrentThreads`
validates with `Number.isFinite(value) && value >= 1`, not `Number.isInteger`, so a
20-digit `max_concurrent_threads_per_session` parses to `1e20` and passes.

Resolution — two-layer API:

1. The helpers keep the throwing guard. They are the canonical translation and the
   throw is what criterion 10 asserts.
2. `transitionMultiAgentV2` **pre-validates** the discovered limit and returns a normal
   error result before touching any bytes, in the same style as the existing
   `options.threadLimit` check at line 396 and `transitionConfigError` at line 403.
   Nothing has been written at that point, so rollback-safety is structural.
3. `getLogicalMaxThreads` is a read path reached from `GET /api/v2` and `ocx v2 status`
   and must never throw. When the stored value is outside the translatable range it
   returns the raw stored number untranslated: at 1e20 the ±1 is already below the
   float's precision, so translating is meaningless while crashing a status endpoint is
   not.

`transitionMultiAgentV2`, replacing line 406 (final form for this phase):

```ts
  const beforeEnabled = isMultiAgentV2Enabled(path);
  const backendChanges = enabled !== beforeEnabled;
  const discoveredLimit = getLogicalMaxThreads(path);
  // A discovered value crosses the root-slot boundary exactly once, and only when the
  // backend actually changes; a caller-supplied options.threadLimit is already in the
  // destination backend's units and is never translated. Validate before the try block
  // so an out-of-range stored value is a normal error result rather than a throw that
  // escapes the rollback contract.
  if (options.threadLimit === undefined && backendChanges && discoveredLimit !== null
      && !isTranslatableThreadLimit(discoveredLimit)) {
    return { ok: false, error: `stored thread limit out of translatable range: ${discoveredLimit}` };
  }
  const threadLimit = options.threadLimit ?? (
    discoveredLimit === null || !backendChanges
      ? discoveredLimit
      : enabled
        ? v1ChildLimitToV2TotalLimit(discoveredLimit)
        : v2TotalLimitToV1ChildLimit(discoveredLimit)
  );
```

with the predicate exported alongside the helpers:

```ts
export function isTranslatableThreadLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_TRANSLATABLE_THREAD_LIMIT;
}
```

## Amendment B — six existing tests assert the defect and must move with the fix

The earlier cycle's change map said "MODIFY `tests/codex-v2-gate.test.ts` — add tests".
Adding is not sufficient: the current suite pins the *untranslated* behavior, so the
fix turns it red. These are behavior updates, not test weakening, and each one is the
defect being corrected:

| Test (line) | Current assertion | Post-fix assertion | Why |
|---|---|---|---|
| `off -> on carries the active legacy value` (218) | legacy 100 → v2 100 | → v2 **101** | the defect itself |
| `on -> off carries the active v2 value` (228) | v2 64 → legacy 64 | → legacy **63** | the defect itself |
| `migration carries the active limit comment` (237) | 100 → 100 → 100 | 100 → **101** → 100 | round trip stays identity |
| `target-only ...` `equal` case (259) | legacy 64 + v2 64 → 64 | → **65** | legacy key is active, so it translates |
| management API `mode-only switches` (318) | 100 both directions | v1→v2 **101**, v2→v1 back to **100** | same defect through the HTTP surface |
| `same-state repair` (245) / `disabled` case (264) | 32 / 100 unchanged | unchanged | `backendChanges` false — these are the guard's regression witnesses |

The `target-only` case (256) needs no change and is worth keeping for a non-obvious
reason: V2 storage `32` under a disabled feature round-trips through
`v2TotalLimitToV1ChildLimit` (31) and back through `v1ChildLimitToV2TotalLimit` (32),
so the two translations cancel and the stored V2 value is preserved exactly. That is
the correct outcome and it silently proves both helpers agree on the boundary.

## Caller impact (traced this cycle)

`getLogicalMaxThreads` has four non-test callers:

- [`src/cli/v2.ts:86`](/Users/jun/Developer/new/700_projects/opencodex/src/cli/v2.ts:86) — status display only.
- [`src/cli/v2.ts:100`](/Users/jun/Developer/new/700_projects/opencodex/src/cli/v2.ts:100) — passes an explicit `threadLimit`, never translated.
- [`src/server/management/agent-settings-routes.ts:112`](/Users/jun/Developer/new/700_projects/opencodex/src/server/management/agent-settings-routes.ts:112) and `:169` — `GET`/`PUT` response payload.

No caller does arithmetic on the value, so the semantic change ("the limit in the
units of the currently active backend") propagates without further edits. The GUI reads
`maxConcurrentThreadsPerSession` for display in `gui/src/pages/Models.tsx` and needs no
change.

## Verification gate for this cycle

`bun run typecheck` plus `bun test tests/codex-v2-gate.test.ts`, with criteria 1-10
asserted and the three activation-scenario tables driven directly.

---

# A-phase fold-back, execution cycle (reviewer verdict FAIL, 3 High blockers)

An independent terra-high reviewer failed the plan above. All three blockers reproduce
against the tree at HEAD `2435b1149`. This section is the final form for every hunk it
touches and supersedes Diff 1, Diff 2, and Amendment A/B where they disagree.

## Blocker 1 (accepted) — Diff 2 still calls throwing helpers, so read paths can throw

Amendment A said `getLogicalMaxThreads` "must never throw" but left Diff 2 unamended,
and Diff 2 calls the guarded helpers directly. `getMaxConcurrentThreads` validates with
`Number.isFinite(value) && value >= 1` (features.ts:156), not `Number.isInteger`, so a
20-digit stored value parses to `1e20` and passes the reader. Under Diff 2 as written
that value reaches `v2TotalLimitToV1ChildLimit` and throws `RangeError` out of
`ocx v2 status` (src/cli/v2.ts:86) and `GET /api/v2`
(src/server/management/agent-settings-routes.ts:112) — a crashed status surface caused
by the very guard meant to make translation safe.

FINAL form of `getLogicalMaxThreads`, replacing Diff 2:

```ts
export function getLogicalMaxThreads(configPath?: string): number | null {
  if (isMultiAgentV2Enabled(configPath)) {
    const v2 = getMaxConcurrentThreads(configPath);
    if (v2 !== null) return v2;
    const legacy = getAgentsMaxThreads(configPath);
    if (legacy === null) return null;
    // Read paths never throw: an out-of-range stored value is reported raw. At that
    // magnitude the ±1 root slot is already below float precision, so translating is
    // meaningless while crashing `ocx v2 status` / GET /api/v2 is not.
    return isTranslatableV1ChildLimit(legacy) ? v1ChildLimitToV2TotalLimit(legacy) : legacy;
  }
  const legacy = getAgentsMaxThreads(configPath);
  if (legacy !== null) return legacy;
  const v2 = getMaxConcurrentThreads(configPath);
  if (v2 === null) return null;
  return isTranslatableV2TotalLimit(v2) ? v2TotalLimitToV1ChildLimit(v2) : v2;
}
```

New criterion 11: an out-of-range stored value returns raw from both read paths and does
not throw, asserted through `ocx v2 status` and the management `GET` — not only through
the helper.

## Blocker 2 (accepted) — one shared maximum breaks the round trip at the boundary

A single `MAX_TRANSLATABLE_THREAD_LIMIT` is self-contradictory: V1 child `1_000_000` is
in range and migrates to V2 total `1_000_001`, which the same predicate then rejects, so
a config this code just wrote cannot migrate back. The maxima must be directional,
because the two units differ by exactly the root slot.

FINAL form of Diff 1:

```ts
/** Largest V1 child limit we translate. Well below Number.MAX_SAFE_INTEGER and far
 *  above any real concurrency setting; upstream's usize saturates, ours would silently
 *  lose precision. */
const MAX_TRANSLATABLE_V1_CHILD_LIMIT = 1_000_000;
/** The V2 side is one larger by construction: it counts the root agent's own slot, so
 *  the image of the maximum V1 value must itself be translatable back. */
const MAX_TRANSLATABLE_V2_TOTAL_LIMIT = MAX_TRANSLATABLE_V1_CHILD_LIMIT + 1;

export function isTranslatableV1ChildLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_TRANSLATABLE_V1_CHILD_LIMIT;
}

export function isTranslatableV2TotalLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_TRANSLATABLE_V2_TOTAL_LIMIT;
}

/**
 * Upstream counts the root agent inside the V2 thread limit but not inside the legacy
 * `[agents]` limit (codex-rs core/src/config/mod.rs resolve_multi_agent_v2_config applies
 * saturating_add(1) to the [agents] value; the inverse saturating_sub(1) appears at
 * mod.rs:1555). These helpers keep our migrations on the same side of that boundary.
 */
export function v1ChildLimitToV2TotalLimit(childLimit: number): number {
  if (!isTranslatableV1ChildLimit(childLimit)) {
    throw new RangeError(`v1 child limit out of translatable range: ${childLimit}`);
  }
  return childLimit + 1;
}

/**
 * Inverse of `v1ChildLimitToV2TotalLimit`. A V2 total of 1 means "root only, no
 * children", which has no representable legacy child count >= 1, so it clamps to 1
 * rather than writing 0 and tripping upstream's `>= 1` validation.
 */
export function v2TotalLimitToV1ChildLimit(totalLimit: number): number {
  if (!isTranslatableV2TotalLimit(totalLimit)) {
    throw new RangeError(`v2 total limit out of translatable range: ${totalLimit}`);
  }
  return Math.max(1, totalLimit - 1);
}
```

`transitionMultiAgentV2`'s pre-validation from Amendment A becomes direction-aware:

```ts
  const translatable = enabled ? isTranslatableV1ChildLimit : isTranslatableV2TotalLimit;
  if (options.threadLimit === undefined && backendChanges && discoveredLimit !== null
      && !translatable(discoveredLimit)) {
    return { ok: false, error: `stored thread limit out of translatable range: ${discoveredLimit}` };
  }
```

Criterion 10 is restated: `1_000_000 → 1_000_001 → 1_000_000` round-trips, and
`1_000_001` as a *V1 child* limit is rejected while the same number as a *V2 total* is
accepted. The single-maximum version of criterion 10 is withdrawn.

## Blocker 3 (accepted) — Amendment B's table was short by two tests

Two further existing tests pin the pre-fix numbers. Both verified by reading them:

| Test | Line | Current | Post-fix | Reason |
|---|---|---|---|---|
| `boolean/inline migration preserves feature and limit comments...` | 205 | `getMaxConcurrentThreads(prefixOnly)).toBe(100)` | `101` | legacy 100 is the source, backend changes |
| `mode v2/v1 preserves the same logical limit` | 464 | `getLogicalMaxThreads(path)).toBe(100)` | `101` | `mode v2` from legacy 100 |
| same test, after `off` | 469 | `toBe(77)` | `76` | V2 total 77 disables to child 76 |
| same test, after `mode v1` | 475 | `toBe(77)` | `76` | same translation |
| same test, after `threads 77` | 466 | `toBe(77)` | `77` unchanged | explicit caller value, never translated |
| same test, after `on` | 472 | `toBe(77)` | `77` unchanged | child 76 re-enables to total 77 |

That test's title also needs correcting: "preserves the same logical limit" is precisely
what the fix stops doing across a backend change. Rename it to
`mode v2/v1 translates the limit across the root-slot boundary`.

The reviewer confirmed no other `tests/*.test.ts` calls the four affected helpers, and
that `tests/codex-inject*.test.ts` only preserves literal config text.

## Reviewer findings accepted without a code change

- Upstream direction and fallback order confirmed independently: V2-native key first,
  then `[agents]` via `.or_else(...saturating_add(1))` at upstream
  `codex-rs/core/src/config/mod.rs:2674`, with the inverse `saturating_sub(1)` at
  `:1555`. The plan's direction is correct.
- The clamp is compatible with the postcondition at features.ts:438 — a V2 total of 1
  disables to `threadLimit === 1`, which is both what gets written (:435) and what the
  assertion compares.
- The "target-only needs no change" claim is true; the two translations cancel.
- Doc drift corrected: HEAD is `2435b1149` (the P-phase table said `8759e34de`, which
  the user's devlog-publication commit superseded mid-cycle); the
  `options.threadLimit` guard is at line 397, not 396.
- The GUI is not purely display-only — `gui/src/pages/Models.tsx` compares and re-sends
  the active-backend value — but since it round-trips the same units it stays coherent.
  No GUI change in this phase.

VERDICT of record: FAIL → all three blockers folded above → re-audit before B.

---

# A-phase fold-back, execution cycle round 2 (verdict FAIL, 2 High blockers)

Second audit round, same reviewer. Both blockers reproduce. This section is the final
form of the transition design and supersedes every earlier statement of how
`transitionMultiAgentV2` derives `threadLimit`.

## Review synthesis (REVIEW-SYNTHESIS-01)

Two consecutive rounds ended with "your assertion-update table is incomplete" (round 1:
2 tests missing; round 2: 2 more assertions missing). Root cause: enumerating red
assertions by *reading* the test file is unreliable — every reader, human or model,
misses entries. Change of method, not another enumeration attempt: the tables below are
kept as a **checklist**, and the authoritative list of changed assertions is produced
empirically in B — run `bun test tests/codex-v2-gate.test.ts` after the source change,
collect every failure, fix each, and record the actual enumerated list in the D summary.

## Blocker 1 (accepted) — the raw fallback loses unit provenance

Round-2's `getLogicalMaxThreads` returns an out-of-range value raw, in whatever units
the source storage used. Round-2's transition then re-derived the source predicate from
the *destination* direction, so a V2-enabled config holding only
`[agents] max_threads = 1_000_001`, disabled, passed the V2 predicate and was converted
to `1_000_000` — a silent mutation of a value that never needed to move.

The real defect is older: the transition asks a *display* function
(`getLogicalMaxThreads`) for a *migration* input, and display semantics ("report the
effective limit in active-backend units, never throw") are the wrong contract for
migration ("know exactly which storage the value came from").

FINAL design — the transition derives the source value with explicit provenance and
never calls `getLogicalMaxThreads`:

```ts
type ThreadLimitUnits = "v1-child" | "v2-total";

/** Which storage the active limit lives in, in that storage's native units. The
 *  active backend's own key wins; the other backend's key is the fallback and keeps
 *  ITS units. Never translates and never throws. */
function discoverStoredThreadLimit(configPath?: string): { value: number; units: ThreadLimitUnits } | null {
  if (isMultiAgentV2Enabled(configPath)) {
    const v2 = getMaxConcurrentThreads(configPath);
    if (v2 !== null) return { value: v2, units: "v2-total" };
    const legacy = getAgentsMaxThreads(configPath);
    return legacy === null ? null : { value: legacy, units: "v1-child" };
  }
  const legacy = getAgentsMaxThreads(configPath);
  if (legacy !== null) return { value: legacy, units: "v1-child" };
  const v2 = getMaxConcurrentThreads(configPath);
  return v2 === null ? null : { value: v2, units: "v2-total" };
}
```

`transitionMultiAgentV2`, replacing line 406 (`const threadLimit = ...`) entirely and
keeping everything else byte-identical:

```ts
  const beforeEnabled = isMultiAgentV2Enabled(path);
  // A caller-supplied limit is already in the DESTINATION backend's units and is never
  // translated. A discovered limit carries the units of the storage it was read from
  // and crosses the root-slot boundary only when those units differ from the
  // destination's — which subsumes the old "backend actually changed" condition and
  // also handles same-state storage migrations (legacy-only under V2, V2-only under
  // V1) that are genuine moves even though the feature flag does not flip.
  const discovered = discoverStoredThreadLimit(path);
  const destinationUnits: ThreadLimitUnits = enabled ? "v2-total" : "v1-child";
  let threadLimit = options.threadLimit ?? discovered?.value ?? null;
  if (options.threadLimit === undefined && discovered !== null && discovered.units !== destinationUnits) {
    const translatable = discovered.units === "v1-child" ? isTranslatableV1ChildLimit : isTranslatableV2TotalLimit;
    if (!translatable(discovered.value)) {
      return { ok: false, error: `stored thread limit out of translatable range: ${discovered.value}` };
    }
    threadLimit = discovered.units === "v1-child"
      ? v1ChildLimitToV2TotalLimit(discovered.value)
      : v2TotalLimitToV1ChildLimit(discovered.value);
  }
```

Case table, each independently verified by walking the code:

| State before call | Call | Source units | Dest units | Result |
|---|---|---|---|---|
| legacy 3, V2 off | enable | v1-child | v2-total | translate → 4 |
| v2 total 4, V2 on | disable | v2-total | v1-child | translate → 3 |
| v2 total 32, V2 off (target-only) | enable | v2-total | v2-total | no translation → 32 (same observable as the old round-trip cancellation, but direct) |
| v2 total 32 + legacy 100, V2 on (repair) | enable | v2-total (own key wins) | v2-total | no translation → 32, legacy dropped |
| legacy 64 + v2 64, V2 off (equal) | enable | v1-child (own key wins) | v2-total | translate → 65 |
| legacy 1_000_001, V2 on | disable | v1-child | v1-child | **no translation → 1_000_001 preserved, no error** (reviewer's fixture) |
| v2 total 1e20, V2 on | disable | v2-total | v1-child | pre-validation fails → `{ ok: false }`, bytes untouched; escape hatch: explicit `options.threadLimit` |
| legacy 100, V2 off | disable | v1-child | v1-child | no translation → 100 |
| neither key | either | null | — | threadLimit stays null |

The reviewer's suggested "reject raw-untranslatable" outcome improves on this: the
legacy-only 1_000_001 case is not an error at all — nothing crosses the boundary, so
nothing is rejected, and the config is left in a valid state that means the same thing.
Rejection is reserved for values that genuinely cannot cross.

Both postconditions (lines ~428, ~438) stay unmodified and honest: `threadLimit` is
always in destination units by construction.

New criteria:

12. V2-enabled + legacy-only `1_000_001` + disable → `{ ok: true }`, the value survives
    in `[agents]` untranslated. The subsequent automatic re-enable is REJECTED —
    `{ ok: false, error }` with config bytes unchanged — because `1_000_001` exceeds
    `MAX_TRANSLATABLE_V1_CHILD_LIMIT` and the storage-translation it would need cannot
    be done safely. Recovery is the documented escape hatch: an explicit
    destination-unit `options.threadLimit`. (Amended in A round 3: the original draft
    claimed an identity round trip, which is impossible under the directional guard —
    the re-enable leg genuinely needs a translation the guard correctly refuses.)
13. V2 total `1e20` + disable → `{ ok: false, error }` with config bytes unchanged;
    retrying with an explicit destination-unit `options.threadLimit` succeeds (the
    documented escape hatch).

## Blocker 2 (accepted) — two more management-API assertions pin pre-fix numbers

Verified at `tests/codex-v2-gate.test.ts:364` and `:368`: after
`{ multiAgentMode: "v2", maxConcurrentThreadsPerSession: 77 }` stores V2 total 77, the
`{ multiAgentMode: "default", enabled: false }` PUT has no explicit limit, so the
discovered V2 total 77 translates to V1 child **76**, and both that PUT's response and
the following GET must expect 76. Added to the checklist below.

## Consolidated assertion-update checklist (checklist, NOT claimed exhaustive)

| Location | Pre-fix | Post-fix | Basis |
|---|---|---|---|
| `off -> on carries the active legacy value` | 100 → v2 100 | → 101 | defect |
| `on -> off carries the active v2 value` | v2 64 → 64 | → 63 | defect |
| `migration carries the active limit comment` | 100 → 100 → 100 | 100 → 101 → 100 | round trip identity |
| `boolean/inline migration...` (:205) | 100 | 101 | defect |
| `target-only...` `equal` case | → 64 | → 65 | legacy source translates |
| `mode v2/v1...` (:464) | 100 | 101 | mode change |
| same test (:469, :475) | 77 | 76 | explicit 77 disables to 76 |
| same test (:466, :472) | 77 | 77 | explicit value / re-enable of 76 |
| management `mode-only switches` | 100 both ways | 101 then 100 | defect |
| management :364, :368 | 77 | 76 | round-2 blocker |

The test at ~443 is renamed to `mode v2/v1 translates the limit across the root-slot
boundary`. In B, run the suite and append any failure not in this table to the D
summary's enumerated list.
