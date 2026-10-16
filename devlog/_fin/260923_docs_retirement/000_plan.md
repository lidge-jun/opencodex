# 000 — Retire `docs/` and move PR evidence images off `dev`

Status: open (wp1, single PABCD cycle). Branch `codex/remove-docs-pr-assets`, base `origin/dev` `746c7386e6`.

## Problem

The root `docs/` folder describes itself as historical notes, yet it grew to 4.9 MB, and 4.5 MB of
that is PR screenshot evidence. The same kind of image also piles up in `.github/pr-assets/`,
`assets/pr-screenshots/` and `docs-site/public/pr-screenshots/`. The GUI screenshot rule in
`enforce-target` sends authors to commit images on their PR branch; squash merges then carry every
image into `dev`. Moving the folder does not fix this, as `docs-site/public/pr-screenshots/`
already shows. Worse, anything under `docs-site/public/` is published to GitHub Pages.

## Inventory at `746c7386e6`

| Path | Live references outside `devlog/` | Disposition |
| --- | --- | --- |
| `docs/README.md` | `CONTRIBUTING.md:11`, `structure/ops/docs-and-release.md:232`, `scripts/structure-ssot.ts:223` → `structure/INDEX.md:5` | delete; rewrite the three references |
| `docs/design-system/*` (Korean GUI token/component contract) | none | move to `gui/design-system/` (current contract, lives next to `gui/src/styles.css`) |
| `docs/adr/0004`, `docs/adr/0005` (GUI toggle contrast, design tokens) | linked by design-system README | move to `gui/design-system/decisions/` |
| `docs/adr/0001-0003, 0006, 0007` | none | delete; git history keeps them at `746c7386e6` |
| `docs/superpowers/**` (16 dated plans/specs) | none | delete |
| `docs/codex-app-model-catalog.md`, `docs/codex-path-investigation.md` | devlog links only | delete; devlog history links go stale by design |
| `docs/qoder-cli-provider.md` | devlog only | delete; covered by `docs-site/.../guides/providers.md` "Official Qoder CLI"; #3010 credit already sits in the carry trailer (`devlog/_fin/260908_provider_runtime_stack/050_delivery_record.md:11`) |
| `docs/shadow-call-intercept.md` | devlog only | delete; covered by `docs-site/.../reference/configuration/server.md` "Shadow calls" |
| `docs/github-copilot-app.md` | devlog only | port to `docs-site/.../guides/integrations.md` (not covered anywhere in docs-site) |
| `docs/pr-assets/**`, `docs/screenshots/**` | none | delete |
| `.github/pr-assets/**` (31), `assets/pr-screenshots/**` (6), `docs-site/public/pr-screenshots/**` (20), `assets/pr2950-capacity-expiry.png`, `assets/pr715-selection-order.png`, `assets/request-pacing-dashboard.jpg`, `assets/zh-tw-providers.png`, `assets/pr-gate-screenshot-required.png` | none (`rg -F -f` over all 62 basenames, excluding `devlog/` and `docs/`) | delete |

Other `docs/` strings in the tree are unrelated: synthetic paths in `.github/scripts/pr-hygiene.test.cjs`,
`.github/scripts/issue-quality.test.cjs:148` and `tests/ci-workflows/privacy-scan-meta-key.test.ts:50`,
upstream vendor paths in `src/adapters/*` comments, and `gui/public/provider-icons/README.md`.

## Replacement workflow

An orphan branch `pr-assets` on `lidge-jun/opencodex` holds PR evidence images. It shares no history
with `dev`, so nothing on it can reach a squash merge. Authors link images by commit SHA
(`https://raw.githubusercontent.com/lidge-jun/opencodex/<sha>/<path>`), which keeps the link stable.
A branch ruleset blocks deletion and force-push so pinned SHAs stay reachable. Contributors without
push access use GitHub's drag-and-drop attachment, which the `enforce-target` message already suggests
(`.github/scripts/pr-quality-messages.cjs:234`).

CI impact: every workflow `push:` trigger is pinned to `main`, `preview` or `dev` (`ci.yml`,
`issue-quality-tests.yml`, `deploy-docs.yml`, `react-doctor.yml`, `cleanup-orphaned-workflows.yml`,
`service-lifecycle.yml`); `pr-hygiene.yml` is `pull_request_target` only. A push to `pr-assets`
triggers nothing, so no workflow edit is needed.

## Constraints

- `.github/PULL_REQUEST_TEMPLATE.md` stays byte-identical: `PR_TEMPLATE_BOILERPLATE_LINES` in
  `.github/scripts/pr-quality.cjs` matches its lines literally.
- `.gitignore` entries are root-anchored. A bare `docs/` would ignore `docs-site/src/content/docs/`.
- No file-size cap changes (`tests/fixtures/file-size-baseline.json`); none of the edited files is capped.
- Security scratch rule untouched; no security content moves.

## Out of scope

Rewriting devlog links, CI gate semantics, and translated docs-site pages other than the one
"Structure SOT" contributing bullet (D9 in `010`).
