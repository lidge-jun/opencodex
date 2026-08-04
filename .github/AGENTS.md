# GitHub automation instructions

This file applies to `.github/` and inherits the repository-wide rules in `/AGENTS.md`.

## Security boundary

Every workflow, ownership, branch-enforcement, release, or repository-automation
change requires explicit security review under `MAINTAINERS.md`.

## Workflow rules

- Grant the minimum required `permissions`.
- Pin third-party actions to immutable full commit SHAs.
- Preserve the human-readable version comment beside each pinned action.
- Do not run untrusted pull-request code with secrets or write permissions.
- Treat `pull_request_target`, workflow dispatch, reusable workflows, artifacts, caches, and generated command input as trust boundaries.
- Do not broaden triggers, write permissions, token exposure, release eligibility, or publish capability without an explicit task requirement.
- Preserve cross-platform coverage where the workflow currently promises Linux, macOS, and Windows behavior.
- Keep branch-enforcement text synchronized with `AGENTS.md`, `MAINTAINERS.md`, and the public contributing guide.

## Validation

- Inspect the complete workflow diff, including event triggers, permissions, conditions, interpolation, and shell behavior.
- Run the local commands represented by changed workflow steps where possible.
- Run `bun run prepush` for CI, release, dependency, packaging, or cross-platform workflow changes.
- Do not claim the workflow itself passed until GitHub Actions reports success for the exact commit.
