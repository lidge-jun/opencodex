# wp3 — live verification, screenshots, push and PR

Neither defect is provable by unit test alone: both were reported against a running
dashboard, and `enforce-target` requires a screenshot for any GUI-mentioning PR. This
phase is the evidence phase.

## Build and load order

1. `bun run build:gui` — the service serves `gui/dist`, so an unbuilt change is
   invisible no matter how green the tests are.
2. Load the rebuilt code in the isolated scratch instance and confirm its identity
   and fresh uptime on `/healthz`. The completed isolation record supersedes the
   original `ocx service restart` plan; do not restart, repoint or reconfigure the
   user's working proxy.
3. Query the scratch instance's `/api/provider-quotas` with its admin token — the meta-muse row must now
   carry `"observed": true`. This is the wire-level proof, checked before the UI so a
   blank screen can be attributed correctly.

## Browser verification (aside CLI repl on the signed-in profile)

The dashboard is loopback and needs no login, so `aside repl` is the right surface:
one invocation is one session, it throws on a bad path instead of skipping, and the
screenshots land as real files. A whole inspect-act-verify flow must fit in a single
invocation because bindings do not persist between calls.

The planned capture set covered the Usage quota display, the Usage and Accounts
refresh controls, and the post-click success state. The completed record in
`031_live_verification_record.md` preserves the observed outcomes.

Those live captures were subsequently removed from the current tree under one
retention rule for both surfaces: account and usage screenshots from a real
operator profile are unnecessary once the behavioral evidence is recorded in
text. The planned filename list is also retired; it differed from the delivered
filenames and must not be treated as an asset inventory.

The plan required each `aside` invocation to run under
`perl -e 'alarm shift; exec @ARGV' 300` because macOS has no `timeout` and the bare
spelling exits 127 without starting the run.

## Push and PR

- Branch `codex/260904-provider-quota-refresh`, commits as the phases close.
- `git push --no-verify` — explicitly authorized by the requester.
- PR against `dev` with the full template: Summary, Verification, Checklist, and the
  screenshots inline. `enforce-target` rejects a thin description and a GUI PR with
  no screenshot.
- The suite line in Verification must state plainly which focused files were run and
  that the repository-wide suite was withheld at the requester's instruction, rather
  than implying a full green run.

## Criteria closed here

c-1 (Meta renders), c-2 (Accounts refresh), c-3 (Usage refresh), c-5 (push + PR).
c-4 closes at the end of wp2 with the command output.
