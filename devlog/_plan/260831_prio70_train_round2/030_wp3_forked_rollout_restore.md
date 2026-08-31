# 030 — wp3: make history restore id-aware and stop overwriting `has_user_event` (#3026)

Score 75/80. Branch: `codex/3026-forked-rollout-restore`, based on `dev`.
One PABCD cycle.

PR #3056 is half of this. Its half is correct; the other half is untouched, so the
issue cannot close on it.

## Two defects, one symptom

**Defect A — the reader ignores the thread id.** A forked session's rollout file
contains more than one `session_meta` line. `readLatestSessionMeta` returns the last
one regardless of whose id it carries, and three call sites depend on it:
`snapshotRolloutForRestore` (`src/codex/history-provider.ts:552`),
`assertRestoreReadback` (`:631`), and `updateSessionMeta` (`:878`). The tree already
has an id-aware fold at `:680-688`, so this is a wiring defect, not a missing
capability.

One rejected entry fails the whole manifest (`:586-596`), so a single forked rollout
out of 389 wedges every `ocx stop` and `ocx update`. The reporter measured 6/389.

**Defect B — restore forces the manifest's `has_user_event` even when Codex moved it.**
The user does something in the session after the snapshot, the row flips 0 → 1, and
readback rejects it (`:487-500`, `:611-613`), then restore overwrites it from the
manifest (`:1265-1289`). PR #3056 relaxes it only for the relabelled `opencodex`
post-image, which is the narrower case, not this one.

### Amendment after audit round 1 (`002`, blocker 2): OpenCodex writes this field too

The first draft justified the relaxation by calling `has_user_event` Codex-owned and
never written by OpenCodex. That is false. OpenCodex writes it in
`routeOpenai`/`routeExec` (`src/codex/history-provider.ts:1158`) and sets it to `1`
unconditionally in legacy recovery (`:1013`). An existing test *requires* OpenCodex's
own `0 → 1` routing write to restore back to `0`
(`tests/codex-history-provider.test.ts:261`), so blanket preservation would have
broken a contract already under test.

The rule is therefore directional, not permissive:

- Preserve **only monotonic `0 → 1` drift**, never `1 → 0`. Nothing legitimate produces
  the reverse, and accepting it would let a stale manifest erase real activity.
- `has_user_event` **stays** in the CAS and readback for OpenCodex post-images, because
  on that path OpenCodex is the writer and the field is genuine evidence.

### Amendment after audit round 3 (`004`, blocker 2): the tuple is not provenance

The first version of this rule also required the original `model_provider`/`source`
tuple to be untouched, reasoning that an OpenCodex write always moves one of them.
There is a reachable two-step sequence where it does not:

1. Routing takes `openai/vscode/0` to `opencodex/vscode/1`
   (`src/codex/history-provider.ts:1158`).
2. Explicit legacy recovery takes that same row to `openai/vscode/1` — it sets
   `model_provider = 'openai'`, leaves `source` unchanged for any non-`exec` row, and
   sets `has_user_event = 1` unconditionally (`:991`, `:1013`).

The end state is the original tuple with `has_user_event` moved `0 → 1`, and every
write in it was OpenCodex's. The predicate would call that user activity.

**A final state cannot establish authorship when two paths reach it.** So the check
does not infer ownership from the tuple. It needs a transition record:

- The manifest already stores the original tuple, and `rememberOriginal` runs before
  the routing write (`:1152-1154`). Extend the manifest entry with the fact that a
  routed relabel occurred for this row, so legacy recovery's return to `openai` is
  distinguishable from a row that was never routed.
- When the manifest records a routed relabel, `has_user_event` stays a hard CAS term —
  the `1` is OpenCodex's own and must restore to the recorded original.
- Only a row with **no** recorded routed relabel may carry `0 → 1` drift through
  restore. That is the forked-rollout case #3026 actually reports.
- If provenance is unavailable for an entry (an older manifest without the field), see
  the round-4 amendment below — refusing outright would brick every manifest already on
  disk.

### Amendment after audit round 4 (`005`, blocker 1): crash-safety and migration

The round-3 rule had two holes, and the second is a migration hazard.

**Crash-safety.** The manifest is written before routing (`:1152`) and routing can fail
after it (`:1230`, `history_apply_partial_route`). A flag set at `rememberOriginal`
claims a relabel that may never land; a flag set after the write is missing if the crash
falls between. So provenance is a **versioned tri-state**, not a boolean:
`relabel-pending` written before the routing write, resolved to `relabel-committed`
after it, and absent for anything older. A crash leaves `relabel-pending`, which is an
honest "unknown" the restore path can reason about instead of a confident wrong answer.

**Migration.** `CodexHistoryBackupManifest` is `version: 1` with a fixed entry shape and
no provenance field (`src/codex/history-manifest.ts:7-19`), so *every manifest on every
user's disk* lacks it. "Refuse when provenance is unavailable" would therefore refuse
the entire existing population — the exact rows #3026 is about. Corrected rule:

### Amendment after audit round 5 (`006`, blockers 1-2): a disjoint table, and pending resolves by inspection

The round-4 table had two defects. It rejected the *ordinary* routed post-image — a v1
entry recording `openai/vscode/0` whose row is now `opencodex/vscode/1` is a `0 → 1`
drift, and the table refused it, contradicting the live contract at
`tests/codex-history-provider.test.ts:261`. And "refuse every `relabel-pending`" made
the tri-state crash-*detecting* rather than crash-recoverable: a crash after the routing
commit (`src/codex/history-provider.ts:1230`) but before the marker resolves would wedge
restore permanently.

Both come from classifying on the drift instead of on **what the row actually is**. The
observed row falls into exactly one of four shapes, and the shape is decidable:

| # | observed row | meaning | verdict |
| --- | --- | --- | --- |
| A | exactly the recorded original | untouched, or already restored | restore (no-op on the field) |
| B | `rowMatchesExpectedPostImage(row, entry)` returns true | OpenCodex wrote it | `has_user_event` is a hard CAS term; restore to the recorded original |
| C | the **original** tuple with `has_user_event` moved `0 → 1` | Codex-side activity, or route-then-legacy-recover | decided by provenance |
| D | the **expected post-image** tuple with `has_user_event` moved `0 → 1` | routed row, then Codex-side activity | preserve the `1` |

A and B are unambiguous from the row alone. C and D are the two ways `has_user_event`
can differ from what OpenCodex last wrote — before routing (C) and after it (D) — and
they are distinguished by which tuple the row carries, so the four are disjoint.

**Why D exists** (audit round 8, `009`): with `hadFirstUserMessage = false`, the expected
post-image of `openai/vscode/0` is `opencodex/vscode/0`. If the user then sends their
first message the row becomes `opencodex/vscode/1` — not A, not B (B expects the `0`),
and not C (C requires the *original* `openai/vscode` tuple). Round 7's fix correctly
stopped B from swallowing this row and left it matching nothing, so the fallback refused
it. D is where it belongs, and its verdict is the one the round-7 regression asserts:
preserve the `1`.

D needs no provenance. A row wearing the routed tuple was written by OpenCodex by
definition, so a `0 → 1` difference on top of it can only be Codex-side activity that
followed.

### Amendment after audit round 7 (`008`): B already exists in the tree

Rounds 3, 4, 5 and 6 each found a hole in a predicate I kept rewriting for B. Round 7
found two more. The reason is simpler than any of the individual holes:
**`rowMatchesExpectedPostImage` is already in the file**
(`src/codex/history-provider.ts:487-500`). It computes the routed post-image from the
entry, handles the nullable-message branch, and accepts the `openai/cli/1` legacy bridge
at `:496-499` that round 7 caught my table refusing — the one covered by
`tests/codex-history-provider.test.ts:345`.

wp3 does not define a new predicate. It calls the existing one and fixes the single real
defect in it.

#### The defect in the existing helper

`:488` computes `postHasUserEvent` from `hasFirstUserMessage(row.first_user_message)` —
the message as it is **now**. Routing derived it from the message as it was **at snapshot
time**: `:1162` CASes the original value and `:1184` reads it.

Those diverge in a reachable case. An `openai/vscode/0` entry with a null message routes
to `opencodex/vscode/0`; the user then sends their first message and the row becomes
`opencodex/vscode/1`. The helper recomputes the expected post-image from the *current*
non-empty message, gets `1`, declares a match, and restore erases the user's activity
back to `0`.

So the manifest entry must carry the snapshot's message state.
`CodexHistoryBackupEntry` records neither the message nor its emptiness
(`src/codex/history-manifest.ts:7-13`). Add **a boolean**, `hadFirstUserMessage` —
never the text. The manifest is written to disk and the message is user content, so
emptiness is the only privacy-safe form to persist, and it is all the computation needs.

With that field the helper computes from the snapshot, and the case above stops being B
and becomes C — original-tuple drift adjudicated by provenance, which is what it actually
is.

*Corrected by round 8:* it becomes **D**, not C. C is scoped to the original tuple; this
row wears the post-image tuple. See the table above.

### Amendment after audit round 8 (`009`): v1 entries keep the current-row fallback

`hadFirstUserMessage` cannot be recovered for a manifest written before the field
existed. Computing `postHasUserEvent` from `entry.hadFirstUserMessage` unconditionally
would read `undefined` as `false` on every v1 entry and refuse ordinary pre-upgrade
manifests — the migration hazard from round 4, returning through a different door.

So the helper is version-aware:

- **v2 entry** — compute from `entry.hadFirstUserMessage`. Correct by construction.
- **v1 entry** — fall back to `hasFirstUserMessage(row.first_user_message)`, exactly what
  `src/codex/history-provider.ts:488` does today. It is imprecise in the null → non-empty
  case, and that imprecision is the status quo on `dev`; the fix applies to manifests
  written after the upgrade, and does not pretend to repair snapshots that never recorded
  the fact.

`hadFirstUserMessage` is recoverable where it is written: `rememberOriginal`
(`:465`) is called from `:1153` over rows that carry `first_user_message`
(`ApplyRowSnapshot`, `:256-258`). Its signature widens from `ThreadRow` to
`ApplyRowSnapshot`; the value is in scope at the call site today.

#### Why this ends the sequence

Exhaustiveness is now inherited rather than argued: every row `dev` accepts today is
accepted by the same function afterwards, because it is the same function. The two
defects round 6 fixed are subsumed — both were cases the helper already handled.

The lesson, recorded because it cost five rounds: **when a check must decide "did our own
code write this?", call the code that already decides it.** Round 6 got half of it —
derive rather than pattern-match — and still wrote the derivation beside the tree instead
of taking it from the tree.

| provenance on the entry | row C verdict |
| --- | --- |
| `relabel-committed`, route's expected event was `1` | OpenCodex authored the `1` via route-then-legacy-recover; restore to `0` |
| `relabel-committed`, route's expected event was `0` | the `1` cannot be OpenCodex's; preserve it — see below |
| `relabel-none` | genuine user activity; preserve the `1` — the #3026 case |
| absent (legacy v1 entry) | refuse, exactly as `dev` does today |

**Why `relabel-committed` alone is not enough** (audit round 9, `010`). A row can pass
through D and then be pulled back to C by legacy recovery:

1. `openai/vscode/0` with `hadFirstUserMessage = false`;
2. routing produces `opencodex/vscode/0` — expected event `0`;
3. the user sends their first message, giving `opencodex/vscode/1`, shape D;
4. legacy recovery produces `openai/vscode/1` (`src/codex/history-provider.ts:991`),
   shape C.

Provenance still reads `relabel-committed`, and an unconditional verdict would restore
`0` — erasing activity that demonstrably was not OpenCodex's, because the routing write
for this entry produced a `0`.

`hadFirstUserMessage` settles it: when it is false the route's expected event was `0`,
so any `1` observed afterwards came from the user, whichever tuple the row now wears.
The field turns out to be load-bearing in two places, not one.

**Refusing legacy row C is not a regression.** `dev` already refuses it with
`history_backup_postimage_mismatch`; the fix simply does not reach back in time for
manifests written before provenance existed. Every v1 entry in shapes A and B — which is
the overwhelming majority, and the whole population the id-aware read in Defect A
repairs — restores exactly as it does today. Round 4 was right that failing closed on an
entire schema version is wrong; the correction is to shrink the ambiguous set to row C,
not to guess at it.

**Pending resolves by inspection, not by refusal.** `relabel-pending` means "a routing
write was attempted and we do not know if it landed" — and the row itself answers that:

| row under `relabel-pending` | what it proves | resolve to |
| --- | --- | --- |
| shape A | the write did not land | `relabel-none` |
| shape B | the write landed | `relabel-committed` |
| shape C, OpenAI-origin, route's expected event was `0` | the write did not land, activity followed | `relabel-none`, preserving the `1` |
| shape C, **OpenAI-origin**, route's expected event was `1` | **two histories produce this state** | refuse |
| shape C, `exec`-origin (any expected event) | legacy return cannot reach it | `relabel-none`, preserving the `1` |
| shape D — post-image tuple, `0 → 1` | the write landed, activity followed | `relabel-committed`, preserving the `1` |
| anything else | foreign to every outcome | refuse |

**The one genuinely undecidable cell** (audit round 10, `011`). For an OpenAI-origin
entry whose expected route event is `1`, pending + shape C is reachable two ways:

- routing never landed, and Codex-side activity moved the original row `0 → 1` — the
  `1` is the user's and must survive; or
- routing landed as `opencodex/vscode/1`, the process crashed before the marker
  resolved, and legacy recovery rewrote it to `openai/vscode/1`
  (`src/codex/history-provider.ts:991`) — the `1` is OpenCodex's and must restore to
  `0`.

Tuple, provenance and expected event are identical in both. No durable fact left in the
system separates them, so the cell refuses. That is the correct answer rather than a gap:
a coin flip here either erases a user's activity or fabricates it, and refusal leaves the
manifest intact for a human.

The neighbouring cells stay decidable and must not be widened into this one. Expected
event `0` is safe because routing would have produced a `0`, so any `1` is the user's
whatever happened. `exec`-origin entries are safe because `routeExec` moves `source` to
`cli` and legacy recovery does not restore it, so a legacy return cannot land on the
original tuple at all.

Round 8's version accepted only A and B, so a crash on either side of the routing write
followed by ordinary user activity left restore wedged (audit round 9, `010`). D is
always decidable under pending, and so is C except in the single OpenAI-origin cell
above — the tuple says whether the write landed everywhere else, so the blanket refusal
was never necessary.

Resolution is idempotent and can run at restore time, so no third crash window opens: a
crash during resolution just means the next restore resolves again from the same row.

**Provenance is per entry, not per manifest.** `CodexHistoryBackupEntry` carries the
field; the version bump only says the field may be present. A mixed manifest rewritten
forward keeps "this entry predates provenance" distinguishable from "this entry recorded
no relabel", which the round-4 wording lost by overloading absence.

## What changes

1. Add the path-based id-aware wrapper (PR #3056's `readLatestSessionMetaForId()`) and
   use it at all three call sites.
2. Extend `CodexHistoryBackupEntry` with an **optional** `hadFirstUserMessage?: boolean`
   and the versioned tri-state provenance, bumping the manifest version and keeping v1
   readable. Widen `rememberOriginal` (`:465`) from `ThreadRow` to `ApplyRowSnapshot` so
   it can record the flag; the value is already in scope at its call site (`:1153`).
3. Fix `rowMatchesExpectedPostImage` (`src/codex/history-provider.ts:487-500`) to compute
   `postHasUserEvent` from `entry.hadFirstUserMessage` **when the entry has it**, and to
   keep today's `hasFirstUserMessage(row.first_user_message)` reading for v1 entries that
   do not. Keep both existing branches, including the `openai/cli/1` legacy bridge.
4. The restore CAS and readback compare provider and source unconditionally, and resolve
   `has_user_event` through the shape table: B restores to the recorded original, C is
   decided by provenance, D preserves the observed `1`. Where drift is preserved, carry
   the observed value into the restore write instead of forcing the manifest's.

The distinction to hold onto: an integrity check exists to catch OpenCodex writing
something it did not intend. Authorship cannot be read off the final state — round 3
proved two paths reach the same tuple — so it has to be recorded at the time of the
write. What the check narrows on is direction plus recorded provenance, and absent
provenance is treated as compatible for an exact post-image and ambiguous only for
drift.

## Regressions

Both in `tests/codex-history-provider.test.ts`:

1. A rollout whose trailing `session_meta` belongs to the parent thread restores and
   consumes the manifest. RED against `dev` at
   `history_backup_rollout_postimage_mismatch`.
2. A manifest entry captured as `openai`/`vscode` with `hasUserEvent=0`, whose row is
   then changed to `has_user_event=1` by user activity, restores successfully, ends
   with `has_user_event=1`, and deletes the manifest. RED against `dev` at
   `history_backup_postimage_mismatch`, and RED against PR #3056's head too — that is
   the assertion which proves the second half is missing.
3. The existing contract at `tests/codex-history-provider.test.ts:261` still passes:
   OpenCodex's own `0 → 1` routing write restores back to `0`. This one is GREEN before
   and after, and it is the guard that keeps the relaxation from becoming blanket
   preservation.
4. The route-then-legacy-recover sequence from blocker 2: relabel `openai/vscode/0` to
   `opencodex/vscode/1`, then run legacy recovery to reach `openai/vscode/1`, then
   restore. Must restore `has_user_event` to `0` or refuse with an integrity error —
   never accept the `1` as user activity. RED against the round-1 amendment as written,
   which is precisely why it is here.

## Adversarial cases the audit lane asked for

Relaxing a CAS term needs the negative cases pinned in the same commit, or the next
change will relax further:

- a row whose `model_provider` differs from the manifest still fails;
- a row whose `source` differs still fails;
- a rollout whose id-matched `session_meta` is absent entirely still fails.
- a row whose `has_user_event` went `1 → 0` still fails, under either tuple.
- an entry that predates the provenance field **and presents shape C** refuses rather
  than assuming no relabel occurred. Legacy entries in shapes A and B restore normally —
  round 6 caught this line still reading as a blanket v1 refusal, which is the exact
  migration hazard round 4 removed.

Corrected by rounds 4, 5 and 6. Cases to add, one per table row:

- shape A on a v1 entry restores;
- shape B restores `has_user_event` to the recorded original. The existing contract at
  `tests/codex-history-provider.test.ts:261` must stay green — note it builds its manifest
  through the writer, so after the version bump it witnesses **v2**, not v1; the
  hand-constructed v1 case below is what covers v1;
- shape B where the entry has a **null `first_user_message`**, so the computed post-image
  is `opencodex/vscode/0` — restores, keeping
  `tests/codex-history-provider.test.ts:117` green. This is the case the pattern-based
  predicate refused;
- **null → non-empty after routing (shape D)**: a **v2** entry `openai/vscode/0` with a
  null message routes to `opencodex/vscode/0`, the user then sends a first message and the
  row becomes `opencodex/vscode/1`. Restore must **preserve the `1`**. RED against `dev`
  — the current helper recomputes from the present message, calls it B and erases it — and
  red against every earlier version of this plan;
- **an ordinary v1 shape-B entry still restores.** Construct the v1 manifest by hand
  rather than through the writer: `openai/vscode/0` with a non-empty message, routed to
  `opencodex/vscode/1`, no `hadFirstUserMessage` field. Restore must succeed via the v1
  fallback. Round 8 caught `tests/codex-history-provider.test.ts:261` being cited as the
  v1 guard when it generates its manifest through the current writer — after the version
  bump that test exercises v2, so it cannot witness v1 behaviour at all;
- the `opencodex/exec/1` → `opencodex/cli/1` → `openai/cli/1` legacy bridge still
  restores, keeping `tests/codex-history-provider.test.ts:345` green. This is the branch
  at `src/codex/history-provider.ts:496-499` that the round-6 table dropped;
- shape C with `relabel-committed` restores to `0`;
- **D → legacy recovery → C**: the four-step sequence above on a v2 entry with
  `hadFirstUserMessage = false`. Restore must **preserve the `1`** even though provenance
  reads `relabel-committed`. RED against the round-8 verdict table;
- **pending + C** and **pending + D**: a crash on either side of the routing write
  followed by user activity. Both must resolve and restore, preserving the `1`, rather
  than refusing. RED against round 8's A/B-only pending resolution;
  For pending + C this is the **expected-event-`0`** case;
- **pending + C with expected event `1`** refuses. GREEN by refusal, and the assertion
  that keeps the two safe cells from being generalized into the ambiguous one. Pair it
  with an `exec`-origin pending + C case that still restores, so the refusal is scoped
  rather than blanket;
- shape C with `relabel-none` preserves the `1`;
- **legacy shape C only** — a v1 entry with original-tuple `0 → 1` drift — refuses,
  matching `dev`. Legacy shapes A and B restore normally; the refusal is scoped to C
  alone.
- crash between the pending marker and the routing write → row is shape A → resolves to
  `relabel-none` and restores;
- crash between the routing write and its resolution → row is shape B → resolves to
  `relabel-committed` and restores to the original.

The last two are the crash windows, and they assert **recovery**, not refusal. A
tri-state that refuses on pending would be a more elaborate way to wedge.

## Verification

Focused: `bun test tests/codex-history-provider.test.ts`. Suite, typecheck and privacy
scan on `ssh lidge`.

## Close-out

`Closes #3026`. PR #3056 is 630 commits behind `dev`; carry its id-aware reader with
credit to its author rather than rebasing that branch, the same way round 1's wp3
carried Ingwannu's `aec717722`.

## What implementation added beyond this plan

Seven adversarial review rounds against the built branch (findings 3, 2, 1, 1, 2, 2, 0).
The eleven planning rounds got the classifier right; every implementation finding was in
the machinery around it, which is worth recording separately:

- **A surviving manifest has to be re-snapshotted, not just re-marked.** The plan said to
  reopen the relabel marker on a new routing attempt. That was half of it: the entry also
  carries `hadFirstUserMessage` and `hasUserEvent`, and both described the previous
  attempt. The stale message flag made the new routed row match the expected post-image;
  the stale event value restored the thread to a state two events old.
- **Refreshing the baseline needs the same proof the classifier needs.** Tuple equality
  does not establish that the previous relabel was undone — route-then-legacy-recovery
  lands on the original tuple. A restore that lands and passes its readback now records
  `relabel: "none"`, which is the proof. Nothing wrote that value before.
- **A sixth cell, and it refuses.** When the proof is absent and the row has drifted,
  neither reading is safe. That is the plan's undecidable shape arriving one layer up, in
  `rememberOriginal` rather than in the classifier, and it refuses the same way.
- **The decision is direction and origin, not one flag.** Reverse drift is always foreign;
  `0 → 1` is the user's for an exec-origin entry, under a `none` marker, or when the
  previous route would have written 0; everything else refuses, and a legacy `undefined`
  is not `false`.
- **The refusal has to reach a person.** `failureReason: "integrity"` alone reads as
  "retry or run doctor", and an ambiguous reroute is not retryable. The specific code now
  travels through the worker and job layers to an operator message that says the manifest
  needs manual resolution.

And two about verification: a regression that let an ordinary restore consume the manifest
never reached the reopen path at all, and the legacy-return end-to-end test passed because
the fixture's rollout omitted `source`, so restore refused at rollout preflight before the
classifier was consulted. Both were green for reasons unrelated to what they claimed.
