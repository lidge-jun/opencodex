# wp6 — lock the invariants AGENTS.md claims are enforced

The audit's most useful negative result: the core invariants HOLD on `dev`, but two of
them are held by nothing except the current code being correct.

## Verified holding (do not "fix")

- `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts` do not
  reach `src/lab/`, including through dynamic `import()`. Independently re-walked.
- `src/server/index.ts:519` is `export function startServer` — not async. Bind at
  1836, activation at 1950, `return` at 1954, with no body-level `await` between.
  `scheduleStartupRun()` is a `setTimeout(..., 0)`, which does not yield the turn.
- Hygiene: 0 tracked `160000` gitlinks, no `.gitmodules`, no vendored reference
  clones, no security triage in open `_plan` (434 markdown files scanned).
- 13 new `src/` files since `main` all respect the slot pattern.

## Gap 1 — the promised no-await scan was never written

`AGENTS.md` states the synchronous activation guarantee as if it were enforced, and
`devlog/_fin/260814_lab_core_decoupling/080_activation_is_synchronous.md:143` recorded
it as a Phase-4 test. `tests/core-lab-boundary.test.ts` contains only the two
import-graph guards; no such scan exists anywhere under `tests/`.

That matters more than an ordinary missing test. The failure it guards against is
silent: an `await` added before the activation block lets the synchronous
subagent-fallback chain observe an empty evidence slot and route subagents to a
different model than the operator configured. Nothing goes red; the wrong model just
answers.

**Fix.** Add to `tests/core-lab-boundary.test.ts`:

- fail if `startServer` is declared `async`
- fail on a non-nested `await` between the `Bun.serve` call and `labActivationRequired`
- allow the awaits inside the `server.stop` closure (1877, 1888, 1889), which run later

Drive it red once — insert a temporary `await` — to prove it is not vacuous. That is
the standard `tests/repo-hygiene.test.ts` was held to.

## Gap 2 — the R3-1 profile-less dry-run assertion is missing

`devlog/_fin/260814_lab_core_decoupling/090_audit_round3_closeout.md:47` required a
behavioral assertion that a genuinely profile-less dry-run registers no slot. The
production fix is present (`src/server/management/routing-profile-routes.ts:293,368`)
but `tests/lab-activation.test.ts:62` only checks that a bare config never activates.

This was the exact "guard passes while the property is violated" path from audit round
3, so leaving it unpinned re-opens the door it was closed for.

**Fix.** One HTTP case: empty `routingProfiles`, dry-run a missing/unknown profile,
assert `hasPassiveRouteLinker() === false` and no evidence provider registered.

## Also correct the prose

`src/server/responses/core.ts:5194` still describes generic OAuth failover as "opt-in
and a strict no-op otherwise". Since #2568d it defaults ON at 2+ eligible accounts
(`src/oauth/generic-account-failover.ts:104-128`). The behavior is a recorded owner
decision and stays; the comment is simply now false and will mislead the next reader of
that path.

## Verification

- `bun test ./tests/core-lab-boundary.test.ts ./tests/lab-activation.test.ts`
- each new assertion driven red once before being accepted
- full suite on `ssh lidge` at the branch head
