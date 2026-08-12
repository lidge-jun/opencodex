# Audit round 4 — synthesis, and the scope decision

Verdict: **FAIL**, 8 blocking (3 Critical, 5 High) plus 3 Medium. Fresh reviewer,
auditing the replan rather than the design its three predecessors rejected.

This round reads differently from 1-3, and the difference is the point.

## What the reviewer confirmed

- The semantic inversion is **directionally correct** for Claude Code and Grok,
  and correct as a principle for Desktop bookkeeping.
- Every refusal has a constructible fixture — the reachability question that
  failed round 1 is closed.
- `appliedProfileId` genuinely needs the parser work `014` claims. I verified
  this independently: `assertExactKeys` (`desktop-profile.ts:97-52`) THROWS on an
  unknown field, so adding the marker without the parser change breaks the next
  config load outright.
- The conservative `custom-local`/`custom-remote`/`unknown` refusal is defensible
  for a destructive GUI switch.
- Docs satisfy LEXICO-SPLIT-01 and each client has a diff-level doc.

So the direction survived. What failed is a specific, nameable gap.

## The one real hole: pre-states have nowhere to live

Findings #1, #2 and #5 are one defect seen three ways.

I designed `NativeClient.capture()` returning a typed state and `apply()` taking
it back — and never said where that state lives between the two. The existing
`JournalEntry` (`journal.ts:34-51`) carries one `configPath`, one `SnapshotRef`,
one `resultFingerprint`: a file-shaped row. A boolean, a routing description, or
three library members do not fit it.

`030` papered over it with "carried in the operation record", which named a
field no phase adds. That is the same class of error as round 1's unreachable
`home_mismatch`: I asserted a mechanism instead of specifying it.

And it invalidates my prettiest claim. I wrote that idempotent re-apply removes
crash ambiguity. The reviewer is right that it does not: idempotence helps once
a state EXISTS, and a crash between mutation and journal append means no state
was ever recorded. Nothing to re-apply is not a state to re-apply idempotently.

## The claim I got wrong on my own evidence

Finding #3. I built "unrelated config cannot be clobbered" on
`saveConfigPreservingClaudeCode`, and its own docstring says the opposite —
`src/config.ts:2132-2135`, verified directly:

> Scope residual: only `claudeCode` is reconciled. A hand edit to `providers` is
> still clobbered — recorded and asserted in tests so it cannot drift into an
> assumed guarantee.

"So it cannot drift into an assumed guarantee" is the maintainer warning
precisely against what I then did. Worse, the reviewer found the sharper case:
when disk and caller both changed `claudeCode`, the caller's whole stale subtree
wins (`config.ts:2145-2151`), so flipping one toggle field can clobber a
concurrent Desktop-profile edit — inside the very subtree I claimed was safe.

`011`'s acceptance criterion "an unrelated config edit survives the toggle" is
therefore **false as written**. It needs a field-scoped write that reloads from
disk and touches only named paths, or the claim must be narrowed to what the
existing writer actually provides.

## Disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Critical | Pre-states not durably journaled | **Accept** — needs a versioned discriminated entry |
| 2 | Critical | Crash between mutate and append erases the undo state | **Accept** — prepare/commit, my idempotence claim was wrong |
| 5 | Critical | Desktop's 3 library members do not fit `SnapshotRef` | **Accept** — same defect as #1 |
| 3 | High | Config isolation claim is false | **Accept** — field-scoped write or narrow the claim |
| 4 | High | Codex pre-state too small; no selector API exists | **Accept** — `injectCodexConfig` takes a concrete `catalogPath` |
| 6 | High | Desktop ordering is pointer-safe, not crash-safe | **Accept** — say so, add phase markers |
| 7 | High | Journal widening not type-safe end to end | **Accept** — split the domains properly |
| 8 | High | Preflight-vs-dialog timing contradicts | **Accept** — GET must carry preflight status |
| 9-11 | Medium | Route debris, phase-label drift, ordering | **Accept** |

Nothing rebutted.

## The decision this round forces

Four audits, four FAILs. Rounds 1-3 rejected a design; round 4 says the new
direction is right but **incomplete in a way that is not small**: a durable
operation-state schema, a prepare/commit protocol with restart reconciliation,
and a field-scoped config writer. That is real engineering work, and every one
of the four clients needs it before ANY of them can ship.

Which finally answers a question I have been avoiding since round 1: is the
rollback machinery proportionate to the feature?

For **Claude Code** and **Grok** — no, and it never was:

- Claude Code's undo is flipping one boolean back. It needs no journal, no
  snapshot, no pre-state schema. It is a switch that already exists on the
  Claude tab; this work only moves it onto a card.
- Grok's undo is `syncGrokConfig` — the enable path. Turning it back on
  regenerates the fence from the catalog. The byte snapshot was never the undo
  mechanism; it was insurance against a botched strip, and `stripGrokConfig` is
  already fence-scoped and preserves user content.

For **Codex** and **Desktop** — yes, genuinely. Codex touches four artifacts and
a live database; Desktop writes into another application's registry and cannot
re-derive the user's previous selection. Those two are where the durable
operation state earns its cost.

## Next

Split the unit:

- **`260803_integrations_toggle_all`** keeps Claude Code and Grok, re-scoped to
  the toggles they actually need: no pre-state schema, no journal changes, undo
  by re-running the enable path. Small enough to audit once and build.
- **A new unit** owns Codex and Desktop, starting from the durable
  operation-state schema round 4 named as the missing shared dependency, then
  the two clients as parallel siblings.

That is not scope-shrinking to escape the loop (LOOP-CONTINUE-01): the objective
is unchanged and all four still get toggles. It is the phase map finally
matching the dependency structure the audits kept pointing at — which is what
PHASE-SPLIT-01 asks for, and what round 4 #11 says the client-shaped split still
was not.
