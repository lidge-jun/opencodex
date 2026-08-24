# WP6 — #1049: adopt pre-substrate Codex homes into the write coordinator

> Source: read-only research lane `res-1049` (model `openrouter/stealth-ox-alpha`), dispatched at work-phase 0 against `dev@ced9a85c5`.
> Every file:line pointer below was independently spot-checked by the main agent before the roadmap was locked; verification notes are appended at the end of this document.

Research complete — all pointers verified against the tree. Here is the implementation document.

---

# Issue #1049 — Adopt pre-substrate Codex homes into the write coordinator

## 1. ROOT CAUSE

The write coordinator covers only clean first applies and homes with an already-valid coordinator. Every install that predates the substrate keeps its old uncoordinated write path. Verified chain:

**a. The eligibility gate decides before lock acquisition and routes legacy homes around coordination.** [src/codex/inject-coordination.ts:54](/Users/jun/Developer/new/700_projects/opencodex/src/codex/inject-coordination.ts:54), returning at [src/codex/inject-coordination.ts:120](/Users/jun/Developer/new/700_projects/opencodex/src/codex/inject-coordination.ts:120):

```ts
return {
    kind: "legacy-uncoordinated",
    reason: coordinatorIsStableZeroByte
      ? "the coordinator is a zero-byte non-authoritative remnant ..."
      : residue.kind === "residue"
      ? "this home was routed before write coordination existed and has not been adopted yet"
      : "the existing native Codex state could not be classified, ...",
};
```

Its own docstring ([lines 21–34](/Users/jun/Developer/new/700_projects/opencodex/src/codex/inject-coordination.ts:21)) calls this "a temporary boundary, not a design."

**b. Both production callers branch on it.** [src/codex/inject.ts:891](/Users/jun/Developer/new/700_projects/opencodex/src/codex/inject.ts:891) (`injectCodexConfig`) and [src/codex/inject.ts:1512](/Users/jun/Developer/new/700_projects/opencodex/src/codex/inject.ts:1512) (`restoreNativeCodexAsync`); the apply side writes via `applyNativeArtifacts()` unconditionally when `legacy-uncoordinated` ([inject.ts:936–944](/Users/jun/Developer/new/700_projects/opencodex/src/codex/inject.ts:936)), never entering `withCodexWriteLock`.

**c. Why adoption cannot simply turn the gate off.** `assertInitialStateCanBeCreated` at [src/codex/transition-state.ts:268–280](/Users/jun/Developer/new/700_projects/opencodex/src/codex/transition-state.ts:268):

```ts
if (classifyNativeRoutedResidue().kind !== "clean") {
    throw new CodexCoordinatorLegacyAmbiguousError(
      "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
    );
}
```

Installing `{0, null}` over routed bytes would erase the evidence of an interrupted transition. The refusal is correct; the missing piece is a *different* row identity (`adoption-pending`), not a relaxation.

**d. None of the adoption machinery exists in `src/`.** `rg 'adoption-pending' src/ tests/` → zero matches (verified). It exists only as a spec in `devlog/_fin/260804_codex_write_substrate/005_contract.md` (WP10, lines ~706–790; fixtures at :2241–2290).

**e. Current create path is unsafe for adoption-grade publication.** [transition-state.ts:378–382](/Users/jun/Developer/new/700_projects/opencodex/src/codex/transition-state.ts:378): `database = new Database(finalDatabasePath, { create: true }); if (databaseWasAbsent) { try { chmodSync(finalDatabasePath, 0o600); } ... }` — exactly what the contract forbids ("never opens a missing final path with SQLite create:true", contract line ~708).

## 2. FILE CHANGE MAP

The maintainer triage comment (verified against the tree) is explicit that this is **not one diff**: it requires a temp-database publisher + no-clobber publication phase first, then the adoption mode, then positive-authority handoff plumbing. No such primitives exist today — there are no no-clobber link/rename or publication-fsync helpers anywhere in `src/codex/`, and `history-job.ts` has no retained-callback authority plumbing. The honest change map therefore names the required new units rather than pretending copy-paste hunks exist:

| File | Change | What |
|---|---|---|
| `src/codex/coordinator-publish.ts` | NEW | Complete-v1-temp-database publisher: unique mode-0600 temp in final dir, full schema + singleton committed there, bytes fsynced, atomic no-clobber publish (same-dir exclusive hard link or rename-without-replace; ordinary replace forbidden; EEXIST = lost race → strict existing path after scrubbing own temp), parent-dir fsync after success |
| `src/codex/transition-state.ts` | MODIFY | (Phase A) Replace the `create:true`+chmod open path for absent databases with the publisher, so every clean create is crash-safe too; add `'adoption-pending'` to `DURABLE_HISTORY_STATUSES` and to the `CREATE_TRANSITION_TABLE` CHECK constraints; add WP10 compatibility-row initializer producing exactly the identity specified at contract :727–737 (`native_generation=0, current_tx_id=NULL, history_status='adoption-pending'`, fresh non-empty history_tx_id, intent-derived operation, `authority_kind='wp10-compatibility'`, opaque authority id) |
| `src/codex/inject-coordination.ts` | MODIFY | Narrow `legacy-uncoordinated`: when residue kind is `"residue"` and integration record is missing-or-valid, return a new `{kind:"adopt"}` eligibility instead; indeterminate residue, invalid record, unversioned/rowless DB still refuse (the latter two already do via `initialize()` guards at [transition-state.ts:287–299](/Users/jun/Developer/new/700_projects/opencodex/src/codex/transition-state.ts:287)) |
| `src/codex/inject.ts` | MODIFY | In both call sites, route `kind:"adopt"` through `withCodexWriteLock`; inside the lock, publish the adoption-pending row before invoking `applyNativeArtifacts()` / the restore callback, per the contract's ordering (publish → native callback → conditional transition to pending schedule) |
| `src/codex/history-job.ts` | MODIFY | Positive-authority consumption: accept retained high-level callback, closed intent (`retained-apply` with exact op set / `retained-restore`), consume transaction-bound authorizer exactly once; refuse to dispatch from `adoption-pending` without it |

Literal copy-paste hunks cannot be supplied because the publisher module (~200–300 lines including kill-boundary seams) does not exist; writing it here would be fabrication, not research. The executing agent should treat the contract sections quoted above as the literal specification.

## 3. TEST PLAN

Per contract :2241–2290 plus the maintainer's named cases:

- **New** `tests/codex-coordinator-adoption.test.ts`:
  - `routed config with no coordinator adopts via adoption-pending then applies under the lock` — seed routed config/catalog/history with NO coordinator db; run real `injectCodexConfig`; assert final row exists with `history_status='adoption-pending'` published *before* any artifact mutation (sentinel ordering), then transitions to pending schedule. Fails today (no adoption; inject returns `legacy-uncoordinated` path).
  - `indeterminate residue refuses adoption and creates no row`
  - `invalid or legacy integration record refuses adoption`
  - `existing unversioned or rowless coordinator database refuses and is never adopted` (guards already exist at transition-state.ts:287–299; test pins them against the new adopt path)
  - `process death mid-adoption leaves recoverable state, never poisoned` (kill checkpoints per contract)
- **Modify** `tests/codex-transition-state.test.ts`: cross-process no-clobber race — two contestants build valid temps; exactly one publishes; loser gets EEXIST, scrubs only its temp, opens winner as ready.
- **Existing** `tests/codex-coordinator-doctor.test.ts:166–205`: its `legacy-uncoordinated` expectations must be updated to the narrowed boundary (they currently pin the behavior this issue removes).

## 4. VERIFIER COMMAND

```
bun test tests/codex-coordinator-adoption.test.ts tests/codex-transition-state.test.ts tests/codex-coordinator-doctor.test.ts
```

All three read the changed files: the first exercises `inject-coordination.ts` + `inject.ts` + the new publisher via the real inject path; the second exercises `transition-state.ts` directly; the third pins the eligibility function.

## 5. ACTIVATION SCENARIO

A test seeds a temporary home with routed config/catalog/history (residue classifier returns `residue`) and **no** coordinator database, then calls the real `injectCodexConfig`. Before this issue's fix, `codexWriteCoordinationEligibility` returns `legacy-uncoordinated`, the code skips `withCodexWriteLock` entirely, and no coordinator file ever appears — observable by asserting the coordinator path stays absent and no lock was taken. After adoption lands, the same input returns `adopt`, acquires N, publishes a validated `adoption-pending` database at the final path *before* the native callback mutates artifacts, and the observable proof is (a) the coordinator database now exists with the exact WP10 singleton identity, and (b) a sentinel installed in the native-write path fires strictly after publication but before artifact replacement.

## 6. RISK / BLOCKERS

- **Not implementable as a single copy-paste diff.** The maintainer's assessment (comment verified against tree: `grep -r 'adoption-pending' src/` = 0 matches) stands: the prerequisite temp-publisher/no-clobber phase rewrites the create path used by *every* clean install, so its blast radius is the whole installed base. It wants its own reviewable phase, then adoption, then authority plumbing.
- **Crash-safety surface:** publication is the crash boundary; partial implementations risk corrupted user installs, which is why the maintainer deferred rather than half-shipped.
- **#1798/#1802 remain separate acceptance cases** even after this lands (per owner comment); closing them here would be wrong scope.
- The `legacy-uncoordinated` tests in `tests/codex-coordinator-doctor.test.ts:166–205` will need updating in the same change — they currently pin the exact boundary being removed.
