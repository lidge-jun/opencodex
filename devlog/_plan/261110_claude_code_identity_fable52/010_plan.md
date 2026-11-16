# 261110 Claude Code identity bump for Fable 5.2

## Problem

Anthropic OAuth (Claude subscription) requests for `claude-fable-5-2` fail upstream:
`400 invalid_request_error: Claude Code 2.1.280 does not support this model; version 2.1.290 or newer is required`.
opencodex presents a fixed Claude Code identity from `src/providers/claude-cli-identity.ts`
(`CLAUDE_CLI_VERSION = "2.1.280"`, User-Agent `claude-cli/2.1.280 (external, cli)`), plus the Stainless
SDK/runtime pins consumed by `src/adapters/client-fingerprint.ts`.

## Evidence

- npm `@anthropic-ai/claude-code`: latest 2.1.322, stable 2.1.311 (2026-11-10).
- Installed CLI `~/.local/share/claude/versions/2.1.319`: binary strings carry `@anthropic-ai/sdk` "0.128.0",
  runtime `v26.12.1` (Bun v1.4.4 embedded).

## Diff-level plan (wp1)

1. `src/providers/claude-cli-identity.ts`: CLAUDE_CLI_VERSION 2.1.321, SDK 0.128.0, runtime v26.12.1
   (one coherent fingerprint taken from one real binary); note the Fable 5.2 floor in the doc comment.
2. `src/adapters/client-fingerprint.ts`: header comment names 2.1.321 / sdk 0.128.0.
3. `tests/clients/client-fingerprint.test.ts`: update the two pinned values; add a regression assertion that
   the presented CLI version is >= 2.1.290 (Anthropic's Fable 5.2 minimum).
4. Live check: temporary proxy on the real config home, POST /v1/messages claude-fable-5-2, expect a model reply.

## Verification

`bun test tests/clients/client-fingerprint.test.ts` and Anthropic adapter tests, `bun run typecheck`,
`bun run test:changed`, live call. Then PR, merge, release (lane=all CI + service-lifecycle + dry run + publish).

## Audit fold (terra NEAR-PASS)

1. Scope: the reported 400 names 2.1.280, which is exactly the proxy-generated identity (the local caller is
   2.1.319), so this fix targets the proxy identity. Native passthrough that forwards a caller's own older
   identity still needs that caller to update Claude Code; the live check exercises the proxy identity.
2. Only the three version strings move; the remaining Stainless fields, beta list and anthropic-version are not
   tied to the CLI version in this repo. The live call proves route compatibility, not a full fingerprint match.
3. Test pins: only tests/clients/client-fingerprint.test.ts SDK/runtime asserts move; caller-identity fixtures stay.
   The SDK pin also changes the API-key User-Agent (@anthropic-ai/sdk/0.128.0), which matches the real SDK.


## Reference

router-for-me/CLIProxyAPI#7392 (merged 2026-11-10, fixes their #7386) hit the same 400 and bumped its emulated
baseline to 2.1.321 / sdk 0.128.0 / runtime v26.12.1 from a mitmproxy capture. This unit aligns to that measured
baseline. Their beta-header reordering and billing cc_version changes do not apply: opencodex assembles no
version-specific billing header and only passes caller betas through its allowlist.

