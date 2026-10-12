# 010 — Phase 1: retire `docs/`, seed `pr-assets`, add guards

Diff-level change map. Paths are relative to the repository root.

## DELETE

- `docs/` entirely, except the files moved below (`git rm -r docs`).
- `.github/pr-assets/`, `assets/pr-screenshots/`, `docs-site/public/pr-screenshots/`.
- `assets/pr2950-capacity-expiry.png`, `assets/pr715-selection-order.png`, `assets/request-pacing-dashboard.jpg`,
  `assets/zh-tw-providers.png`, `assets/pr-gate-screenshot-required.png`.

## MOVE (git mv, then edit links)

- `docs/design-system/{README,foundations,components,contributing}.md` → `gui/design-system/`.
- `docs/adr/0004-gui-toggle-contrast-and-nav-spacing.md`, `docs/adr/0005-gui-design-token-system.md`
  → `gui/design-system/decisions/`.
- `gui/design-system/README.md`: source tree block `docs/design-system/` → `gui/design-system/`;
  ADR links `../adr/000N-…` → `./decisions/000N-…`.
- Any `../../gui/…` style relative link inside the moved files is re-resolved against the new location.

## MODIFY

- `gui/AGENTS.md`: one bullet pointing to `gui/design-system/` as the token/component contract.
- `CONTRIBUTING.md:11`: replace the `docs/` bullet with the PR screenshot hosting rule (drag-and-drop
  attachment first; maintainers with push access may use the `pr-assets` branch; never commit
  evidence images on the PR branch). AGENTS.md and docs-site use the same order.
- `AGENTS.md` "Issues and pull requests (agents)": after the screenshot sentence, add where the
  image goes (`pr-assets` branch, SHA-pinned raw URL) and that PR branches must not add evidence images.
- `docs-site/src/content/docs/contributing.md:157`: same hosting rule, one sentence.
- `docs-site/AGENTS.md:8` (A-phase blocker 1, Planck): "historical `docs/` or `devlog/` material" →
  "`devlog/` notes or older revisions in git history".
- D9 (architect addition): the "Structure SOT" bullet in `docs-site/src/content/docs/contributing.md:180`
  and its seven translations (`tr:193`, `fr:169`, `ko:131`, `ja:132`, `ru:133`, `zh-tw:138`, `zh-cn:120`)
  sends historical notes to `docs/`. Each becomes "`devlog/`" (the tracked home for investigation and
  planning notes), translated in place.
- `docs-site/src/content/docs/guides/integrations.md`: new `## GitHub Copilot App` section at the end,
  ported from `docs/github-copilot-app.md` (manual setup; not an Integrations-tab switch).
- `structure/ops/docs-and-release.md` "Historical docs": state that `docs/` is retired, where each kind
  of material now lives, and the `pr-assets` branch.
- `scripts/structure-ssot.ts:223`: INDEX header drops the `docs/` clause; then `bun run structure:index`
  regenerates `structure/INDEX.md`.
- `structure/manifest.json` `absentPaths`: add `{ "path": "docs/", "reason": … }` next to `go/`.
- `scripts/privacy-scan.ts:151`: drop the `docs/` username allowance (no file there any more).
- `.github/ISSUE_TEMPLATE/documentation.yml:31`: placeholder `docs/providers.md` →
  `docs-site/src/content/docs/guides/providers.md`.
- `tests/ci-workflows/repo-hygiene.test.ts`: `RETIRED_TRACKED_DIRS` gains `docs`, `.github/pr-assets`,
  `assets/pr-screenshots`, `docs-site/public/pr-screenshots`, with a comment naming the cause.
- `.gitignore`: root-anchored `/docs/`, `/.github/pr-assets/`, `/assets/pr-screenshots/`,
  `/docs-site/public/pr-screenshots/` (the gitignore assertion in the same test requires them).

## Architect dispositions (Dalton, gpt-6-sol high)

- D1, D3, D5 ACCEPT. D5 audit done: 268 PRs mention these image paths; none links them through a
  `dev`, `main` or `preview` ref, so deleting them from `dev` breaks no PR description.
- D2 AMEND accepted: ADR 0005 keeps its historical text (it names `docs/design-system` as of its date);
  the moved README is the current pointer.
- D4 AMEND accepted: the ported section says it is a client setup, separate from the upstream
  `github-copilot` provider, and its auth/field claims are rechecked against `src/server/chat-completions.ts`
  and `src/server/auth-cors.ts` before publishing.
- D6 AMEND accepted (INDEX is regenerated, never hand-edited).
- D7 AMEND accepted after reflection: the four directories join `RETIRED_TRACKED_DIRS`; the five loose
  images get a separate `RETIRED_TRACKED_FILES` assertion in the same test (no gitignore line, since
  the directory mechanism's `<dir>/` gitignore check does not fit single files).
- D8 AMEND accepted: ruleset is created and verified before any doc tells authors to pin SHAs; the
  drag-and-drop attachment is presented first; the PR template stays byte-identical.
- D9 ADD accepted (above).

## C-phase verifier findings

- Content verifier: ADR 0007 (CLI parity), ADR 0002 (doctor proxy-env disclosure) and the CL-10
  closure contracts had no `structure/` home; carried into `structure/ops/docs-and-release.md`,
  `structure/config.md` and `structure/adapters/compatibility-lab.md`. ADR 0006 was already covered
  (`structure/config.md` provider output defaults, `structure/transports/streaming-health.md` replay).
- Follow-up outside this unit: `docs-site/.../reference/configuration/server.md` "Remote access" table
  (English and seven translations) still says `/v1/responses` and `/v1/chat/completions` reject Bearer
  admission. `src/server/auth-cors.ts` `AUTH_MATRIX` and `reference/proxy-formats.md` accept it since
  #1686. The new Copilot guide links the correct matrix; the stale table predates this unit.

## Remote (outside the PR diff)

1. Orphan branch `pr-assets` with one `README.md` explaining layout (`<pr-number-or-slug>/<file>`),
   SHA-pinned linking, and that the branch is append-only. Pushed from a temporary clone so this
   worktree's HEAD never moves.
2. Branch ruleset "Protect pr-assets" on `refs/heads/pr-assets`: `deletion`, `non_fast_forward`,
   enforcement active. Verified with `gh api repos/lidge-jun/opencodex/rulesets`.

## Enforcement and bypass (PLAN-BYPASS-NAMED-01)

- Tier: CI test (`repo-hygiene`) plus `structure:check` `absentPaths`. Executing surface: hosted CI.
- Known bypass: images committed under any other path (for example `gui/public/`), or a maintainer
  merging with red CI. Residual risk: re-accumulation elsewhere; review catches it.
- Wording: called a guard for these paths, not a general image ban.
- Ruleset: repository admins can still edit or disable the ruleset.

## Acceptance and verifiers (PLAN-VERIFIER-REAL-01)

| Criterion | Command | Reads the target |
| --- | --- | --- |
| `docs/` untracked | `git ls-files docs \| wc -l` → 0 | yes, index |
| structure gate | `bun run structure:check` | yes: manifest `absentPaths`, INDEX, ops doc |
| privacy | `bun run privacy:scan` and `bun test tests/ci-workflows/privacy-scan*.test.ts` | yes: `scripts/privacy-scan.ts` |
| guards | `bun test tests/ci-workflows/repo-hygiene.test.ts tests/ci-workflows/structure-ssot.test.ts` | yes |
| issue template | `node --test .github/scripts/issue-quality*.test.cjs` | yes, template read by tests |
| typecheck | `bun run typecheck` | yes, `scripts/*.ts` |
| docs-site | `cd docs-site && bun run build` | yes, `integrations.md`, `contributing.md` |
| import graph | `bun run test:changed` | partial; source-read tests listed above run explicitly |
| guard activation | stage a throwaway `docs/x.md` with `git add -f`, run repo-hygiene → red, unstage | yes |
