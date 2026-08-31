# Maintainers

This document lists the people responsible for maintaining opencodex and defines the project's
review and merge policy.

## Current maintainers

| GitHub account | Project role | Responsibilities |
| --- | --- | --- |
| [@lidge-jun](https://github.com/lidge-jun) | Project owner | Project direction, releases, repository administration, and final governance decisions |
| [@Ingwannu](https://github.com/Ingwannu) | Maintainer | Issue and pull-request triage, `dev` integration, security review, and repository maintenance |

The table describes project responsibilities. Actual repository permissions remain controlled
through GitHub repository settings.

`dev` is the only integration line. The former `dev2-go` carry duty is retired;
see [The retired `dev2-go` line](#the-retired-dev2-go-line).

## Former maintainers

| GitHub account | Project role | Period |
| --- | --- | --- |
| [@Wibias](https://github.com/Wibias) | Maintainer | 2026-07-27 – 2026-08-19 |

Former maintainers keep contributor standing and are welcome to open issues and pull requests like
anyone else. Authorship credit in git history, release notes, and code comments is not rewritten
when a maintainer steps down.

## Review and merge policy

- Pull requests target `dev`. It is the only integration line, and promotion to
  `main` happens only from `dev`. The target-branch check accepts `dev` alone.
- The **`enforce-target`** CI check rejects pull requests whose head
  ancestry sits on the **`main`** tip while far behind **`dev`**, and rejects
  empty, thin, or malformed descriptions; PRs whose title or description
  mentions `gui` must include a screenshot of the UI change in the description.
  Contributor PRs (authors without repository push permission) open in draft
  and stay there until a four-box review-readiness checklist in the
  description is complete: local CI green, branch on the latest `dev` commit,
  all correct Codex and CodeRabbit findings fixed, and the ready-for-review
  confirmation. When all four boxes are ticked the gate marks the PR ready and
  notifies the maintainers listed in `MAINTAINERS.md` (excluding the author).
  Completion is bound to the exact commit the PR head pointed at: if new
  commits are pushed afterwards, the gate moves the PR back to draft, resets
  the checklist and the notification, and asks the author to test and tick the
  boxes again against the latest code.
  Before a completion is accepted, the gate verifies the checklist claims
  it can check itself: the branch must be on the latest `dev` commit or at
  most 10 commits behind it, and Codex/CodeRabbit findings must be resolved.
  The local-CI box is an author attestation only — fork contributors cannot
  start repository CI; a maintainer has to — so the gate never disproves it;
  a new push still resets every box. A disproved claim unticks the matching
  box and keeps the PR a draft.
  Authors with repository push permission skip the ancestry heuristic only. As
  with the approval requirement above, this part is enforced by convention;
  the ruleset does not check ancestry (see the note under the change log).
- A pull request requires approval from at least one maintainer and successful required CI checks
  before merge.
- Authors do not approve their own pull requests.
- Authentication, credential handling, GitHub Actions, release automation, dependency installation,
  and other security-boundary changes require explicit security review.
- A new or promoted provider preset is a credential-destination change. Before merge it needs the
  primary-source evidence listed under [Adding a provider to the
  catalog](https://opencodex.me/contributing/#evidence-required-for-a-canonical-preset): documented
  OpenAI-compatible endpoints (including authenticated `GET /v1/models` when the entry declares
  `liveModels`), terms of service and operating legal entity, resale or routing authorization for
  aggregators, a named maintenance owner, and a citable verification date. Contributor affiliation
  with the service is disclosed, not disqualifying, and it does not lower the evidence bar. When the
  evidence is incomplete, prefer an inert `src/providers/free-directory.ts` reference row over a
  canonical registry entry.
- Security-sensitive and release-related changes should be reviewed by both maintainers when
  practical.
- Direct pushes are reserved for maintainer-owned integration work, urgent repairs, or incident
  recovery. The same CI and documentation requirements still apply.
- Promotion from `dev` to `main` and npm releases is maintainer-controlled.
- **Closing out a release includes moving `dev`'s version line forward.** A published
  release leaves `dev` carrying a version at or behind it, and
  `tests/release-version-line.test.ts` then fails on `dev` and on every pull request
  opened against it — red that contributors inherit and cannot fix from their own diff.
  This was repaired by hand four times (`32529c2b2`, `e4a85d134`, `076ad3036`,
  `befcac3e1`) before it was automated.

  `.github/workflows/dev-version-bump.yml` now opens that bump as a pull request when a
  release publishes. Merging it is part of closing the release; a bot cannot, because
  `Protect dev` requires an approving review and code-owner sign-off. Two caveats worth
  knowing: the workflow runs from the DEFAULT branch, so it only fires once it has been
  promoted to `main`; and a pull request opened with `GITHUB_TOKEN` does not start
  `pull_request` workflows, so the bump pull request arrives without CI. To re-drive a
  missed run by hand: `bun scripts/bump-dev-version.ts <released-version> package.json`,
  then open the pull request normally.

## The retired `dev2-go` line

`dev2-go` was a parallel integration line that rebuilt the runtime as a Go
native port, and policy required every merge into `dev` to be rebased onto it
and ported under `go/`. That policy is withdrawn as of 2026-07-30.

The dual-track cost outran its return: the carry backlog never cleared (17
commits and 9 open `needs-go-port` issues at the time of the decision, against
594 commits of divergence), and dogfooding the Go runtime kept producing new
defects. Bun-native TypeScript on `dev` is the single runtime line again.

- The branch has been deleted from this repository. Its full history is
  published at
  [lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive),
  and its final tip stays reachable here as the `archive/dev2-go` tag.
- A merge into `dev` carries no port obligation. The nine open `needs-go-port`
  issues (#661, #663, #666, #670, #674, #678, #680, #685, #703) were closed as
  not planned, and the `needs-go-port` label no longer exists on the
  repository.
- Future native work is expected to be an incremental module landing on `dev`
  (Rust via N-API is the current candidate), not a second integration branch.
  Reopening a parallel runtime line is an owner decision.

## Maintainer changes

Adding or removing a maintainer requires:

1. agreement from the project owner,
2. review by another current maintainer when available, and
3. updates to this file and [`.github/CODEOWNERS`](./.github/CODEOWNERS).

### Change log

- 2026-08-19 — [@Wibias](https://github.com/Wibias) stepped down as a maintainer
  and is now a contributor. This follows his own decision to stop developing
  opencodex; it is not a disciplinary action, and it was made with the owner's
  agreement (requirement 1). Requirement 2 does not apply to a maintainer's own
  resignation, which needs no second maintainer to ratify it. Requirement 3 is
  met by this file and `.github/CODEOWNERS`, where the default-reviewer line
  and the four runtime paths that listed him (`/src/adapters/`,
  `/src/providers/`, `/src/codex/`, `/src/server/`) drop back to the two
  remaining maintainers. Repository permission was reduced to read access at
  the same time, so the roster and the GitHub settings agree again.

  Nothing he authored is being unwound. His commits, the pull requests he
  merged, the release-note attributions, and the code comments citing his
  reviews stay exactly as they are, and the trust-lane gate derived from his
  work in `.github/scripts/pr-sponsored-surface.cjs` keeps its attribution.
  Returning to the maintainer table later would go through the same three
  requirements that govern every addition.

- 2026-07-27 — [@Wibias](https://github.com/Wibias) added as a maintainer.
  Requirement 1 (agreement from the project owner) is met: the owner requested
  the addition. **Requirement 2 (review by another current maintainer) was
  never satisfied in the form this document describes.** The three commits that
  carried the addition (`a2693c02`, `dc3a4ade`, `02bbd47a`) landed on `dev` as
  direct owner pushes with no associated pull request, so no second maintainer
  reviewed them. Requirement 3 is met by this file and `.github/CODEOWNERS`.
  The addition took effect regardless: @Wibias held write access on the
  repository and merged pull requests from 2026-07-26 until he stepped down on
  2026-08-19. This entry records the gap rather than papering over it — a later
  maintainer change should go through a reviewed pull request.

  Scope covers issue and pull-request triage, `dev` integration, and
  provider/CI maintenance. (This entry originally also described carrying
  merged `dev` work onto `dev2-go`; that duty ended when the line was retired
  on 2026-07-30.) Security-boundary ownership in `.github/CODEOWNERS` is
  deliberately unchanged: authentication, credential handling, GitHub Actions,
  and release automation keep the two owners already listed for those paths, so
  this addition does not widen the review surface for them.

  Code-owner approval and the maintainer-approval requirement above are both
  enforced, not conventions. `dev`, `main`, and `preview` each carry an active
  repository ruleset — the classic `/branches/{branch}/protection` endpoint
  returns 404 for them, which is why this file long described the repository as
  unprotected. `Protect dev` (id 20763889) requires a pull request with one
  approving review, code-owner review, and extra approval for unattributed
  changes, and it blocks deletion and non-fast-forward pushes. Allowed merge
  methods are merge and squash; rebase merges are off.

  The one carve-out is that the `maintain`/`admin` repository role holds a
  `pull_request` bypass, so an owner can merge without the approval the rules
  otherwise require. That is a bypass, not an exemption: "Authors do not approve
  their own pull requests" above still governs, and an owner who uses the bypass
  should record it on the pull request rather than leave it to be inferred from
  a merge timestamp. Widening the security boundary is a separate decision.

## Security reports

Private vulnerability reports are handled by the current maintainers according to
[`SECURITY.md`](./SECURITY.md). Do not disclose secrets or exploit details in a public issue.
