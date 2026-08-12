# 030 — Fix #859: Claude Desktop alias reverse-map missing in the daemon

Root cause (investigator Rawls, verified): the alias reverse-map is
process-local (`desktop3pRegistry`, populated by
`generateDesktop3pModels()`/`buildDesktop3pRegistry()`, read by
`resolveDesktop3pAlias()` — src/claude/desktop-3p.ts:106,251,273).
`ocx claude desktop apply` builds it only inside the short-lived CLI
process (src/cli/claude-desktop.ts:31) and never tells the running daemon;
the daemon keeps startup config (src/server/index.ts:274) and its inbound
path (src/claude/inbound.ts:27) falls through with the alias unchanged →
DeepSeek 400. Static mode sets `modelDiscoveryEnabled: false`
(desktop-3p.ts:291), so Desktop never triggers the /v1/models path that
would rebuild the registry (server/index.ts:491).

## Fix

When a live proxy exists, the CLI apply path executes in the serving
process through the authenticated management API: extend/reuse
`/api/claude-desktop/apply` to accept the reconciled profile + requested
mode so its existing `writeDesktop3pConfig()` call
(src/server/management/agent-settings-routes.ts:647) installs the reverse
map in the daemon. Direct local writing remains only when no proxy is
running.

## Tests (tests/claude-desktop-cli.test.ts)

Multiprocess regression: start proxy; run `ocx claude desktop apply` in a
separate Bun process; do NOT request /v1/models; POST /v1/messages with
the generated date alias. Red: mock DeepSeek receives
`claude-opus-4-8-20261210` and 400s. Green: daemon resolves to
`deepseek/deepseek-v4-flash` and the adapter sends `deepseek-v4-flash`.
(Existing 42 focused tests pass but only cover same-process generation or
explicit discovery first — the coverage gap that hid this.)

## Results (2026-08-02, wp4 executed on branch codex/bugfix-280)

- ce249422 red regression (delegation contract, red at import pre-fix).
- d05ec663 fix: applyProfile delegates to the live daemon through the
  authenticated management API; route gains optional validated mode.
- 71b7ac6e repair round 1 (Mencius FAIL): stale-daemon profile — the
  delegated request now carries the profile, validated server-side with
  parseDesktopProfile; CLI reports saved-but-not-applied explicitly.
- 8a364c1d repair round 2 (FAIL): seam now passes (mode, profile) so
  dropping the profile is red; registry guard uses a test-unique provider.
- Final review: PASS. Suites 30 pass 0 fail; typecheck green.
