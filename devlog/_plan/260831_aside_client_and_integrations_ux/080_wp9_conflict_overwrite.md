# wp9 — overwrite a conflict with defaults

Independent of wp7/wp8 in code; ordered after them in the stack because they
touch the same page and a three-way overlap on `IntegrationsOverview.tsx` is not
worth reviewing.

## The dead end today

`classifyIntegration` reports `conflict` for two reasons and the writer refuses
both unconditionally (`writer.ts` apply branch):

- `unowned-key` — our fragment paths are occupied by a value we did not write,
  or there is no ownership record at all.
- `foreign-edit` — the recorded block's bytes changed, or a comment-capable
  format drifted at file level.

The GUI mirrors that: `FileIntegrationPage` sets `locked` for conflict and
`OverviewCard` disables the switch. So the only recovery is to open the file and
edit it by hand, which is precisely what a user reaching for a dashboard is
avoiding. The refusal is correct as a default — it is what stops us deleting
someone's work — but "correct default" and "only path" are different things.

## Design: an explicit, snapshotted, journaled force

The escape hatch is a THIRD operation, not a flag that weakens apply.

`src/integrations/writer.ts` gains `overwriteIntegration(input)` and
`overwriteIntegrationCoordinated(input, options)`, next to apply/refresh/disable.
It differs from apply in exactly one place: where
`applyOrRefreshIntegration` returns `refuse(clientId, "conflict", ...)`, this
path continues. Everything else is shared, which is the point — the snapshot,
the atomic write, the compare-before-commit recheck, the ownership record and
the journal row all come from the same `commit()` call apply uses.

Two properties it must NOT relax:

- `unsafe` still refuses. A blocked container means our write would replace a
  value the merge cannot reason about; forcing that is data loss with a receipt,
  and 005's rule for marks applies here too — the snapshot is not a licence.
- `not_installed` and `non_loopback` still refuse. Neither is a conflict.

The merge base is the parsed document as it stands, and the recorded fragment
paths are removed first WHEN A RECORD EXISTS — the same `removeFragments` call
the stale-refresh path makes. Without that, forcing over a drifted block leaves
orphans the new record does not cover, exactly as the refresh comment documents.

The audit asked what happens in the other case, and it is worth writing down
because the answer looks like a bug and is not. `unowned-key` with NO record
gives `removeFragments` nothing to remove, so the merge runs against the
user's document with their values in our paths. `createdContainerPaths`
(`merge.ts`) then walks the same paths and records a container only where one
is NOT already a plain object — so every container the user already had is
correctly attributed to them, and the `createdContainers` we persist is
empty or near-empty. A later disable removes our leaves and leaves their
containers standing. That is the right outcome: we did not create those
containers, and pruning them would be the second act of destruction after the
one the user explicitly authorized.

What the audit was right to flag is the `record!` non-null assertions in the
disable branch, whose comment records a real TypeError shipped that way. The
force path must not reuse them: it reaches the merge with a possibly-null
record by design, so it takes the apply-side code, where `record` is already
nullable, and never the disable-side code.

New journal kind: `overwrite`. It could reuse `apply`, and that is the tempting
shortcut, but the rollback list is the one place a user goes after a mistake and
"applied" is a lie about an operation that replaced someone else's block.

The kind string is declared in THREE independent places, none of which imports
another — the audit enumerated them and the plan originally named only two:

- `src/integrations/journal.ts:22` — `export type OperationKind`, the persisted
  vocabulary.
- `src/server/management/integration-routes.ts:73` — the route's own
  `IntegrationJournalRow.kind` union, re-declared rather than imported.
- `gui/src/pages/integrations/integration-api.ts:57` — the GUI's union, also
  re-declared, because the GUI does not import backend types.

Plus `JOURNAL_KIND_KEY` in `overview-clients.ts`, which is an exhaustive
`Record<IntegrationJournalRow["kind"], TKey>` — so the compiler catches a missing
entry there, and only there. The two re-declared unions drift silently: a row
persisted as `overwrite` would fail no type check and render as an untranslated
key. A guard asserting the three declarations agree is worth more than the
feature test.

The new i18n key goes into nine locale files. `gui/tests/locale-parity.test.ts`
already enforces key-set parity and additionally fails a zh-TW value left
identical to English unless it is allowlisted, so a placeholder translation is
not an option here.

Undo is not special-cased: `restoreIntegration` already restores from the
snapshot by `opId` and does not care which kind produced it. The regression test
proves that end to end rather than asserting it here.

## Route

`src/server/management/integration-routes.ts`, the `PUT
/api/client-integrations/:client` handler. The body today is `{enabled:
boolean}`. It gains an optional `overwriteConflict?: boolean`, validated the
same way `confirmDrift` is on the restore route: present-and-not-boolean is a
400 `invalid_overwrite_conflict`.

`enabled: false` plus `overwriteConflict: true` is a 400, not a silent ignore.
Disabling a block we do not own is the deletion this whole subsystem exists to
prevent, and a caller asking for it has misunderstood the field.

`writerFailureResponse` needs no new branch: an `unsafe` refusal from a forced
call is still `integration_unsafe`.

## GUI

`FileIntegrationPage.tsx` — when `status.state === "conflict"`, a
`btn-danger` button appears beside the locked switch, opening a
`ConsequenceDialog`. The switch stays locked; the button is the only way
through.

`IntegrationsOverview.tsx` — the same action on a conflicted card, reusing the
existing `ConsequenceDialog` and `pendingToggle` focus-restore machinery.

`ConsequenceDialog` copy needs the file path, the sentence that the current
block is replaced by opencodex defaults, the sentence that a snapshot is taken
and the operation is undoable from the rollback list, and a confirm label that
is not "OK". Nine locales.

The reason matters in the copy: `unowned-key` means "a block we did not write
is in the way", `foreign-edit` means "your edit to our block will be
discarded". Same operation, materially different thing being lost, so two
`changes` strings selected on `status.reason`.

## Tests

Backend, driven red first:

1. force apply over `unowned-key` succeeds, writes our block, journals kind
   `overwrite`, and `restore` of that op returns the original bytes exactly.
   Falsify by leaving the conflict refusal in place.
2. force apply over `foreign-edit` drops the recorded fragments before merging,
   so no orphan survives. Falsify by merging without `removeFragments`.
3. force apply over `unsafe` still refuses. Falsify by moving the force branch
   above the unsafe check.
4. `{enabled: false, overwriteConflict: true}` is a 400. Falsify by ignoring
   the combination.
5. a normal apply is unchanged — no `overwriteConflict` means the conflict
   refusal still fires. Falsify by defaulting the field to true.

GUI, driven red first:

6. the overwrite button renders only for `conflict`, and never for `absent`,
   `current`, `stale`, `unsafe` or not-installed. Falsify by widening the
   condition to `unsafe`.
7. clicking it does not mutate until the dialog is confirmed. Falsify by wiring
   the button straight to the mutation.
8. the dialog names the config path. Falsify by dropping the `path` var.

## Verification

Focused backend files run in CI, not locally (the full local suite is
forbidden). `cd gui && bun test tests` for the GUI files. A screenshot of a
conflicted client page is worth having but needs a conflicted config to exist;
the GUI test asserting the button's presence is the real gate.
