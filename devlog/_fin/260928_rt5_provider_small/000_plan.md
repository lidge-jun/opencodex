# rt5-provider-small — roadmap

Release train 5 hands this lane six contributor PRs. Five of them land through four small
pull requests against `dev` (#6130 and #6131 share one), each cut from the latest
`origin/dev` and carrying the contributor's commits with a `Co-authored-by` trailer; #5539
is dropped with a recorded reason. Kiro users stop hitting `IMAGE_COUNT_EXCEEDED` (#6118) first; the
retry-policy, compaction-image, and Command Code fixes follow in that order.

## Loop spec

- Loop archetype: satisfy-spec, one PABCD cycle per PR.
- Trigger: coordinator dispatch packet for lane `rt5-provider-small` (source thread
  01a0e6dd-d946-7562-81f6-7c5b43581439).
- Goal: each item is an open PR against `dev` with green Ubuntu CI on its current head,
  or dropped with a reason.
- Non-goals: merging (coordinator), `gui/`, Windows/macOS manual CI, CodeRabbit,
  contributor PR comments, other lanes' branches and worktrees.
- Verifier: per PR `bun test <focused files>`, `bun run typecheck`,
  `bun run test:changed`, `bun run structure:check`, `bun run privacy:scan`, then the
  PR's Ubuntu CI checked by head SHA and run id (`gh pr view --json statusCheckRollup`).
  Full-suite exception (AGENTS.md "Commands"): several release-train lanes run full suites
  in parallel worktrees on this host, so the local full `bun run test` is replaced by the
  hosted four test shards, which run the full suite on each PR's exact head; each PR's
  Verification section records this.
- Stop condition: every item in an open, green PR or dropped; wp6 closes when CI is green.
- Memory artifact: this unit plus `.codexclaw/goalplans/lane-rt5-provider-small-*`.
- Expected terminal outcomes: DONE (all handled); BLOCKED if hosted CI stays unavailable;
  UNSAFE if an item needs a security-boundary change beyond scope.
- Escalation: a change that would alter auth/credential handling, or a CI failure caused by
  another lane's merge that this lane cannot fix inside its write scope.
- Resource bounds: local git/gh/bun in this worktree, push only to `codex/rt5-*`; the user
  set no token or time budget.

## Work-phase map

The four PRs touch disjoint source files, so no phase consumes another's output. The order
is the coordinator's readiness order, and each phase closes with its own verifiable PR.

| Phase | Doc | Branch | Source |
|---|---|---|---|
| wp1 | 010_kiro_images.md | codex/rt5-provider-small-kiro-images | #6130 + #6131, Closes #6118 |
| wp2 | 020_retry_policy_carry.md | codex/rt5-provider-small-retry-carry | #6121 |
| wp3 | 030_compaction_images.md | codex/rt5-provider-small-compaction-images | #6150 |
| wp4 | 040_command_code_echo.md | codex/rt5-provider-small-command-code-echo | #5964 |
| wp5 | 050_effort_wire_drop.md | none (dropped) | #5539 |
| wp6 | 060_ci_closure.md | all of the above | — |

## Overlap and ratchet facts (origin/dev cbe0d40daf, 2026-09-28)

- No touched file has a cap in `tests/fixtures/file-size-baseline.json`.
- No new test files, so the test-layout registries need no entries.
- `structure/transports/responses.md` reaches its 600-line budget exactly with #6150 and
  `responses-failover.md` keeps one line of headroom; wording fixes there add no lines.
- `docs-site/src/content/docs/reference/adapters.md` is edited by both the Kiro PR and the
  Command Code PR, in different sections.

## Discovery evidence

Five read-only explorer packets (gpt-6-sol, 2026-09-28) are summarized in each decade doc.
Survey rows: coordinator worktree `.tmp/rt5-survey/pr-a.md` and `pr-b.md`.

## Architect consultation

Architect handle `01a0e6f0-2ded-7160-8a0f-42716ed491c2` (gpt-6-sol, read-only) returned
decisions D1-D6 on plan revision 1.

| ID | Proposal | Main disposition |
|---|---|---|
| D1 | Split #6130 and #6131 into two PRs | Rejected: the coordinator packet says to land them together; one PR keeps the six commits separate so review can still read them apart. |
| D2 | Drop #5539 | Accepted (050). |
| D3 | Keep the provider-agnostic 400 classifier, fix the Google-only wording | Accepted (030 step 2). |
| D4 | PATCH keeps unnamed retry policies on endpoint change (field mask) | Accepted; docs already say PATCH keeps unnamed fields (020). |
| D5 | Add a late `tool-input-start` regression to #5964, fix if red | Accepted (040 step 3). |
| D6 | Line-neutral structure edits | Accepted (030 step 2). |

Reflection (same handle): revision 2 was MISALIGNED on four verification gaps, all folded:
the item count wording above, a PATCH `baseUrl` retention acceptance case (020), CI closure
covering the required checks (060), and the full-suite exception above. Revision 3 was
MISALIGNED on one gap: a required check that never appears is missing evidence; 060 now
requires the full expected set to appear and pass.
