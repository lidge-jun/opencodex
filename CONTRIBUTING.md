# Contributing

Thanks for helping with opencodex.

- Start with the canonical guide: [Contributing](https://opencodex.me/contributing/)
- Public user docs live in [`docs-site/`](./docs-site)
- Current maintainer invariants live in [`structure/`](./structure)
- Maintainer roles and merge policy live in [`MAINTAINERS.md`](./MAINTAINERS.md)
- Historical investigations live in [`docs/`](./docs)

## Branches

- `dev` — default integration target for pull requests.
- `dev2-go` — parallel integration line for the Go native port (`go/`, the
  native runtime entrypoint, and the Go release-asset tooling). Open for pull
  requests alongside `dev`. Send work here only when it belongs to the Go port;
  anything else goes to `dev`. The automated check accepts both targets and
  cannot tell them apart, so scope is settled in review.
- `main` — releases only; moves by maintainer-controlled promotion from `dev`.
- `preview` — prerelease train.

While the project moves its primary runtime to the Go native port, `dev2-go`
has to keep receiving everything that lands on `dev`. Nothing changes for
contributors: keep opening pull requests against `dev`. After merging, a
maintainer rebases the work onto `dev2-go` and ports whatever needs a Go
counterpart, and the item is finished only once both lines carry it. See
[`MAINTAINERS.md`](./MAINTAINERS.md) for the full rule.

Porting and rebase pull requests are welcome: carrying a fix across integration
lines, or rebasing a stale branch onto the current head, is normal
contribution. Note the source commits in the description.

Agent-facing repository and review rules live in [`AGENTS.md`](./AGENTS.md).

For local development commands, architecture notes, and release workflow details, use the hosted
contributing guide above instead of duplicating instructions here.

Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own
Bun runtime for end users, but contributor commands such as `bun install`, `bun run test`, and
`bun run prepush` run from your local Bun installation.

## Pre-push hook

After cloning, run once to install a local pre-push hook that runs the typecheck,
GUI eslint, unit-test, privacy-scan, and (when `gui/` changed) React Doctor
portions of the CI gate:

```sh
bun run setup:hooks
```

This installs a `pre-push` hook (into the hooks dir git reports, so worktrees and
`core.hooksPath` work) that runs `bun run prepush` — `typecheck`, `lint:gui`,
`test`, `privacy:scan`, and `doctor:gui:if-changed` — before every `git push`.
The same checks run on ubuntu-latest, macos-latest, and windows-latest in CI (CI
additionally builds the GUI and smoke-tests the CLI). Skip in an emergency with
`git push --no-verify`.
