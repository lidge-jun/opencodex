# wp2 — the 2.58.0 release

Published. 2.58.0 is on `main` and `preview`, tag `v2.58.0` names the release commit, the GitHub
release exists, and `npm publish` returned success with a signed provenance statement. Registry
propagation is tracked at the end.

## Sequence, with evidence

| Step | What happened | Evidence |
| --- | --- | --- |
| Land the native control stack | Five layers replayed onto `dev` one at a time, each verified before its push | #4782 → `519db59b31`, #4858 → `3ec1af6209`, #4861 → `fa26404d7b`, #4911 (= #4864 head `77c65e1a99`) → `f671934f02`, #4912 (= #4868 head `5c79b218a6`) → `5061f2c956` |
| Freeze the candidate | `dev` tip `5061f2c956`, `package.json` 2.58.0 | — |
| Full-platform regression | `ci.yml` dispatched with `lane=all` | Run `35247708168`: all nine Windows shards, all four Linux shards, `gates`, `docs site build`, keyring and npm-global on all three platforms, `storage policy`, `api usage`, `docker smoke` green. macOS capacity cancellations were the only non-green entries. |
| Move `dev`'s version line | `dev-version-bump.yml` run `35253998264` opened #4916, merged as `4655d32f88` | `dev` now 2.59.0, which is what `release.yml` requires before it will publish 2.58.0 |
| Promote to `main` | #4915 merged as `6fe4cd0de8` | Merge commit from the frozen candidate; tree identical to `5061f2c956`. `enforce-target` red by design, as for #4829 and #4694. |
| Prove the release SHA | `Cross-platform CI` push run on `main` at `6fe4cd0de8` | Green after one re-run for a cancelled macOS shard. `release.yml` refuses to publish without this, and its first dispatch (`35254221472`) failed exactly there. |
| Publish | `release.yml` run `35257765967`, version 2.58.0, tag `latest`, dry-run false, `expected-sha=6fe4cd0de85d63b8cdd0c3552e5e8883c0a029ee` | `validate-dispatch` and `publish` both success. Publish step ends `+ @bitkyc08/opencodex@2.58.0`; provenance in the sigstore transparency log at logIndex 2879474742. GitHub release `v2.58.0` created 17:40:35Z, tag points at `6fe4cd0de8`. |
| Promote to `preview` | #4917 merged as `48e1ddba0b` | `git diff origin/main HEAD` empty; no version-line conflict this time |

## Three things worth recording

**A green pull request is not a green merge result.** #4824 and #4817 each stayed under
`tests/server/server-combo-failover-e2e.test.ts`'s file-size cap on their own branch and each
reported an honest green. Merged in sequence they summed to 4207 lines against a cap of 4166, so
every pull request built on that `dev` failed the ratchet with the same single offender. Exact-head
CI is structurally unable to see "what happens after a sibling touches the same file", and
`updateBaseline` only ever lowers a cap, so no tool could absorb it. #4908 moved one test into a
sibling file, byte-for-byte, the way `d3ca5522db` did for the same situation.

**Dispatching a stale ref runs that ref's CI definition, not the current one.** Two evidence
dispatches of draft fork trees failed on Windows and looked like a systemic defect in `dev`. The
branches pre-dated #4876, and `workflow_dispatch` reads the workflow file from the dispatched ref,
so those runs used a `ci.yml` without `OCX_TEST_NO_QUEUE` and reproduced the batch-serialization
bug #4876 had already fixed — visible in the log as `waiting for test run pid … to release the user
lock` followed by eight minutes with no test result. Merging current `dev` into the evidence branch
removed it and all nine Windows shards passed. #4901 records the correction; the earlier claim of a
Windows test-harness class was withdrawn.

**Rebasing a stacked child drops whatever lived only in its merge commits.** Replaying #4864 lost
seven lines its author had added inside a merge commit — the paragraph documenting that the owned
connection has no absolute lifetime cap — and left a new test file referencing a field the rename
had removed. Neither is a conflict git can report. Both layers after that were checked for the same
shape before pushing, and #4868 carried the identical defect in `ws-steering-completion.test.ts`.

## Native control stack: what shipped, and what enabling it still needs

Both flags remain default-off, so an installation that does not opt in sees no behaviour change.
Contracts confirmed in the replayed trees rather than assumed: the account and physical socket are
preserved, a failed steering or injection is never reported as success, steering deadlines are
finite (90s submission, successor and continuation; 30 minutes for a tool wait), sparse terminal
output is preserved and an output that contradicts completed wire items fails explicitly, and the
settings pin relaxes for exactly four generation parameters while model, routing, tools,
instructions and multi-agent stay pinned.

Three conditions remain before recommending activation. #4850's caller-owned preview read fence
matters because an injection create is that request shape and this stack pins the create-time
preview result across the whole chain. Eligibility now widens from injection-only to
injection-or-steering, so a public API route can own a steering channel, and the canonical ChatGPT
wire for these frames is still unproven from any source — decide the two routes separately. The
owned connection itself has no absolute lifetime cap; the per-stage deadlines are finite but 128
responses times a 30-minute tool wait can be composed on one pinned credential.

## Registry propagation

`npm publish` succeeded and npm answered that the package "is being processed and may take a few
minutes to become available". The workflow's own post-publish registry smoke read it repeatedly
without confirming and recorded `verification=pending`, continuing to the GitHub release without
republishing. Reads from this machine still returned `E404` for 2.58.0 and `latest` still pointed at
2.57.0 several minutes after the publish, which is the same behaviour 2.57.0 showed. **Do not
republish.** The publish is acknowledged with provenance; inspect the registry before announcing
availability.

