# 810 — Local rebase/consolidation and first main-to-dev regression cycle

## Loop spec

- Archetype/trigger: satisfy-spec first regression cycle under the user's confirmed cutoff/aggregation request.
- Goal: locally rebase all14 inventoried source candidates and independently compare the combined result with pinned dev and main before any publication.
- Non-goals: new debt implementation, unrelated PR changes, intermediate pushes/CI, release/deploy, live-user state or local suites.
- Verifier: recorded range-diffs and extraction/body/type/state/cycle checks, main/current-dev baselines, first801matrix pass, candidate remote full gates and independent review.
- Stop: first complete P/A/B/C/D regression cycle closes with a source-bound candidate receipt and an honest regression report; then enter820. No delivery is claimed here.
- Memory:800inventory/procedure,801matrix, this810, private per-head logs and closeout ledger. Preserve original68goal and all original refs.
- Outcomes: DONE means locally rebased/validated candidate only. Failed or unexplained verification remains incomplete. This is not the final merge cycle.
- Escalation/resources: preserve dirty owners and source identity; semantic conflicts beyond required preservation return to the plan. Existing credentials, task-owned checkouts, remote tests only; unlimited user budget. Main reclaims after two distinct failed workers and records new delegation scope before it is used.

## Exact B work

Execute800steps1–8 with staging refs and the recorded replay boundaries. Each
worker owns only its assigned staging checkout/branch and original layer's
source/test paths; main owns aggregate a2c0, docs, Git publication and receipts.
No worker may push, change an original ref, weaken tests, run a local suite,
change repository workflows, or contact another task.

Only #3570 depends on another open split head: rebase #3557 first, then use
that staged tip as #3570's new base and original97df51515 as its replay
boundary. For other roots use the pinned dev from800. Review every dropped
or altered commit with range-diff and file/content evidence.

The high-risk vision/parser/Claude preservation cases in800 must survive
in their correct moved or retained owner. Rebase is not permission to restore
an older implementation over a newer landed fix. Existing source/test
changes and any necessary preservation repairs become part of the manifest.

Merge staged candidates into the main aggregate during B, preserving their
ancestry/author metadata. Include reviewed central devlog and the frozen
WP480 planning record, explicitly deferred. No new WP480 source is built.

## First regression pass

1. Freeze main48f818 and the selected dev SHA/tree. Classify their full diff,
   including mechanical test relocation versus intentional behavior changes.
2. Run pinned main and current-dev baselines in separate remote temporary
   clones. Inspect their own package/bunfig/test-runner guards first; use
   their own frozen dependencies and repository runtime. Main's scripts/test
   already provides isolated homes and a test-run lock. Never bypass them.
3. Run each baseline's typecheck, build preparation, privacy and full test
   command. Preserve exit codes, complete logs and source identities. A
   baseline failure requires classification; it is not silently waived.
4. Validate the000_3main export snapshot against the pinned source/runtime
   independently. Its14modules/244value-export names were statically captured
   from main, not generated from the candidate. Any temporary probe is kept
   outside committed product source and removed from the disposable checkout
   before its final clean-state claim.
5. For each stack, review old-base→old-head against dev→staged-result and
   execute the relevant original/upstream regression cases remotely. Source
   equivalence and preserved exports/state/cycles are separate from test pass.
6. Run the full801matrix against the aggregate, emphasizing main-compatible
   requests, intentional feature differences and the landed fixes that old
   split bodies could otherwise lose. No blanket equivalence claim from
   aggregate pass counts.

## Unpublished exact-head verification

Intermediate staging refs remain local. For a clean aggregate candidate H,
create a task-owned Git bundle containing H above its pinned dev prerequisite:
`git bundle create <owned>/candidate.bundle HEAD ^<pinned-dev>`.
Transfer it to a fresh remote clone, verify bundle prerequisites, fetch its
HEAD and require FETCH_HEAD=H, then detach at H. The clone must contain the
recorded dev prerequisite. Never switch a shared remote seed checkout.

Use the proven receipt wrapper pattern: main checks its clean expected HEAD
before/after SSH inside `cxc receipt test`; SSH and tee exits propagate with
pipefail; remote uses frozen root/dashboard installs, repository Bun, build,
typecheck, focused/full suites and privacy; final remote HEAD and clean status
must still match H. Git bundle transport replaces early publication, not
identity checks. Record the concrete paths/commands as B creates the harness;
do not claim an unexecuted recipe passed.

## First-cycle acceptance

Repair amendment813 adds one bounded existing-test fixture correction after
the first C watchdog failure was reproduced on pinned dev. The unsuccessful
cycle was reset toP for audit; it was not counted as completed. All source
rebases and prior valid evidence remain preserved. No extra debt layer is
implemented and no test budget or assertion is relaxed.

- All14 original identities are preserved and staged heads are accounted for,
  with correct Cursor dependency ancestry and no unexplained source loss.
- First main→dev/candidate regression report distinguishes intended changes,
  baseline failures and regressions; required repairs are tested, not guessed.
- Main/current-dev/candidate verification uses isolated remote execution;
  candidate has actual full-gate success and a clean source-bound receipt.
- The exact source/manifest and first report pass independent review. No
  intermediate PR/head was published, no old PR closed, and no final delivery
  or second-cycle completion is claimed.
- D closes this local result;820 begins a new P/A/B/C/D cycle with fresh
  contract coverage and final delivery authority.
