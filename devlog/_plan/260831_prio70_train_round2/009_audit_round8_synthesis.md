# 009 — audit round 8: the fourth shape, and a v1 fallback

First resumed round — same reviewer as round 7, judging whether its own two blockers
closed. That is the right shape for a closure round: it could tell a real fix from a
restatement without re-deriving the history, and it confirmed one closed and found that
the other had moved rather than resolved.

**Closed:** the exec legacy bridge. `030` now retains both branches of the existing
helper, including `openai/cli/1`. Also confirmed: `hadFirstUserMessage` is recoverable
where it is written — `rememberOriginal` (`src/codex/history-provider.ts:465`) is called
at `:1153` over rows carrying `first_user_message`, so only its signature widens, from
`ThreadRow` to `ApplyRowSnapshot` (`:256-258`). And `native-residue`, the other manifest
consumer, touches only validated id and path, so the entry-shape change does not reach
it.

## Blocker 1 — the row I rescued from B landed nowhere

Round 7's fix stopped shape B from swallowing the null → non-empty row. It did not give
it a home.

With `hadFirstUserMessage = false` the expected post-image of `openai/vscode/0` is
`opencodex/vscode/0`. After the user's first message the row is `opencodex/vscode/1`:
not A, not B (B expects the `0`), and **not C** — C requires the *original*
`openai/vscode` tuple, and this row wears the routed one. I wrote "it becomes C" without
checking C's own definition, so the plan's own regression could not pass under the plan's
own classifier.

The fix is a fourth shape, not a broader third one. `has_user_event` can drift from what
OpenCodex last wrote in exactly two places — before the routing write and after it — and
the tuple says which: original tuple is C, post-image tuple is D. D needs no provenance,
because a row wearing the routed tuple was written by OpenCodex by definition, so drift
on top of it can only be activity that followed.

## Blocker 2 — the required field would refuse ordinary v1 manifests

Computing from `entry.hadFirstUserMessage` unconditionally reads `undefined` as `false`
on every manifest written before the field existed, which refuses ordinary pre-upgrade
shape-B entries. That is round 4's migration hazard arriving through a different door,
which is worth noting: the same class of mistake has now appeared twice in this phase
from two different directions.

The field becomes optional and the helper version-aware — snapshot boolean for v2,
today's current-row reading for v1. The v1 path stays as imprecise as `dev` is now, which
is the honest bound: the fix cannot repair snapshots that never recorded the fact.

**And the test I cited as the v1 guard is not one.** `tests/codex-history-provider.test.ts:261`
builds its manifest through the current writer, so after the version bump it exercises
v2. A v1 regression has to construct the manifest by hand. Round 8 caught a guard that
would have gone green while guarding nothing — the vacuous-test class, found in my own
verification plan rather than in a contributor's PR.

## Blocker 3 — the round count drifted again

`000` and `070` both still said six rounds after `008` landed. Third recurrence, and
round 9 caught the "written once from now on" claim as itself false — the number still
appears in both files. It is a two-place fact in a document set that will not be
restructured mid-flight; the honest fix is to check both on every round, not to claim a
mechanism that does not exist.
