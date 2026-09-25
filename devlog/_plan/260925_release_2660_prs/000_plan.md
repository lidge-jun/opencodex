# 260925 release 2.66.0 — plan

## Reader summary

`dev` at `76db92a4cd` carries 34 commits since v2.65.0 and one regression: #5806 and #5820
together fail `tests/responses/protocol-direct-encoders-chat.test.ts`, which also turns every PR
based on current `dev` red. The owner asked (2026-09-25) to fix that, land eleven reviewed PRs,
and release 2.66.0. This unit fixes the regression first, lands the PRs in four groups, then
binds a candidate, pre-moves `dev` to 2.67.0, promotes and publishes.

## Loop spec

- Archetype: satisfy-spec, multi-cycle HOTL; one PABCD cycle per work-phase; wp1 is this
  docs-only roadmap.
- Goal: the regression fixed on `dev`; #5006, #5754, #5835, #5837, #5826, #5838, #5839, #5757,
  #5778, #5776, #5780 merged at green exact heads or dropped with a recorded reason; v2.66.0 and
  v2.66.0-preview published and verified.
- Non-goals: deferred PRs (#5790, #5147, #5831, #5758, #5836, #5756, other drafts); raising any
  file-size cap; direct pushes to `dev`/`main`/`preview`; security write-ups in tracked
  directories; rewriting protected history.
- Verifier: per PR, the exact-head check list (`gh pr checks`, run jobs read at the head SHA),
  focused local tests on the merge result, `bun run typecheck`; for the release, the lane=all run
  on the candidate, push-event CI and Service lifecycle at the promoted SHAs, `release.yml`
  outcome rows, npm dist-tags, `gh release view`, `latest.json`.
- Stop condition: 2.66.0 published and verified, or a terminal outcome below.
- Terminal outcomes: DONE; a PR that cannot be made green after root-cause work, or fails security
  review, is dropped with reason and the release proceeds; UNSAFE if merged code has an unfixable
  high-severity issue; BLOCKED only for a release gate that cannot pass; NEEDS_HUMAN for an owner
  product decision.
- Resource bounds: no token or wall-clock budget set by the owner. Tool scope: gh (PR creation,
  pushes to same-repo branches and fork branches with `maintainerCanModify`, fork workflow-run
  approval, close/reopen for fresh merge refs, admin squash merges with `--match-head-commit`,
  dispatch of `ci.yml`, `dev-version-bump.yml`, `release.yml`), git in scratch worktrees under
  `/tmp`, local bun tests. Kimi subagents for architect, audit, security review and discovery.
- Memory artifact: this unit, the goalplan under
  `.codexclaw/goalplans/land-the-owner-selected-pre-release-pr-set-into/`, `070_done.md` at the end.

## Phase map (dependency order)

| wp | Doc | Change | Depends on |
|---|---|---|---|
| wp1 | 000 (this) | roadmap | — |
| wp2 | [010](010_wp2_direct_chat_heartbeat.md) | direct Chat heartbeat parity fix | wp1 |
| wp3 | [020](020_wp3_5006_5754.md) | #5006, #5754 | wp2 |
| wp4 | [030](030_wp4_5835_5837_5826.md) | #5835, #5837, #5826 | wp2 |
| wp5 | [040](040_wp5_security_5838_5839_5757.md) | security review + #5838, #5839, #5757 | wp2 |
| wp6 | [050](050_wp6_5778_5776_5780.md) | #5778, #5776, #5780 | wp2 |
| wp7 | [060](060_wp7_release.md) | candidate, pre-move, promotion, publish | wp3-wp6 |

wp2 is the foundation: until it lands, every PR's CI carries the `dev` failure. wp3-wp6 are
independent of each other (disjoint files, clean pairwise merge trees) and run in order.

## Cross-cutting rules

1. Exact-head evidence: a PR merges only when every expected check at its current head ran and
   succeeded. Skipped counts only when the workflow's path conditions skip it for that diff.
   Fork runs are approved by main only after main has read the diff.
2. Fresh merge refs: a PR whose green run predates wp2 gets a new `pull_request` event (a push,
   or close/reopen) so CI tests it against the fixed `dev`. Old runs are not re-run: a re-run
   reuses the stale merge ref. #5006 is the exception: it has a full green run at its head with
   no `dev` overlap beyond additive layout entries, so its union risk is covered by local tests on
   the merge result plus the wp7 candidate run.
3. File-size ratchet: no cap increases. Overflow moves into a registered sibling file.
4. After each merge the next PR is re-checked against the new `dev` tip (`git merge-tree`) and
   union risks (layout maps, counts, locale catalogs) are re-run locally.
5. A merge that turns `dev` red freezes further merges until a repair PR lands.
6. Maintainer integration (MAINTAINERS.md 2026-09-06) is recorded on each PR with the exact-head
   evidence. Security reviews stay in `.tmp/`; the PR carries only the verdict.
7. Carrying someone else's work onto a maintainer branch adds a `Co-authored-by` trailer.

## Starting state (2026-09-25 ~11:00Z)

| Ref | Commit | Note |
|---|---|---|
| `dev` | `76db92a4cd` | 2.66.0; last full Cross-platform CI success at `ed181a0d0c` |
| `main` | `87a78e5f26` | v2.65.0 |
| `preview` | `d4c26e2b09` | v2.65.0-preview.20260925 |

Local checks on `76db92a4cd`: typecheck, `structure:check`, `skill:surface:check`, file-size
ratchet, repo hygiene, layout and Lab boundary tests pass; `protocol-direct-encoders-chat` fails
(47 pass, 1 fail).


## Architect consultation

Architect: Kimi `kimi/kimi-for-coding-highspeed`, handle Nash (`01a0d83c-3a51-7780-befd-9e5fde34d22b`),
proposal D1-D7 received 2026-09-25. Main dispositions:

- D1 order (regression fix first, then wp3-wp6, release last): accepted.
- D2 fresh CI: accepted with amendment. Same-repo branches (#5835, #5837, #5838, #5839): merge
  `origin/dev` into the branch and push without force, but only after re-reading the head: the
  author (Ingwannu, a maintainer) pushed new heads to #5837 (`de26479105`) and #5838
  (`09c6993a15`) during wp1, so each wp re-reads heads at P and leaves an actively moving branch to
  its author unless the author stops. Architect's reading that a maintainer push does not reset the
  readiness gate (`authorHasPushPermission`, `.github/scripts/pr-quality.cjs`) is recorded; if a PR
  is drafted anyway, `gh pr ready` precedes the merge (2.65 precedent). Fork branches with
  `maintainerCanModify`: a merge-from-`dev` push by main is the certain way to a fresh merge ref;
  close/reopen is the fallback when a push is undesirable.
- D3 heartbeat fix: accepted in substance; delivery amended to the owner's existing branch (010
  amendment), which already includes the relayed-counter change D3 asks for.
- D4 #5778 ratchet: accepted (050).
- D5 #5839 drop criteria: accepted; the setsid descendant escape and the Windows regression are
  the drop criteria, async scan and env allowlist are recommended (040).
- D6 release sequencing and runner policy: accepted (060).
- D7 union checks: accepted except the claim that `dev` itself fails the ratchet on
  `src/adapters/openai-chat.ts`: rejected. `dev` has 822 lines against a cap of 822 and
  `./tests/ci-workflows/file-size-ratchet.test.ts` passes on `76db92a4cd`; the 823 seen in PR runs
  comes from merge refs built before #5822.

## Audit round 1 (Kimi auditor Meitner, verdict FAIL) — dispositions

1. BLOCKER "pre-move must use 2.67.0": rebutted. `.github/workflows/dev-version-bump.yml:27-29`
   defines `intended-version` as "Version about to be released (pre-move)", and
   `scripts/bump-dev-version.ts` derives the next line from it; 2.64 dispatched 2.64.0 and `dev`
   moved to 2.65.0. 060's `intended-version=2.66.0` moves `dev` to 2.67.0 as intended.
2. MAJOR "#5006 lacks a maintainer approval at the head": rebutted. Ingwannu APPROVED at
   `f5516ca15f` (the current head) on 2026-09-25T04:00:42Z.
3. MAJOR "security verdicts are not a PR sign-off": folded. 040 now makes a maintainer security
   sign-off on the current head (an approving review by the owner citing the independent review
   verdict, no exploit detail) a precondition of each merge.
4. MAJOR "#5778/#5776 still CHANGES_REQUESTED": folded. 050 makes an owner approving review on the
   current head, listing the verified dispositions, a precondition; the same applies to #5780 and
   to #5754 (020), whose approvals name older commits.
5. MAJOR "`PV` must be one fixed string": folded. 060 computes `PV` once at the start of wp7,
   records it in the D summary, and every later command reuses it.
6. MINOR (commit reachability): both commits are on the branch (`dd80e03ca3` parent of
   `ac3ea085e6`); B checks `git log origin/dev..HEAD` shows exactly those two after cherry-pick.
7. MINOR (runner policy missing in 060): rebutted; 060 section 1 carries the "Runners:" paragraph.
8. MINOR: no action.

## Execution finding (wp3/wp4, 2026-09-25 ~12:10Z) — amends cross-cutting rule 2

Close/reopen does not rebuild the merge ref. The reopened runs checked out the old merge commits
(#5835 run 36131541136: `Merge 61dfd0225a into 76db92a4cd`; #5757: `... into 88b9da8c51`), so
they failed exactly as before. A fresh merge ref needs a new head: main uses GitHub's update-branch
(`gh pr update-branch <n>`, a server-side merge of `dev` into the head branch; forks only with
`maintainerCanModify`), then approves fork runs after reading the diff. The PR description or a
comment names the merge commit so the author knows the branch moved.

#5754 (wp3) failed its own head's contract test
`tests/codex-integration/bearer-admission-routed-provider.test.ts` "search-runTurn": the PR
deliberately plans the OpenAI search helper for runTurn adapters, and that test still asserted the
old no-helper contract; its CI had never run tests (fork approval pending). It moves to a new
work-phase wp8 (test contract update on the fork branch, then land); wp7 waits for wp8.
