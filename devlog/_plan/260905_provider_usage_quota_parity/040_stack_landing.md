# Verified bottom-up stack landing

## Final integration pass

Pre-merge freshness update: all four45f3-based integration runs passed, but published
dev advanced to `09335d7d451335a74ad1c02e88ee37ef89f5a007` before landing. Its seven-file
delta is the upstream CLI status split, adjacent regression and documentation. Preserve
it verbatim through a normal merge and cascade, then require new exact-head/tree CI for
all four layers. No quota behavior or prior review fix is replaced, and no historical
passing run is relabeled as proof of the new integration tree.

The user ended cross-task CI coordination and instructed the remaining tasks to proceed
independently. Continue this stack without waiting for another task's START or sending it
messages. No local tests, typecheck, build, lint or scan; the previously authorized
no-verify pushes and CI-gated admin merges remain in effect.

Class C4 integration verification, satisfy-spec loop. Consume the earlier verified quota
layers without redesigning them. Current published baseline is
`45f3bed84be10a7e045a20aae1db46ab822bf7d0`; this incorporates provider registration and
pending-selection contracts plus the upstream port-probe repair. Preserve those public
changes verbatim. The source delta in this pass is their actual merge into the bottom
branch, cascaded through API and UI, not a synthetic no-op edit.

Exact change map: MODIFY this landing record; MERGE the published baseline into
`codex/provider-usage-attribution`; MERGE each new lower tip into
`codex/provider-account-quota-api` then `codex/provider-quota-parity`; MERGE the new UI tip
into `codex/provider-ci-isolation-followup`. The follow-up already contains reviewed
commit `b37841448816107c856171277dff0464032d282e`, limited to the update-recovery fixture
and its numbered record. Retain it as a fourth test-only stack layer. No new production
behavior is planned. Any semantic conflict requires a concrete plan amendment and review.

The UI cascade has one textual conflict in `gui/src/pages/Providers.tsx`: retain this
unit's `useQuotaRefreshCoordinator(apiBase)` and upstream's `fetchConfig:
refreshConfigResult` binding together. Keep the upstream void-returning `fetchConfig`
adapter and result-aware `useProviderModelsNotice` caller unchanged. Existing quota epoch
and registration-notice tests must both execute in the new CI. This composes the two
existing contracts; it does not restore superseded unbounded refresh waiters.

Preserve all original commits; use normal merge commits and fast-forward no-verify pushes,
not rebases or force-pushes. Inspect each integration diff, check that inherited quota,
registration and pricing semantics survive, and obtain independent review before publication.
Every layer needs its own new full applicable GitHub CI, including the follow-up's actual
negative-inheritance and recovery scenarios. Old green trees are context, not final proof.

Repository auto-deletion requires retargeting the direct child to dev BEFORE admin merging
its parent. Verify unchanged child head, then merge only the parent with
`--admin --merge --match-head-commit <verified-head>`. Fetch dev and prove both the merge
commit's ancestry and its tree match with the tested integration. Before each later merge,
refresh head/base/tree/reviews/checks; a changed integration tree needs fresh CI rather than
an old workflow rerun. Do not alter repository settings, other tasks' CI, live services or
user history. The final documentation record and archive must be published with their own
appropriate remote checks; no completion until all four layers and closure are on dev.

Verifier: GitHub run/job output at the exact head and checkout tree (all required jobs
completed successfully), review-thread reads, `git diff`/`git merge-tree` for static
integration inspection only, and fetched `git merge-base --is-ancestor` for delivery.
No local executable verifier runs. Source/layout unchanged by a merge does not require
another render; any actual quota layout change requires a fresh observed isolated render.
The user-visible quota matrix and screenshots already recorded in031 remain required.
Terminal success is all original requirements plus follow-up and closure delivered, not
merely a clean textual merge. Preserve unknown historical usage and do not claim a fixed
historical stall without evidence. Active integration work is bounded to90minutes before
reassessment; queued remote CI time is excluded, and no new credential or spending authority
is introduced.

## Authorized continuation

The user explicitly extended this goal to the CI-blocking launcher, shim and process
failures and authorized completion without further routine scope pauses. Existing no-local-
suite/typecheck/build/lint/scan restrictions remain. Verification is remote CI only; commits
and pushes use no-verify. The live proxy, user accounts and usage history remain untouched.

Replan the unfinished landing cycle; no prior failed check is marked successful. First improve
bounded diagnostic classification in `src/codex/shim.ts` and its existing integration test,
and in `tests/update/update-stop-first.test.ts`. Keep unknown outcomes fail-closed. Do not
raise production deadlines, accept live descendants, suppress assertions, expose raw child
output or add retry-to-green behavior. Detailed diagnostic hypotheses and the write map live
in ignored scratch space. Then repair only causes established by remote evidence, with an
independent security/implementation review before publishing each dependent cascade.

Main owns shim outcome diagnostics and its test; the delegated update worker owns only the
update-recovery fixture and its bounded tests. No worker may modify Git, CI state, the goal,
another worker's files or run local validation. New production fixes beyond diagnostics are
amended here and independently audited before writing. Allow up to 90 minutes of active
work for this authorized repair pass; exclude external CI queue time from active work.

Depends on all implementation layers. Execute as `landing`; production changes are limited
to the authorized, reviewed CI-blocking diagnostics and evidence-backed corrections.
Inherit resource/scope limits from 000. User explicitly authorizes no-verify pushes and admin merges only after CI succeeds.

## Actions

1. Inspect `git status --short`, `git worktree list`, each branch tip and `gh pr view --json headRefOid,baseRefName,statusCheckRollup,reviewDecision,mergeStateStatus`.
2. Inspect exact-head CI via `gh run list --commit <sha>` and failed job logs when necessary. An empty required-check list is not proof. Resolve correct review findings without suppressing tests.
3. Ensure every PR includes Summary, Verification and Checklist, a linked stack map, explicit no-local-suite note, and UI screenshot for UI changes. Record admin bypass authorization in the PR description.
4. After exact-head/integration-tree full CI, retarget the direct child to `dev` before its parent merges, because this repository automatically deletes merged remote heads. Preserve local lower refs.
5. Merge only the bottom PR with `gh pr merge --admin --merge --match-head-commit <sha>`; refresh the child's head/base/tree and checks. Reconstruct only session-owned branches with normal merges and no-verify fast-forward pushes; no destructive worktree operations.
6. After each merge, `git fetch origin dev` then `git merge-base --is-ancestor <merge-sha> FETCH_HEAD`. Record PR, CI head, merge SHA and ancestry outcome in `041_delivery.md`.
7. Archive the completed unit from `_plan` to `_fin` only as an explicit final documented source change with its own remote checks if it alters a pending PR. Otherwise retain a terminal closure record without inventing extra unverified commits.

## Completion evidence

All exact-head CI jobs passed, original symptom and quota state matrix observed, no user history modified, no live service restarted, no local suite executed, every authorized stack layer on fetched dev. Final report distinguishes repository delivery from runtime deployment.

## Verifier and terminal conditions

Pre-merge review remediation: preserve the rejected selector in Chat/Messages early 404 logs
(`src/server/{chat-completions,claude-messages}.ts` and the existing policy surface regression),
and use null-prototype provider-keyed accumulators in the provider workspace with `__proto__`
and `constructor` regression rows. Record final roadmap audit closure and clearly mark the
superseded global-scheduler design in020. These remain the attribution layer's thesis; amend
the bottom branch, cascade every upper branch before pushing, then require renewed exact-head
CI. Credential-reader redirect controls belong to the already implemented API layer, not to
the attribution layer's executable scope.

Freeze the integration baseline at fetched `dev`55395a9dc. It adds Antigravity weekly and
Ollama Cloud quota support during this task. Preserve both implementations and the optional
reset observer while merging the baseline into the stack. Resolve the quota dispatch conflict
by retaining the shared key-reader selector and registering the incoming canonical Ollama
reader there; add a per-key Ollama regression. All layers must receive the integrated baseline
before publication and new exact-head CI. Do not chase unrelated later changes without a
concrete integration conflict or verifier requirement.

The integrated baseline's remote CI exposed three concrete quota-reset contract gaps:
an undeclared management route/lazy dispatch guard, a strict expected quota shape missing
`shortObservedAt`, and an HTTP webhook fixture rejected by the existing HTTPS schema.
Repair these integration gates in the bottom layer and cascade both children. Register the
existing `provider resets` command and route without an exemption, retain exact quota
assertions, and bridge only the test's HTTPS transport to its local receiver. Do not relax
HTTPS/SSRF protections or run local validation. Kant independently reviewed both the two-test
delta and the four-file route/capability delta: PASS, including explicit security review
of unchanged authentication, exact inner method/path guards and lazy imports. All three
new heads still require remote CI.

Concrete follow-on conflict: upstream PR #3622 landed the same quota-reset integration repairs,
followed by #3623's update-test diagnostic change, at `dev`1c1ca060a. Preserve both commits.
Use upstream's route/capability declarations and generated reference verbatim; retain this
unit's stricter observation-time, HTTPS-schema and payload-privacy assertions without duplicate
properties or fixtures. This conflict resolution, not unrelated base chasing, advances the
frozen baseline. Cascade every child and require fresh exact-head CI.

The webhook fixture bridges an HTTPS-shaped test URL to an HTTP loopback receiver. It
verifies configuration acceptance and activation/delivery, not TLS negotiation or certificate
validation. These remain outside this fixture's evidence claim.

The Windows stabilization stack then landed #3610/#3613 at `dev`be81013fa, creating another
concrete conflict in the same webhook fixture. Adopt its portable receiver-promise wait and
fetch shim intact; keep only this unit's additional HTTPS-schema rejection and payload
privacy assertions there. Preserve upstream eager-relay cancellation changes verbatim.
Do not replace the new cross-platform fixture with the superseded polling fixture.

CI repair scope: the output-byte case in `tests/lab/lab-live-pinned-timeouts.test.ts`
inherits 30ms first-byte/inactivity deadlines from neighboring timeout tests. The macOS
failure reached `first_byte_timeout` before the byte guard. Give only this size case 1000ms
first-byte/inactivity budgets, keeping the 128-byte response, 16-byte ceiling and exact
`output_byte_limit` assertion. Inject the same 150ms response delay used by the neighboring
timeout case so restoring the old 30ms budget deterministically preempts the intended guard.
Keep both dedicated timeout tests and all production limits unchanged. Add an exact-16-byte
success boundary under the size-case budgets. Record hypotheses and remote red/green evidence
in 013; no local validation, skip, retry policy or CI workflow change is permitted.

Upstream #3552 advanced `dev` to 9fe986d84 and conflicted in the same quota-observation
test. Preserve its main-account hard-lock and private quota-provenance implementation
verbatim, including monthly-primary semantics and exact quota-reset dispatch. Resolve only
the local snapshot variable name while retaining strict shape/equality and observation-time
bounds. No new hard-lock behavior is designed in this unit; fresh integrated CI is required.

CLI GitHub reads are bounded, at most one fresh rollup per meaningful head/state change. Capture C receipt using the exact-head CI verification command. DONE only with all ancestry proofs; wait for pending CI using bounded polling, never call pending CI a blocker.
