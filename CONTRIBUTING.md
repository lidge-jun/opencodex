# Contributing

Thanks for helping with opencodex.

- Start with the canonical guide: [Contributing](https://lidge-jun.github.io/opencodex/contributing/)
- Public user docs live in [`docs-site/`](./docs-site)
- Current maintainer invariants live in [`structure/`](./structure)
- Historical investigations live in [`docs/`](./docs)

For local development commands, architecture notes, and release workflow details, use the hosted
contributing guide above instead of duplicating instructions here.

## Pre-push hook

After cloning, run once to install a local pre-push hook that mirrors the CI gate:

```sh
bun run setup:hooks
```

This installs `.git/hooks/pre-push`, which runs `bun run typecheck && bun run test` before every
`git push`. The same two checks run on ubuntu-latest, macos-latest, and windows-latest in CI.
Skip in an emergency with `git push --no-verify`.
