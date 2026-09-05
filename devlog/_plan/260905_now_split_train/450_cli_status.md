# 450 — S14 L1 — CLI status probe extraction

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Delivered history; later final delivery and successful post-merge follow-up below govern.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move, C3 CLI/module refactor; main owns the goal and persisted PABCD.
- Goal: extract the existing health/stale-process probes while preserving status/doctor behavior and all original exports. Implementation basis is `d2b4a81c61294c3c9ae7a2d58a01397167b120d0` from verified prerequisite PR #3640, now merged into `dev` as `ebb0e5e174e0cc035d4e7ffa668c25652bd1caca`. PR #3633 therefore keeps `dev` as its target. The547-line basis source still matches the original1362b1a38 inventory byte-for-byte.
- Scope: MODIFY `src/cli/status.ts`, NEW `src/cli/status-probes.ts`, MODIFY existing `tests/cli/cli-status-json.test.ts` for forwarding assertions, and add the planned ownership row in `structure/01_runtime.md`. Unit documents and isolated verification evidence are included.
- Non-goals: changed timing, liveness/refusal semantics, snapshots, rendering/schema, service/auth/runtime resolution, generic diagnostics, other S14 implementations, releases or live-service changes. This layer's admin merge is authorized after the final-head gates below.
- Verifier: this document's remote-only Verification recipe, structural/export identity review, named mutation controls, and exact-head CI. No local suites.
- Stop: all layer criteria actually verified, this layer admin-merged with expected-head/tree and fetched-dev ancestry proof, and evidence recorded; close D and immediately continue the remaining goal. Do not stop merely on a wait timeout.
- Resource scope: local source/docs/Git and configured origin PR/CI maintenance; isolated SSH `lidge` checks. Existing configured credentials only, never printed. User authorized unbounded time/tokens and gpt-6-astra high delegation; no live-proxy/service changes.
- Delegation: one worker owns only the two source paths and existing test; main owns SoT/docs/Git/remote checks. Independent audit and check review are read-only. Main reclaims a packet after two distinct failed workers; new write scope requires a P amendment.
- Bounds: planned source churn is below500 and non-move wiring/tests below150 under003. Stale symbols, new cycles, oversized leaves or semantic changes require re-planning, not silent waivers.

Structural decision: lane 016:390–401 identifies probes behind `collectStatus` as the seam. Current map is `src/cli/index.ts:51` / `src/cli/doctor.ts:15` / two test importers → `status.ts` → process-state, liveness and diagnostics dependencies (`status.ts:1–21`). Intended map is the same consumers → retained status boundary → `status-probes.ts` → the existing process-state/liveness/HTTP/process-control owners. Blast radius is the CLI diagnostic feature, not server lifecycle. Doing nothing leaves 547 lines; deleting or configuring cannot remove required diagnostics; reusing an unrelated probe would change semantics. Move the existing implementation intact, not a new abstraction. Existing `src/cli/status-oauth.ts:1` and `src/cli/version-skew.ts` establish the concern-named sibling convention.

## Symbol inventory

Ranges were checked with `git show origin/dev:src/cli/status.ts | nl -ba` and ast-grep declaration ranges. They include syntax, not preceding comments. Every owned top-level declaration is listed; imported bindings are dependencies, not new declarations. Consumer counts are distinct **external importing files**: `rg -l -w '<symbol>' src gui/src scripts tests`, then inspect the hits for imports resolving to this file and exclude the defining file. Private symbols therefore have zero external consumers. `ListenTarget` in PowerShell and `collectStatus` in a capabilities comment are not importers. File fan-in: **4** (2 production, 2 tests).

Aliases: `P` = `src/cli/status-probes.ts` (new); `R` = `src/cli/status.ts` (residual).

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| HealthCheck | type | 23–30 | no | 0 | P |
| CliStatusJson | type | 32–106 | yes | 0 | R |
| CliStatusView | type | 108–112 | yes | 0 | R |
| ListenTarget | type | 115–121 | yes | 0 | P |
| StatusListenConfig | type | 123–123 | no | 0 | R |
| statusDashboardUrl | function | 125–136 | no | 0 | R |
| selectListenTarget | function | 138–153 | yes | 1 | R |
| resolveStatusPid | function | 156–161 | yes | 1 | R |
| proxyHealthFailureReason | function | 163–167 | yes | 1 | P |
| isConnectionRefused | function | 175–185 | yes | 1 | P |
| isUncleanExitEvidence | function | 214–230 | yes | 1 | P |
| unusedProxyWarningLines | function | 244–253 | yes | 2 | R |
| checkProxyHealth | async function | 255–280 | no | 0 | P |
| probeUncleanExitState | async function | 295–331 | yes | 1 | P |
| collectStatus | async function | 333–547 | yes | 1 | R |

The one-consumer predicates resolve to `tests/cli/cli-status-json.test.ts:9`; `probeUncleanExitState` to `src/cli/doctor.ts:15`; `collectStatus` to `src/cli/index.ts:51`. `unusedProxyWarningLines` has that index consumer plus `tests/service/autostart-health.test.ts:3`.

## Leaf partition

1. **`src/cli/status-probes.ts` — 168 lines, ceiling 400.** Own `HealthCheck`, `ListenTarget`, `proxyHealthFailureReason`, `isConnectionRefused`, `isUncleanExitEvidence`, `checkProxyHealth`, `probeUncleanExitState`. Relocate source ranges **23–31, 115–122, 163–231, 255–331**, including all attached comments: 9 + 8 + 69 + 77 = **163 relocated lines**. The former separator at332 is omitted at the new file's EOF so `git diff --check` stays clean; count that one blank-line deletion as non-move formatting, not a declaration/body change. Export `checkProxyHealth` only for its production caller in the residual; do not add it to the old public surface. `HealthCheck` stays private. Own imports (four lines plus one separator):

   ```ts
   import { readPidFileValue, readRuntimePort } from "../config/process-state";
   import { isOpencodexHealthz, probeHostname } from "../server/proxy-liveness";
   import { directLocalHttpFetch } from "../server/direct-local-http";
   import { isProcessAlive } from "../lib/process-control";
   ```

2. **Residual `src/cli/status.ts` — 384 lines, ceiling 400.** Retain all R declarations and their implementation verbatim. Remove import lines6 and10; remove only `readPidFileValue` from line3 and `isOpencodexHealthz` from line5. Keep `readRuntimePort`, `RuntimePortState`, `findLiveProxy`, and `probeHostname`: the assembler/listen selector still uses them. Keep every other original import. Add the three lines below. Accounting: **547 − 163 relocated − 1 terminal separator − 2 imports + 3 wiring = 384**; leaf163 +5 =168; aggregate552 = original547 +6 wiring −1 separator. No #b is needed.

Owner search: `rg -n 'checkProxyHealth|isUncleanExitEvidence|probeUncleanExitState' src/cli src/server` identifies this implementation and its callers, not an interchangeable existing leaf. Preserve the existing `directLocalHttpFetch` owner instead of copying transport. Expected ordinary numstat churn is about 340 source lines (move deletion/addition plus wiring), below 500; measure the actual parent-relative diff before publication.

## Re-export block

Exact additions to the original file, one physical line each:

```ts
export { proxyHealthFailureReason, isConnectionRefused, isUncleanExitEvidence, probeUncleanExitState } from "./status-probes";
export type { ListenTarget } from "./status-probes";
import { checkProxyHealth, probeUncleanExitState, type ListenTarget } from "./status-probes";
```

`CliStatusJson`, `CliStatusView`, `selectListenTarget`, `resolveStatusPid`, `unusedProxyWarningLines`, and `collectStatus` remain exported declarations in the original. No wildcard exports, wrappers, aliases or new `index.ts`. The existing public-path compatibility requirement explicitly calls for a residual with named re-exports; this is not a new internal convenience barrel. Re-export does not bind `probeUncleanExitState` or `ListenTarget` locally, hence the explicit import.

## Module-level state and cycles

No top-level `let`, mutable Map/Set/WeakMap/WeakSet, lock or timer exists in the source (lane 016:396, rechecked declaration inventory). The loop variables at `status.ts:176` and `AbortController` / timer at 257–258 are invocation-local, owned by the moved functions; `clearTimeout` at 278 stays in `finally`. No duplicated process-state cache is introduced.

Keep the `ListenTarget` type with the probe so the probe never imports the residual, even type-only. Keeping that type only in the residual would create `status.ts → status-probes.ts → status.ts`; this partition avoids it. R → P is functional coupling. The before/after process-record reads (301–303 and 318–320) and refusal probe (311) have existing temporal coupling; keep them together in P, not split into independently cached helpers. No callback, lazy-import workaround or copied singleton is needed.

Lane 016:397 reports no return cycle through the current module. During implementation re-run its method G (AST relative import/export and literal dynamic-import resolution, including type edges) over the changed closure; require no return path through R or P. The leaf has exactly the four imports listed above. `PROTECTED` roots in `tests/lab/core-lab-boundary.test.ts` remain untouched; this layer edits no server/router/lib source.

## Tests

Exact direct-test `rg -l 'cli/status["\x27]' tests` list:

| test file | source anchor | disposition |
|---|---|---|
| tests/service/autostart-health.test.ts | import at 3 | unchanged; original public path |
| tests/cli/cli-status-json.test.ts | import at 9 | unchanged; original public path exercises re-exports |

Source-oracle audit: no test reads **`src/cli/status.ts`** as source after basename, qualified-path and split path-segment searches. `tests/cli/cli-json-contract.test.ts:22` is its source-read helper, but the status assertion at 26 reads **`src/cli/index.ts`**; unchanged. There is no `retarget-to-leaf` or `add-leaf-to-scan-list` action for this layer. Subprocess consumers in cli-status-json (`cliPath` at 14, spawn at 17) remain pointed to the executable entry, not the leaf.

Guards to drive red once in a disposable remote checkout, then restore before green: change the moved `isUncleanExitEvidence` refusal check corresponding to old line 225 and observe `tests/cli/cli-status-json.test.ts:445` fail; change the old line-227 before/after predicate and observe its line-449 case fail. Confirm the end-to-end recorded-port case at 564 still exercises the shared gatherer. These are planned negative controls, not results claimed by this document. Do not weaken assertions or redirect behavior tests away from the public boundary.


### Regression and SoT additions

Add a small test to existing `tests/cli/cli-status-json.test.ts`: import the facade namespace and the leaf's existing forwarded probes; assert the four forwarded function bindings have identical identity and `checkProxyHealth` is absent from the original runtime namespace. Preserve all original assertions. Typecheck and the export inventory cover the three type exports. No new test file or layout-registry change is needed.

MODIFY `structure/01_runtime.md` by inserting this ownership row immediately after its existing `src/config/process-state.ts` row; no other runtime prose changes:

| Path | Responsibility |
|---|---|
| `src/cli/status.ts` / `src/cli/status-probes.ts` | Status snapshot assembly and the shared read-only health/stale-process probes used by status and doctor. Probe evidence keeps recorded-port choice, before/after snapshots and per-call timer cleanup together. |

## Verification

Run this Bash recipe from the bound a2c0 checkout at C after the clean layer head is published. The session id is this task's binding; other tasks use their own newest binding. All Bun commands are remote. The receipt command checks local identity before/after SSH, creates a fresh remote clone, matches the fetched branch head, and propagates command/logging failures.

```bash
set -euo pipefail
wp450_root=$(git rev-parse --show-toplevel)
wp450_expected=$(git rev-parse HEAD)
wp450_status=$(git status --porcelain)
test -z "$wp450_status"
wp450_log="$wp450_root/.codexclaw/evidence/01a06e97-b9d8-7250-8204-bb788338c288/wp450-remote-check-$wp450_expected.log"
mkdir -p "$(dirname "$wp450_log")"
cxc receipt test --cwd "$wp450_root" --session 01a06e97-b9d8-7250-8204-bb788338c288 -- bash -c '
set -euo pipefail
test "$(git rev-parse HEAD)" = "$1"
local_status=$(git status --porcelain)
test -z "$local_status"
ssh lidge bash -s -- "$1" 2>&1 | tee "$2"
test "$(git rev-parse HEAD)" = "$1"
local_status=$(git status --porcelain)
test -z "$local_status"
' -- "$wp450_expected" "$wp450_log" <<'REMOTE'
set -euo pipefail
expected=${1:?expected SHA required}
[[ "$expected" =~ ^[0-9a-f]{40}$ ]]
run_dir=$(mktemp -d /tmp/ocx-wp450.XXXXXX)
printf 'RETAINED_RUN_DIR=%s\n' "$run_dir"
git clone --no-checkout https://github.com/lidge-jun/opencodex.git "$run_dir/repo"
cd "$run_dir/repo"
git fetch origin refs/heads/codex/split-cli-status
test "$(git rev-parse FETCH_HEAD)" = "$expected"
git checkout --detach "$expected"
bun install --frozen-lockfile
export PATH="$PWD/node_modules/.bin:$PATH"
test "$(bun --version)" = 1.4.0
(cd gui && bun install --frozen-lockfile && bun run build)
tree_status=$(git status --porcelain)
test -z "$tree_status"
printf 'CHECKOUT=%s\nHEAD=%s\n' "$PWD" "$(git rev-parse HEAD)"
unset OCX_TEST_NO_QUEUE
bun run typecheck
bun test tests/cli/cli-status-json.test.ts tests/service/autostart-health.test.ts tests/cli/cli-json-contract.test.ts
bun run privacy:scan
if bun run test; then
  test_rc=0
else
  test_rc=$?
fi
printf 'SUITE_EXIT=%s\n' "$test_rc"
if [ "$test_rc" -ne 0 ]; then exit "$test_rc"; fi
test "$(git rev-parse HEAD)" = "$expected"
tree_status=$(git status --porcelain)
test -z "$tree_status"
printf 'VERIFIED_HEAD=%s\n' "$expected"
REMOTE
```

Local checks are read-only: `git diff --check`, `wc -l src/cli/status-probes.ts src/cli/status.ts`, and importer discovery with `rg`. Require the original four direct consumers and all11exports; resolve static/re-export/type/literal-dynamic edges for cycle proof. The three focused files include subprocess/source-oracle coverage; full-suite output and exact-head CI are additionally required. No protected root is edited. Record actual exits and output; the recipe is not evidence of a pass by itself.

## Accept criteria

1. All 15 owned declarations are assigned once; the moved bodies/comments are unchanged except necessary `export` keywords.
2. `wc -l` returns ≤400 for both paths (P=168, R=384 after the explicitly accounted terminal-separator cleanup); actual parent-relative source churn ≤500, or stop for parent re-plan.
3. The original 11 exports remain importable with identical signatures; `checkProxyHealth` and `HealthCheck` are not added to the original export surface.
4. Original consumer paths and the two test imports are unchanged; method G finds no cycle involving either changed module.
5. Probe timers remain per-call, cleanup stays in `finally`, recorded-port choice and both snapshots stay in the same gatherer; negative controls go red and restored focused checks/typecheck/privacy pass.
6. Remote full suite and exact-head CI are green for this layer independently. Only the two source files, named existing test, planned SoT row and unit documents enter its parent-relative PR delta; no upper-layer implementation. Land this layer with admin after fresh review disposition, expected-head matching and child preservation; verify actual merged tree and fetched-dev ancestry.

## PR

Title: `refactor(cli): isolate status health and stale-process probes (split S14 L1/3)`

Branch: `codex/split-cli-status`. Base: `dev`; verified prerequisite #3640 has landed. Existing PR #3633 already targets dev, so no retarget is necessary. Closes: none.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); paste actual checks only. This table is the DEV-STACK-03 map; replace PR-number placeholders when created:

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 3 | #<S14-L3> | hub transport / codex/split-client-hub-client | dev | transport and error identity |
| 2 | #<S14-L2> | provider readers / codex/split-cli-provider | dev | read handlers and argument parsing |
| 1 | #3633 | status probes / codex/split-cli-status — this PR | dev (includes #3640) | diagnostic probes and old exports |

The implementation consumes separately verified prerequisite #3640, now on dev. Other S14 layers remain independent; do not add their code. Recheck the current dev integration tree before publication and landing. Admin landing after passing CI is authorized by USER-ADMIN-LANDING-01 in003.

Review only this layer's diff. Other S14 layers are not needed for correctness. The later user instruction authorizes admin landing after final-head CI and valid review closure; earlier no-merge wording below is historical.

## Initial P stale check and continuity (historical)

Previous D: WP400 closed at `bbf8d3cd` with ready PR #3611, current-head CI and a clean remote receipt. Its remaining facade work belongs to WP410. WP450 is independent and uses pinned dev commit `9fe986d84a598aa08eeef7731b9a50fa0ff6ab07`.

`git diff 1362b1a38 9fe986d84 -- src/cli/status.ts` is empty; all original ranges remain valid. Main read the complete source, direct doctor/test consumers, sibling status-oauth/version-skew conventions and Runtime SOT. `cxc map src/cli` confirms the listed declarations. No existing status-probes module was present.

The isolated parent baseline on lidge passed typecheck, the three named focused files (49 pass / 0 fail), privacy, and final HEAD/clean-tree checks. Full suite was not run for this baseline and remains a final layer gate. Complete output: `.codexclaw/evidence/01a06e97-b9d8-7250-8204-bb788338c288/wp450-baseline.log`. The recipe passed Bash syntax checking. No local suite ran; resulting-head verification remains pending.

## Initial A audit outcome (historical)

Hooke independently verified all 15 declaration ranges, 164 moved lines, virtual 169/384-line files, complete/minimal leaf imports, exact residual wiring and all 11 public names. The candidate graph has no facade/leaf return cycle (363 modules / 44 inline-import edges). Held-port and mid-probe snapshot negative controls discriminate by inspection, and the recorded-port integration scenario remains intact. Verdict: PASS.

Wegener's independent operational review passed the verifier and all 29 documented dependency edges. Comparing the archived proposal with the goalplan confirmed all 78 work-phase objects are deeply unchanged by ID; only pending WP580 moved before WP590. No runtime result is inferred from these static reviews.

## Initial B implementation record (historical)

Carver implemented the two source paths and existing test only. Main added the planned Runtime SOT row. `status.ts` now has384lines and `status-probes.ts`168; both are below400. The new test adds four forwarding-identity assertions and excludes the private health helper from the facade; all original test lines remain.

The initially preserved terminal separator produced a new-file whitespace-check failure. Main removed only that blank EOF line and amended the accounting above before proceeding:163relocated lines, one non-move separator deletion, source churn341lines and total non-move wiring/test churn25lines. Declaration signatures, bodies and comments are unchanged apart from the required export modifier. Worker static AST checks verified all15owners,11facadeexports, bindings and absence of return cycles. Main reviewed the source/test diff and ran `git diff --check` with the new file included; it passed. No local tests, typecheck or installs ran.

Changes by file: `src/cli/status-probes.ts` owns the existing probes; `src/cli/status.ts` retains assembly and forwards the old API; `tests/cli/cli-status-json.test.ts` adds the identity regression; `structure/01_runtime.md` names the two owners. Resulting-head runtime checks, mutation controls and independent C review remain to be completed.

## Resumed P after prerequisite completion (historical)

WP445 closed through D at d2b4a81c61294c3c9ae7a2d58a01397167b120d0, with
ready PR #3640, current-head hosted CI and a clean remote full-suite receipt.
This is a verified prerequisite, not a modularization-row completion. Detailed
investigation remains outside public devlog.

The same a2c0 checkout now resumes WP450. The old4a71894f implementation and
remote PR #3633 head are preserved. Local restack onto the verified parent
produced ae6ef3d64eb03b864d98ed07b2d02a46858fe400 before this plan amendment.
Only two documentation conflicts occurred: retain the updated000 verification
row and both Runtime ownership rows. The source and status-test files are
byte-identical to the previous4a71894f implementation; parent-relative source
scope and sizes remain341churn,384/168lines,15owners and11exports.

The checkpoint branch retains4a71894f. A configured rebase update-refs option
initially moved that newly created checkpoint alongside the working branch;
Main restored only its own checkpoint ref with a compare-and-swap update.
Future restacks explicitly disable update-refs to preserve unrelated refs.
No source conflict or original implementation change was introduced.

The initial base-source comparison remains valid: the status source and three
focused-test files have no change between9fe986d84 and the new parent d2b4a81c.
This does not replace a new dependency-graph audit or current-head execution.
The verifier above now pins package Bun1.4.0 and builds the packaged dashboard
before tests. It still preserves complete logs, exit codes, clean expected
HEAD checks and the same session binding.

Re-audit the resumed layer, preserve the existing implementation, and publish
the restack only in its assigned CI slot. PR #3633 must target #3640's branch
before new-head checks are accepted. Reconfirm the old remote4a71894f head
before an explicit force-with-lease; do not overwrite another owner's push.
Record fresh remote/CI proof for the restacked head, not the old successful
remote result or failed hosted result. No local suites, merge or release.

## Resumed A outcome (historical)

Hooke verified51import/re-export bindings, all11public exports, and a fresh
363-module/44-inline-edge graph with no return cycle through either changed
status module. Original source/test blobs match4a71894f; sizes384/168 and
source churn341 remain unchanged. Verdict: PASS.

Wegener independently verified the parent ancestry, baseline and implementation
blob identities, checkpoint restoration, identical document/script recipe,
receipt-internal SHA/clean checks, Bun1.4.0 setup and serialized publication
plan. WP445's genuine D close and WP450's active cursor were confirmed.
Verdict: PASS. Neither review is runtime verification of the restacked head.

## Resumed B integration (historical)

The already-built layer is retained exactly rather than reimplemented. Main
verified the rebased source/test blobs against4a71894f and the approved
parent-relative five-path scope. Only the documented conflict resolutions
and current plan/verification amendments changed during integration. No new
behavior or test assertion was added. Fresh C evidence remains required;
the branch is not published until the coordinator assigns its CI slot.

## Phase-correct reconstruction

SOURCE-DELTA-01 rejected C entry because the prior integration had carried
already-built code into B rather than applying the move during that B. No
source or verification state was fabricated. Main returned to P and preserved
the complete audited candidate at `codex/status-restack-candidate-d8671a8c`
(d8671a8cb3073286b790d43f1a760696add37be9), plus the original4a71894f checkpoint.
The physical worktree was not moved or recreated.

The working branch is reconstructed from the same verified parent d2b4a81c,
initially carrying only this approved plan. Re-audit this execution change;
then apply the already-reviewed three source/test file states and the single
Runtime row during B using apply_patch. Match the preserved candidate's blobs
exactly. This creates the intended real parent-relative source delta inside
B without inventing a new behavior or a comment-only change. B→P is not a
supported transition in this CLI, so the unfinished cycle was explicitly
reset to IDLE and restarted at P with goal, work-phase and evidence retained.
This reset is not completion; all P/A/B/C gates must run again. All current-head
checks, lease protection, privacy constraints and CI scheduling remain intact.

## Reconstruction B result

Carver applied the three approved source/test file states with apply_patch
during the fresh B. Main applied the single Runtime row. The source/test blobs
match preserved d8671a8c exactly: facade02e39f7f, leafd3848c95, test2969d651.
Sizes384/168 and15declarations/11exports are preserved. Static parsing and
whitespace checks passed; no runtime checks were run during another owner's
CI. This is now a genuine source delta from B's547-line parent baseline.
Fresh resulting-head C checks remain pending.

## Latest integration-base review

After #3626/#3636 landed, current dev is
cfe95eea0f776a5a5d5bad5f41408cd98ba98ff7. Object-only merging that base with
the local450 candidate produced tree3c0689fe040de4f941899935c8808b594016ac55,
identical to the independently reviewed prospective onboarding integration.
No refs or worktree source changed during this check.

The three owned source/test blobs still match the approved implementation.
A fresh Git-tree graph found366reachable facade modules and346leaf modules,
46valid named imports plus the existing forwarding bindings,11public exports,
and no return cycle through either status module. New reachable upstream
owners are initial-model-selection, its runtime companion, and CLI selection
guidance. Main read those implementations; the provider field is additive and
the direct status consumers remain unchanged. This is static evidence only.

This C→P amendment plans dependency integration during B, preserving the
owned blobs. Use a normal merge of the final pinned, verified dev into the
working branch; preserve all checkpoint refs and avoid rebase update-refs.
Recheck the base immediately before A→B. If a late-review follow-up changes
dev first, update the pin and re-audit the changed integration rather than
claiming this prospective tree covers it. The onboarding review-closure flow
currently owns the execution queue; do not publish or run runtime gates here.

Before landing WP450, require the actual new head/tree's remote checks and CI,
fresh review disposition, admin head-match merge, child safety and fetched
dev ancestry under USER-ADMIN-LANDING-01. Previous4a/d2 results are not the
new integrated head's verification. No release or live-service change.

## Earlier integration input and start condition (superseded)

The queued upstream review-closure candidate is PR #3645, commit
3c4ff939735e02fe10910d05fad6c3a18571f663, tree
ec6cdffbd7473c4ae283fd0dd3645d4c3dfd31a1, based on cfe95eea.
Object-merging it with the current450 candidate gives
f2d652955f67d5f9f6863f16e771711c127d9e69. This names immutable proposed
content, not a claim that the candidate has landed or passed runtime checks.

Incremental independent review found no changed source within the366/346
status closures. The only production-source difference from the previously
reviewed upstream candidate is outside those closures and preserves its
import/export declarations. Owned facade/leaf/test blobs remain unchanged;
the prior11-export/46-named-import/no-return-cycle proof remains applicable.

Immediately before A→B, require #3645 to be merged, its post-merge CI to pass,
and fetched dev to contain the named candidate with the exact expected source
tree. Record the actual landed SHA in the ledger/attestation. If the content
or base changes, return A→P and amend before executing B; do not substitute an
unreviewed newer branch. Until these conditions hold, source integration waits.

During B, perform the actual normal merge of that pinned landed dev into the
working450 branch. Preserve all existing refs and owned source/test blobs.
Compare source/test/SOT content with the reviewed prospective tree (plan-record
updates may differ); then commit and enter C. The resulting real commit—not
the prospective tree—receives fresh remote gates, CI and admin landing proof.

## Previous planning hold (superseded by slot return below)

The earlier #3645 input is superseded by a validated review correction, and
the already-requested #3643 integration is using the otherwise idle CI slot.
Main returned A→P; the previous audit is not authorization to consume either
an unlanded or changed input. Owned450 source/test blobs remain untouched.

Once these existing flows publish their verified final base, record the actual
commit/tree, compare the incremental source/caller changes, and re-audit the
normal B-stage merge. Retain the exact owned-blob and fresh-head verification
requirements above. This is a dependency/scheduling wait, not completion or
permission to weaken the gates. No intermediate source merge or new CI ran.

### Verifier continuity for the next B/C

The archived mutation runner embeds the original4a71894f remote checkout and
must not run unchanged against the new layer. During B, parameterize that
existing runner with the fresh remote checkout and expected40-character SHA.
Require an owned `/tmp/ocx-wp450.*` checkout, clean matching HEAD, repository
Bun1.4.0 on PATH, and patches beside the runner. Preserve its two named
failure checks, reverse-on-exit restoration and final clean identity check.
Run these controls serially after the full verifier finishes, never against a
checkout whose suite is active. Archived old-head results remain historical.

The frozen #3645 correction is bb0547342c9526484b0219d6aaf5bf8927d0a852,
tree f4f770511db04b01f2b9376833a4f4f5012ae1a7, before final WS integration.
It is not the integration pin or runtime proof. Queue order is WS3643,
follow-up3645, this450 unit, then provider ROOT3582. Final-base admission and
fresh A review remain mandatory; the candidate import-graph review can only
reduce redundant static work once its content matches the landed input.

## Current upstream admission after WS slot return

WS #3643 did not land: its macOS second shard reached the20-minute limit,
the job was cancelled and the final CI aggregate failed. Its owner returned
the execution slot for read-only root-cause analysis. WS is not a code
dependency of this status move; no unverified WS source enters this layer.

The next existing prerequisite is the frozen #3645 correction
bb0547342c9526484b0219d6aaf5bf8927d0a852, tree
f4f770511db04b01f2b9376833a4f4f5012ae1a7, on published cfe95eea.
It now owns the sole execution slot. Main verified that its14 changed paths
and WS's21 paths do not intersect. Object-only merging it with own c4e67991a
produced b5749715bbbd6936937defd20bfd522bc013850b without conflicts.
This is proposed content, not verification or adoption of that content.

Audit this input and the previously specified normal B-stage merge. Before
A→B, require #3645 admin-merged with fresh exact-head CI, matching actual
source tree and completed successful post-merge dev CI. Fetch dev and record
its actual SHA/tree. It must contain bb054 and match its expected tree;
if another content change lands, return to P and re-audit that delta first.
Then merge the pinned dev during B, preserve the three owned blobs and
checkpoint refs, parameterize the existing mutation runner as specified,
and verify the resulting real HEAD in C. No local suites or live-service work.

Own450 and provider ROOT3582 retain their next-unit reservations. WS recovery
needs a separately allocated slot after its diagnostic evidence, not an
automatic retry concurrent with #3645 or a silent new prerequisite here.

## C documentation consistency repair

Three retained PR review findings exposed conflicting shared guidance in
the carried000/003 documents. Align000 with the already binding declared-
dependency topology and admin authority; restrict the method-to-factory
exception to eligible object-literal methods, excluding class/method-only
semantics; and make RESIDUAL-FN depend on the final over400 residual and its
sole unsplittable-function cause, not a350-line shortcut. These are scoped
documentation repairs, not additional status implementation or relaxed gates.

The status source/test blobs and reviewed source boundaries remain unchanged.
Re-review the repaired documents and verify the new resulting HEAD. The
preceding8bc CI belongs to that prior HEAD, even if it passes; it cannot be
presented as the new commit's exact-head proof.

## Verified delivery record

Final layer HEAD: df92323d3406535c7eacd0bfa2d5bae6adb610e1. Final hosted
CI33963307005 passed18jobs with two configured dispatch-only skips. Fresh
isolated remote verification passed build preparation, typecheck,50focused
tests, privacy, and the full suite:18842pass/16skip/0fail. This includes the
main18681pass batch and six disjoint serial lanes totaling161pass. Both
named refusal/snapshot negative controls failed with exit1, then restored
to27pass/0fail each; final remote HEAD remained clean. The bound receipt and
full/mutation logs are retained in the session evidence directory.

Independent C review validated source identity, all15owners/11exports,
51bindings,366/346module closures, test activation and execution accounting.
The three retained shared-document findings were repaired and resolved.
An older duplicate label cancellation had a newer same-head successful
replacement; no cancelled test was counted as passing.

PR #3633 was admin-merged with expected-head matching as
09335d7d451335a74ad1c02e88ee37ef89f5a007. Its actual tree
7ffe001817a487a47f5836eedfe1645574111393 equals the tested PR merge tree.
Freshly fetched dev contains both the layer and its merge; no open direct
child PR required preservation. The approval bypass is recorded in PR
comment5551535773; optional CodeRabbit was pending at that snapshot, not
counted as PASS. Independent review and executable gates had passed.

Delivery is verified, while post-merge dev CI33964069626 is monitored
separately and is not yet claimed successful in this record. Any failure
remains work under the active goal; the next unit must check its base before
implementation. No local suite, release or live-service change occurred.

Residual: status.ts is384lines and the new leaf168, but collectStatus at
status.ts:170 remains an unchanged215-line function. This is file-boundary
completion, not elimination of that function debt or completion of all68
rows. Changed public bindings, a new return cycle, or a negative control
that does not fail would invalidate this direction; none was observed.

Post-merge follow-up: CI33964069626 completed SUCCESS on
09335d7d451335a74ad1c02e88ee37ef89f5a007. The separately monitored base check
is now closed; no additional source change or rerun was needed.
