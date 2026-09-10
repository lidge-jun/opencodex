# 080 — Release automation follow-ups: bot PR creation, service-lifecycle trigger

## Provenance: was "Allow GitHub Actions to create and approve pull requests" turned off?

No. It was never on.

| date | source | `can_approve_pull_request_reviews` |
|---|---|---|
| 2026-07-27 | chat tool log (`gh api …/actions/permissions/workflow`) | false |
| 2026-08-01 | chat tool log, Windows CI server session | false |
| 2026-09-02 | this train, after release 33617573070 | false |

No commit, devlog note, or chat turn in the recall index mentions disabling it. GitHub creates
repositories with this toggle OFF, so the value is the default, not a maintainer decision.
#3013 (open bumps as PRs) and #3129 (call the bump from release.yml) both assumed the bot could
open a PR with `GITHUB_TOKEN`; neither was exercised by a live release until v2.40.0, which is
why the gap surfaced only now.

## Decision

Flip the repository toggle (option a). Rejected: a PAT secret for `gh pr create` (option b) —
a long-lived write credential in Actions is a wider blast radius than a repo-scoped toggle.

What the toggle grants: any workflow running with `GITHUB_TOKEN` may create pull requests and
submit approving reviews. What still holds: `Protect dev` requires a reviewed pull request and
blocks direct pushes; `MAINTAINERS.md` forbids self-approval; `dev-version-bump.yml` runs only as
a `workflow_call` from `release.yml` (no `workflow_dispatch`), with `contents: write` scoped to
the unprotected `codex/dev-version-*` branch. A bot-created PR cannot merge itself; it waits for
the same admin merge every bump has had by hand (#3045, #3076, #3127, #3265).

Route: REST `PUT /repos/{owner}/{repo}/actions/permissions/workflow` with
`can_approve_pull_request_reviews=true` (the user's `gh` session is an admin). Aside against the
Settings page only if the API refuses.

Verification: re-read the setting; the exact failing step (`gh pr create` under `GITHUB_TOKEN`)
is proven live by the next release's bump job — a synthetic probe would need its own workflow on
`dev` and is not worth landing for one step.

Applied 2026-09-02 via `gh api -X PUT repos/lidge-jun/opencodex/actions/permissions/workflow
-f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`; the API accepted
it, so Aside was not needed. Read-back: `{"default_workflow_permissions":"read",
"can_approve_pull_request_reviews":true}`. Default token permission stays `read`.

## service-lifecycle trigger

`release.yml`'s gate requires a successful `service-lifecycle.yml` run for the release SHA when
any of its watched paths changed since the previous tag. `service-lifecycle.yml`'s own
`push.paths` did not include `.github/workflows/release.yml`, so #3263/#3264 (workflow-only
cherry-picks onto main/preview) produced no run and both v2.40.0 dispatches needed a manual
`workflow_dispatch`. Add `.github/workflows/release.yml` to both trigger path lists and to the
regex the gate applies, so the two stay in sync as the file comment already demands.
