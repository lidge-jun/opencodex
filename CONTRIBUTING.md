# Contributing

Thanks for helping with opencodex.

- Start with the canonical guide: [Contributing](https://opencodex.me/contributing/)
- Pull-request quality contract: [Review readiness and author responsibility](https://opencodex.me/contributing/pr-quality/)
- Public user docs live in [`docs-site/`](./docs-site)
- Current maintainer invariants live in [`structure/`](./structure)
- Maintainer roles and merge policy live in [`MAINTAINERS.md`](./MAINTAINERS.md)
- Historical investigations live in [`docs/`](./docs)

## Branches

- `dev` — the only integration target for pull requests.
- `main` — releases only; moves by maintainer-controlled promotion from `dev`.
- `preview` — prerelease train.

The `dev2-go` Go native-port line has been retired. Its history is archived at
[lidge-jun/opencodex-go-archive](https://github.com/lidge-jun/opencodex-go-archive),
and everything now goes to `dev`. See [`MAINTAINERS.md`](./MAINTAINERS.md) for
the reasoning.

Rebase pull requests are welcome: bringing a stale branch onto the current head
is normal contribution. Note the source commits in the description.

Agent-facing repository and review rules live in [`AGENTS.md`](./AGENTS.md).

For local development commands, architecture notes, and release workflow details, use the hosted
contributing guide above instead of duplicating instructions here.

Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own
Bun runtime for end users, but contributor commands such as `bun install`, `bun run test`, and
`bun run prepush` run from your local Bun installation.

## Pull request contract

A ready-for-review PR is the author's claim that the change is complete, understood, tested, and suitable for merging. Opening a PR does not transfer responsibility for the branch to maintainers.

- **You do not need permission to fix something.** An unplanned PR for a bug you
  hit is welcome, and several of this project's better fixes arrived exactly that
  way. Opening an issue first helps for larger or design-shaped work, but it is
  not an admission requirement.
- Authors own CI failures, missing tests, merge conflicts, and review fixes.
  Maintainers identify problems; they are not required to implement or debug the
  fixes for contributors.
- Behavior changes include focused regression tests. Claims such as "tested" or
  "CI" without named commands and results are not evidence. The hygiene gate
  checks this mechanically, and its failures are deterministic — read the message
  and you know what to change.
- Authentication, workflow, release automation, and dependency-installation
  surfaces need a maintainer to sponsor the change (`maintainer-sponsored`)
  before merge. Those are the places where a bad merge is expensive and hard to
  unwind, which is why they are the only pre-approved surfaces here.
- A PR that stalls with unresolved review feedback may be closed, with the reason
  stated. A closed PR can be reopened once the stated reason is resolved, or
  replaced with a clean one.

## Pre-push hook

After cloning, run once to install a local pre-push hook that runs the typecheck,
unit-test, privacy-scan, and (when `gui/` changed) GUI eslint and React Doctor
portions of the CI gate:

```sh
bun run setup:hooks
```

This installs a `pre-push` hook (into the hooks dir git reports, so worktrees and
`core.hooksPath` work) that runs `bun run prepush` — `typecheck`,
`lint:gui:if-changed`, `test`, `privacy:scan`, and `doctor:gui:if-changed` —
before every `git push`. Both `lint:gui:if-changed` and `doctor:gui:if-changed`
run their check only when the push touches `gui/`.
The same checks run on ubuntu-latest, macos-latest, and windows-latest in CI (CI
additionally builds the GUI and smoke-tests the CLI). Skip in an emergency with
`git push --no-verify`.
