# 009_0 — Merge-readiness judgment: codex/bucket2-fixes-260723 → dev/preview/main

Date: 2026-07-23. Question: may this branch be merged toward main/preview?
Answer shape: content verdict + process verdict + required conditions. No PR
opened, no merge executed (user instruction).

## Evidence

### Branch topology (verified 2026-07-23, after push)

- `codex/bucket2-fixes-260723` = 11 commits on top of `origin/dev` (54e0bbf8):
  2 devlog + 8 code/docs (f464f966, ea39977d, a4bd1d85, c771aaa5, f4f90e94,
  95b8717c, 44082437, 70d1251e, + final devlog record). Pushed to origin.
- `origin/dev` is 26 commits ahead of `origin/main` (9e68ed67) and 28 ahead of
  `origin/preview` (6d6bef8b = v2.7.33 tag commit). preview is an ancestor of dev.
- Commit author name: bitkyc08-arch, which GitHub maps to the repository-owner
  account @lidge-jun.

### Local gate state (all fresh runs on the final HEAD)

- `bun run test`: 3542 pass / 0 fail (290 files), re-run after every WP.
- `bun run typecheck`: exit 0. `bun run lint:gui`: clean. `bun run build:gui`: ok.
- `bun run privacy:scan`: passed. docs-site build: 121 pages.
- Regression coverage added per fix: 6 (#289) + 6 (#292) + 7 (#287) + 9 (#295)
  + 11 (#300) named cases.

### Policy surface (MAINTAINERS.md / AGENTS.md / workflows)

- Normal PRs target `dev`; a PR requires ≥1 maintainer approval + required CI.
  **Authors do not approve their own pull requests** — commits here are authored
  by the owner, so approval must come from the other maintainer (@Ingwannu).
- `ci.yml` triggers: PR → {main, dev} and push → {main, preview, dev}.
  `service-lifecycle.yml` triggers: PR → {main, dev}. Therefore **no CI has run
  on this branch yet** — CI starts when a PR to dev opens, and again on the dev
  push after merge.
- Security boundary: WP3 (#292) adds DNS-resolved destination-policy enforcement
  on model discovery — a direct change to the SSRF boundary (hardening
  direction). Per MAINTAINERS.md this requires **explicit security review**;
  it is merge condition #1, not an optional focus area. The other four fixes do
  not touch auth/credentials/OAuth/workflows/release automation/dependencies.
- Branch policy: `main` moves only by maintainer promotion from `dev`;
  `preview` is the prerelease train. `scripts/release.ts` enforces: preview
  branch → version must contain `-preview.`; main → no prerelease suffix.
- Release train gates (memory skill opencodex-release-train): push dev → wait
  for BOTH `ci.yml` and `service-lifecycle.yml` green on the exact release SHA
  → dev→preview, publish preview → preview→main, publish stable → verify
  `npm view @bitkyc08/opencodex dist-tags --json`.

## Verdict

**Content: LOCAL GATES GREEN — ready to open the PR.** All five fixes are
complete, locally gate-green, regression-covered, and documented across
locales. This supports "ready to open the PR", not an unqualified merge GO.

**Merge state: NOT READY until three external conditions complete** (audit
round 1, reviewer Peirce, all accepted):

1. **Explicit security review (mandatory, not optional).** WP3 adds DNS-resolved
   destination-policy enforcement on model discovery (src/codex/catalog.ts),
   directly changing the SSRF boundary in a hardening direction. MAINTAINERS.md
   requires explicit security review for security-boundary changes; practically
   this must come from @Ingwannu (the author — GitHub account @lidge-jun —
   cannot self-approve).
2. **PR CI green — `ci.yml` only.** Workflow triggers verified: ci.yml runs on
   PRs to dev/main and pushes to main/preview/dev; `gh run list --branch
   codex/bucket2-fixes-260723` is empty (no CI on feature-branch pushes).
   **`service-lifecycle.yml` will NOT run on this PR**: its path filters
   (src/service.ts, src/cli*.ts, src/lib/bun-runtime.ts, package.json, bun.lock,
   the workflow itself) match nothing in this diff. Do not wait for it here;
   the both-workflows gate applies at the release-train SHA when paths match.
3. **GUI regression-test coverage decision.** Root CI runs only
   `bun test --isolate tests` (ci.yml:72); `gui/tests/claude-code-autoconnect.test.tsx`
   (WP4's 5 SSR cases) is NOT executed by CI — the auto-connect regression pin is
   currently local-only. Options: (a) wire it into CI — a workflow change, which
   is itself a security-boundary edit requiring its own review, so NOT done
   silently here; (b) relocate the cases into a CI-executed suite; (c) accept and
   document the gap. Default recommendation: (b) or (a) as a follow-up PR; the
   gap does not block merging this branch if the reviewer accepts it.

**Promotion remains a maintainer decision.** After dev merge, dev→preview
(version `2.7.x-preview.*`) then preview→main (`2.7.x`) follows the release
train with both CI workflows green on the exact release SHA (when their path
filters match), then npm dist-tag verification. dev already carries 26
unreleased commits, so the next train ships more than these five fixes.

**NOT allowed:** direct merge of this branch into `preview` or `main` — that
bypasses the dev-integration policy and skips required CI.

## Recommended next action

Open the PR to `dev` (user decision — withheld per instruction), watch ci.yml
on the PR, obtain @Ingwannu's approval explicitly covering the SSRF-boundary
change, decide the GUI-test coverage question, then let the maintainer run the
preview/main train when ready. `git merge-tree` confirms the branch merges
cleanly into origin/dev today (exit 0). Note: `dev` branch protection is
policy-only (no GitHub branch protection rules), so approval/CI discipline is
social, not enforced.

## Watch items

- Local `dev` branch in the main checkout is +12/-0 vs origin/dev (unpushed
  work including the a89504fc server fix and earlier devlog units) unrelated to
  this branch; keep it out of this merge decision, but account for it before
  any dev push.
- #290 remains open (needs-info); it is not a merge blocker.
