# Audit round 3 — synthesis, and the decision to replan

Verdict: **FAIL**, 7 blocking. Third consecutive FAIL on the same plan, which
under LOOP-REPAIR-01 is the signal to stop patching and return to P with a
changed plan rather than run a fourth round of the same shape.

Two findings are confirmed closed: the legacy `legacy_profile_unverified`
refusal is accepted as a hard refusal, and sorted multi-lock acquisition
establishes a common order (pending dedup/reentrancy rules).

## What three rounds actually taught

Each round closed its predecessor's findings and produced new ones at the next
layer down. That is not the audit being unreasonable — re-reading the three
reports together, they converge on one thing I kept not doing:

**I am designing a general-purpose transactional file store, and I keep
discovering that I have designed one badly.**

Round 1: snapshots must cover every artifact. Round 2: and must not name their
own destinations, and must survive a journal failure. Round 3: and must
fingerprint every member for drift, and handle prepared-crash recovery, and not
restore a whole config file over unrelated later edits, and resolve a catalog
path that may itself have moved.

Every one of those is correct. Together they describe a multi-file
transactional rollback engine with per-member drift detection and crash
recovery — which is a substantially larger and riskier thing than "let the user
turn four integrations off", and which the six file clients deliberately never
needed because each of them mutates exactly one file.

## The finding that reframes the unit

Round 3 #4 is the one that changes my mind. Snapshotting opencodex's whole
`config.json` and restoring it byte-for-byte would roll back unrelated settings
the user changed after the disable — provider edits, account changes, anything.
A "rollback" that silently reverts a week of unrelated configuration is worse
than no rollback.

The reviewer's amendment is right and it points somewhere bigger: **restore
should be semantic, not byte-level.** Restore the four Desktop bookkeeping
fields through `saveConfigPreservingClaudeCode`, not the file. Reconcile Codex
history through its own sync, not a SQLite copy (round 2 #7, already accepted).
Resolve the Codex catalog through a validated selector, not a captured path
(round 3 #7).

Three independent findings, one answer: for the native four, a byte-level
snapshot is the wrong primitive. The file clients can use one because their
whole integration IS a file. Ours are state spread across files, a database, and
our own config, where "put the bytes back" and "put the state back" are
different operations and only the second is what a user means by undo.

## The replan

Returning to P (LOOP-REPAIR-01, three failed rounds). The next P inverts the
primitive:

- **Semantic restore per client**, expressed as a typed pre-state — Desktop's
  four bookkeeping fields plus its profile payload; Codex's routing kind plus
  its catalog selector — with each client owning how to re-establish it.
- **Byte snapshots kept only where a file genuinely is the whole integration**:
  Grok's `config.toml` and Desktop's `<id>.json`. Both are single files we
  wholly own, which is exactly the case the existing substrate already handles.
- **Scope split.** Claude Code and Grok are one work-phase and could ship
  behind the existing machinery almost immediately. Codex and Desktop are their
  own work-phases because each needs a semantic pre-state, and Desktop
  additionally needs the `appliedProfileId` schema work.

That last point is the honest one: rev 1 through 3 tried to build all four on
one substrate because that seemed tidier. Three audits say the four are not
alike. Splitting them lets two ship safely while the two genuinely hard ones get
the design they need.

## Carried forward (LOOP-CONTINUITY-01)

Findings that survive the replan and must be satisfied by whatever the next P
produces:

| From | Finding | Still binding |
|---|---|---|
| r1 #2 | Partial mutation must not report as refusal | yes |
| r1 #5 | `home_mismatch` needs a real trigger | yes — preflight design stands |
| r1 #7 | Desktop ownership needs proof, not a display name | yes |
| r1 #8 | No-survivor case refuses | yes |
| r2 #1 | Snapshots supply bytes, code supplies paths | yes |
| r2 #4 | A journal failure must not strand a mutation | yes |
| r2 #6 | `appliedProfileId` needs schema + carry-through | yes |
| r3 #2 | Prepared rows need a terminal state | yes |
| r3 #3 | Prepared-crash recovery must be specified | yes |
| r3 #4 | Never restore unrelated config | **drives the replan** |
| r3 #5 | Per-member drift, not one fingerprint | yes |
| r3 #7 | Dynamic paths need validated selectors | yes |
| r3 #8 | `withLocks` dedup + reentrancy | yes |
| r3 #9 | Content-level stale sweep, not just headings | yes — process rule |

## Process rule earned this round

Round 3 #9 caught contradictions my `grep '^## '` check missed: "all of it" vs
three members vs "FIVE" vs four; `000` still saying three artifacts; dialog copy
still saying history is not restored after I had accepted semantic restoration.

Heading-level verification is not contract-level verification. The next
amendment pass greps the CLAIMS — member counts, type names, refusal values —
across every doc in the unit, and reads each match in context.
