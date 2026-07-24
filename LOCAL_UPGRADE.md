# Local upgrade baseline

This clone is the durable source of the locally deployed opencodex package.
The built-in GUI/npm updater must not be used while local-only patches remain
unmerged upstream, because it replaces the global package with the registry
tarball and bypasses this Git history.

## Branches and remotes

- `local/stable` is the deployable branch.
- `upstream` points to `lidge-jun/opencodex`.
- `origin` points to `duansy123/opencodex` for off-machine backup.
- `local-baseline/v2.7.35-patches` records the first combined local baseline.

## Local patches

1. `fix(codex): reset main runtime state after account switch`
   clears stale main-account runtime state after frequent Codex account changes.
2. `fix(anthropic): guard premature no-tool completions`
   performs one bounded internal continuation when an Anthropic model announces
   work, emits no tool call, and prematurely completes. Normal final answers,
   explicit plan-only requests, questions, and completed tool-backed turns are
   left unchanged.

## Upgrade procedure

Run from this repository:

```bash
./scripts/local-update.sh
```

The command fetches the latest official tag and merges it into `local/stable`.
Git conflicts stop before the installed proxy is touched. A clean merge must
pass typecheck, GUI lint, the full test suite, privacy scan, and GUI build before
packaging. Only then is the launchd service stopped and replaced. The previous
installed package is packed first and restored automatically if install,
health, or GUI verification fails.

To target a specific official release:

```bash
./scripts/local-update.sh 2.7.39
```

After a successful update, push `local/stable` and the local baseline/backup
tags to `origin`. Upstream-facing PR branches remain separate so local workflow
commits are never mixed into public feature PRs.
