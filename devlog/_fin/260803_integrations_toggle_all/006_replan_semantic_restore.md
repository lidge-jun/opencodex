# Replan — undo is a state, not a set of bytes

Written at the P re-entry after three FAIL rounds (`003`, `004`, `005`).
Supersedes the substrate design in `010` and the member design in `020`; those
two docs are retired and replaced by `011`–`014` below. `001`, `002`, `030` and
`040` survive with amendments named here.

## The wrong primitive

Rounds 1–3 kept finding new holes in one design: a compound byte snapshot with a
journal, restored file by file. Every finding was correct, and together they
specify a multi-file transactional store with per-member drift detection and
crash recovery.

That is a bigger, riskier artifact than the feature justifies — and round 3 #4
shows it does not even produce the right answer. Snapshotting opencodex's
`config.json` and restoring it byte-for-byte would roll back provider edits,
account changes, and everything else the user did after the disable. A rollback
that reverts a week of unrelated settings is worse than no rollback.

The six file clients can use byte snapshots because for them the file **is** the
integration. Ours are state spread across a config file we share with every
other setting, another application's registry, a model catalog whose path can
move, and a SQLite database. For those, "put the bytes back" and "put the state
back" are different operations, and only the second is what a user means by undo.

## The primitive

Each native client declares a typed **pre-state**: the smallest description from
which its integration can be re-established. Undo re-applies that description
through the same code path that established it in the first place.

```ts
export interface NativePreState<T> {
  clientId: NativeIntegrationClientId;
  capturedAt: string;
  /** Everything needed to put this client back the way it was. */
  state: T;
}
```

Consequences that fall out, each closing a finding rather than patching it:

- **No path is ever persisted** (r2 #1, r3 #7). A pre-state holds values, not
  destinations; re-applying resolves paths through the same functions the
  original apply used. The Codex catalog cannot be restored to the wrong file
  because nothing writes a catalog path from stored data.
- **Unrelated config cannot be clobbered** (r3 #4). Desktop's pre-state is four
  fields, re-applied through `saveConfigPreservingClaudeCode`, which already
  merges rather than replaces.
- **Per-member drift collapses to per-field compare-before-commit** (r3 #5). We
  compare the four fields we own, not a whole-file fingerprint that a
  neighbouring edit invalidates.
- **Prepared-crash ambiguity mostly disappears** (r3 #2, #3). Re-applying a
  pre-state is idempotent, so "did the mutation run?" stops being a question
  restore has to answer. It re-establishes the state either way.

## Byte snapshots stay where a file IS the integration

Two cases genuinely are single-file and wholly ours, which is exactly what the
existing substrate already handles well:

| Client | Byte snapshot | Why |
|---|---|---|
| Grok | `~/.grok/config.toml` | The fence is the whole integration; the file is not shared with our other settings |
| Desktop | `<library>/<id>.json` + `_meta.json` | Another app's registry; we cannot re-derive the user's previous `appliedId` any other way |

Desktop is the hybrid and the reason this is not a clean split: its **library**
needs bytes (we do not own `_meta.json` and cannot reconstruct it), while its
**bookkeeping** needs semantics (our config holds a hundred unrelated things).
One operation, two mechanisms, and the docs must say so plainly rather than
pretend one covers both.

## The four are not alike — split the phases

Rounds 1–3 tried to build all four on one substrate because it looked tidier.
Three audits say they are not alike. Splitting them lets the two easy ones ship
while the two hard ones get the design they need:

| Phase | Client | Mechanism | Risk |
|---|---|---|---|
| WP1 | Claude Code | pre-state: one boolean | trivial — no external file |
| WP2 | Grok | byte snapshot, existing substrate | low — single owned file, `stripGrokConfig` exists |
| WP3 | Codex | pre-state: routing kind + catalog selector; history via its own sync | high — multi-artifact, delegates to `restoreNativeCodex` |
| WP4 | Desktop | hybrid: library bytes + config pre-state | highest — another app's state, new removal path, schema work |
| WP5 | routes + coordinator | — | medium |
| WP6 | dialog + cards | — | low |

WP1 and WP2 are independently shippable and independently verifiable. That is
the practical payoff of the replan: two of the four toggles can be real and
tested before the hard design is finished, instead of all four waiting on the
riskiest one.

## Carried forward, unchanged

These survive the replan and bind whatever the new phase docs say
(LOOP-CONTINUITY-01, full table in `005`):

- A partial mutation never reports as a refusal (r1 #2).
- `home_mismatch` needs the ownership preflight to be reachable (r1 #5).
- Desktop ownership needs a persisted id plus a payload marker; legacy refuses
  (r1 #7, r2 #5).
- The no-survivor case refuses (r1 #8).
- A journal failure must not strand a mutation (r2 #4).
- `appliedProfileId` needs schema and carry-through (r2 #6).
- `withLocks` sorts AND deduplicates, with reentrancy defined (r3 #8).
- Corrupt `_meta.json` is `unsafe`, not an ownership refusal (r2 #10).

## Verification rule earned in round 3

Heading-level checks are not contract-level checks (r3 #9). Every amendment pass
from here greps the CLAIMS — member counts, type names, refusal values, "cannot
be restored" statements — across all unit docs and reads each match in context
before re-audit.

## Next

`011`–`014` replace `010` and `020`. `030` and `040` are amended for the split
phase map and the pre-state result shape. Then A, with the same reviewer and
this replan attached.
