# 000 — Plan and live manifest

Unit: `devlog/_plan/260908_provider_runtime_stack`. Session `01a080e2-1dfc-7082-bff8-5043215bdd35`.
Snapshot: 2026-09-08T12:00Z (fetch), `origin/dev` = `29bb221c3`
(`Merge pull request #4021 from lidge-jun/codex/release-248-record`).
Carry worktree: `/private/tmp/ocx-prs-stack-01a080e2` (linked worktree of the main checkout;
`core.worktree` unset, toplevel verified).

## Objective

Land the open provider-runtime contributor PRs on `dev` as one ordinary manual dependent PR
stack, integrated with the repository's provider discipline (test layout, provider marks,
docs-site sections, contributor attribution), and merge the stack bottom-up into `dev`
after a single green final-head CI run. Constraints given by the maintainer:

- Never run the local product suite, typecheck, build, or install. Every one of those is
  labelled NOT RUN in the delivery record. Hosted CI on the final head is the only proof.
- Every mutating Git command runs as `git -c core.hooksPath=/dev/null` (the repository
  `postmerge` hook can otherwise install dependencies and typecheck). Push with
  `--no-verify`.
- CI runs once, on the top of the stack. Merge only if that head is green.
- Ordinary dependent PR bases, no GitHub native stack registration (DEV-STACK-OPT-IN-01).
- Cherry-pick, reimplement, squash, or rebase are all permitted. Original authors stay
  as commit authors (`cherry-pick -x`) or in a `Co-authored-by` trailer.
- Subagents: `anthropic/claude-opus-5` unlimited; Aside browser delegation unlimited.
- Out of scope: release/publish, `main`/`preview` promotion, unrelated subsystems.

## Work-phase map (one PABCD cycle each)

| WP | Scope | Doc |
|----|-------|-----|
| wp1 | Docs-only roadmap: this manifest, layer plan (010), conflict map (011), mark sourcing (012), secondary dispositions (013) | 000-013 |
| wp2 | Carry L1-L3 (CodeBuddy #3340, Qoder Global #3349, Qoder CN #3350) onto `dev` with layout registration | 020 |
| wp3 | L4 marks + display names + docs-site sections + attribution; accepted secondary layers | 030 |
| wp4 | Publish, final-head CI, bottom-up admin merge, ancestry proof, closeouts, delivery record | 040, 060 |

## Manifest (exact head at snapshot)

| PR | Author | Head | Base | Mergeable vs dev | +/- | Files | Commits | Draft |
|----|--------|------|------|------------------|-----|-------|---------|-------|
| #3340 | Flowershangfromthebranches | `4b705e92d` | dev | clean (merge-tree) | 2108/6 | 17 | 4 | yes |
| #3349 | Flowershangfromthebranches | `4ac98bd4d` | dev | CONFLICTING (`tests/providers/provider-connection-test.test.ts`, import-path only) | 2683/14 | 30 | 4 (3 shared with #3340) | yes |
| #3350 | Flowershangfromthebranches | `a4e805084` | dev | conflicts inherited from #3349 | 2834/16 | 30 | 5 (4 shared) | yes |
| #3010 | Liang-Psych | `2e3582328` | dev | CONFLICTING; OAuth/private-protocol design the maintainer review rejected | 1474/2 | 11 | 18 | yes |

The three Flowershangfromthebranches PRs are already a contributor-declared chain
(#3340 → #3349 → #3350); #3349 and #3350 GitHub diffs include the lower layers because
each targets `dev`. The carry keeps that chain shape but rebases each layer onto its
parent so every PR diff is layer-only (DEV-STACK-03).

## Maintainer review state carried into this unit

The prior maintainer reviews (grok-bot, 2026-09-03) on all three PRs left these open items,
now dispositioned here:

| Item | Disposition |
|------|-------------|
| AUP / terms acceptance for headless CLI proxy routing (CodeBuddy, Qoder) | Maintainer decided in this session by authorizing the landing. Recorded in 040. |
| Provider marks missing in `gui/src/provider-icons.ts` | wp3, per the Meta precedent `81a1fc1cc` (#3338): first-party SVG with source notes, or documented initials tile when terms forbid. See 012. |
| docs-site guide lacks a Qoder Global/CN section | wp3. CodeBuddy section already exists at `guides/providers.md:620`. |
| Shared `coding-agent/protocol.ts` error classification broadened in the Qoder commit | Kept in L2 where the contributor put it; audit (wp2 A-phase) checks CodeBuddy fixture coverage. |
| `qoder` promoted from free-directory reference id to runtime seed with `preserveCustomDestination` | Kept; parity test in the carried commits asserts the flag. |
| #3010 relationship | Superseded by #3350 once landed; close with credit to Liang-Psych. |
| Tests at `tests/` root | Blocker on current `dev`: layout guard. Fixed per layer in wp2. |
| Draft readiness checklist (contributor-side) | Not applicable; maintainer carries the PRs under admin authority. Originals close as superseded. |
