# 260912 — Devin hardening and cached-token display

## Why this unit exists

`devin-cli` landed as a working provider in `devlog/_fin/260912_devin_cli_account_login/`:
a signed-in local Devin CLI credentials.toml is imported as an OAuth account, and inference
goes to the Cognition cloud endpoint through the cloud-direct adapter rather than through an
ACP stdio loop. That unit proved the path works. It did not harden it.

Two things are outstanding.

The first is the auth and transport path itself. The import reads one file with two regexes,
the session token has no modelled expiry, and the cloud-direct client's failure classification
is thin enough that an operator cannot tell a revoked credential from a rate limit from a
protocol drift. The adapter decodes a reverse-engineered protobuf frame, and a truncated or
reshaped frame is a class of failure the current code does not name.

The second is unrelated to Devin and was raised alongside it: a cached request's token total
is displayed without its cached companion on several surfaces. The logs table already renders
a total with a stacked cached line, and the surfaces that do not do this look like they are
reporting a different number rather than the same number without its breakdown.

## Reference material

can1357/oh-my-pi carries an independent Devin provider implementation
(packages/ai/src/providers/devin.ts, packages/ai/src/usage/devin.ts,
packages/catalog/src/discovery/devin.ts, packages/catalog/src/wire/devin.ts) plus generated
proto descriptors for the same Cognition surface. It is cloned read-only into .tmp/ref/oh-my-pi
and is never vendored, imported, or copied: it is a second observation of the same wire
protocol, used to decide which of our assumptions are load-bearing and which are guesses that
happened to hold. Its open pull requests are read the same way.

## Work phases

| Phase | Doc | Scope |
|---|---|---|
| wp1 | this file plus 010/020/030/040 | Lock the roadmap. Docs only. |
| wp2 | 010_cli_token_transition.md | CLI credential import and token transition hardening. |
| wp3 | 020_cloud_direct_hardening.md | Cloud-direct transport, usage, and catalog hardening. |
| wp4 | 030_cached_token_display.md | Cached companion on every total-bearing surface. |
| wp5 | 040_stacked_delivery.md | Stacked PR chain, exact-head CI, merge into dev. |

wp2 and wp3 are sequential because they share src/oauth/devin/api-base.ts and the account
record shape. wp4 is independent of both and touches only gui/src and src/cli, so it is a
sibling branch in the stack rather than a child.

## Out of scope

- The Devin session product (cog_ keys, agent VMs). credentials.toml carries devin_webapp_host
  and devin_api_url for it; neither is inference and neither is read.
- Any change to src/adapters/devin-cli/acp.ts stdio behaviour beyond failure classification.
  The cloud-direct route is the one that serves traffic.
- Vendoring anything from the reference clone.

## Constraints carried into every later phase

- Bun-native TypeScript. No Node-only API that Bun does not implement.
- bun run privacy:scan stays green. A devin session token is not recognised by
  redactSecretString, so no error path may echo a request body or a parsed credential.
- Behaviour changes in src/ get a focused regression test next to the existing
  tests/providers/devin-*.test.ts files.
- Every new test file needs an entry in scripts/test-layout/layout.json and
  tests/fixtures/test-layout-expected.json.
