# Coordinator stabilization acceptance

Consumes 010 after roadmap D at commit 2152fdfeb8. The prior conclusion was a
locked five-lane plan with a separate final regression phase, not runtime success.
Architect decisions S-01 through S-06 below refine that same direction.

## S-01: native acceptance receipts

NEW ignored `launcher-acceptance.json` and `windows-acceptance.json` under
`.tmp/release-stabilization/`: source/artifact SHA, prerequisites, invoked synthetic
scenario, expected/observed result, cleanup and verification boundary.

For #6220:

1. Read-only discovery establishes whether the actual launcher is installed, reachable
   and already authenticated. Do not install a browser extension or retrieve cookies.
2. If available, use a fresh isolated CLI home/session and the same synthetic prompt
   against the launcher directly and through an isolated proxy at the candidate SHA.
   Both must complete the same minimal current-turn request. Then exercise one bounded
   synthetic client-owned tool result and its follow-up through both routes.
3. Enable only the carried per-provider compatibility opt-ins in the isolated proxy
   config; preserve ordinary-provider stripping and xAI ID repair in focused tests.
4. Capture structural/error metadata only, never cookies, tokens or private histories.
   Stop only owned processes and remove only owned temporary state. If the required
   launcher/account is missing, record NOT EXECUTED with prerequisites and rationale;
   fixtures cannot certify this acceptance.

For #6473:

1. Read-only discovery checks available Windows host/toolchain and installed artifact
   identity. Do not toggle the operator's existing Start at Login setting or overwrite
   its Run entry as an incidental test.
2. If the patched packaged app can be exercised in an isolated Windows user/session,
   verify first registration quotes the executable under a path containing spaces;
   seed the legacy unquoted entry in that isolated profile, run the repair path, and
   read back the quoted command with arguments intact. Exercise login startup there.
3. If only native test execution is available, run a source-derived bounded probe with
   a unique temporary registry value and owned executable path; verify registration,
   repair and cleanup through actual Windows APIs. Report this as native component
   proof, not packaged-installer or login acceptance.
4. No unavailable package/session is treated as tested. Final release disposition
   distinguishes the report's observed registration defect from an unconfirmed startup
   failure and states precisely which behavior the collected evidence covers.

## S-02 through S-04: merge handoff

S-02 preserves A/B-before-E final composition and permits C/D in independent ready slots.
S-03 adds per-head merge receipts: source PR/head, carry authors, current base, test
coverage, exact-head CI event/run/attempt, independent review/security verdict and limits.
S-04 uses `scripts/ci/assert-mergeable-review.sh --maintainer-integration` for dev only.
The helper is actor/review evidence, not CI/security proof. A failed command stops the
dependent merge. Immediately re-read live head, dev target, actor and objections before
head-pinned merge, then verify the actual merge commit and late review threads.

The helper has been read from source and its command shape verified. It is intentionally
not run against an arbitrary PR during planning: no lane candidate exists yet. Each
candidate's actual invocation is recorded before its own merge; no passing claim exists now.

## S-05 and S-06: phase handoff

S-05 sends completed stabilization to 015 independent parallel regression; native
receipts and lane reviews do not replace that phase. S-06 keeps publication outside
this work phase, preserves main approval/push-CI policy and retains actual native gaps
for the final release-impact decision. A goalplan label never grants bypass authority.

## Consultation

Architect (receipt retained in private coordination evidence) proposed these six decisions.
Main accepted them. The same architect reflected ALIGNED on 011/010/015 with no
material gaps. Independent reviewer (receipt retained in private coordination evidence)
checked 010/011/015 and the policy boundary: VERDICT PASS, no blockers. This is
plan acceptance only; runtime/native and merge evidence is still required.
