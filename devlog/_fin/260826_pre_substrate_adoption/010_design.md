# #1049 — crash-safe pre-substrate home adoption

## Current facts at `dev@f392e02eb3`

1. `codexWriteCoordinationEligibility` treats every absent/stable-zero-byte coordinator with
   routed or indeterminate native evidence as `legacy-uncoordinated`
   (`src/codex/inject-coordination.ts:87-122`). Invalid integration records refuse before
   residue classification (`src/codex/inject-coordination.ts:93-99`).
2. Apply calls `applyNativeArtifacts()` directly for `legacy-uncoordinated`, without
   `withCodexWriteLock` or `beginTransition` (`src/codex/inject.ts:940-952`). The coordinated
   branch publishes a pending transition before touching native files
   (`src/codex/inject.ts:953-1011`).
3. Restore enters `withCodexWriteLock` only for `coordinated`; every other eligibility falls
   through to the legacy config restore (`src/codex/inject.ts:1536-1554`,
   `src/codex/inject.ts:1641-1647`).
4. The runtime status validator and SQL constraint omit `adoption-pending`
   (`src/codex/transition-state.ts:40-92`), while generation zero rejects all history identity
   and schedule fields (`src/codex/transition-state.ts:211-221`).
5. Missing-database creation opens the final path with SQLite `create:true` before schema and
   singleton initialization (`src/codex/transition-state.ts:349-426`). A kill in that interval
   can leave a final zero-byte or rowless file; existing unversioned and rowless files are then
   deliberately refused (`src/codex/transition-state.ts:283-305`).
6. `withCodexWriteLock` always opens the ordinary coordinator transaction, so routed residue is
   rejected before its callback (`src/codex/codex-write-lock.ts:305-307`,
   `src/codex/transition-state.ts:269-280`). Adoption needs an explicit transaction-open mode;
   changing eligibility alone is unreachable.
7. `adoption-pending` has no runtime occurrence. Its durable publication and recovery rules are
   specified in `devlog/_fin/260804_codex_write_substrate/005_contract.md:706-790` and the
   implementation deferral is recorded in
   `devlog/_fin/260816_wave34_closeout/101_1049_legacy_adoption.md:58-109`.

## Exclusions and necessity gate

- Do not infer authority from indeterminate evidence. It remains legacy-operable and
  uncoordinated; only positively classified routed residue is adoptable.
- Do not add an artifact fingerprint. The archived correction explains that byte equality cannot
  prove whether the retained callback started or partially completed; recovery must rerun the
  idempotent high-level operation.
- Do not delete or clear the singleton. Adoption advances the same durable row to the ordinary
  positive-generation pending schedule.
- Do not relax ordinary clean initialization or the existing unversioned/rowless refusals.
- Do not add a second lock or a history-worker path. Adoption reuses N and the existing apply/remove
  transition publication; workers still see only ordinary `pending` rows.

Configuration and deletion cannot solve the issue: the missing behavior is durable migration of
an already-routed home. Existing `beginTransition` is reused for adoption completion, while a new
publisher is necessary because no existing owner atomically publishes a complete SQLite database.

## Root-cause hypotheses and falsifiers

- H1 (accepted): eligibility bypass is the sole cause. Falsifier: route routed residue to the
  ordinary lock and observe successful callback entry. Current `assertInitialStateCanBeCreated`
  rejects before callback, disproving sufficiency and showing the missing adoption opener.
- H2 (rejected): adding `adoption-pending` only to the TypeScript union is sufficient. Falsifier:
  persist such a row. Current SQL status and generation-zero shape constraints reject it, so schema,
  runtime validation, and creation must move together.
- H3 (rejected): create the final SQLite file and then fill it under N. Falsifier: terminate after
  final-path creation but before commit. The next opener sees an unversioned/rowless authority and
  refuses; therefore publication must make the complete database visible in one atomic step.

The causal mechanism is structural: pre-substrate residue cannot seed the ordinary clean row, so
eligibility bypasses N; direct writes then never create transition authority. Adoption must publish
a distinct recoverable generation-zero row before native mutation, under the same N acquisition
that serializes the retained callback, and then atomically advance it to the ordinary pending
transition.

## Design

### State shape

Add durable `history_status = 'adoption-pending'`. Its exact generation-zero identity is:

- `native_generation = 0`, `current_tx_id = NULL`;
- fresh non-empty `history_tx_id`;
- intent-derived `history_direction = apply | remove`;
- fresh opaque non-empty `history_authority_snapshot_id`;
- null reason/retry/count fields and zero attempts.

Generation zero accepts either the existing all-null `unknown` row or that complete adoption
identity. `beginTransition` conditionally replaces either with generation one (or the next positive
generation) and the ordinary `pending` schedule. Ordinary readers may report adoption-pending, but
no history worker dispatches it because worker scheduling remains gated on `pending`.

### Publication

When and only when eligibility says `adopt`, `withCodexWriteLock` opens the coordinator in an
adoption mode carrying `apply | remove` intent. If the final path is absent:

1. Create a unique same-directory mode-0600 temporary file.
2. Open SQLite at the temporary path, create the complete v1 schema and adoption singleton in a
   committed rollback-journal transaction, set `user_version = 1`, and close SQLite.
3. Reopen/validate the temp database through the same row parser, fsync its bytes, then close it.
4. Atomically publish without replacement using same-directory `linkSync(temp, final)`. `EEXIST`
   means a contestant won; unlink only this process's temp and strictly open the winner.
5. Fsync the parent directory, unlink the temp alias, then open the final path normally and begin N.

No SQLite handle crosses publication. No post-publication error path unlinks the final database.
Existing final paths, including unversioned or rowless files, always take strict validation and are
never rewritten by adoption.

### Eligibility and callers

- routed residue + missing or valid integration record + absent/stable-zero-byte coordinator:
  `adopt`;
- indeterminate residue: retain `legacy-uncoordinated`, preserving current operability;
- clean: `coordinated`; invalid record: `refused`; any authoritative existing coordinator:
  `coordinated` and strict opener validation.

Apply and restore treat `adopt` as coordinated with the matching intent. The adoption row is visible
before either retained native callback runs. The existing callback then calls `beginTransition`
before filesystem mutation, replacing adoption-pending with ordinary pending in the same SQLite
transaction. If callback publication or mutation throws, rollback leaves adoption-pending durable;
the next authorized apply/restore reruns idempotently.

### Crash-state table

| Kill point | Final path after death | Next authorized operation |
| --- | --- | --- |
| after temp creation, before SQLite commit | absent | ignores private temp; republishes |
| after complete temp commit, before link | absent | ignores private temp; republishes |
| after no-clobber link, before alias cleanup | complete validated adoption-pending | opens and resumes |
| after final open / during retained callback | complete adoption-pending or ordinary pending | reruns adoption callback or existing recovery |

The publication primitive is the only absent-to-present boundary. Thus every observable final path
is either absent or a complete validated v1 database.

## Files and verification

- `src/codex/convergence-types.ts`: durable status type.
- `src/codex/transition-state.ts`: schema, row validation, complete temp publisher, adoption opener.
- `src/codex/codex-write-lock.ts`: explicit adoption intent passed to the transaction owner.
- `src/codex/inject-coordination.ts`: routed adoption classification.
- `src/codex/inject.ts`: apply/restore route `adopt` through N.
- focused tests beside coordinator/injection tests, including child-process kill checkpoints,
  routed and indeterminate classification, and substrate-native unaffected behavior.

Required proof:

```text
bun x tsc --noEmit
bun test tests/codex-inject*.test.ts tests/codex-composed-acceptance.test.ts <all tests found by rg to touch inject-coordination>
```

Each new regression is mutation-checked by reverting its production hunk, observing the named test
fail for the intended reason, restoring the hunk, and rerunning green.
