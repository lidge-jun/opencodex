# Audit round 2 — synthesis

Verdict: **FAIL**, 8 blocking (1 Critical, 7 High) plus 2 Medium. Same reviewer,
re-audited against the amended docs with the round-1 synthesis attached.

Round 1's direction survived: compound snapshots, three-state outcomes, the
ownership preflight, the async API, the scoped-down id widening and the
no-survivor refusal are all confirmed closed *in concept*. Round 2 is about
where those concepts are still leaky — plus one finding that is my own editing
failure.

## The embarrassing one first

**Finding #2 — the amended docs still contained the entire rev-1 design after
the rev-2 design.** My `apply_patch` edits replaced the sections I targeted and
left the originals below them, so `010` and `020` each prescribed two
contradictory contracts, and the stale halves re-introduced findings #1, #2, #4
and #9 verbatim.

That is not a design disagreement, it is a documentation defect that would have
shipped the rejected design to whoever implemented the second half of the file.
Both files are now truncated at the rev-2 boundary and `000` is reconciled.

Lesson recorded because it will recur: when amending a doc after an audit,
verify the file has ONE contract afterwards — `grep '^## '` and read the
headings back. A patch that adds a corrected section is not the same as a patch
that removes the wrong one.

## Root causes of the rest

### RC-4 — I let persisted data name a write destination

Finding #1 (Critical). My compound member carried `absPath`, and restore wrote
to it. So the snapshot file — which is just JSON on disk, hand-editable and
corruptible — became a list of destinations. The store's containment guards
(`journal.ts:83-105`) protect the snapshot's own path, not what it points at, so
a crafted member could target any user-writable file.

The fix is a boundary rule worth stating once: **snapshots supply bytes, code
supplies paths.** Members are keyed, restore resolves each key through the
current spec, and an unknown key is refused before any write.

### RC-5 — I moved the "committed with no handle" hole instead of closing it

Finding #4. Round 1 taught me that a partial mutation must not report as a
refusal. I fixed that at the mutate boundary and left the same hole at the
journal boundary: `appendJournal` after a successful mutation, unguarded. A
throw there leaves artifacts changed, a snapshot on disk, and nothing in the
Rollback Centre pointing at it.

Worse, the stale rev-1 text I failed to delete still argued *for* that
behavior — "it does NOT compensate a failed journal append" — so the document
contradicted its own fix.

Fixed with prepare/commit: the row is written BEFORE the mutation and resolved
after. A prepared-only row naming its snapshot is exactly what recovery needs.

### RC-6 — I asserted a mechanism instead of specifying it

Findings #6 (Desktop config member), #8 (lock matrix), #10 (error classification).
In each case I named the right idea and left the diff-level detail out, which is
precisely what DIFFLEVEL-ROADMAP-01 exists to prevent:

- The Desktop member set covered Desktop's files but not the opencodex config
  the same operation writes, so a restore returns the library while our side
  still says disabled.
- "One coordinator with a fixed acquisition order" never named the order, the
  API, or the ~9 other config writers in `agent-settings-routes.ts` that would
  still race it.
- `removeDesktop3pConfig`'s outer catch mapped every failure — unreadable
  `_meta.json`, parse error, failed write — to `unowned_profile`, which tells a
  user to resolve ownership when their file is actually corrupt.

## Disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Critical | Snapshot paths trusted as restore destinations | **Accept** — keyed members, spec-resolved targets |
| 2 | High | Rev-1 blocks left in the amended docs | **Accept** — both files truncated, `000` reconciled |
| 3 | High | Desktop snapshot omits opencodex config | **Accept** — 4th member, restored last |
| 4 | High | Journal append can strand a mutation | **Accept** — prepare/commit |
| 5 | High | Legacy Desktop ownership unproven | **Accept with variation** — see below |
| 6 | High | `appliedProfileId` needs schema + carry-through | **Accept** — pulled into WP2 scope |
| 7 | High | Codex history exclusion is a real inconsistency | **Accept** — semantic restore, not a DB copy |
| 8 | High | Lock matrix asserted, not specified | **Accept** — canonical order + `acquireMany`, scope narrowed |
| 9 | Medium | `discardSnapshot` failure unspecified | **Accept** — structured result, orphan maintenance |
| 10 | Medium | Desktop IO errors mislabeled as ownership refusals | **Accept** — separate `unsafe`/`write_failed` |

### Variation on #5

The reviewer is right that the legacy fallback has only one real proof: a
display name and a generic loopback-gateway shape are both user-constructible.

But refusing every legacy install outright would strand users who applied before
`appliedProfileId` existed — they cannot disable at all until they re-apply,
which is a strange thing to demand before allowing an *un*-apply.

So: legacy removal is **refused by default** with a specific, actionable
refusal — `legacy_profile_unverified`, which explains that the profile predates
ownership tracking and offers re-apply as the one-click path to make it
removable. Re-apply writes the id, and the id makes removal provable. The user
is never stuck, and we never delete on a guess.

### On #7

Taking the reviewer's own suggested shape: do not copy the live SQLite
database. Restore file members by key, then call the existing history sync in
the matching direction using its backup manifest, and report `partial` when that
step fails. This replaces rev 2's "excluded, and the dialog says so" — an
exclusion the reviewer correctly read as leaving a real cross-artifact
inconsistency rather than merely an unbacked-up extra.

## Still open after this round

Nothing rebutted. All 10 folded in. Round 3 goes to the same reviewer.
