# Stabilize the next production release

The recovered train is integrated, but new request failures and pending account,
pairing and accounting reviews need disposition before publication. Five isolated
implementation lanes prepare reviewed changes; this coordinator lands ready PRs
serially, verifies the complete candidate, and publishes the next stable release.

## Loop contract

- Archetype: satisfy-spec, C4 integration/release; trigger: explicit maintainer request
  to use inherited parallel worktree tasks and leaf subagents through deployment.
- Goal: address the listed scope, land safe changes progressively and verify production
  publication. Each lane owns its goal/FSM; leaves own neither and cannot spawn.
- Non-goals: unrelated features, native GitHub stacks, changing branch protection,
  new credentials, account preference changes, or replacing the operator's installed app.
- Verifier: focused activated regressions and exact-head required PR CI, then final
  candidate lane=all CI, release-line push CI and actual publication/artifact checks.
- Stop: all five work phases have evidence and production deployment is verified.
  Missing native evidence remains missing; closing an issue does not prove acceptance.
- Artifacts: this numbered unit, lane-owned numbered units, and ignored
  `.tmp/release-stabilization/` receipts. Unpublished security notes stay in scratch.
- Outcomes: DONE only with verified release; unresolved gates remain open. Host blocked
  status follows its recurrence rule; timeout/compaction is not a terminal result.
- Escalation: unavailable required access or policy conflict; no invented approval or
  weakened verification. Main reclaims only failed/retired lane work with provenance.
- Resources: existing repository/GitHub access and configured environments only; no
  new paid resources. No user token/time budget. Bounded commands, one CI observer,
  focused local tests under concurrent-worktree resource exception; CI covers breadth.

## Dependency order

1. `roadmap`: docs-only proposal, main dispositions, architect reflection, independent
   audit and document checks. Locks this ownership and acceptance map.
2. `stabilize`: execute [010](010_stabilization.md). Five worktree tasks prepare
   implementation PRs with inherited leaf reviews. Main integrates serially as ready.
3. `regression`: execute [015](015_independent_regression.md), a separate PABCD cycle
   with parallel independent inherited regression subagents before publication.
4. `candidate`: execute [020](020_candidate.md) after regression closure.
5. `publish`: execute [030](030_publication.md) after candidate acceptance.

Lane P phases own exact patch plans based on the current source. This coordinator
roadmap owns their dispatch and integration interfaces, not speculative implementations
of defects not yet diagnosed. No lane enters B without its own audited diff-level plan.

## Measured starting state

At initial inspection the previous full CI was successful at `7c59baf9597fbad188c49bb562bdd4858275766d`
(run 37110109894). Dev subsequently advanced; the initial fetched baseline for this
unit is `b82b39018b48ad489110b4165ee2cd9ba30433d5`, including #6501, #6506 and #6498.
The version sources report 2.77.0; latest stable is v2.76.0. Re-read both before selecting
the publication version. The current branch is `codex/release-stabilization-261003`.

Repository authorities: `MAINTAINERS.md`, `scripts/release.ts`,
`structure/ops/docs-and-release.md`, `.github/workflows/ci.yml`,
`.github/workflows/service-lifecycle.yml`, `.github/workflows/release.yml`.
Structure ownership remains with each implementation area; each lane updates its
matching structure and user documentation in the same implementation PR.

## Consultation and continuity

Architect (receipt retained in private coordination evidence) proposed ARC-01 through ARC-05.
Main accepts ARC-01 five lanes, ARC-02 B-before-E shared ownership, ARC-03 serial
integration with A preceding final E composition, ARC-04 native acceptance ownership,
and ARC-05 version pre-move and exact release-event proof. The same architect read
these four concrete documents and returned ALIGNED with ARC-01 through ARC-05,
with no remaining architectural gaps. Independent reviewer
(receipt retained in private coordination evidence) passed the original plan and ARC-06 supplement.
Its gate-recording clarification was folded into 010 and rechecked: VERDICT PASS,
no remaining blockers. No implementation or
release readiness is claimed by this roadmap. The preceding completed recovery unit
established integration readiness, explicitly not a publication receipt; this new unit
adds the user-authorized fixes, acceptance and publication.

User steering added ARC-06: a separate independent parallel regression PABCD cycle.
The same architect reflected ALIGNED and identified one SHA handoff gap. Main folded
it into 020: candidate C must equal the regression-approved SHA; intervening product
changes require affected regression and matrix review. This preserves the accepted flow.
