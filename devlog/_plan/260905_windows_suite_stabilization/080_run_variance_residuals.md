# 080 — wp5 (research): two more hosted-runner timing residuals surface on the 5th run

Run 33930757649 (head `fd786be83`, PR #3555): windows 1/4 and 3/4 SUCCESS.
**The change under test passed** — `anthropic-quorum-cache` 7/7 on 2/4. But 2/4
and 4/4 each failed on ONE case that had passed on every one of the four
previous runs of this stack:

| shard | case | wall | what timed out |
|---|---|---|---|
| 2/4 | `codex-write-lock > two real processes contend for one lock > one OS user and one home take ONE lock, case 0` | 10.67 s | `waitFor(holdMarker)` — default 10 s (`codex-write-lock.test.ts:314`) waiting for a spawned holder child to write its marker |
| 4/4 | `codex-composed-acceptance > B-reduced: a held local provider cannot commit after the HTTP route persists OFF` | 57.7 s | a `fx.request(..., SERVER_BUDGET_MS)` (30 s) `AbortSignal.timeout` — `TimeoutError: The operation timed out` |

## Same class, already named

Both are `test-budget-sized-from-local-timing` (corpus, added this unit) with a
twist: neither is a per-test budget. They are **internal waits** whose bound is
shorter than a Windows child boot or a Windows server round-trip under load.

- `waitFor(holdMarker)` has the same shape as the 8-11 s child boot that
  `retained-root-serialization` documented at its `:99` comment. The file's own
  comment at `:430` already knows this ("process boot took >4 s on
  windows-latest in run 33603770447") and raised `holdMs` to 20 s for it — but
  left `waitFor`'s default at 10 s. On this run the holder took longer than
  that to boot.
- The composed-acceptance case already carries one Windows fix in its
  comments (`idleTimeout: 255` because Bun's 10 s default cancelled the held
  request on a loaded shard). This time the client-side `SERVER_BUDGET_MS`
  abort fired first. Its siblings on the same run took 47.9 s and 57.8 s and
  passed, so 30 s for one round-trip is inside the runner's noise band.

## What this run says about the runner

Five dispatches of this stack on `windows-latest`, same job class:

| run | 1/4 | 2/4 | 3/4 | 4/4 |
|---|---|---|---|---|
| 33920624827 | ✓ | K-owner 15 s timeout | ✓ | ✓ |
| 33923803071 | ✓ | K-owner 20 s timeout (next case) | ✓ | ✓ |
| 33926041666 | ✓ | ✓ | ✓ | ✓ |
| 33928082123 | ✓ | quorum-cache ×3 (dev drift) | ✓ | ✓ |
| 33930757649 | ✓ | write-lock `waitFor` 10 s | ✓ | composed-acceptance 30 s abort |

Every red cell is a bound that a slower-than-usual run crossed; no red cell
is an assertion about behaviour. The runner is not getting worse — the
quorum-cache file (fixed here) and the K-owner file (fixed in #3550) are both
green on this run — it is that each run samples a different slow child, and
the suite has more sub-10 s waits than the four we have fixed.

## Honest reading of the acceptance bar

`c-1` asks for 0 fail twice consecutively. Run 3 was the first; run 4 broke on
dev drift (fixed, #3555); run 5 broke on two more waits of the same class.
"Twice consecutively" is not going to be reached by fixing the residual each
run exposes and re-dispatching, because each 25-minute run samples one or two
new ones out of a population we have not enumerated.

The faster path is to enumerate the population once: grep the suite for every
internal wait shorter than the hosted-runner floor and budget them as a
class, the way `retained-root-serialization` was fixed in `050` after
budgeting one case moved the failure. That is the next work-phase.

## Next work-phase (wp5)

1. Inventory: every `waitFor`/`waitForPath`/`AbortSignal.timeout`/
   `Bun.sleep`-poll deadline under `tests/` with a literal below 30 s that
   gates on a spawned child or a real server round-trip. `rg` for the
   patterns, then read each hit for what it waits on.
2. Classify each: intrinsic child/server wait → `SPAWN_BUDGET_MS` /
   `SERVER_BUDGET_MS` / `isolationBudgetMs()`; pure-logic wait → leave alone.
3. One PR (stack 5) with the class change and a comment per site naming the
   run that motivated it, then two consecutive dispatches.

Fixing only `waitFor`'s default and the one `SERVER_BUDGET_MS` call would be
the same mistake `050` recorded: it moves the failure to the next site.

---

## Inventory (wp5 step 1, done)

`rg` over `tests/` for literal deadlines that gate on something external —
`waitFor*(…, N)`, `deadline = Date.now() + N`, `AbortSignal.timeout(N)`,
helper defaults `timeoutMs = N` — excluding sites already on a named budget.
58 hits. Classified by what the wait actually gates on, after reading each:

### A. Gates on a spawned Bun child reaching a marker — MUST budget

These are the `retained-root` shape: a real `bun --eval` boot that costs 8-19 s
on `windows-latest`, behind a literal under 20 s.

| site | literal | gates on |
|---|---|---|
| `codex-integration/codex-write-lock.test.ts:314` | `waitFor` default 10 s | holder child writes marker (**failed run 5**) |
| `codex-integration/codex-history-lock.test.ts:59` | `waitForPath` default 10 s | child marker |
| `codex-integration/native-profile-startup.test.ts:229` | `waitForPath` default 10 s | child marker |
| `codex-integration/native-profile-startup.test.ts:243` | `waitForPort` default 18 s | child binds a port |
| `codex-integration/native-profile-manager.test.ts:199` | 12 s | child ready marker |
| `codex-integration/codex-history-worker.test.ts:346` | 10 s | worker child |
| `codex-integration/codex-inject-write-lock.test.ts:343` | 10 s | child marker |
| `oauth/oauth-refresh-lock-multiprocess.test.ts:95` | 15 s | child |
| `codex-integration/codex-retained-root-serialization.test.ts:203,373,450` | 12 s / 16 s | child marker — the file `050` budgeted at the CASE level; its internal waits are still literal |
| `codex-integration/codex-retained-root-serialization.test.ts:514` | 8 s | two children |

### B. Gates on a real server / HTTP round-trip — MUST budget

| site | literal | gates on |
|---|---|---|
| `codex-integration/codex-composed-acceptance.test.ts:494,503` | `SERVER_BUDGET_MS` 30 s | already named, still lost on run 5 at 57 s wall; the CASE budget is 150 s on CI, so the per-request bound is the one that fires. See note. |
| `server/server-background-lifecycle.test.ts:221,243` | 5 s / 10 s | live server + storage worker |
| `storage/storage-policy-job-responsive.test.ts:140` | 10 s | server under a blocked worker |
| `storage/storage-worker-lifecycle.test.ts:70,80`, `storage-worker-teardown-isolate.test.ts:95` | 10-20 s | Worker thread lifecycle (Windows OS-thread join is the slow half; `worker-lifecycle.ts` already keeps a 1.5 s settle) |

### C. Deliberately short — LEAVE ALONE

Bounds that exist to prove something is fast or absent; raising them would
weaken the assertion:

- `AbortSignal.timeout(500/800)` on `/healthz` polls (`composed-acceptance:251`,
  `cli-start-journal-order:135`, `ocx-launcher-runtime:57`, `shutdown-launcher:63`,
  `local-management-direct-transport` ×4) — each is inside its own retry loop
  whose OUTER bound is already a budget; the 500 ms is per-probe.
- `issue-914-transport-attribution:163` — `fetch("http://127.0.0.1:1/")` is
  asserting a refused connection, 5 s is generous.
- `terminal-guard:235` (25 ms), `web-search-progress-stream:15` (100 ms),
  `translator-budget:17` (2 s) — in-process logic, no child, no socket.
- `windows-secret-acl:1680,1714,1831` (5 s) — stubbed runners, in-process.
- `deepseek-*`, `responses-reasoning-summary-passthrough`, `cli-account:397`
  (`AbortSignal.timeout(5_000)` on adapter calls against an in-process mock
  server) — no child, loopback only, 5 s is not the floor these hit.

### D. Ambiguous — read at B, decide per site

`oauth-status-privacy:365,427`, `oauth-manual-code:226`, `codex-account-store:1302`,
`codex-shim:1704`, `codex-prompt-*:35,74`, `native-main-claim:202`,
`native-profile-drain-server:189`, `server-live:1221,1309`,
`storage-policy-config-race:135`, `cursor-http1-transport:289`,
`package-tree-integrity:192`, `user-cost-overlay-*` — 2-5 s deadlines whose
subject I have not read yet. Rule for B: if the loop body spawns or awaits a
real listener, it is A/B; if it polls in-process state, it is C.

### Note on the composed-acceptance case

Its per-request bound is already `SERVER_BUDGET_MS` and it still lost. The
siblings on the same run took 47.9 s and 57.8 s and PASSED, so this case's
total (57.7 s) is inside the file's normal band; what fired was one
`fx.request` at the 30 s mark while the server was mid-startup under four
shards. The honest fix is not "raise 30 to 60" but to give the held-request
pattern its own named bound: the request is deliberately held open by the
fixture until `release()`, so its ceiling is "a startup plus a held gather",
not "a request". That is a design note for B, not a number.

## Plan for B (wp5)

One PR. For every A/B site: replace the literal with the matching named budget
(`SPAWN_BUDGET_MS` for a child boot, `SERVER_BUDGET_MS` for a round-trip,
`isolationBudgetMs()` where the file already scales by lane), and leave a
one-line comment naming the run that motivated the class (33930757649). For
each helper with a default (`waitFor`, `waitForPath`, `waitForPort`), change
the DEFAULT so every caller inherits it. C sites untouched. D sites resolved
by reading, listed in the commit message either way.

Verifier: macOS focused run of every touched file, `typecheck`, then two
consecutive CI dispatches. The ablation rule from `test-budget.ts` applies per
file: at least one case per touched file is driven red by disabling the thing
it waits for, so a budget cannot hide a vacuous wait.

---

## Review of 3b431b413: FAIL (6 blockers) — the composition invariant

The implementation reviewer found the shape of the first attempt wrong, and the
argument is structural, not a nit.

`watchdogMs()` returns **45 s on Windows CI**. I applied it to INTERNAL waits
inside tests whose OWN budgets are 15, 20 or 30 s. So on the platform this fix
targets, the internal deadline is now LONGER than the test — Bun's per-test
timeout fires first, and the wait's diagnostic ("timed out waiting for
`<marker>`") never prints. That is the exact inversion `test-budget.ts:64`
warns about: "keep these at least a few times under the surrounding budget".
It also destroys the one thing the diagnostic was for — naming WHICH child was
slow — and replaces it with a bare timeout, which is where this unit started.

| file | internal wait now | enclosing budget | result on Windows CI |
|---|---|---|---|
| `native-profile-manager` | 45 s | **15 s** ×4 cases | bare timeout, no diagnostic |
| `codex-history-lock` | 45 s | 30 s | bare timeout |
| `codex-write-lock` | 45 s | 30 s ×4 | bare timeout |
| `oauth-refresh-lock-multiprocess` | 45 s | 30 s | bare timeout |
| `codex-history-worker` | 45 s | 30 s | bare timeout |
| `codex-retained-root`, `codex-inject-write-lock` | 45 s | 45 s | tie — diagnostic races Bun |

### Corrected shape

Two knobs, moved together, the way `test-budget.ts` and `ci-watchdog.ts` say:

1. **Internal waits that gate on a spawned child or a live server use
   `INTERNAL_DEADLINE_MS` (15 s)** — the repository's named constant for
   exactly this ("a deadline inside a test, for an await that would otherwise
   hang forever"). It is already what `windows-tray`, `cli-models` and
   `oauth-store-multi` use. Not `watchdogMs`, which is for the OUTER
   watchdog and is sized to sit under the lane's 60 s.
2. **Every enclosing case whose body spawns a child or binds a server gets
   `SPAWN_BUDGET_MS` (45 s) or `SERVER_BUDGET_MS` (30 s)** — a few times the
   internal deadline, as the invariant requires, and under the 60 s lane ceiling.

On the failing runs the child took 8-19 s: 15 s internal still loses on the
slow tail. That is acceptable ONLY because the diagnostic then fires and names
the marker, which is the signal we want — and it is why (2) matters: the case
must outlive the diagnostic so the diagnostic is what gets reported. If 15 s
proves too tight in practice, the right move is to raise `INTERNAL_DEADLINE_MS`
once, in the helper, with the run number — not to reach for `watchdogMs`.

### The other five blockers, dispositions

- **b2** `retained-root:515` (8 s two-child barrier) and `:555` (20 s child
  deadline) were in my own class-A inventory and not changed. Change both.
- **b3** Ten more A/B sites the reviewer's re-run of the grep found that mine
  missed (`codex-shim:1704`, `codex-prompt-route:73`, `codex-prompt-text-probe:34`,
  `native-profile-drain-server:189`, `server-live:1221,1309`,
  `helpers/storage-policy-api:61`, `storage-mutation-race:127`,
  `api-storage-policy-put-race:55`, `helpers/windows-power-shell-fixture:22`).
  My inventory regex excluded helper files and missed `deadline = Date.now() +
  N` where N was a variable. Read each; budget the ones that gate externally.
- **b4** `storage-policy-job-responsive:143` — the loop falls through on
  expiry with no throw and no final assertion, so it is vacuous today
  regardless of the bound. Add `expect(status).toBe("idle")` after the loop.
  This is a real find independent of Windows.
- **b5** `composed-acceptance` — `SERVER_BUDGET_MS * 2` was arithmetic, and my
  "two serialized legs" model is wrong: `fx.start()` completes BEFORE the held
  request begins, and the held request and the OFF round-trip overlap. Name
  it: `HELD_REQUEST_BUDGET_MS = SERVER_BUDGET_MS` with a comment that the bound
  covers "a gather held open until `release()` plus one overlapping mutation",
  and derive nothing from `* 2`. Since the case budget is 150 s on CI and the
  request was aborted at 30 s while the case sat at 57 s total, the real
  question is whether 30 s is enough for a gather under startup load; the
  siblings say yes at 47-58 s total. Keep 30 s named, do not double it.
- **b6** Ablation evidence — blocked by another session holding the user
  test lock at the time; must be run before this lands. Two files selected:
  `codex-history-lock` (disable the holder's `writeFileSync(ready)` → the
  helper's "timed out waiting for" must print, not Bun's timeout) and
  `storage-policy-job-responsive` (after b4, block the job → the new
  `expect` must fail).

### Reading of what I did wrong

I reached for the helper whose name matched ("watchdog") without reading the
two paragraphs above it that say what it is for and what it must stay under.
The reviewer read them. Same failure as `007` in a smaller key: pattern-matched
the fix instead of measuring it against the constraint.

### Blocker-3 sites, read and dispositioned

| site | what the loop gates on | disposition |
|---|---|---|
| `codex-shim:1704` | spawned holder child's ready marker | **A → INTERNAL_DEADLINE_MS** |
| `codex-prompt-route:73` | `waitUntil` used only for spawned probe child pid/start markers (5 callers) | **A → INTERNAL_DEADLINE_MS** |
| `codex-prompt-text-probe:34` | same shape, child pid marker / child exit | **A → INTERNAL_DEADLINE_MS** |
| `helpers/storage-policy-api:61` `waitForJobIdle` | live server, worker-backed job settling | **B → INTERNAL_DEADLINE_MS** (helper default; every caller inherits) |
| `storage-mutation-race:127` `waitForPolicyJob` | same as above, local copy | **B → INTERNAL_DEADLINE_MS** |
| `native-profile-drain-server:189` | in-process `Bun.serve` counters (`upstreamCloses`), no child | **C — leave** |
| `server-live:1221` | in-process WS frame arrival on a loopback server already up | **C — leave** (2 s asserts latency of an established socket) |
| `server-live:1309` | frame-log file written by the same process | **C — leave** |
| `api-storage-policy-put-race:55` | `sawRunning` peek loop — the assertion is that the job is STILL running during the edit window; a longer bound would wait for it to finish and invert the test | **C — leave, deliberately** |
| `helpers/windows-power-shell-fixture:22` `probeWindowsPowerShellFixture` | spawns a real PowerShell — but it is a PREFLIGHT whose `ok:false` result skips the dependent cases with a reason; 5 s is the "is PowerShell usable at all" bound and lengthening it only delays a skip | **C — leave** |

Five budgeted, five left with a reason each. The inventory regex missed
`tests/helpers/*.ts` and `deadline = Date.now() + <identifier>`; both are
now in the grep.
