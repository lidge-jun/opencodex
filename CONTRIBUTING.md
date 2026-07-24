# Contributing

Thanks for helping with opencodex.

- Start with the canonical guide: [Contributing](https://opencodex.me/contributing/)
- Public user docs live in [`docs-site/`](./docs-site)
- Current maintainer invariants live in [`structure/`](./structure)
- Maintainer roles and merge policy live in [`MAINTAINERS.md`](./MAINTAINERS.md)
- Historical investigations live in [`docs/`](./docs)

## Branches

- `dev` — integration target for all normal pull requests.
- `main` — releases only; moves by maintainer-controlled promotion from `dev`.
- `preview` — prerelease train.
- `claudedesktop` — work in progress; maintainer-integrated only.

Agent-facing repository and review rules live in [`AGENTS.md`](./AGENTS.md).

For local development commands, architecture notes, and release workflow details, use the hosted
contributing guide above instead of duplicating instructions here.

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
