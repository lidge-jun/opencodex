# L1 — preview read fence and dependency audit

Two independent safety units that deliberately do not stack on any feature branch.
Each ends as its own pull request against `dev` with exact-head CI evidence.

| Unit | Subject | Artifact |
|---|---|---|
| A | Issue #4850 — caller-owned `thread_spawn` preview still reads physical main `auth.json` | `010_issue_4850_preview_pool_eligibility_fence.md` |
| B | PR #4873 — dependency audit overrides for `hono` and the docs-site toolchain | `020_pr_4873_dependency_audit_review.md` |

## Why they are separate

Unit A changes runtime credential-boundary behaviour in `src/codex/` and
`src/server/responses/`. Unit B changes only `package.json` and lockfiles and is
authored by an outside contributor. Putting them on one branch would make the
contributor's commit un-landable on its own and would drag a credential-boundary
review into a dependency bump.

## Verification posture

No local suite, typecheck, build, or install runs in this lane. Correctness is
argued statically from the source and the call graph, and confirmed by hosted CI
at the exact head of each pull request. That constraint is why unit A's completion
criteria are written as observable read counts rather than as "the right token was
eventually sent": a behavioural assertion that hosted CI can run is the only proof
available here, and it is the stronger one anyway.

## Boundaries

This lane does not merge, does not push to `dev`, and does not rebase without an
instruction. It does not widen timeouts, add retries, skip platforms, or mask a
failure to make CI green. Windows jobs are dispatch-only, so any change with
Windows impact is reported rather than dispatched here.

Unreleased security analysis belongs in `.tmp/`, never in this directory.
Both units here concern already-public material: #4850 is a filed public issue
with the call path in its body, and #4873's advisories are published GHSA records.
