# 050 — Delivery: rebase, full verification, PR, exact-head CI

The four implementation commits are done and each passed its own Check (receipts and implementation reviews in 000_plan.md). This cycle lands them as one PR to `dev`: rebase onto the current `dev`, prove the whole branch at its final head, publish, and watch the PR's exact-head CI until branch-caused failures are fixed.

## Loop spec

- **Loop archetype:** satisfy-spec, final cycle of the unit.
- **Trigger:** owner request "PR 날려놔" (push and PR creation authorised; merge not).
- **Goal:** PR from `codex/update-indicator` to `dev` with the repository template filled, GUI screenshots linked from `pr-assets`, and exact-head CI inspected.
- **Non-goals:** merge, release, deploy, closing issues, any change to CI workflows.
- **Verifier:** at the rebased head — `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, `bun run skill:surface:check`, `cd gui && bun run lint && bun run lint:i18n && bun run build`, `cd docs-site && bun install --frozen-lockfile && bun run build`, `cargo test` and `cargo clippy -D warnings` for `desktop/src-tauri`, `swift run --package-path app NativeTrayTests` and `bun run test:macos` (the Swift dot overlay lives in `app/Sources/NativeTray`), `bun scripts/generate-windows-tray-update-icons.ts --check`, `cd desktop && bun run icons:check`, and the full `bun run test` from a detached `/tmp` checkout (this worktree lives under `~/.codex`, where the test-home guard fails unrelated suites; failures there are compared against the same run at the `dev` base). Then hosted CI on the PR head, read per DEV-CI-EVIDENCE-01 (expected jobs present, head SHA, event, run id; skipped/cancelled/pending are not passes). PowerShell tray behaviour runs only in the `platform-windows` leg, which `ci.yml` gates on `workflow_dispatch` (lane `all`); normal PR CI does not run it, so step 6 dispatches the existing workflow on the branch at the final head (no workflow change) and compares its Windows failures with the most recent `dev` dispatch, reading the tray/CLI tests by name.
- **Stop condition:** PR open, template complete, every required check at the exact head concluded; each failure either fixed on the branch or shown to reproduce on `dev` with evidence.
- **Memory artifact:** this document, 000_plan.md, the PR description.
- **Expected terminal outcomes:** DONE; BLOCKED if push/PR creation is rejected or CI cannot run after investigation; NEEDS_HUMAN for Windows/Linux tray rendering and packaged cross-origin navigation, which no local or hosted job observes.
- **Escalation condition:** a rebase conflict that changes a design decision, a CI failure in a security or release job that is not branch-caused, or any need to change workflows.
- **Resource bounds:** local shell, git, gh; write scope is this branch, the `pr-assets` branch (one new folder), and the PR; no token or time budget set.

Architect consultation: this cycle makes no module, interface or data-structure decision, so no architect proposal was requested; this is a disclosed N/A, not a skipped consultation for a design change.

## Steps

1. `git fetch origin dev && git rebase origin/dev` on `codex/update-indicator` (unpushed, owned by this task). Resolve conflicts in place, keeping upstream behaviour and this unit's additions; re-run the focused tests of any commit whose files conflicted before continuing. Actual overlap with `origin/dev` 608ed54cea (from `git diff --stat HEAD...origin/dev`): `gui/src/App.tsx`, all ten `gui/src/i18n/*.ts` catalogs (commit 3 keys vs #5749 onboarding keys), and both test-layout JSON files (new test registrations). Recheck after conflicts: GUI lint, i18n lint, build and `gui/tests/desktop-shell.test.ts`; `tests/test-layout.test.ts` and `tests/test-layout-tooling.test.ts`.
2. Run the verifier list above at the rebased head; record results here.
3. Final adversarial gate: a fresh gpt-6-sol reviewer over `origin/dev..HEAD` (security boundary, concurrency, upgrade paths, docs), fold findings with red-green evidence.
4. Push `codex/update-indicator` to `origin`. Commit the update-page screenshot, the macOS dot rendering sheet and the Windows icon sheet to `pr-assets` under `260924-update-indicator/` and link them by commit SHA.
5. `gh pr create --base dev` with Summary / Verification / Checklist (template headings kept), limitations and follow-ups (Windows `/api/update/run` installer launch still synchronous; Windows base tray glyph contrast; auto-install policy).
6. Inspect exact-head CI; fix branch-caused failures with new commits (no force-push after review starts unless rebasing is required), re-inspect. Dispatch `ci.yml` with lane `all` on `codex/update-indicator` at the final head to obtain the Windows legs; record run id, head SHA and the Windows tray/CLI test results; any Windows failure not present in the latest `dev` dispatch is treated as branch-caused.

## Results

- Rebase onto `origin/dev` 608ed54cea: no textual conflicts (App.tsx, ten catalogs and layout JSONs merged cleanly).
- Local verifiers at the rebased head: typecheck, structure, privacy, skill surface, GUI lint/i18n/build + 5 GUI tests, layout/ratchet/structure tests (78), Windows ICO `--check`, desktop icons (19), cargo test 147 + clippy, Swift NativeTrayTests (26 assertions) and MenuBarCoreTests, docs-site build (505 pages) — all exit 0.
- Full `bun run test` from a detached `/tmp` checkout: 26 failures, 25 of them the same environment-bound set seen on the `dev` base in wp1 (live proxy on :10100, WSL/service/launcher fixtures, parallel contention). One was branch-caused: `tests/clients/desktop-runtime-identity.test.ts` still expected the old `"tauri" => true` arm that commit 3 narrowed to `tauri://localhost` without a port. Fixed in commit 3: the source oracle now pins the narrowed arm and still forbids an `http` localhost widening (8 pass).
- Final adversarial gate: Maxwell (gpt-6-sol, agent 01a0d425-09ea-7181-b62d-cf0b1062617c) GO-WITH-FIXES with zero blockers; the Low (extra blank line at the end of 001 failing `git diff --check`) is fixed in the docs commit.
