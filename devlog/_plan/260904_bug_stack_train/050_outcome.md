# 050 — Outcome record

## Shipped

| PR | Branch | Base | Content |
|----|--------|------|---------|
| #3369 | `codex/deviceauth-core` | `dev` | The deviceauth grant (#3366 layer 1) |
| #3370 | `codex/deviceauth-surface` | `codex/deviceauth-core` | API/CLI/GUI surface + poll budgets (layer 2) |
| #3371 | `codex/carry-3357` | `dev` | Cursor repeated-narration breaker, carried from #3357 |
| #3372 | `codex/carry-3322` | `dev` | `logs --follow` contract, carried from #3322 |
| #3373 | `codex/carry-3335` | `dev` | Combo strategy selector, carried from #3335 |
| #3374 | `codex/carry-3333` | `dev` | Models tab width stability, carried from #3333 |

#3369 and #3370 are a real stack (layer 2 consumes layer 1). The four carries are
parallel branches off `dev`: none consumes another, so stacking them would have
imposed a false merge order. The plan audit caught that before anything was pushed.

## What review changed

The audits were not a formality. Across eight reviewer rounds they found, with
reproductions:

- A finite-but-absurd poll interval overflowed the 32-bit timer and fired
  immediately — 34 token requests in ~50ms against an auth endpoint.
- The 15-minute deadline was not enforced during an in-flight poll, so a grant
  arriving after expiry was accepted.
- `credsFromToken` cast `access_token` instead of validating it, so a 200 with no
  token resolved a login as successful with an undefined credential.
- The GUI never actually requested device mode, and the test covering it was
  false-green: its mock returned a device payload regardless of the request.
- The modal's 5-minute cancel timer would have aborted a device login ten minutes
  before its grant expired.
- Both poll-budget tests permitted the exact regression they existed to catch.
- Reauth could not reach the device flow at all — it skips the pick step.

The first attempt at the GUI trigger reused the "Don't open a browser on the proxy
machine" preference. That was wrong twice: the toggle is not rendered in the Codex
modal, and the preference means "use a different browser", not "change protocol".
It became an explicit device-login row instead.

## Not shipped, and why

Recorded in 040. #3348 and #3312 both classify generic HTTP 410/413 as retryable
hops, which would replay an oversized or invalid request to the next provider;
at ~2,000 lines each across the failover, credential, and core response paths they
need their own review cycle. #3325 is correct but touches a restricted workflow
surface and needs a maintainer sponsorship decision, not a patch.

All six open bug issues need reporter evidence or a product decision. Three of them
(#3352, #3320, #3279) would require weakening an auth or identity boundary to
"fix" without a reproduction.
