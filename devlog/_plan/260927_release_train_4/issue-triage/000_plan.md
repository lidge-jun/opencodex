# Release train 4 — issue triage roadmap

At the 2026-09-27 inventory, `origin/dev` was `24b2f39b77a29711c5064987de169ecf4a97c58b`. This lane owns 12 open issues and the 21 named large PRs. The source audit finds no issue whose full acceptance is already satisfied on `dev`. Every large PR remains open; the only current-release carry candidate is the isolated Bun `%7E` standalone URL fix from #6079. The main Windows compatibility feature remains under review.

## Loop specification

- Archetype: satisfy-spec, with a docs-only first PABCD cycle and one cycle per dependency-ordered work phase.
- Trigger: release train 4 `issue-triage` delegation; user authorizes this lane's branch, PR, exact-head merge, and item-specific GitHub comments/closures.
- Goal: record a sourced disposition for each owned issue and listed PR, give contributors a concrete next step, and land only bounded fixes that satisfy current-`dev` gates.
- Non-goals: the explicitly assigned bug-hardening, provider-compat, account-pool, gui-ux and clients-proxy items; `main`/`preview`, tags, releases, deployments, contributor-fork pushes, other lanes' branches, and a wholesale carry of a large draft.
- Verification: `gh issue list --limit 300 --json number` and `gh pr list --limit 300 --json number,headRefOid` establish the full current inventory, checked by ID-set comparison (the defaults return only 30); source and PR head links establish each decision; `bun test tests/lib/standalone.test.ts`, `bun run test:changed`, `bun run typecheck`, `bun run privacy:scan`, `bun run structure:check`, `git diff --cached --check` before commit, `git diff --check origin/dev...HEAD` after commit, and exact-head required PR CI validate the bounded carry and record. A Windows packaged smoke would be needed to claim packaged Windows behavior; the URL regression test only proves helper semantics.
- Stop condition: all 33 owned items have a documented decision, warranted comments/closures are confirmed by readback, the bounded carry and final devlog record are merged only after exact-head gates, and the dev merge CI is checked. If no candidate clears gates, keep it open and record the reason.
- Memory artifact: this numbered unit under `devlog/_plan/260927_release_train_4/issue-triage/`, plus GitHub comment/PR URLs in `040_outcome.md`. Security working notes, if any, stay in `.tmp/`.
- Outcomes: DONE means the criteria above have fresh proof; NOOP means an item has no new action after the source audit; NEEDS_HUMAN means an unresolved product or security policy decision; UNSAFE means a candidate would violate a boundary; BLOCKED means a persistent external gate prevents required work. A pending CI run is pending evidence, not success.
- Escalation: request a maintainer decision only for product policy or security acceptance that this lane cannot infer. No token or wall-clock limit was specified. Use the existing repository credentials only; write source only in this lane's worktree and GitHub only for owned items.

## Source and method

The remote inventories at `24b2f39b` contain 41 open issues. The following 29 belong to other lanes and are excluded from comments and closure: #6088 #4956 #4761; #4213 #4143 #3506 #3765 #5270 #2511; #6013 #5649 #5616 #5561 #4878 #4961 #4869 #3375 #3376; #4644 #3379 #4189; #5660 #5679 #5982 #5853 #4854 #3494 #1416 #2811. This enumeration is checked against the delegation: #3494 appears in the coordinator's **unassigned examples**, while the same delegation lists it under clients-proxy. The explicit exclusion wins, so this lane records #3494 as excluded and does not touch it. The remaining owned issue count is 12. Recheck new issues before publication and route any newly assigned item by ownership.

Each PR is reviewed against the live head, GitHub mergeability, required-check state, current source ownership and the union with `dev`; an old PR description is a claim, not current proof. For carried code, use a focused new PR with a `Co-authored-by` trailer and link back to the source; retain the source PR if substantial feature work remains. The carrying PR never touches a contributor fork. Security-sensitive PR observations here are release-level blockers only; undisclosed findings are not written to this public unit.

## Work phases and dependency order

| Phase | Owner document | Input | Output and gate |
|---|---|---|---|
| wp0: decision architecture | `000_plan.md`, `010_issue_actions.md`, `020_pr_actions.md`, `030_standalone_carry.md`, `040_outcome.md` | live issue/PR list and source at `24b2f39b` | docs-only roadmap with every item and exact action; architect reflection, independent audit, text consistency check |
| wp1: issue dispositions | `010_issue_actions.md` | locked roadmap | concise evidence comments where status changed; close only fully resolved items; readback receipts |
| wp2: PR feedback | `020_pr_actions.md` | locked roadmap | item-specific English review comments and readback; hold feature PRs open |
| wp3: bounded integration and landing | `030_standalone_carry.md`, `040_outcome.md` | issue and PR decisions, fresh `origin/dev` | URL fix, focused PR and full decision record; exact-head CI, merge, dev CI, final receipts |

Work phases are dependency ordered by decision data: inventory and contract first, external dispositions next, then integration and publication. The issue and PR phases can each be independently checked by GitHub readback. If the small carry fails its gate, omit the code merge and record that as a held candidate; do not weaken the gate.

## Architect consultation

Architect handle `01a0e33a-411b-7d42-9f74-00734614db07`, proposal received 2026-09-27. Decisions: A1 (numbered docs-only roadmap) accepted, with the user-mandated `260927_release_train_4/issue-triage/` path replacing the proposed sibling unit; A2 (stable issue and PR IDs, source evidence and careful closure) accepted; A3 (hold large boundary changes until current-head review) accepted, amended to carry only #6079's independent URL bug; A4 (external comment receipts, exact-head CI and final docs PR) accepted. The preliminary proposal counted #3494 as owned; the explicit clients-proxy exclusion corrects that count here. Concrete plan revision: this file plus the four numbered phase documents. The first same-architect reflection found three material ambiguities: a combined versus separate publication path, a missing `src/lib/` source-to-doc mapping, and “cherry-pick” versus “reimplement” wording. The plan now uses separate carry and docs PRs, adds the service doc to the manifest/INDEX mapping, and consistently says reimplement. Recheck the revised plan before independent audit.

## Verifier preflight on the docs-only tree

After `bun install --frozen-lockfile` (exit 0, 104 packages), `bun test tests/lib/standalone.test.ts` passed 3/3 and directly read the future `tests/lib/standalone.test.ts` target; `bun run typecheck` exited 0 and TypeScript's project includes `src/lib/standalone.ts`; `bun run structure:check` exited 0 and reads the `structure/` document map; `bun run privacy:scan` exited 0 and scans tracked `devlog/` text; `git diff --cached --check` exited 0 on the five staged docs. `bun run test:changed` exited 0 but selected 0 tests for these five docs-only files. It is a command-availability preflight, **not** post-change regression evidence; rerun it after the code edit. An initial focused test attempt failed because this fresh worktree lacked `zod/v4`; the frozen install resolved that environment precondition before the successful run. The actual code change still needs red/green and all planned checks.

The same architect re-read the revised plan and returned **ALIGNED**: separate carry/docs publication, `src/lib/` source-map repair, reimplementation wording, 12 owned issues plus 21 PRs, and the verified `luvs01` coauthor trailer are consistent. The reflection applies to the current five-file roadmap, before the independent A audit.

## Independent audit round 1

The first independent reviewer pass saw no staged diff and returned FAIL without content review. After staging all five files, the same reviewer verified the 41/29/12 issue inventory, 21 PR head prefixes, author attribution and source links, then found two plan blockers: default 30-item `gh list` truncation and an unstaged-only whitespace check. Both are folded into this revision: inventory commands use `--limit 300` with ID-set reconciliation, and the whitespace gate checks staged content before commit and the base-to-head diff after commit. These are verification corrections, not a design change. The same reviewer re-audits this revision.

The same independent auditor rechecked the staged corrections and returned **VERDICT: PASS** with no blockers. The full-list commands returned 41 open issues and 61 open PRs at recheck; `git diff --cached --check` passed. The post-commit base-to-head whitespace check remains a C-phase task because the roadmap has not yet been committed.

## wp0 check conclusion and next direction

The docs-only roadmap is committed on `codex/t4-issue-triage-audit`. Its independent plan audit passed after the two verifier corrections. Fresh Check evidence: the live inventory reconciliation returned 41 open issues, 29 explicit exclusions, 12 owned issue rows and all 21 named open PR rows (61 open PRs total at that read); `bun run privacy:scan`, `bun run structure:check`, and `git diff --check origin/dev...HEAD` each exited 0. A fresh reader can find each item from the numbered issue/PR tables without the original chat. No GitHub issue or PR was changed in wp0, and the standalone fix remains unimplemented. The next phase is wp1: recheck each owned issue, post only the five planned status comments, and keep all 12 issues open unless new full-resolution evidence appears.
