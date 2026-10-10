# L7 roadmap — two documentation units, locked before either guide is edited

Base: `origin/dev` at rebase time, branch `codex/260911-l7-docs`. Packet: `000_packet.md`.

This is the docs-first cycle the loop requires. Nothing in `docs-site/` is edited until the two
wordings below are locked, because both issues propose wording that the source does not support and
writing first would have shipped two wrong claims.

## Unit order

1. **#4215** — `docs-site/src/content/docs/guides/providers.md`. The rule per authentication mode,
   then one explicit line per provider that accepts both a subscription login and an API key.
   Wording locked in `020_4215_wording.md`.
2. **#4200** — `docs-site/src/content/docs/guides/remote-hub.md`. Fresh-config object
   initialization, field preservation, data-plane versus management-plane separation, and a macOS
   Tailscale Serve data-plane TLS path. Recipe locked in `030_4200_recipe.md`.

PR 1 targets `dev`. PR 2 targets PR 1's head branch and is retargeted to `dev` after PR 1 lands.

## What this lane may touch

`docs-site/src/content/docs/guides/providers.md`, `docs-site/src/content/docs/guides/remote-hub.md`,
one new regression test per unit plus its two registrations in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`, and this devlog unit. Nothing else — no `src/`, no
`gui/src/i18n/`, and none of the seven translated copies of either guide. Translations are a
follow-up, which is what #4200's own review comment asks for.

## Verification posture

The local product suite is NOT RUN by operator instruction: no `bun test`, no `bun run test`, no
`bun run test:changed`, no `bun run typecheck`, no `bun run build:gui`, no `bun install`. Hosted CI
on the exact pushed head is the only product evidence this round accepts. Every mutating git command
is prefixed with `git -c core.hooksPath=/dev/null` and every push uses `--no-verify`, because this
repository's hooks can start a GUI install, a typecheck, and a build — the same forbidden work
through a side door.

Confidence that would normally come from a local run comes instead from read-only `xai/grok-4.6`
subagents: every claim written into either guide carries a `path:line` anchor recorded in the unit
doc, and the staged diff is reviewed adversarially before each push.

## Regression tests

Both guards live in `tests/ci-workflows/`, beside `docs-429-failover-claims.test.ts`, which is the
existing precedent for pinning a published claim that drifted away from the runtime. A subagent
confirmed that directory is the docs-guard home and that no test anywhere asserts the
`config parent path not found` behaviour today.

Each new file is registered in `scripts/test-layout/layout.json` `explicit` and in
`tests/fixtures/test-layout-expected.json`. Both maps are append-only and other lanes are appending
too; the orchestrator resolves the merge conflicts.

## Open decisions this lane had to make

- **#4215 form.** The issue left "table or per-section sentence" open. The packet decided: the rule
  per authentication mode first, then one explicit line per dual-mode provider. A table carries the
  per-provider lines because the reader's question is a lookup.
- **#4215 scope.** The issue left "dual-mode providers only, or the full roster" open. The packet
  decided dual-mode only. Providers that offer exactly one mode are already unambiguous.
- **#4215 verification surface.** The issue asks the guide to point at "the account card in the
  dashboard". No such per-account badge exists. The guide points at the surface that does exist —
  see `020_4215_wording.md`.
- **#4200 product change.** The issue's review comment explicitly leaves auto-creating a missing
  parent object out of scope. This lane documents the CLI as it behaves and does not touch
  `src/cli/config-command.ts`.
