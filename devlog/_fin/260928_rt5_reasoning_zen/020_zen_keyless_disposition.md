# 020 — wp2: #5995 keyless OpenCode Zen — dropped for release train 5

## Decision

Dropped this train. No branch or PR is opened; #5995 stays open under its author.

## Reason

The keyless tier refuses non-OpenCode traffic (`MissingSessionID`, "OpenCode's free tier can only be
used in OpenCode"; registry note at `src/providers/registry/entries-extended.ts:1149`). #5995 is
admitted by presenting OpenCode's client identity: an OpenCode-shaped `x-opencode-session`, a
default `User-Agent: opencode/2.0.18`, `x-opencode-client: desktop`, and injected `shell`/`read`
declarations. OpenCode documents API-key access for Zen (https://opencode.ai/docs/zen/); a search on
2026-09-28 found no published contract permitting third-party use of the anonymous tier.
The maintainer hold of 2026-09-27 on #5995 names written permission or documentation from
OpenCode, a three-turn fixture, and fresh security review as landing conditions. The first is
external and unmet, so carrying the change would ship a credential-free admission path that
works around another service's client restriction.

## Technical findings kept for a future carry

- Continuation-cache blocker is real. With `previous_response_id`, the passthrough guard narrows
  declared tools to the caller's catalog (`src/server/responses/passthrough-dispatch.ts:452-500`);
  raw inspection latches `inspectionSawUndeclaredTool` for an injected `shell`/`read` call
  (`:510-573`), and `rememberPassthroughResponseChecked` returns early on that latch (`:583-586`)
  even after the redirect rewrote the call into guidance. Turn three then misses `resp_2`.
  Minimal fix: do not latch a name owned by the current request's injected-call redirect; keep
  latching every other undeclared name. Regression: three turns (tool call → tool result →
  accidental injected call rewritten → chained third turn sees full history), plus an unrelated
  undeclared call that still refuses caching.
  Caveat from reflection: the detector returns one undeclared name per payload
  (`passthrough-dispatch.ts:562-572`), so skipping that single name could hide a second, genuine
  undeclared call in the same frame. The fix must inspect every call in the payload, or validate
  the final delivered stream, including an empty terminal snapshot after an earlier rejected call.
- `structure/decisions/ADR-5810-zen-keyless-client-identity.md:12` still claims unknown-tool
  behaviour is unchanged; stale.
- The Muse Spark contributor-free Responses-wire default is separable routing work.
- Merge against `dev` `cbe0d40daf` is textually clean; no touched file has a size cap.

## What would reopen it

OpenCode permission or documentation for third-party keyless use, then a carry with the fix and
fixture above and a security review of the identity headers.
