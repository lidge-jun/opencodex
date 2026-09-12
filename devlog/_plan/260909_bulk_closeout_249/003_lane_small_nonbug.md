# Lane C — small non-bug PRs (chore/docs/refactor/tiny features)

Read-only adversarial review. Research worktree: `/tmp/ocx-249.xGQnxl/wt`, detached at `origin/dev` = `7dc7dc99e65268bc8764e19840952256b030bce9` ("Merge pull request #4037 from lidge-jun/codex/prs-stack-record"). Index re-read immediately before verdict: `git status --porcelain=v1` empty, HEAD unchanged. Remote verified: `https://github.com/lidge-jun/opencodex.git`.

Scratch worktree for conflict checks and focused tests: `/tmp/ocx-lanec-bcdq/w` (`git worktree add --detach`), `node_modules` symlinked from the main checkout. The `/tmp/ocx-249.xGQnxl/wt` index was never touched.

## THE FINDING THAT GOVERNS EVERY VERDICT IN THIS LANE

**No product CI has ever run on any of these 14 PRs.** Every `ci.yml` run on every head SHA in this lane terminated at `action_required` — GitHub's fork-approval gate — so the aggregate `ci` check-run does not exist at any head.

Verified per-head via `gh api repos/lidge-jun/opencodex/commits/<sha>/check-runs`. For example at #3980's head `b855765dd83f77162b13b00599f41b1447d9020d`, the complete set of check-runs is:

```
enforce-target	completed	success
resolve-pr	completed	success
label	completed	success
hygiene	completed	success
```

There is no `ci`, no `test`, no `gates`, no `platform-macos`, no `platform-windows`. Verified per-branch via `gh run list --workflow=ci.yml --branch <branch>`; every run on all 14 branches reports `completed/action_required`:

| PR | branch | latest ci.yml run |
|---|---|---|
| 3980 | `codex/upstream-cli-stale-port-20260908` | `b855765dd completed/action_required` |
| 3984 | `codex/upstream-model-feedback-20260908` | `35a4d99d6 completed/action_required` |
| 3963 | `agent/dashboard-capture-retention-20260908` | `5497cd994 completed/action_required` |
| 3897 | `codex/router-selection-capture` | `356f2c1db completed/action_required` |
| 3648 | `windows-perf-cred-fix-candidate` | `bd3644333 completed/action_required` |
| 4041 | `agent/idle-deadline-reset-fixture-20260908` | `9aa3e9204 completed/action_required` |
| 3748 | `codex/upstream-local-telemetry-ledger` | `5b1cbbcb3 completed/action_required` |
| 3742 | `codex/upstream-cursor-pool-kernel` | `3e6be56f3 completed/action_required` |
| 4040 | `feat/decode-throughput-metric` | `b1d316501 completed/action_required` |
| 3987 | `feat/codex-client-compaction-v2` | `f3247298b completed/action_required` |
| 4033 | `feat/usage-api-list-price` | `48e2ae5b3 completed/action_required` |
| 4042 | `feat/usage-ledger-retention-v2` | `320c20493 completed/action_required` |
| 3983 | `codex/upstream-stream-diagnostics-20260908` | `dc7ce1f79 completed/action_required` |
| 3982 | `codex/upstream-usage-accessibility-20260908` | `239868dde completed/action_required` |

The four green checks are hygiene gates only, produced by `pr-hygiene.yml`, `enforce-pr-target.yml`, and `pr-labeler.yml`. They validate the PR *description*, not the code.

Per the delegation brief's own standard — "tested, green" — **nothing in this lane is green in the product sense**. Every LAND verdict below is therefore conditional on a maintainer dispatching `ci.yml` at the exact head SHA and it passing. My focused-test runs are local Bun 1.4.0 macOS evidence and are explicitly not a substitute for the Linux/Windows/macOS matrix. AGENTS.md ("Commands") makes `bun run typecheck` and `bun run test` the PR-ready gate; I ran neither (full suite is forbidden by this brief), so those are **NOT RUN**.

Note also that `ci.yml` is triggered by `pull_request: {}` with no base-branch filter (`.github/workflows/ci.yml:9`) precisely so contributor stacks get CI. The blocker here is fork-approval, not workflow scoping — a maintainer clicking "Approve and run workflows" is all that is required.

## Summary table

| Item | Verdict | One-line reason | Head SHA | CI at head | Conflicts |
|---|---|---|---|---|---|
| #3980 | LAND_AS_IS (after CI dispatch) | Real shared-`freePort` fixture inversion; test-only, 12/-6 in one file; 47/47 pass locally | `b855765dd83f77162b13b00599f41b1447d9020d` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #4041 | LAND_AS_IS (after CI dispatch) | Real wall-clock flake with a cited hosted failure; test-only, one file; 6/6 pass, target case 360ms→0.37ms | `9aa3e9204c12c1bbd9068e77115501e16203bb60` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #3897 | LAND_AS_IS (after CI dispatch) | Cycle real at `src/router.ts:13`; pure 10-line extraction + compat re-export; 41/41 pass; closes #3894 | `356f2c1db4e96a0a43e3d3209d35d97ec4e30291` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #3963 | LAND_AS_IS (docs-only) | Deletes 60 devlog assets; **no dev file references any deleted asset** — the 3 dev hits cite `.md` files that are retained | `5497cd9943c4b4c26e7b99926d9f0725b16f1cce` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #3984 | LAND_WITH_FIX | Correct 3-line `useCallback` fix, but `hygiene` and `enforce-target` **FAIL** with `missing_regression_test` | `35a4d99d672545bf16d37c5d94a05cf6ff472982` | **hygiene FAIL, enforce-target FAIL** | clean vs dev |
| #3648 | DEFER | `hygiene` and `resolve-pr` both **FAIL**; docs assert a stale pre-stabilization Windows baseline the PR itself says not to diff against dev | `bd3644333da96e8bde362ce57c08bf75c68ac2be` | **hygiene FAIL, resolve-pr FAIL** | clean vs dev |
| #3748 | DEFER | +642 new `src/telemetry/` subsystem, zero runtime callers — dead code plus a new SQLite dependency surface | `5b1cbbcb39805e5fc0c98b9440cba57e1c939ee7` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #3742 | DEFER | +334/-43 replaces the whole 72-line `cursor-pool.ts`, holds OAuth tokens in memory, author requests security review | `3e6be56f3058bf4d2b7124f416a284d0706704c4` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #4040 | DEFER | New user-visible Logs metric across 9 locales + management API field; implements #4038, a product-direction decision | `b1d316501d8fdff6701946a7b8604fa3d468342a` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #3987 | DEFER | New `codexClientCompaction` config surface changing Codex provider-table injection; implements #3978 | `f3247298b27868fd039f31f3a4a402c9c6410392` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #4033 | DEFER | New pricing display surface in Usage across 9 locales + docs-site; product decision | `48e2ae5b35637bad67620613196547da39655376` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #4042 | DEFER | +1464 across 14 files, 6 new `src/usage/` modules, new CLI capability; `enforce-target` **FAILS** | `320c20493b43d0dd59a7c8a0c043c2779a18f954` | **enforce-target FAIL**; no `ci` check-run exists | clean vs dev |
| #3983 | DEFER | +537 touching `src/server/responses/core.ts`, a protected core-path file under the Lab-boundary rule | `dc7ce1f79085b36ad8964e8112f386ac623650e1` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |
| #3982 | DEFER | +370 GUI rework of `Usage.tsx` (+147/-38) and `styles.css` across 9 locales; visual product judgment | `239868dde6d6181574a412298db1e373e15dca5a` | hygiene 4/4 green; **no `ci` check-run exists** | clean vs dev |

**Net: 4 LAND candidates, 1 LAND_WITH_FIX, 9 DEFER.** All 14 merge cleanly against dev.

---

## #3980 — test(cli): make stale-port status fixture deterministic — LAND_AS_IS (after CI dispatch)

Author yansigit, draft, `chore`. +12/-6, 1 file: `tests/cli/cli-status-json.test.ts`.

**The defect is real on dev.** `/tmp/ocx-249.xGQnxl/wt/tests/cli/cli-status-json.test.ts:713-720`:

```
  let freePort = 9;
  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>(resolve => { probe.listen(0, "127.0.0.1", () => resolve()); });
    freePort = (probe.address() as AddressInfo).port;
    await new Promise<void>(resolve => { probe.close(() => resolve()); });
  });
```

One `beforeAll` allocates a single ephemeral port, releases it, and four tests share the resulting number. The last test then binds a *second* listener and requires the two ports to differ — `cli-status-json.test.ts:785-787`:

```
    const occupied = createServer(socket => { socket.destroy(); });
    await new Promise<void>(resolve => { occupied.listen(0, "127.0.0.1", () => resolve()); });
    const occupiedPort = (occupied.address() as AddressInfo).port;
```

and at `:793` writes `runtime-port.json` with the shared `freePort`:

```
      writeFileSync(join(home, "runtime-port.json"), JSON.stringify({ pid, port: freePort, hostname: "127.0.0.1" }), "utf8");
```

Because `freePort` was released back to the ephemeral pool in `beforeAll`, the kernel can hand that exact number to `occupied.listen(0)`. Then `occupiedPort === freePort`, the "refused" port is actually occupied, and the fixture inverts — `staleProcessState` comes back `false` where `:797` expects `true`. The test's own comment at `:709-712` states the invariant it fails to enforce: *"if anything answers on it the probe is accepted rather than refused and these fixtures invert."*

**The fix is correct and minimal.** It converts `beforeAll` to `beforeEach` with a reusable `allocateFreePort()`, and critically allocates the record port **after** the occupied listener is bound, with an explicit guard:

```
      const recordedPort = await allocateFreePort();
      expect(recordedPort).not.toBe(occupiedPort);
```

Allocating after the bind is what actually closes the hole — the occupied listener can no longer later steal the recorded number. The `expect` is a belt-and-braces assertion that converts any residual collision into an honest failure instead of a silent inversion.

**Focused test, scratch worktree, Bun 1.4.0:** `bun test tests/cli/cli-status-json.test.ts` → **47 pass / 0 fail**, 271 expect() calls, 8.10s.

**Conflicts:** `git merge-tree --write-tree HEAD pr3980` → CLEAN.

**Caveats.** Draft with all four review-readiness boxes unticked. Test-only, so `missing_regression_test` does not fire and hygiene is green. This is the single safest item in the lane: one test file, no `src/` change, no product surface.

## #4041 — test(lib): make idle deadline reset timing deterministic — LAND_AS_IS (after CI dispatch)

Author luvs01, draft, `chore`. +52/-11, 1 file: `tests/lib/abort-idle-deadline.test.ts`.

**The defect is real on dev.** `/tmp/ocx-249.xGQnxl/wt/tests/lib/abort-idle-deadline.test.ts:20-31`:

```
test("idleDeadline reset() re-arms and postpones firing", async () => {
  let fired = 0;
  const idle = idleDeadline(120, () => { fired += 1; });
  idle.reset();
  for (let i = 0; i < 4; i++) {
    await sleep(40);
    idle.reset(); // keep-alive: total elapsed (160ms) exceeds 120ms but silence never does
  }
  expect(fired).toBe(0);
```

The comment states the assumption exactly: each requested 40 ms sleep must resume before the 120 ms idle window elapses. `setTimeout` guarantees a *minimum* delay, not a maximum. One 40 ms sleep resuming after 120 ms under load makes the production timer fire correctly while `expect(fired).toBe(0)` fails — the test reports a defect that does not exist.

The PR body cites a concrete hosted occurrence: the macOS control run for #4036 (`https://github.com/luvs01/opencodex/actions/runs/34235799731/job/102093155231`) reported 432.21 ms and one firing where zero was expected. Honest scoping in the body: *"individual callback timings were not logged, so the exact delayed interval is unknown."*

**The fix is correct and well-bounded.** It replaces wall-clock dependence in *this one case only* with a scoped fake-timer fixture, spying `globalThis.setTimeout`/`clearTimeout`, and asserts the boundary precisely — no firing through 119 ms, exactly one firing at the next millisecond, no repeat after a further 240 ms. Restoration is in nested `finally` blocks so a mid-test assertion failure cannot leak mocked timers into the five sibling cases, which still exercise Bun's real timers. That containment is the part worth trusting; leaked global timer spies are the usual failure mode of this technique.

**Focused test, scratch worktree, Bun 1.4.0:** `bun test tests/lib/abort-idle-deadline.test.ts` → **6 pass / 0 fail**. The target case drops from ~360 ms of real sleeping to **0.37 ms**, and the five real-timer siblings still pass afterwards (202.15 ms, 81.19 ms, 61.22 ms, 61.13 ms), which is direct evidence the spies were restored.

The author additionally reports two source ablations rejected by the new fixture (removing cancellation before rearming; making repeated resets no-ops) — that is the right way to prove a determinism fix has not gone vacuous. I did not re-run the ablations.

**Conflicts:** clean. **Caveat:** draft, boxes 1 and 4 unticked; contributor CI described as "queued/in progress".

## #3897 — refactor(router): isolate API-key selection capture — LAND_AS_IS (after CI dispatch)

Author parkjs101, draft, `chore`. +117/-8, 8 files. Body says `Closes #3894`.

**The cycle is real on dev.** `/tmp/ocx-249.xGQnxl/wt/src/router.ts:13`:

```
import { captureProviderApiKeySelection } from "./providers/api-key-selection";
```

and the return edge at `/tmp/ocx-249.xGQnxl/wt/src/providers/api-key-selection.ts:6`:

```
import { routedProviderConfig } from "../router";
```

The helper being imported is genuinely pure — `api-key-selection.ts:10-16`:

```
export function captureProviderApiKeySelection(provider: OcxProviderConfig): ProviderApiKeySelection {
  return {
    entryId: provider.apiKeyPool?.find(entry => entry.key === provider.apiKey)?.id,
    reference: provider.apiKey,
    revision: provider.apiKeySelectionRevision,
  };
}
```

It reads three fields off its argument. It needs neither `mutatePersistedConfig` (imported at `:2`) nor `routedProviderConfig`, both of which the router drags in transitively today.

**The fix is exactly the extraction the issue specifies.** New `src/providers/api-key-selection-capture.ts` contains the function body byte-identical with two `import type` lines only; `api-key-selection.ts` keeps `export { captureProviderApiKeySelection } from "./api-key-selection-capture";` so every existing caller is unaffected; `router.ts:13` retargets to the leaf. Both test-layout registries get the new entry (`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`), which AGENTS.md requires and which `tests/test-layout-tooling.test.ts` enforces. `structure/01_runtime.md` gains an ownership row.

The new test is better than average: it asserts export identity (`expect(legacyCapture).toBe(captureProviderApiKeySelection)`), and it verifies the boundary with Bun's transpiler rather than by grepping prose, including a self-check that the scanner distinguishes erased type imports from real ones. That last case is what stops the guard from being vacuous.

**Focused tests, scratch worktree:** `bun test tests/providers/api-key-selection-capture.test.ts tests/lab/core-lab-boundary.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` → **41 pass / 0 fail**, 611 expect() calls.

**Scope honesty.** The PR does not claim to fix the router's other transitive cycles, and #3894 explicitly excludes them. The second cycle named in the issue (via `src/lib/state-store-registrations.ts:42`) remains, correctly out of scope.

**Conflicts:** clean. **Caveat:** draft; the security checkbox is unticked, though the change moves no auth logic — only the pure snapshot — and `api-key-selection.ts` retains all persisted-selection and route-resolution behavior.

### Issue #3894 vs PR #3897

#3894 is **OPEN**, labelled `enhancement` + `proxy`. #3897 addresses it exactly: the issue's "Possible after" sketch names `src/providers/api-key-selection-capture` and the compatibility re-export, and the PR implements precisely that, including the requested boundary coverage. **Keep #3894 open until #3897 lands on dev**, then close manually — AGENTS.md notes GitHub auto-closes only on merge into `main`, and these PRs target `dev`.

## #3963 — docs: retire the historical dashboard capture pack — LAND_AS_IS

Author luvs01, draft, `documentation`. +31/-2449, 62 files: 60 asset deletions under `devlog/_plan/260904_dashboard_minimal/assets/` plus 2 Markdown edits.

**The reference check you asked for — the answer is nothing on dev breaks.** `rg -n '260904_dashboard_minimal' --glob '!devlog/_plan/260904_dashboard_minimal/**'` in `/tmp/ocx-249.xGQnxl/wt` returns exactly 3 hits, all in GUI test comments, and **all three cite retained `.md` files, not deleted assets**:

- `/tmp/ocx-249.xGQnxl/wt/gui/tests/page-polish-minimal.test.ts:15`:
  `/** devlog/_plan/260904_dashboard_minimal/080_page_polish.md — the small items on five pages. */`
- `/tmp/ocx-249.xGQnxl/wt/gui/tests/codex-account-pool-toast-tone.test.tsx:519`:
  ` * devlog/_plan/260904_dashboard_minimal/050_codex_set.md: a pool card shows only its daily`
- `/tmp/ocx-249.xGQnxl/wt/gui/tests/startup-minimal.test.tsx:10`:
  ` * devlog/_plan/260904_dashboard_minimal/070_startup.md: the hero answers the page's`

`080_page_polish.md`, `050_codex_set.md`, and `070_startup.md` are **not** in the PR's file list. The unit directory retains all 13 `.md` files; only `assets/` (60 of 60 entries) is removed. These are comment references in any case — they are not resolved at runtime and could not fail a test even if the files vanished.

**Dangling-reference check inside the unit.** Only two files on dev mention `assets/`:

- `devlog/_plan/260904_dashboard_minimal/000_inventory.md:3-4` — the "Evidence: `assets/<route>_1440.png`…" paragraph
- `devlog/_plan/260904_dashboard_minimal/001_subagent_opinions.md:3` — "evidence pack in `assets/`"

Both are exactly the two Markdown files the PR rewrites. The diff replaces the evidence paragraph with prose describing the historical capture conditions and drops the now-dead Screenshot column from the 17-row inventory table, preserving all four substantive columns and every route, control count, and word count. After the change the unit has no `assets/` reference and no broken link.

**Nothing in the build reads it.** AGENTS.md: *"Nothing in the build, typecheck, or test path reads from `devlog/`."* The only consumer is `privacy:scan`, and removing files cannot introduce a new finding there.

**Size sanity:** `du -sh` on dev reports **4.6M** for the unit, 60 files under `assets/`; the PR states 4,513,616 bytes retired. Consistent.

**Conflicts:** clean. CodeRabbit reviewed this head and reported no findings. **Caveat:** draft, boxes 1 and 4 unticked. This is a pure documentation deletion with a verified-empty reference set — the lowest-risk item in the lane alongside #3980.

## #3984 — refactor(gui): stabilize model feedback callback dependencies — LAND_WITH_FIX

Author yansigit, draft, `chore` + **`intake: hygiene-blocked`**. +3/-3, 2 files.

**The defect is real.** `/tmp/ocx-249.xGQnxl/wt/gui/src/pages/Models.tsx:305-309`:

```
  const publishFeedback = (nextOk: boolean, message: string) => {
    setOk(nextOk);
    setStatus(message);
    setFeedbackGen(g => g + 1);
  };
```

A plain function reallocated every render, used by 21 call sites (lines 377, 379, 390, 392, 669, 829, 860, 1060, 1074, 1202, 1206, 1212, 1231, 1318, 1342, 1358, 1361, 1364, 1847, 1886). It is consumed inside a `useCallback` whose dependency array at `Models.tsx:698` omits it:

```
  }, [apiBase, displayNameModel, displayNameRecovery, finishDisplayNameEdit, load, t]);
```

The fix wraps it in `useCallback(..., [])` — sound, since the body uses only setters, which React guarantees stable — and adds `publishFeedback` to that dependency array. `useCallback` is already imported at `Models.tsx:8`. Correct as written.

**Why not LAND_AS_IS: two required checks are FAILING at head `35a4d99d6`.**

- `enforce-target` **fail** — `https://github.com/lidge-jun/opencodex/actions/runs/34175806010/job/101907870087`
- `hygiene` **fail** — `https://github.com/lidge-jun/opencodex/actions/runs/34175806012/job/101904837877`

Both with the identical cause, quoted from the job logs:

```
##[error]PR hygiene failed: missing_regression_test
##[error]PR quality gate failed: missing_regression_test
```

The PR changes `gui/src/pages/Models.tsx` and adds only `assets/pr-screenshots/model-feedback-review.png`. No test.

**Bounded fix to carry.** Add one GUI regression test — the natural shape is a source-level assertion in `gui/tests/` (the convention `gui/tests/page-polish-minimal.test.ts` already uses) checking that `publishFeedback` is declared via `useCallback` and appears in the `saveDisplayName` dependency array; or a render test that fires two consecutive identical feedback messages and asserts the toast timer re-arms, which is the behaviour the existing comment at `Models.tsx:300-304` says is at stake. Then re-push so `hygiene` and `enforce-target` go green, and dispatch `ci.yml`.

I would not waive `missing_regression_test` here. The gate is doing its job: this is a correctness change to a hook dependency array with 21 call sites and no coverage proving the stale-closure path.

**Conflicts:** clean.

## #3648 — docs(test): add Windows failure baseline — DEFER

Author Muki182, draft, `documentation`. +309/-0, 6 files: `WINDOWS_BASELINE.md`, `docs/issues/00{1,2,3,4}-*.md`, `docs/issues/README.md`.

**Two required checks are FAILING** at head `bd3644333da96e8bde362ce57c08bf75c68ac2be`:

- `hygiene` **fail** (2s) — `https://github.com/lidge-jun/opencodex/actions/runs/33965594679/job/101305187096`
- `resolve-pr` **fail** (58s) — `https://github.com/lidge-jun/opencodex/actions/runs/33965594725/job/101305037775`

`enforce-target` produced no check-run at all. Last updated 2026-09-05; four days stale with failures unaddressed.

**Substantive concern beyond the red checks.** The PR documents a *pre-stabilization* Windows baseline (9786 pass / 98 fail at fork snapshot `d881140`) and its own body concedes the numbers are superseded: *"the counts are a pre-stabilization snapshot — current authority is dev's green six-shard GHA runs (`devlog/_fin/260905_windows_suite_stabilization/`); do not diff this table against latest dev."* Merging a document that instructs readers not to trust its central table is a maintainer judgment call, not a mechanical one. Issue draft 004 is already self-withdrawn.

There is also a placement question: the PR writes to a new top-level `WINDOWS_BASELINE.md` and a new `docs/issues/` tree, while AGENTS.md establishes `devlog/_fin/` as the home for closed investigation records. Whether to open a second parallel docs location is exactly the kind of call to leave with a maintainer.

**Conflicts:** clean vs dev, but that is the only green signal here.

## #3748 — feat(telemetry): add privacy-safe local failure ledger — DEFER

Author yansigit, **not a draft**, `enhancement` + `review-ready`, review-ready since 2026-09-06 with no maintainer response. +642/-0, 8 files. Hygiene checks all green.

**Honest size/risk assessment, as requested.** This is not a small non-bug PR. It creates an entire new subsystem — `src/telemetry/ledger.ts` (+238), `src/telemetry/fingerprint.ts` (+62), `src/telemetry/types.ts` (+22) — and `src/telemetry/` **does not exist on dev**:

```
$ ls src/telemetry
NO src/telemetry ON DEV
```

**It is dead code as merged.** Grepping dev for any consumer returns nothing outside `devlog/`, and within the PR's own diff the only import of the ledger is from its test:

```
+import { TelemetryLedger } from "../../src/telemetry/ledger";
```

The body confirms this deliberately: *"Keep this foundation completely disconnected from request handling, dispatch, subprocesses, network calls, and remediation; those surfaces require separate authorization and review."*

So the maintainer decision is not "is this code correct" but "do we want a local SQLite telemetry ledger in this product at all, and do we accept 322 lines of unreferenced runtime code landing before its consumer exists." That is product direction. The author's own framing — a foundation awaiting separate authorization — is an explicit request for a maintainer decision.

Additional weight: a ledger that stores failure fingerprints is privacy-adjacent by construction. AGENTS.md routes credential/token handling to explicit security review, and while this PR sanitizes aggressively by design, "we sanitized it" is a claim a maintainer should verify rather than accept.

Being review-ready and unanswered for three days is a real cost to the contributor, and it deserves a prompt answer — but the correct answer is a product decision, not a merge. **Conflicts:** clean.

## #3742 — feat(cursor): add capability-gated account pool kernel — DEFER

Author yansigit, **not a draft**, `enhancement` + `review-ready`, review-ready since 2026-09-06/07 with no maintainer response. +784/-49, 4 files. Hygiene green.

**Honest size/risk assessment.** `src/providers/cursor-pool.ts` on dev is **72 lines** (`wc -l`), a small weighted round-robin router:

```
/tmp/ocx-249.xGQnxl/wt/src/providers/cursor-pool.ts:28:export class CursorCredentialRouter {
```

The PR is +334/-43 on that file — it does not extend the module, it replaces it wholesale with a new kernel, plus +313 of new tests and a new adapter seam in `src/adapters/cursor.ts`:

```
+  /** Optional internal pool seam. Owner is supplied by trusted route parsing, never request headers. */
+  selectPoolToken?: (owner: string, thread: string) => string | undefined;
```

**Three independent reasons this cannot be a Lane C mechanical merge.**

First, security. The author explicitly requests it: *"the kernel holds OAuth access tokens in memory and assigns opaque references, so explicit security review is requested."* AGENTS.md makes credential/token handling a review gate: *"changes touching authentication, credential/token handling, OAuth flows … require explicit security review per `MAINTAINERS.md`."* I am a read-only lane and cannot supply that.

Second, the existing `CursorCredentialRouter` is itself dead code on dev — its only importer is its own test (`tests/providers/cursor/cursor-pool.test.ts:2`). So this PR replaces one unused implementation with a larger unused one, and the same "do we want this at all" question as #3748 applies.

Third, the diff quietly changes the credential-isolation comment and reorders identity-scope derivation in `src/adapters/cursor.ts`. The new comment says pool ownership is "a trusted parsed-route field"; whether `_cursorIdentityScope` is in fact always trusted at that point is a security-boundary claim that needs a maintainer who owns that code path, not a diff reader.

**Conflicts:** clean. The staleness is real and unfair to the contributor, but "unanswered" is not a reason to merge an OAuth-token-handling kernel without the review its own author asked for.

## #4040 — feat(logs): show estimated decode throughput — DEFER

Author cb8010d6, not a draft, `enhancement` + `review-ready`. +166/-4, 15 files. Hygiene green.

Adds `decodeTokPerSecondResult` to `src/server/management/shared.ts`, a new `ttft_missing` reason to the `MetricUnavailableReason` union, `firstOutputMs` to `MetricSource`, new UI in `gui/src/pages/Logs.tsx`, and new strings in **all 9 locale files**.

The implementation is careful — it guards `usage_missing`, `usage_unsupported`, `output_missing`, `ttft_missing`, and `invalid_duration` before dividing, and the doc comment correctly warns that parent and attempt timings must not be mixed. It carries tests (`tests/server/management-api-logs-metrics.test.ts`, two `gui/tests` files).

**Why DEFER anyway:** a new user-visible metric in the Logs table across 9 locales is new product surface. The brief's bar is "adds no new product surface a maintainer would need to decide on," and this adds a second number to every row of a fixed-layout table. #4038 itself specifies stacking values in the existing rate column to avoid widening it — a layout tradeoff a maintainer should look at. **Conflicts:** clean.

### Issue #4038 vs PR #4040

#4038 is **OPEN**, `enhancement` + `gui`, opened 2026-09-08 by the same author (cb8010d6) three hours before the PR. It is AI-generated during triage and carries a "Proposed acceptance criteria" block.

**#4040 tracks #4038 closely.** The issue asks for `displayMetrics.decodeTokPerSecond` at management-API response time with no persisted-schema change; the diff adds a derived function in `shared.ts` and touches no `RequestLogEntry` or `usage.jsonl` shape. The issue asks for `ttft_missing` and `invalid_duration` reasons; the diff adds exactly those. The issue asks the value always be marked estimated; the diff's doc comment states why.

This is an author-authored issue paired with the author's own implementation — normal, but it means neither artifact represents an independent maintainer decision that the feature is wanted. **Keep #4038 open**; it is the product decision, and closing it should follow a maintainer accepting or rejecting #4040.

## #3987 — feat(codex): opt into client-side compaction — DEFER

Author cb8010d6, not a draft, `enhancement` + `review-ready`. +387/-29, 25 files. Hygiene green.

Adds a `codexClientCompaction` setting (`src/types/config.ts`, `src/config.ts`, `src/server/management/config-routes.ts`, `src/cli/system-command.ts`), changes `src/codex/inject.ts` (+36/-17) to emit a `[model_providers.opencodex]` table instead of overriding the built-in `openai` provider, plus dashboard UI, docs-site, and 9 locales.

**Clear DEFER.** This changes how OpenCodex injects itself into the user's Codex configuration and who owns compaction — squarely the product-direction category. `src/codex/inject.ts` is the seam between this proxy and the user's Codex install; the new form sets `requires_openai_auth = true` and interacts with the ChatGPT sign-in gate. The issue itself notes the opt-in "may use third-party provider quota for summary generation," a user-billing consequence. It also brushes the interop story around `ocx1:` envelopes and the #3916/#3920 recovery path. **Conflicts:** clean.

### Issue #3978 vs PR #3987

#3978 is **OPEN**, `enhancement`, opened 2026-09-08 by cb8010d6 an hour before the PR. Same author-issue/author-PR pattern as #4038/#4040.

**#3987 implements #3978's proposal closely** — the issue's "Expected managed Codex shape" TOML block (`model_provider = "opencodex"`, `requires_openai_auth = true`) matches the `src/codex/inject.ts` change, and the requested `{"codexClientCompaction": true}` key matches `src/types/config.ts`. The issue's stated requirements (default-off, byte-compatible when unset, no silent rewrite of existing `ocx1:` history) are the acceptance criteria a reviewer should check.

**Keep #3978 open.** It is a well-written feature proposal that a maintainer has not yet accepted; it is not resolved by dev today, is not a duplicate, and is not stale. It needs product judgment on compaction ownership.

## #4033 — feat(usage): show API list-price in breakdowns — DEFER

Author harryzhou2000, draft, `enhancement`. +147/-1, 13 files: `gui/src/pages/Usage.tsx`, all 9 locales, `gui/tests/usage-layout.test.ts`, `docs-site/src/content/docs/guides/web-dashboard.md`, one PR asset. Hygiene green, CodeRabbit skipped (draft).

Displaying what usage *would have* cost at API list price is a pricing-presentation decision: it depends on price-table accuracy and currency/staleness assumptions, and it will be read by users as authoritative. New user-facing surface in 9 locales plus a docs-site change. **Conflicts:** clean.

## #4042 — feat(usage): rebuild safe usage ledger retention core — DEFER

Author Vocllum, draft, `enhancement`. **+1464/-44, 14 files** — the largest item in the lane by a wide margin.

Six new `src/usage/` modules (`ledger-retention.ts` +239, `ledger-retention-job.ts` +331, `ledger-retention-config.ts` +106, `ledger-retention-scheduler.ts` +44, `ledger-retention-worker.ts` +37), a new GUI panel (`UsageLedgerRetentionPanel.tsx` +238), a new CLI capability (`src/cli/capabilities.ts` +22), new management routes, and a change to `src/server/background-lifecycle.ts`.

**`enforce-target` is FAILING** at head `320c20493b43d0dd59a7c8a0c043c2779a18f954` — `https://github.com/lidge-jun/opencodex/actions/runs/34245472213/job/102126234334`. The branch also shows 14 ci.yml runs in ~20 minutes, all `action_required`, indicating rapid force-pushing; the head is unlikely to be settled.

Separately, `tests/usage-ledger-retention-v2.test.ts` sits at the **root of `tests/`**, which `tests/test-layout.test.ts` forbids — AGENTS.md: *"only the two layout guards live at the root."* That is an independent likely CI failure once `ci.yml` actually runs.

Data-retention deletion policy over the user's usage ledger, on a background schedule, is a product decision with irreversible consequences. **Conflicts:** clean, but nothing else here is ready.

## #3983 — feat(debug): add content-free adapter and bridge stream diagnostics — DEFER

Author yansigit, draft, `enhancement`. +537/-23, 11 files. Hygiene green.

**Touches a protected core-path file:** `src/server/responses/core.ts` (+89/-14). AGENTS.md names exactly three files that carry every user's request path and are guarded by `tests/lab/core-lab-boundary.test.ts`, and this is one of them:

> Three files carry every such user's request path and must not reach `src/lab/`, directly or transitively: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`.

Also +97 in `src/bridge.ts` and a new `src/lib/debug.ts` surface. Diagnostics that observe streaming are privacy-adjacent — AGENTS.md: *"never introduce logging of request bodies, API keys, or account identifiers."* The PR says content-free, and the design intent looks right, but verifying that claim across the hot path needs `privacy:scan` plus the full suite on real CI, neither of which has run. **Conflicts:** clean.

## #3982 — feat(gui): make usage chart details keyboard and touch accessible — DEFER

Author yansigit, draft, `enhancement`. +370/-47, 15 files: `gui/src/pages/Usage.tsx` (+147/-38), `gui/src/styles.css` (+9/-4), all 9 locales, `gui/tests/usage-chart-interactions.tsx` (+187 new), a docs-site change, and a PR screenshot. Hygiene green.

Accessibility is worth doing and the direction is right. But a 147-line rework of chart interaction plus a global `styles.css` change is a visual/interaction redesign that wants a maintainer's eye on the actual rendered result, especially since it modifies shared CSS that other pages consume. The PR includes a screenshot (required by `enforce-target` for `gui` PRs, and present). **Conflicts:** clean.

---

## Shared files / stack order

**Conflict method.** For each PR: `git fetch origin pull/N/head:prN` then `git merge-tree --write-tree HEAD prN` against `7dc7dc99e`, in the scratch worktree `/tmp/ocx-lanec-bcdq/w`. **All 14 report CLEAN.** The `/tmp/ocx-249.xGQnxl/wt` index was not modified.

### Shared files *within* Lane C

| File | PRs | Note |
|---|---|---|
| `gui/src/pages/Usage.tsx` | **#3982** (+147/-38), **#4033** (+147/-1) | **Hard overlap.** Both substantially rewrite the same component. Serialize; the second will need a rebase regardless of merge-tree. |
| `gui/src/i18n/{de,en,fr,ja,ko,ru,tr,zh-TW,zh}.ts` | **#3982, #4033, #4040, #3987** | Each appends +2 lines. Likely textually adjacent; expect the 2nd–4th to need trivial rebases. |
| `docs-site/src/content/docs/guides/web-dashboard.md` | **#3982** (+4), **#4033** | Small; sequence them. |
| `scripts/test-layout/layout.json` + `tests/fixtures/test-layout-expected.json` | **#3897** (+1 each), **#3748** (+8/+2) | Both append to the same sorted maps. #3897 adds `"api-key-selection-capture.test.ts": "providers"`. Low-risk but same-file. |
| `gui/src/pages/Models.tsx` | **#3984** only | No Lane C overlap. |

### Overlap with the luvs01 fixture train (#4004 #4012 #4014 #4015 #4039 #4034 #4041 #4036 #4043 #4025 #4006 #3997)

**#4041 is a member of that train** (author luvs01, `agent/idle-deadline-reset-fixture-20260908`) and its PR body cites the macOS control run for **#4036** as the failure that motivated it. Order #4041 relative to #4036 within the train, not against Lane C.

**#3963 is also luvs01-authored** but touches only `devlog/_plan/260904_dashboard_minimal/`, which no other PR in either lane touches. Independent.

The Lane C LAND candidates touch files the fixture train does not:

- #3980 → `tests/cli/cli-status-json.test.ts` (sole)
- #3897 → `src/router.ts`, `src/providers/api-key-selection*.ts`, `structure/01_runtime.md`, plus the two layout registries
- #3963 → `devlog/` only

The one thing to watch: if any fixture-train PR also appends to `scripts/test-layout/layout.json` or `tests/fixtures/test-layout-expected.json`, it collides with **#3897** and **#3748**. Worth a targeted check before building parallel stacks.

### Recommended stack order

Three independent, conflict-free stacks:

1. **Stack A (test fixtures, safest):** #3980 → #4041. Different files, no interaction. #4041 should be ordered inside the luvs01 train relative to #4036.
2. **Stack B (docs, zero code risk):** #3963 alone.
3. **Stack C (source refactor):** #3897 alone. Shares the two layout registries with #3748, but #3748 is DEFER, so no live conflict.

**#3984** is not stackable until its `missing_regression_test` failure is fixed; once a test is added it is independent of A/B/C.

### Blocking precondition for every LAND in this lane

A maintainer must approve and dispatch `ci.yml` at each exact head SHA and confirm the aggregate `ci` check passes:

- #3980 → `b855765dd83f77162b13b00599f41b1447d9020d`
- #4041 → `9aa3e9204c12c1bbd9068e77115501e16203bb60`
- #3897 → `356f2c1db4e96a0a43e3d3209d35d97ec4e30291`
- #3963 → `5497cd9943c4b4c26e7b99926d9f0725b16f1cce`

All four are also **drafts**, so a maintainer must mark them ready (or the checklist gate must complete) before merge.

### What was NOT run

`bun run test` (full suite) and `bun run typecheck` — **NOT RUN**, forbidden by this delegation's scope. `bun run privacy:scan`, `bun run lint:gui`, `bun run build:gui` — **NOT RUN**. All focused test evidence is local Bun 1.4.0 on macOS in a scratch worktree and is not equivalent to the Linux/Windows/macOS matrix that `ci.yml` provides.
