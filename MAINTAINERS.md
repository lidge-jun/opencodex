# Maintainers

This document lists the people responsible for maintaining opencodex and defines the project's
review and merge policy.

## Current maintainers

| GitHub account | Project role | Responsibilities |
| --- | --- | --- |
| [@lidge-jun](https://github.com/lidge-jun) | Project owner | Project direction, releases, repository administration, and final governance decisions |
| [@Ingwannu](https://github.com/Ingwannu) | Maintainer | Issue and pull-request triage, `dev` and `dev2-go` integration, security review, and repository maintenance |
| [@Wibias](https://github.com/Wibias) | Maintainer | Issue and pull-request triage, `dev` and `dev2-go` integration, and provider/CI maintenance |

The table describes project responsibilities. Actual repository permissions remain controlled
through GitHub repository settings.

Integration duty spans both lines while the Go native port is in transition: a
maintainer who merges into `dev` also carries that work onto `dev2-go`. The
rule is written out under [Review and merge policy](#review-and-merge-policy).

## Review and merge policy

- Pull requests target `dev` by default. `dev2-go` is a parallel integration
  line reserved for Go native-port work; it converges back through
  maintainer-controlled merges, and promotion to `main` still happens only from
  `dev`. The target-branch check accepts both as integration targets. It cannot
  distinguish scoped Go port work from anything else aimed at `dev2-go`, so
  that boundary is enforced in review: redirect an out-of-scope pull request to
  `dev` rather than treating the automation's silence as approval.
- **Transition to `dev2-go` (current phase).** The project is moving its
  primary runtime to the Go native port, so `dev2-go` has to keep receiving
  everything that lands on `dev`. Contributors still open pull requests against
  `dev`, and that stays allowed — the extra work is the maintainer's, not
  theirs. A merge into `dev` is therefore not the end of the task. The
  maintainer who merges it also rebases that work onto `dev2-go`, ports
  whatever needs a Go counterpart under `go/`, and merges the port. The item is
  finished only when both lines carry the change.
  - Do the rebase and the port in the same session as the merge. A `dev` merge
    left unported is the failure mode this rule exists to prevent: `dev2-go`
    silently falls behind, and the divergence surfaces later as a conflict
    nobody has context for.
  - When a change genuinely has no Go counterpart — docs, TypeScript-only
    paths the port does not cover yet, GUI-only work — record that decision in
    the merge or the tracking issue. An unexplained missing port is
    indistinguishable from a forgotten one.
  - If the port cannot be completed immediately (a blocking dependency, a
    subsystem the port has not reached), open a tracking issue against
    `dev2-go` before closing out the `dev` merge, label it `needs-go-port`,
    and name the source commits. That label is the durable signal that a
    deferred port is intentional, not forgotten.
- A pull request requires approval from at least one maintainer and successful required CI checks
  before merge.
- Authors do not approve their own pull requests.
- Authentication, credential handling, GitHub Actions, release automation, dependency installation,
  and other security-boundary changes require explicit security review.
- Security-sensitive and release-related changes should be reviewed by both maintainers when
  practical.
- Direct pushes are reserved for maintainer-owned integration work, urgent repairs, or incident
  recovery. The same CI and documentation requirements still apply.
- Promotion from `dev` to `main` and npm releases is maintainer-controlled.

## Maintainer changes

Adding or removing a maintainer requires:

1. agreement from the project owner,
2. review by another current maintainer when available, and
3. updates to this file and [`.github/CODEOWNERS`](./.github/CODEOWNERS).

### Change log

- 2026-07-27 — [@Wibias](https://github.com/Wibias) added as a maintainer.
  Requirement 1 (agreement from the project owner) is met: the owner requested
  the addition. **Requirement 2 (review by another current maintainer) was
  never satisfied in the form this document describes.** The three commits that
  carried the addition (`a2693c02`, `dc3a4ade`, `02bbd47a`) landed on `dev` as
  direct owner pushes with no associated pull request, so no second maintainer
  reviewed them. Requirement 3 is met by this file and `.github/CODEOWNERS`.
  The addition is in effect regardless: @Wibias holds write access on the
  repository and has been merging pull requests since 2026-07-26. This entry
  records the gap rather than papering over it — a later maintainer change
  should go through a reviewed pull request.

  Scope covers issue and pull-request triage, `dev` and `dev2-go` integration,
  and provider/CI maintenance. While the Go native port is in transition,
  integration duty includes carrying merged `dev` work onto `dev2-go` as
  described in the review and merge policy above. Security-boundary ownership
  in `.github/CODEOWNERS` is deliberately unchanged: authentication, credential
  handling, GitHub Actions, and release automation keep the two owners already
  listed for those paths, so this addition does not widen the review surface
  for them.

  CODEOWNERS requests reviews rather than enforcing them — no branch protection
  rule is configured on this repository, so code-owner approval is a convention
  here, not a gate. The same is true of the approval requirement in the review
  and merge policy above. Widening the security boundary, or enforcing either
  of these through branch protection, is a separate decision.

## Security reports

Private vulnerability reports are handled by the current maintainers according to
[`SECURITY.md`](./SECURITY.md). Do not disclose secrets or exploit details in a public issue.
